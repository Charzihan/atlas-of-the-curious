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

- `scripts/build-map.mjs` now emits `countryCodes`, `countryNames` and a flat
  `countries` index per desktop/mobile cell; zero is water, other values are
  one-based entries in `countryCodes`. Existing glyph/color output is unchanged.
  The ownership follows the generator's existing sampled-country assignment.
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

Country stories try 9, 8, 7 and 6 px type against per-row country spans. Small
text can be enlarged with the existing map zoom. A story that does not fit in
full uses a 12 px regional inset near its marker; if even that cannot fit the
map height, the full story is shown in a caption below the map. The complete story also has a screen-reader text equivalent. Nothing is
silently truncated. At the tested 1280×800 size, **1 of 40 stories fits a
silhouette and 39 use regional insets**. The current coarse 150×39 grid cannot
provide large reading silhouettes for most countries. This is a deliberate,
tested fallback, not forty country-shaped stories at that size.

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
