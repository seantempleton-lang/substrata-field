const CACHE = "substrata-v10";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./favicon.svg",
  "./sw.js",
  "./vendor/react.production.min.js",
  "./vendor/react-dom.production.min.js",
  "./vendor/babel.min.js",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_SHELL);
  })());
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(event.request);
        const cache = await caches.open(CACHE);
        cache.put("./index.html", networkResponse.clone());
        return networkResponse;
      } catch (err) {
        const cached = await caches.match("./index.html");
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;

    try {
      const networkResponse = await fetch(event.request);
      const cache = await caches.open(CACHE);
      if (networkResponse.ok || networkResponse.type === "opaque") {
        cache.put(event.request, networkResponse.clone());
      }
      return networkResponse;
    } catch (err) {
      const fallback = await caches.match("./index.html");
      if (event.request.destination === "document" && fallback) return fallback;
      throw err;
    }
  })());
});
