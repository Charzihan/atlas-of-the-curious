# Claude handoff — Phases 5, 7 and 8

Original handoff: 2026-09-10, branch `pretext-roadmap`, starting at `8103e5b`
(Phase 6). Integration update: 2026-09-11, combining Phase 7 (`2beb714`) and
Phase 8 (`5a33022`) for `integration-p7-p8`, with service-worker cache v3.
Both phases below describe the combined implementation. No push or deployment
was performed. The original `.claude/` worktrees and `claude-Phase5-handoff.txt`
were preserved.

## Start here

The original nine-phase specification is now preserved in the working tree at
[atlas-pretext-roadmap.html](atlas-pretext-roadmap.html). This is an exact copy of
Claude's scratchpad artifact, whose published artifact ID is
`4ec59cae-ddea-40d9-b0e8-b3d6ad8f65c6`. The live artifact could not be fetched, so
later edits to that published page have not been compared.

Phases 0–4 and 6 were already committed. This continuation recovers Phase 5,
adds Phases 7–8, and preserves Phase 6's reader, print and notebook integration.
The original roadmap's estimated effort is historical, not a record of time spent.

## What was recovered, versus added here

The interrupted Phase 5 implementation was uncommitted in
`.claude/worktrees/agent-a20f006e646c18691`, based on Phase 4 (`184fc8a`).
Its map/router/CSS changes and new label, sea, worker and test modules were
recovered into the current tree. Service-worker and smoke-test changes were
integrated selectively to retain Phase 6's entries and checks.

The recovered code implements worker-based label placement, hover-story spills,
idle sentences and per-word hit testing. This continuation additionally:

- Registers all Phase 5 and Phase 7–8 flags in `js/text.js`.
- Drops superseded worker replies and recovers cleanly from worker errors.
- Aborts per-build window listeners on map rebuild, avoiding accumulated
  pointer, scroll, hash, highlight and geolocation listeners after resizing.
- Keeps a hover spill hidden until the previous idle sentences have dissolved,
  preventing two text layers from painting over each other.
- Limits text ripple lift to the row's vertical gutter; reduced motion has no
  text displacement.
- Selects idle sentences using the actual corridor depth and leaves at least
  six cells for travel before laying out. The earlier first-row-only capacity
  estimate could repeatedly choose sentences that could not drift in tight water.
- Adds country indices, country/route layout, drawing controls, serif ink,
  browser checks, screenshots and this documentation.

## Phase 5 — The living sea

- `js/labels.js`: the former map label placement logic, now a pure engine.
- `js/sea.js`: coastline-safe hover spills and idle sentence corridors. Prepared
  text is cached by text/font; sentences travel within a reserved rectangle.
  `setObstacles()` takes the cells the page's own floating chrome covers; they
  are treated exactly like land (added in the Phase 5 review, see below).
- `js/text-worker.js`: same-origin module worker, with init/geometry/placement,
  hover, idle and map-art messages. Idle position arrays use transferable buffers.
- `js/map.js`: asynchronous backend, drawing, fading, hit testing and main-thread
  fallback using the same engines. `ATLAS_MAP_DEBUG` exposes diagnostics,
  including `fontAgreement()`: the worker measures the grid's reference string
  with pretext and the page measures it with a canvas, and the two must agree.
  There is no `@font-face` in the site, so every role is a stack of locally
  installed faces and there is nothing to load into the worker — but a stack
  that resolved to a different face there would route the sea at one cell width
  and paint it at another, so it is checked rather than assumed.
- `js/text-route.js`: line results retain start/end cursors for per-word geometry.
- `scripts/checks/sea.mjs` and `run-sea.mjs`: both backends, 4× CPU timing,
  hover/collision sweeps, twenty click picks per backend, phone and reduced motion.

Hover a marker for a tagline spill. Opening its place extends the spill where
there is room. After twelve seconds idle on desktop, field-note sentences drift;
hovering a word pauses/brightens its sentence, clicking opens the source place.
Pointer motion elsewhere or keyboard/wheel input dissolves them. Phones and
reduced-motion users do not get idle animation.

Intentional implementation detail: idle sentences are laid out once into safe
rectangular corridors, then moved within those corridors by the worker. They
are not unnecessarily re-typeset every frame as the original proposal suggested.
Worker frames still update positions, opacity, lifetime and occupancy validity.
Landlocked/crowded markers can have no spill; their normal hover card remains.

**Phase 5 review (later).** Neither the hover spill nor an idle corridor may use
cells that the intro panel, the control cluster or the hover card sits over.
Those boxes are measured on the main thread, converted through the same inverse
pan/zoom transform the hit test uses, and posted to the engine (`sea-obstacles`)
or set on the fallback directly. Before this, a quarter of all drifting-word
placements were behind the opaque intro panel, and some of those were on its
outbound @chenglou/pretext link — clicking one navigated away and was the cause
of the intermittent "Execution context was destroyed" failure in the sea click
sweep. `ATLAS_MAP_DEBUG.checkSeaText()` now counts those cells as violations
("under page chrome") and `ATLAS_MAP_DEBUG.seaObstacles()` exposes the boxes.
`.map-marker-ring` also became `pointer-events: none`: the decorative pulse
scales to roughly a 49px invisible click target and could swallow a click meant
for a drifting word underneath it.

The dev assertion also now runs on its own, as the roadmap asked. Only the label
walk had been wired to a placement, so `checkSeaText()` fired only when a test
called it; it now runs (under `DEBUG_MAP`) after every placement and at every
spawn or retirement — the two moments the sea's cells change for a reason other
than drifting. It is deliberately not per frame: a sliding sentence already has
every cell of the block it is moving into revalidated in `js/sea.js` on every
frame, and a full grid walk per frame on localhost would land inside the
frame-rate measurement in `scripts/checks/sea.mjs`.

Masking the hover card costs spills — on a real hover about 11 of 40 markers now
place a complete tagline on the water, against 19 before, but 10 of those 19
were at least half-hidden behind the card. Nothing half-drawn is preferred to
more of it.

## Phase 7 — Shapes and paths

- `scripts/build-map.mjs` emits `countryCodes`, `countryNames` and a flat
  `countries` index per desktop/mobile cell; zero is water, other values are
  one-based entries in `countryCodes`. Existing glyph/color output is unchanged.
  The ownership follows the generator's existing sampled-country assignment.
- It also emits `outlines`: simplified lon/lat rings for the 31 countries the
  dataset names (it runs `js/data.js` to find them). The alias table is emitted
  as `countryAliases` in `js/landmap.js` for `js/map.js` to consume.
  Pruning keeps each exterior with all its holes, and keeps every exterior at
  least 15% of the largest one's area regardless of distance; only smaller
  offshore parts must join the nearby cluster. Rings crossing the antimeridian
  cause their whole polygon to be rejected rather than projected across the map.
  The named `Malaysia (Borneo)` exception explicitly selects Borneo; a plain
  Malaysia request preserves both Borneo and the peninsula. Exteriors are
  simplified with Douglas–Peucker at a tolerance proportional to the country's
  own size. Holes are never simplified or area-pruned; if quantisation collapses
  one, its exterior is rejected too. Rings are quantised to 1/50 of a degree and
  delta-encoded as integers. After the review fixes, `js/landmap.js` is 54,060
  bytes for 1,681 outline points. Desktop/mobile glyphs, colors and countries
  arrays remain identical to the pre-fix HEAD.
- `js/landmap.js` is regenerated from the repository's existing Natural Earth
  data. No new network download is needed.
- `js/map-art.js` supplies pure, cached country-story and route layout engines,
  used in the existing worker and its synchronous fallback.
- `js/map.js`, `index.html`, `js/dialog.js`, `css/style.css` supply the canvas,
  captions, screen-reader story copy and controls.

Opening a place prepares its country story behind the dialog; an ordinary
dialog close clears that preview. **Read on the map**
closes the dialog, scrolls to the map and pins the reading view until cleared. **Journey to**
plus **Show route** draws a journey between two places. **Locate me** draws a
route from the granted location to the nearest wonder. **Clear story** clears
country/route content; **Serif map** is independent.

A country story is set inside the country's own polygon, not inside the land
grid: the 150×39 cells are far too coarse to hold 400 words inside anything
smaller than a continent. The rings are projected with the map's own
equirectangular projection and scaled about the country's centre by k. Per text
row the scanline runs of the polygon — even-odd over every ring, so holes are
water — become the widths fed to `layoutNextLineRange`. Full-height containment
intersects the edge limits on both sides of every vertex height inside a row,
plus its top and bottom; a narrow hole or notch between vertices cannot escape
this check. Several runs in one row are several slots, so a row that crosses
two islands sets two
pieces of the story. A run that cannot hold the next *whole* word is left empty
rather than breaking the word: that is the minimum-run rule, measured against
the word actually coming rather than against a fixed number of cells.

The Phase 0 registry's `MAP_STORY_TYPE` table in `js/text.js` owns the family
property, candidate sizes/line heights and inset typography. Type sizes are
tried at 14, 13, 12, 11 and 10 px; the first that fits at the
largest scale the map allows is kept, and then a binary search finds the
*smallest* k that still holds the whole story, which is the k that fills the
shape. The view is anchored on the country's true position and slid only as far
as it must to stay on the map and clear of the introduction panel and the map
controls (`js/map.js` measures those once per request and passes them as
`avoid`, after showing Clear story so the control box has its final size).
Slots intersecting a panel are removed before fitting; anchoring prefers fewer
removed slots before considering movement. The marker's full footprint,
including its outer stroke (7.3 px radius), also removes slots before fitting.
Insets obey panel clearance too, falling back to the complete caption when no
clear placement fits. The place's own coordinates are marked inside the
silhouette; the outline is stroked in the country's palette colour and stamped
with the grid's texture character at the grid's own cadence, over a dimmed map.

Before the review fixes, the tested 1280×800 size gave **37 of 40 stories in
their country's silhouette and 3 regional insets** — `marble-caves`, `atacama` and
`rapa-nui`, all Chile. Chile is 4,300 km long and about 180 km wide: scaled to
the map's height it is a 100 px-wide ribbon whose rows hold roughly a third of
the words, and scaling it to the map's width would make it nine screens tall.
Rapa Nui is 3,500 km offshore and was never present in the source Natural Earth
110m Chile geometry; pruning did not remove it. On a phone the map band is too
short for a silhouette at 10 px, so phones keep the inset. A story that fits no
silhouette uses a 12 px regional inset near its marker; if even that cannot fit
the map height, the full story is shown in a caption below the map. The
complete story also has a screen-reader text equivalent. Nothing is ever
silently truncated: `scripts/checks/map-art.mjs` asserts that the lines
concatenate back to the story, that every line box is inside the polygon, that
the type never drops below 10 px, and that at least 34 of the 40 are
silhouettes. The check now uses the exported full-height containment routine,
asserts panel/marker clearance, and reports silhouettes, insets and captions
separately for both layout hosts.

The post-fix browser count is **unverified**: this sandbox blocks Chromium
launch (`sandbox_host_linux.cc:41`, `Operation not permitted`). The Node-only
`node scripts/checks/map-art-geometry.mjs` passes the narrow-hole/notch,
sloped-edge, panel/marker, font-registry, Malaysia, retained-hole and dateline
regressions; its flow fixtures use synthetic widths, not browser font metrics.
`pnpm build-map` and `pnpm build` pass; `pnpm validate` passes the dataset checks
but skips browser text checks. `node scripts/checks/run-map-art.mjs` and
`pnpm smoke` cannot run browser assertions, and the Wadi Rum screenshot could
not be retaken. These pnpm commands used `--config.verify-deps-before-run=false`
to use the existing local dependencies without an automatic network install.

Routes use spherical interpolation, split at the antimeridian and handle
coincident/antipodal endpoints without NaN coordinates. Text runs rotate to
segment headings. A conservative rotated bounding box must clear place labels,
ocean labels and markers. When the full field note cannot fit the available
route, a caption displays the complete note. Old route text is cleared while
changed label geometry is being rerouted. The background path itself may pass
under labels; the text must not.

`window.ATLAS_MAP_ART` exposes `country(id)`, `route(fromLatLon, toId)`, `clear()`,
`setSerif(boolean)` and `debug()` for development checks. These operations use
sequence/build IDs so obsolete layouts do not repaint a new map.

## Phase 8 — A serif atlas

The map control **Serif map** requests the site's serif stack (`--font-serif`,
starting with Georgia). The browser resolves that stack against installed fonts;
headless Linux substitutes for Georgia. The first pass shipped a hand-ordered
list of fourteen glyphs whose "tone" was its index. The palette is now measured.

**The palette** (`palette()` in `js/map-art.js`). The candidates are printable
ASCII, the printable half of Latin-1, and the typographic marks a WGL4 face
such as Georgia commonly carries (`† ‡ • ≈ ∞ œ Œ – — ‰`); 198 in all. Each is
rendered into an `OffscreenCanvas` in the worker, or a DOM canvas on the
synchronous host (even when that host also offers `OffscreenCanvas`). Measurement
uses the fractional CSS cell width and height and the painter's DPR, capped at
2. The probe is scaled by DPR and the glyph is centred by its measured advance
at a middle baseline, just as in `repaintBase` and the sea loop.

The reference placement is cell (0, 0), before the sea's animated ripple lift.
Padding is a whole number of device pixels so it preserves that cell's raster
phase. Fractional boundary pixels are apportioned by their overlap with the
cell. `inkCoverage` is the share of the cell inked; `spill` is the share of the
glyph's ink outside any of the four cell edges. This is a reference-cell fit
bound, not a bound on the intentional motion of a ripple or a promise that
antialiasing is identical at every translated cell. The advance comes from
`prepareWithSegments`, the same measurement pretext lays text out with.

A glyph fits only if its advance is at most the cell width, it has visible ink,
and it spills no more than **6%** of its ink outside the reference cell. These
limits never expand to fill a target rung count. The U+E000 probe only removes
likely notdef boxes with matching width and coverage. It cannot detect a real
glyph supplied by a fallback font, and it can mistakenly exclude supported ink
that resembles the probe. Canvas does not identify the face behind each glyph;
there is **no single-face guarantee**. All scores measure the resolved stack,
including substitutions. The browser assertion checks that the canvas font
string contains the registry's serif family; it does not prove Georgia exists.

The ramp has **up to 24 rungs**, one per distinct measured coverage. Equal
coverages keep the widest fitting glyph. Coverage is normalised over the fitting
set, then each rung minimises
`|coverage − target| + 0.4 · max(0, (cellWidth − advance) / cellWidth)` among
those darker than the rung below it, leaving one candidate for each remaining
rung. Shorter ramps are never padded. With fewer than **6** distinct tones, or
failed canvas measurement, the palette is unusable: serif mode stays off, the
toggle is disabled, and its tooltip gives the reason. A requested mode only
becomes active when a usable palette arrives. Geometry rebuilds retry the
request. The engine caches by font, fractional geometry, and DPR; no measurement
runs inside a frame. Actual ramp lengths and glyphs depend on the font resolver
and raster scale and are printed by the checks.

**Land tone.** A multi-source breadth-first search over the land mask gives each
land cell its distance to the nearest coast (columns wrap, so the antimeridian
is not a false coastline; the poles count as edges). Tone runs from 1.0 at the
coast down to 0.3 five cells inland, plus ±0.025 of the existing colour dither
so a wide interior does not flatten into one even grey. That is what keeps a
continent readable as a shape once the glyphs are no longer all one width: its
outline stays the darkest thing on the map. The per-cell rung index is computed
with the palette and travels with it, so `repaintBase` is a lookup. Country
colours come from the existing palette, unchanged.

**The sea.** The wave and ripple simulation is untouched; only its ink changes.
Where the monospace sea quantises density into six glyphs and gets the rest of
its contrast from colour, the serif sea maps `(density / 1.15) ^ 1.6` straight
onto the available ramp per cell per frame, so crests and troughs read as one
continuous tone. Both land and water index by the actual ramp length. The gamma
is there because a measured ramp mapped linearly makes
quiet water much heavier than the monospace floor. The still sea floor on the
base canvas is tonal too, taken from the same static regional bias the wave
trains use; under reduced motion, where the fluid layer never draws, that static
tonal sea is the whole sea.

The toggle is remembered in `localStorage` under `atlas:serif-map` (every access
wrapped, including the property read, which throws outright in a browser with
site data blocked). `aria-pressed` reflects it, and `serifAtlas` still gates
both the control and the rendering. Land mask, cell positions, marker
coordinates and zoom are identical in both modes; labels, hover cards and the
readable sea sentences keep their own measured fonts. The combined release
bumps `sw.js` to cache v3 so returning visitors fetch the updated modules.
No inline style attributes, no `eval`.

`ATLAS_MAP_ART.debug()` exposes `palette` (the ramp with its measured coverage
and advances, without the per-cell array) and `base` — the base canvas's
requested font string, land glyph multiset, and painted land cell positions.
Checks compare those positions across toggles, rasterise every chosen rung with
production placement at DPR 1, 1.25 and 2, verify strictly increasing coverage and
at most 6% spill, and assert worker/DOM-canvas ramp equality. Sparse synthetic
palettes cover 0, 1, 5, 6, 12, 24 and 30 fitting tones, including rejected width
and spill violations and the equal-coverage width tie.

**Timing.** The check warms the palette before timing, starts idle mode, waits
for its full sentence count, and switches serif via `ATLAS_MAP_ART.setSerif(true)`
without moving the pointer. Every sampled frame must have idle mode on and the
same nonzero sentence count in both samples. At 4× CPU, both average and p95
must be at most **1.25× monospace idle**, and each must also clear its **2×
unthrottled vsync** ceiling. All timings and sentence-count ranges are printed
before assertions, including on a failed gate.

**Phase 8 fixes — sandbox verification.** Syntax checks on all four changed
JavaScript files and the synthetic ramp checks passed, including a no-canvas
engine returning an unusable zero-rung palette. `pnpm validate` passed dataset
validation but skipped browser text checks; `pnpm build` generated all 40 pages.
`node scripts/checks/run-map-art.mjs` and `pnpm smoke` both failed at Chromium
startup (`Target page, context or browser has been closed`). No browser check
passed in this sandbox, and the production ramp length and all new timing
numbers are **unavailable**. The pnpm scripts used
`--config.verifyDepsBeforeRun=false` with a local copy of the parent checkout's
pinned dependencies after the automatic install failed on npm registry DNS.

## Phase 8 addendum — The sky in ASCII

The drifting clouds were blurred radial-gradient blobs. They are now drawings in
the map's own alphabet: a closed outline of `.` `-` `_` `(` `)` `~` `,` `'` and a
backtick on whole grid cells, with the soft white sprite poured into the blank
interior.

`js/clouds.js` is the generator, and it is pure — no DOM, no canvas, no
`Math.random`, so Node and the browser produce byte-identical clouds from the
same seed. Three stages:

1. **A silhouette.** Either a hand-drawn template (four of them; the classic
   three-line puff is the first) stretched, mirrored and edge-jittered, or 3..6
   aspect-corrected ellipse lobes rasterised onto an 8..26 by 2..6 cell grid.
   Cells are about twice as tall as they are wide, and the raster knows it.
2. **Closure.** Rows and columns are each collapsed to one run, then every row is
   nested inside the row below it and made one to three cells narrower. That
   single rule is what makes the drawing a cloud: the bottom row is the widest
   and becomes the flat `_` base line, every column runs unbroken down to it, and
   the silhouette is orthogonally convex — so every interior cell has outline to
   its left and right on its row and above and below in its column, which is
   exactly the closure `scripts/checks/clouds.mjs` asserts.
3. **Tracing.** Boundary cells pick their glyph from the local shape: `.` and `-`
   along a top edge, `_` along the base, `(` and `)` down the sides and wherever
   an edge turns into the white interior, `~` for a frayed west edge (the drift
   runs west to east), `,` `'` and a backtick for the occasional curled corner.
   `(` and `)` are emitted in pairs around each interior run, so a row can never
   be off by more than one.

A cloud's identity is its seed; `morph` only re-frays its edges, so every six to
thirteen seconds a cloud regenerates from the same seed and cross-fades over
1.5 s into the new outline. Regeneration happens on a timer between frames, never
inside one, and pauses while the page is hidden. The frame loop allocates
nothing: it walks a cross-fade, draws one pre-rendered fill per cloud and one
`fillText` per outline row.

Rendering notes:

- **Snapped to whole cells, columns and rows.** An outline half a column off the
  grid reads as a misprint next to the land glyphs, so the drift advances a
  column at a time (about a second per step at this speed, unsynchronised
  between clouds) and only the soft mass inside keeps the sub-cell remainder, so
  it slides on while the drawing waits for its next column.
- **The fill is feathered, not clipped.** Clipping the sprite straight to the
  interior cells gives a staircase of hard rectangles. Instead the silhouette is
  blurred into a mask and the sprite poured through it (`source-in`) into a small
  per-outline canvas; the frame just draws that. A browser without canvas filters
  gets the crisp version.
- **No Antarctic fade on this path.** `cloudFade` withheld clouds from the polar
  rows because a white blob dissolved into white ice. An ASCII outline does not,
  so clouds now drift over the whole map and their rest rows are spread over its
  full height. Over the rows the base canvas paints in the palest palette entry
  the outline switches to slate blue and the fill to a cooler, firmer blue —
  read off `cellColor`, so it follows the map rather than a hard-coded latitude.
  `cloudFade` still governs the blob path behind `?noflags=asciiClouds`.
- **The cloud canvas keeps its own monospace font.** The serif toggle repaints
  the land and the sea; the sky is a drawing, not map ink.
- **Reduced motion** paints the sky once and leaves it still. (The blob path
  painted nothing at all; a still drawing is the honest static form of this one.)

`scripts/checks/clouds.mjs` runs both halves — `node scripts/checks/clouds.mjs`
for the geometry alone, `node scripts/checks/run-clouds.mjs` for the browser too,
and `pnpm smoke` for both. Screenshots: `docs/screenshots/clouds-1280.png` and
`docs/screenshots/clouds-zoom.png`.

## Flags and offline cache

All default on, except serif rendering is opt-in through its toggle:

| Flag | Disables |
| --- | --- |
| `worker` | Worker backend; exercises synchronous fallback |
| `seaStories` | Hover/open sea spills |
| `idleSea` | Idle sentence animation |
| `seaClick` | Drifting-word click/hover behavior |
| `countryStories` | Country-story layout and dialog button |
| `routeText` | Route layout and dialog route controls |
| `serifAtlas` | Serif-map control/rendering |
| `asciiClouds` | ASCII cloud outlines; restores the blurred sprite blobs |

Example: `/?noflags=worker`, `/?noflags=asciiClouds`, or
`/?noflags=countryStories,routeText,serifAtlas`.

`sw.js` uses `atlas-of-the-curious-v3`, invalidating the previous cache-first
JavaScript cache. Its CORE list includes labels, sea, clouds, text-worker and map-art,
and retains the reader/notebook modules. The offline check also found that the
pre-existing CORE list omitted `vendor/pretext/generated/bidi-data.js`; that
transitive dependency is now precached too. The CORE list covers every direct
and transitive JavaScript import of map, map-art, text-worker, sea and labels.
CSP was not loosened. New runtime
modules use same-origin imports only.

## Verification

Commands:

```sh
pnpm build-map
pnpm build
pnpm validate
pnpm smoke
node scripts/checks/run-sea.mjs
node scripts/checks/run-map-art.mjs
```

The original implementation's validation outcomes are recorded below. Browser tests
require a working Playwright Chromium installation and permission to launch it.
During the original implementation, Chromium could not start in the Codex
sandbox; those browser checks were run outside the sandbox with approval.
These historical results do not certify the merged revision. No dependencies
were installed or upgraded.

`pnpm smoke` retains all earlier checks and adds the sea checks and basic
country/route/serif checks. `run-map-art.mjs` additionally checks 4× CPU serif
performance, actual painted-label clearance, offline worker reload, geolocation,
phone/reduced-motion behavior, and writes screenshots to `docs/screenshots/`.
Timing is a local headless-Chromium regression measurement, not a guarantee for
all hardware. Firefox/Safari and real-device visual/performance testing were not
performed.

## Integration verification — 2026-09-11

- `node --check` passed for every JavaScript file changed across the two phases
  and the integration, including both check modules and `sw.js`. Every new
  named helper was found with `rg`, and all added runtime/check lines from both
  phase commits survive in the merged files.
- `pnpm validate` exited 0: all 40 places passed dataset validation, but the
  browser text/locale checks were skipped because Chromium could not launch.
- `pnpm build` passed and regenerated 40 place pages without changes.
- `pnpm build-map` passed after copying the existing ignored Natural Earth
  input into this worktree. `git status --short -- js/landmap.js` was empty
  afterwards, and the file matches Phase 7 byte for byte.
- `node scripts/checks/run-map-art.mjs` and `pnpm smoke` both exited 1 before
  running browser assertions: Chromium could not launch in this sandbox
  (`browserType.launch: Target page, context or browser has been closed`).
  Browser verification of the merged revision remains to be run outside it.
- The two conflicting Phase 7 screenshots match `2beb714`; both Phase 8
  screenshots match `5a33022`. No screenshots were regenerated during these
  failed browser launches.
- The service-worker cache is v3. All 15 modules in the map's transitive import
  graph are in CORE, and all 30 CORE assets exist. `git diff --check` passed.

The initial pnpm run tried to install dependencies and failed on registry DNS.
Subsequent runs used a local copy of the already installed dependencies with
`pnpm_config_verify_deps_before_run=false`; no dependency versions changed.
The original worktree's Git metadata is read-only outside this sandbox's
writable directory, so the merge is committed using `.merge-git/` inside the
worktree and exported as `integration-p7-p8.bundle`. Importing that commit into
the original branch requires a Git operation outside this sandbox.

## Original implementation verification results

- Dataset validation and page generation: passed, 40 places and 40 generated pages.
- Text agreement/overflow and locale checks: passed at 320, 768 and 1280 px.
- Earlier-phase regression checks: map labels (both zoom tiers), native names,
  grid prediction/FLIP/scroll anchoring/search, all 40 dialogs at three widths,
  reader at six sizes, print pagination, notebook persistence/privacy/copy and
  phone daily card passed in the integrated run.
- Country/route checks: complete stories for all 40 places with both backends;
  dialog controls, dateline routing, marker/land-mask stability, resize passed.
- Extended map checks: painted place/ocean label clearance at 2.5× zoom,
  coincident/antipodal routes, actual geolocation, offline worker/serif reload,
  phone and reduced-motion behavior passed.
- The original serif palette counts and glyph string are superseded by the
  Phase 8 measurement-parity fixes above; they used rounded, unscaled cells.
- The original serif timing comparison (27.22 ms average / 33.40 ms p95 versus
  idle 27.78 ms / 33.40 ms, baseline 16.67 ms) is **invalid**: clicking the toggle
  moved the pointer and ended idle mode. It is not evidence for the new 1.25×
  average/p95 gates or the additional 2× vsync ceilings.
- Serif toggle persistence: on after an offline reload, off again after being
  turned off and reloaded, with the palette rebuilt from the cached worker
  modules and no network.
- Desktop and phone screenshots inspected; corrected inset stacking so marker
  circles cannot paint over or receive clicks through the reading panel.
- `docs/screenshots/phase8-serif.png` (1280×800) and
  `phase8-serif-zoom.png` (the same view at 2.5× zoom) were inspected. At 2.5×
  the map plainly reads as an atlas set in a serif face: Africa comes out as
  `ÈZüL†××××†LüZÈ`, a dark lettered coast around a lighter interior. At 1× the
  continents stay recognisable — the coastal outline carries them — though the
  overall texture is busier than the monospace map, since a proportional face
  has no glyph as quiet as a monospace `·`.
- Final integrated rerun: **`node scripts/smoke.mjs` passed (`smoke OK`)**.
- Final extended rerun: **`node scripts/checks/run-map-art.mjs --extra-only`
  passed**, including disabled feature flags and the editorial fallback.
- Final sea results: 20/20 clicked words opened the correct place on each
  backend; zero land/label/ocean-name/page-chrome collisions and zero
  self-overlap.
  Both zoom levels sustained six drifting sentences. At 4× CPU the worker run
  averaged 30.05 ms/frame and the fallback 28.72 ms/frame (33.33 ms budget).
  Worker main-thread layout calls were zero. Fallback calls are reliably
  observed during startup and only sometimes during the timed interval: once six
  sentences are adrift and merely moving, the fallback has nothing left to lay
  out, and a spawn may or may not fall inside a given 120 frames. The check
  therefore requires the sum across startup and the timed run to be positive,
  which is the correct assertion — not that layout happens while the sea is only
  drifting. Nine empty-water retries per click sweep were not
  counted as picks; all twenty actual picks succeeded.
- The generated map's original glyph/color arrays were compared with HEAD:
  unchanged on desktop and mobile. Country array dimensions/water indices pass.
- JavaScript syntax checks and `git diff --check`: passed.

The remaining roadmap phases are implemented with the geometry fallbacks
specified above. The original handoff reported no known failing checks; its
Claude worktree remains available for comparison.

The first integrated run caught empty idle water with the old corridor estimate.
After the corridor fix, all six slots filled before timing began. That exposed
an invalid test assumption: the fallback need not perform new layout calls
while cached sentences are only moving. The test now verifies positive fallback
layout calls across startup plus the timed interval, while separately enforcing
zero main-thread layout calls during worker-driven animation. Sea self-overlap
is also now a failing assertion, not just a reported count.

## Reviewing or continuing

1. Read the roadmap and this handoff, then `git diff` and `git status --short`.
   Preserve both phases when making further changes. Do not accidentally stage
   the original `.claude/` directory.
2. Run the commands above. No build step downloads geography; place pages remain
   generated with the existing script. `pnpm build` does not rebuild the map,
   so changes to map generation require `pnpm build-map` explicitly.
3. Visual examples are in `docs/screenshots/`. Verify the regional inset and route
   caption behavior before changing typography or the map grid resolution.
4. Country silhouettes already scale independently of the coarse land grid.
   Further reading-view work should preserve the complete-story inset/caption
   fallbacks for Chile and for short phone map bands.
