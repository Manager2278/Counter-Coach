#!/usr/bin/env node
/**
 * backup-firestore.js
 * Exports every Firestore collection + subcollection to a timestamped JSON
 * file in the project root.
 *
 * One-time setup:
 *   1. Firebase Console → Project Settings → Service Accounts
 *   2. Click "Generate new private key" → save the downloaded file as
 *      functions/serviceAccountKey.json   (already in .gitignore)
 *   3. Run:  node functions/backup-firestore.js
 */

const path = require("path");
const fs   = require("fs");

// ── Credentials ────────────────────────────────────────────────────────────
const KEY_PATH = path.join(__dirname, "serviceAccountKey.json");

if (!fs.existsSync(KEY_PATH)) {
  console.error(`
ERROR: Service account key not found at:
  ${KEY_PATH}

To create one:
  1. Go to https://console.firebase.google.com/project/daily-recap-v1/settings/serviceaccounts/adminsdk
  2. Click "Generate new private key"
  3. Save the downloaded file as:  functions/serviceAccountKey.json
  4. Re-run this script.
`);
  process.exit(1);
}

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore }        = require("firebase-admin/firestore");

initializeApp({ credential: cert(require(KEY_PATH)) });

const db = getFirestore();

// ── Helpers ────────────────────────────────────────────────────────────────

/** Recursively convert Timestamps, GeoPoints, etc. to plain JS values. */
function serialize(value) {
  if (value === null || value === undefined) return value;
  if (typeof value.toDate === "function")   return value.toDate().toISOString();   // Timestamp
  if (typeof value.toJSON === "function")   return value.toJSON();                 // GeoPoint etc.
  if (Array.isArray(value))                 return value.map(serialize);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

/** Export a CollectionReference → plain object keyed by doc ID. */
async function exportCollection(colRef, indent = "  ") {
  const snap = await colRef.get();
  const result = {};

  for (const docSnap of snap.docs) {
    const data = serialize(docSnap.data());

    // Recurse into subcollections
    const subcols = await docSnap.ref.listCollections();
    if (subcols.length > 0) {
      data._subcollections = {};
      for (const sub of subcols) {
        console.log(`${indent}  ↳ ${sub.id}`);
        data._subcollections[sub.id] = await exportCollection(sub, indent + "    ");
      }
    }

    result[docSnap.id] = data;
  }

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("Connecting to Firestore project: daily-recap-v1\n");

  const topLevel   = await db.listCollections();
  const exportedAt = new Date().toISOString();

  const backup = {
    _meta: {
      project:     "daily-recap-v1",
      exportedAt,
      collections: topLevel.map(c => c.id),
    },
  };

  for (const col of topLevel) {
    console.log(`  Exporting collection: ${col.id}`);
    backup[col.id] = await exportCollection(col);
    const count = Object.keys(backup[col.id]).length;
    console.log(`    → ${count} document(s)`);
  }

  // Save next to the project root (one level up from functions/)
  const timestamp = exportedAt.replace(/[:.]/g, "-").slice(0, 19);
  const filename  = `firestore-backup-${timestamp}.json`;
  const outPath   = path.join(__dirname, "..", filename);

  fs.writeFileSync(outPath, JSON.stringify(backup, null, 2), "utf8");

  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);

  console.log(`\n✓ Backup complete`);
  console.log(`  File : ${outPath}`);
  console.log(`  Size : ${sizeMB} MB`);
  console.log(`  Collections: ${backup._meta.collections.join(", ")}`);
}

main().catch(err => {
  console.error("\nBackup failed:", err.message);
  process.exit(1);
});
