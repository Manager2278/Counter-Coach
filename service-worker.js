const CACHE_NAME = "counter-coach-v2";

const urlsToCache = [
  "./",
  "./index.html",
  "./manifest.json"
];

self.addEventListener("install", event => {
  self.skipWaiting(); // 🔥 activate immediately
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

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

  // 🔥 FORCE ALL OPEN TABS TO RELOAD
  self.clients.matchAll({ type: "window" }).then(clients => {
    clients.forEach(client => {
      client.navigate(client.url);
    });
  });
});

self.addEventListener("fetch", event => {
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
