const CACHE_NAME = "counter-coach-v1";

// Files to cache (add more if needed)
const urlsToCache = [
  "./",
  "./index.html",
  "./manifest.json"
];

// Install → cache files
self.addEventListener("install", event => {
  self.skipWaiting(); // 🔥 activate immediately
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

// Activate → clear old caches
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim(); // 🔥 take control immediately
});

// Fetch → always try network first (auto update)
self.addEventListener("fetch", event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Update cache with fresh version
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)) // fallback offline
  );
});
