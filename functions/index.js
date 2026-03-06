const { onCall, HttpsError }            = require("firebase-functions/v2/https");
const { onDocumentCreated,
        onDocumentUpdated }             = require("firebase-functions/v2/firestore");
const { initializeApp }                 = require("firebase-admin/app");
const { getFirestore, FieldValue }      = require("firebase-admin/firestore");
const { getMessaging }                  = require("firebase-admin/messaging");
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
 * Also notifies admin via push if the redemption fails.
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

  try {
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

  } catch(e) {
    // Notify admin via push about the failed setup attempt
    sendPushToAdmin(
      `❌ Store Setup Failed — Store ${storeId}`,
      e.message || "Registration code redemption failed",
      "codes"
    ).catch(() => {}); // fire-and-forget; don't block the error response
    throw e; // re-throw so client receives the proper error
  }
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

// ── SHARED FCM PUSH HELPERS ───────────────────────────────────────────────

/**
 * sendPushToAdmin
 * Reads FCM tokens from admin/pushTokens and sends a multicast push.
 * Automatically prunes stale/unregistered tokens.
 */
async function sendPushToAdmin(title, body, tab = "messages") {
  const snap = await db.doc("admin/pushTokens").get();
  if (!snap.exists) return;
  const tokens = (snap.data().tokens || []).filter(Boolean);
  if (!tokens.length) return;

  const url  = "/hub?tab=" + tab;
  const resp = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { title, body, tab, url, tag: "admin-" + tab }
  });

  // Prune stale tokens automatically
  const stale = resp.responses
    .map((r, i) => (!r.success && (
      r.error?.code === "messaging/registration-token-not-registered" ||
      r.error?.code === "messaging/invalid-registration-token"
    )) ? tokens[i] : null)
    .filter(Boolean);
  if (stale.length) {
    await db.doc("admin/pushTokens").update({ tokens: FieldValue.arrayRemove(...stale) });
  }
}

/**
 * sendPushToStore
 * Sends push to all FCM tokens stored in stores/{storeId}.mgrPushTokens.
 * Automatically prunes stale tokens.
 */
async function sendPushToStore(storeId, title, body, tab = "log") {
  const snap = await db.doc(`stores/${storeId}`).get();
  if (!snap.exists) return;
  const tokens = (snap.data().mgrPushTokens || []).filter(Boolean);
  if (!tokens.length) return;

  const resp = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { title, body, tab, url: "/recap", tag: "mgr-" + tab }
  });

  const stale = resp.responses
    .map((r, i) => (!r.success && (
      r.error?.code === "messaging/registration-token-not-registered" ||
      r.error?.code === "messaging/invalid-registration-token"
    )) ? tokens[i] : null)
    .filter(Boolean);
  if (stale.length) {
    await db.doc(`stores/${storeId}`).update({ mgrPushTokens: FieldValue.arrayRemove(...stale) });
  }
}

/**
 * sendPushToEmployee
 * Sends push to a single employee FCM token.
 * Clears stale tokens from their Firestore document automatically.
 */
async function sendPushToEmployee(pushToken, title, body) {
  if (!pushToken) return;
  try {
    await getMessaging().send({
      token: pushToken,
      notification: { title, body },
      data: { title, body, url: "/recap", tag: "emp-notif" }
    });
  } catch(e) {
    if (
      e.code === "messaging/registration-token-not-registered" ||
      e.code === "messaging/invalid-registration-token"
    ) {
      // Find the employee document with this stale token and clear it
      const snap = await db.collection("employees")
        .where("pushToken", "==", pushToken).limit(1).get();
      if (!snap.empty) await snap.docs[0].ref.update({ pushToken: "" });
    }
  }
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

// ── FCM PUSH TRIGGERS ─────────────────────────────────────────────────────

/**
 * onNewFeedback
 * Pushes admin when a manager submits new feedback.
 */
exports.onNewFeedback = onDocumentCreated("feedback/{id}", async event => {
  const d     = event.data?.data() || {};
  const label = d.type === "bug" ? "Bug Report" : d.type === "idea" ? "Idea" : "Feedback";
  const text  = (d.text || "").slice(0, 80) + ((d.text || "").length > 80 ? "…" : "");
  await sendPushToAdmin(
    `💬 New ${label} — Store ${d.store || "?"}`,
    `${d.from || "Manager"}: ${text}`,
    "feedback"
  );
});

/**
 * onStoreCreated
 * Pushes admin when a new store is registered, flagging any incomplete fields.
 */
exports.onStoreCreated = onDocumentCreated("stores/{storeId}", async event => {
  const d       = event.data?.data() || {};
  const storeId = event.params.storeId;
  const missing = [];
  if (!d.managerName)   missing.push("Manager Name");
  if (!d.pin)           missing.push("PIN");
  if (!d.helpdeskPhone) missing.push("Helpdesk Phone");
  if (missing.length) {
    await sendPushToAdmin(
      `⚠️ Incomplete Setup — Store ${storeId}`,
      `Missing: ${missing.join(", ")}. Store registered but setup may be incomplete.`,
      "stores"
    );
  }
});

/**
 * onNewEntry
 * Pushes to the store manager (if preference allows) and to any employees
 * who have opted into log entry notifications at that store.
 */
exports.onNewEntry = onDocumentCreated("entries/{id}", async event => {
  const d = event.data?.data() || {};
  if (!d.store) return;

  const emoji = d.type === "issue" ? "⚠️" : d.type === "progress" ? "📈" : "📝";
  const text  = (d.text || "").slice(0, 80) + ((d.text || "").length > 80 ? "…" : "");
  const title = `${emoji} New Entry — Store ${d.store}`;
  const body  = `${d.author || "Employee"}: ${text}`;

  // Push to store manager (check preference)
  const storeSnap = await db.doc(`stores/${d.store}`).get();
  if (storeSnap.exists && storeSnap.data().pushNotifyEntries !== false) {
    await sendPushToStore(d.store, title, body, "log");
  }

  // Push to employees who opted into log notifications at this store
  const empSnap = await db.collection("employees")
    .where("store", "==", d.store)
    .where("empPushNotifyEntries", "==", true)
    .get();
  const empTokens = empSnap.docs
    .map(doc => doc.data().pushToken)
    .filter(t => !!t); // skip empty/null tokens
  if (empTokens.length) {
    await getMessaging().sendEachForMulticast({
      tokens: empTokens,
      notification: { title, body },
      data: { title, body, url: "/recap", tag: "emp-entry" }
    });
  }
});

/**
 * onNewMessage
 * Pushes to admin (overview) and to the store manager (if preference allows).
 */
exports.onNewMessage = onDocumentCreated("messages/{id}", async event => {
  const d    = event.data?.data() || {};
  if (!d.store) return;
  const text = (d.text || "").slice(0, 80) + ((d.text || "").length > 80 ? "…" : "");

  // Always push to admin
  await sendPushToAdmin(
    `📬 New Message — Store ${d.store}`,
    `${d.from || "Employee"}: ${text}`,
    "messages"
  );

  // Push to store manager (check preference)
  const storeSnap = await db.doc(`stores/${d.store}`).get();
  if (storeSnap.exists && storeSnap.data().pushNotifyMessages !== false) {
    await sendPushToStore(
      d.store,
      `📬 New Message`,
      `${d.from || "Employee"}: ${text}`,
      "msg"
    );
  }
});

/**
 * onMessageReplied
 * Pushes to the employee when a manager replies to their private message.
 */
exports.onMessageReplied = onDocumentUpdated("messages/{id}", async event => {
  const before = event.data.before.data() || {};
  const after  = event.data.after.data()  || {};
  // Only fire when a reply is first added (not on subsequent updates)
  if (before.reply || !after.reply) return;

  const employeeName = after.from;
  const storeId      = after.store;
  if (!employeeName || !storeId) return;

  const empSnap = await db.collection("employees")
    .where("store", "==", storeId)
    .where("name",  "==", employeeName)
    .limit(1).get();
  if (empSnap.empty) return;

  const pushToken = empSnap.docs[0].data().pushToken;
  const replyText = (after.reply?.text || "").slice(0, 80);
  await sendPushToEmployee(
    pushToken,
    `💬 Manager replied to your message`,
    `${after.reply?.from || "Manager"}: ${replyText}`
  );
});

/**
 * onNewCoaching
 * Pushes to the employee named in a newly created coaching record.
 */
exports.onNewCoaching = onDocumentCreated("coaching/{id}", async event => {
  const d       = event.data?.data() || {};
  const empName = d.name;
  const storeId = d.store;
  if (!empName || !storeId) return;

  const empSnap = await db.collection("employees")
    .where("store", "==", storeId)
    .where("name",  "==", empName)
    .limit(1).get();
  if (empSnap.empty) return;

  const pushToken = empSnap.docs[0].data().pushToken;
  const typeLabel = {
    verbal: "Verbal", written: "Written", final: "Final Written",
    pip: "PIP", termination: "Termination"
  };
  await sendPushToEmployee(
    pushToken,
    `📋 Coaching Record`,
    `A ${typeLabel[d.type] || d.type || "coaching"} document has been created for you.`
  );
});
