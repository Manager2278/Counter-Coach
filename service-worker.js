<meta name='viewport' content='width=device-width, initial-scale=1'/>self.addEventListener("install", e => {
  e.waitUntil(
    caches.open("manager-tool-v3").then(cache => {
      return cache.addAll([
        "./",
        "./index.html",
        "./manifest.json"
      ]);
    })
  );
});

self.addEventListener("fetch", e => {
  e.respondWith(
    caches.match(e.request).then(response => {
      return response || fetch(e.request);
    })
  );
});