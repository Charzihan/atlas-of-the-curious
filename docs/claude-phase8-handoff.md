# Claude handoff — Phases 5, 7 and 8

Date: 2026-09-10. Branch: `pretext-roadmap`. Starting HEAD: `8103e5b`
(Phase 6). Changes are in the working tree; no commit, merge, push or deployment
was performed. Preserve the original `.claude/` worktrees and
`claude-Phase5-handoff.txt`; neither was edited.

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
- `js/text-worker.js`: same-origin module worker, with init/geometry/placement,
  hover, idle and map-art messages. Idle position arrays use transferable buffers.
- `js/map.js`: asynchronous backend, drawing, fading, hit testing and main-thread
  fallback using the same engines. `ATLAS_MAP_DEBUG` exposes diagnostics.
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

## Phase 7 — Shapes and paths

- `scripts/build-map.mjs` emits `countryCodes`, `countryNames` and a flat
  `countries` index per desktop/mobile cell; zero is water, other values are
  one-based entries in `countryCodes`. Existing glyph/color output is unchanged.
  The ownership follows the generator's existing sampled-country assignment.
- It also emits `outlines`: simplified lon/lat rings for the 31 countries the
  dataset names (it runs `js/data.js` to find them, through the same alias
  table `js/map.js` uses). Rings are pruned to the cluster around the largest
  one — so the Aleutians, Svalbard, the Galapagos and Easter Island do not
  swallow the bounding box, while Indonesia, Japan and New Zealand stay whole —
  simplified with Douglas–Peucker at a tolerance proportional to the country's
  own size, quantised to 1/50 of a degree and delta-encoded as integers.
  That is +11 KB in `js/landmap.js` (41,891 → 53,248 bytes) for 1,592 points.
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
water, and the runs at five heights across the row are intersected so the whole
line box is inside — become the widths fed to `layoutNextLineRange`. Several
runs in one row are several slots, so a row that crosses two islands sets two
pieces of the story. A run that cannot hold the next *whole* word is left empty
rather than breaking the word: that is the minimum-run rule, measured against
the word actually coming rather than against a fixed number of cells.

Type sizes are tried at 14, 13, 12, 11 and 10 px; the first that fits at the
largest scale the map allows is kept, and then a binary search finds the
*smallest* k that still holds the whole story, which is the k that fills the
shape. The view is anchored on the country's true position and slid only as far
as it must to stay on the map and clear of the introduction panel and the map
controls (`js/map.js` measures those once per request and passes them as
`avoid`). The place's own coordinates are marked inside the silhouette; the
outline is stroked in the country's palette colour and stamped with the grid's
texture character at the grid's own cadence, over a dimmed map.

At the tested 1280×800 size, **37 of 40 stories fill their country's
silhouette and 3 use the regional inset** — `marble-caves`, `atacama` and
`rapa-nui`, all Chile. Chile is 4,300 km long and about 180 km wide: scaled to
the map's height it is a 100 px-wide ribbon whose rows hold roughly a third of
the words, and scaling it to the map's width would make it nine screens tall.
Rapa Nui is 3,500 km offshore and is dropped from Chile's rings for the same
reason the Aleutians are dropped from America's. On a phone the map band is too
short for a silhouette at 10 px, so phones keep the inset. A story that fits no
silhouette uses a 12 px regional inset near its marker; if even that cannot fit
the map height, the full story is shown in a caption below the map. The
complete story also has a screen-reader text equivalent. Nothing is ever
silently truncated: `scripts/checks/map-art.mjs` asserts that the lines
concatenate back to the story, that every line box is inside the polygon, that
the type never drops below 10 px, and that at least 34 of the 40 are
silhouettes.

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

The map control **Serif map** toggles a Georgia glyph palette for land and the
fluid sea. `prepareWithSegments` measures advances; palette selection scores
both density and distance from the existing cell width. Narrow glyphs are
centered in their cells. The land mask, marker coordinates and zoom stay fixed.
The sea reuses the existing wave/ripple simulation and changes its ink. Labels
and readable sea sentences keep their own measured fonts. Palette generation
happens once per geometry/font, not in the animation loop. Reduced-motion mode
has no autonomous fluid animation.

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

Example: `/?noflags=worker` or
`/?noflags=countryStories,routeText,serifAtlas`.

`sw.js` uses `atlas-of-the-curious-v2`, invalidating the previous cache-first
JavaScript cache. Its CORE list includes labels, sea, text-worker and map-art,
and retains the reader/notebook modules. The offline check also found that the
pre-existing CORE list omitted `vendor/pretext/generated/bidi-data.js`; that
transitive dependency is now precached too. CSP was not loosened. New runtime
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

The final validation outcomes are recorded below after execution. Browser tests
require a working Playwright Chromium installation and permission to launch it.
In the Codex sandbox Chromium could not start; browser checks were run outside
the sandbox with approval. No dependencies were installed or upgraded.

`pnpm smoke` retains all earlier checks and adds the sea checks and basic
country/route/serif checks. `run-map-art.mjs` additionally checks 4× CPU serif
performance, actual painted-label clearance, offline worker reload, geolocation,
phone/reduced-motion behavior, and writes screenshots to `docs/screenshots/`.
Timing is a local headless-Chromium regression measurement, not a guarantee for
all hardware. Firefox/Safari and real-device visual/performance testing were not
performed.

## Verification results

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
- Serif + idle at 4× CPU: 33.05 ms average / 33.40 ms p95 against a 16.67 ms
  baseline in the latest completed extended run; zero main-thread layout calls.
- Desktop and phone screenshots inspected; corrected inset stacking so marker
  circles cannot paint over or receive clicks through the reading panel.
- Final integrated rerun: **`node scripts/smoke.mjs` passed (`smoke OK`)**.
- Final extended rerun: **`node scripts/checks/run-map-art.mjs --extra-only`
  passed**, including disabled feature flags and the editorial fallback.
- Final sea results: 20/20 clicked words opened the correct place on each
  backend; zero land/label/ocean-name collisions and zero self-overlap.
  Both zoom levels sustained six drifting sentences. At 4× CPU the worker run
  averaged 30.05 ms/frame and the fallback 28.72 ms/frame (33.33 ms budget).
  Worker main-thread layout calls were zero; fallback calls were observed in
  warmup and the timed run. Nine empty-water retries per click sweep were not
  counted as picks; all twenty actual picks succeeded.
- The generated map's original glyph/color arrays were compared with HEAD:
  unchanged on desktop and mobile. Country array dimensions/water indices pass.
- JavaScript syntax checks and `git diff --check`: passed.

The remaining roadmap phases are implemented with the geometry fallbacks
specified above. There are no known failing checks at handoff. Changes remain
uncommitted; the original Claude worktree remains available for comparison.

The first integrated run caught empty idle water with the old corridor estimate.
After the corridor fix, all six slots filled before timing began. That exposed
an invalid test assumption: the fallback need not perform new layout calls
while cached sentences are only moving. The test now verifies positive fallback
layout calls across startup plus the timed interval, while separately enforcing
zero main-thread layout calls during worker-driven animation. Sea self-overlap
is also now a failing assertion, not just a reported count.

## Reviewing or continuing

1. Read the roadmap and this handoff, then `git diff` and `git status --short`.
   New runtime/test/docs files are untracked until added; do not omit them from
   a future commit. Do not accidentally stage the original `.claude/` directory.
2. Run the commands above. No build step downloads geography; place pages remain
   generated with the existing script. `pnpm build` does not rebuild the map,
   so changes to map generation require `pnpm build-map` explicitly.
3. Visual examples are in `docs/screenshots/`. Verify the regional inset and route
   caption behavior before changing typography or the map grid resolution.
4. Product follow-up, if desired: a larger country-detail view would allow more
   full stories to follow recognizable country silhouettes at readable sizes.
   That is beyond the original coarse-map geometry and has not been added here.
