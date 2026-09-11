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

The map control **Serif map** re-sets the map in the site's Georgia face
(`--font-serif`). The first pass of this phase shipped a hand-ordered list of
fourteen glyphs whose "tone" was its index, which produced a map that was
indistinguishable from the monospace one. The palette is now measured.

**The palette** (`palette()` in `js/map-art.js`). The candidates are printable
ASCII, the printable half of Latin-1, and the typographic marks a WGL4 face
such as Georgia also carries (`† ‡ • ≈ ∞ œ Œ – — ‰`); 198 in all. Each is
rendered once into an `OffscreenCanvas` in the worker — a hidden DOM canvas on
the synchronous fallback host — at the map's own cell size, drawn exactly as
`repaintBase` draws it, and its ink is summed from the alpha channel. That
gives two numbers per glyph: `coverage`, the share of the cell it inks, and
`spill`, the share of its ink that lands outside the cell. Its advance comes
from `prepareWithSegments`, the same measurement pretext lays text out with.

A glyph is usable if its advance fits the cell (narrower is fine and is centred;
wider is rejected, because that is what would put the ink out of step with the
markers) and if it spills no more than 6% of its ink into the neighbouring rows.
141 of the 198 survive that at the desktop cell size. A glyph the resolved face
does not have is dropped first: it is detected by measuring an unassigned
private-use code point and discarding anything that matches that notdef box, so
the atlas is set in one face rather than in whatever the browser would
substitute. Coverage is then normalised 0..1 over the usable set, so tone 0 and
tone 1 are that cell's real lightest and darkest ink.

The ramp has **24 rungs**. Each is the glyph minimising
`|coverage − target| + 0.4 · max(0, (cellWidth − advance) / cellWidth)` among
those darker than the rung below it, leaving one candidate behind for every rung
still to come — so the ramp is strictly increasing in measured coverage and no
rung repeats its neighbour. At 1280×800 it comes out as
`¬÷=+<>×*«≈†}oLT4üFµZEÉÈË`, coverage 0.125 to 0.994. The whole thing is built
once per geometry and font and cached in the engine; nothing measures inside a
frame.

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
onto the 24-rung ramp per cell per frame, so crests and troughs read as one
continuous tone. The gamma is there because a 24-rung ramp mapped linearly makes
quiet water much heavier than the monospace floor. The still sea floor on the
base canvas is tonal too, taken from the same static regional bias the wave
trains use; under reduced motion, where the fluid layer never draws, that static
tonal sea is the whole sea.

The toggle is remembered in `localStorage` under `atlas:serif-map` (every access
wrapped, including the property read, which throws outright in a browser with
site data blocked). `aria-pressed` reflects it, and `serifAtlas` still gates
both the control and the rendering. Land mask, cell positions, marker
coordinates and zoom are identical in both modes; labels, hover cards and the
readable sea sentences keep their own measured fonts. No new files, so `sw.js`
is unchanged and still accurate. No inline style attributes, no `eval`.

`ATLAS_MAP_ART.debug()` exposes `palette` (the ramp with its measured coverage
and advances, without the per-cell array) and `base` — the base canvas's
resolved font string and the multiset of land glyphs it last painted — so the
checks can assert on what was actually drawn rather than diff pixels.

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
- Serif palette checks (both backends, identical results): 24 rungs from
  141 usable of 198 candidates, coverage 0.125→0.994 strictly increasing, every
  rung's advance within the cell, no rung repeating its neighbour; the base
  canvas font resolves to the serif family, the land glyph multiset differs from
  the monospace one and the land mask is unchanged across the toggle.
- Serif + idle at 4× CPU: 27.22 ms average / 33.40 ms p95, against **idle mode
  in monospace under the same 4× throttle** at 27.78 ms / 33.40 ms; unthrottled
  baseline 16.67 ms; zero main-thread layout calls. The like-for-like comparison
  is the roadmap's own bar ("holds frame rate under the same throttle as idle
  mode"); the unthrottled baseline is vsync-capped at ~16.7 ms, so twice it is
  really "30 fps at 4× CPU" — a line monospace idle mode itself sits on, which
  made that bound a coin flip rather than a measurement of the serif ink. It is
  retained as an alternative, not as the sole gate.
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
