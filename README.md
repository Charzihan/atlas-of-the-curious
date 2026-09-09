# Atlas of the Curious

A hand-curated atlas of 40 extraordinary places on Earth — salt mirrors, sunken
island seas, singing dunes, blue ice caves, and carved cities. A single-page
static site with no runtime network requests. The one library used at runtime
is [`@chenglou/pretext`](https://github.com/chenglou/pretext) (vendored,
same-origin) for reflow-free text measurement in the Text Atlas.

## Run it locally

The project is managed with **fnm** (Node version manager) + **pnpm**
(the pinned Node version lives in `.node-version`):

```sh
pnpm install     # installs @chenglou/pretext and vendors it into vendor/
pnpm start       # zero-dependency static server → http://localhost:8000
```

If you use fnm, it picks up the pinned Node version automatically:

```sh
eval "$(fnm env)"
fnm use          # reads .node-version
```

Any other static file server works too (`python3 -m http.server 8000`), and
opening `index.html` directly from disk also works.

## Rebuilding generated assets

Small build steps run with Node (no bundler):

```sh
pnpm vendor      # copy @chenglou/pretext modules into vendor/pretext/
pnpm build-map   # rasterize world coastlines into js/landmap.js (ASCII grid)
pnpm validate    # check the dataset (unique ids, valid coords, required fields)
pnpm build-pages # generate per-place share pages into places/<id>/
pnpm build       # validate + build-pages (run before deploying)
```

`vendor` and `build-map` are already committed; re-run them only after upgrading
the dependency or changing the map grid settings. Run `pnpm build` after editing
`js/data.js` so the per-place share pages and the dataset stay in sync.

## Features

- **40 places** across 7 categories (geology, coastal, deserts, forests,
  glaciers, sacred sites, urban oddities), each with a story, a field note, a
  best time to visit, and the nearest major city.
- **The Text Atlas**: an ASCII world map — land drawn from real Natural Earth
  coastlines, every marker projected from its own lat/lon, name labels
  word-wrapped by pretext (measured with the browser's own font engine, no
  DOM reflow). Hover a marker for a live field readout; click to open the
  detail dialog. The corresponding grid card lights up on hover.
- **Pan & zoom** the map (buttons, wheel, or drag); markers stay a constant
  on-screen size so you can zoom into the glyph detail.
- **Locate me**: drop a "you are here" marker from your GPS position and label
  the nearest wonder with its distance, then sort the list by distance.
- **Live search** across names, countries, regions, full story text, and the
  new best-time / nearest-city fields.
- **Category filter chips** with per-category counts, plus sorting
  (featured, A–Z, country, distance from me).
- **Shareable filter state**: search, category, and sort live in the URL
  (`?cat=desert&q=salt&sort=name`), so a reload restores the view and links
  carry the filter.
- **Surprise me**: open a random place from the current filter.
- **Detail dialog** with keyboard support (Esc, ←/→ to move between places).
- **Daily pick**: a deterministic-of-the-day place (UTC), the same for every
  visitor on the same calendar day — no server state needed.
- **Shareable URLs, two ways**: `index.html#/place/<id>` deep-links open
  straight into a place's detail view, and `pnpm build-pages` generates a real
  `places/<id>/` page per place (its own title, meta, and Open Graph tags) that
  is indexable and works on any static host with no rewrites.
- **Offline**: a service worker caches the site so it stays usable after the
  first visit; a web-app manifest makes it installable.
- **Performance**: the map animation and ambient ripples pause when the map
  scrolls out of view and resume seamlessly.
- Fully responsive, dark "atlas" theme, no external fonts or images.

## Security

The site is built to be safe even when served from the public web:

- **Strict Content-Security-Policy** in `index.html`:
  `script-src 'self'`, `style-src 'self'`, `object-src 'none'`,
  `base-uri 'self'`, `frame-ancestors 'self'`. No `unsafe-inline`, no
  `unsafe-eval`, no remote origins — so a compromised dependency could not
  exfiltrate data or inject scripts.
- **No HTML string interpolation**: every piece of data is rendered with
  `textContent` / DOM APIs, so malformed data (even user-controllable hash
  fragments) can never inject markup.
- **Hash fragments are validated** against the known place-id set before use.
- **No cookies, no trackers, no analytics, no third-party requests.** The
  only third-party code is `@chenglou/pretext` (MIT), which is **vendored**
  into `vendor/pretext/` and loaded from the same origin — never from a CDN.
- `form-action 'self'` and a `preventDefault()` on the search form mean the
  page never navigates unexpectedly.
- No secrets or user input are ever stored.

## Publishing it to the public web

The site is 100% static, so any static host works. Three easy options:

1. **GitHub Pages** — push this folder to a repo, enable Pages in repo
   settings. Every place deep-link works out of the box (fragment routing).
2. **Netlify / Vercel / Cloudflare Pages** — drag-and-drop this folder (or
   connect the repo). Zero configuration; no `public/` directory or
   build command needed.
3. **Any web server** — copy the folder to `/var/www` (nginx/Apache) and you
   are done.

No environment variables, no build step, nothing to configure.

Two notes before you ship:

- **Run `pnpm build` first.** This validates the dataset and generates the
  per-place share pages in `places/<id>/` (the "Copy link" button points at
  these when they exist; without them it falls back to hash deep-links, which
  also work). Commit the generated `places/` directory so it ships with the
  site (it contains no build timestamps, so diffs stay clean).
- **Skip the large source files.** `data/*.geojson` (≈ 970 KB) are only inputs
  to `pnpm build-map` and are ignored by `.gitignore`; don't upload them to a
  static host. `node_modules/` is ignored too. The service worker is
  same-origin only and never fetches external resources.

## Project layout

```
index.html        — page shell + strict CSP + Open Graph meta
css/style.css     — all styling (no external assets)
css/place.css     — styling for the generated per-place share pages
js/data.js        — the dataset (40 places, 7 categories)
js/landmap.js     — generated ASCII land grid (120×40, from Natural Earth)
js/app.js        — search, filters, URL state, dialog, routing, daily pick,
                    geolocation, distance sort, service-worker registration
js/map.js        — the Text Atlas (character-grid map, uses pretext), pan/zoom,
                    locate-me marker, off-screen pause
js/place.js      — behaviour for the generated per-place share pages
sw.js            — service worker (offline cache)
manifest.webmanifest — web-app manifest (installable)
img/             — icon.svg, og-cover.png (social share image)
places/<id>/     — generated per-place share pages (pnpm build-pages)
vendor/pretext/  — vendored @chenglou/pretext (generated by scripts/vendor.mjs)
scripts/vendor.mjs        — vendors pretext into vendor/
scripts/build-map.mjs     — rasterizes data/world-110m-land.geojson into js/landmap.js
scripts/validate-data.mjs — dataset validation (ids, coords, required fields)
scripts/build-place-pages.mjs — generates the places/<id>/ share pages
data/world-110m-*.geojson — source coastlines (Natural Earth 110m; not deployed)
server.mjs       — zero-dependency dev server (pnpm start)
package.json     — scripts + devDependency (@chenglou/pretext)
.node-version    — pinned Node version for fnm
.gitignore       — ignores node_modules, places/, data/*.geojson, logs
```
