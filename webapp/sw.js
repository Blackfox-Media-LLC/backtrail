// Backtrail service worker — cache the app shell so it works offline
// (the whole point: usable with no internet, in the field).
const CACHE = "backtrail-v13";
const SHELL = [
  "./index.html", "./styles.css", "./app.js", "./ble.js", "./gt.js",
  "./manifest.webmanifest", "./assets/icon-192.png", "./assets/icon-512.png",
  "./assets/backtrail-hero.jpg", "./assets/fox-mark.png",
  "./mesh.js", "./native-ble.js", "./store.js", "./geo.js", "./notify.js", "./qr.js", "./map.js",
  "./vendor/meshtastic.js", "./vendor/native.js", "./vendor/libs.js", "./vendor/leaflet.css",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return; // map tiles etc. go straight to the network
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => hit))
  );
});
