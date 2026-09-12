# Earthxt — the atlas globe view

The globe view of Atlas of the Curious: a client-side, text-native globe with mathematical 3D projection, real offline geography, mouse/touch rotation, smooth zoom, three geographic detail levels, and live performance instrumentation.

Run from the repository root:

```sh
npm start
# Open http://localhost:8000/earthxt/
```

The existing Atlas of the Curious remains available at `/`. Its header links to Earthxt. Earthxt shares the atlas’s CSS font registry, text metrics module, and vendored `@chenglou/pretext` measurement library. It uses no external fonts, map services, API keys, or backend. The development server is only a static file server.

If localhost is unavailable, generate the standalone edition:

```sh
npm run build:earthxt-standalone
```

Open `earthxt-standalone.html` from the repository root directly in your browser (or drag it into a browser window). This single file embeds the same app, shared font registry, vendored pretext modules, styles, and geographic data, with no HTTP server or network connection required. The generated file is ignored by Git and can be regenerated at any time. Its content security policy permits only its own hashed script/styles and embedded data.

## Interaction

- Drag with a mouse or one finger to rotate. A drag pauses automatic rotation.
- Scroll, pinch, use +/−, or move the orbit/surface slider to zoom.
- Choose Planet, Coastlines, or Countries to move to a representative distance. Detail also changes automatically as the camera moves.
- Focus the globe and use arrow keys to rotate, +/− to zoom, 0 to reset, Space to toggle rotation, and D for diagnostics.
- At Countries detail, uppercase names flow into their own visible country silhouettes in up to three centred lines. Names that cannot fit use a pill when there is room without overlap; otherwise they are omitted. The country-label switch hides both forms. The optional coordinate grid is also made of glyphs.
- Earth/Synthetic switches between real and invented geography using the same projection and display path.
- Reduced-motion preferences disable automatic rotation, ocean animation, and zoom interpolation by default. Rotation can still be explicitly enabled. Hidden tabs suspend the frame loop.

## Architecture

| Module | Responsibility |
| --- | --- |
| `geometry.js` | Unit sphere, lat/lon conversion, camera basis, perspective projection, visibility, near ray/sphere intersection, logarithmic zoom |
| `geography.js` | Load and validate local country grids; classify land/ocean, coasts, and borders; provide label anchors; synthetic provider |
| `lod.js` | Extensible ordered detail registry, thresholds, glyph choices, and hysteresis |
| `renderer.js` | Screen-space sampling and reusable country-id buffer, inset row slots, cached country-name advances/ink bounds, Canvas 2D silhouette names, collision-filtered DOM pill fallback |
| `../css/fonts.css` | Single font family and role registry for atlas and globe; `globe-label` controls country-name font, line height, and spacing |
| `../js/text.js` | Read computed font roles and families for the renderer, without starting atlas boot code on the globe page |
| `../js/map-art.js` | Shared `prepareFlowText` cache and `flowIntoSlots` line breaking used by atlas stories and globe names |
| `../vendor/pretext/` | Shared text preparation and natural-width measurement kernel |
| `app.js` | Resolve registry fonts, prepare country names before animation, input, camera interpolation, lifecycle, controls, accessible status, diagnostics |

No conventional sphere, texture, raster map, or WebGL scene is drawn. The globe surface and silhouette names consist exclusively of `CanvasRenderingContext2D.fillText` glyphs. Names use the registry's `globe-label` font and spacing. Preparation caches pretext handles, possible whole-word lines, grapheme advances, and canvas ink bounds before animation; frames only detect runs and lay out visible names. Native canvas letter spacing is used when available; otherwise graphemes are placed from cached prefix widths. The vendored `measureNaturalWidth` already includes terminal CSS spacing, which is applied once. Pill widths add only padding and borders. Per-LOD surface glyph sizes remain in `lod.js`; their family comes from `--font-mono`. Countries land uses a brighter, denser glyph so names have visible ground. Canvas is a display adapter; the sphere mathematics and geography do not depend on it or on Three.js.

Each row's maximal nonzero country-id runs become slots one cell tall, trimmed by one cell at each end and discarded below three remaining cells. Placement starts on the projected anchor's column and considers nearby rows above and below, preserving reading order and the role's leading. The shared atlas flow sets whole words in at most three lines, centred in their slots. Cached ink bounds must fit vertically as well as horizontally; a 10px font's actual ink can fit a 9px cell row. Silhouette names take priority over pills, and collision checks include both forms.

For the surface, the renderer casts one ray per screen character cell into the sphere and uses the **near intersection** to recover geographic coordinates. This inverse projection keeps cost proportional to viewport size, capped at 24,000 candidate glyph cells, and cannot include hidden far-side points. Geographic label anchors follow the forward pipeline: lat/lon → sphere coordinates → camera basis → perspective projection → horizon test → screen text. The horizon test is `cameraDistance × cameraSpaceZ > 1`, not simply a positive Z test.

A logarithmic slider maps to camera distances of 4.6–1.16 Earth radii. Wheel and pinch input change the same target distance; exponential interpolation approaches it independently of frame rate. LOD thresholds follow camera distance, with a small dead band when zooming out to prevent flicker. Camera motion is smooth; raster detail changes at the thresholds, without a crossfade. The closest view remains at geographic/country scale (about 1,019 km altitude).

## Local data and budget

The checked-in [data files](data/README.md) include 177 Natural Earth country features rasterized at 1.5°, 0.5°, and 0.25° spacing, with names and label anchors. Coasts and borders are derived from neighboring ownership cells. Data are public domain. All three grids and metadata total approximately **38 KB with gzip**, or **1.29 MiB decoded**. Production transfer sizes depend on host compression. There are no runtime data downloads beyond these same-origin static files.

The budget is **10 MB compressed for initial geography**; `build:earthxt-data` enforces it. `npm run build:earthxt-data` regenerates the checked-in files from the original GeoJSON when that optional source file is available. Normal builds use the checked-in results.

All levels derive from the same simplified 1:110m source: higher detail improves raster resolution, not the source's geographic accuracy. Small islands and inland waters can be absent. Borders follow the source dataset. These data are deliberately unsuitable for street-level navigation.

To extend the hierarchy, add a detail entry in `lod.js` and corresponding provider data, then expose any desired preset in the controls. Geographic providers implement `sample(latitude, longitude, level, result)` and `labels()`. A future static chunk loader can populate provider caches and invalidate rendering as chunks arrive; this MVP loads the small global payload once. Streets, buildings, search, routing, POIs, accounts, and live services are not implemented.

## Performance and failure handling

The footer shows rendered FPS, visible glyphs, altitude, and resident geographic bytes. Diagnostics add candidate screen cells, current LOD, camera distance, projection plus geographic lookup time, text plus label submission time, current/average name layout and drawing time, silhouette/pill counts, and JS heap usage when the browser exposes it. Timings are CPU submission measurements; they do not measure compositor/GPU completion. FPS counts actual rendered frames, so a paused view can correctly show 0–2 FPS while it redraws only for occasional ocean changes. Metrics update every 600 ms.

`EARTHXT_DEBUG.snapshot()` includes `labelMs`, `averageLabels`, `silhouetteLabels`, `fallbackLabels`, and a monotonically increasing `frameNumber`. Request `snapshot({ includeGeometry: true })` to copy the current country-id grid and submitted name lines, glyph ink boxes, slots, and pill boxes. Geometry copying happens only on explicit inspection, outside the frame loop.

The renderer uses fixed typed buffers, caps pixel ratio at 2, batches text by color, and hides the far side by construction. Country labels are culled at the horizon and viewport edges, then filtered for overlap. The label layer is decorative to assistive technology; an accessible globe description reports the current position and detail, with keyboard controls and native buttons as alternatives to pointer gestures.

If geography fails to load, a visible explanation appears and the globe remains usable in synthetic mode. Reload retries Earth data. The app does not need an internet connection after its local files have loaded. The atlas service worker precaches the globe and shared dependencies and uses the globe entry for offline `/earthxt/` navigations once the atlas worker is installed. A separate static deployment does not install a dedicated worker; use the standalone edition for guaranteed server-free reopening.

## Build and static deployment

```sh
npm run build:earthxt
```

The build walks the runtime graph from `earthxt/app.js` and `earthxt/index.html`: static module imports, `new URL(..., import.meta.url)` resources, stylesheet links, and CSS imports. It copies every reachable file into `dist/` with repository-relative paths preserved, plus data attribution and `.nojekyll`. The file count and byte budget are calculated from that graph and printed on each build; tests derive their expected assets from the same graph and exercise an independent import-chain fixture.

Publish **the entire `dist/` directory**, then open `earthxt/` beneath the host root or project path (for example `/project/earthxt/`). The sibling `js/`, `vendor/pretext/`, and `css/` directories must remain beside `earthxt/` so its `../` imports resolve. All runtime references are relative and stay within the publish root. No special routes, runtime install, environment variables, or server code are required. The build reports current raw and gzip graph sizes, including the shared atlas flow dependencies; host compression determines transfer size.

For GitHub Pages from a branch, the repository's existing static root exposes `/earthxt/` directly. For a separate static deployment, use `dist/` as the publish directory. Enable gzip/Brotli if available. No public deployment is automatically triggered by building.

`scripts/earthxt/graph.mjs` is shared by both packagers. The standalone packager uses a scoped module registry supporting this graph's multiline named imports, trailing commas, parent-relative paths, and exported function/async function/class/const declarations. Modules are emitted in dependency order; unsupported module syntax and cycles fail loudly. It embeds geographic data as data URLs and expands the stylesheet chain in cascade order, including the shared registry. Vendored pretext is inlined too. The standalone CSP permits only the generated script/style hashes and embedded data, with no `eval` or network access.

## Validation

```sh
npm run test:earthxt        # Geometry, real data, renderer, and packaging checks
npm run build:earthxt
npm run smoke:earthxt       # Real Chromium; requires Playwright + installed browser
```

The unit checks cover spherical projection round trips, perspective occlusion, pole/dateline handling, zoom endpoints, LOD hysteresis, known geographic locations, dataset integrity and budget, progressively finer coasts, synthetic data, glyph silhouettes, rotation, draw-count bounds, country-label culling/collisions, shared registry roles, absence of JavaScript font-family literals, cached measurement outside frames, graph-based static paths, service-worker coverage/fallbacks, and executable standalone pretext/registry/data loading. Renderer tests use stubbed metrics to check run detection, country-cell containment, spacing with and without the canvas API, multiline fitting, pill fallback, and the shared atlas/globe flow. They do not verify browser font rasterization or frame rate.

The browser suite exercises the **built output under `/dist/earthxt/`**, drag and wheel input, all LODs, country labels, source modes, zoom limits, keyboard controls, dialog focus restoration, reduced motion, mobile width, actual touch drag/pinch/cancellation, and data-loading failure. Over Africa it requires at least three silhouette names, verifies each submitted ink box against its country's cells through the debug hook, and samples two seconds of auto-rotation with names enabled. Median/p95 frame intervals, CPU submission and label cost are printed and saved with raw samples to `test-results/earthxt/countries-timing.json`; these are measurements, not a device-independent performance guarantee. It rejects unexpected external requests and browser errors and saves captures to `test-results/earthxt/`. It fails rather than silently skipping if Chromium or local sockets cannot run. A full browser performance evaluation still needs representative desktop and mobile devices.
