// ── REGISTER.JS — Store Registration / First-Time Setup ──────
import { db, auth }                   from "./firebase.js";
import { saveSession, saveMgrSession } from "./session.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, addDoc, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

signInAnonymously(auth).catch(e => showErr("Auth error: " + e.message));

// ── HELPERS ───────────────────────────────────────────────────
const el  = id => document.getElementById(id);
const val = id => (el(id)?.value || "").trim();

function showErr(msg) {
  const e = el("reg-err");
  e.textContent = msg;
  e.classList.add("show");
  el("reg-ok").classList.remove("show");
}
function showOk(msg) {
  const o = el("reg-ok");
  o.textContent = msg;
  o.classList.add("show");
  el("reg-err").classList.remove("show");
}
function clearMsg() {
  el("reg-err").classList.remove("show");
  el("reg-ok").classList.remove("show");
}

// ── STATE ─────────────────────────────────────────────────────
let storeStatus     = null;   // null | "new" | "exists"
let storeCheckTimer = null;
let fieldsLocked    = false;

// ── STORE CHECK (debounced) ────────────────────────────────────
window.onStoreInput = function () {
  const s = val("reg-store");
  clearMsg();
  el("status-badge").innerHTML = "";
  el("desc-text").style.display = "none";
  storeStatus = null;
  clearTimeout(storeCheckTimer);
  if (s.length >= 2) storeCheckTimer = setTimeout(() => checkStore(s), 600);
};

async function checkStore(s) {
  el("status-badge").innerHTML = '<span class="badge badge-check">⏳ Checking…</span>';
  try {
    const snap = await getDoc(doc(db, "stores", s));
    if (snap.exists()) {
      storeStatus = "exists";
      const d = snap.data();
      el("status-badge").innerHTML = '<span class="badge badge-exists">✓ Store already registered</span>';
      el("desc-text").textContent  = `Store ${s} is registered. Enter your PIN to verify, or enter PIN then click Unlock to edit info.`;
      el("desc-text").style.display = "block";
      // Pre-fill store fields
      el("reg-name").value        = d.managerName  || "";
      el("reg-phone").value       = d.managerPhone  || "";
      el("reg-helpdesk").value    = d.helpdeskPhone || "";
      el("reg-dm-email").value    = d.dmEmail       || "";
      el("reg-recap-email").value = d.recapEmail    || "";
      // Pre-fill manager counter # from their employee record
      try {
        const mgrEmp = await getDocs(
          query(collection(db, "stores", s, "employees"), where("isManager", "==", true))
        );
        if (!mgrEmp.empty) el("reg-counter").value = mgrEmp.docs[0].data().memberNum || "";
      } catch (_) {}
      // Lock all fields, hide reg code
      lockFields();
      el("reg-code-wrap").classList.remove("show");
    } else {
      storeStatus = "new";
      el("status-badge").innerHTML = '<span class="badge badge-new">🆕 New store</span>';
      el("desc-text").textContent  = `Store ${s} is not registered yet. Fill in your info and provide the registration code to create it.`;
      el("desc-text").style.display = "block";
      unlockAllFields();
      el("reg-code-wrap").classList.add("show");
      setTimeout(() => el("reg-code").focus(), 50);
    }
  } catch (e) {
    el("status-badge").innerHTML = '<span class="badge badge-check">⚠ Could not check — check connection</span>';
    console.error("checkStore:", e);
  }
}

// ── LOCK / UNLOCK ─────────────────────────────────────────────
const LOCKABLE = ["reg-name", "reg-counter", "reg-phone", "reg-helpdesk", "reg-dm-email", "reg-recap-email"];

function lockFields() {
  LOCKABLE.forEach(id => {
    el(id).readOnly = true;
    el(id).classList.add("locked");
  });
  el("lock-notice").classList.add("show");
  fieldsLocked = true;
}

function unlockAllFields() {
  LOCKABLE.forEach(id => {
    el(id).readOnly = false;
    el(id).classList.remove("locked");
  });
  el("lock-notice").classList.remove("show");
  fieldsLocked = false;
}

window.unlockFields = async function () {
  const s   = val("reg-store");
  const pin = val("reg-pin");
  if (!s)   { showErr("Enter your store number first."); return; }
  if (!pin) { showErr("Enter your current PIN, then click Unlock."); return; }
  try {
    const snap = await getDoc(doc(db, "stores", s));
    if (!snap.exists() || snap.data().pin !== pin) {
      showErr("Incorrect PIN — cannot unlock.");
      return;
    }
    clearMsg();
    unlockAllFields();
    el("reg-name").focus();
  } catch (e) { showErr("Error: " + e.message); }
};

// ── SAVE / UPDATE MANAGER EMPLOYEE RECORD ─────────────────────
async function syncManagerEmployeeRecord(s, n, counterNum) {
  if (!counterNum) return; // skip if no counter # provided
  const empRef = collection(db, "stores", s, "employees");
  try {
    // Find existing manager record (flagged with isManager:true)
    const mgrSnap = await getDocs(query(empRef, where("isManager", "==", true)));
    if (mgrSnap.empty) {
      // No manager record yet — create one
      await addDoc(empRef, {
        store: s, name: n, memberNum: counterNum,
        role: "Store Manager", isManager: true,
        addedBy: "registration", addedAt: serverTimestamp()
      });
    } else {
      // Update existing manager record
      await updateDoc(mgrSnap.docs[0].ref, {
        name: n, memberNum: counterNum, role: "Store Manager"
      });
    }
  } catch (e) { console.warn("syncManagerEmployeeRecord:", e); }
}

// ── SUBMIT ────────────────────────────────────────────────────
window.submitSetup = async function () {
  const s       = val("reg-store");
  const n       = val("reg-name");
  const counter = val("reg-counter");
  const ph      = val("reg-phone");
  const hd      = val("reg-helpdesk");
  const pin     = val("reg-pin");
  const reg     = val("reg-code");
  const dm      = val("reg-dm-email");
  const rc      = val("reg-recap-email");

  clearMsg();

  if (!s)             { showErr("Store number is required."); return; }
  if (!n)             { showErr("Manager name is required."); return; }
  if (!counter)       { showErr("Counter / badge number is required."); return; }
  if (!pin)           { showErr("PIN is required."); return; }
  if (pin.length < 4) { showErr("PIN must be at least 4 characters."); return; }
  if (storeStatus === null) { showErr("Please wait for the store check to complete."); return; }

  const storeRef = doc(db, "stores", s);

  try {
    if (storeStatus === "exists") {
      // Verify PIN before updating
      const snap = await getDoc(storeRef);
      if (!snap.exists())          { showErr("Store not found — refresh and try again."); return; }
      if (snap.data().pin !== pin) { showErr("Incorrect PIN."); return; }
      await setDoc(storeRef, { managerName: n, managerPhone: ph, helpdeskPhone: hd, dmEmail: dm, recapEmail: rc }, { merge: true });

    } else {
      // New store — validate registration code
      if (!reg) { showErr("A registration code is required to create a new store."); return; }
      const codeKey  = reg.toUpperCase();
      const codeRef  = doc(db, "reg_codes", codeKey);
      const codeSnap = await getDoc(codeRef);
      if (!codeSnap.exists())                                                   { showErr("Invalid registration code."); return; }
      const cd = codeSnap.data();
      if (cd.used)                                                              { showErr("This code has already been used."); return; }
      if (cd.expires && cd.expires.toDate && cd.expires.toDate() < new Date()) { showErr("This code has expired."); return; }
      if (cd.storeNumber && cd.storeNumber !== s)                               { showErr(`This code is for store ${cd.storeNumber}, not ${s}.`); return; }
      // Mark code used + create store doc
      await updateDoc(codeRef, { used: true, usedAt: serverTimestamp(), usedByStore: s });
      await setDoc(storeRef, {
        pin, managerName: n, managerPhone: ph, helpdeskPhone: hd,
        dmEmail: dm, recapEmail: rc, created: serverTimestamp()
      });
    }

    // Create / update manager's employee record in the roster
    await syncManagerEmployeeRecord(s, n, counter);

    // Save session (manager) and redirect to main app
    saveSession({ store: s, name: n, role: "manager", managerPhone: ph, helpdeskPhone: hd });
    saveMgrSession({ store: s, on: true });
    showOk("✓ Setup complete! Redirecting…");
    setTimeout(() => { window.location.href = "/"; }, 1200);

  } catch (e) { showErr("Error: " + e.message); }
};
