// ── FIREBASE SHARED INIT ──────────────────────────────────────
// Single source of truth for Firebase config and service instances.
// All page modules import from here instead of duplicating the config.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore }  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth }       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getStorage }    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import { getFunctions }  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const cfg = {
  apiKey:            "AIzaSyC50q5eXaWnLykZHOuZOVOo_r6nK4kSno8",
  authDomain:        "daily-recap-v1.firebaseapp.com",
  projectId:         "daily-recap-v1",
  storageBucket:     "daily-recap-v1.firebasestorage.app",
  messagingSenderId: "476802421766",
  appId:             "1:476802421766:web:171eccca066feb711bdf87"
};

const app = initializeApp(cfg);

export const db        = getFirestore(app);
export const auth      = getAuth(app);
export const storage   = getStorage(app);
export const functions = getFunctions(app);
