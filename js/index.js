// ── COACH.HTML — Counter Coach Decision Tree ──────────────────
import { db, auth, functions, storage }    from "./firebase.js";
import { initNav }                         from "./nav.js";
import { el, fetchBrandingData, loadBroadcast, compressImage } from "./utils.js";
import { loadSession }                     from "./session.js";
import { doc, getDoc, getDocs, updateDoc, deleteField,
         collection, query, where }        from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { ref as storageRef, uploadBytes,
         getDownloadURL, deleteObject }    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import { signInAnonymously }               from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { httpsCallable }                   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

// ── HELPERS ───────────────────────────────────────────────────
function showBanner(msg) { const b = el("error-banner"); b.style.display = "block"; b.textContent = msg; }

// ── STATE ─────────────────────────────────────────────────────
let store = "", name = "", role = "employee", managerPhone = "", helpdeskPhone = "";
let historyStack = [];
let myEmpId          = null;
let myAvatarUrl      = null;
let avatarPendingFile = null;

// ── INIT ──────────────────────────────────────────────────────
signInAnonymously(auth)
  .then(() => { loadBroadcast(db); loadBranding(); if (store) fetchStoreData(store); })
  .catch(e => showBanner("Auth error: " + e.message));

// Restore session for header display (store/name from main app login)
const saved = loadSession();
if (saved && saved.store && saved.name) {
  store = saved.store; name = saved.name;
  role          = saved.role          || "employee";
  managerPhone  = saved.managerPhone  || "";
  helpdeskPhone = saved.helpdeskPhone || "";
  updateHeader();
  // Show cached avatar immediately, then confirm from Firestore
  const cached = localStorage.getItem("cc_avatar_url");
  if (cached) { myAvatarUrl = cached; applyAvatarToHeader(cached); }
  // Fetch employee doc for avatarUrl
  getDocs(query(collection(db, "stores", store, "employees"), where("name", "==", name)))
    .then(snap => {
      if (!snap.empty) {
        const empDoc = snap.docs[0];
        myEmpId = empDoc.id;
        if (empDoc.data().avatarUrl) {
          myAvatarUrl = empDoc.data().avatarUrl;
          applyAvatarToHeader(myAvatarUrl);
        }
      }
      const btn = document.getElementById("tb-avatar-btn");
      if (btn) btn.style.display = "flex";
    })
    .catch(() => {
      const btn = document.getElementById("tb-avatar-btn");
      if (btn) btn.style.display = "flex";
    });
}

// Fetch fresh store data (manager/helpdesk phone) for Call buttons
async function fetchStoreData(s) {
  try {
    const snap = await getDoc(doc(db, "stores", s));
    if (snap.exists()) {
      const d = snap.data();
      managerPhone  = d.managerPhone  || managerPhone;
      helpdeskPhone = d.helpdeskPhone || helpdeskPhone;
    }
  } catch (e) { /* non-fatal */ }
}

// ── NAVIGATION ────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  el(id).classList.add("active");
}
window.goHome = () => { historyStack = []; showScreen("screen-home"); };
window.nextQ  = (id) => { historyStack.push(id); renderQ(id); showScreen("screen-q"); };

function goBack() {
  historyStack.pop();
  if (!historyStack.length) { goHome(); return; }
  renderQ(historyStack[historyStack.length - 1]);
}
window.goBack = goBack;

function updateHeader() {
  const info = el("header-info");
  if (info) {
    info.innerHTML = store
      ? "Store " + store + (name ? "<br>" + name + (role === "manager" ? " &#x1F511;" : "") : "")
      : "";
  }
}

// ── QUESTION TREE ─────────────────────────────────────────────
const Q = {
  cust1:  { q:"Customer demanding manager or escalating beyond employee?",          yes:["cust2"],   no:[null,"Handled at employee level"] },
  cust2:  { q:"Did you fully follow return/warranty policy without deviation?",     yes:["cust3"],   no:[null,"Follow policy completely first"] },
  cust3:  { q:"Did you offer ALL available solutions (exchange, credit, part)?",    yes:["cust4"],   no:[null,"Offer all solutions before escalating"] },
  cust4:  { q:"Customer still refusing resolution and disrupting the store?",       yes:["CALL","Unresolvable customer escalation"], no:[null,"Resolved without escalation"] },
  staff1: { q:"Is there a call-off or staffing gap affecting coverage?",            yes:["staff2"],  no:[null,"Coverage sufficient"] },
  staff2: { q:"Did you contact all available employees for coverage?",              yes:["staff3"],  no:[null,"Attempt all coverage options first"] },
  staff3: { q:"Did you adjust roles (counter, driver, commercial) to maintain operations?", yes:["staff4"], no:[null,"Reallocate team roles first"] },
  staff4: { q:"Is the store unable to operate or losing significant business?",     yes:["CALL","Staffing prevents operations"],     no:[null,"Store still functional"] },
  driver1:{ q:"Driver unavailable or delivery disruption?",                         yes:["driver2"], no:[null,"No delivery issue"] },
  driver2:{ q:"Can counter or other staff cover delivery temporarily?",             yes:[null,"Reassign staff and continue"],        no:["driver3"] },
  driver3:{ q:"Is commercial business significantly impacted?",                     yes:["CALL","Delivery failure impacting business"], no:[null,"Delay manageable — monitor"] },
  cash1:  { q:"Register over/short detected?",                                      yes:["cash2"],   no:[null,"No variance — no action needed"] },
  cash2:  { q:"Recounted drawer, checked all bags, safe, and deposits?",           yes:["cash3"],   no:[null,"Verify all cash locations first"] },
  cash3:  { q:"Variance still over $20 after full verification?",                  yes:["CALL","Unresolved cash variance over $20"], no:[null,"Under threshold — log and monitor"] },
  ops1:   { q:"System, POS, or building issue affecting operations?",               yes:["ops2"],    no:[null,"Minor issue — no escalation needed"] },
  ops2:   { q:"Restarted system or attempted basic troubleshooting?",              yes:["ops3"],    no:[null,"Restart and troubleshoot first"] },
  ops3:   { q:"Contacted help desk and followed their guidance?",                  yes:["ops4"],    no:[null,"Contact help desk first"] },
  ops4:   { q:"Still unable to operate or actively losing sales?",                 yes:["CALL","Operational failure after all steps"], no:[null,"Issue resolved"] },
};

function renderQ(id) {
  const q = Q[id]; if (!q) return;
  // Use the Q-tree key (e.g. "cust4") as the function suffix — encodeURIComponent
  // produces % characters which are invalid in JS identifier names and silently
  // prevent the onclick from firing.
  const yH = q.yes[0] === "CALL"
    ? `callManager_${id}()`
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
  el("why").innerHTML    = "<b>WHY:</b> " + reason;
  el("ask").innerHTML    = "<b>MANAGER WILL ASK:</b><br>&bull; What did you already try?<br>&bull; What policy applies?<br>&bull; What solution do you recommend?";
  el("expect").innerHTML = "<b>EXPECTED:</b> You attempted all steps before calling.";
  const btn = el("actionBtn"); btn.innerHTML = "";
  if (managerPhone) btn.innerHTML = `<a href="tel:${managerPhone}" class="btn btn-green">&#x1F4DE; Call Manager Now</a>`;
};

// Register window.callManager_* for each CALL branch using the Q-tree key
// (e.g. window.callManager_cust4) so the onclick identifier is always valid JS.
Object.keys(Q).forEach(k => {
  const q = Q[k];
  if (q.yes[0] === "CALL") {
    window["callManager_" + k] = () => callManager(q.yes[1]);
  }
});

window.noCall = (reasonEncoded) => {
  const reason = decodeURIComponent(reasonEncoded);
  showScreen("screen-result");
  el("resultText").innerHTML = "&#x2705; DO NOT CALL";
  el("resultText").className = "result nocall";
  el("why").innerHTML    = "<b>WHY:</b> " + reason;
  el("ask").innerHTML    = "<b>MANAGER WILL ASK:</b> Why wasn't this handled in-store?";
  el("expect").innerHTML = "<b>EXPECTED:</b> Store-level ownership.";
  const btn = el("actionBtn"); btn.innerHTML = "";
  if (helpdeskPhone && reason.toLowerCase().includes("help desk")) {
    btn.innerHTML = `<a href="tel:${helpdeskPhone}" class="btn btn-green">&#x1F4DE; Call Help Desk</a>`;
  }
};

window.emergency = () => {
  showScreen("screen-result");
  el("resultText").innerHTML = "&#x1F6A8; CALL 911 THEN MANAGER";
  el("resultText").className = "result call";
  el("why").innerHTML    = "<b>WHY:</b> Safety risk present.";
  el("ask").innerHTML    = "<b>MANAGER WILL ASK:</b> What immediate danger exists? Who is affected?";
  el("expect").innerHTML = "<b>EXPECTED:</b> You secured safety and called 911 first.";
  const btn = el("actionBtn");
  btn.innerHTML = `<a href="tel:911" class="btn btn-emergency">&#x1F6A8; Call 911</a>`;
  if (managerPhone) btn.innerHTML += `<a href="tel:${managerPhone}" class="btn btn-green">&#x1F4DE; Then Call Manager</a>`;
};

// ── AVATAR ────────────────────────────────────────────────────
function applyAvatarToHeader(url) {
  if (url) localStorage.setItem("cc_avatar_url", url);
  else     localStorage.removeItem("cc_avatar_url");
  const img = document.getElementById("tb-avatar-img");
  const ph  = document.getElementById("tb-avatar-placeholder");
  if (url) {
    if (img) { img.src = url; img.style.display = "block"; }
    if (ph)  { ph.style.display = "none"; }
  } else {
    if (img) { img.src = ""; img.style.display = "none"; }
    if (ph)  { ph.style.display = "block"; }
  }
}

window.openAvatarModal = function() {
  const modal = document.getElementById("avatar-modal");
  if (!modal) return;
  modal.style.display = "flex";
  const cur = document.getElementById("avatar-current-img");
  const ph  = document.getElementById("avatar-placeholder-circle");
  if (myAvatarUrl) { cur.src = myAvatarUrl; cur.style.display = "block"; ph.style.display = "none"; }
  else             { cur.style.display = "none"; ph.style.display = "flex"; }
  document.getElementById("avatar-status").textContent = "";
  document.getElementById("avatar-generate-btn").style.display = "none";
  document.getElementById("avatar-use-btn").style.display = "none";
  document.getElementById("avatar-remove-btn").style.display = myAvatarUrl ? "block" : "none";
  avatarPendingFile = null;
  const lbl = document.querySelector('label[for="avatar-file-input"]');
  if (lbl) lbl.textContent = myAvatarUrl ? "📷 Change Photo" : "📷 Choose / Take Photo";
};

window.closeAvatarModal = function() {
  const modal = document.getElementById("avatar-modal");
  if (modal) modal.style.display = "none";
  avatarPendingFile = null;
};

window.handleAvatarFileChosen = function(input) {
  const file = input.files?.[0];
  if (!file) return;
  avatarPendingFile = file;
  const cur = document.getElementById("avatar-current-img");
  cur.src = URL.createObjectURL(file); cur.style.display = "block";
  document.getElementById("avatar-placeholder-circle").style.display = "none";
  document.getElementById("avatar-status").textContent = "Photo selected — use as-is or generate a caricature!";
  document.getElementById("avatar-use-btn").style.display = "block";
  document.getElementById("avatar-generate-btn").style.display = "block";
  document.getElementById("avatar-remove-btn").style.display = "none";
};

window.generateMyAvatar = async function() {
  if (!avatarPendingFile) { alert("Please choose a photo first."); return; }
  if (!myEmpId) { alert("Employee record not found. Try logging in from the Daily Recap first."); return; }
  const btn = document.getElementById("avatar-generate-btn");
  btn.disabled = true; btn.textContent = "Generating…";
  document.getElementById("avatar-status").textContent = "Compressing photo…";
  try {
    const compressed = await compressImage(avatarPendingFile, 512, 0.85);
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(compressed);
    });
    document.getElementById("avatar-status").textContent = "Generating your caricature… (15–30s)";
    const fn = httpsCallable(functions, "generateAvatarCaricature");
    const result = await fn({ photoBase64: base64, mimeType: "image/jpeg", storeId: store, empId: myEmpId, role });
    myAvatarUrl = result.data.avatarUrl;
    applyAvatarToHeader(myAvatarUrl);
    const cur = document.getElementById("avatar-current-img");
    cur.src = myAvatarUrl; cur.style.display = "block";
    document.getElementById("avatar-placeholder-circle").style.display = "none";
    document.getElementById("avatar-status").textContent = "Caricature generated!";
    document.getElementById("avatar-use-btn").style.display = "none";
    document.getElementById("avatar-remove-btn").style.display = "block";
    btn.textContent = "✨ Regenerate";
  } catch(e) {
    document.getElementById("avatar-status").textContent = "Error: " + (e.message || "Unknown error");
    btn.textContent = "✨ Try Again";
  } finally {
    btn.disabled = false;
    avatarPendingFile = null;
    const inp = document.getElementById("avatar-file-input");
    if (inp) inp.value = "";
  }
};

window.usePhotoAsIs = async function() {
  if (!avatarPendingFile) { alert("Please choose a photo first."); return; }
  if (!myEmpId) { alert("Employee record not found. Try logging in from the Daily Recap first."); return; }
  const btn = document.getElementById("avatar-use-btn");
  btn.disabled = true; btn.textContent = "Saving…";
  document.getElementById("avatar-status").textContent = "Compressing photo…";
  try {
    const compressed = await compressImage(avatarPendingFile, 512, 0.85);
    document.getElementById("avatar-status").textContent = "Uploading photo…";
    const sRef = storageRef(storage, `avatars/${store}/${myEmpId}.jpg`);
    await uploadBytes(sRef, compressed, { contentType: "image/jpeg" });
    const url = await getDownloadURL(sRef);
    await updateDoc(doc(db, "stores", store, "employees", myEmpId), { avatarUrl: url });
    myAvatarUrl = url;
    applyAvatarToHeader(myAvatarUrl);
    const cur = document.getElementById("avatar-current-img");
    cur.src = myAvatarUrl; cur.style.display = "block";
    document.getElementById("avatar-placeholder-circle").style.display = "none";
    document.getElementById("avatar-status").textContent = "Photo saved!";
    document.getElementById("avatar-generate-btn").style.display = "none";
    document.getElementById("avatar-remove-btn").style.display = "block";
    btn.textContent = "✅ Saved";
  } catch(e) {
    document.getElementById("avatar-status").textContent = "Error: " + (e.message || "Unknown error");
    btn.textContent = "📷 Use Photo As-Is";
  } finally {
    btn.disabled = false;
    avatarPendingFile = null;
    const inp = document.getElementById("avatar-file-input");
    if (inp) inp.value = "";
  }
};

window.removeMyAvatar = async function() {
  if (!confirm("Remove your avatar? This can't be undone.")) return;
  const btn = document.getElementById("avatar-remove-btn");
  btn.disabled = true; btn.textContent = "Removing…";
  document.getElementById("avatar-status").textContent = "Removing avatar…";
  try {
    if (myEmpId) {
      await updateDoc(doc(db, "stores", store, "employees", myEmpId), { avatarUrl: deleteField() });
      try { await deleteObject(storageRef(storage, `avatars/${store}/${myEmpId}.jpg`)); } catch(_) {}
    }
    myAvatarUrl = null;
    applyAvatarToHeader(null);
    const cur = document.getElementById("avatar-current-img");
    cur.src = ""; cur.style.display = "none";
    document.getElementById("avatar-placeholder-circle").style.display = "flex";
    document.getElementById("avatar-generate-btn").style.display = "none";
    document.getElementById("avatar-use-btn").style.display = "none";
    document.getElementById("avatar-status").textContent = "Avatar removed.";
    const lbl = document.querySelector('label[for="avatar-file-input"]');
    if (lbl) lbl.textContent = "📷 Choose / Take Photo";
    btn.style.display = "none";
  } catch(e) {
    document.getElementById("avatar-status").textContent = "Error: " + (e.message || "Unknown error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🗑️ Remove Avatar";
  }
};

// ── NAV ───────────────────────────────────────────────────────
initNav("coach");   // injects nav HTML + CSS + role-based visibility

// ── BRANDING ──────────────────────────────────────────────────
async function loadBranding() {
  try {
    const data = await fetchBrandingData(db);
    if (!data) return;
    if (data.appName) {
      document.title = data.appName;
      el("header-brand-text").innerHTML = `<img src="icon-192.png" alt="" style="height:20px;width:20px;border-radius:3px;vertical-align:middle;margin-right:6px;object-fit:cover;"> ${data.appName}`;
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
  } catch (e) { /* non-fatal */ }
}
