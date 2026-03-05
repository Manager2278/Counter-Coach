// ── SHARED SESSION HELPERS ────────────────────────────────────
// localStorage-based session persistence. Zero Firebase dependencies.

// Saves the main user session.
// data shape: { store, name, role, managerPhone, helpdeskPhone }
export function saveSession(data) {
  localStorage.setItem("cc_v2_session", JSON.stringify(data));
}

export function loadSession() {
  try { return JSON.parse(localStorage.getItem("cc_v2_session")); } catch { return null; }
}

// Saves the manager PIN session for recap.html
// data shape: { store, on: true }
export function saveMgrSession(data) {
  localStorage.setItem("cc_recap_mgr", JSON.stringify(data));
}

export function loadMgrSession() {
  try { return JSON.parse(localStorage.getItem("cc_recap_mgr")); } catch { return null; }
}

export function clearMgrSession() {
  localStorage.removeItem("cc_recap_mgr");
}
