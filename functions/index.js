const { onCall, HttpsError }            = require("firebase-functions/v2/https");
const { onDocumentCreated,
        onDocumentUpdated,
        onDocumentDeleted }             = require("firebase-functions/v2/firestore");
const { initializeApp }                 = require("firebase-admin/app");
const { getFirestore, FieldValue }      = require("firebase-admin/firestore");
const { getStorage }                    = require("firebase-admin/storage");
const nodemailer                        = require("nodemailer");

// ── Environment variables ──────────────────────────────────────────────────
// For secrets (API keys etc.), define them with defineSecret and pass via the
// secrets array on the function options. Then access via secret.value().
//
// Example:
//   const { defineSecret } = require("firebase-functions/params");
//   const openAiKey = defineSecret("OPENAI_API_KEY");
//   exports.myFn = onCall({ secrets: [openAiKey] }, async (req) => {
//     const key = openAiKey.value();
//   });
//
// To set a secret:
//   firebase functions:secrets:set OPENAI_API_KEY
// ──────────────────────────────────────────────────────────────────────────

initializeApp();
const db = getFirestore();

/**
 * verifyStorePin
 * Checks a store PIN server-side so raw PINs are never exposed to the client.
 *
 * Request data: { storeId: string, pin: string }
 * Returns:      { success: true }
 */
exports.verifyStorePin = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }

  const { storeId, pin } = request.data;
  if (!storeId || !pin) {
    throw new HttpsError("invalid-argument", "storeId and pin are required.");
  }

  const snap = await db.doc(`stores/${storeId}`).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Store not found.");
  }
  if (snap.data().pin !== pin) {
    throw new HttpsError("unauthenticated", "Incorrect PIN.");
  }

  return { success: true };
});

/**
 * verifyAdminPassword
 * Compares the sha256 hash of the submitted password against the stored hash.
 * Keeps the master password hash off the client.
 *
 * Request data: { passwordHash: string }  (sha256 hex of the raw password)
 * Returns:      { success: true }
 */
exports.verifyAdminPassword = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }

  const { passwordHash } = request.data;
  if (!passwordHash) {
    throw new HttpsError("invalid-argument", "passwordHash is required.");
  }

  const snap = await db.doc("admin/config").get();
  if (!snap.exists || !snap.data().masterPwdHash) {
    throw new HttpsError("not-found", "Admin has not been configured yet.");
  }
  if (snap.data().masterPwdHash !== passwordHash) {
    throw new HttpsError("unauthenticated", "Incorrect password.");
  }

  return { success: true };
});

/**
 * redeemRegCode
 * Atomically validates a registration code and creates the store document
 * in a single Firestore transaction, preventing race-condition double-use.
 *
 * Request data: {
 *   code:           string,
 *   storeId:        string,
 *   pin:            string,
 *   managerName:    string,
 *   managerPhone:   string (optional),
 *   helpdeskPhone:  string (optional),
 * }
 * Returns: { success: true }
 */
exports.redeemRegCode = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }

  const { code, storeId, pin, managerName, managerPhone, helpdeskPhone } = request.data;
  if (!code || !storeId || !pin || !managerName) {
    throw new HttpsError(
      "invalid-argument",
      "code, storeId, pin, and managerName are required."
    );
  }

  const codeKey  = code.trim().toUpperCase();
  const codeRef  = db.doc(`reg_codes/${codeKey}`);
  const storeRef = db.doc(`stores/${storeId}`);

  await db.runTransaction(async (txn) => {
    const codeSnap = await txn.get(codeRef);

    if (!codeSnap.exists) {
      throw new HttpsError("not-found", "Invalid registration code.");
    }

    const cd = codeSnap.data();

    if (cd.used) {
      throw new HttpsError("already-exists", "This registration code has already been used.");
    }
    if (cd.expires && cd.expires.toDate() < new Date()) {
      throw new HttpsError("deadline-exceeded", "This registration code has expired.");
    }
    if (cd.storeNumber && cd.storeNumber !== storeId) {
      throw new HttpsError(
        "failed-precondition",
        `This code is for store ${cd.storeNumber}, not store ${storeId}.`
      );
    }

    txn.update(codeRef, {
      used:        true,
      usedAt:      FieldValue.serverTimestamp(),
      usedByStore: storeId,
    });

    txn.set(storeRef, {
      pin,
      managerName,
      managerPhone:  managerPhone  || "",
      helpdeskPhone: helpdeskPhone || "",
      created:       FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

// ── SHARED SMTP HELPER ────────────────────────────────────────────────────
async function getMailTransport() {
  const snap = await db.doc("admin/mailConfig").get();
  if (!snap.exists) throw new Error("Mail not configured. Add IONOS credentials in CC Hub → Mail Settings.");
  const d = snap.data();
  const { smtpUser, smtpPass } = d;
  if (!smtpUser || !smtpPass) throw new Error("SMTP credentials incomplete in CC Hub → Mail Settings.");
  const host     = d.smtpHost     || "smtp.ionos.com";
  const port     = Number(d.smtpPort) || 587;
  const secure   = d.smtpSecure   || false;   // true = SSL/TLS (465), false = STARTTLS (587)
  const fromName = d.smtpFromName || "Counter Coach";
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure,   // require STARTTLS upgrade on plain connections (port 587)
    auth: { user: smtpUser, pass: smtpPass },
    tls:  { rejectUnauthorized: true }
  });
  return { transport, from: `"${fromName}" <${smtpUser}>` };
}

/**
 * sendEmail
 * Shared helper for sending plain-text emails via SMTP mailConfig.
 */
async function sendEmail(to, subject, body) {
  const { transport, from } = await getMailTransport();
  await transport.sendMail({ from, to, subject, text: body });
}

/**
 * sendCoachingEmail
 * Emails a coaching PDF to the store's configured District Manager address.
 *
 * Request data: { storeId, coachingId, employeeName, date, type, pdfBase64 }
 * Returns: { success: true }
 */
exports.sendCoachingEmail = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const { storeId, coachingId, employeeName, date, type, pdfBase64 } = request.data;
  if (!storeId || !pdfBase64) {
    throw new HttpsError("invalid-argument", "storeId and pdfBase64 are required.");
  }

  const storeSnap = await db.doc(`stores/${storeId}`).get();
  if (!storeSnap.exists) throw new HttpsError("not-found", "Store not found.");
  const dmEmail = storeSnap.data().dmEmail;
  if (!dmEmail) {
    throw new HttpsError(
      "failed-precondition",
      "No DM email set for this store. Add it in ⚙️ Store Setup tab."
    );
  }

  const { transport, from } = await getMailTransport().catch(e => {
    throw new HttpsError("failed-precondition", e.message);
  });

  const fname = `Coaching_${(employeeName||"Employee").replace(/\s+/g,"_")}_${(date||"").replace(/[/:,\s]/g,"")}.pdf`;
  await transport.sendMail({
    from,
    to:      dmEmail,
    subject: `${type||"Coaching"} — ${employeeName} — Store ${storeId}`,
    text:    `A ${type||"Coaching"} record for ${employeeName} was saved on ${date}.\n\nStore: ${storeId}\nRecord ID: ${coachingId}\n\nThe coaching PDF is attached.`,
    attachments: [{
      filename:    fname,
      content:     Buffer.from(pdfBase64, "base64"),
      contentType: "application/pdf"
    }]
  });

  return { success: true };
});

/**
 * sendRecapNotification
 * Sends a real-time notification email when a log entry or message is created.
 * Checks store notification preferences before sending.
 *
 * Request data: { storeId, type ("entry"|"flagged"|"message"), data }
 * Returns: { success: true } or { skipped: true }
 */
exports.sendRecapNotification = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

  const { storeId, type, data } = request.data;
  if (!storeId || !type) {
    throw new HttpsError("invalid-argument", "storeId and type are required.");
  }

  const storeSnap = await db.doc(`stores/${storeId}`).get();
  if (!storeSnap.exists) return { skipped: true };
  const s = storeSnap.data();
  if (!s.recapEmail)                        return { skipped: true };
  if (type === "entry"   && !s.notifyEntry)    return { skipped: true };
  if (type === "flagged" && !s.notifyFlagged)  return { skipped: true };
  if (type === "message" && !s.notifyMessages) return { skipped: true };
  if (type === "done"    && !s.notifyDone)     return { skipped: true };

  const { transport, from } = await getMailTransport().catch(() => ({ transport: null, from: null }));
  if (!transport) return { skipped: true };

  const subjects = {
    entry:   `📝 New Log Entry — Store ${storeId}`,
    flagged: `⚠️ Issue Entry — Store ${storeId}`,
    message: `📬 New Message — Store ${storeId}`,
    done:    `✅ Entry Marked Done — Store ${storeId}`
  };
  const typeLabel = { progress: "Progress", issue: "Issue", note: "Note" };
  const bodies = {
    entry:   `Employee: ${data.author||"?"}\nEntry: ${data.text||""}\nTime: ${new Date(data.time||Date.now()).toLocaleString()}`,
    flagged: `Employee: ${data.author||"?"}\nIssue: ${data.text||""}\nTime: ${new Date(data.time||Date.now()).toLocaleString()}`,
    message: `From: ${data.from||"?"}\nMessage: ${data.text||""}\nTime: ${new Date(data.time||Date.now()).toLocaleString()}`,
    done:    `Entry marked done at Store ${storeId}.\n\nEmployee: ${data.author||"?"}\nType: ${typeLabel[data.type]||data.type||"Entry"}\nEntry: ${data.text||""}\nTime: ${new Date(data.time||Date.now()).toLocaleString()}`
  };

  await transport.sendMail({
    from,
    to:      s.recapEmail,
    subject: subjects[type] || `Counter Coach Notification — Store ${storeId}`,
    text:    bodies[type]   || JSON.stringify(data)
  });

  return { success: true };
});

// ── EMPLOYEE EMAIL TRIGGERS ───────────────────────────────────────────────

/**
 * onEmployeeMessageReplied
 * When a manager replies to an employee's private message, email the employee.
 * Listens on the new subcollection path: stores/{storeId}/messages/{msgId}
 */
exports.onEmployeeMessageReplied = onDocumentUpdated(
  "stores/{storeId}/messages/{msgId}", async event => {
    const before = event.data.before.data() || {};
    const after  = event.data.after.data()  || {};
    // Only fire when a reply is first added (not on subsequent updates)
    if (before.reply || !after.reply) return;

    const storeId = event.params.storeId;
    const empSnap = await db.collection("stores").doc(storeId)
      .collection("employees").where("name", "==", after.from).limit(1).get();
    if (empSnap.empty) return;

    const emp = empSnap.docs[0].data();
    const empEmail = emp.empEmail;
    if (!empEmail) return;
    if (emp.notifyMessages === false) return;

    const replyText = (after.reply?.text || "").slice(0, 200);
    await sendEmail(
      empEmail,
      "Counter Coach — Manager replied to your message",
      `Your manager replied to your message:\n\n"${replyText}"\n\nLog in at countercoach.app to view the full reply.`
    ).catch(e => console.error("onEmployeeMessageReplied email error:", e));
  }
);

/**
 * onEmployeeEntryCreated
 * When a log entry is created, email any employee at that store
 * who has notifyEntries:true and empEmail set.
 * Listens on: stores/{storeId}/entries/{entryId}
 */
exports.onEmployeeEntryCreated = onDocumentCreated(
  "stores/{storeId}/entries/{entryId}", async event => {
    const d       = event.data?.data() || {};
    const storeId = event.params.storeId;
    if (!storeId) return;

    const empSnap = await db.collection("stores").doc(storeId)
      .collection("employees").get();
    if (empSnap.empty) return;

    const typeEmoji  = { progress: "📈", issue: "⚠️", note: "📝" };
    const typeLabel  = { progress: "Progress", issue: "Issue/Flag", note: "Note" };
    const entryType  = d.type || "progress";
    const subject    = `${typeEmoji[entryType] || "📋"} New Log Entry — Store ${storeId}`;
    const body       = `A new ${typeLabel[entryType] || entryType} entry was added by ${d.author || "an employee"} at Store ${storeId}.\n\n"${(d.text || "").slice(0, 300)}"\n\nLog in at countercoach.app to view the full logbook.`;

    const sends = [];
    empSnap.docs.forEach(empDoc => {
      const emp = empDoc.data();
      // Skip the author themselves, and only send if opted in
      if (!emp.empEmail)            return;
      if (emp.notifyEntries === false) return;
      if (emp.name === d.author)    return;
      sends.push(sendEmail(emp.empEmail, subject, body).catch(e =>
        console.error("onEmployeeEntryCreated email error:", e)
      ));
    });
    await Promise.all(sends);
  }
);

/**
 * onEntryMarkedDone
 * When a log entry is marked complete (status → "complete"), email the author
 * if they have empEmail set and notifyDone is not false.
 * Listens on: stores/{storeId}/entries/{entryId}
 */
exports.onEntryMarkedDone = onDocumentUpdated(
  "stores/{storeId}/entries/{entryId}", async event => {
    const before = event.data.before.data() || {};
    const after  = event.data.after.data()  || {};
    // Only fire when status first changes to "complete"
    if (before.status === "complete" || after.status !== "complete") return;

    const storeId = event.params.storeId;
    const author  = after.author;
    if (!author || !storeId) return;

    const empSnap = await db.collection("stores").doc(storeId)
      .collection("employees").where("name", "==", author).limit(1).get();
    if (empSnap.empty) return;

    const emp = empSnap.docs[0].data();
    if (!emp.empEmail)            return;
    if (emp.notifyDone === false)  return;

    const typeLabel = { progress: "Progress", issue: "Issue/Flag", note: "Note" };
    const label     = typeLabel[after.type] || after.type || "Log";
    const preview   = (after.text || "").slice(0, 300);
    await sendEmail(
      emp.empEmail,
      `✅ Your entry was marked done — Store ${storeId}`,
      `Your ${label} entry has been marked complete by a manager at Store ${storeId}.\n\n"${preview}"\n\nLog in at countercoach.app to view your logbook.`
    ).catch(e => console.error("onEntryMarkedDone email error:", e));
  }
);

/**
 * onEmployeeCoachingCreated
 * When a coaching record is created, email the named employee.
 * Listens on the new subcollection path: stores/{storeId}/coaching/{coachId}
 */
exports.onEmployeeCoachingCreated = onDocumentCreated(
  "stores/{storeId}/coaching/{coachId}", async event => {
    const d       = event.data?.data() || {};
    const storeId = event.params.storeId;
    if (!d.name || !storeId) return;

    const empSnap = await db.collection("stores").doc(storeId)
      .collection("employees").where("name", "==", d.name).limit(1).get();
    if (empSnap.empty) return;

    const emp = empSnap.docs[0].data();
    const empEmail = emp.empEmail;
    if (!empEmail) return;
    if (emp.notifyCoaching === false) return;

    const typeLabel = {
      verbal: "Verbal", written: "Written", final: "Final Written",
      pip: "PIP", termination: "Termination"
    };
    const label = typeLabel[d.type] || d.type || "Coaching";
    await sendEmail(
      empEmail,
      "Counter Coach — Coaching Record",
      `A ${label} coaching document has been created for you at Store ${storeId}.\n\nPlease log in at countercoach.app to review and sign the document.`
    ).catch(e => console.error("onEmployeeCoachingCreated email error:", e));
  }
);

// ── STORAGE CLEANUP ────────────────────────────────────────────

/**
 * Extract a Firebase Storage object path from a download URL.
 * URL format: https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encoded-path}?...
 */
function storagePathFromUrl(url) {
  try {
    const match = decodeURIComponent(new URL(url).pathname).match(/\/o\/(.+)$/);
    return match ? match[1] : null;
  } catch (_) { return null; }
}

/**
 * onEntryDeleted
 * When a log entry is deleted (from any client — cc-hub, recap, etc.),
 * delete all associated photos from Firebase Storage so the bucket
 * doesn't accumulate orphaned images.
 *
 * Listens on: stores/{storeId}/entries/{entryId}
 */
exports.onEntryDeleted = onDocumentDeleted(
  "stores/{storeId}/entries/{entryId}", async event => {
    const data = event.data?.data() || {};
    // Collect all photo URLs — prefer the photos array, fall back to legacy photoURL
    const urls = (data.photos && data.photos.length)
      ? data.photos
      : data.photoURL ? [data.photoURL] : [];

    if (!urls.length) return;   // no photos attached — nothing to clean up

    const bucket = getStorage().bucket();
    await Promise.all(urls.map(async url => {
      const path = storagePathFromUrl(url);
      if (!path) return;
      try {
        await bucket.file(path).delete();
        console.log("Deleted storage file:", path);
      } catch (e) {
        // 404 = file already gone — not an error worth logging loudly
        if (e.code !== 404) console.error("onEntryDeleted storage delete error:", path, e.message);
      }
    }));
  }
);
