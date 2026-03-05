// ── SHARED UTILITIES ──────────────────────────────────────────
// Pure helper functions with no side effects.
// Also includes Firebase read helpers that accept db as a parameter.
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export function el(id)  { return document.getElementById(id); }
export function v(id)   { return el(id).value.trim(); }
export function esc(s)  { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
export function ts(ms)  {
  const t = new Date(ms);
  return t.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}) + " · " +
         t.toLocaleDateString("en-US",{month:"short",day:"numeric"});
}

export async function compressImage(file, maxPx = 1280, quality = 0.82) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: h } = img;
      if (w > maxPx || h > maxPx) {
        if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
        else        { w = Math.round(w * maxPx / h); h = maxPx; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => resolve(blob || file), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// Returns { appName, logoUrl, brandColor } from Firestore admin/appConfig.
// Each page applies the values to its own DOM elements.
export async function fetchBrandingData(db) {
  const snap = await getDoc(doc(db, "admin", "appConfig"));
  if (!snap.exists()) return null;
  const d = snap.data();
  return { appName: d.appName || "", logoUrl: d.logoUrl || "", brandColor: d.brandColor || "" };
}

// Updates #broadcast-banner if an active broadcast exists.
export async function loadBroadcast(db) {
  try {
    const snap = await getDoc(doc(db, "admin", "broadcast"));
    if (!snap.exists()) return;
    const data = snap.data();
    if (!data.active || !data.message) return;
    const banner = document.getElementById("broadcast-banner");
    if (!banner) return;
    banner.innerHTML = (data.title ? `<strong>📢 ${data.title}</strong>` : "<strong>📢 Notice</strong>") + data.message;
    banner.classList.add("show");
  } catch(e) { /* non-critical — broadcast is cosmetic */ }
}
