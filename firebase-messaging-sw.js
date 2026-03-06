// ── FCM Background Message Handler ───────────────────────────
// Counter Coach push notifications service worker.
// Must use importScripts (compat SDK) — ES modules not supported in SWs.

importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey:            "AIzaSyC50q5eXaWnLykZHOuZOVOo_r6nK4kSno8",
  authDomain:        "daily-recap-v1.firebaseapp.com",
  projectId:         "daily-recap-v1",
  storageBucket:     "daily-recap-v1.firebasestorage.app",
  messagingSenderId: "476802421766",
  appId:             "1:476802421766:web:171eccca066feb711bdf87"
});

const messaging = firebase.messaging();

// Handle background messages (tab closed or not focused)
messaging.onBackgroundMessage(payload => {
  const notif = payload.notification || {};
  const data  = payload.data         || {};
  return self.registration.showNotification(
    notif.title || data.title || "Counter Coach",
    {
      body:     notif.body || data.body || "",
      icon:     "/icon-192.png",
      badge:    "/icon-192.png",
      tag:      data.tag   || "cc-notif",  // collapses duplicate same-type notifications
      renotify: true,
      data:     data
    }
  );
});

// Notification click → navigate to the correct page/tab
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const d   = event.notification.data || {};
  const url = d.url || "/hub";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      // Focus existing tab if already open
      for (const c of list) {
        const pathname = new URL(c.url).pathname;
        if (pathname === url || pathname === url + ".html") {
          c.focus();
          return c.navigate(url);
        }
      }
      // Otherwise open a new tab
      return clients.openWindow(url);
    })
  );
});
