/* Atlas of the Curious — service worker
   Caches same-origin static assets so the atlas keeps working after the
   first visit, even fully offline. The site's CSP already forbids any
   non-same-origin requests, so the cache never pulls in third-party code and
   stays small and safe.

   Strategy:
   - Navigations: network-first (fresh content wins), cache as offline fallback.
   - Everything else: cache-first, falling back to network and caching the
     result so repeated visits are instant.
   - Every copy that enters the cache is fetched past the browser's HTTP cache
     (GitHub Pages lets browsers keep files for 10 minutes), so a visit just
     after a deploy cannot pin the previous release's files in the new cache.
   - CORE paths are relative to the worker's scope, so the site works from a
     subpath such as https://<user>.github.io/atlas-of-the-curious/. */
const CACHE = "atlas-of-the-curious-v18";
const CORE = [
  "/",
  "/index.html",
  "/css/style.css",
  "/css/fonts.css",
  "/css/tokens.css",
  "/css/globe.css",
  "/js/views.js",
  "/js/gesture-hint.js",
  "/js/nearest-target.js",
  "/earthxt/redirect.js",
  "/earthxt/",
  "/earthxt/index.html",
  "/earthxt/styles.css",
  "/earthxt/app.js",
  "/earthxt/geometry.js",
  "/earthxt/geography.js",
  "/earthxt/lod.js",
  "/earthxt/renderer.js",
  "/earthxt/ink-palette.js",
  "/earthxt/places.js",
  "/earthxt/place-layer.js",
  "/earthxt/data/world.bin",
  "/earthxt/data/world.json",
  "/css/place.css",
  "/js/data.js",
  "/js/landmap.js",
  "/js/text.js",
  "/js/text-route.js",
  "/js/labels.js",
  "/js/hover-card.js",
  "/js/category-colors.js",
  "/js/sea.js",
  "/js/clouds.js",
  "/js/currents.js",
  "/js/map-art.js",
  "/js/text-worker.js",
  "/js/justify.js",
  "/js/dialog.js",
  "/js/notebook.js",
  "/js/reader.js",
  "/js/app.js",
  "/js/map.js",
  "/js/place.js",
  "/vendor/pretext/layout.js",
  "/vendor/pretext/analysis.js",
  "/vendor/pretext/bidi.js",
  "/vendor/pretext/generated/bidi-data.js",
  "/vendor/pretext/line-break.js",
  "/vendor/pretext/line-text.js",
  "/vendor/pretext/measurement.js",
  "/vendor/pretext/rich-inline.js",
  "/manifest.webmanifest",
  "/img/icon.svg",
  "/img/og-cover.png"
];

// The deployment root: "/" locally, "/atlas-of-the-curious/" on GitHub Pages.
const scope = () => new URL(self.registration ? self.registration.scope : self.location.origin + "/");
const scoped = (path) => new URL(path.replace(/^\//, ""), scope()).href;
const fresh = (url) => new Request(url, { cache: "no-cache" });

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(async (c) => {
        const requests = CORE.map((path) => fresh(scoped(path)));
        try {
          await c.addAll(requests);
        } catch (_) {
          // addAll is atomic: one missing asset (e.g. a generated image not yet
          // built) would fail the whole install. Cache whatever exists instead,
          // so the offline cache still works.
          await Promise.all(requests.map((r) => c.add(r).catch(() => {})));
        }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // cache only idempotent requests
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch external origins

  if (req.mode === "navigate") {
    // Network-first so updated content is served, cache only when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => {
          const path = "/" + url.pathname.slice(scope().pathname.length);
          return caches.match(req).then((hit) => hit || caches.match(scoped(path.startsWith("/earthxt/") ? "/earthxt/index.html" : "/index.html")));
        })
    );
  } else {
    // Cache-first for static assets.
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(fresh(req)).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          })
      )
    );
  }
});
