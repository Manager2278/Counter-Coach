const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp }     = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const nodemailer             = require("nodemailer");

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
  const port     = d.smtpPort     || 587;
  const secure   = d.smtpSecure   || false;
  const fromName = d.smtpFromName || "Counter Coach";
  const transport = nodemailer.createTransport({
    host,
    port,
    secure, // true = SSL/TLS (465), false = STARTTLS (587)
    auth: { user: smtpUser, pass: smtpPass }
  });
  return { transport, from: `"${fromName}" <${smtpUser}>` };
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

  const { transport, from } = await getMailTransport().catch(() => ({ transport: null, from: null }));
  if (!transport) return { skipped: true };

  const subjects = {
    entry:   `📝 New Log Entry — Store ${storeId}`,
    flagged: `⚠️ Issue Entry — Store ${storeId}`,
    message: `📬 New Message — Store ${storeId}`
  };
  const bodies = {
    entry:   `Employee: ${data.author||"?"}\nEntry: ${data.text||""}\nTime: ${new Date(data.time||Date.now()).toLocaleString()}`,
    flagged: `Employee: ${data.author||"?"}\nIssue: ${data.text||""}\nTime: ${new Date(data.time||Date.now()).toLocaleString()}`,
    message: `From: ${data.from||"?"}\nMessage: ${data.text||""}\nTime: ${new Date(data.time||Date.now()).toLocaleString()}`
  };

  await transport.sendMail({
    from,
    to:      s.recapEmail,
    subject: subjects[type] || `Counter Coach Notification — Store ${storeId}`,
    text:    bodies[type]   || JSON.stringify(data)
  });

  return { success: true };
});
