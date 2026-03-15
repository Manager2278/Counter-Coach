// ── SHARED AVATAR MODAL ────────────────────────────────────────────────────
// Used by coaching.html and rules.html. Coach (/coach) and Recap (/) have
// their own inline implementations; this module handles the other pages.
//
// Usage:
//   import { initAvatarModal } from "./avatar.js";
//   initAvatarModal("#coaching-avatar");   // pass selector of the topbar avatar div
// ─────────────────────────────────────────────────────────────────────────────

import { db, auth, storage }                       from "./firebase.js";
import { ref as storageRef, uploadBytes,
         getDownloadURL, deleteObject }            from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import { doc, updateDoc, deleteField,
         collection, query, where, getDocs }       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { compressImage }                           from "./utils.js";

// ── MODULE STATE ─────────────────────────────────────────────────────────────
let avatarPendingFile = null;
let avatarImgEl       = null;   // topbar <img>  inside the avatar container
let avatarPhEl        = null;   // topbar <span> inside the avatar container

// ── HELPERS ──────────────────────────────────────────────────────────────────
function getSession() {
  try { return JSON.parse(localStorage.getItem("cc_v2_session") || "null"); } catch { return null; }
}

/** Query Firestore for the logged-in employee's doc ID. */
async function getEmpId(storeId, name) {
  const snap = await getDocs(
    query(collection(db, "stores", storeId, "employees"), where("name", "==", name))
  );
  return snap.empty ? null : snap.docs[0].id;
}

/** Sync the topbar avatar circle and localStorage cache. */
function applyAvatarToBtn(url) {
  if (url) localStorage.setItem("cc_avatar_url", url);
  else     localStorage.removeItem("cc_avatar_url");
  if (!avatarImgEl || !avatarPhEl) return;
  if (url) {
    avatarImgEl.src = url; avatarImgEl.style.display = "block";
    avatarPhEl.style.display = "none";
  } else {
    avatarImgEl.src = ""; avatarImgEl.style.display = "none";
    avatarPhEl.style.display = "block";
  }
}

// ── MODAL ACTIONS (exposed via window with _av_ prefix to avoid collisions) ──

function openAvatarModal() {
  const modal = document.getElementById("_avatar-modal");
  if (!modal) return;
  // Sync current avatar from localStorage (coaching.js may have refreshed it)
  const currentUrl = localStorage.getItem("cc_avatar_url") || null;
  modal.style.display = "flex";
  const cur = document.getElementById("_av-current-img");
  const ph  = document.getElementById("_av-placeholder");
  if (currentUrl) { cur.src = currentUrl; cur.style.display = "block"; ph.style.display = "none"; }
  else            { cur.style.display = "none"; ph.style.display = "flex"; }
  document.getElementById("_av-status").textContent = "";
  document.getElementById("_av-use-btn").style.display = "none";
  document.getElementById("_av-remove-btn").style.display = currentUrl ? "block" : "none";
  avatarPendingFile = null;
  const lbl = document.querySelector('label[for="_av-file-input"]');
  if (lbl) lbl.textContent = currentUrl ? "📷 Change Photo" : "📷 Choose / Take Photo";
}

function closeAvatarModal() {
  const modal = document.getElementById("_avatar-modal");
  if (modal) modal.style.display = "none";
  avatarPendingFile = null;
}

function handleAvatarFileChosen(input) {
  const file = input.files?.[0];
  if (!file) return;
  avatarPendingFile = file;
  const cur = document.getElementById("_av-current-img");
  cur.src = URL.createObjectURL(file); cur.style.display = "block";
  document.getElementById("_av-placeholder").style.display = "none";
  document.getElementById("_av-status").textContent = "Photo selected — tap 'Use Photo As-Is' to save.";
  document.getElementById("_av-use-btn").style.display = "block";
  document.getElementById("_av-remove-btn").style.display = "none";
}

async function usePhotoAsIs() {
  if (!avatarPendingFile) { alert("Please choose a photo first."); return; }
  const sess = getSession();
  if (!sess?.store || !sess?.name) { alert("Not logged in."); return; }
  const empId = await getEmpId(sess.store, sess.name);
  if (!empId) { alert("Employee record not found."); return; }
  const btn = document.getElementById("_av-use-btn");
  btn.disabled = true; btn.textContent = "Saving…";
  document.getElementById("_av-status").textContent = "Compressing photo…";
  try {
    const compressed = await compressImage(avatarPendingFile, 512, 0.85);
    document.getElementById("_av-status").textContent = "Uploading photo…";
    const sRef = storageRef(storage, `avatars/${sess.store}/${empId}.jpg`);
    await uploadBytes(sRef, compressed, { contentType: "image/jpeg" });
    const url = await getDownloadURL(sRef);
    await updateDoc(doc(db, "stores", sess.store, "employees", empId), { avatarUrl: url });
    applyAvatarToBtn(url);
    const cur = document.getElementById("_av-current-img");
    cur.src = url; cur.style.display = "block";
    document.getElementById("_av-placeholder").style.display = "none";
    document.getElementById("_av-status").textContent = "Photo saved!";
    document.getElementById("_av-remove-btn").style.display = "block";
    btn.textContent = "✅ Saved";
  } catch(e) {
    document.getElementById("_av-status").textContent = "Error: " + (e.message || "Unknown error");
    btn.textContent = "📷 Use Photo As-Is";
  } finally {
    btn.disabled = false;
    avatarPendingFile = null;
    const inp = document.getElementById("_av-file-input");
    if (inp) inp.value = "";
  }
}

async function removeMyAvatar() {
  if (!confirm("Remove your avatar? This can't be undone.")) return;
  const sess  = getSession();
  const empId = sess?.store ? await getEmpId(sess.store, sess.name).catch(() => null) : null;
  const btn   = document.getElementById("_av-remove-btn");
  btn.disabled = true; btn.textContent = "Removing…";
  document.getElementById("_av-status").textContent = "Removing avatar…";
  try {
    if (empId && sess?.store) {
      await updateDoc(doc(db, "stores", sess.store, "employees", empId), { avatarUrl: deleteField() });
      try { await deleteObject(storageRef(storage, `avatars/${sess.store}/${empId}.jpg`)); } catch(_) {}
    }
    applyAvatarToBtn(null);
    const cur = document.getElementById("_av-current-img");
    cur.src = ""; cur.style.display = "none";
    document.getElementById("_av-placeholder").style.display = "flex";
    document.getElementById("_av-use-btn").style.display = "none";
    document.getElementById("_av-status").textContent = "Avatar removed.";
    const lbl = document.querySelector('label[for="_av-file-input"]');
    if (lbl) lbl.textContent = "📷 Choose / Take Photo";
    btn.style.display = "none";
  } catch(e) {
    document.getElementById("_av-status").textContent = "Error: " + (e.message || "Unknown error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🗑️ Remove Avatar";
  }
}

// Expose globally with _av_ prefix to avoid collisions with other page handlers
window._avOpenModal    = openAvatarModal;
window._avCloseModal   = closeAvatarModal;
window._avFileChosen   = (input) => handleAvatarFileChosen(input);
window._avUseAsIs      = usePhotoAsIs;
window._avRemove       = removeMyAvatar;

// ── MODAL HTML INJECTION ─────────────────────────────────────────────────────
function injectModal() {
  if (document.getElementById("_avatar-modal")) return;
  const modal = document.createElement("div");
  modal.id = "_avatar-modal";
  modal.style.cssText = "display:none;position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:400;align-items:center;justify-content:center;";
  modal.addEventListener("click", (e) => { if (e.target === modal) closeAvatarModal(); });
  modal.innerHTML = `
    <div style="background:white;border-radius:16px;padding:24px 20px;max-width:320px;width:90%;text-align:center;box-sizing:border-box;" onclick="event.stopPropagation()">
      <h3 style="font-family:'Courier Prime',monospace;font-size:17px;margin:0 0 6px;">My Avatar</h3>
      <p style="font-size:13px;color:#8a8a7e;margin:0 0 16px;">Choose a photo to use as your avatar.</p>
      <div style="margin-bottom:14px;">
        <img id="_av-current-img" src="" alt="" style="width:100px;height:100px;border-radius:50%;object-fit:cover;border:3px solid #1c3a2a;display:none;margin:0 auto 8px;">
        <div id="_av-placeholder" style="width:100px;height:100px;border-radius:50%;background:#c8e6d0;border:3px dashed #7fb891;display:flex;align-items:center;justify-content:center;font-size:42px;margin:0 auto 8px;">👤</div>
      </div>
      <div id="_av-status" style="font-size:13px;color:#8a8a7e;min-height:18px;margin-bottom:12px;"></div>
      <input type="file" id="_av-file-input" accept="image/*" style="display:none;" onchange="_avFileChosen(this)">
      <label for="_av-file-input" style="display:block;width:100%;padding:10px;background:#1c3a2a;border:none;border-radius:10px;font-size:14px;font-weight:700;color:white;cursor:pointer;margin-bottom:8px;box-sizing:border-box;">📷 Choose / Take Photo</label>
      <button id="_av-use-btn" onclick="_avUseAsIs()" style="display:none;width:100%;padding:10px;background:#4a90d9;border:none;border-radius:10px;font-size:14px;font-weight:700;color:white;cursor:pointer;margin-bottom:8px;">📷 Use Photo As-Is</button>
      <button id="_av-remove-btn" onclick="_avRemove()" style="display:none;width:100%;padding:9px;background:#fff0f0;border:1.5px solid #e55;border-radius:10px;font-size:14px;font-weight:700;color:#c00;cursor:pointer;margin-bottom:8px;">🗑️ Remove Avatar</button>
      <button onclick="_avCloseModal()" style="width:100%;padding:9px;background:#f5f2eb;border:1.5px solid #e2ddd3;border-radius:10px;font-size:13px;font-weight:700;color:#4a4a42;cursor:pointer;">Cancel</button>
    </div>`;
  document.body.appendChild(modal);
}

// ── PUBLIC API ───────────────────────────────────────────────────────────────
/**
 * Call once after the page loads.
 * @param {string} avatarBtnSelector  CSS selector for the topbar avatar container
 *                                    (e.g. "#coaching-avatar" or "#rules-avatar")
 */
export function initAvatarModal(avatarBtnSelector) {
  const container = document.querySelector(avatarBtnSelector);
  if (!container) return;

  avatarImgEl = container.querySelector("img");
  avatarPhEl  = container.querySelector("span");

  // Restore cached avatar into the topbar immediately
  const cached = localStorage.getItem("cc_avatar_url");
  if (cached && avatarImgEl) {
    avatarImgEl.src = cached; avatarImgEl.style.display = "block";
    if (avatarPhEl) avatarPhEl.style.display = "none";
  }

  // Make the avatar circle tappable
  container.style.cursor = "pointer";
  container.addEventListener("click", openAvatarModal);

  // Inject modal HTML (idempotent — safe to call multiple times)
  injectModal();
}
