// ── FCM PUSH NOTIFICATION HELPERS ────────────────────────────
// Shared by cc-hub.js (admin), recap.js (manager + employee).
//
// Each page supplies its own saveFn/removeFn callbacks so tokens are
// stored in the correct Firestore path for that user type:
//   Admin    → admin/pushTokens          (arrayUnion/arrayRemove)
//   Manager  → stores/{storeId}          (arrayUnion/arrayRemove on mgrPushTokens)
//   Employee → employees/{empId}         (set/clear pushToken)

import { getApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getMessaging, getToken, onMessage, deleteToken }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const VAPID_KEY = "BNx3MMJSQVNx3DGj4NqkqUvqhGrm7LGy5rtsks9kumKPFesGOaY5FpxNi9qxq-piMVsQYlWk8WueNsHofXOiGcM";

let _messaging = null;

function _getMsg() {
  if (!_messaging) {
    try { _messaging = getMessaging(getApp()); }
    catch(e) { console.warn("FCM: getMessaging failed:", e); }
  }
  return _messaging;
}

/** True if this browser supports Web Push */
export const isPushSupported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Current browser Notification.permission: "default" | "granted" | "denied" */
export const getPushPermission = () =>
  isPushSupported() ? Notification.permission : "denied";

/**
 * Register the FCM service worker, request permission, get FCM token,
 * then call saveFn(token) to persist it.
 *
 * @param {(token: string) => Promise} saveFn  — called with the token to store
 * @returns {"granted"|"denied"|"unsupported"|"error"}
 */
export async function enablePush(saveFn) {
  if (!isPushSupported()) return "unsupported";

  let swReg;
  try {
    swReg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  } catch(e) {
    console.error("FCM: SW register failed:", e);
    return "error";
  }

  const perm = await Notification.requestPermission().catch(() => "denied");
  if (perm !== "granted") return "denied";

  const msg = _getMsg();
  if (!msg) return "error";

  try {
    const token = await getToken(msg, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (!token) return "error";
    await saveFn(token);
    return "granted";
  } catch(e) {
    console.error("FCM: getToken failed:", e);
    return "error";
  }
}

/**
 * Remove the current token via removeFn and invalidate it with FCM.
 * @param {(token: string) => Promise} removeFn  — called with the token to remove
 */
export async function disablePush(removeFn) {
  const msg = _getMsg();
  if (!msg) return;
  try {
    const swReg = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
    const token = swReg
      ? await getToken(msg, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg }).catch(() => null)
      : null;
    if (token) {
      await removeFn(token);
      await deleteToken(msg);
    }
  } catch(e) {
    console.warn("FCM: disablePush error:", e);
  }
}

/**
 * Silently get the current token and call saveFn (idempotent via arrayUnion).
 * Call on every login to handle FCM token rotation (~monthly).
 * @param {(token: string) => Promise} saveFn
 */
export async function refreshToken(saveFn) {
  if (!isPushSupported() || Notification.permission !== "granted") return;
  let swReg;
  try {
    swReg = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js")
         || await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  } catch(e) {
    console.warn("FCM: refreshToken SW error:", e);
    return;
  }
  const msg = _getMsg();
  if (!msg) return;
  try {
    const token = await getToken(msg, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (token) await saveFn(token);
  } catch(e) {
    console.warn("FCM: refreshToken getToken error:", e);
  }
}

/**
 * Listen for foreground FCM messages (tab is open and focused).
 * Returns an unsubscribe function — call on logout to detach.
 * @param {(payload: object) => void} onMsgFn
 * @returns {() => void}
 */
export function subscribeForeground(onMsgFn) {
  const msg = _getMsg();
  if (!msg) return () => {};
  return onMessage(msg, onMsgFn);
}
