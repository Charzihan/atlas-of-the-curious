# Globe · Atlas of the Curious

The spherical view of Atlas of the Curious, built on the atlas’s shared text foundation and colour palette: a client-side, text-native globe with mathematical 3D projection, real offline geography, mouse/touch rotation, smooth zoom, three geographic detail levels, and live performance instrumentation.

Run from the repository root:

```sh
npm start
# Open http://localhost:8000/earthxt/
```

The atlas remains available at `/`. Its header links to **Globe**, and the globe’s **✦ Atlas of the Curious** brand link returns to the atlas. The globe shares the atlas’s CSS font registry, text metrics module, and vendored `@chenglou/pretext` measurement library. It uses no external fonts, map services, API keys, or backend. The development server is only a static file server.

If localhost is unavailable, generate the standalone edition:

```sh
npm run build:earthxt-standalone
```

Open `earthxt-standalone.html` from the repository root directly in your browser (or drag it into a browser window). This single file embeds the same app, shared font registry and colour tokens, vendored pretext modules, styles, and geographic data, with no HTTP server or network connection required. The generated file is ignored by Git and can be regenerated at any time. Its content security policy permits only its own hashed script/styles and embedded data. The brand link opens the adjacent atlas `index.html` when the file stays in the repository root; the atlas itself is not embedded.

## Interaction

- Drag with a mouse or one finger to rotate. A drag pauses automatic rotation.
- Scroll, pinch, use +/−, or move the orbit/surface slider to zoom.
- Choose Planet, Coastlines, or Countries to move to a representative distance. Detail also changes automatically as the camera moves.
- Focus the globe and use arrow keys to rotate, +/− to zoom, 0 to reset, Space to toggle rotation, and D for diagnostics.
- Country labels appear at country detail and can be disabled. The optional coordinate grid is also made of glyphs.
- Earth/Synthetic switches between real and invented geography using the same projection and display path.
- Reduced-motion preferences disable automatic rotation, ocean animation, and zoom interpolation by default. Rotation can still be explicitly enabled. Hidden tabs suspend the frame loop.

## Architecture

| Module | Responsibility |
| --- | --- |
| `geometry.js` | Unit sphere, lat/lon conversion, camera basis, perspective projection, visibility, near ray/sphere intersection, logarithmic zoom |
| `geography.js` | Load and validate local country grids; classify land/ocean, coasts, and borders; provide label anchors; synthetic provider |
| `lod.js` | Extensible ordered detail registry, thresholds, glyph choices, and hysteresis |
| `renderer.js` | Screen-space sampling, glyph selection, Canvas 2D text, cached pretext country-name measurement, DOM label projection and collision checks |
| `../css/tokens.css` | Shared ground, ink, accent, panel, and line colours, preserving the atlas palette |
| `../css/fonts.css` | Single font family and role registry for atlas and globe; `globe-label` controls country-name font, line height, and spacing |
| `../js/text.js` | Read computed font roles and families for the renderer, without starting atlas boot code on the globe page |
| `../vendor/pretext/` | Shared text preparation and natural-width measurement kernel |
| `app.js` | Resolve registry fonts, prepare country names before animation, input, camera interpolation, lifecycle, controls, accessible status, diagnostics |

No conventional sphere, texture, raster map, or WebGL scene is drawn. The globe surface consists exclusively of `CanvasRenderingContext2D.fillText` glyphs. Country labels are uppercase DOM text set with the `globe-label` role. Names are prepared once per font and letter spacing after geography loads; frames reuse cached handles and widths. The vendored `measureNaturalWidth` includes terminal CSS letter spacing, so the renderer adds only the existing padding and borders. The older comment/addition in atlas `js/labels.js` assumes terminal spacing is excluded and merits a separate measurement review. Per-LOD glyph sizes remain in `lod.js`; their family comes from `--font-mono`. Canvas is a display adapter; the sphere mathematics and geography do not depend on it or on Three.js.

For the surface, the renderer casts one ray per screen character cell into the sphere and uses the **near intersection** to recover geographic coordinates. This inverse projection keeps cost proportional to viewport size, capped at 24,000 candidate glyph cells, and cannot include hidden far-side points. Geographic label anchors follow the forward pipeline: lat/lon → sphere coordinates → camera basis → perspective projection → horizon test → screen text. The horizon test is `cameraDistance × cameraSpaceZ > 1`, not simply a positive Z test.

A logarithmic slider maps to camera distances of 4.6–1.16 Earth radii. Wheel and pinch input change the same target distance; exponential interpolation approaches it independently of frame rate. LOD thresholds follow camera distance, with a small dead band when zooming out to prevent flicker. Camera motion is smooth; raster detail changes at the thresholds, without a crossfade. The closest view remains at geographic/country scale (about 1,019 km altitude).

## Local data and budget

The checked-in [data files](data/README.md) include 177 Natural Earth country features rasterized at 1.5°, 0.5°, and 0.25° spacing, with names and label anchors. Coasts and borders are derived from neighboring ownership cells. Data are public domain. All three grids and metadata total approximately **38 KB with gzip**, or **1.29 MiB decoded**. Production transfer sizes depend on host compression. There are no runtime data downloads beyond these same-origin static files.

The budget is **10 MB compressed for initial geography**; `build:earthxt-data` enforces it. `npm run build:earthxt-data` regenerates the checked-in files from the original GeoJSON when that optional source file is available. Normal builds use the checked-in results.

All levels derive from the same simplified 1:110m source: higher detail improves raster resolution, not the source's geographic accuracy. Small islands and inland waters can be absent. Borders follow the source dataset. These data are deliberately unsuitable for street-level navigation.

To extend the hierarchy, add a detail entry in `lod.js` and corresponding provider data, then expose any desired preset in the controls. Geographic providers implement `sample(latitude, longitude, level, result)` and `labels()`. A future static chunk loader can populate provider caches and invalidate rendering as chunks arrive; this MVP loads the small global payload once. Streets, buildings, search, routing, POIs, accounts, and live services are not implemented.

## Performance and failure handling

The footer shows rendered FPS, visible glyphs, altitude, and resident geographic bytes. Diagnostics add candidate screen cells, current LOD, camera distance, projection plus geographic lookup time, text plus label submission time, visible labels, and JS heap usage when the browser exposes it. Timings are CPU submission measurements; they do not measure compositor/GPU completion. FPS counts actual rendered frames, so a paused view can correctly show 0–2 FPS while it redraws only for occasional ocean changes. Metrics update every 600 ms.

The renderer uses fixed typed buffers, caps pixel ratio at 2, batches text by color, and hides the far side by construction. Country labels are culled at the horizon and viewport edges, then filtered for overlap. The label layer is decorative to assistive technology; an accessible globe description reports the current position and detail, with keyboard controls and native buttons as alternatives to pointer gestures.

If geography fails to load, a visible explanation appears and the globe remains usable in synthetic mode. Reload retries Earth data. The app does not need an internet connection after its local files have loaded. The atlas service worker precaches the globe and shared dependencies and uses the globe entry for offline `/earthxt/` navigations once the atlas worker is installed. A separate static deployment does not install a dedicated worker; use the standalone edition for guaranteed server-free reopening.

## Build and static deployment

```sh
npm run build:earthxt
```

The build walks the runtime graph from `earthxt/app.js` and `earthxt/index.html`: static module imports, `new URL(..., import.meta.url)` resources, stylesheet links, and CSS imports. It copies every reachable file into `dist/` with repository-relative paths preserved, plus data attribution and `.nojekyll`. The file count and byte budget are calculated from that graph and printed on each build; tests derive their expected assets from the same graph and exercise an independent import-chain fixture.

Publish **the entire `dist/` directory**, then open `earthxt/` beneath the host root or project path (for example `/project/earthxt/`). The sibling `js/`, `vendor/pretext/`, and `css/` directories must remain beside `earthxt/` so its `../` imports resolve. All runtime references are relative and stay within the publish root. No special routes, runtime install, environment variables, or server code are required. The current graph is approximately **100 KiB with gzip** (1.52 MiB raw); host compression determines transfer size.

For GitHub Pages from a branch, the repository's existing static root exposes `/earthxt/` directly. For a separate static deployment, use `dist/` as the publish directory. Enable gzip/Brotli if available. No public deployment is automatically triggered by building.

The globe-only `dist/` graph does not copy the atlas page: the brand link needs an atlas at the publish root. Deploy the combined repository site for navigation between both views.

`scripts/earthxt/graph.mjs` is shared by both packagers. The standalone packager uses a scoped module registry supporting this graph's multiline named imports, trailing commas, parent-relative paths, and exported function/async function/class/const declarations. Modules are emitted in dependency order; unsupported module syntax and cycles fail loudly. It embeds geographic data as data URLs and expands the stylesheet chain in cascade order, including the shared registry. Vendored pretext is inlined too. The standalone CSP permits only the generated script/style hashes and embedded data, with no `eval` or network access.

## Validation

```sh
npm run test:earthxt        # Geometry, real data, renderer, and packaging checks
npm run build:earthxt
npm run smoke:earthxt       # Real Chromium; requires Playwright + installed browser
npm run build
node scripts/earthxt/smoke-nav.mjs # Both views at the combined repository root
```

The unit checks cover spherical projection round trips, perspective occlusion, pole/dateline handling, zoom endpoints, LOD hysteresis, known geographic locations, dataset integrity and budget, progressively finer coasts, synthetic data, glyph silhouettes, rotation, draw-count bounds, country-label culling/collisions, shared registry roles, absence of JavaScript font-family literals, cached measurement outside frames, graph-based static paths, service-worker coverage/fallbacks, and executable standalone pretext/registry/data loading.

The browser suite exercises the **built output under `/dist/earthxt/`**, drag and wheel input, all LODs, country labels, source modes, zoom limits, keyboard controls, dialog focus restoration, reduced motion, mobile width, actual touch drag/pinch/cancellation, and data-loading failure. It rejects unexpected external requests and browser errors and saves captures to `test-results/earthxt/`. It fails rather than silently skipping if Chromium or local sockets cannot run. A full browser performance evaluation still needs representative desktop and mobile devices.

`nav.test.mjs` checks source markup, unchanged atlas palette values, shared stylesheet loading and packaging, standalone identity, and cache coverage. It does not prove browser rendering. `smoke-nav.mjs` checks the actual header links in both directions at desktop and mobile sizes, keyboard activation of the brand link, shared computed tokens, rendered views, and absence of console/page errors.
