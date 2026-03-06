// ── CC-HUB ADMIN MODULE ───────────────────────────────────────
import { db, auth, storage }           from "./firebase.js";
import { el, v, esc }                  from "./utils.js";
import { isPushSupported, getPushPermission,
         enablePush, disablePush,
         refreshToken, subscribeForeground } from "./fcm.js";
import { signInAnonymously }           from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  collection, onSnapshot, writeBatch, serverTimestamp, Timestamp,
  query, orderBy, limit, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ref as storageRef, uploadBytesResumable, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const authReady = signInAnonymously(auth).catch(e => console.error("Auth:", e));

// ── HELPERS ───────────────────────────────────────────────────
async function sha256(msg) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

function randCode() {
  // Avoids ambiguous chars (O, 0, I, 1) so codes are easy to read aloud / type
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) c += "-";
    c += chars[Math.floor(Math.random() * chars.length)];
  }
  return "CC-" + c;
}

function expiresLabel(ts) {
  if (!ts) return "Never expires";
  const d   = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  if (d < now) return "EXPIRED";
  const days = Math.ceil((d - now) / 86400000);
  return days === 1 ? "Expires tomorrow" : `Expires in ${days}d`;
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── AUDIT LOG HELPER ──────────────────────────────────────────
async function auditLog(action, details = "") {
  try {
    await addDoc(collection(db, "audit_log"), { action, details, time: serverTimestamp() });
  } catch(e) { console.warn("auditLog write failed:", e); }
}

// ── STATE ─────────────────────────────────────────────────────
let loggedIn        = false;
let selectedExpiry  = "7d";
let lastCode        = "";
let allCodes        = [];
let allStores       = [];
let allEntries      = [];
let filteredEntries = [];
let allAdminMsgs    = [];
let filtAdminMsgs   = [];
let unsubCodes      = null;
let unsubStores     = null;
let unsubEntries    = null;
let unsubAdminMsgs  = null;
let allFeedback       = [];
let filtFeedback      = [];
let unsubFeedback     = null;
let prevFeedbackCount = -1; // -1 = initial load, skip notification
let allAuditLog     = [];
let unsubAuditLog   = null;
let allEmployees    = [];
let filtEmployees   = [];
let unsubEmployees  = null;
let allCoaching       = [];
let filtCoaching      = [];
let unsubCoaching     = null;
let unsubFcmForeground = null;

// ── ADMIN AUTH ────────────────────────────────────────────────
(async function checkSetup() {
  await authReady; // ensure anonymous auth is complete before reading Firestore
  try {
    const snap = await getDoc(doc(db, "admin", "config"));
    if (!snap.exists() || !snap.data().masterPwdHash) {
      el("login-sub").textContent = "First run — create your admin password.";
      el("first-run-setup").style.display = "block";
      el("normal-login").style.display    = "none";
    }
  } catch(e) {
    el("login-sub").textContent = "Could not reach database. Check connection.";
    console.error("Admin setup check:", e);
  }
})();

window.createAdminPwd = async function() {
  const p1    = v("setup-pwd1");
  const p2    = v("setup-pwd2");
  const errEl = el("setup-err");
  errEl.classList.remove("show");
  if (p1.length < 6) { errEl.textContent = "Password must be at least 6 characters."; errEl.classList.add("show"); return; }
  if (p1 !== p2)     { errEl.textContent = "Passwords don't match.";                  errEl.classList.add("show"); return; }
  try {
    await setDoc(doc(db, "admin", "config"), { masterPwdHash: await sha256(p1), created: serverTimestamp() });
    enterAdmin();
  } catch(e) { errEl.textContent = "Error: " + e.message; errEl.classList.add("show"); }
};

window.adminLogin = async function() {
  const pwd   = v("login-pwd");
  const errEl = el("login-err");
  errEl.classList.remove("show");
  if (!pwd) { errEl.textContent = "Enter your password."; errEl.classList.add("show"); return; }
  try {
    const snap = await getDoc(doc(db, "admin", "config"));
    if (!snap.exists()) { errEl.textContent = "Admin not configured."; errEl.classList.add("show"); return; }
    if (snap.data().masterPwdHash !== await sha256(pwd)) {
      errEl.textContent = "Incorrect password."; errEl.classList.add("show"); return;
    }
    enterAdmin();
  } catch(e) { errEl.textContent = "Error: " + e.message; errEl.classList.add("show"); }
};

function enterAdmin() {
  loggedIn = true;
  el("login-screen").classList.add("hidden");
  el("admin-app").classList.add("show");
  el("topbar-badge").style.display = "inline-block";
  el("btn-logout").style.display   = "inline-block";
  listenCodes();
  listenStores();
  listenEntries();
  listenAdminMsgs();
  listenFeedback();
  listenAuditLog();
  listenEmployees();
  listenCoaching();

  // FCM: refresh token, subscribe foreground, read ?tab= from notification click
  const _saveAdminToken = t =>
    setDoc(doc(db, "admin", "pushTokens"), { tokens: arrayUnion(t) }, { merge: true });
  refreshToken(_saveAdminToken).catch(() => {});
  unsubFcmForeground = subscribeForeground(p => {
    const b = p.notification?.body  || p.data?.body  || "";
    const t = p.notification?.title || p.data?.title || "Counter Coach";
    showNotif("🔔 " + (b || t));
  });
  _updatePushToggle();

  const tabParam = new URLSearchParams(window.location.search).get("tab");
  if (tabParam && TAB_LABELS[tabParam]) setTimeout(() => goTab(tabParam), 100);
}

window.adminLogout = function() {
  if (unsubCodes)     { unsubCodes();     unsubCodes     = null; }
  if (unsubStores)   { unsubStores();   unsubStores   = null; }
  if (unsubEntries)  { unsubEntries();  unsubEntries  = null; }
  if (unsubAdminMsgs){ unsubAdminMsgs(); unsubAdminMsgs = null; }
  if (unsubFeedback) { unsubFeedback(); unsubFeedback  = null; }
  prevFeedbackCount = -1;
  dismissNotif();
  if (unsubAuditLog)  { unsubAuditLog();  unsubAuditLog  = null; }
  if (unsubEmployees) { unsubEmployees(); unsubEmployees = null; }
  if (unsubCoaching)      { unsubCoaching();      unsubCoaching      = null; }
  if (unsubFcmForeground) { unsubFcmForeground(); unsubFcmForeground = null; }
  loggedIn = false;
  el("login-screen").classList.remove("hidden");
  el("admin-app").classList.remove("show");
  el("topbar-badge").style.display = "none";
  el("btn-logout").style.display   = "none";
  el("login-pwd").value = "";
};

// ── TAB DROPDOWN ──────────────────────────────────────────────
const TAB_LABELS = {
  codes:"🎫 Codes", stores:"🏪 Stores", logbook:"📋 Logbook",
  messages:"📬 Messages", broadcast:"📢 Broadcast", settings:"⚙️ Settings",
  analytics:"📊 Analytics", employees:"👥 Employees", coaching:"📋 Coaching",
  feedback:"💬 Feedback", audit:"📓 Audit Log", config:"🛠️ Config"
};

window.goTab = function(tab) {
  document.querySelectorAll(".tab-drop-item").forEach(b =>
    b.classList.toggle("on", b.textContent.trim() === TAB_LABELS[tab])
  );
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("on"));
  el("tab-" + tab).classList.add("on");
  el("tab-dropdown-label").textContent = TAB_LABELS[tab];
  el("tab-dropdown-btn").classList.remove("open");
  el("tab-dropdown-menu").classList.remove("open");
  if (tab === "broadcast") loadBroadcast();
  if (tab === "analytics") renderAnalytics();
  if (tab === "config")    loadAppConfig();
};

window.toggleTabDropdown = function() {
  el("tab-dropdown-btn").classList.toggle("open");
  el("tab-dropdown-menu").classList.toggle("open");
};

document.addEventListener("click", e => {
  if (el("tab-dropdown") && !el("tab-dropdown").contains(e.target)) {
    el("tab-dropdown-btn").classList.remove("open");
    el("tab-dropdown-menu").classList.remove("open");
  }
});

// ── EXPIRY PICKER ─────────────────────────────────────────────
window.setExpiry = function(btn, val) {
  document.querySelectorAll(".epill").forEach(b => b.classList.remove("on"));
  btn.classList.add("on");
  selectedExpiry = val;
};

// ── GENERATE CODE ─────────────────────────────────────────────
window.generateCode = async function() {
  if (!loggedIn) return;
  const storeNum = v("gen-store") || null;
  let expires = null;
  if (selectedExpiry === "7d")  expires = Timestamp.fromDate(new Date(Date.now() + 7  * 86400000));
  if (selectedExpiry === "30d") expires = Timestamp.fromDate(new Date(Date.now() + 30 * 86400000));

  const code = randCode();
  try {
    await setDoc(doc(db, "reg_codes", code), {
      created:     serverTimestamp(),
      expires:     expires,
      storeNumber: storeNum,
      used:        false,
      usedAt:      null,
      usedByStore: null
    });
    lastCode = code;
    el("code-display").textContent = code;
    el("code-display").classList.add("show");
    el("copy-row").style.display = "block";
    const okEl = el("gen-ok");
    okEl.textContent = "Code saved — share it with the store manager.";
    okEl.classList.add("show");
    setTimeout(() => okEl.classList.remove("show"), 4000);
    el("gen-store").value = "";
    auditLog("Generated registration code", `Code: ${code}${storeNum ? ` · Store ${storeNum}` : " · Any store"} · Expires: ${selectedExpiry}`);
  } catch(e) { alert("Error generating code: " + e.message); }
};

window.copyCode = function() {
  navigator.clipboard.writeText(lastCode)
    .then(() => {
      el("btn-copy").textContent = "✓ Copied!";
      setTimeout(() => el("btn-copy").textContent = "📋 Copy Code", 2500);
    })
    .catch(() => prompt("Copy this code:", lastCode));
};

// ── LISTEN: CODES ─────────────────────────────────────────────
function listenCodes() {
  if (unsubCodes) unsubCodes();
  unsubCodes = onSnapshot(collection(db, "reg_codes"), snap => {
    allCodes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderCodes();
    updateStats();
  });
}

function renderCodes() {
  const container = el("codes-list");
  if (!allCodes.length) { container.innerHTML = '<div class="empty">No codes yet. Generate one above.</div>'; return; }

  const now    = new Date();
  const sorted = [...allCodes].sort((a, b) => {
    const aExp = a.expires ? a.expires.toDate() < now : false;
    const bExp = b.expires ? b.expires.toDate() < now : false;
    if (a.used !== b.used) return a.used ? 1 : -1;
    if (aExp  !== bExp)    return aExp   ? 1 : -1;
    return 0;
  });

  container.innerHTML = sorted.map(c => {
    const expired = c.expires && c.expires.toDate && c.expires.toDate() < now;
    const badge   = c.used    ? `<span class="badge badge-red">Used</span>`
                  : expired   ? `<span class="badge badge-amber">Expired</span>`
                              : `<span class="badge badge-green">Active</span>`;
    const store   = c.storeNumber ? `Store ${esc(c.storeNumber)}` : "Any store";
    const usedBy  = c.used ? ` · Used by Store ${esc(c.usedByStore || "?")}` : "";
    return `
      <div class="code-item">
        <div style="flex:1;min-width:0;">
          <div class="code-mono">${esc(c.id)}</div>
          <div class="code-meta">${store} · ${expiresLabel(c.expires)}${usedBy}</div>
        </div>
        ${badge}
        <button class="btn btn-sm btn-red" onclick="revokeCode('${esc(c.id)}')">Revoke</button>
      </div>`;
  }).join("");
}

window.revokeCode = async function(id) {
  if (!confirm(`Revoke and delete code "${id}"? This cannot be undone.`)) return;
  await deleteDoc(doc(db, "reg_codes", id)).catch(e => alert("Error: " + e.message));
  auditLog("Revoked registration code", `Code: ${id}`);
};

// ── LISTEN: STORES ────────────────────────────────────────────
function listenStores() {
  if (unsubStores) unsubStores();
  unsubStores = onSnapshot(collection(db, "stores"), snap => {
    allStores = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderStores();
    updateStats();
  });
}

function renderStores() {
  const container = el("stores-list");
  if (!allStores.length) { container.innerHTML = '<div class="empty">No stores registered yet.</div>'; return; }

  const sorted = [...allStores].sort((a, b) => a.id.localeCompare(b.id));
  container.innerHTML = sorted.map(s => `
    <div class="store-item">
      <div class="store-num">Store ${esc(s.id)}</div>
      <div class="store-detail">
        👤 ${esc(s.managerName   || "—")}
        &nbsp;·&nbsp; 📞 ${esc(s.managerPhone  || "—")}
        &nbsp;·&nbsp; 🛟 ${esc(s.helpdeskPhone || "—")}
        ${s.created ? `<br>📅 Registered ${fmtDate(s.created)}` : ""}
        ${s.infoUpdatedAt ? `<br>🔄 Info updated ${fmtDate(s.infoUpdatedAt)}` : ""}
      </div>
      <div class="store-actions">
        <button class="btn btn-sm btn-outline" onclick="toggleStoreEdit('${esc(s.id)}')">✏️ Edit</button>
        <button class="btn btn-sm btn-red"     onclick="deleteStore('${esc(s.id)}')">🗑️ Delete</button>
      </div>
      <div class="store-edit" id="edit-${esc(s.id)}">
        <div class="store-edit-grid">
          <div class="edit-field">
            <label class="field-label">Manager Name</label>
            <input type="text" id="sf-name-${esc(s.id)}" value="${esc(s.managerName || '')}" placeholder="Manager name">
          </div>
          <div class="edit-field">
            <label class="field-label">Manager Phone</label>
            <input type="tel" id="sf-phone-${esc(s.id)}" value="${esc(s.managerPhone || '')}" placeholder="555-1234">
          </div>
          <div class="edit-field" style="grid-column:1/-1;">
            <label class="field-label">Helpdesk Phone</label>
            <input type="tel" id="sf-helpdesk-${esc(s.id)}" value="${esc(s.helpdeskPhone || '')}" placeholder="Helpdesk number">
          </div>
        </div>
        <label class="replies-toggle-row">
          <input type="checkbox" id="sf-replies-${esc(s.id)}" ${s.repliesEnabled ? 'checked' : ''}>
          Allow manager to reply to employee private messages
        </label>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button class="btn btn-sm btn-green" onclick="saveStore('${esc(s.id)}')">💾 Save</button>
          <button class="btn btn-sm btn-outline" onclick="resetPIN('${esc(s.id)}')">🔑 Reset PIN</button>
        </div>
      </div>
    </div>`).join("");
}

window.deleteStore = async function(id) {
  if (!confirm(`Delete Store ${id}?\n\nThis removes the store record and PIN. Logbook entries and messages are NOT deleted.\n\nThis cannot be undone.`)) return;
  await deleteDoc(doc(db, "stores", id)).catch(e => alert("Error: " + e.message));
  auditLog("Deleted store", `Store: ${id}`);
};

// ── STATS ─────────────────────────────────────────────────────
function updateStats() {
  const now    = new Date();
  const active = allCodes.filter(c => !c.used && (!c.expires || c.expires.toDate() > now)).length;
  const used   = allCodes.filter(c =>  c.used).length;
  el("stat-stores").textContent = allStores.length;
  el("stat-codes").textContent  = active;
  el("stat-used").textContent   = used;
}

// ── CHANGE PASSWORD ───────────────────────────────────────────
window.changePwd = async function() {
  const cur   = v("chg-cur");
  const nw1   = v("chg-new1");
  const nw2   = v("chg-new2");
  const errEl = el("chg-err");
  const okEl  = el("chg-ok");
  errEl.classList.remove("show"); okEl.classList.remove("show");
  if (!cur || !nw1 || !nw2) { errEl.textContent = "All fields are required.";             errEl.classList.add("show"); return; }
  if (nw1.length < 6)       { errEl.textContent = "New password must be 6+ characters.";  errEl.classList.add("show"); return; }
  if (nw1 !== nw2)          { errEl.textContent = "New passwords don't match.";            errEl.classList.add("show"); return; }
  try {
    const snap = await getDoc(doc(db, "admin", "config"));
    if (snap.data().masterPwdHash !== await sha256(cur)) {
      errEl.textContent = "Current password is incorrect."; errEl.classList.add("show"); return;
    }
    await updateDoc(doc(db, "admin", "config"), { masterPwdHash: await sha256(nw1) });
    okEl.textContent = "Password updated successfully."; okEl.classList.add("show");
    el("chg-cur").value = ""; el("chg-new1").value = ""; el("chg-new2").value = "";
    auditLog("Changed master password");
  } catch(e) { errEl.textContent = "Error: " + e.message; errEl.classList.add("show"); }
};

// ── CLEAR USED/EXPIRED CODES ──────────────────────────────────
window.clearUsedCodes = async function() {
  const now    = new Date();
  const toDelete = allCodes.filter(c => c.used || (c.expires && c.expires.toDate && c.expires.toDate() < now));
  if (!toDelete.length) { alert("No used or expired codes to delete."); return; }
  if (!confirm(`Delete ${toDelete.length} used/expired code(s)?`)) return;
  const batch = writeBatch(db);
  toDelete.forEach(c => batch.delete(doc(db, "reg_codes", c.id)));
  await batch.commit().catch(e => alert("Error: " + e.message));
  auditLog("Deleted used/expired codes", `Count: ${toDelete.length}`);
};

// ── STORE EDITING ──────────────────────────────────────────────
window.toggleStoreEdit = function(storeId) {
  const form = document.getElementById("edit-" + storeId);
  if (form) form.classList.toggle("open");
};

window.saveStore = async function(storeId) {
  const name          = document.getElementById(`sf-name-${storeId}`).value.trim();
  const phone         = document.getElementById(`sf-phone-${storeId}`).value.trim();
  const helpdesk      = document.getElementById(`sf-helpdesk-${storeId}`).value.trim();
  const repliesEnabled = document.getElementById(`sf-replies-${storeId}`).checked;
  if (!name) { alert("Manager name is required."); return; }
  try {
    const storeDoc = doc(db, "stores", storeId);
    const snap = await getDoc(storeDoc);
    const cur  = snap.exists() ? snap.data() : {};
    await updateDoc(storeDoc, {
      managerName:    name,
      managerPhone:   phone,
      helpdeskPhone:  helpdesk,
      repliesEnabled: repliesEnabled,
      pin:            cur.pin || "0000",
      infoUpdatedAt:  serverTimestamp()
    });
    document.getElementById("edit-" + storeId).classList.remove("open");
    auditLog("Updated store info", `Store: ${storeId} · Manager: ${name}`);
  } catch(e) { alert("Error saving store: " + e.message); }
};

window.resetPIN = async function(storeId) {
  const newPin = prompt(`Set new manager PIN for Store ${storeId}:\n(4+ characters)`);
  if (newPin === null) return;
  if (newPin.trim().length < 4) { alert("PIN must be at least 4 characters."); return; }
  try {
    const storeDoc = doc(db, "stores", storeId);
    const snap = await getDoc(storeDoc);
    const cur  = snap.exists() ? snap.data() : {};
    await updateDoc(storeDoc, {
      pin:           newPin.trim(),
      managerName:   cur.managerName   || "—",
      managerPhone:  cur.managerPhone  || "",
      helpdeskPhone: cur.helpdeskPhone || "",
      infoUpdatedAt: serverTimestamp()
    });
    alert(`✅ PIN for Store ${storeId} has been updated.`);
    auditLog("Reset manager PIN", `Store: ${storeId}`);
  } catch(e) { alert("Error resetting PIN: " + e.message); }
};

// ── LOGBOOK ────────────────────────────────────────────────────
function listenEntries() {
  if (unsubEntries) unsubEntries();
  const q = query(collection(db, "entries"), orderBy("time", "desc"));
  unsubEntries = onSnapshot(q, snap => {
    allEntries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateStoreFilter();
    filterEntries();
  }, e => console.error("entries snapshot:", e));
}

function populateStoreFilter() {
  const stores = [...new Set(allEntries.map(e => e.store).filter(Boolean))].sort();
  const sel = el("log-store-filter");
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Stores</option>' +
    stores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  if (cur) sel.value = cur;
}

window.filterEntries = function() {
  const store = el("log-store-filter").value;
  filteredEntries = store ? allEntries.filter(e => e.store === store) : allEntries;
  renderEntries();
};

window.refreshEntries = function() {
  el("log-list").innerHTML = '<div class="empty">Loading…</div>';
  listenEntries();
};

function renderEntries() {
  const container = el("log-list");
  if (!filteredEntries.length) {
    container.innerHTML = '<div class="empty">No entries found.</div>';
    return;
  }
  const typeClass = { progress: "log-type-progress", issue: "log-type-issue", note: "log-type-note" };
  const typeEmoji = { progress: "📈", issue: "⚠️", note: "📝" };
  const shown = filteredEntries.slice(0, 100);
  container.innerHTML = shown.map(e => `
    <div class="log-entry">
      <div class="log-header">
        <div>
          <span class="log-store">Store ${esc(e.store || "?")}</span>
          <span class="log-type ${typeClass[e.type] || 'log-type-note'}">
            ${typeEmoji[e.type] || "📝"} ${esc(e.type || "note")}
          </span>
        </div>
        <button class="btn btn-sm btn-red" onclick="deleteEntry('${esc(e.id)}')">🗑️</button>
      </div>
      <div class="log-body">${esc(e.text || "")}</div>
      <div class="log-meta">👤 ${esc(e.author || "?")} · ${fmtTime(e.time)} · <span style="text-transform:uppercase;font-size:11px;">${esc(e.status || "")}</span></div>
    </div>`).join("") +
    (filteredEntries.length > 100 ? `<div class="empty" style="padding:10px 0;">Showing 100 of ${filteredEntries.length} entries</div>` : "");
}

window.deleteEntry = async function(id) {
  if (!confirm("Delete this logbook entry? This cannot be undone.")) return;
  await deleteDoc(doc(db, "entries", id)).catch(e => alert("Error: " + e.message));
};

// ── ADMIN MESSAGES ─────────────────────────────────────────────
function listenAdminMsgs() {
  if (unsubAdminMsgs) unsubAdminMsgs();
  const q = query(collection(db, "messages"), orderBy("time", "desc"));
  unsubAdminMsgs = onSnapshot(q, snap => {
    allAdminMsgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateMsgStoreFilter();
    filterMessages();
  }, e => console.error("admin msgs:", e));
}

function populateMsgStoreFilter() {
  const stores = [...new Set(allAdminMsgs.map(m => m.store).filter(Boolean))].sort();
  const sel = el("msg-store-filter");
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Stores</option>' +
    stores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  if (cur) sel.value = cur;
}

window.filterMessages = function() {
  const store = el("msg-store-filter").value;
  filtAdminMsgs = store ? allAdminMsgs.filter(m => m.store === store) : allAdminMsgs;
  renderAdminMsgs();
};

window.refreshMessages = function() {
  el("admin-msg-list").innerHTML = '<div class="empty">Loading…</div>';
  listenAdminMsgs();
};

window.deleteMessage = async function(id) {
  if (!confirm("Delete this message? This cannot be undone.")) return;
  await deleteDoc(doc(db, "messages", id)).catch(e => alert("Error: " + e.message));
  auditLog("Deleted private message", `ID: ${id}`);
};

function renderAdminMsgs() {
  const container = el("admin-msg-list");
  if (!filtAdminMsgs.length) {
    container.innerHTML = '<div class="empty">No messages found.</div>';
    return;
  }
  const shown = filtAdminMsgs.slice(0, 100);
  container.innerHTML = shown.map(m => `
    <div class="admin-msg">
      <div class="admin-msg-head">
        <div>
          <span class="admin-msg-store">Store ${esc(m.store || "?")}</span>
          <span style="margin:0 5px;color:var(--ink-faint)">·</span>
          <span class="admin-msg-from">From: ${esc(m.from || "?")}</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="${m.read ? 'badge-read' : 'badge-unread'}">${m.read ? "Read" : "Unread"}</span>
          <button class="btn btn-sm btn-red" onclick="deleteMessage('${esc(m.id)}')">🗑️</button>
        </div>
      </div>
      <div class="admin-msg-body">${esc(m.text || "")}</div>
      ${m.reply ? `<div class="admin-msg-reply">↩ <b>${esc(m.reply.from)}</b> replied: ${esc(m.reply.text)}</div>` : ""}
      <div class="log-meta" style="margin-top:4px;">${fmtTime(m.time)}</div>
    </div>`).join("") +
    (filtAdminMsgs.length > 100 ? `<div class="empty" style="padding:10px 0;">Showing 100 of ${filtAdminMsgs.length}</div>` : "");
}

// ── BROADCAST ──────────────────────────────────────────────────
async function loadBroadcast() {
  try {
    const snap = await getDoc(doc(db, "admin", "broadcast"));
    const data = snap.exists() ? snap.data() : {};
    const active = data.active || false;
    el("bc-toggle").checked = active;
    el("bc-title").value    = data.title   || "";
    el("bc-msg").value      = data.message || "";
    updateBroadcastBadge(active);
  } catch(e) { console.error("loadBroadcast:", e); }
}

function updateBroadcastBadge(active) {
  const badge = el("bc-badge");
  badge.textContent = active ? "Live" : "Off";
  badge.className   = "bc-status-badge " + (active ? "bc-active" : "bc-inactive");
}

window.toggleBroadcast = function() {
  updateBroadcastBadge(el("bc-toggle").checked);
};

window.saveBroadcast = async function() {
  const active  = el("bc-toggle").checked;
  const title   = el("bc-title").value.trim();
  const message = el("bc-msg").value.trim();
  if (active && !message) {
    alert("Please enter a message before activating the broadcast.");
    el("bc-toggle").checked = false;
    updateBroadcastBadge(false);
    return;
  }
  try {
    await setDoc(doc(db, "admin", "broadcast"), { active, title, message, updatedAt: serverTimestamp() });
    const okEl = el("bc-ok");
    okEl.textContent = active ? "✅ Broadcast is now live for all stores!" : "Broadcast saved (inactive).";
    okEl.classList.add("show");
    setTimeout(() => okEl.classList.remove("show"), 4000);
    updateBroadcastBadge(active);
    auditLog(active ? "Activated broadcast" : "Saved broadcast (inactive)", title ? `Title: ${title}` : "");
  } catch(e) { alert("Error: " + e.message); }
};

window.clearBroadcast = async function() {
  if (!confirm("Clear and deactivate the broadcast?")) return;
  await setDoc(doc(db, "admin", "broadcast"), { active: false, title: "", message: "", updatedAt: serverTimestamp() });
  el("bc-toggle").checked = false;
  el("bc-title").value    = "";
  el("bc-msg").value      = "";
  updateBroadcastBadge(false);
  auditLog("Cleared broadcast");
};

// ── ANALYTICS ─────────────────────────────────────────────────
function renderAnalytics() {
  // Overview stats
  const totalEntries  = allEntries.length;
  const totalMsgs     = allAdminMsgs.length;
  const unreadMsgs    = allAdminMsgs.filter(m => !m.read).length;
  const totalStores   = allStores.length;
  el("analytics-overview").innerHTML = `
    <div class="analytics-stat"><div class="analytics-stat-num">${totalEntries}</div><div class="analytics-stat-lbl">Total Entries</div></div>
    <div class="analytics-stat"><div class="analytics-stat-num">${totalMsgs}</div><div class="analytics-stat-lbl">Total Messages</div></div>
    <div class="analytics-stat"><div class="analytics-stat-num">${unreadMsgs}</div><div class="analytics-stat-lbl">Unread Messages</div></div>
    <div class="analytics-stat"><div class="analytics-stat-num">${totalStores}</div><div class="analytics-stat-lbl">Stores</div></div>`;

  // Entry type breakdown
  const typeCounts = { progress: 0, issue: 0, note: 0 };
  allEntries.forEach(e => { if (typeCounts[e.type] !== undefined) typeCounts[e.type]++; });
  const maxType = Math.max(...Object.values(typeCounts), 1);
  const typeLabels = { progress: "📈 Progress", issue: "⚠️ Issue", note: "📝 Note" };
  const typeClasses = { progress: "bar-progress", issue: "bar-issue", note: "bar-note" };
  el("chart-types").innerHTML = !totalEntries ? '<div class="empty">No entries yet.</div>' :
    Object.entries(typeCounts).map(([type, count]) => `
      <div class="chart-item">
        <div class="chart-label">${typeLabels[type]}</div>
        <div class="chart-bar-wrap"><div class="chart-bar ${typeClasses[type]}" style="width:${Math.round(count/maxType*100)}%"></div></div>
        <div class="chart-val">${count}</div>
      </div>`).join("");

  // Top stores by entry count
  const storeCounts = {};
  allEntries.forEach(e => { if (e.store) storeCounts[e.store] = (storeCounts[e.store] || 0) + 1; });
  const topStores = Object.entries(storeCounts).sort((a,b) => b[1]-a[1]).slice(0, 8);
  const maxStore  = topStores.length ? topStores[0][1] : 1;
  el("chart-stores").innerHTML = !topStores.length ? '<div class="empty">No entries yet.</div>' :
    topStores.map(([store, count]) => `
      <div class="chart-item">
        <div class="chart-label">Store ${esc(store)}</div>
        <div class="chart-bar-wrap"><div class="chart-bar bar-store" style="width:${Math.round(count/maxStore*100)}%"></div></div>
        <div class="chart-val">${count}</div>
      </div>`).join("");

  // Message stats by store
  const msgCounts = {};
  allAdminMsgs.forEach(m => { if (m.store) msgCounts[m.store] = (msgCounts[m.store] || 0) + 1; });
  const topMsgStores = Object.entries(msgCounts).sort((a,b) => b[1]-a[1]).slice(0, 8);
  const maxMsg = topMsgStores.length ? topMsgStores[0][1] : 1;
  el("chart-msgs").innerHTML = !topMsgStores.length ? '<div class="empty">No messages yet.</div>' :
    topMsgStores.map(([store, count]) => `
      <div class="chart-item">
        <div class="chart-label">Store ${esc(store)}</div>
        <div class="chart-bar-wrap"><div class="chart-bar bar-msg" style="width:${Math.round(count/maxMsg*100)}%"></div></div>
        <div class="chart-val">${count}</div>
      </div>`).join("");
}

// ── FEEDBACK ──────────────────────────────────────────────────
function listenFeedback() {
  if (unsubFeedback) unsubFeedback();
  prevFeedbackCount = -1;
  const q = query(collection(db, "feedback"), orderBy("time", "desc"));
  unsubFeedback = onSnapshot(q, snap => {
    allFeedback = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const newCount = allFeedback.length;
    if (prevFeedbackCount !== -1 && newCount > prevFeedbackCount) {
      const added = newCount - prevFeedbackCount;
      showNotif(`💬 ${added} new feedback item${added > 1 ? 's' : ''} received — tap to view`);
    }
    prevFeedbackCount = newCount;
    populateFbStoreFilter();
    filterFeedback();
  }, e => console.error("feedback snapshot:", e));
}

function showNotif(msg) {
  el("notif-text").textContent = msg;
  el("notif-banner").classList.add("show");
}

window.dismissNotif = function() {
  el("notif-banner").classList.remove("show");
};

function populateFbStoreFilter() {
  const stores = [...new Set(allFeedback.map(f => f.store).filter(Boolean))].sort();
  const sel = el("fb-store-filter");
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Stores</option>' +
    stores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  if (cur) sel.value = cur;
}

window.filterFeedback = function() {
  const store = el("fb-store-filter").value;
  const type  = el("fb-type-filter").value;
  filtFeedback = allFeedback
    .filter(f => (!store || f.store === store) && (!type || f.type === type));
  renderFeedback();
};

function renderFeedback() {
  const container = el("feedback-list");
  if (!filtFeedback.length) {
    container.innerHTML = '<div class="empty">No feedback found.</div>';
    return;
  }
  const typeBadge = { bug: "badge-bug", idea: "badge-idea", other: "badge-other" };
  const typeLabel = { bug: "Bug Report", idea: "Idea", other: "Other" };
  container.innerHTML = filtFeedback.map(f => `
    <div class="feedback-item">
      <div class="feedback-head">
        <div>
          <span class="feedback-store">Store ${esc(f.store || "?")}</span>
          <span style="margin:0 5px;color:var(--ink-faint)">·</span>
          <span style="font-size:13px;font-weight:700;">${esc(f.from || "Manager")}</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="${typeBadge[f.type] || 'badge-other'}">${typeLabel[f.type] || "Other"}</span>
          <span class="${f.status === 'resolved' ? 'badge-resolved' : 'badge-open-fb'}">${f.status === 'resolved' ? 'Resolved' : 'Open'}</span>
        </div>
      </div>
      <div class="feedback-body">${esc(f.text || "")}</div>
      <div class="feedback-meta">${fmtTime(f.time)}</div>
      <div class="feedback-actions">
        ${f.status !== 'resolved'
          ? `<button class="btn btn-sm btn-green" onclick="resolveFeedback('${esc(f.id)}')">✅ Mark Resolved</button>`
          : `<button class="btn btn-sm btn-outline" onclick="reopenFeedback('${esc(f.id)}')">↩ Reopen</button>`}
        <button class="btn btn-sm btn-red" onclick="deleteFeedback('${esc(f.id)}')">🗑️ Delete</button>
      </div>
    </div>`).join("") +
    (allFeedback.length > filtFeedback.length ? `<div class="empty" style="padding:10px 0;">Filtered — ${filtFeedback.length} of ${allFeedback.length} items shown</div>` : "");
}

window.resolveFeedback = async function(id) {
  await updateDoc(doc(db, "feedback", id), { status: "resolved" }).catch(e => alert("Error: " + e.message));
  auditLog("Resolved feedback", `ID: ${id}`);
};

window.reopenFeedback = async function(id) {
  await updateDoc(doc(db, "feedback", id), { status: "open" }).catch(e => alert("Error: " + e.message));
};

window.deleteFeedback = async function(id) {
  if (!confirm("Delete this feedback item? This cannot be undone.")) return;
  await deleteDoc(doc(db, "feedback", id)).catch(e => alert("Error: " + e.message));
  auditLog("Deleted feedback", `ID: ${id}`);
};

// ── AUDIT LOG ─────────────────────────────────────────────────
function listenAuditLog() {
  if (unsubAuditLog) unsubAuditLog();
  const q = query(collection(db, "audit_log"), orderBy("time", "desc"), limit(200));
  unsubAuditLog = onSnapshot(q, snap => {
    allAuditLog = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAuditLog();
  }, e => console.error("audit_log snapshot:", e));
}

function renderAuditLog() {
  const container = el("audit-list");
  if (!allAuditLog.length) { container.innerHTML = '<div class="empty">No actions logged yet.</div>'; return; }
  container.innerHTML = allAuditLog.map(a => `
    <div class="audit-item">
      <div class="audit-dot"></div>
      <div class="audit-body">
        <div class="audit-action">${esc(a.action || "Unknown action")}</div>
        ${a.details ? `<div class="audit-detail">${esc(a.details)}</div>` : ""}
        <div class="audit-time">${fmtTime(a.time)}</div>
      </div>
    </div>`).join("") +
    (allAuditLog.length >= 200 ? '<div class="empty" style="padding:10px 0;">Showing latest 200 entries</div>' : "");
}

window.clearAuditLog = async function() {
  if (!allAuditLog.length) { alert("Audit log is already empty."); return; }
  if (!confirm(`Delete all ${allAuditLog.length} audit log entries? This cannot be undone.`)) return;
  const batch = writeBatch(db);
  allAuditLog.forEach(a => batch.delete(doc(db, "audit_log", a.id)));
  await batch.commit().catch(e => alert("Error: " + e.message));
};

// ── APP CONFIG ────────────────────────────────────────────────
async function loadAppConfig() {
  try {
    const snap = await getDoc(doc(db, "admin", "appConfig"));
    const data = snap.exists() ? snap.data() : {};
    el("cfg-helpdesk").value = data.helpdeskFallback || "";
    el("cfg-footer").value   = data.appFooterNote    || "";
    el("cfg-feedback-enabled").checked = data.feedbackEnabled !== false;
    el("cfg-msgs-enabled").checked     = data.msgsEnabled     !== false;
    el("cfg-roster-enabled").checked   = data.rosterEnabled   !== false;
    el("cfg-allow-type-name").checked  = data.allowTypeMyName !== false;
    el("cfg-coaching-enabled").checked = data.coachingEnabled !== false;
    // Branding fields
    el("cfg-app-name").value = data.appName || "";
    const color = data.brandColor || "#2d5a27";
    el("cfg-brand-color").value = color;
    el("cfg-brand-color-hex").textContent = color;
    if (data.logoUrl) {
      el("cfg-logo-preview").src = data.logoUrl;
      el("cfg-logo-preview").classList.add("show");
      el("cfg-logo-default").style.display  = "none";
      el("cfg-logo-sub").style.display      = "none";
      el("cfg-logo-remove").style.display   = "inline-block";
    }
    applyBranding(data);
    loadMailConfig();
  } catch(e) { console.error("loadAppConfig:", e); }
}

async function loadMailConfig() {
  try {
    const snap = await getDoc(doc(db, "admin", "mailConfig"));
    if (snap.exists()) {
      const d = snap.data();
      el("cfg-smtp-host").value      = d.smtpHost      || "";
      el("cfg-smtp-port").value      = d.smtpPort      || "";
      el("cfg-smtp-user").value      = d.smtpUser      || "";
      el("cfg-smtp-pass").value      = d.smtpPass      || "";
      el("cfg-smtp-from-name").value = d.smtpFromName  || "";
      el("cfg-smtp-secure").checked  = d.smtpSecure    || false;
    }
  } catch(e) { console.error("loadMailConfig:", e); }
}

window.saveMailConfig = async function() {
  const smtpHost     = el("cfg-smtp-host").value.trim()      || "smtp.ionos.com";
  const smtpPort     = parseInt(el("cfg-smtp-port").value)   || 587;
  const smtpUser     = el("cfg-smtp-user").value.trim();
  const smtpPass     = el("cfg-smtp-pass").value.trim();
  const smtpFromName = el("cfg-smtp-from-name").value.trim() || "Counter Coach";
  const smtpSecure   = el("cfg-smtp-secure").checked;
  try {
    await setDoc(doc(db, "admin", "mailConfig"),
      { smtpHost, smtpPort, smtpUser, smtpPass, smtpFromName, smtpSecure },
      { merge: true }
    );
    const ok = el("cfg-mail-ok");
    ok.style.opacity = "1";
    setTimeout(() => { ok.style.opacity = "0"; }, 3000);
  } catch(e) { alert("Error: " + e.message); }
};

// ── PUSH NOTIFICATION TOGGLE (Admin Settings) ─────────────────
function _updatePushToggle() {
  const row = el("push-toggle-row");
  if (!row) return;
  if (!isPushSupported()) { row.style.display = "none"; return; }
  const perm = getPushPermission();
  el("push-toggle-cb").checked = perm === "granted";
  el("push-toggle-status").textContent =
    perm === "granted" ? "Enabled — fires even when tab is closed" :
    perm === "denied"  ? "Blocked — allow in browser site settings" :
                         "Off — click to enable";
}

window.togglePushNotifs = async function() {
  const cb      = el("push-toggle-cb");
  const _save   = t => setDoc(doc(db,"admin","pushTokens"), { tokens: arrayUnion(t)  }, { merge: true });
  const _remove = t => setDoc(doc(db,"admin","pushTokens"), { tokens: arrayRemove(t) }, { merge: true });
  if (cb.checked) {
    const r = await enablePush(_save);
    if (r !== "granted") {
      cb.checked = false;
      if (r === "denied") alert("Notifications were denied. Allow them in browser settings then try again.");
    }
  } else {
    await disablePush(_remove);
  }
  _updatePushToggle();
};

function applyBranding(data) {
  if (!data) return;
  // Apply brand color to this page's CSS variables
  if (data.brandColor) {
    document.documentElement.style.setProperty("--forest", data.brandColor);
    document.documentElement.style.setProperty("--forest-mid", data.brandColor);
  }
  // Apply app name to topbar title, login title, and page title
  const name = data.appName || "Counter Coach";
  document.title = name + " — Admin";
  el("topbar-title-text").textContent = "⚙️ " + name + " Admin";
  el("login-title-text").textContent  = name + " Admin";
  // Apply logo to topbar and login card
  const topbarLogo = el("topbar-logo-img");
  const loginLogo  = el("login-logo-img");
  const lockIcon   = el("login-lock-icon");
  if (data.logoUrl) {
    topbarLogo.src = data.logoUrl;
    topbarLogo.style.display = "inline-block";
    el("topbar-title-text").style.display = "none";
    loginLogo.src = data.logoUrl;
    loginLogo.classList.add("show");
    lockIcon.style.display = "none";
  } else {
    topbarLogo.style.display = "none";
    el("topbar-title-text").style.display = "";
    loginLogo.classList.remove("show");
    lockIcon.style.display = "";
  }
}

// ── BRANDING ──────────────────────────────────────────────────
window.saveBranding = async function() {
  const appName    = el("cfg-app-name").value.trim();
  const brandColor = el("cfg-brand-color").value;
  try {
    await setDoc(doc(db, "admin", "appConfig"), { appName, brandColor, updatedAt: serverTimestamp() }, { merge: true });
    const snap = await getDoc(doc(db, "admin", "appConfig"));
    applyBranding(snap.exists() ? snap.data() : {});
    const okEl = el("cfg-brand-ok");
    okEl.textContent = "Branding saved.";
    okEl.classList.add("show");
    setTimeout(() => okEl.classList.remove("show"), 3000);
    auditLog("Updated branding", `Name: "${appName || "default"}" · Color: ${brandColor}`);
  } catch(e) { alert("Error: " + e.message); }
};

window.resetBrandColor = async function() {
  el("cfg-brand-color").value = "#2d5a27";
  el("cfg-brand-color-hex").textContent = "#2d5a27";
};

window.uploadLogo = async function(input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) { alert("Please select an image file."); return; }
  if (file.size > 2 * 1024 * 1024) { alert("Image must be under 2 MB."); return; }
  const progressWrap = el("cfg-logo-progress-wrap");
  const progressBar  = el("cfg-logo-progress-bar");
  const okEl         = el("cfg-logo-ok");
  progressWrap.style.display = "block";
  progressBar.style.width    = "0%";
  okEl.classList.remove("show");
  try {
    const sRef = storageRef(storage, "branding/logo");
    await new Promise((resolve, reject) => {
      const task = uploadBytesResumable(sRef, file);
      task.on("state_changed",
        snap => { progressBar.style.width = Math.round(snap.bytesTransferred / snap.totalBytes * 100) + "%"; },
        reject,
        async () => {
          const url = await getDownloadURL(task.snapshot.ref);
          await setDoc(doc(db, "admin", "appConfig"), { logoUrl: url, updatedAt: serverTimestamp() }, { merge: true });
          el("cfg-logo-preview").src = url;
          el("cfg-logo-preview").classList.add("show");
          el("cfg-logo-default").style.display  = "none";
          el("cfg-logo-sub").style.display      = "none";
          el("cfg-logo-remove").style.display   = "inline-block";
          progressWrap.style.display = "none";
          okEl.textContent = "Logo uploaded successfully.";
          okEl.classList.add("show");
          setTimeout(() => okEl.classList.remove("show"), 4000);
          const snap2 = await getDoc(doc(db, "admin", "appConfig"));
          applyBranding(snap2.exists() ? snap2.data() : {});
          auditLog("Uploaded custom logo");
          resolve();
        }
      );
    });
  } catch(e) {
    progressWrap.style.display = "none";
    alert("Upload error: " + e.message);
  }
  input.value = "";
};

window.removeLogo = async function() {
  if (!confirm("Remove the custom logo? The app will revert to default branding.")) return;
  try {
    await setDoc(doc(db, "admin", "appConfig"), { logoUrl: "", updatedAt: serverTimestamp() }, { merge: true });
    el("cfg-logo-preview").src = "";
    el("cfg-logo-preview").classList.remove("show");
    el("cfg-logo-default").style.display = "";
    el("cfg-logo-sub").style.display     = "";
    el("cfg-logo-remove").style.display  = "none";
    applyBranding({ logoUrl: "", appName: el("cfg-app-name").value.trim(), brandColor: el("cfg-brand-color").value });
    auditLog("Removed custom logo");
  } catch(e) { alert("Error: " + e.message); }
};

window.saveAppConfig = async function() {
  const helpdesk = el("cfg-helpdesk").value.trim();
  const footer   = el("cfg-footer").value.trim();
  try {
    await setDoc(doc(db, "admin", "appConfig"), {
      helpdeskFallback: helpdesk,
      appFooterNote:    footer,
      feedbackEnabled:  el("cfg-feedback-enabled").checked,
      msgsEnabled:      el("cfg-msgs-enabled").checked,
      updatedAt:        serverTimestamp()
    }, { merge: true });
    const okEl = el("cfg-ok");
    okEl.textContent = "Settings saved.";
    okEl.classList.add("show");
    setTimeout(() => okEl.classList.remove("show"), 3000);
    auditLog("Updated app config", helpdesk ? `Helpdesk fallback: ${helpdesk}` : "");
  } catch(e) { alert("Error: " + e.message); }
};

window.saveFeatureFlags = async function() {
  const feedbackEnabled = el("cfg-feedback-enabled").checked;
  const msgsEnabled     = el("cfg-msgs-enabled").checked;
  const rosterEnabled   = el("cfg-roster-enabled").checked;
  const allowTypeMyName = el("cfg-allow-type-name").checked;
  const coachingEnabled = el("cfg-coaching-enabled").checked;
  try {
    await setDoc(doc(db, "admin", "appConfig"), {
      feedbackEnabled,
      msgsEnabled,
      rosterEnabled,
      allowTypeMyName,
      coachingEnabled,
      updatedAt: serverTimestamp()
    }, { merge: true });
    const okEl = el("cfg-flags-ok");
    okEl.textContent = "Feature flags saved.";
    okEl.classList.add("show");
    setTimeout(() => okEl.classList.remove("show"), 3000);
    auditLog("Updated feature flags",
      `Feedback: ${feedbackEnabled}, Messages: ${msgsEnabled}, Roster: ${rosterEnabled}, TypeName: ${allowTypeMyName}, Coaching: ${coachingEnabled}`);
  } catch(e) { alert("Error: " + e.message); }
};

// ── EMPLOYEES ─────────────────────────────────────────────────
function listenEmployees() {
  if (unsubEmployees) unsubEmployees();
  const q = query(collection(db, "employees"), orderBy("name"));
  unsubEmployees = onSnapshot(q, snap => {
    allEmployees = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateEmpStoreFilter();
    filterEmployees();
  }, e => console.error("employees snapshot:", e));
}

function populateEmpStoreFilter() {
  const stores = [...new Set(allEmployees.map(e => e.store).filter(Boolean))].sort();
  const sel = el("emp-store-filter");
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Stores</option>' +
    stores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  if (cur) sel.value = cur;
}

window.filterEmployees = function() {
  const store = el("emp-store-filter").value;
  filtEmployees = store ? allEmployees.filter(e => e.store === store) : allEmployees;
  renderEmployees();
};

function renderEmployees() {
  const container = el("emp-list");
  if (!filtEmployees.length) {
    container.innerHTML = '<div class="empty">No employees found.</div>';
    return;
  }
  const titleOptions = ["Parts Specialist","RSS","ISS","Assistant","Driver"];
  container.innerHTML = filtEmployees.map(e => `
    <div class="emp-wrap">
      <div class="emp-item">
        <div style="flex:1;min-width:0;">
          <div class="emp-name">${esc(e.name || "—")}</div>
          <div class="emp-detail">Store ${esc(e.store || "?")}${e.memberNum ? ` · #${esc(e.memberNum)}` : ""}${e.addedAt ? ` · Added ${fmtDate(e.addedAt)}` : ""}</div>
        </div>
        ${e.loggedIn ? `<span class="badge badge-green" style="flex-shrink:0;">🟢 Active</span>` : ""}
        <span class="badge badge-role-emp" style="flex-shrink:0;">${esc(e.role || "—")}</span>
        ${e.loggedIn ? `<button class="btn btn-sm btn-outline" onclick="releaseEmployee('${esc(e.id)}','${esc(e.name||'')}')">Release</button>` : ""}
        <button class="btn btn-sm btn-outline" onclick="editEmployee('${esc(e.id)}')">✏️</button>
        <button class="btn btn-sm btn-red" onclick="deleteEmployee('${esc(e.id)}','${esc(e.name || '')}')">🗑️</button>
      </div>
      <div class="emp-edit" id="emp-edit-${esc(e.id)}">
        <div class="store-edit-grid">
          <div class="edit-field">
            <label class="field-label">Name</label>
            <input type="text" id="ee-name-${esc(e.id)}" value="${esc(e.name||'')}" style="margin:0;">
          </div>
          <div class="edit-field">
            <label class="field-label">Title</label>
            <select id="ee-role-${esc(e.id)}" style="padding:8px 10px;border:1.5px solid var(--ruled);border-radius:8px;font-family:'Karla',sans-serif;font-size:14px;background:var(--paper);color:var(--ink);width:100%;">
              ${titleOptions.map(t => `<option value="${t}"${e.role===t?' selected':''}>${t}</option>`).join("")}
            </select>
          </div>
          <div class="edit-field">
            <label class="field-label">Member #</label>
            <input type="text" id="ee-member-${esc(e.id)}" value="${esc(e.memberNum||'')}" style="margin:0;">
          </div>
          <div class="edit-field">
            <label class="field-label">Store #</label>
            <input type="text" id="ee-store-${esc(e.id)}" value="${esc(e.store||'')}" style="margin:0;">
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="btn btn-sm btn-green" onclick="saveEmployee('${esc(e.id)}')">Save</button>
          <button class="btn btn-sm btn-outline" onclick="editEmployee('${esc(e.id)}')">Cancel</button>
        </div>
      </div>
    </div>`).join("") +
    (allEmployees.length > filtEmployees.length
      ? `<div class="empty" style="padding:10px 0;">Filtered — ${filtEmployees.length} of ${allEmployees.length} employees</div>` : "");
}

window.editEmployee = function(id) {
  const editEl = document.getElementById("emp-edit-" + id);
  if (!editEl) return;
  const isOpen = editEl.classList.contains("open");
  // Close all open edit forms first
  document.querySelectorAll(".emp-edit.open").forEach(elem => elem.classList.remove("open"));
  if (!isOpen) editEl.classList.add("open");
};

window.saveEmployee = async function(id) {
  const name      = (document.getElementById("ee-name-"   + id) || {}).value?.trim();
  const role      = (document.getElementById("ee-role-"   + id) || {}).value;
  const memberNum = (document.getElementById("ee-member-" + id) || {}).value?.trim();
  const store     = (document.getElementById("ee-store-"  + id) || {}).value?.trim();
  if (!name)  { alert("Name is required.");         return; }
  if (!store) { alert("Store number is required."); return; }
  await updateDoc(doc(db, "employees", id), {
    name, role, memberNum: memberNum || null, store
  }).catch(e => { alert("Error: " + e.message); return; });
  auditLog("Updated employee", `ID: ${id} · Name: ${name} · Title: ${role} · Store: ${store}`);
  const editEl = document.getElementById("emp-edit-" + id);
  if (editEl) editEl.classList.remove("open");
};

window.addEmployee = async function() {
  const store     = el("emp-add-store").value.trim();
  const name      = el("emp-add-name").value.trim();
  const role      = el("emp-add-role").value;
  const memberNum = el("emp-add-member").value.trim();
  const errEl     = el("emp-add-err");
  errEl.classList.remove("show");
  if (!store) { errEl.textContent = "Store number is required."; errEl.classList.add("show"); return; }
  if (!name)  { errEl.textContent = "Employee name is required."; errEl.classList.add("show"); return; }
  try {
    await addDoc(collection(db, "employees"), {
      store,
      name,
      role,
      memberNum: memberNum || null,
      addedBy:  "admin",
      addedAt:  serverTimestamp()
    });
    el("emp-add-name").value   = "";
    el("emp-add-member").value = "";
    auditLog("Added employee", `Store: ${store} · Name: ${name} · Role: ${role}`);
  } catch(e) { errEl.textContent = "Error: " + e.message; errEl.classList.add("show"); }
};

window.deleteEmployee = async function(id, name) {
  if (!confirm(`Remove "${name}" from the roster? This cannot be undone.`)) return;
  await deleteDoc(doc(db, "employees", id)).catch(e => alert("Error: " + e.message));
  auditLog("Removed employee", `Name: ${name} · ID: ${id}`);
};

window.releaseEmployee = async function(id, name) {
  if (!confirm(`Release session for "${name}"? They will be able to log in again.`)) return;
  await updateDoc(doc(db, "employees", id), { loggedIn: false }).catch(e => alert("Error: " + e.message));
  auditLog("Released employee session", `Name: ${name}`);
};

// ── COACHING RECORDS ──────────────────────────────────────────
function listenCoaching() {
  if (unsubCoaching) unsubCoaching();
  const q = query(collection(db, "coaching"), orderBy("savedAt", "desc"), limit(200));
  unsubCoaching = onSnapshot(q, snap => {
    allCoaching = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    populateCoachingStoreFilter();
    filterCoaching();
  }, e => console.error("coaching snapshot:", e));
}

function populateCoachingStoreFilter() {
  const stores = [...new Set(allCoaching.map(c => c.store).filter(Boolean))].sort();
  const sel = el("coaching-store-filter");
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Stores</option>' +
    stores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  if (cur) sel.value = cur;
}

window.filterCoaching = function() {
  const store = el("coaching-store-filter").value;
  const type  = el("coaching-type-filter").value;
  filtCoaching = allCoaching
    .filter(c => (!store || c.store === store) && (!type || c.type === type));
  renderCoaching();
};

window.deleteCoaching = async function(id, name) {
  if (!confirm(`Delete coaching record for "${name}"? This cannot be undone.`)) return;
  await deleteDoc(doc(db, "coaching", id)).catch(e => alert("Error: " + e.message));
  auditLog("Deleted coaching record", `Name: ${name} · ID: ${id}`);
};

function renderCoaching() {
  const container = el("coaching-list");
  if (!filtCoaching.length) {
    container.innerHTML = '<div class="empty">No coaching records found.</div>';
    return;
  }
  const typeBadge = {
    verbal: "badge-verbal", written: "badge-written", final: "badge-final",
    pip: "badge-pip", termination: "badge-termination"
  };
  const typeLabel = {
    verbal: "Verbal", written: "Written", final: "Final Written",
    pip: "PIP", termination: "Termination"
  };
  container.innerHTML = filtCoaching.map(c => `
    <div class="coaching-item">
      <div class="coaching-head">
        <div>
          <span class="coaching-store">Store ${esc(c.store || "?")}</span>
          <span style="margin:0 5px;color:var(--ink-faint)">·</span>
          <span style="font-size:13px;font-weight:700;">${esc(c.name || "—")}</span>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;">
          <span class="${typeBadge[c.type] || 'badge-other'}">${typeLabel[c.type] || esc(c.type || "—")}</span>
          <span class="${c.status === 'complete' ? 'badge-coaching-complete' : 'badge-coaching-draft'}">${c.status === 'complete' ? 'Complete' : 'Draft'}</span>
          <button class="btn btn-sm btn-red" onclick="deleteCoaching('${esc(c.id)}','${esc(c.name||'')}')">🗑️</button>
        </div>
      </div>
      <div class="coaching-body">
        ${c.issue  ? `<b>Issue:</b> ${esc(c.issue)}<br>` : ""}
        ${c.action ? `<b>Action:</b> ${esc(c.action)}` : ""}
      </div>
      <div class="coaching-meta">
        👤 Mgr: ${esc(c.manager || "?")}
        ${c.savedAt ? ` · ${fmtTime(c.savedAt)}` : ""}
        ${c.empSig  ? ` · <span style="color:#2e7d32;">✍ Signed</span>` : ""}
      </div>
    </div>`).join("") +
    (allCoaching.length > filtCoaching.length
      ? `<div class="empty" style="padding:10px 0;">Filtered — ${filtCoaching.length} of ${allCoaching.length} records</div>` : "");
}
