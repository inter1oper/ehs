/* Minimal app-shell service worker.
 * Caches the static shell so the PWA opens instantly and works briefly
 * offline; CSV menu data is always re-fetched (network-first).
 */
const CACHE = "mealmenu-shell-v5";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Network-first for live menu data and Wikipedia thumbnails.
  if (
    url.hostname.endsWith("docs.google.com") ||
    url.hostname.endsWith("wikipedia.org") ||
    url.hostname.endsWith("wikimedia.org")
  ) {
    event.respondWith(
      fetch(req)
        .then((res) => res)
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Cache-first for the app shell.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req)
          .then((res) => {
            if (res && res.ok && url.origin === self.location.origin) {
              const clone = res.clone();
              caches.open(CACHE).then((c) => c.put(req, clone));
            }
            return res;
          })
          .catch(() => cached),
    ),
  );
});
