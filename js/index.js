// ── INDEX.HTML — Counter Coach Decision Tree ──────────────────
import { db, auth }                  from "./firebase.js";
import { el, v, fetchBrandingData, loadBroadcast } from "./utils.js";
import { saveSession, loadSession }  from "./session.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, serverTimestamp,
         collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { signInAnonymously }         from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// ── HELPERS (page-specific) ───────────────────────────────────
function val(id) { return document.getElementById(id).value.trim(); }
function showErr(id, msg) { const e = el(id); e.textContent = msg; e.classList.add("show"); }
function showBanner(msg) { const b = el("error-banner"); b.style.display = "block"; b.textContent = msg; }

// ── STATE ─────────────────────────────────────────────────────
let store = "", name = "", role = "employee", managerPhone = "", helpdeskPhone = "";
let historyStack = [];
let pendingAction = null;
let storeExists = null; // null=unknown, true=exists, false=new

// ── INIT ──────────────────────────────────────────────────────
signInAnonymously(auth)
  .then(() => { loadBroadcast(db); loadBranding(); })
  .catch(e => showBanner("Auth error: " + e.message));

const params  = new URLSearchParams(location.search);
const qrStore = params.get("store");
const qrName  = params.get("name");

const saved = loadSession();
if (saved && saved.store && saved.name) {
  store = saved.store; name = saved.name;
  role = saved.role || "employee";
  managerPhone = saved.managerPhone || "";
  helpdeskPhone = saved.helpdeskPhone || "";
  updateHeader();
}
if (qrStore) {
  el("nb-store").value = qrStore;
  if (qrName) el("nb-name").value = qrName;
  if (qrStore && qrName && !(saved && saved.store)) autoLoginFromQR(qrStore, qrName);
  else if (qrStore && !qrName && !(saved && saved.store)) {
    el("nb-store").value = qrStore;
    showNameBanner("Enter your name to get started");
  }
}

async function autoLoginFromQR(s, n) {
  try {
    const snap = await getDoc(doc(db, "stores", s));
    if (snap.exists()) {
      const d = snap.data();
      store = s; name = n; role = "employee";
      managerPhone = d.managerPhone || "";
      helpdeskPhone = d.helpdeskPhone || "";
      saveSession({ store, name, role, managerPhone, helpdeskPhone });
      updateHeader();
    }
  } catch(e) { console.error("QR login:", e); }
}

// ── NAVIGATION ────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  el(id).classList.add("active");
  el("name-banner").classList.remove("show");
}
window.goHome = () => { historyStack = []; showScreen("screen-home"); };
window.showManagerSetup = () => {
  storeExists = null;
  el("store-status-badge").innerHTML = "";
  el("reg-code-wrap").classList.remove("show");
  el("mgr-lock-notice").classList.remove("show");
  el("setup-desc").textContent = "Enter your store number to check if it exists.";
  ["mgr-name", "mgr-phone", "mgr-helpdesk"].forEach(id => {
    el(id).readOnly = false;
    el(id).classList.remove("mgr-locked");
    el(id).value = "";
  });
  el("mgr-pin").value = "";
  if (store) { el("mgr-store").value = store; onStoreInput(); }
  showScreen("screen-mgr-setup");
};
window.nextQ = (id) => { historyStack.push(id); renderQ(id); showScreen("screen-q"); };
function goBack() {
  historyStack.pop();
  if (!historyStack.length) { goHome(); return; }
  renderQ(historyStack[historyStack.length - 1]);
}
window.goBack = goBack;
function updateHeader() {
  el("header-info").innerHTML = store
    ? "Store " + store + (name ? "<br>" + name + (role === "manager" ? " &#x1F511;" : "") : "")
    : "";
}

// ── STORE LOOKUP (debounced) ───────────────────────────────────
let storeCheckTimer = null;
window.onStoreInput = () => {
  const s = val("mgr-store");
  el("store-status-badge").innerHTML = "";
  el("reg-code-wrap").classList.remove("show");
  storeExists = null;
  clearTimeout(storeCheckTimer);
  if (s.length < 2) return;
  el("store-status-badge").innerHTML = '<span style="font-size:12px;color:#888;">Checking…</span>';
  storeCheckTimer = setTimeout(() => checkStoreExists(s), 600);
};
async function checkStoreExists(s) {
  try {
    const snap = await getDoc(doc(db, "stores", s));
    storeExists = snap.exists();
    if (storeExists) {
      el("store-status-badge").innerHTML = '<span class="store-status exists">&#x2714; Store found — enter your PIN below</span>';
      el("setup-desc").textContent = "Store already registered. Enter your PIN to log in, or unlock to edit manager info.";
      el("reg-code-wrap").classList.remove("show");
      const d = snap.data();
      el("mgr-name").value     = d.managerName   || "";
      el("mgr-phone").value    = d.managerPhone   || "";
      el("mgr-helpdesk").value = d.helpdeskPhone  || "";
      ["mgr-name", "mgr-phone", "mgr-helpdesk"].forEach(id => {
        el(id).readOnly = true;
        el(id).classList.add("mgr-locked");
      });
      el("mgr-lock-notice").classList.add("show");
    } else {
      el("store-status-badge").innerHTML = '<span class="store-status new">&#x2795; New store — registration code required</span>';
      el("setup-desc").textContent = "New store. Enter the registration code from SM 2278 Justin to create it.";
      el("reg-code-wrap").classList.add("show");
      setTimeout(() => el("mgr-regcode").focus(), 50);
    }
  } catch(e) {
    el("store-status-badge").innerHTML = '<span style="font-size:12px;color:#c62828;">Could not check store — check connection</span>';
  }
}

// ── NAME BANNER — ROSTER LOADER ───────────────────────────────
let _nbTimer = null;
window.onNbStoreInput = () => {
  const s = val("nb-store");
  const sel = el("nb-name");
  sel.innerHTML = '<option value="">— Loading\u2026 —</option>';
  sel.disabled = true;
  clearTimeout(_nbTimer);
  if (s.length < 2) {
    sel.innerHTML = '<option value="">— Enter store # first —</option>';
    return;
  }
  _nbTimer = setTimeout(() => loadNbRoster(s), 600);
};

async function loadNbRoster(s) {
  const sel = el("nb-name");
  try {
    const snap = await getDocs(query(collection(db,"employees"), where("store","==",s)));
    const available = snap.docs.filter(d => !d.data().loggedIn).map(d => d.data().name).sort((a,b) => a.localeCompare(b));
    if (snap.empty) {
      sel.innerHTML = '<option value="">— No roster found — ask your manager to add you —</option>';
    } else if (!available.length) {
      sel.innerHTML = '<option value="">— All employees are currently logged in —</option>';
    } else {
      sel.innerHTML = '<option value="">— Select your name —</option>' +
        available.map(n => `<option value="${n.replace(/"/g,'&quot;')}">${n}</option>`).join("");
    }
    sel.disabled = false;
  } catch(_) {
    sel.innerHTML = '<option value="">— Error loading names —</option>';
    sel.disabled = false;
  }
}

// ── NAME BANNER ───────────────────────────────────────────────
function showNameBanner(title) {
  el("nb-title").textContent = title || "Enter your name to continue";
  el("nb-err").classList.remove("show");
  el("name-banner").classList.add("show");
  el("nb-store").style.display = store ? "none" : "";
  if (store) {
    el("nb-store").value = store;
    loadNbRoster(store);
  }
}
window.submitNameBanner = async () => {
  const s = val("nb-store") || store;
  const n = el("nb-name").value;
  if (!s || !n) { el("nb-err").classList.add("show"); return; }
  try {
    const snap = await getDoc(doc(db, "stores", s));
    if (snap.exists()) {
      const d = snap.data();
      managerPhone  = d.managerPhone  || "";
      helpdeskPhone = d.helpdeskPhone || "";
    }
  } catch(e) { console.error("store fetch:", e); }
  store = s; name = n; role = "employee";
  saveSession({ store, name, role, managerPhone, helpdeskPhone });
  updateHeader();
  el("name-banner").classList.remove("show");
  if (pendingAction) { const a = pendingAction; pendingAction = null; a(); }
};

// ── GUARDED ACTIONS ───────────────────────────────────────────
window.guardedAction = (action) => {
  if (!name) { pendingAction = () => window[action](); showNameBanner("Who's calling? Enter your info first"); return; }
  window[action]();
};
window.guardedRecap = (e) => {
  if (!name || !store) {
    e.preventDefault();
    pendingAction = () => { el("recap-link").href = "recap.html"; window.location.href = "recap.html"; };
    showNameBanner("Enter your info to open Daily Recap");
    return false;
  }
  return true;
};

// ── MANAGER LOGIN ─────────────────────────────────────────────
window.unlockMgrFields = async () => {
  const s   = val("mgr-store");
  const pin = val("mgr-pin");
  if (!pin) { showErr("mgr-err", "Enter your PIN first, then click Unlock."); return; }
  try {
    const snap = await getDoc(doc(db, "stores", s));
    if (!snap.exists() || snap.data().pin !== pin) {
      showErr("mgr-err", "Incorrect PIN — cannot unlock.");
      return;
    }
    ["mgr-name", "mgr-phone", "mgr-helpdesk"].forEach(id => {
      el(id).readOnly = false;
      el(id).classList.remove("mgr-locked");
    });
    el("mgr-lock-notice").classList.remove("show");
    el("mgr-err").classList.remove("show");
    el("mgr-name").focus();
  } catch(e) { showErr("mgr-err", "Error: " + e.message); }
};

window.mgrLogin = async () => {
  const s   = val("mgr-store");
  const n   = val("mgr-name");
  const ph  = val("mgr-phone");
  const hd  = val("mgr-helpdesk");
  const pin = val("mgr-pin");
  const reg = val("mgr-regcode");

  el("mgr-err").classList.remove("show");

  if (!s || !n || !pin) { showErr("mgr-err", "Store number, name and PIN are required."); return; }
  if (pin.length < 4)   { showErr("mgr-err", "PIN must be at least 4 characters."); return; }

  try {
    const storeRef  = doc(db, "stores", s);
    const storeSnap = await getDoc(storeRef);

    if (storeSnap.exists()) {
      if (storeSnap.data().pin !== pin) { showErr("mgr-err", "Incorrect PIN."); return; }
      await setDoc(storeRef, { managerPhone: ph, helpdeskPhone: hd, managerName: n }, { merge: true });
    } else {
      if (!reg) { showErr("mgr-err", "A registration code is required to create a new store."); return; }
      const codeKey  = reg.trim().toUpperCase();
      const codeRef  = doc(db, "reg_codes", codeKey);
      const codeSnap = await getDoc(codeRef);
      if (!codeSnap.exists())                                                           { showErr("mgr-err", "Invalid registration code."); return; }
      const cd = codeSnap.data();
      if (cd.used)                                                                      { showErr("mgr-err", "This registration code has already been used."); return; }
      if (cd.expires && cd.expires.toDate && cd.expires.toDate() < new Date())          { showErr("mgr-err", "This registration code has expired."); return; }
      if (cd.storeNumber && cd.storeNumber !== s)                                       { showErr("mgr-err", `This code is for store ${cd.storeNumber}, not store ${s}.`); return; }
      await updateDoc(codeRef, { used: true, usedAt: serverTimestamp(), usedByStore: s });
      await setDoc(storeRef, { pin, managerName: n, managerPhone: ph, helpdeskPhone: hd, created: serverTimestamp() });
    }

    store = s; name = n; role = "manager";
    managerPhone = ph; helpdeskPhone = hd;
    saveSession({ store, name, role, managerPhone, helpdeskPhone });
    updateHeader(); goHome();
  } catch(e) { showErr("mgr-err", "Error: " + e.message); }
};

// ── QUESTION TREE ─────────────────────────────────────────────
const Q = {
  cust1:  { q:"Customer demanding manager or escalating beyond employee?", yes:["cust2"],   no:[null,"Handled at employee level"] },
  cust2:  { q:"Did you fully follow return/warranty policy without deviation?", yes:["cust3"], no:[null,"Follow policy completely first"] },
  cust3:  { q:"Did you offer ALL available solutions (exchange, credit, part)?", yes:["cust4"], no:[null,"Offer all solutions before escalating"] },
  cust4:  { q:"Customer still refusing resolution and disrupting the store?", yes:["CALL","Unresolvable customer escalation"], no:[null,"Resolved without escalation"] },
  staff1: { q:"Is there a call-off or staffing gap affecting coverage?", yes:["staff2"], no:[null,"Coverage sufficient"] },
  staff2: { q:"Did you contact all available employees for coverage?", yes:["staff3"], no:[null,"Attempt all coverage options first"] },
  staff3: { q:"Did you adjust roles (counter, driver, commercial) to maintain operations?", yes:["staff4"], no:[null,"Reallocate team roles first"] },
  staff4: { q:"Is the store unable to operate or losing significant business?", yes:["CALL","Staffing prevents operations"], no:[null,"Store still functional"] },
  driver1:{ q:"Driver unavailable or delivery disruption?", yes:["driver2"], no:[null,"No delivery issue"] },
  driver2:{ q:"Can counter or other staff cover delivery temporarily?", yes:[null,"Reassign staff and continue"], no:["driver3"] },
  driver3:{ q:"Is commercial business significantly impacted?", yes:["CALL","Delivery failure impacting business"], no:[null,"Delay manageable — monitor"] },
  cash1:  { q:"Register over/short detected?", yes:["cash2"], no:[null,"No variance — no action needed"] },
  cash2:  { q:"Recounted drawer, checked all bags, safe, and deposits?", yes:["cash3"], no:[null,"Verify all cash locations first"] },
  cash3:  { q:"Variance still over $20 after full verification?", yes:["CALL","Unresolved cash variance over $20"], no:[null,"Under threshold — log and monitor"] },
  ops1:   { q:"System, POS, or building issue affecting operations?", yes:["ops2"], no:[null,"Minor issue — no escalation needed"] },
  ops2:   { q:"Restarted system or attempted basic troubleshooting?", yes:["ops3"], no:[null,"Restart and troubleshoot first"] },
  ops3:   { q:"Contacted help desk and followed their guidance?", yes:["ops4"], no:[null,"Contact help desk first"] },
  ops4:   { q:"Still unable to operate or actively losing sales?", yes:["CALL","Operational failure after all steps"], no:[null,"Issue resolved"] },
};

function renderQ(id) {
  const q = Q[id]; if (!q) return;
  const yH = q.yes[0] === "CALL"
    ? `guardedAction('callManager_${encodeURIComponent(q.yes[1])}')`
    : q.yes[0] ? `nextQ('${q.yes[0]}')` : `noCall('${encodeURIComponent(q.yes[1])}')`;
  const nH = q.no[0] ? `nextQ('${q.no[0]}')` : `noCall('${encodeURIComponent(q.no[1])}')`;
  el("q-inner").innerHTML = `
    <p>${q.q}</p>
    <button class="btn btn-green" onclick="${yH}">YES</button>
    <button class="btn btn-red"   onclick="${nH}">NO</button>
    <button class="btn btn-gray"  onclick="goBack()">&#x2190; Back</button>
  `;
}

// ── RESULTS ───────────────────────────────────────────────────
window.callManager = (reason) => {
  showScreen("screen-result");
  el("resultText").innerHTML = "&#x1F4DE; CALL MANAGER";
  el("resultText").className = "result call";
  el("why").innerHTML  = "<b>WHY:</b> " + reason;
  el("ask").innerHTML  = "<b>MANAGER WILL ASK:</b><br>&bull; What did you already try?<br>&bull; What policy applies?<br>&bull; What solution do you recommend?";
  el("expect").innerHTML = "<b>EXPECTED:</b> You attempted all steps before calling.";
  const btn = el("actionBtn"); btn.innerHTML = "";
  if (managerPhone) btn.innerHTML = `<a href="tel:${managerPhone}" class="btn btn-green">&#x1F4DE; Call Manager Now</a>`;
};
Object.keys(Q).forEach(k => {
  const q = Q[k];
  if (q.yes[0] === "CALL") {
    const key = "callManager_" + encodeURIComponent(q.yes[1]);
    window[key] = () => {
      if (!name) { pendingAction = () => window[key](); showNameBanner("Who's calling? Enter your info first"); return; }
      callManager(q.yes[1]);
    };
  }
});
window.noCall = (reasonEncoded) => {
  const reason = decodeURIComponent(reasonEncoded);
  showScreen("screen-result");
  el("resultText").innerHTML = "&#x2705; DO NOT CALL";
  el("resultText").className = "result nocall";
  el("why").innerHTML  = "<b>WHY:</b> " + reason;
  el("ask").innerHTML  = "<b>MANAGER WILL ASK:</b> Why wasn't this handled in-store?";
  el("expect").innerHTML = "<b>EXPECTED:</b> Store-level ownership.";
  const btn = el("actionBtn");
  btn.innerHTML = "";
  if (helpdeskPhone && reason.toLowerCase().includes("help desk")) {
    btn.innerHTML = `<a href="tel:${helpdeskPhone}" class="btn btn-green">&#x1F4DE; Call Help Desk</a>`;
  }
};
window.emergency = () => {
  showScreen("screen-result");
  el("resultText").innerHTML = "&#x1F6A8; CALL 911 THEN MANAGER";
  el("resultText").className = "result call";
  el("why").innerHTML  = "<b>WHY:</b> Safety risk present.";
  el("ask").innerHTML  = "<b>MANAGER WILL ASK:</b> What immediate danger exists? Who is affected?";
  el("expect").innerHTML = "<b>EXPECTED:</b> You secured safety and called 911 first.";
  const btn = el("actionBtn");
  btn.innerHTML = `<a href="tel:911" class="btn btn-emergency">&#x1F6A8; Call 911</a>`;
  if (managerPhone) btn.innerHTML += `<a href="tel:${managerPhone}" class="btn btn-green">&#x1F4DE; Then Call Manager</a>`;
};

// ── BRANDING ──────────────────────────────────────────────────
async function loadBranding() {
  try {
    const data = await fetchBrandingData(db);
    if (!data) return;
    if (data.appName) {
      document.title = data.appName;
      el("header-brand-text").textContent = "🏪 " + data.appName;
    }
    if (data.logoUrl) {
      el("header-logo-img").src = data.logoUrl;
      el("header-logo-img").style.display = "inline-block";
      el("header-brand-text").style.display = "none";
    }
    if (data.brandColor) {
      el("main-header").style.background = data.brandColor;
      document.querySelector('meta[name="theme-color"]').content = data.brandColor;
    }
  } catch(e) { /* non-fatal */ }
}
