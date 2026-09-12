# Globe · Atlas of the Curious

The spherical view of Atlas of the Curious, built on the atlas’s shared text foundation and colour palette: a client-side, text-native globe with mathematical 3D projection, real offline geography, mouse/touch rotation, smooth zoom, three geographic detail levels, the atlas’s 40 places, and live performance instrumentation.

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
- At Countries detail, uppercase names flow into their own visible country silhouettes in up to three centred lines. Names that cannot fit use a pill when there is room without overlap; otherwise they are omitted. The label switch hides both country forms and routed place names. The optional coordinate grid is also made of glyphs.
- Turn on **Serif** in display settings (Tab, then Space) for measured proportional glyphs. Coast cells take the densest ink, inland tone follows the lighting, and the ocean uses a lightly animated pale band. Names, pills, markers and their positions stay the same. The current mono surface remains visible while the palette is prepared; the switch works in the standalone edition too.
- Coloured dots mark all 40 atlas places on Earth. Hover or Tab to a visible marker to read its name, native name, country and pretext-wrapped tagline. Enter or click opens the atlas field note; Escape dismisses a card. Inspecting a marker pauses rotation. At Coastlines and Countries detail, uppercase names route into nearby open water. Inland places may need a longer route; names without enough water are omitted.
- `earthxt/#/place/<id>` centres that place at Countries detail and opens its card. The atlas place dialog has a “See on the globe” link. Unknown or malformed place hashes leave the current view alone.
- The standalone edition includes all places and shows the first two story sentences in each card. Activating a marker keeps the standalone file open.
- Earth/Synthetic switches between real and invented geography using the same projection and display path. Atlas places are hidden in Synthetic mode.
- Reduced-motion preferences disable automatic rotation, ocean animation, and zoom interpolation by default. Rotation can still be explicitly enabled. Hidden tabs suspend the frame loop.

## Architecture

| Module | Responsibility |
| --- | --- |
| `geometry.js` | Unit sphere, lat/lon conversion, camera basis, perspective projection, visibility, near ray/sphere intersection, logarithmic zoom |
| `geography.js` | Load and validate local country grids; classify land/ocean, coasts, and borders; provide label anchors; synthetic provider |
| `lod.js` | Extensible ordered detail registry, thresholds, glyph choices, and hysteresis |
| `renderer.js` | Screen-space sampling and reusable country-id buffer, inset row slots, cached country-name advances/ink bounds, Canvas 2D silhouette names, collision-filtered DOM pill fallback |
| `ink-palette.js` | Lazy cache by serif family, effective cell width/height and capped DPR; prepared land and ocean tone lookups |
| `../css/tokens.css` | Shared ground, ink, category accents, panel, and line colours, preserving the atlas palette |
| `../css/fonts.css` | Single font family and role registry for atlas and globe; `globe-label` controls country-name font, line height, and spacing |
| `places.js` | Parse atlas coordinates and place hashes, forward-project and cull markers, adapt the atlas label engine to the screen grid, cache placements between cells of camera travel |
| `place-layer.js` | Cached tracked label paint plans, canvas dots, accessible marker buttons, fitted cards and atlas navigation/standalone excerpts |
| `../js/data.js` | Classic script providing the same 40 atlas places before module startup |
| `../js/text.js` | Registry metrics and native-name direction; loading atlas data also enables the existing metrics boot (the atlas application itself is not loaded) |
| `../js/labels.js` | Shared sea-cell routing, explicit preparation hook, optional multirow line footprints |
| `../js/hover-card.js` | Shared tagline fitting, tight widths and widow handling used by both views |
| `../js/category-colors.js` | Resolve category custom properties once for both canvas marker adapters |
| `../js/map-art.js` | Shared text flow, measured glyph coverage/advance and `buildInkRamp`; synchronous atlas `palette` and resumable globe `paletteAsync` use the same calculation |
| `../vendor/pretext/` | Shared text preparation and natural-width measurement kernel |
| `app.js` | Resolve registry fonts, prepare country and place names before animation, input, camera interpolation, lifecycle, controls, accessible status, diagnostics |

No conventional sphere, texture, raster map, or WebGL scene is drawn. The globe surface and silhouette names consist exclusively of `CanvasRenderingContext2D.fillText` glyphs. Names use the registry's `globe-label` font and spacing. Preparation caches pretext handles, possible whole-word lines, grapheme advances, and canvas ink bounds before animation; frames only detect runs and lay out visible names. Native canvas letter spacing is used when available; otherwise graphemes are placed from cached prefix widths. The vendored `measureNaturalWidth` already includes terminal CSS spacing, which is applied once. Pill widths add only padding and borders. Mono surface glyph sizes remain in `lod.js`; their family comes from `--font-mono`. Countries land uses a brighter, denser glyph so names have visible ground. Place dots are small canvas circles above this text surface. Canvas is a display adapter; the sphere mathematics and geography do not depend on it or on Three.js.

Serif uses `readMapStoryFamily(document)` from the shared registry. Its font size equals the effective cell height. The atlas palette engine renders each candidate at that size and DPR, counts ink coverage/spill, and uses pretext's measured advance to reject glyphs wider than the cell. Both adapters keep the same 6% spill limit and minimum six distinct tones. The globe centres each selected glyph using its cached advance and paints it on the same middle baseline as the measurement probe. It changes neither the ray samples nor the buffers used for country silhouettes and place routing.

The first toggle, or a new LOD/cell size/DPR while enabled, schedules the shared resumable palette calculation. Idle callbacks process glyphs in slices capped between candidates at 2 ms; browsers without idle callbacks process one glyph per timer task. Even the first measurement is deferred, and frames only read completed entries. Pending requests for the same key share one promise; returning to a prior key reuses its palette. The synchronous atlas worker action consumes the same steps immediately, preserving its existing protocol. No worker URL, network request or CSP exception is needed in either globe edition. If fewer than six usable tones fit, or canvas measurement fails, mono stays visible and the live status explains why. Reduced motion freezes the ocean phase in both modes; visibility handling is unchanged.

Each row's maximal nonzero country-id runs become slots one cell tall, trimmed by one cell at each end and discarded below three remaining cells. Placement starts on the projected anchor's column and considers nearby rows above and below, preserving reading order and the role's leading. The shared atlas flow sets whole words in at most three lines, centred in their slots. Cached ink bounds must fit vertically as well as horizontally; a 10px font's actual ink can fit a 9px cell row. Silhouette names take priority over pills, and collision checks include both forms.

For the surface, the renderer casts one ray per screen character cell into the sphere and uses the **near intersection** to recover geographic coordinates. This inverse projection keeps cost proportional to viewport size, capped at 24,000 candidate glyph cells, and cannot include hidden far-side points. Geographic label anchors follow the forward pipeline: lat/lon → sphere coordinates → camera basis → perspective projection → horizon test → screen text. The horizon test is `cameraDistance × cameraSpaceZ > 1`, not simply a positive Z test.


Place routing runs on every rendered frame at Coastlines and Countries detail, using the renderer’s current grid: country cells, cells whose corners fall outside the sphere’s disc, country-pill rectangles and a three-by-three-cell footprint around each visible marker are blocked. The shared label engine first moves previous records with their markers and reserves those whose full line-height footprints remain free, preserving their direction, offset and line breaks. Invalid records are replaced in the same pass: the old candidate and nearby offsets in that direction are tried before the other directions, so newly available water on the opposite side does not flip a name. A larger anchor search lets inland places reach the coast; names disappear when their markers leave visibility or no candidate fits. Grid/level changes reset the preferences. All names are prepared before animation; frames never call pretext preparation. Labels paint in uppercase with registry tracking exactly once.

Cards share the atlas’s tight tagline fit and widow handling; the chosen line breaks remain fixed when a long name widens the card. Card text is prepared and fitted at setup/resize, outside the frame loop. Inspection reads the card size once; following frames only position it, flip sides near an edge, and clamp it to the stage. Native names carry their language and `dirForLang` direction. The normal card links to `../#/place/<id>`; a generated `data-standalone` page uses a story excerpt instead.

A logarithmic slider maps to camera distances of 4.6–1.16 Earth radii. Wheel and pinch input change the same target distance; exponential interpolation approaches it independently of frame rate. LOD thresholds follow camera distance, with a small dead band when zooming out to prevent flicker. Camera motion is smooth; raster detail changes at the thresholds, without a crossfade. The closest view remains at geographic/country scale (about 1,019 km altitude).

## Local data and budget

The checked-in [data files](data/README.md) include 177 Natural Earth country features rasterized at 1.5°, 0.5°, and 0.25° spacing, with names and label anchors. Coasts and borders are derived from neighboring ownership cells. Data are public domain. All three grids and metadata total approximately **38 KB with gzip**, or **1.29 MiB decoded**. Production transfer sizes depend on host compression. There are no runtime data downloads beyond these same-origin static files.

The budget is **10 MB compressed for initial geography**; `build:earthxt-data` enforces it. `npm run build:earthxt-data` regenerates the checked-in files from the original GeoJSON when that optional source file is available. Normal builds use the checked-in results.

All levels derive from the same simplified 1:110m source: higher detail improves raster resolution, not the source's geographic accuracy. Small islands and inland waters can be absent. Borders follow the source dataset. These data are deliberately unsuitable for street-level navigation.

To extend the hierarchy, add a detail entry in `lod.js` and corresponding provider data, then expose any desired preset in the controls. Geographic providers implement `sample(latitude, longitude, level, result)` and `labels()`. A future static chunk loader can populate provider caches and invalidate rendering as chunks arrive; this MVP loads the small global payload once. Streets, buildings, search, travel routing, accounts, and live services are not implemented.

## Performance and failure handling

The footer shows rendered FPS, visible glyphs, altitude, and resident geographic bytes. Diagnostics add candidate screen cells, current LOD, camera distance, projection plus geographic lookup time, text plus label submission time, current/average name layout and drawing time, silhouette/pill counts, visible/labelled place counts, place placement and total routing/drawing time, and JS heap usage when the browser exposes it. Timings are CPU submission measurements; they do not measure compositor/GPU completion. FPS counts actual rendered frames, so a paused view can correctly show 0–2 FPS while it redraws only for occasional ocean changes. Metrics update every 600 ms. `EARTHXT_DEBUG.snapshot()` exposes `placeCount`, `visibleMarkers`, `labelledPlaces`, `labelCells`, `markerCells`, `markers`, `placeLabels`, and `placeLayoutPasses`. `placeLabelMs` measures the current placement pass (zero when skipped); `placeRenderMs` includes marker projection, routing, canvas submission and DOM updates. With `{ includeGeometry: true }`, the grid also includes current `countryIds` and `blockedCells`. Snapshots copy these records only on explicit inspection.

`EARTHXT_DEBUG.snapshot()` includes `labelMs`, `averageLabels`, `silhouetteLabels`, `fallbackLabels`, and a monotonically increasing `frameNumber`. Request `snapshot({ includeGeometry: true })` to copy the current country-id grid and submitted name lines, glyph ink boxes, slots, and pill boxes. Geometry copying happens only on explicit inspection, outside the frame loop.

The snapshot also reports `serif` (the switch), `serifActive` (the last submitted surface), and `serifPalette` with its key, status (`unprepared`, `building`, `ready`, or `unavailable`), reason, resolved font and measured ramp. A checked switch can still report `serifActive: false` while the current geometry's palette is pending or unavailable.

The renderer uses fixed typed buffers, caps pixel ratio at 2, batches text by color, and hides the far side by construction. Country labels are culled at the horizon and viewport edges, then filtered for overlap. The country-label layer is decorative to assistive technology; the place-marker layer contains named, focusable buttons. An accessible globe description reports the current position and detail, with keyboard controls and native buttons as alternatives to pointer gestures.

If geography fails to load, a visible explanation appears and the globe remains usable in synthetic mode. Reload retries Earth data. The app does not need an internet connection after its local files have loaded. The atlas service worker precaches the globe and shared dependencies and uses the globe entry for offline `/earthxt/` navigations once the atlas worker is installed. A separate static deployment does not install a dedicated worker; use the standalone edition for guaranteed server-free reopening.

## Build and static deployment

```sh
npm run build:earthxt
```

The build walks the runtime graph from `earthxt/app.js` and `earthxt/index.html`: classic and module `<script src>` tags, static module imports, `new URL(..., import.meta.url)` resources, stylesheet links, and CSS imports. It copies every reachable file into `dist/` with repository-relative paths preserved, plus data attribution and `.nojekyll`. The file count and byte budget are calculated from that graph and printed on each build; tests derive their expected assets from the same graph and exercise an independent import-chain fixture.

Publish **the entire `dist/` directory**, then open `earthxt/` beneath the host root or project path (for example `/project/earthxt/`). The sibling `js/`, `vendor/pretext/`, and `css/` directories must remain beside `earthxt/` so its `../` imports resolve. All runtime references are relative and stay within the publish root. No special routes, runtime install, environment variables, or server code are required. The build reports current raw and gzip graph sizes, including the shared atlas flow dependencies; host compression determines transfer size.

For GitHub Pages from a branch, the repository's existing static root exposes `/earthxt/` directly. For a separate static deployment, use `dist/` as the publish directory. Enable gzip/Brotli if available. No public deployment is automatically triggered by building.

The globe-only `dist/` graph does not copy the atlas page: the brand link and place field-note links need an atlas at the publish root. Deploy the combined repository site for navigation between both views.

`scripts/earthxt/graph.mjs` is shared by both packagers. The standalone packager uses a scoped module registry supporting this graph's multiline named imports, trailing commas, parent-relative paths, and exported function/async function/class/const declarations. Classic scripts execute in document order before modules, so `ATLAS_DATA` exists when metrics and the globe start. Modules are emitted in dependency order; unsupported module syntax and cycles fail loudly. It embeds geographic data as data URLs and expands the stylesheet chain in cascade order, including the shared registry. Vendored pretext is inlined too. The standalone CSP permits only the generated script/style hashes and embedded data, with no `eval` or network access.

## Validation

```sh
node --test --test-concurrency=1 test/earthxt/*.test.mjs # Serial checks for low-memory hosts
npm run build:earthxt
npm run smoke:earthxt       # Real Chromium; requires Playwright + installed browser
npm run build
node scripts/earthxt/smoke-nav.mjs # Both views at the combined repository root
```

The unit checks cover spherical projection round trips, perspective occlusion, pole/dateline handling, zoom endpoints, LOD hysteresis, known geographic locations, dataset integrity and budget, progressively finer coasts, synthetic data, glyph silhouettes, rotation, draw-count bounds, country-label culling/collisions, shared registry roles, absence of JavaScript font-family literals, cached measurement outside frames, graph-based static paths, service-worker coverage/fallbacks, and executable standalone pretext/registry/data loading. Renderer tests use stubbed metrics to check run detection, country-cell containment, spacing with and without the canvas API, multiline fitting, pill fallback, and the shared atlas/globe flow. Place tests cover all 40 coordinates, near/far-side projection, hash parsing, synthetic-disc clearance including multirow text and markers, continuous labels and stable sides under a mask shifting one column per frame, marker-relative hysteresis, cached measurement, shared card composition, and rotation over a real South America raster with stubbed advances. They do not verify browser font rasterization or frame rate.

`ink-palette.test.mjs` uses synthetic advances/alpha coverage with the actual shared palette engine. It checks synchronous/asynchronous equivalence, deferred measurement, idle deadlines, one-glyph timer slices, pending and completed cache reuse across all key fields, failure fallback, and executable standalone palette preparation. Recorder comparisons use real country rasters and the actual place layer to verify that every Serif surface glyph belongs to the ramp while classification, country names/pills, routed place names, canvas dots and DOM positions remain identical. Both canvas spacing paths are covered. These checks cannot establish real font coverage or animation performance.

`node scripts/earthxt/bench-places.mjs` compares fresh searches with the current router for all 40 places over two seconds of South American rotation at 1440×1000 and Coastlines detail. It reports p95 routing cost, pass count and labelled/visible ranges after one warm-up sweep. The Node benchmark uses real raster masks and synthetic 6px font advances, excludes rendering, and is guidance for the placement policy; the browser smoke is needed to verify actual font metrics and submission costs.

The browser suite exercises the **built output under `/dist/earthxt/`**, drag and wheel input, all LODs, country labels, source modes, zoom limits, keyboard controls, dialog focus restoration, reduced motion, mobile width, actual touch drag/pinch/cancellation, and data-loading failure. Over Africa it requires at least three silhouette names, verifies each submitted ink box against its country's cells through the debug hook, and samples two seconds of auto-rotation with names enabled. Median/p95 frame intervals, CPU submission and label cost are printed and saved with raw samples to `test-results/earthxt/countries-timing.json`; these are measurements, not a device-independent performance guarantee. It rejects unexpected external requests and browser errors and saves captures to `test-results/earthxt/`. It fails rather than silently skipping if Chromium or local sockets cannot run. A full browser performance evaluation still needs representative desktop and mobile devices.

Serif smoke additions capture actual canvas text commands around keyboard toggles, compare all reported placements and classification, check reduced-motion stability, and exercise the standalone switch with HTTP blocked. Canvas interception is removed before a two-second Countries rotation sample. `serif-timing.json` stores raw samples and the mono comparison; regression limits are p95 CPU submission below 33.4 ms, frame intervals below 50 ms, and CPU within 35% of the mono sample (an 8 ms floor avoids overreacting to tiny baseline timings). These browser additions still need to be run on a Chromium-capable host.

`nav.test.mjs` checks source markup, unchanged atlas palette values, shared stylesheet loading and packaging, standalone identity, and cache coverage. It does not prove browser rendering. `smoke-nav.mjs` checks the actual header links in both directions at desktop and mobile sizes, keyboard activation of the brand link, shared computed tokens, rendered views, and absence of console/page errors.

The place browser checks open South America at Coastlines detail, require at least four visible and labelled places, check all reported cells against current water/disc/marker masks, exercise hover/taglines, card bounds, Tab and Enter, click destinations, and place deep links in both directions. A two-second rotation sample writes labelled min/max, visible marker counts, placement pass counts and timings to `test-results/earthxt/places-timing.json` before assertions. Each frame must stay within one label of the sample maximum unless visible markers decreased that frame. The sample enforces p95 placement below 2 ms, CPU submission below 33.4 ms and frame intervals below 50 ms at the suite’s desktop viewport. These are regression budgets for that test environment, not device-independent guarantees. The offline check opens a place deep link in the standalone file with HTTP blocked and verifies all 40 places, the story excerpt, and marker activation without navigation.

For this change, Chromium could not run in the implementation sandbox. The browser smoke suites and atlas browser checks must be run on a host with Chromium; passing Node checks does not establish browser rendering, navigation, CSP enforcement or frame timing.
