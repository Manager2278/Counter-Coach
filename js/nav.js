// ── SHARED BOTTOM NAV ──────────────────────────────────────────
// Single source of truth for the cross-page bottom navigation bar.
// Used by coach.html, coaching.html, and rules.html.
// index.html manages its own SPA tab nav separately.
//
// Usage:  import { initNav } from "./nav.js";
//         initNav("coach");   // pass the current page key
//
// Page keys: "coach" | "coaching" | "rules"
// (recap links like /?tab=msg are destinations, not page keys here)

const ITEMS = [
  { key: "coach",    href: "/coach",         label: "Coach",    img: "icon-192.png" },
  { key: "recap",    href: "/",              label: "Logbook",  icon: "📋" },
  { key: "msg",      href: "/?tab=msg",      label: "Private",  icon: "🔒", role: "employee" },
  { key: "coaching", href: "/coaching",      label: "Coaching", icon: "📝" },
  { key: "settings", href: "/?tab=settings", label: "Settings", icon: "⚙️", role: "employee" },
  { key: "mgr",      href: "/?tab=mgr",      label: "Manager",  icon: "🔑", role: "manager", hidden: true },
];

const NAV_CSS = `
body { padding-bottom: 70px; }
.bottom-nav {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: white; border-top: 1.5px solid #ddd;
  display: flex; z-index: 200;
  box-shadow: 0 -2px 14px rgba(0,0,0,.08);
}
.nav-btn-link {
  flex: 1; padding: 10px 8px 8px; text-align: center;
  text-decoration: none; color: #888; font-size: 10px;
  font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
  display: flex; flex-direction: column; align-items: center;
  transition: color .15s;
}
.nav-btn-link.active,
.nav-btn-link:hover { color: #1a6b3c; }
.nav-icon { font-size: 20px; display: block; margin-bottom: 2px; }
`;

export function initNav(activePage) {
  // 1. Inject CSS once per page
  if (!document.getElementById("_nav_css")) {
    const style = document.createElement("style");
    style.id = "_nav_css";
    style.textContent = NAV_CSS;
    document.head.appendChild(style);
  }

  // 2. Build nav element
  const nav = document.createElement("nav");
  nav.className = "bottom-nav";
  nav.id = "bottom-nav";

  ITEMS.forEach(item => {
    const a = document.createElement("a");
    a.className = "nav-btn-link" + (item.key === activePage ? " active" : "");
    a.href = item.href;
    if (item.role)   a.dataset.role = item.role;
    if (item.hidden) a.style.display = "none";
    a.innerHTML = item.img
      ? `<img src="${item.img}" style="width:22px;height:22px;border-radius:4px;object-fit:cover;display:block;margin:0 auto 2px;" alt="">${item.label}`
      : `<span class="nav-icon">${item.icon}</span>${item.label}`;
    nav.appendChild(a);
  });

  document.body.appendChild(nav);

  // 3. Role-based visibility (reads localStorage — no Firebase needed)
  try {
    const s   = JSON.parse(localStorage.getItem("cc_v2_session") || "null");
    const ms  = JSON.parse(localStorage.getItem("cc_recap_mgr")  || "null");
    const isMgr = (ms && ms.on) || (s && s.role === "manager");
    document.querySelectorAll("[data-role='employee']").forEach(el => {
      el.style.display = isMgr ? "none" : "";
    });
    document.querySelectorAll("[data-role='manager']").forEach(el => {
      el.style.display = isMgr ? "" : "none";
    });
  } catch(_) {}
}
