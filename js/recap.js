// ── RECAP.HTML — Daily Recap & Log ────────────────────────────
import { db, auth, storage, functions }               from "./firebase.js";
import { el, v, esc, ts, compressImage,
         fetchBrandingData, loadBroadcast }            from "./utils.js";
import { saveSession, loadSession,
         saveMgrSession, loadMgrSession,
         clearMgrSession }                             from "./session.js";
import { collection, addDoc, onSnapshot, deleteDoc,
         query, where, orderBy, limit, updateDoc, deleteField, doc, getDoc,
         getDocs, serverTimestamp, writeBatch }          from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { signInAnonymously }                           from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { uploadBytesResumable, uploadBytes, getDownloadURL,
         ref, deleteObject }                           from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import { httpsCallable }                               from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

// ── STATE ─────────────────────────────────────────────────────
let store = "", name = "", filterVal = "all";
let mgrLoggedIn = false, storePin = "";
let allEntries = [], allEntriesMgr = [], myMsgs = [];
let unsubEntries = null, unsubMgrEntries = null, unsubMsgs = null, unsubMgrMsgs = null;
let pendingPhotoFiles  = [];
let mgrViewingInbox    = false;
let repliesEnabled     = false;
let dmEmail            = "";
let recapEmail         = "";
let notifyEntry        = true;
let notifyFlagged      = true;
let notifyMessages     = true;
let notifyDone         = false;
let empDocMap          = {};
let mgrRosterData      = [];
let myEmpId            = null;
let myAvatarUrl        = null;
let avatarPendingFile  = null;
let mgrAvatarTargetId   = null;
let mgrAvatarTargetRole = null;
let mgrAvatarPendingFile = null;

// ── INIT ──────────────────────────────────────────────────────
(function preShowQR() {
  const uS    = new URLSearchParams(location.search).get("store");
  const saved = loadSession();
  if (!uS || (saved && saved.store)) return;
  el("ns-store").value    = uS;
  el("ns-store").readOnly = true;
  el("ns-store").style.opacity = "0.55";
  el("ns-store").style.cursor  = "default";
  el("ns-name").innerHTML = '<option value="">Loading roster\u2026</option>';
  el("ns-name").disabled  = true;
  el("no-session").classList.add("show");
  el("bottom-nav").classList.add("show");
})();

signInAnonymously(auth)
  .then(() => {
    loadBroadcast(db); loadBranding();
    const uS    = new URLSearchParams(location.search).get("store");
    const saved = loadSession();
    if (uS && !(saved && saved.store)) loadNsRoster(uS);
  })
  .catch(e => console.error("Auth:", e))
  .finally(init);

function init() {
  const p  = new URLSearchParams(location.search);
  const uS = p.get("store");
  const uN = p.get("name");

  const saved = loadSession();
  if (saved && saved.store && saved.name) {
    store = saved.store;
    name  = saved.name;
    getDocs(query(collection(db,"stores",store,"employees"), where("name","==",name)))
      .then(snap => {
        if (!snap.empty) {
          const empDoc = snap.docs[0];
          myEmpId = empDoc.id;
          updateDoc(empDoc.ref, { loggedIn: true }).catch(()=>{});
          if (empDoc.data().avatarUrl) {
            myAvatarUrl = empDoc.data().avatarUrl;
            applyAvatarToTopbar(myAvatarUrl);
          }
        }
      })
      .catch(() => {});
    bootApp();
    return;
  }

  if (uS && uN) {
    store = uS; name = uN;
    saveSession({ store, name, role: "employee", managerPhone: "", helpdeskPhone: "" });
    bootApp();
    return;
  }

  if (uS) {
    store = uS;
    return;
  }

  el("no-session").classList.add("show");
  el("bottom-nav").classList.add("show");
  setTimeout(() => el("ns-store").focus(), 150);
}

// ── ROSTER-BACKED NAME DROPDOWN ───────────────────────────────
let nsRosterTimer = null;

function nsStoreStatus(msg, color) {
  const d = el("ns-store-status");
  if (!d) return;
  if (!msg) { d.style.display = "none"; d.textContent = ""; return; }
  d.textContent = msg;
  d.style.color = color || "var(--ink-faint)";
  d.style.display = "block";
}

function onNsStoreInput() {
  const s = el("ns-store").value.trim();
  clearTimeout(nsRosterTimer);
  nsStoreStatus("");
  if (s.length >= 3) {
    nsStoreStatus("Checking…", "var(--ink-faint)");
    nsRosterTimer = setTimeout(() => checkNsStore(s), 600);
  } else {
    el("ns-name").innerHTML = '<option value="">— Enter store # first —</option>';
  }
}

async function checkNsStore(s) {
  try {
    const snap = await getDoc(doc(db, "stores", s));
    if (snap.exists()) {
      nsStoreStatus("✓ Store " + s + " found", "#2e7d32");
      loadNsRoster(s);
    } else {
      nsStoreStatus("⚠ Store not registered — visit /register to set up", "#c62828");
      el("ns-name").innerHTML = '<option value="">— Store not registered —</option>';
    }
  } catch (_) {
    nsStoreStatus("");
    loadNsRoster(s); // fallback on error
  }
}

async function loadNsRoster(s) {
  const sel = el("ns-name");
  sel.innerHTML = '<option value="">Loading…</option>';
  sel.disabled = true;
  empDocMap = {};
  try {
    const snap = await getDocs(collection(db, "stores", s, "employees"));
    snap.docs.forEach(d => { empDocMap[d.data().name] = { id: d.id, memberNum: d.data().memberNum }; });
    const available = snap.docs
      .filter(d => !d.data().loggedIn)
      .map(d => d.data().name)
      .sort((a, b) => a.localeCompare(b));
    if (!snap.docs.length) {
      sel.innerHTML = '<option value="">— No roster found — ask your manager to add you —</option>';
    } else if (!available.length) {
      sel.innerHTML = '<option value="">— All employees are currently logged in —</option>';
    } else {
      sel.innerHTML = '<option value="">— Select your name —</option>'
        + available.map(n => `<option value="${n.replace(/"/g,'&quot;')}">${n}</option>`).join("");
    }
  } catch (_) {
    sel.innerHTML = '<option value="">— Error loading roster —</option>';
  }
  sel.disabled = false;
}

window.noSessionLogin = () => {
  const s       = el("ns-store").value.trim() || store;
  const n       = el("ns-name").value.trim();
  const counter = el("ns-counter").value.trim();
  const email   = el("ns-email")?.value.trim() || "";
  const errEl   = el("ns-err");
  if (!s) { errEl.textContent = "Please enter your store number."; errEl.style.display="block"; return; }
  if (!n) { errEl.textContent = "Please select your name.";        errEl.style.display="block"; return; }
  if (!counter) { errEl.textContent = "Please enter your counter/badge number."; errEl.style.display="block"; return; }
  errEl.style.display = "none";
  const empData = empDocMap[n];
  if (!empData || String(empData.memberNum) !== counter) {
    errEl.textContent = "Counter/badge number doesn't match. Check with your manager.";
    errEl.style.display = "block"; return;
  }
  const docId = empData.id;
  myEmpId = docId;
  if (empData.avatarUrl) { myAvatarUrl = empData.avatarUrl; applyAvatarToTopbar(empData.avatarUrl); }
  const updates = { loggedIn: true };
  if (email) updates.empEmail = email;
  updateDoc(doc(db,"stores",s,"employees",docId), updates).catch(e => console.warn(e));
  store = s; name = n;
  saveSession({ store, name, role: "employee" });
  el("no-session").classList.remove("show");
  bootApp();
};

window.showMgrLoginForm = function() {
  const f = el("mgr-login-form");
  if (f) { f.style.display = "block"; }
  setTimeout(() => { const p = el("ns-mgr-pin"); if (p) p.focus(); }, 100);
};

window.mgrLoginFromForm = async function() {
  const s       = (el("ns-mgr-store")?.value.trim()   || "");
  const counter = el("ns-mgr-counter")?.value.trim() || "";
  const pin     = el("ns-mgr-pin")?.value.trim()     || "";
  const err     = el("ns-err");
  if (err) err.style.display = "none";
  if (!s)       { if(err){err.textContent="Enter your store number.";err.style.display="block";} return; }
  if (!counter) { if(err){err.textContent="Enter your counter / badge number.";err.style.display="block";} return; }
  if (!pin)     { if(err){err.textContent="Enter your manager PIN.";err.style.display="block";} return; }
  try {
    // Verify store PIN
    const storeSnap = await getDoc(doc(db,"stores",s));
    if (!storeSnap.exists() || storeSnap.data().pin !== pin) {
      if(err){err.textContent="Incorrect PIN.";err.style.display="block";} return;
    }
    // Look up employee record by counter # to get manager's name
    const empSnap = await getDocs(
      query(collection(db,"stores",s,"employees"), where("memberNum","==",counter))
    );
    if (empSnap.empty) {
      if(err){err.textContent="Counter # not found in roster — set up your store first or contact your admin.";err.style.display="block";}
      return;
    }
    const mgrName  = empSnap.docs[0].data().name || "Manager";
    const storeData = storeSnap.data();
    store = s; name = mgrName; mgrLoggedIn = true;
    saveMgrSession({ store, on: true });
    saveSession({ store, name: mgrName, role: "manager",
                  managerPhone: storeData.managerPhone||"", helpdeskPhone: storeData.helpdeskPhone||"" });
    el("no-session").classList.remove("show");
    bootApp();
  } catch(e) { if(err){err.textContent="Error: "+e.message;err.style.display="block";} return; }
};

el("ns-store").addEventListener("input",  onNsStoreInput);
el("ns-store").addEventListener("keydown", e => { if (e.key === "Enter") noSessionLogin(); });

window.switchUser = async function() {
  if (!confirm("Log out and switch user? Your session will end.")) return;
  try {
    const snap = await getDocs(
      query(collection(db, "stores", store, "employees"), where("name","==",name))
    );
    if (!snap.empty) await updateDoc(snap.docs[0].ref, { loggedIn: false });
  } catch(_) {}
  localStorage.removeItem("cc_v2_session");
  location.reload();
};

async function bootApp() {
  const ms = loadMgrSession();
  if (ms && ms.store === store && ms.on) mgrLoggedIn = true;

  el("tb-store").textContent = "Store " + store;
  el("tb-store").classList.remove("hidden");
  el("tb-user").textContent  = name + (mgrLoggedIn ? " 🔑" : "");
  el("tb-user").classList.remove("hidden");
  el("tb-avatar-btn").classList.remove("hidden");
  el("btn-switch-user").classList.remove("hidden");
  el("bottom-nav").classList.add("show");
  el("log-date").textContent = new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
  el("banner-store").textContent = store;

  listenEntries();
  listenMyMsgs();

  await loadStorePin();

  applyRoleUI(mgrLoggedIn);
  if (mgrLoggedIn) activateMgrPanel();
  const tab = new URLSearchParams(location.search).get("tab");
  if (tab) navTo(tab); else goScreen("log");   // all users land on logbook
}

async function loadStorePin() {
  try {
    const snap = await getDoc(doc(db,"stores",store));
    if (snap.exists()) {
      const d     = snap.data();
      storePin        = d.pin            || "";
      repliesEnabled  = d.repliesEnabled || false;
      dmEmail         = d.dmEmail        || "";
      recapEmail      = d.recapEmail     || "";
      notifyEntry       = d.notifyEntry    !== false;
      notifyFlagged     = d.notifyFlagged  !== false;
      notifyMessages    = d.notifyMessages !== false;
      notifyDone        = d.notifyDone     === true;
    }
  } catch(e) { console.error("loadStorePin:", e); }
}

// ── ROLE-BASED UI ─────────────────────────────────────────────
// Show/hide nav items based on role. To add a new role-specific nav
// item, just set data-role="employee" or data-role="manager" on it.
function applyRoleUI(isManager) {
  document.querySelectorAll("[data-role='employee']").forEach(btn => {
    btn.style.display = isManager ? "none" : "";
  });
  document.querySelectorAll("[data-role='manager']").forEach(btn => {
    btn.style.display = isManager ? "" : "none";
  });
}

function _updateMgrNavBtn() {
  applyRoleUI(mgrLoggedIn);
}

async function loadStoreSettings() {
  await loadStorePin();
  try {
    const snap = await getDoc(doc(db,"stores",store));
    if (snap.exists()) {
      const d = snap.data();
      el("mgr-name-disp").value     = d.managerName   || "";
      el("mgr-phone-disp").value    = d.managerPhone   || "";
      el("mgr-helpdesk-disp").value = d.helpdeskPhone  || "";
    }
  } catch(_) {}
  el("mgr-dm-email-disp").value    = dmEmail;
  el("mgr-recap-email-disp").value = recapEmail;
  el("notify-entry").checked       = notifyEntry;
  el("notify-flagged").checked     = notifyFlagged;
  el("notify-messages").checked    = notifyMessages;
  el("notify-done").checked        = notifyDone;
  el("mgr-new-pin").value = "";
}

window.saveStoreSettings = async function() {
  const newMgrName  = el("mgr-name-disp").value.trim();
  const newMgrPhone = el("mgr-phone-disp").value.trim();
  const newHelpdesk = el("mgr-helpdesk-disp").value.trim();
  const newDm       = el("mgr-dm-email-disp").value.trim();
  const newRecap    = el("mgr-recap-email-disp").value.trim();
  const newNE       = el("notify-entry").checked;
  const newNF       = el("notify-flagged").checked;
  const newNM       = el("notify-messages").checked;
  const newND       = el("notify-done").checked;
  const newPin      = el("mgr-new-pin").value.trim();
  if (newPin && newPin.length < 4) { alert("PIN must be at least 4 characters."); return; }
  try {
    const updates = {
      managerName: newMgrName, managerPhone: newMgrPhone, helpdeskPhone: newHelpdesk,
      dmEmail: newDm, recapEmail: newRecap,
      notifyEntry: newNE, notifyFlagged: newNF, notifyMessages: newNM, notifyDone: newND
    };
    if (newPin) { updates.pin = newPin; storePin = newPin; }
    await updateDoc(doc(db,"stores",store), updates);
    dmEmail = newDm; recapEmail = newRecap;
    notifyEntry = newNE; notifyFlagged = newNF; notifyMessages = newNM; notifyDone = newND;
    el("mgr-new-pin").value = "";
    const ok = el("settings-ok");
    ok.classList.add("show");
    setTimeout(() => ok.classList.remove("show"), 2500);
  } catch(e) { alert("Error saving settings: " + e.message); }
};

// ── EMPLOYEE SETTINGS ─────────────────────────────────────────
async function loadEmpSettings() {
  if (!store || !name) return;
  try {
    const snap = await getDocs(
      query(collection(db, "stores", store, "employees"), where("name", "==", name))
    );
    if (snap.empty) return;
    const d = snap.docs[0].data();
    el("emp-settings-email").value           = d.empEmail          || "";
    el("emp-notify-entries").checked         = d.notifyEntries     !== false;
    el("emp-notify-messages").checked        = d.notifyMessages    !== false;
    el("emp-notify-coaching").checked        = d.notifyCoaching    !== false;
    el("emp-notify-done").checked            = d.notifyDone        !== false;
  } catch(e) { console.warn("loadEmpSettings:", e); }
}

window.saveEmpSettings = async function() {
  if (!store || !name) return;
  const email          = el("emp-settings-email").value.trim();
  const notifyEntries  = el("emp-notify-entries").checked;
  const notifyMessages = el("emp-notify-messages").checked;
  const notifyCoaching = el("emp-notify-coaching").checked;
  const notifyDone     = el("emp-notify-done").checked;
  const errEl = el("emp-settings-email-err");
  const okEl  = el("emp-settings-ok");

  // Email is required
  if (!email) {
    errEl.style.display = "block";
    el("emp-settings-email").focus();
    return;
  }
  errEl.style.display = "none";

  try {
    const snap = await getDocs(
      query(collection(db, "stores", store, "employees"), where("name", "==", name))
    );
    if (snap.empty) { alert("Could not find your employee record. Contact your manager."); return; }
    const updates = { empEmail: email, notifyEntries, notifyMessages, notifyCoaching, notifyDone };
    await updateDoc(snap.docs[0].ref, updates);
    okEl.classList.add("show");
    setTimeout(() => okEl.classList.remove("show"), 2500);
  } catch(e) { alert("Error saving settings: " + e.message); }
};

function fireRecapNotif(type, payload) {
  if (!recapEmail) return;
  if (type === "entry"   && !notifyEntry)    return;
  if (type === "flagged" && !notifyFlagged)  return;
  if (type === "message" && !notifyMessages) return;
  if (type === "done"    && !notifyDone)     return;
  httpsCallable(functions, "sendRecapNotification")({
    storeId: store, type, data: payload
  }).catch(e => console.warn("Recap notif:", e));
}

// ── NAVIGATION ────────────────────────────────────────────────
function goScreen(s) {
  document.querySelectorAll(".screen").forEach(x => x.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(x => x.classList.remove("on"));
  el("mgr-banner").classList.remove("show");
  if (s === "mgr") {
    mgrViewingInbox = false;  // default tab is All Entries, not Inbox
  } else {
    mgrViewingInbox = false;
  }
  if (!s) return;
  const sc = el("screen-"+s); if (sc) sc.classList.add("active");
  const nb = el("nav-"+s);    if (nb) nb.classList.add("on");
}
window.goScreen = goScreen;
window.goBack   = () => { window.location.href = "/coach"; };

window.navTo = (dest) => {
  // Role guards — prevent cross-role navigation
  if (mgrLoggedIn && ["settings", "msg"].includes(dest)) {
    goScreen("mgr"); return;
  }
  if (dest === "mgr" && !mgrLoggedIn) {
    document.querySelectorAll(".screen").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".nav-btn").forEach(x => x.classList.remove("on"));
    el("nav-mgr").classList.add("on");
    el("mgr-banner").classList.add("show");
    setTimeout(() => el("b-pin").focus(), 100);
  } else if (dest === "feedback" && !mgrLoggedIn) {
    // Feedback requires manager login — redirect to manager panel first
    document.querySelectorAll(".screen").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".nav-btn").forEach(x => x.classList.remove("on"));
    el("nav-mgr").classList.add("on");
    el("mgr-banner").classList.add("show");
    setTimeout(() => el("b-pin").focus(), 100);
  } else if (dest === "feedback") {
    // Feedback lives inside the manager panel — switch to mgr screen, then select the feedback sub-tab
    goScreen("mgr");
    const feedbackBtn = el("mgr-tab-feedback-btn");
    if (feedbackBtn) feedbackBtn.click();
  } else {
    goScreen(dest);
    if (dest === "coaching") {
      if (mgrLoggedIn) {
        el("coaching-section-head").textContent = "\uD83C\uDFEA Store Coaching Records";
        el("coaching-subtitle").textContent = "All coaching records for your store";
      } else {
        el("coaching-section-head").textContent = "\uD83D\uDCCB My Coaching Records";
        el("coaching-subtitle").textContent = "Private \u2014 visible only to you";
      }
      loadMyCoaching();
    }
    if (dest === "settings") loadEmpSettings();
  }
};

window.setMgrTab = (tab, btn) => {
  document.querySelectorAll(".mgr-tab").forEach(b => b.classList.remove("on"));
  document.querySelectorAll(".mgr-tab-pane").forEach(p => p.classList.remove("on"));
  btn.classList.add("on");
  el("mgr-pane-"+tab).classList.add("on");
  mgrViewingInbox = (tab === "inbox");
  if (tab === "inbox")    markMsgsRead(_lastInboxMsgs);
  if (tab === "roster")   loadMgrRoster();
  if (tab === "settings") loadStoreSettings();
};

// ── MANAGER LOGIN (banner) ────────────────────────────────────
window.bannerLogin = async () => {
  const pin = v("b-pin");
  if (!pin) return;
  if (!storePin) await loadStorePin();
  if (!storePin) {
    el("b-err").textContent = "Store PIN not set up yet. Go to Counter Coach → Manager Setup first.";
    el("b-err").classList.add("show"); return;
  }
  if (pin !== storePin) {
    el("b-err").classList.add("show"); return;
  }
  el("b-err").classList.remove("show");
  el("b-pin").value = "";
  mgrLoggedIn = true;
  saveMgrSession({ store, on: true });
  el("tb-user").textContent = name + " 🔑";
  applyRoleUI(true);
  activateMgrPanel();
  goScreen("log");   // stay on logbook after PIN entry
};

el("b-pin").addEventListener("keydown", e => { if (e.key === "Enter") bannerLogin(); });

function activateMgrPanel() {
  el("mgr-store-sub").textContent = "Store " + store;
  el("qr-store-lbl").textContent  = store;
  buildQR();
  listenMgrEntries();
  listenMgrInbox();
  // CC Hub link — only visible for the designated admin store
  const ccHubBtn = el("mgr-tab-cchub-btn");
  if (ccHubBtn) ccHubBtn.style.display = (store === "2278") ? "" : "none";
}

window.logoutMgr = () => {
  mgrLoggedIn = false;
  clearMgrSession();
  el("tb-user").textContent = name;
  if (unsubMgrEntries)    { unsubMgrEntries();    unsubMgrEntries    = null; }
  if (unsubMgrMsgs)       { unsubMgrMsgs();       unsubMgrMsgs       = null; }
  el("mgr-dot").classList.remove("show");
  applyRoleUI(false);
  goScreen("log");
};


// ── PHOTO ATTACH TO EXISTING ENTRY ───────────────────────────
window.attachPhotoToEntry = async (entryId, input) => {
  const files = Array.from(input.files); if (!files.length) return;
  input.disabled = true;
  const label = input.previousElementSibling;
  label.textContent = "Uploading…";
  try {
    const snap    = await getDoc(doc(db, "stores", store, "entries", entryId));
    const cur     = snap.data() || {};
    const existing = cur.photos && cur.photos.length ? cur.photos
                   : cur.photoURL ? [cur.photoURL] : [];
    const slots   = 4 - existing.length;
    if (slots <= 0) { alert("This entry already has 4 photos."); input.disabled = false; label.textContent = "📷 Add Photo"; return; }
    const toUpload = files.slice(0, slots);
    const newUrls = await Promise.all(toUpload.map((f, i) => uploadPhoto(f, entryId, existing.length + i)));
    const urls = [...existing, ...newUrls];
    await updateDoc(doc(db,"stores",store,"entries",entryId), { photos: urls, photoURL: urls[0] });
  } catch(e) {
    alert("Upload error: " + e.message);
    label.textContent = "📷 Add Photo";
    input.disabled = false;
  }
};

// ── LIGHTBOX ─────────────────────────────────────────────────
window.openLightbox = (url) => {
  el("lightbox-img").src = url;
  el("lightbox").classList.add("show");
  document.body.style.overflow = "hidden";
};
window.closeLightbox = () => {
  el("lightbox").classList.remove("show");
  document.body.style.overflow = "";
};
document.addEventListener("keydown", e => { if (e.key === "Escape") closeLightbox(); });

// ── ENTRIES ───────────────────────────────────────────────────
window.selectType = (btn) => {
  document.querySelectorAll(".tpill").forEach(b => b.classList.remove("on"));
  btn.classList.add("on");
};

window.previewPhoto = (input) => {
  const incoming = Array.from(input.files);
  const slots = 4 - pendingPhotoFiles.length;
  if (slots <= 0) { alert("Maximum 4 photos per entry."); input.value = ""; return; }
  const adding = incoming.slice(0, slots);
  if (incoming.length > slots) alert(`Only ${slots} slot(s) left — adding first ${slots}.`);
  pendingPhotoFiles.push(...adding);
  input.value = "";
  renderPhotoPreview();
};

window.removePhoto = (index) => {
  if (index === undefined) {
    pendingPhotoFiles = [];
  } else {
    pendingPhotoFiles.splice(index, 1);
  }
  renderPhotoPreview();
};

function renderPhotoPreview() {
  const wrap  = el("photo-preview-wrap");
  const label = el("photo-label");
  if (!pendingPhotoFiles.length) {
    wrap.innerHTML = "";
    label.textContent = "📷 Add Photos";
    return;
  }
  wrap.innerHTML = pendingPhotoFiles.map((f, i) => {
    const url = URL.createObjectURL(f);
    return `<div class="preview-thumb-wrap">
      <img class="preview-thumb" src="${url}" alt="photo ${i+1}">
      <button class="btn-remove-thumb" onclick="removePhoto(${i})">✕</button>
    </div>`;
  }).join("");
  const count = pendingPhotoFiles.length;
  label.textContent = count >= 4 ? "📷 4 / 4" : `📷 Add Photos (${count}/4)`;
}

async function uploadPhoto(file, entryId, index = 0) {
  const compressed = await compressImage(file);
  const path = `entries/${store}/${entryId}_${index}.jpg`;
  const sRef = ref(storage, path);
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(sRef, compressed, { contentType: "image/jpeg" });
    task.on("state_changed", null, reject,
      async () => { resolve(await getDownloadURL(task.snapshot.ref)); }
    );
  });
}

window.addEntry = async () => {
  const txt  = v("new-text"); if (!txt) return;
  const pill = document.querySelector(".tpill.on");
  const type = pill ? pill.dataset.type : "progress";
  const btn  = document.querySelector(".btn-add");
  btn.disabled = true; btn.textContent = "Saving…";

  const barWrap = document.querySelector(".upload-bar-wrap");
  const bar     = document.querySelector(".upload-bar");
  if (pendingPhotoFiles.length) { barWrap.classList.add("show"); bar.style.width = "0%"; }

  try {
    const docRef = await addDoc(collection(db,"stores",store,"entries"), {
      store, author: name, text: txt, type,
      status: "open", time: Date.now(), ts: serverTimestamp(),
      photos: [], photoURL: null
    });

    if (pendingPhotoFiles.length) {
      const files = [...pendingPhotoFiles];
      barWrap.classList.add("show"); bar.style.width = "10%";
      const urls = await Promise.all(files.map((f, i) => uploadPhoto(f, docRef.id, i)));
      bar.style.width = "100%";
      await updateDoc(docRef, { photos: urls, photoURL: urls[0] });
    }

    el("new-text").value = "";
    removePhoto();
    const notifType = (type === "issue") ? "flagged" : "entry";
    fireRecapNotif(notifType, { author: name, text: txt, type, time: Date.now() });
  } catch(e) {
    alert("Save error: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "Add";
    barWrap.classList.remove("show");
    bar.style.width = "0%";
  }
};

window.toggleDone = async (id, cur) => {
  const next = cur === "complete" ? "open" : "complete";
  await updateDoc(doc(db,"stores",store,"entries",id), { status: next }).catch(e => alert(e.message));
  if (next === "complete") {
    const entry = allEntriesMgr.find(e => e.id === id);
    if (entry) fireRecapNotif("done", { author: entry.author, text: entry.text, type: entry.type, time: Date.now() });
  }
};

window.confirmClear = async (id) => {
  if (!confirm("Clear this completed entry from the log?")) return;
  await deleteDoc(doc(db,"stores",store,"entries",id)).catch(e => alert(e.message));
};

window.confirmAllDone = async () => {
  if (!confirm("Clear ALL completed entries? This cannot be undone.")) return;
  const batch = writeBatch(db);
  allEntriesMgr.filter(e => e.status === "complete")
                .forEach(e => batch.delete(doc(db,"stores",store,"entries",e.id)));
  await batch.commit().catch(e => alert(e.message));
};

window.setFilter = (f, btn) => {
  filterVal = f;
  document.querySelectorAll(".fpill").forEach(b => b.classList.remove("on"));
  btn.classList.add("on");
  renderEmpEntries();
};

function _entriesQuery() {
  return query(collection(db,"stores",store,"entries"), orderBy("time","desc"), limit(200));
}
function _entriesQueryFallback() {
  return collection(db,"stores",store,"entries");
}

function listenEntries() {
  if (unsubEntries) unsubEntries();
  unsubEntries = onSnapshot(_entriesQuery(), snap => {
    allEntries = snap.docs.map(d => ({id:d.id,...d.data()}));
    renderEmpEntries();
    updateStats();
  }, err => {
    if (unsubEntries) unsubEntries();
    unsubEntries = onSnapshot(_entriesQueryFallback(), snap => {
      allEntries = snap.docs.map(d => ({id:d.id,...d.data()})).sort((a,b) => b.time - a.time);
      renderEmpEntries();
      updateStats();
    }, e => console.error("entries:", e));
  });
}

function renderMgrEntries() {
  const doneCount = allEntriesMgr.filter(e => e.status === "complete").length;
  el("ms-open").textContent  = allEntriesMgr.filter(e => e.status === "open").length;
  el("ms-done").textContent  = doneCount;
  el("ms-total").textContent = allEntriesMgr.length;
  el("confirm-all-bar").classList.toggle("hidden", doneCount === 0);
  el("mgr-dot").classList.toggle("show", doneCount > 0 && !mgrLoggedIn);
  el("mgr-entries-list").innerHTML = allEntriesMgr.length
    ? allEntriesMgr.map(e => mgrEntryCard(e)).join("")
    : '<div class="empty"><div class="ei">📋</div><p>No entries yet.</p></div>';
}

function listenMgrEntries() {
  if (unsubMgrEntries) unsubMgrEntries();
  unsubMgrEntries = onSnapshot(_entriesQuery(), snap => {
    allEntriesMgr = snap.docs.map(d => ({id:d.id,...d.data()}));
    renderMgrEntries();
  }, err => {
    if (unsubMgrEntries) unsubMgrEntries();
    unsubMgrEntries = onSnapshot(_entriesQueryFallback(), snap => {
      allEntriesMgr = snap.docs.map(d => ({id:d.id,...d.data()})).sort((a,b) => b.time - a.time);
      renderMgrEntries();
    }, e => console.error("mgr-entries:", e));
  });
}

function updatePillCounts() {
  const total    = allEntries.length;
  const open     = allEntries.filter(e => e.status === "open").length;
  const progress = allEntries.filter(e => e.type === "progress").length;
  const issues   = allEntries.filter(e => e.type === "issue").length;
  const notes    = allEntries.filter(e => e.type === "note").length;
  const counts   = { all: total, open, progress: progress, issue: issues, note: notes };
  document.querySelectorAll(".fpill[data-filter]").forEach(btn => {
    const key = btn.dataset.filter;
    const n   = counts[key];
    btn.textContent = btn.dataset.label + (n != null && n > 0 ? ` ${n}` : "");
  });
}

function renderEmpEntries() {
  updatePillCounts();
  let rows = allEntries;
  if      (filterVal === "open")     rows = allEntries.filter(e => e.status === "open");
  else if (filterVal === "done")     rows = allEntries.filter(e => e.status === "complete");
  else if (filterVal === "issue")    rows = allEntries.filter(e => e.type === "issue");
  else if (filterVal === "progress") rows = allEntries.filter(e => e.type === "progress");
  else if (filterVal === "note")     rows = allEntries.filter(e => e.type === "note");
  el("entries-list").innerHTML = rows.length
    ? rows.map(e => empEntryCard(e)).join("")
    : '<div class="empty"><div class="ei">📋</div><p>No entries here yet.</p></div>';
}

function entryPhotosHtml(e, inputId) {
  const urls = e.photos && e.photos.length ? e.photos : e.photoURL ? [e.photoURL] : [];
  const grid = urls.map(u =>
    `<img src="${esc(u)}" loading="lazy" onclick="openLightbox('${esc(u)}')" alt="photo">`
  ).join("");
  const addBtn = urls.length < 4
    ? `<div class="mgr-photo-attach"><label class="btn-photo-sm" for="${inputId}">📷 Add Photo</label><input type="file" id="${inputId}" accept="image/*" style="display:none" onchange="attachPhotoToEntry('${e.id}',this)"></div>`
    : "";
  return `${urls.length ? `<div class="entry-photo">${grid}</div>` : ""}${addBtn}`;
}

function empEntryCard(e) {
  const emoji  = {progress:"📈",issue:"⚠️",note:"📝"};
  const bClass = {progress:"badge-progress",issue:"badge-issue",note:"badge-note"};
  const done   = e.status === "complete";
  return `<div class="entry-card ${done?"done":""}" data-type="${esc(e.type)}">
    <div class="entry-top">
      <div class="entry-text">${esc(e.text)}</div>
      <span class="badge ${bClass[e.type]||"badge-note"}">${emoji[e.type]||"📝"} ${e.type}</span>
    </div>
    ${entryPhotosHtml(e, "emp-photo-"+e.id)}
    <div class="entry-footer">
      <div class="entry-meta"><span class="by">${esc(e.author)}</span> — ${ts(e.time)}</div>
      <button class="btn-done ${done?"is-done":""}" onclick="toggleDone('${e.id}','${e.status}')">
        ${done ? "↩ Reopen" : "✔ Done"}
      </button>
    </div>
  </div>`;
}

function mgrEntryCard(e) {
  const emoji  = {progress:"📈",issue:"⚠️",note:"📝"};
  const bClass = {progress:"badge-progress",issue:"badge-issue",note:"badge-note"};
  const done   = e.status === "complete";
  return `<div class="entry-card ${done?"pending-clear":""}" data-type="${esc(e.type)}">
    <div class="entry-top">
      <div class="entry-text">${esc(e.text)}</div>
      <span class="badge ${bClass[e.type]||"badge-note"}">${emoji[e.type]||"📝"} ${e.type}</span>
    </div>
    ${entryPhotosHtml(e, "mgr-photo-"+e.id)}
    <div class="entry-footer">
      <div class="entry-meta"><span class="by">${esc(e.author)}</span> — ${ts(e.time)}</div>
      <div class="entry-actions">
        ${done
          ? `<span class="lbl-done">✔ Done by employee</span>
             <button class="btn-clear" onclick="confirmClear('${e.id}')">✕ Clear</button>`
          : `<span style="font-size:11px;color:var(--ink-faint)">Open</span>`}
      </div>
    </div>
  </div>`;
}

function updateStats() {
  el("s-open").textContent  = allEntries.filter(e => e.status === "open").length;
  el("s-done").textContent  = allEntries.filter(e => e.status === "complete").length;
  el("s-total").textContent = allEntries.length;
}

// ── MESSAGES ─────────────────────────────────────────────────
window.sendMsg = async () => {
  const txt = v("msg-text"); if (!txt) return;
  try {
    await addDoc(collection(db,"stores",store,"messages"), {
      store, from: name, text: txt,
      time: Date.now(), ts: serverTimestamp(), read: false
    });
    el("msg-text").value = "";
    fireRecapNotif("message", { from: name, text: txt, time: Date.now() });
  } catch(e) { alert("Send error: " + e.message); }
};

// ── COACHING RECORD ACTIONS (PDF / Email) ────────────────────
let _coachCache = {};   // id → full coaching record, populated by loadMyCoaching()

function generateCoachingPDF(d) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const lm = 20, rw = 170;
  let y = 20;
  function checkPage(n) { if (y + n > 270) { doc.addPage(); y = 20; } }
  function heading(text) {
    checkPage(14); doc.setFont("helvetica","bold"); doc.setFontSize(10);
    doc.setTextColor(28,58,42); doc.text(text.toUpperCase(), lm, y); y += 4;
    doc.setDrawColor(200,230,210); doc.line(lm, y, lm+rw, y); y += 5;
    doc.setTextColor(26,26,22); doc.setFont("helvetica","normal"); doc.setFontSize(11);
  }
  function field(label, value) {
    if (!value) return; checkPage(14);
    doc.setFont("helvetica","bold"); doc.setFontSize(10); doc.text(label+":", lm, y); y += 5;
    doc.setFont("helvetica","normal"); doc.setFontSize(10);
    const lines = doc.splitTextToSize(String(value), rw);
    checkPage(lines.length*5+4); doc.text(lines, lm, y); y += lines.length*5+4;
  }
  doc.setFont("helvetica","bold"); doc.setFontSize(16); doc.setTextColor(28,58,42);
  doc.text("Employee Coaching Record", lm, y); y += 8; doc.setTextColor(26,26,22);
  heading("Store Information"); field("Store Number",d.store); field("Manager",d.manager); field("Date",d.date);
  heading("Employee"); field("Employee Name",d.name); field("Issue Type",d.issue);
  heading("Coaching Details"); field("Incident",d.incident); field("Expected Behavior",d.expected);
  field("Counter / Employee #",d.empCounter); field("Corrective Action",d.action);
  if (d.systemWriteupDone) {
    heading("Company System Writeup");
    field("Status","Completed in company HR / discipline system prior to this record");
    if (d.systemRef) field("Reference #",d.systemRef);
  }
  checkPage(60); heading("Signatures");
  const sigY = y;
  if (d.mgrSig) { try { doc.addImage(d.mgrSig,"PNG",lm,sigY,72,32); } catch(_){} }
  else doc.rect(lm,sigY,72,32);
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text("Manager Signature",lm,sigY+36); doc.text(d.manager||"",lm,sigY+41);
  const ex = lm+90;
  if (d.empSig) { try { doc.addImage(d.empSig,"PNG",ex,sigY,72,32); } catch(_){} }
  else {
    doc.rect(ex,sigY,72,32); doc.setFont("helvetica","italic"); doc.setFontSize(8);
    doc.setTextColor(140,140,140); doc.text("Signature pending",ex+2,sigY+17); doc.setTextColor(26,26,22);
  }
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text("Employee Signature",ex,sigY+36); doc.text(d.name||"",ex,sigY+41);
  y = sigY+50; checkPage(16);
  doc.setFont("helvetica","italic"); doc.setFontSize(8); doc.setTextColor(130,130,120);
  const disc = "Signing this document acknowledges receipt of this coaching record, not necessarily agreement with its contents. This record is confidential and for internal use only.";
  doc.text(doc.splitTextToSize(disc,rw),lm,y);
  return doc;
}

window.coachPDF = function(id) {
  const r = _coachCache[id];
  if (!r || !window.jspdf) return;
  const doc   = generateCoachingPDF(r);
  const fname = `Coaching_${(r.name||"Employee").replace(/\s+/g,"_")}_${(r.date||"").replace(/[/:,\s]/g,"")}.pdf`;
  doc.save(fname);
};

window.coachEmail = async function(id, btn) {
  const r = _coachCache[id];
  if (!r || !window.jspdf) return;
  if (btn) { btn.disabled = true; btn.textContent = "Sending\u2026"; }
  try {
    const pdfBase64 = generateCoachingPDF(r).output("datauristring").split(",")[1];
    await httpsCallable(functions, "sendCoachingEmail")({
      storeId: r.store || store, coachingId: id,
      employeeName: r.name || "", date: r.date || "",
      type: r.type || "Coaching", pdfBase64
    });
    if (btn) {
      btn.textContent = "\u2713 Sent!";
      setTimeout(() => { btn.disabled = false; btn.textContent = "\uD83D\uDCE7 Email DM"; }, 3000);
    }
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = "\uD83D\uDCE7 Email DM"; }
    alert("Email failed: " + (e.message || String(e)));
  }
};

async function loadMyCoaching() {
  const listEl = el("coaching-list");
  listEl.innerHTML = '<div style="text-align:center;padding:36px 0;color:var(--ink-faint);font-size:14px;">Loading\u2026</div>';
  try {
    const q = mgrLoggedIn
      ? query(collection(db,"stores",store,"coaching"), orderBy("savedAt","desc"))
      : query(collection(db,"stores",store,"coaching"), where("name","==",name));
    const snap = await getDocs(q);
    if (snap.empty) {
      listEl.innerHTML = `<div style="text-align:center;padding:36px 0;color:var(--ink-faint);font-size:14px;">${mgrLoggedIn ? "No coaching records on file for this store." : "No coaching records on file for you."}</div>`;
      return;
    }
    const records = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => (b.savedAt?.toMillis?.() || 0) - (a.savedAt?.toMillis?.() || 0));

    // Cache full records so coachPDF / coachEmail window functions can access them
    records.forEach(r => { _coachCache[r.id] = r; });

    if (!mgrLoggedIn) {
      const hasPending = records.some(r => r.status === "pending_employee");
      el("coaching-dot").style.display = hasPending ? "block" : "none";
    }

    // Local esc here intentionally matches the original (no HTML attributes, just text nodes)
    const escLocal = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    listEl.innerHTML = records.map(r => {
      const isPending   = r.status === "pending_employee";
      const borderColor = r.type === "Final Warning"   ? "var(--red)"
                        : r.type === "Written Warning" ? "var(--amber)"
                        :                                "var(--forest-light)";
      const statusHtml  = isPending
        ? `<span style="font-size:11px;font-weight:700;color:var(--amber);">&#x26A0;&#xFE0F; Signature needed</span>`
        : `<span style="font-size:11px;font-weight:700;color:var(--forest);">&#x2714;&#xFE0F; Signed</span>`;
      const empNameRow = mgrLoggedIn && r.name
        ? `<div style="font-size:11px;color:var(--ink-soft);margin-top:2px;font-weight:600;">&#x1F464; ${escLocal(r.name)}</div>`
        : "";
      const actionsRow = mgrLoggedIn ? `
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <button class="btn-action" onclick="coachPDF('${r.id}')">&#x1F4C4; PDF</button>
          ${isPending
            ? `<a href="coaching.html?sign=${r.id}" class="btn-action btn-action-coach" style="text-decoration:none;">&#x270D;&#xFE0F; Review &amp; Sign</a>`
            : ""}
          ${r.empSig
            ? `<button class="btn-action" onclick="coachEmail('${r.id}', this)">&#x1F4E7; Email DM</button>`
            : ""}
        </div>` : "";
      return `
        <div class="entry-card" style="border-left-color:${borderColor};">
          <div class="entry-top">
            <div style="flex:1;">
              <div style="font-weight:700;font-size:14px;">${escLocal(r.issue || "Coaching")}</div>
              <div style="font-size:11px;color:var(--ink-soft);margin-top:2px;">${escLocal(r.type || "")}</div>
              ${empNameRow}
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div style="font-size:11px;color:var(--ink-faint);margin-bottom:3px;">${escLocal(r.date || "")}</div>
              ${statusHtml}
            </div>
          </div>
          ${r.incident ? `<div style="font-size:13px;color:var(--ink-soft);margin-top:8px;line-height:1.6;font-family:'Courier Prime',monospace;">${escLocal(r.incident)}</div>` : ""}
          ${actionsRow}
        </div>`;
    }).join("");
  } catch(e) {
    listEl.innerHTML = `<div style="text-align:center;padding:36px 0;color:var(--red);font-size:14px;">Error loading records: ${e.message}</div>`;
  }
}

function listenMyMsgs() {
  if (unsubMsgs) unsubMsgs();
  const q = query(collection(db,"stores",store,"messages"),
    where("from","==",name));
  unsubMsgs = onSnapshot(q, snap => {
    myMsgs = snap.docs.map(d => ({id:d.id,...d.data()})).sort((a,b) => b.time - a.time);
    renderMsgs(myMsgs, "msg-list", false);
    renderEmpEntries();
  }, e => console.error("msgs:", e));
}

function listenMgrInbox() {
  if (unsubMgrMsgs) unsubMgrMsgs();
  const q = collection(db,"stores",store,"messages");
  unsubMgrMsgs = onSnapshot(q, snap => {
    const msgs   = snap.docs.map(d => ({id:d.id,...d.data()})).sort((a,b) => b.time - a.time);
    const unread = msgs.filter(m => !m.read).length;
    el("mgr-dot").classList.toggle("show", unread > 0 && mgrLoggedIn);
    const cnt = el("inbox-cnt");
    if (unread > 0) { cnt.textContent = unread; cnt.classList.remove("hidden"); }
    else { cnt.classList.add("hidden"); }
    const bar = el("msg-notify-bar");
    if (unread > 0) { el("msg-notify-count").textContent = unread; bar.classList.remove("hidden"); }
    else { bar.classList.add("hidden"); }
    renderMsgs(msgs, "mgr-inbox-list", true);
    _lastInboxMsgs = msgs;
    if (mgrViewingInbox) markMsgsRead(msgs);
  }, e => console.error("mgr-msgs:", e));
}

let _lastInboxMsgs = [];
function markMsgsRead(msgs) {
  msgs.filter(m => !m.read).forEach(m =>
    updateDoc(doc(db,"stores",store,"messages",m.id),{read:true}).catch(()=>{})
  );
}

function renderMsgs(msgs, targetId, isMgr) {
  const container = el(targetId);
  if (!msgs.length) {
    container.innerHTML = '<div class="empty"><div class="ei">💬</div><p>No messages yet.</p></div>';
    return;
  }
  container.innerHTML = msgs.map(m => {
    const unread = isMgr && !m.read;
    const replyBubble = m.reply
      ? `<div class="reply-bubble"><strong>↩ ${esc(m.reply.from)} replied:</strong>${esc(m.reply.text)}</div>`
      : "";
    const replyForm = (isMgr && repliesEnabled && !m.reply)
      ? `<div class="reply-input-row">
           <textarea rows="1" id="ri-${esc(m.id)}" placeholder="Reply to ${esc(m.from)}…"></textarea>
           <button class="btn-reply-send" onclick="sendReply('${esc(m.id)}')">Send</button>
         </div>`
      : "";
    return `<div class="msg-card ${unread?"msg-unread":""}">
      <div class="msg-head">
        <span class="msg-from">From: ${esc(m.from)}</span>
        <span class="msg-lock">🔒 Private</span>
      </div>
      <div class="msg-text">${esc(m.text)}</div>
      ${replyBubble}
      ${replyForm}
      <div class="msg-time">${ts(m.time)}</div>
    </div>`;
  }).join("");
}

window.sendReply = async (msgId) => {
  const ta  = el("ri-" + msgId);
  const txt = ta ? ta.value.trim() : "";
  if (!txt) return;
  ta.disabled = true;
  ta.nextElementSibling.disabled = true;
  try {
    await updateDoc(doc(db, "stores", store, "messages", msgId), {
      reply: { from: name, text: txt, time: Date.now() }
    });
  } catch(e) {
    alert("Send error: " + e.message);
    ta.disabled = false;
    ta.nextElementSibling.disabled = false;
  }
};

// ── QR CODE ───────────────────────────────────────────────────
function buildQR() {
  const link = `${location.origin}${location.pathname}?store=${encodeURIComponent(store)}`;
  el("qr-canvas").innerHTML = "";
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
  s.onload = () => new QRCode(el("qr-canvas"),{text:link,width:200,height:200,colorDark:"#1c3a2a",colorLight:"#ffffff"});
  document.head.appendChild(s);
}

window.copyLink = () => {
  const link = `${location.origin}${location.pathname}?store=${encodeURIComponent(store)}`;
  navigator.clipboard.writeText(link).then(()=>alert("Link copied!")).catch(()=>prompt("Copy this link:",link));
};

// ── MANAGER FEEDBACK ─────────────────────────────────────────
let selectedFbType = "idea";

window.setFbType = (btn, type) => {
  document.querySelectorAll(".fb-type-pill").forEach(b => b.classList.remove("on"));
  btn.classList.add("on");
  selectedFbType = type;
};

window.sendFeedback = async () => {
  const text = el("fb-text").value.trim();
  const okEl  = el("fb-ok");
  const errEl = el("fb-err");
  okEl.style.display  = "none";
  errEl.style.display = "none";
  if (!text) { errEl.textContent = "Please describe your feedback before sending."; errEl.style.display = "block"; return; }
  if (!mgrLoggedIn) { errEl.textContent = "You must be logged in as a manager to submit feedback."; errEl.style.display = "block"; return; }
  try {
    await addDoc(collection(db, "feedback"), {
      store, from: name, type: selectedFbType, text,
      time: serverTimestamp(), status: "open", read: false
    });
    el("fb-text").value = "";
    okEl.style.display = "block";
    setTimeout(() => { okEl.style.display = "none"; }, 4000);
  } catch(e) { errEl.textContent = "Send error: " + e.message; errEl.style.display = "block"; }
};

// ── BRANDING ─────────────────────────────────────────────────
async function loadBranding() {
  try {
    const data = await fetchBrandingData(db);
    if (!data) return;
    if (data.appName) {
      document.title = "Daily Recap · " + data.appName;
      const brandEl = el("topbar-brand-text");
      if (brandEl) brandEl.textContent = data.appName;
    }
    if (data.logoUrl) {
      el("topbar-logo-img").src = data.logoUrl;
      el("topbar-logo-img").style.display = "inline-block";
      const brandEl = el("topbar-brand-text");
      if (brandEl) brandEl.style.display = "none";
    }
    if (data.brandColor) {
      document.documentElement.style.setProperty("--forest",       data.brandColor);
      document.documentElement.style.setProperty("--forest-mid",   data.brandColor);
      document.documentElement.style.setProperty("--forest-light", data.brandColor);
    }
  } catch(e) { /* non-fatal */ }
}

// ── MANAGER ROSTER ────────────────────────────────────────────
const ROSTER_TITLES = ["Parts Specialist","RSS","ISS","Assistant","Driver","Merchandiser","Store Manager"];

async function loadMgrRoster() {
  const listEl = el("mgr-roster-list");
  listEl.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const snap = await getDocs(
      query(collection(db,"stores",store,"employees"), orderBy("name"))
    );
    mgrRosterData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!mgrRosterData.length) {
      listEl.innerHTML = '<div class="empty">No employees on roster. Add one above.</div>';
      return;
    }
    renderMgrRoster();
  } catch(err) {
    listEl.innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
  }
}

// ── AVATAR HELPERS & MODALS ───────────────────────────────────────────────

function applyAvatarToTopbar(url) {
  if (url) localStorage.setItem("cc_avatar_url", url);
  else     localStorage.removeItem("cc_avatar_url");
  const img = el("tb-avatar-img");
  const ph  = el("tb-avatar-placeholder");
  if (url) {
    if (img) { img.src = url; img.style.display = "block"; }
    if (ph)  { ph.style.display = "none"; }
  } else {
    if (img) { img.src = ""; img.style.display = "none"; }
    if (ph)  { ph.style.display = "block"; }
  }
}

window.openAvatarModal = function() {
  const modal = el("avatar-modal");
  if (!modal) return;
  modal.style.display = "flex";
  const cur    = el("avatar-current-img");
  const circle = el("avatar-placeholder-circle");
  if (myAvatarUrl) {
    cur.src = myAvatarUrl; cur.style.display = "block";
    circle.style.display = "none";
  } else {
    cur.style.display = "none";
    circle.style.display = "flex";
  }
  el("avatar-status").textContent = "";
  el("avatar-use-btn").style.display = "none";
  el("avatar-remove-btn").style.display = myAvatarUrl ? "block" : "none";
  avatarPendingFile = null;
  const lbl = document.querySelector('label[for="avatar-file-input"]');
  if (lbl) lbl.textContent = myAvatarUrl ? "📷 Change Photo" : "📷 Choose / Take Photo";
};

window.closeAvatarModal = function() {
  const modal = el("avatar-modal");
  if (modal) modal.style.display = "none";
  avatarPendingFile = null;
};

window.handleAvatarFileChosen = function(input) {
  const file = input.files?.[0];
  if (!file) return;
  avatarPendingFile = file;
  const cur = el("avatar-current-img");
  cur.src = URL.createObjectURL(file);
  cur.style.display = "block";
  el("avatar-placeholder-circle").style.display = "none";
  el("avatar-status").textContent = "Photo selected — tap 'Use Photo As-Is' to save.";
  el("avatar-use-btn").style.display = "block";
  el("avatar-remove-btn").style.display = "none";
};

window.usePhotoAsIs = async function() {
  if (!avatarPendingFile) { alert("Please choose a photo first."); return; }
  if (!myEmpId) { alert("Employee record not found. Try logging out and back in."); return; }
  const btn = el("avatar-use-btn");
  btn.disabled = true; btn.textContent = "Saving…";
  el("avatar-status").textContent = "Compressing photo…";
  try {
    const compressed = await compressImage(avatarPendingFile, 512, 0.85);
    el("avatar-status").textContent = "Uploading photo…";
    const sRef = ref(storage, `avatars/${store}/${myEmpId}.jpg`);
    await uploadBytes(sRef, compressed, { contentType: "image/jpeg" });
    const url = await getDownloadURL(sRef);
    await updateDoc(doc(db, "stores", store, "employees", myEmpId), { avatarUrl: url });
    myAvatarUrl = url;
    applyAvatarToTopbar(myAvatarUrl);
    const cur = el("avatar-current-img");
    cur.src = myAvatarUrl; cur.style.display = "block";
    el("avatar-placeholder-circle").style.display = "none";
    el("avatar-status").textContent = "Photo saved!";
    el("avatar-remove-btn").style.display = "block";
    btn.textContent = "✅ Saved";
  } catch(e) {
    el("avatar-status").textContent = "Error: " + (e.message || "Unknown error");
    btn.textContent = "📷 Use Photo As-Is";
  } finally {
    btn.disabled = false;
    avatarPendingFile = null;
    const inp = el("avatar-file-input");
    if (inp) inp.value = "";
  }
};

window.removeMyAvatar = async function() {
  if (!confirm("Remove your avatar? This can't be undone.")) return;
  const btn = el("avatar-remove-btn");
  btn.disabled = true; btn.textContent = "Removing…";
  el("avatar-status").textContent = "Removing avatar…";
  try {
    if (myEmpId) {
      await updateDoc(doc(db, "stores", store, "employees", myEmpId), { avatarUrl: deleteField() });
      try { await deleteObject(ref(storage, `avatars/${store}/${myEmpId}.jpg`)); } catch(_) {}
    }
    myAvatarUrl = null;
    applyAvatarToTopbar(null);
    const cur = el("avatar-current-img");
    cur.src = ""; cur.style.display = "none";
    el("avatar-placeholder-circle").style.display = "flex";
    el("avatar-use-btn").style.display = "none";
    el("avatar-status").textContent = "Avatar removed.";
    const lbl = document.querySelector('label[for="avatar-file-input"]');
    if (lbl) lbl.textContent = "📷 Choose / Take Photo";
    btn.style.display = "none";
  } catch(e) {
    el("avatar-status").textContent = "Error: " + (e.message || "Unknown error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🗑️ Remove Avatar";
  }
};

window.openMgrAvatarModal = function(empId, empName, empRole) {
  mgrAvatarTargetId   = empId;
  mgrAvatarTargetRole = empRole;
  mgrAvatarPendingFile = null;
  const modal = el("mgr-avatar-modal");
  if (!modal) return;
  modal.style.display = "flex";
  el("mgr-avatar-emp-name").textContent = empName || "Employee";
  el("mgr-avatar-status").textContent = "";
  el("mgr-avatar-use-btn").style.display = "none";
  const emp = mgrRosterData.find(e => e.id === empId);
  const cur = el("mgr-avatar-current");
  const ph  = el("mgr-avatar-placeholder");
  if (emp?.avatarUrl) {
    cur.src = emp.avatarUrl; cur.style.display = "block";
    ph.style.display = "none";
  } else {
    cur.style.display = "none";
    ph.style.display = "flex";
  }
};

window.closeMgrAvatarModal = function() {
  const modal = el("mgr-avatar-modal");
  if (modal) modal.style.display = "none";
  mgrAvatarPendingFile = null;
};

window.handleMgrAvatarFile = function(input) {
  const file = input.files?.[0];
  if (!file) return;
  mgrAvatarPendingFile = file;
  const cur = el("mgr-avatar-current");
  cur.src = URL.createObjectURL(file);
  cur.style.display = "block";
  el("mgr-avatar-placeholder").style.display = "none";
  el("mgr-avatar-status").textContent = "Photo selected — tap 'Use Photo As-Is' to save.";
  el("mgr-avatar-use-btn").style.display = "block";
};

window.useMgrPhotoAsIs = async function() {
  if (!mgrAvatarPendingFile || !mgrAvatarTargetId) return;
  const btn = el("mgr-avatar-use-btn");
  btn.disabled = true; btn.textContent = "Saving…";
  el("mgr-avatar-status").textContent = "Compressing photo…";
  try {
    const compressed = await compressImage(mgrAvatarPendingFile, 512, 0.85);
    el("mgr-avatar-status").textContent = "Uploading photo…";
    const sRef = ref(storage, `avatars/${store}/${mgrAvatarTargetId}.jpg`);
    await uploadBytes(sRef, compressed, { contentType: "image/jpeg" });
    const url = await getDownloadURL(sRef);
    await updateDoc(doc(db, "stores", store, "employees", mgrAvatarTargetId), { avatarUrl: url });
    const emp = mgrRosterData.find(e => e.id === mgrAvatarTargetId);
    if (emp) emp.avatarUrl = url;
    renderMgrRoster();
    const cur = el("mgr-avatar-current");
    cur.src = url; cur.style.display = "block";
    el("mgr-avatar-placeholder").style.display = "none";
    el("mgr-avatar-status").textContent = "Photo saved!";
    btn.textContent = "✅ Saved";
  } catch(e) {
    el("mgr-avatar-status").textContent = "Error: " + (e.message || "Unknown error");
    btn.textContent = "📷 Use Photo As-Is";
  } finally {
    btn.disabled = false;
    mgrAvatarPendingFile = null;
    const inp = el("mgr-avatar-file-input");
    if (inp) inp.value = "";
  }
};

function renderMgrRoster() {
  const listEl = el("mgr-roster-list");
  if (!listEl) return;
  listEl.innerHTML = mgrRosterData.map(e => {
    // Include employee's current role even if it's not in the standard list
    const titleList = (e.role && !ROSTER_TITLES.includes(e.role))
      ? [e.role, ...ROSTER_TITLES]
      : ROSTER_TITLES;
    const opts = titleList.map(t =>
      `<option value="${t}"${e.role===t?' selected':''}>${t}</option>`
    ).join("");
    const avatarHtml = e.avatarUrl
      ? `<img src="${esc(e.avatarUrl)}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid var(--forest);flex-shrink:0;">`
      : `<div style="width:36px;height:36px;border-radius:50%;background:var(--mint);border:2px dashed var(--sage);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">👤</div>`;
    return `
      <div class="roster-item">
        <div class="roster-row">
          ${avatarHtml}
          <div style="flex:1;min-width:100px;">
            <div class="roster-name">${esc(e.name || "—")}</div>
            ${e.memberNum ? `<div class="roster-meta">#${esc(e.memberNum)}</div>` : ""}
          </div>
          <select class="roster-select" id="rs-title-${esc(e.id)}"
            onchange="saveMgrTitle('${esc(e.id)}',this)">${opts}</select>
          <span class="roster-saved" id="rs-saved-${esc(e.id)}">✓</span>
          <button class="btn-action"
            onclick="openMgrAvatarModal('${esc(e.id)}','${esc(e.name||'')}','${esc(e.role||'')}')">🖼️</button>
          <button class="btn-action btn-action-coach"
            onclick="coachEmployee('${esc(e.id)}')">&#x1F4CB; Coach</button>
          <button class="btn-action"
            onclick="toggleRosterEdit('${esc(e.id)}')">&#x270F;&#xFE0F; Edit</button>
          <button class="btn-action btn-action-red"
            onclick="deleteMgrEmployee('${esc(e.id)}','${esc(e.name||'')}')">&#x1F5D1;&#xFE0F; Delete</button>
        </div>
        <div class="roster-edit-row" id="re-row-${esc(e.id)}">
          <div>
            <div class="add-label">Name</div>
            <input type="text" class="roster-field-input" id="re-name-${esc(e.id)}"
              value="${esc(e.name||'')}" style="margin:0;width:140px;">
          </div>
          <div>
            <div class="add-label">Counter #</div>
            <input type="text" class="roster-field-input" id="re-num-${esc(e.id)}"
              value="${esc(e.memberNum||'')}" style="margin:0;width:100px;">
          </div>
          <div style="display:flex;align-items:flex-end;gap:6px;padding-bottom:2px;">
            <button class="btn-add" onclick="saveMgrEmployee('${esc(e.id)}')"
              style="padding:7px 14px;border-radius:8px;font-size:13px;">Save</button>
            <button class="btn-done" onclick="toggleRosterEdit('${esc(e.id)}')"
              style="padding:7px 14px;">Cancel</button>
          </div>
        </div>
      </div>`;
  }).join("");
}

window.saveMgrTitle = async function(id, sel) {
  try {
    await updateDoc(doc(db,"stores",store,"employees",id), { role: sel.value });
    const e = mgrRosterData.find(x => x.id === id);
    if (e) e.role = sel.value;
    flashRosterSaved(id);
  } catch(err) { alert("Error saving title: " + err.message); }
};

window.toggleRosterEdit = function(id) {
  const row = document.getElementById("re-row-" + id);
  if (row) row.classList.toggle("open");
};

window.saveMgrEmployee = async function(id) {
  const newName = document.getElementById("re-name-" + id)?.value.trim();
  const newNum  = document.getElementById("re-num-"  + id)?.value.trim();
  if (!newName) { alert("Name is required."); return; }
  await updateDoc(doc(db,"stores",store,"employees",id), {
    name: newName, memberNum: newNum || null
  }).catch(e => { alert("Error: " + e.message); return; });
  const e = mgrRosterData.find(x => x.id === id);
  if (e) { e.name = newName; e.memberNum = newNum || null; }
  flashRosterSaved(id);
  renderMgrRoster();
};

window.addMgrEmployee = async function() {
  const n     = el("roster-add-name").value.trim();
  const num   = el("roster-add-num").value.trim();
  const title = el("roster-add-title").value;
  const errEl = el("roster-add-err");
  errEl.style.display = "none";
  if (!n) { errEl.textContent = "Name is required."; errEl.style.display = "block"; return; }
  try {
    const ref = await addDoc(collection(db,"stores",store,"employees"), {
      store, name: n, role: title, memberNum: num || null,
      addedBy: "manager", addedAt: serverTimestamp()
    });
    mgrRosterData.push({ id: ref.id, store, name: n, role: title, memberNum: num || null });
    mgrRosterData.sort((a,b) => a.name.localeCompare(b.name));
    el("roster-add-name").value = "";
    el("roster-add-num").value  = "";
    renderMgrRoster();
  } catch(e) { errEl.textContent = "Error: " + e.message; errEl.style.display = "block"; }
};

window.deleteMgrEmployee = async function(id, empName) {
  if (!confirm(`Remove "${empName}" from the roster? This cannot be undone.`)) return;
  await deleteDoc(doc(db,"stores",store,"employees",id)).catch(e => alert("Error: " + e.message));
  mgrRosterData = mgrRosterData.filter(x => x.id !== id);
  renderMgrRoster();
};

window.coachEmployee = function(id) {
  const e = mgrRosterData.find(x => x.id === id);
  if (!e) return;
  location.href = "coaching.html?emp=" + encodeURIComponent(e.name||"")
                + "&num=" + encodeURIComponent(e.memberNum||"");
};

function flashRosterSaved(id) {
  const savedEl = el("rs-saved-" + id);
  if (!savedEl) return;
  savedEl.classList.add("show");
  setTimeout(() => savedEl.classList.remove("show"), 2000);
}


// ── APP CONFIG CHECK ──────────────────────────────────────────
async function checkAppConfig() {
  try {
    const snap = await getDoc(doc(db, "admin", "appConfig"));
    if (!snap.exists()) return;
    const data = snap.data();
    if (data.feedbackEnabled === false) {
      const btn = el("mgr-tab-feedback-btn");
      if (btn) btn.style.display = "none";
    }
    if (data.coachingEnabled === false) {
      const btn = el("mgr-tab-coaching-btn");
      if (btn) btn.style.display = "none";
    }
  } catch(e) { /* non-fatal */ }
}

checkAppConfig();
