const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp }     = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

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
