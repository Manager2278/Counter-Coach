const CACHE_NAME = 'oreillyapp-v3.1'; // 🔁 CHANGE THIS EACH UPDATE

const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./district-dashboard.html"
];

// INSTALL
self.addEventListener("install", event => {
  self.skipWaiting(); // activate immediately
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(FILES_TO_CACHE))
  );
});

// ACTIVATE
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key); // remove old cache
          }
        })
      )
    )
  );
  self.clients.claim();
});

// FETCH (offline-first)
self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});
