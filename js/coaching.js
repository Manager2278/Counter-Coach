// ── COACHING.HTML — Manager Coaching System ───────────────────
// Note: coaching.html must load jsPDF BEFORE this module:
//   <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
//   <script type="module" src="js/coaching.js"></script>
import { db, auth, functions }               from "./firebase.js";
import { initNav }                           from "./nav.js";
import { initAvatarModal }                   from "./avatar.js";
import { el, esc }                           from "./utils.js";
import { loadSession as getSession,
         loadMgrSession, saveSession }        from "./session.js";
import { getFirestore, doc, getDoc, addDoc, updateDoc, deleteDoc,
         collection, query, where, orderBy, getDocs, onSnapshot,
         serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { signInAnonymously }                 from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFunctions, httpsCallable }       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

// ── STATE ─────────────────────────────────────────────────────
let store = "", managerName = "", isMgr = false;
let prefillEmpName = "", prefillEmpNum = "";

function loadSession() {
  const s = getSession();
  if (s && s.store) { store = String(s.store); managerName = s.name || ""; }
  const m = loadMgrSession();
  if (m && m.store === store && m.on) isMgr = true;
}

// ── HELPERS ───────────────────────────────────────────────────
function showErr(id, msg) { const e=el(id); e.textContent=msg; e.classList.add("show"); }
function hideErr(id)      { el(id).classList.remove("show"); }

// ── SIGNATURE PAD ─────────────────────────────────────────────
class SigPad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d");
    this._strokes = false;
    this.drawing  = false;
    this._resize();
    this.ctx.strokeStyle = "#1a1a16";
    this.ctx.lineWidth   = 2;
    this.ctx.lineCap     = "round";
    this.ctx.lineJoin    = "round";

    canvas.addEventListener("mousedown",  e => this._start(e.offsetX, e.offsetY));
    canvas.addEventListener("mousemove",  e => { if (this.drawing) this._draw(e.offsetX, e.offsetY); });
    canvas.addEventListener("mouseup",    () => { this.drawing = false; });
    canvas.addEventListener("mouseleave", () => { this.drawing = false; });

    canvas.addEventListener("touchstart", e => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const t = e.touches[0];
      this._start((t.clientX - r.left) * (canvas.width / r.width),
                  (t.clientY - r.top)  * (canvas.height / r.height));
    }, { passive: false });
    canvas.addEventListener("touchmove", e => {
      e.preventDefault();
      if (!this.drawing) return;
      const r = canvas.getBoundingClientRect();
      const t = e.touches[0];
      this._draw((t.clientX - r.left) * (canvas.width / r.width),
                 (t.clientY - r.top)  * (canvas.height / r.height));
    }, { passive: false });
    canvas.addEventListener("touchend", () => { this.drawing = false; });
  }
  _resize() {
    this.canvas.width  = this.canvas.offsetWidth || 400;
    this.canvas.height = 150;
  }
  _start(x, y) {
    this.drawing = true;
    this._strokes = true;
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
  }
  _draw(x, y) {
    this.ctx.lineTo(x, y);
    this.ctx.stroke();
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
  }
  clear()   { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this._strokes = false; }
  isEmpty() { return !this._strokes; }
  get()     { return this.canvas.toDataURL("image/png"); }
}

let empPad, mgrPad;

window.clearMgrSig = () => { if (mgrPad) mgrPad.clear(); };
window.clearEmpSig = () => { if (empPad) empPad.clear(); };

// ── INIT ──────────────────────────────────────────────────────
signInAnonymously(auth)
  .then(() => init())
  .catch(e  => { console.error("Auth:", e); init(); });

function init() {
  loadSession();
  initNav("coaching");
  // Fetch avatar from Firestore and update topbar + localStorage cache
  if (store && managerName) {
    getDocs(query(collection(db, "stores", store, "employees"), where("name", "==", managerName)))
      .then(snap => {
        if (!snap.empty) {
          const avatarUrl = snap.docs[0].data().avatarUrl;
          if (avatarUrl) {
            localStorage.setItem("cc_avatar_url", avatarUrl);
            const img = document.getElementById("coaching-avatar-img");
            const ph  = document.getElementById("coaching-avatar-ph");
            if (img) { img.src = avatarUrl; img.style.display = "block"; }
            if (ph)  { ph.style.display = "none"; }
          }
        }
      }).catch(() => {});
  }
  initAvatarModal("#coaching-avatar");
  const params    = new URLSearchParams(location.search);
  const kioskId   = params.get("kiosk");
  const signId    = params.get("sign");
  prefillEmpName  = params.get("emp") || "";
  prefillEmpNum   = params.get("num") || "";

  if (kioskId) {
    el("kiosk-view").style.display = "block";
    loadKiosk(kioskId);
    return;
  }

  el("main-ui").style.display = "block";
  if (!store || !isMgr) {
    el("auth-gate").style.display = "block";
    return;
  }

  el("coaching-app").style.display = "block";
  el("topbar-store").style.display = "inline-block";
  el("topbar-store").textContent   = "Store " + store + " — " + managerName;

  empPad = new SigPad(el("emp-sig"));
  mgrPad = new SigPad(el("mgr-sig"));

  listenRoster();
  loadDashData();
  loadLevelPreview();

  // If opened via "Review & Sign" link from logbook, jump straight to that record
  if (signId) openReview(signId);
}

// ── TABS ──────────────────────────────────────────────────────
window.switchTab = function(tab) {
  ["new","dash","emp","saved","emp-detail","review"].forEach(t => {
    el("screen-" + t)?.classList.remove("on");
  });
  ["new","dash","emp"].forEach(t => {
    el("tab-" + t + "-btn")?.classList.remove("on");
  });

  if (tab === "dash") {
    el("screen-dash").classList.add("on");
    el("tab-dash-btn").classList.add("on");
    renderDashboard();
    return;
  }
  if (tab === "emp") {
    el("screen-emp").classList.add("on");
    el("tab-emp-btn").classList.add("on");
    renderRoster();
    return;
  }
  el("screen-new").classList.add("on");
  el("tab-new-btn").classList.add("on");
  loadLevelPreview();
};

// ── AI AUTO-FILL ──────────────────────────────────────────────
const AI = {
  "Core Charge Violation": {
    expected: "Core charges are only removed when the physical core is present and verified at the counter.",
    ask:      "Did you physically receive and inspect the core before removing the charge?",
    action:   "Review the core charge policy. Verify physical core is in hand before any removal in the system."
  },
  "Warranty Violation": {
    expected: "All warranty claims must follow system guidelines and include proper part testing before processing.",
    ask:      "What steps did you take to verify the part was defective before processing the warranty?",
    action:   "Re-train on warranty lookup and the required testing procedure before any claim is processed."
  },
  "Customer Service": {
    expected: "Every customer must be greeted promptly and assisted with professionalism and a solution-first approach.",
    ask:      "How could that customer interaction have been handled differently to reach a better outcome?",
    action:   "Focus on greeting every customer, active listening, and offering at least one solution."
  },
  "Lookup Error": {
    expected: "Parts must be verified using the correct vehicle application — year, make, model, and submodel.",
    ask:      "What steps did you use to confirm the correct part number before completing the sale?",
    action:   "Slow down, confirm all vehicle details, and verify part numbers before completing any sale."
  },
  "Cash Handling": {
    expected: "All transactions must be counted aloud, verified on screen, and the drawer confirmed before closing.",
    ask:      "Walk me through what happened step by step during that transaction.",
    action:   "Follow cash handling procedures: count aloud, count back change, verify amount before closing drawer."
  },
  "Attitude / Conduct": {
    expected: "Team members must maintain a respectful, professional attitude with customers, coworkers, and management at all times.",
    ask:      "Can you help me understand what was going through your mind during that situation?",
    action:   "Review the conduct policy. A repeat of this behavior may result in further disciplinary action."
  },
  "Attendance / Punctuality": {
    expected: "Team members are expected to arrive on time and ready to work for every scheduled shift.",
    ask:      "What prevented you from arriving on time, and what will you do differently going forward?",
    action:   "Ensure reliable transportation and alarms are in place. Further occurrences will be documented."
  },
  "No Call / No Show": {
    expected: "If unable to work a shift, team members must notify the store manager at least 2 hours in advance.",
    ask:      "Why were you unable to contact the store before your shift started?",
    action:   "Review the attendance and call-in policy. Future NCNS occurrences may result in termination."
  },
  "Safety Violation": {
    expected: "All safety policies must be followed at all times to protect yourself, your coworkers, and customers.",
    ask:      "Were you aware of the safety requirement, and what caused you to deviate from it?",
    action:   "Immediately review safety procedures. No exceptions to safety policy are acceptable."
  },
  "Policy Violation": {
    expected: "Company policies exist to protect the business and must be followed consistently.",
    ask:      "Were you aware of this policy, and what led you to deviate from it?",
    action:   "Re-read and acknowledge the relevant policy. Future violations may result in stronger action."
  },
  "Dress Code / Appearance": {
    expected: "Team members must report to work in full uniform meeting company appearance standards.",
    ask:      "Were you aware of the dress code requirement for today's shift?",
    action:   "Review and comply with the dress code policy effective immediately."
  },
  "Professional Sales Call": {
    expected: "Team members conducting professional sales calls should introduce themselves professionally, identify the shop's specific business needs, present O'Reilly's value proposition, and build lasting relationships to earn and grow their ongoing business.",
    ask:      "Walk me through your last pro sales visit — how did you open the conversation, what needs did you uncover, and how did you position O'Reilly's value?",
    action:   "Review the professional sales call process. Focus on building rapport, identifying shop-specific needs, and clearly communicating how O'Reilly can support their business long-term."
  },
  "ROCK the Call": {
    expected: "Every incoming call must follow the ROCK the Call procedure: greet the customer professionally, identify their needs, offer accurate solutions, reinforce O'Reilly's low price guarantee, and close the call ensuring the customer is satisfied.",
    ask:      "Walk me through how you handled that call — did you follow each step of the ROCK the Call process, including the low price guarantee?",
    action:   "Practice the ROCK the Call steps: greet professionally, confirm part availability and pricing, reinforce the low price guarantee, and make sure the customer hangs up confident in O'Reilly."
  }
};

window.applyAI = function() {
  const issue = el("issue").value;
  if (AI[issue]) {
    el("expected").value = AI[issue].expected;
    el("action").value   = AI[issue].action;
  }
  loadLevelPreview();
};

// ── COACHING LEVEL ────────────────────────────────────────────
let priorCount = 0;

async function loadLevelPreview() {
  const name = el("emp-name").value.trim();
  if (!name || !store) { setLevelUI(0); return; }
  try {
    const q    = query(collection(db,"stores",store,"coaching"), where("name","==",name));
    const snap = await getDocs(q);
    priorCount = snap.size;
    setLevelUI(priorCount);
  } catch(_) { setLevelUI(0); }
}

function setLevelUI(count) {
  const preview  = el("level-preview");
  const labelEl  = el("level-label");
  const subEl    = el("level-sub");
  const fwBox    = el("fw-box");

  preview.className = "level-preview";
  if (count >= 2) {
    preview.classList.add("level-final");
    labelEl.textContent = "Final Warning";
    subEl.textContent   = count === 2
      ? "3rd coaching for this employee at this store"
      : `${count + 1}th coaching for this employee`;
    fwBox.classList.add("show");
  } else if (count === 1) {
    preview.classList.add("level-written");
    labelEl.textContent = "Written Warning";
    subEl.textContent   = "2nd coaching for this employee at this store";
    fwBox.classList.remove("show");
  } else {
    preview.classList.add("level-verbal");
    labelEl.textContent = "Verbal Coaching";
    subEl.textContent   = count === 0
      ? "No prior coachings found for this employee"
      : "1st coaching for this employee at this store";
    fwBox.classList.remove("show");
  }
}

window.updateFWCheck = function() { /* validation happens on save */ };
el("emp-name") && el("emp-name").addEventListener("change", () => {
  loadLevelPreview();
  const sel = el("emp-name");
  const opt = sel ? sel.options[sel.selectedIndex] : null;
  const num = opt ? (opt.dataset.num || "") : "";
  if (num && el("emp-counter") && !el("emp-counter").value) el("emp-counter").value = num;
});

// ── SAVE ──────────────────────────────────────────────────────
let lastDoc = null, lastId = null;

window.saveCoaching = async function() {
  hideErr("save-err");
  const empName  = el("emp-name").value.trim();
  const issue    = el("issue").value;
  const incident = el("incident").value.trim();
  const expected = el("expected").value.trim();
  const empCounter = el("emp-counter").value.trim();
  const action   = el("action").value.trim();

  if (!empName)  { showErr("save-err","Employee name is required."); return; }
  if (!issue)    { showErr("save-err","Please select an issue type."); return; }
  if (!incident) { showErr("save-err","Please describe the incident."); return; }
  if (mgrPad.isEmpty()) { showErr("save-err","Manager signature is required."); return; }

  const isFinal   = priorCount >= 2;
  const isWritten = priorCount === 1;

  if (isFinal && !el("fw-check").checked) {
    showErr("save-err","You must confirm you have completed the required company system writeup before saving a Final Warning.");
    return;
  }

  const level = isFinal ? "Final Warning" : isWritten ? "Written Warning" : "Verbal Coaching";
  const empSigData = empPad.isEmpty() ? null : empPad.get();

  const data = {
    store,
    manager:  managerName,
    name:     empName,
    empCounter: empCounter || null,
    issue,
    incident,
    expected,
    action,
    type:     level,
    mgrSig:   mgrPad.get(),
    empSig:   empSigData,
    date:     new Date().toLocaleString("en-US",{ month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" }),
    status:   !empSigData ? "pending_employee" : "complete",
    systemWriteupDone: isFinal,
    systemRef: isFinal ? (el("fw-ref").value.trim() || null) : null,
    savedAt:  serverTimestamp()
  };

  try {
    const ref = await addDoc(collection(db,"stores",store,"coaching"), data);
    lastDoc = data;
    lastId  = ref.id;

    ["screen-new","screen-dash","screen-emp","screen-emp-detail"].forEach(id => {
      el(id)?.classList.remove("on");
    });
    el("screen-saved").classList.add("on");
    ["new","dash","emp"].forEach(id => el("tab-"+id+"-btn")?.classList.remove("on"));

    const lc = isFinal ? "badge-final" : isWritten ? "badge-written" : "badge-verbal";
    el("saved-level").innerHTML = `<span class="badge ${lc}">${level}</span>`;
    el("saved-details").innerHTML = `
      <strong>Employee:</strong> ${esc(empName)}<br>
      <strong>Issue:</strong> ${esc(issue)}<br>
      <strong>Date:</strong> ${esc(data.date)}<br>
      <strong>Signature status:</strong> ${data.status === "complete" ? "Fully signed" : "Awaiting employee signature"}
    `;

    loadDashData();
  } catch(e) {
    showErr("save-err","Error saving: " + e.message);
  }
};

window.downloadLastPDF = function() { if (lastDoc) generatePDF(lastDoc); };

window.startNewCoaching = function() {
  el("emp-name").value  = "";
  el("issue").value     = "";
  el("incident").value  = "";
  el("expected").value    = "";
  el("emp-counter").value = "";
  el("action").value      = "";
  el("fw-check").checked = false;
  el("fw-ref").value    = "";
  el("fw-box").classList.remove("show");
  el("save-err").classList.remove("show");
  empPad.clear();
  mgrPad.clear();
  priorCount = 0;
  setLevelUI(0);
  el("screen-saved").classList.remove("on");
  el("screen-new").classList.add("on");
  ["new","dash","emp"].forEach(id => el("tab-"+id+"-btn")?.classList.remove("on"));
  el("tab-new-btn").classList.add("on");
};

// ── PDF ───────────────────────────────────────────────────────
// Note: generatePDFDoc uses `const doc = new jsPDF()` which shadows the
// Firestore `doc` import locally — this is intentional and safe.
function generatePDFDoc(d) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const lm  = 20;
  const rw  = 170;
  let   y   = 20;

  function addPage() { doc.addPage(); y = 20; }
  function checkPage(needed) { if (y + needed > 270) addPage(); }

  function heading(text) {
    checkPage(14);
    doc.setFont("helvetica","bold");
    doc.setFontSize(10);
    doc.setTextColor(28, 58, 42);
    doc.text(text.toUpperCase(), lm, y);
    y += 4;
    doc.setDrawColor(200, 230, 210);
    doc.line(lm, y, lm + rw, y);
    y += 5;
    doc.setTextColor(26, 26, 22);
    doc.setFont("helvetica","normal");
    doc.setFontSize(11);
  }

  function field(label, value) {
    if (!value) return;
    checkPage(14);
    doc.setFont("helvetica","bold");
    doc.setFontSize(10);
    doc.text(label + ":", lm, y);
    y += 5;
    doc.setFont("helvetica","normal");
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(String(value), rw);
    checkPage(lines.length * 5 + 4);
    doc.text(lines, lm, y);
    y += lines.length * 5 + 4;
  }

  doc.setFont("helvetica","bold");
  doc.setFontSize(16);
  doc.setTextColor(28, 58, 42);
  doc.text("Employee Coaching Record", lm, y);
  y += 8;

  doc.setTextColor(26, 26, 22);

  heading("Store Information");
  field("Store Number", d.store);
  field("Manager",      d.manager);
  field("Date",         d.date);

  heading("Employee");
  field("Employee Name", d.name);
  field("Issue Type",    d.issue);

  heading("Coaching Details");
  field("Incident",          d.incident);
  field("Expected Behavior", d.expected);
  field("Counter / Employee #", d.empCounter);
  field("Corrective Action",    d.action);

  if (d.systemWriteupDone) {
    heading("Company System Writeup");
    field("Status", "Completed in company HR / discipline system prior to this record");
    if (d.systemRef) field("Reference #", d.systemRef);
  }

  // Signatures
  checkPage(60);
  heading("Signatures");
  const sigY = y;

  if (d.mgrSig) {
    try { doc.addImage(d.mgrSig, "PNG", lm, sigY, 72, 32); } catch(_) {}
  } else {
    doc.rect(lm, sigY, 72, 32);
  }
  doc.setFont("helvetica","normal");
  doc.setFontSize(9);
  doc.text("Manager Signature", lm, sigY + 36);
  doc.text(d.manager || "", lm, sigY + 41);

  const ex = lm + 90;
  if (d.empSig) {
    try { doc.addImage(d.empSig, "PNG", ex, sigY, 72, 32); } catch(_) {}
  } else {
    doc.rect(ex, sigY, 72, 32);
    doc.setFont("helvetica","italic");
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 140);
    doc.text("Signature pending", ex + 2, sigY + 17);
    doc.setTextColor(26, 26, 22);
  }
  doc.setFont("helvetica","normal");
  doc.setFontSize(9);
  doc.text("Employee Signature", ex, sigY + 36);
  doc.text(d.name || "", ex, sigY + 41);

  y = sigY + 50;

  checkPage(16);
  doc.setFont("helvetica","italic");
  doc.setFontSize(8);
  doc.setTextColor(130, 130, 120);
  const disc = "Signing this document acknowledges receipt of this coaching record, not necessarily agreement with its contents. This record is confidential and for internal use only.";
  const discLines = doc.splitTextToSize(disc, rw);
  doc.text(discLines, lm, y);

  return doc;
}

function generatePDF(d) {
  const pdfDoc = generatePDFDoc(d);
  const fname  = `Coaching_${(d.name||"Employee").replace(/\s+/g,"_")}_${(d.date||"").replace(/[/:,\s]/g,"")}.pdf`;
  pdfDoc.save(fname);
}

window.emailLastPDF = async function() {
  if (!lastDoc || !lastId) return;
  const btn = el("email-pdf-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  try {
    const pdfBase64 = generatePDFDoc(lastDoc).output("datauristring").split(",")[1];
    const sendEmail = httpsCallable(functions, "sendCoachingEmail");
    await sendEmail({
      storeId:      store,
      coachingId:   lastId,
      employeeName: lastDoc.name || "",
      date:         lastDoc.date || "",
      type:         lastDoc.type || "Coaching",
      pdfBase64
    });
    if (btn) { btn.textContent = "✓ Sent!"; }
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = "📧 Email to DM"; }
    alert("Email failed: " + (e.message || String(e)));
  }
};

// ── DASHBOARD ─────────────────────────────────────────────────
let allCoachings = [];

async function loadDashData() {
  if (!store) return;
  try {
    const snap = await getDocs(collection(db,"stores",store,"coaching"));
    allCoachings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    allCoachings.sort((a,b) => (b.savedAt?.seconds||0) - (a.savedAt?.seconds||0));
  } catch(e) { console.warn("loadDashData:", e); }
}

function renderDashboard() {
  const search  = (el("dash-search")?.value || "").toLowerCase();
  const byEmp   = {};
  allCoachings.forEach(c => {
    if (search && !c.name.toLowerCase().includes(search)) return;
    if (!byEmp[c.name]) byEmp[c.name] = [];
    byEmp[c.name].push(c);
  });

  const container = el("dash-list");
  if (!Object.keys(byEmp).length) {
    container.innerHTML = `<div class="empty"><div class="empty-icon">&#x1F4CA;</div>${search ? "No matches found." : "No coaching records yet."}</div>`;
    return;
  }

  container.innerHTML = Object.entries(byEmp).map(([name, recs]) => {
    const cnt    = recs.length;
    const lTxt   = cnt >= 3 ? "Final Warning" : cnt === 2 ? "Written Warning" : "Verbal Coaching";
    const lCls   = cnt >= 3 ? "badge-final"   : cnt === 2 ? "badge-written"   : "badge-verbal";
    const pend   = recs.some(r => !r.empSig);
    const init   = name.charAt(0).toUpperCase();
    return `
      <div class="emp-card" onclick="showEmpDetail('${esc(name)}')">
        <div class="emp-avatar">${init}</div>
        <div class="emp-info">
          <div class="emp-name">${esc(name)}</div>
          <div class="emp-meta">${cnt} coaching${cnt !== 1 ? "s" : ""}${pend ? " &bull; sig pending" : ""}</div>
        </div>
        <span class="badge ${lCls}">${lTxt}</span>
      </div>
    `;
  }).join("");
}
window.renderDashboard = renderDashboard;

window.showEmpDetail = function(name) {
  const recs = allCoachings.filter(c => c.name === name);
  const cnt  = recs.length;
  const lTxt = cnt >= 3 ? "Final Warning" : cnt === 2 ? "Written Warning" : "Verbal Coaching";
  const lCls = cnt >= 3 ? "badge-final"   : cnt === 2 ? "badge-written"   : "badge-verbal";

  el("det-name").textContent = name;
  el("det-badge").innerHTML  = `<span class="badge ${lCls}">${lTxt}</span> <span style="font-size:13px;color:var(--ink-faint);">${cnt} coaching${cnt !== 1 ? "s" : ""}</span>`;

  el("det-list").innerHTML = recs.map(r => {
    const rc  = r.type === "Final Warning" ? "badge-final" : r.type === "Written Warning" ? "badge-written" : "badge-verbal";
    const sig = r.empSig ? `<span class="badge badge-signed">Signed</span>` : `<span class="badge badge-pending">Sig Pending</span>`;
    return `
      <div class="hist-item">
        <div class="hist-head">
          <span class="badge ${rc}">${esc(r.type)}</span>
          <span class="hist-date">${esc(r.date||"")}</span>
        </div>
        <div class="hist-issue">${esc(r.issue||"")}</div>
        <div style="margin-top:6px;">${sig}</div>
        <div class="hist-actions">
          <button class="btn btn-sm btn-outline" onclick="pdfById('${r.id}')">&#x1F4C4; PDF</button>
          <button class="btn btn-sm btn-outline" onclick="openReview('${r.id}')">&#x1F4CB; Review &amp; Sign</button>
          ${r.empSig ? `<button class="btn btn-sm btn-outline" data-eid="${r.id}" onclick="emailById('${r.id}', this)">&#x1F4E7; Email DM</button>` : ""}
        </div>
      </div>
    `;
  }).join("");

  ["screen-new","screen-dash","screen-emp","screen-saved","screen-review"].forEach(id => el(id)?.classList.remove("on"));
  el("screen-emp-detail").classList.add("on");
};

window.pdfById = function(id) {
  const r = allCoachings.find(c => c.id === id);
  if (r) generatePDF(r);
};

window.emailById = async function(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  const r = allCoachings.find(c => c.id === id);
  if (!r) { if (btn) { btn.disabled = false; btn.textContent = "📧 Email DM"; } return; }
  try {
    const pdfBase64 = generatePDFDoc(r).output("datauristring").split(",")[1];
    await httpsCallable(functions, "sendCoachingEmail")({
      storeId: store, coachingId: id,
      employeeName: r.name || "", date: r.date || "",
      type: r.type || "Coaching", pdfBase64
    });
    if (btn) { btn.textContent = "✓ Sent!"; }
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = "📧 Email DM"; }
    alert("Email failed: " + (e.message || String(e)));
  }
};

// ── RECORD REVIEW & SIGN ──────────────────────────────────────
let rvDoc = null, rvId = null, rvPad = null, rvEmpName = "";

window.openReview = async function(id) {
  let rec = allCoachings.find(c => c.id === id);
  if (!rec) {
    try {
      const snap = await getDoc(doc(db, "stores", store, "coaching", id));
      if (!snap.exists()) { alert("Record not found."); return; }
      rec = { id, ...snap.data() };
    } catch(e) { alert("Error loading record: " + e.message); return; }
  }
  rvDoc = rec; rvId = id; rvEmpName = rec.name || "";

  el("rv-title").textContent = `${rec.type || "Coaching"} — ${rec.name || ""}`;

  const fields = [
    ["Date",                 rec.date],
    ["Manager",              rec.manager],
    ["Store",                rec.store],
    ["Counter / Employee #", rec.empCounter],
    ["Issue Type",           rec.issue],
    ["Incident",             rec.incident],
    ["Expected Behavior",    rec.expected],
    ["Corrective Action",    rec.action],
  ];
  el("rv-fields").innerHTML = fields
    .filter(([, v]) => v)
    .map(([l, v]) => `
      <div style="margin-bottom:10px;">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--ink-faint);margin-bottom:3px;">${esc(l)}</div>
        <div style="font-size:13px;color:var(--ink);background:var(--paper);border:1px solid var(--ruled);border-radius:8px;padding:9px 12px;line-height:1.6;">${esc(v)}</div>
      </div>
    `).join("");

  if (rec.mgrSig) {
    el("rv-mgr-sig-img").src = rec.mgrSig;
    el("rv-mgr-sig-card").style.display = "block";
    el("rv-mgr-name").textContent = "Signed by " + (rec.manager || "Manager");
  } else {
    el("rv-mgr-sig-card").style.display = "none";
  }

  if (rec.empSig) {
    el("rv-emp-sig-display").innerHTML = `
      <img src="${rec.empSig}" style="max-width:100%;max-height:90px;object-fit:contain;border:1px solid var(--ruled);border-radius:8px;background:white;display:block;margin-bottom:6px;">
      <div style="font-size:12px;color:var(--ink-faint);">Signed by ${esc(rec.name || "employee")}</div>
    `;
    el("rv-sig-pad-area").style.display = "none";
    el("rv-sign-btn").style.display     = "none";
  } else {
    el("rv-emp-sig-display").innerHTML = `<div style="font-size:13px;color:var(--amber);font-weight:700;margin-bottom:10px;">&#x26A0;&#xFE0F; No employee signature yet</div>`;
    el("rv-sig-pad-area").style.display = "block";
    el("rv-sign-btn").style.display     = "block";
    el("rv-sign-btn").disabled          = false;
    el("rv-sign-btn").textContent       = "✍️ Save Employee Signature";
    if (!rvPad) rvPad = new SigPad(el("rv-emp-sig"));
    else rvPad.clear();
  }

  el("rv-err").classList.remove("show");
  el("rv-ok").classList.remove("show");
  el("rv-email-btn").disabled    = false;
  el("rv-email-btn").textContent = "📧 Email to DM";

  ["screen-new","screen-dash","screen-emp","screen-saved","screen-emp-detail"].forEach(s => el(s)?.classList.remove("on"));
  el("screen-review").classList.add("on");
  ["new","dash","emp"].forEach(t => el("tab-" + t + "-btn")?.classList.remove("on"));
};

window.closeReview = function() {
  el("screen-review").classList.remove("on");
  if (rvEmpName) showEmpDetail(rvEmpName);
  else { el("screen-dash").classList.add("on"); el("tab-dash-btn").classList.add("on"); }
};

window.clearRvSig = function() { if (rvPad) rvPad.clear(); };

window.saveRvSignature = async function() {
  if (!rvPad || rvPad.isEmpty()) { showErr("rv-err", "Please have the employee sign before saving."); return; }
  el("rv-sign-btn").disabled = true;
  el("rv-sign-btn").textContent = "Saving…";
  try {
    const empSig = rvPad.get();
    await updateDoc(doc(db, "stores", store, "coaching", rvId), {
      empSig, signedAt: serverTimestamp(), status: "complete"
    });
    const idx = allCoachings.findIndex(c => c.id === rvId);
    if (idx >= 0) Object.assign(allCoachings[idx], { empSig, status: "complete" });
    rvDoc = { ...rvDoc, empSig, status: "complete" };

    el("rv-emp-sig-display").innerHTML = `
      <img src="${empSig}" style="max-width:100%;max-height:90px;object-fit:contain;border:1px solid var(--ruled);border-radius:8px;background:white;display:block;margin-bottom:6px;">
      <div style="font-size:12px;color:var(--ink-faint);">Signed by ${esc(rvDoc.name || "employee")}</div>
    `;
    el("rv-sig-pad-area").style.display = "none";
    el("rv-sign-btn").style.display     = "none";
    el("rv-ok").textContent = "Signature saved successfully.";
    el("rv-ok").classList.add("show");
  } catch(e) {
    el("rv-sign-btn").disabled    = false;
    el("rv-sign-btn").textContent = "✍️ Save Employee Signature";
    showErr("rv-err", "Error saving: " + e.message);
  }
};

window.rvDownloadPDF = function() { if (rvDoc) generatePDF(rvDoc); };

window.rvEmailPDF = async function() {
  if (!rvDoc || !rvId) return;
  const btn = el("rv-email-btn");
  btn.disabled = true; btn.textContent = "Sending…";
  try {
    const pdfBase64 = generatePDFDoc(rvDoc).output("datauristring").split(",")[1];
    await httpsCallable(functions, "sendCoachingEmail")({
      storeId: store, coachingId: rvId,
      employeeName: rvDoc.name || "", date: rvDoc.date || "",
      type: rvDoc.type || "Coaching", pdfBase64
    });
    btn.textContent = "✓ Sent!";
    setTimeout(() => { btn.disabled = false; btn.textContent = "📧 Email to DM"; }, 3000);
  } catch(e) {
    btn.disabled = false; btn.textContent = "📧 Email to DM";
    alert("Email failed: " + (e.message || String(e)));
  }
};

// ── EMPLOYEE ROSTER ───────────────────────────────────────────
let roster = [];
let unsubRoster = null;

// Real-time roster listener — stays in sync with manager panel changes
function listenRoster() {
  if (!store) return;
  if (unsubRoster) unsubRoster();
  unsubRoster = onSnapshot(
    query(collection(db, "stores", store, "employees"), orderBy("name")),
    snap => {
      roster = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      updateDropdown();
      renderRoster();
    },
    e => console.error("roster snapshot:", e)
  );
}

function updateDropdown() {
  const sel = el("emp-name");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select Employee —</option>' +
    roster.map(e => `<option value="${esc(e.name)}" data-num="${esc(e.memberNum||'')}">${esc(e.name)}${e.memberNum ? ' (' + esc(e.memberNum) + ')' : ''}</option>`).join("");
  if (cur) sel.value = cur;
  if (prefillEmpName) {
    sel.value = prefillEmpName;
    const opt = sel.options[sel.selectedIndex];
    const num = opt ? (opt.dataset.num || prefillEmpNum) : prefillEmpNum;
    if (el("emp-counter")) el("emp-counter").value = num;
    prefillEmpName = "";
    prefillEmpNum  = "";
    loadLevelPreview();
  }
}

function renderRoster() {
  const c = el("roster-list");
  if (!c) return;
  if (!roster.length) {
    c.innerHTML = '<div class="empty">No employees on roster. Add them from the Manager Panel.</div>';
    return;
  }
  c.innerHTML = roster.map(e => `
    <div class="roster-item">
      <div class="roster-row">
        <div style="flex:1;min-width:0;">
          <div class="roster-name">${esc(e.name || "—")}</div>
          ${e.role      ? `<div class="roster-meta">${esc(e.role)}</div>`       : ""}
          ${e.memberNum ? `<div class="roster-meta">#${esc(e.memberNum)}</div>` : ""}
        </div>
        <button class="btn-action btn-action-coach"
          onclick="startCoach('${esc(e.id)}','${esc(e.name)}','${esc(e.memberNum||'')}')">
          &#x1F4CB; Coach
        </button>
      </div>
    </div>
  `).join("");
}

// Pre-fill coaching form and switch to New tab
window.startCoach = function(id, name, memberNum) {
  const sel = el("emp-name");
  if (sel) { sel.value = name; sel.dispatchEvent(new Event("change")); }
  const numEl = el("emp-counter");
  if (numEl) numEl.value = memberNum || "";
  switchTab("new");
  loadLevelPreview();
};

// Toggle inline edit row open/closed
window.toggleRosterEditCoach = function(id) {
  const row = el("ce-row-" + id);
  if (row) row.classList.toggle("open");
};

// Save name / counter # edits — onSnapshot auto-refreshes the list
window.saveCoachEmp = async function(id) {
  const name      = el("ce-name-" + id)?.value.trim();
  const memberNum = el("ce-num-" + id)?.value.trim() || "";
  if (!name) return;
  try {
    await updateDoc(doc(db, "stores", store, "employees", id), { name, memberNum });
    toggleRosterEditCoach(id);
  } catch(e) { alert("Error saving: " + e.message); }
};

window.removeEmployee = async function(id, name) {
  if (!confirm(`Remove ${name} from the roster?\n\nThis only removes them from the name list — their coaching records are not deleted.`)) return;
  try {
    await deleteDoc(doc(db,"stores",store,"employees",id));
    // onSnapshot auto-refreshes roster and dropdown
  } catch(e) { alert("Error removing: " + e.message); }
};

// ── KIOSK QR CODE ─────────────────────────────────────────────
function updateKioskQR() {
  if (!store) return;
  const kioskUrl = location.origin + location.pathname + "?kiosk=" + encodeURIComponent(store);
  const qrSrc    = "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(kioskUrl);
  const img   = el("kiosk-qr-img");
  const urlEl = el("kiosk-qr-url");
  if (img)   img.src = qrSrc;
  if (urlEl) urlEl.textContent = kioskUrl;
}

// ── EMPLOYEE KIOSK ────────────────────────────────────────────
let kioskStoreId = "";

async function loadKiosk(storeId) {
  kioskStoreId = storeId;
  el("topbar-store").style.display = "inline-block";
  el("topbar-store").textContent   = "Store " + storeId;
  try {
    const snap = await getDocs(collection(db,"stores",storeId,"employees"));
    const emps = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    emps.sort((a,b) => a.name.localeCompare(b.name));
    renderKioskRoster(emps);
  } catch(e) {
    el("kiosk-roster").innerHTML = `<div class="empty">Error loading roster: ${esc(e.message)}</div>`;
  }
}

function renderKioskRoster(emps) {
  if (!emps.length) {
    el("kiosk-roster").innerHTML = '<div class="empty">No employees on roster. Please ask your manager to add you.</div>';
    return;
  }
  el("kiosk-roster").innerHTML = emps.map(e => `
    <div class="roster-item" style="cursor:pointer;" onclick="kioskSelectEmp('${esc(e.name)}')">
      <div>
        <div class="roster-name">${esc(e.name)}</div>
        ${e.role ? `<div class="roster-role">${esc(e.role)}</div>` : ""}
        ${e.memberNum ? `<div class="roster-role">#${esc(e.memberNum)}</div>` : ""}
      </div>
      <div style="color:var(--green);font-size:20px;">&#x276F;</div>
    </div>
  `).join("");
}

window.kioskSelectEmp = async function(name) {
  try {
    let managerPhone = "", helpdeskPhone = "";
    const storeSnap = await getDoc(doc(db, "stores", kioskStoreId));
    if (storeSnap.exists()) {
      managerPhone  = storeSnap.data().managerPhone  || "";
      helpdeskPhone = storeSnap.data().helpdeskPhone || "";
    }
    saveSession({ store: kioskStoreId, name, role: "employee", managerPhone, helpdeskPhone });
  } catch(_) {}
  window.location.href = "/coach";
};
