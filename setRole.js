const admin = require("firebase-admin");

// 🔥 Download this from Firebase Console:
// Project Settings → Service Accounts → Generate key
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// 🔥 CHANGE THIS EMAIL TO YOUR STORE
const email = "store1234@countercoach.com";

async function setRole() {

  const user = await admin.auth().getUserByEmail(email);

  await admin.auth().setCustomUserClaims(user.uid, {
    role: "manager",
    storeNumber: "1234"
  });

  console.log("Role assigned!");
}

setRole();
