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
pnpm validate    # dataset checks + headless text-overflow checks
pnpm build-pages # generate per-place share pages into places/<id>/
pnpm build       # dataset checks + build-pages (run before deploying)
pnpm smoke       # open the real page in headless Chromium at every viewport
```

`vendor` and `build-map` are already committed; re-run them only after upgrading
the dependency or changing the map grid settings. Run `pnpm build` after editing
`js/data.js` so the per-place share pages and the dataset stay in sync.

`pnpm validate` runs two stages: `scripts/validate-data.mjs` (pure Node — ids,
coordinates, required fields, native names and their BCP 47 tags, plus a count
of the distinct scripts in the dataset) and then `scripts/check-text.mjs`,
which needs a real font engine and so starts the dev server and opens
`test/text-check.html` and `test/locale-check.html` in headless Chromium. If
the browser is missing it prints the install command and exits 0, so the
dataset check still gates a commit; pass `--strict` to turn that skip into a
failure. `pnpm build` deliberately runs only the pure-Node dataset check, so
deploying never requires a browser.

`test/locale-check.html` is the evidence behind the locale-aware preparation:
for a Japanese, a Thai (no spaces at all), an Arabic and a Simplified-Chinese
sentence, at three widths, it compares the lines pretext computed with the
lines Chromium actually painted (read back a grapheme at a time with
`Range.getClientRects()`), and asserts that no Thai or Arabic break falls
inside an `Intl.Segmenter` word.

`pnpm smoke` loads `index.html` at 1280x800 and 390x844, waits for the text
metrics and the map, and fails on any console error or uncaught page error.
It also drives the map through `window.ATLAS_MAP_DEBUG` and checks that at
1.5x and 2.5x no label cell overlaps land, another place label or an ocean
name (verified twice: from the placement records and from the painted DOM
boxes mapped back onto the grid), that none of the 40 hover-card taglines ends
on a one-word last line, that a scripted zoom from 1x to 2.5x stays cheap, and
that the phone viewport renders no labels at all.

It then measures the grid: it asserts that all 40 predicted card tops and
heights match the rendered ones, that a filter change and a card expansion cost
no forced synchronous layout (every layout-forcing getter is wrapped in the
page and attributed to its caller, and Chrome DevTools Protocol `LayoutCount` /
`RecalcStyleCount` are sampled either side of a synchronously dispatched
click), that the hovered card keeps its on-screen position across a filter
change, that an expansion repositions each card at most once, and that the
fitted hero headline lands on exactly two lines. The map checks run first: the
grid checks scroll the grid to the top of the viewport, which pauses the map's
animation loop.

It then checks the second name every place now carries. For each of the 13
places whose native name is not Latin script it opens the hover card and reads
the painted line boxes back off the element: every break must land on an
`Intl.Segmenter` word boundary (grapheme boundaries for CJK). Because a short
name does not wrap in a real card, each name is then squeezed into a box
exactly as wide as its own widest word — wrapping forced, no word ever asked to
break — and judged again. Finally it runs five searches and asserts that every
highlighted tagline is painted as exactly the lines the rich-inline flow
predicted, with the grid still at zero mismatches while the search is active.

Finally it opens the detail dialog in three page visits of its own (360, 768
and 1280 px wide) and, for all 40 places at each width, asserts that every
hand-laid-out line box sits inside its column — checked twice, once against the
layout model and once against the painted DOM boxes — and that neither the
dialog, its body, nor the spread scrolls horizontally. At 1280 it asserts that
no river (a chain of vertically aligned word gaps) runs longer than three lines
and prints the worst case; it presses ArrowRight and samples the dialog body's
height every frame, requiring a mid-flight value strictly between the start and
end heights; it checks that Escape still closes and `#/place/<id>` still opens;
and it checks the accessibility contract — the visually hidden paragraph still
carries the whole story, the field note its whole text, every generated line
span is `aria-hidden`, and the dialog is still labelled by its title.

Finally it reads. `scripts/checks/reader.mjs` opens the field guide in six page
visits of its own — 1280x600, 800, 1000 and 1200, 390x844, and one deliberately
cramped 1280x380 where a story *has* to run over a page boundary — and walks
**every** page with `goTo()`. For each page: it may not overflow its box
(`scrollHeight <= clientHeight`) and every line box in it must sit inside it.
For each place: the lines of its story, concatenated back across its pages, must
be that story (compared with whitespace stripped from both sides, because a line
broken after a real hyphen — "flash-" / "melt" — carries no space to rejoin on),
and the body-line indices its pages carry must be `0, 1, 2, …` exactly, which is
what makes "nothing lost, nothing duplicated" countable rather than plausible.
No paragraph that spans a page boundary may leave fewer than two of its lines on
either side of it. Two places are given saved notes first, so the pre-wrap path
(hard breaks and tabs) is exercised too.

It then prints: `emulateMedia({ media: "print" })` must put the reader into
print mode by itself, render *all* the pages instead of three, give each one
`break-after: page`, keep the same page height, and assign exactly the same
lines to exactly the same pages as the screen did — `debug().perPage` compared
field by field. Clearing the media query must put it back to three.

Then the notebook: it types 141 characters into it and asserts that the
textarea's painted height is the predicted height to within half a pixel, that
the text does not overflow the box, that **no** layout-forcing read comes from
`js/dialog.js` or `js/reader.js` during the typing (the read-counter pattern,
attributed to those two files) and reports what the typing cost in CDP
`LayoutCount`. The note must not reach `location.href`, the share link, any
request the page makes, or the generated `places/<id>/index.html` (read back off
disk). A reload must restore it, the reader must set it, "Clear" must empty it,
and "Copy as postcard" must put exactly the expected text on the real clipboard,
read back with `navigator.clipboard.readText()`. Last, the daily card at 390px:
its name on at most two lines — for the name today picked, and for all 40 names
it could have picked, measured in the very same box.

Run it after any change to the layout, the fonts or the map.

## Features

- **40 places** across 7 categories (geology, coastal, deserts, forests,
  glaciers, sacred sites, urban oddities), each with a story, a field note, a
  best time to visit, the nearest major city, and its name in the local
  language and script.
- **Names in their own script**: every place carries a `nativeName` and a
  `nativeLang` — 张家界国家森林公园, البتراء, អង្គរវត្ត, ཐིམ་ཕུག, සීගිරිය,
  渋谷スクランブル交差点, Vịnh Hạ Long, Puszcza Białowieska — shown under the
  Latin name on the card, in the hover card, in the dialog and on the generated
  share page, and as the middle line of the map label from 2.4×. Each span
  carries its own `lang` and a `dir` taken from pretext's per-segment bidi
  levels (an odd embedding level on the first strong segment means right to
  left), not from a guess about the tag. Seven scripts, eight right-to-left
  names.
- **Search matches, picked out**: while a search is running a card's tagline
  stops being one string the browser wraps and becomes a pretext *rich-inline*
  flow over two fonts — the tagline role and its bold variant. The card's
  predicted height is that flow's line count, and each line is painted as its
  own block, so the browser has no wrapping decision left to make and the grid
  stays at zero mismatches mid-search. Clearing the search restores the plain,
  balanced tagline.
- **The Text Atlas**: an ASCII world map — land drawn from real Natural Earth
  coastlines, every marker projected from its own lat/lon, name labels
  word-wrapped by pretext (measured with the browser's own font engine, no
  DOM reflow). Hover a marker for a live field readout; click to open the
  detail dialog. The corresponding grid card lights up on hover.
- **Coastline-routed place labels**: each name is poured into the *free water
  cells* beside its dot. Eight anchor directions are tried at growing offsets;
  for each one the free run of sea is read row by row off the land grid and fed
  to pretext's variable-width router (`layoutNextLineRange`, the routine its
  dynamic-layout demo uses to flow text around a floated image), so a label
  hugs the coast instead of crossing it. Candidates are scored on line count,
  distance from the dot and collisions; a name that cannot be fitted anywhere
  nearby is simply not drawn. Nothing ever overlaps land, another label or an
  ocean name — `pnpm smoke` asserts exactly that.
- **Zoom-level typography**: no labels below 1.4x, the name from 1.4x, and the
  name, the native name and the tagline from 2.4x. Each string is prepared
  once; a zoom change re-runs only the routing, debounced to at most one
  placement per frame. The native line is routed like any other and dropped
  (rather than crossing land) when the water beside the dot is too narrow for
  it, so the "nothing overlaps anything" assertion is unchanged.
- **Ocean names in spaced capitals**: oceans and seas set in tracked uppercase,
  with the tracking opening from 0.18em to 0.3em as you zoom in. They claim
  their cells before the place names are routed, so the names flow around them.
- **A sky drawn in the same alphabet**: the clouds are ASCII drawings on the
  character grid, not blurred blobs — a closed outline of `.` `-` `_` `(` `)`
  `~` with the soft white cloud poured into the blank interior:

  ```
        .--.
     .-(    ).
    (__________)
  ```

  `js/clouds.js` generates every one of them (three to six overlapping lobes on
  a small cell raster, or one of four hand-drawn templates stretched, mirrored
  and jittered), then traces the silhouette's boundary into those glyphs; no two
  clouds in the sky are the same drawing, and every few seconds one of them
  regenerates from its own seed and cross-fades into the new outline, so the sky
  is never the same twice. The drawing is snapped to whole cells, columns and
  rows, so it lines up with the land beside it; only the soft mass inside keeps
  the sub-cell drift. Over Antarctica, where white on white ice would be
  nothing, the ink turns slate blue.
- **Pan & zoom** the map (buttons, wheel, or drag); markers and labels stay a
  constant on-screen size so you can zoom into the glyph detail — which is
  what buys the higher zoom tiers the room to show more text.
- **A hover card that hugs its text**: the card's width is measured from its
  own content (the shrink-wrapped tagline, the name, the location, the coords)
  rather than fixed in CSS, and the card refuses to leave a one-word last line
  — it re-wraps the tagline until the last line has company. The measured
  width is what decides which side of the marker the card opens on.
- **Locate me**: drop a "you are here" marker from your GPS position and label
  the nearest wonder with its distance, then sort the list by distance.
- **A predictive masonry grid**: every card's height is arithmetic before a
  single pixel is laid out — fixed chrome measured once at boot from one probe
  card, plus pretext's height for the name, location, tagline and link. The
  layout pass does writes only (no `offsetHeight`, no `getBoundingClientRect`),
  so filtering the grid costs zero forced synchronous layouts.
- **Cards that glide**: because the new slots are known before the DOM changes,
  each card animates from its old position to its new one (FLIP, via the Web
  Animations API). Cards leaving the filter fade where they stand; cards
  entering rise into their slot. `prefers-reduced-motion` gets a plain swap.
- **The card under your cursor stays put**: when a filter, search or sort
  reflows the grid, the hovered (or keyboard-focused) card keeps its on-screen
  position — the page is scrolled by the card's predicted displacement in the
  same frame as the layout write, before paint.
- **Balanced, fitted text**: taglines, names and location lines are
  shrink-wrapped to the narrowest box that keeps their line count, so the last
  line carries its share of the words; long names step down a size (1.15 →
  1.05 → 0.95rem) until they fit on one line; and the hero headline is fitted
  at every viewport width so it always lands on exactly two whole-word lines
  (three on a phone).
- **Expand a card in place**: on wide screens, clicking a card's body (or
  Enter/Space on a focused one) opens the story and field note inside the grid
  — the card's height animates and its neighbours slide in the same frame,
  from a predicted height. Deep links and phones still use the modal.
- **Live search** across names, countries, regions, full story text, and the
  new best-time / nearest-city fields.
- **Category filter chips** with per-category counts, plus sorting
  (featured, A–Z, country, distance from me).
- **Shareable filter state**: search, category, and sort live in the URL
  (`?cat=desert&q=salt&sort=name`), so a reload restores the view and links
  carry the filter.
- **Surprise me**: open a random place from the current filter.
- **The story as a spread**: the detail dialog does not render the story as a
  paragraph — it typesets it. A drop cap three lines tall that the opening
  lines route around; the field note lifted into a pull-quote box that the body
  text flows past; two columns from a 900px viewport, the right one resuming
  from the left one's cursor with the split chosen so each column carries its
  share of the paragraph. Lines are absolutely positioned spans at coordinates
  pretext computed; the container's height is known before anything is painted.
- **Justified columns, with the rivers counted**: on wide screens the columns
  are set by a Knuth-Plass line breaker (ported from pretext's
  justification-comparison demo into `js/justify.js`) whose badness function
  costs the cube of the space-stretch ratio plus explicit penalties for rivers,
  over-tight lines and hyphenated breaks. Each word is positioned individually,
  so the gaps are exact — which is what lets the same code chain them into
  rivers and pick, from three candidate column widths (the natural one and
  ±6%), the one whose longest river is shortest. `pnpm smoke` asserts no river
  runs longer than three lines, for all 40 stories.
- **Soft hyphens for the long names**: a small hand-written dictionary
  (Białowieża, Zhangjiajie, Jökulsárlón, Vatnajökull, Kilimanjaro, …) is
  applied to the title and the story at render time. Pretext treats U+00AD as
  an optional break — invisible unless taken, and painted as a trailing `-`
  when it is. The dataset never sees a soft hyphen, and neither do the
  accessible copies, so find-in-page keeps matching.
- **Metadata as inline chips**: "best time to visit" and "nearest major city"
  are flowed with pretext's `prepareRichInline` helper. Month ranges (`Dec–Mar`,
  `April–June`) and distances (`≈ 260–400 km`) become atomic pills — `break:
  "never"` plus the pill's padding as `extraWidth` — and every fragment is
  painted at its computed offset, so the wrap is exact and the field's height
  is part of the dialog's predicted height.
- **Detail dialog** with keyboard support (Esc, ←/→ to move between places).
  Stepping animates the dialog body from its current height to the incoming
  one — computed before anything is rendered — and swaps the content at the
  midpoint. Lines then arrive one at a time, about 28ms apart, capped so even
  the longest story has finished inside 1.2s. `prefers-reduced-motion` gets
  both at once, with no animation.
- **Read as a book**: a button in the hero turns the *whole current filter*
  into a paginated field guide. Every place starts a new page with its name,
  its native name, its country and region and its tagline, and its story and
  field note are flowed at a comfortable measure through pretext's own cursor
  (`layoutNextLineRange` / `materializeLineRange`) — so the page count is exact
  the moment the mode opens, before a pixel is painted. The page box is the
  reader's content height rounded *down* to a whole number of body lines, read
  once on open and once on resize, so a line can never be cut in half by the
  page edge. A running footer carries the place and "page 12 of 37"; ← → and
  PageUp/PageDown turn pages, Home/End jump, and clicking the outer third of a
  page turns it (the middle third is left alone, so the text there can still be
  selected). Only the current page and its two neighbours are ever in the DOM.
  A place's first page is a real URL: `#/read/<id>`, rewritten with
  `history.replaceState` as you turn.
- **No widows, no orphans**: the pagination knows every line of a paragraph
  before it closes a page, so the rule is a lookahead rather than a guess — a
  paragraph that runs over a page boundary leaves at least two of its lines on
  each side of it, and a "Field note" label is never stranded at the foot of a
  page with its text overleaf.
- **Print what you see**: printing (or a print preview) makes the reader render
  every page instead of three, each with `break-after: page` and *the same*
  pixel geometry it has on screen — the same page height, the same lines on the
  same pages. `pnpm smoke` compares the two page-by-page.
- **A visitor's notebook**: under the metadata in the detail dialog, a box for
  your own notes. Its height is a *prediction*, not a measurement: every
  keystroke lays the text out in pretext's `pre-wrap` mode at the box's known
  measure and the line count becomes the height, so the box grows and shrinks
  with the text without a single `scrollHeight` read. Notes are saved to
  `localStorage` (debounced, keyed by place id), restored on open, shown
  read-only at the end of that place's pages in the field guide, and never
  touch the URL, the share link, the generated share pages or any request.
  "Copy as postcard" puts the place, its native name, its country, its
  coordinates and your note — line breaks and tabs intact — on the clipboard.
- **Daily pick**: a deterministic-of-the-day place (UTC), the same for every
  visitor on the same calendar day — no server state needed. On a phone the
  card stacks (symbol and name on one row, tagline below, "Open →" last)
  instead of squeezing the name into a column two words wide.
- **Shareable URLs, two ways**: `index.html#/place/<id>` deep-links open
  straight into a place's detail view, and `pnpm build-pages` generates a real
  `places/<id>/` page per place (its own title, meta, and Open Graph tags) that
  is indexable and works on any static host with no rewrites.
- **Offline**: a service worker caches the site so it stays usable after the
  first visit; a web-app manifest makes it installable.
- **Performance**: the map animation and ambient ripples pause when the map
  scrolls out of view and resume seamlessly.
- Fully responsive, dark "atlas" theme, no external fonts or images.

## Text metrics and the font role registry

Every piece of text the site needs to reason about (rather than merely paint)
belongs to a **font role**. The roles live in `css/style.css` as three custom
properties each — `--font-<role>` (a CSS `font` shorthand), `--lh-<role>` and
`--ls-<role>` — and the rules that render them are written in terms of those
same variables, so the painted font and the measured font cannot drift apart:

```css
--font-card-name: normal 1.15rem var(--font-serif);
--lh-card-name: 1.55;

.card h3 { font: var(--font-card-name); line-height: var(--lh-card-name); }
```

Phase 3 added three more of them — `dropcap` (measured at whatever size makes
the cap exactly three body lines tall), `field` and `field-chip` (the plain
runs and the pills of the metadata flows) — and every one is still declared in
the CSS and consumed by the rule that paints it.

Phase 4 added four: `native-name` (the hover card's and the dialog's second
line), `card-native` (the grid card's), `map-label-native` (the map label's
middle line — the `map-label` font, never uppercased) and
`card-tagline-strong` (the bold half of a highlighted search match: the same
family and size as `card-tagline`, one weight up, so the rich-inline flow can
measure the two runs against each other).

Phase 6 added the four the field guide sets — `book-body` (whose line height is
the quantum the whole book is measured in: a page is a whole number of these),
`book-title`, `book-meta` (the "COUNTRY · REGION" line, uppercased in JS before
it is measured rather than by `text-transform`, because the two are not the
same string) and `book-tagline` — and finally gave the long-declared `notebook`
role an element to paint: the `<textarea>` and the reader's copy of a saved
note. Twenty-three roles in all.

**Text a visitor typed.** A note is textarea text: ordinary spaces, `\t` tabs
and `\n` hard breaks all have to survive, which is pretext's
`{ whiteSpace: "pre-wrap" }`. The same (role, text) pair means something
different in the two modes, so `heightOfPreWrap`, `lineCountOfPreWrap`,
`linesOfPreWrap` and `handleForPreWrap` keep their handles in a bucket of their
own and never disturb the normal-flow handle for the same string. The CSS has
to ask for the same thing the measurement did — `white-space: pre-wrap` and
`tab-size: 8`, the default pretext models — and the box must never grow a
scrollbar, which would silently steal width from the measure.

**Text in another language.** pretext segments through `Intl.Segmenter`, which
is locale-sensitive — Thai has no spaces at all and is broken by dictionary —
so a native name has to be prepared under its own locale. `setLocale()` is
global and clears pretext's shared measurement caches (already-prepared handles
stay valid), which makes calling it per render ruinous. `js/text.js` therefore
takes the strings in two steps: `prepareLocalized(role, id, text, { locale,
wordBreak })` *queues* one, and `flushLocalized()` prepares the whole queue
grouped by locale — `setLocale(locale)` once per group, then a single
`setLocale()` back to the default before anything else in the page is prepared.
CJK tags are queued with `wordBreak: "keep-all"`, and the rules that paint them
carry the matching `word-break: keep-all` (via a `data-wb` attribute), so the
measurement and the CSS are asking for the same thing. `directionOf(role, id,
lang)` answers "which way does this run?" from the prepared handle's
`segLevels`, with the language tag only as the fallback for a string with no
strong RTL character.

One caveat worth stating plainly: `word-break: keep-all` turns an overlong CJK
run into a single unbreakable word, and the break then falls to
`overflow-wrap`, which pretext documents as approximate — Chromium and pretext
do disagree there. `test/locale-check.html` measures that disagreement and
reports it (it does not fail on it), and `pnpm smoke` asserts that no native
name in the dataset is long enough to reach that path in the card a reader
actually sees.

`js/text.js` reads the registry once at boot, resolves `rem`/`em` into `px`,
turns each shorthand into a canvas font string and hands the result to
`createMetrics()` — a pure factory that touches neither `document` nor `window`
(so a later phase can move it into a Web Worker). It answers `heightOf`,
`linesOf` and `tightWidth` for text registered by place id, the same three for
arbitrary strings (`heightOfText`, `linesOfText`, `tightWidthOfText`), and
`fontFor`. The instance is published as `window.ATLAS_TEXT` together with an
`atlas:text-ready` event, because `js/app.js` is a classic script and cannot
import a module.

When a caller has to lay the lines out itself rather than ask how tall they
are — the dialog's justified columns need each segment's width, each break's
kind and the discretionary hyphen's width — `handleFor(role, id)` and
`handleForText(role, text)` hand back the underlying
`prepareWithSegments()` handle, upgrading a height-only entry in place so
nothing is ever prepared twice.

Two rules make the numbers trustworthy: the canvas font string must match the
CSS exactly, and a font stack may only name real faces — a generic keyword such
as `ui-monospace` can resolve to a different face in a canvas 2D context than in
CSS, which would silently poison every measurement.

Served from `localhost` (or with `?debug=metrics` in the URL), the module
re-measures the first five cards after the first render and warns in the console
if pretext and the browser disagree by more than one line height.

**Feature flags.** `window.ATLAS_FLAGS` carries the defaults from `js/text.js`;
`?flags=a,b` turns features on and `?noflags=a,b` turns them off. Every flag is
on unless it is explicitly turned off, so a phase can be bisected in the
browser without a rebuild:

| flag | owner | off means |
| --- | --- | --- |
| `metrics` | `js/text.js` | no `window.ATLAS_TEXT`; the map falls back to its own wrapping |
| `labels` | `js/map.js` | no place-name labels on the map |
| `oceanLabels` | `js/map.js` | no ocean or sea names |
| `hoverFit` | `js/map.js` | the hover card stays at its maximum width instead of shrink-wrapping |
| `predictiveGrid` | `js/app.js` | arithmetic card heights off; the grid falls back to the original measured layout |
| `flip` | `js/app.js` | no glide — cards jump straight to their new slot |
| `scrollAnchor` | `js/app.js` | the card under the cursor no longer keeps its place across a reflow |
| `fitText` | `js/app.js` | no balanced taglines, no fitted names, no fitted headline |
| `expandInPlace` | `js/app.js` | clicking a card opens the modal instead of expanding it in the grid |
| `openOcean` | `js/map.js` | the sea stops at the edge of the world grid again, in uniform sine trains instead of currents |
| `editorial` | `js/dialog.js` | no `window.ATLAS_DIALOG`; the dialog falls back to `js/app.js`'s plain paragraph rendering |
| `justify` | `js/dialog.js` | the wide-screen columns stay ragged-right instead of being justified |
| `reveal` | `js/dialog.js` | the laid-out lines appear all at once instead of one at a time |
| `hyphens` | `js/dialog.js` | no soft hyphens are injected into long names |
| `chips` | `js/dialog.js` | the two metadata fields stay plain text instead of a rich inline flow |
| `dialogAnimate` | `js/dialog.js` | prev/next swaps the content without animating the body's height |
| `nativeNames` | `js/text.js` | no second name anywhere — no card line, no hover-card line, no dialog line, and the map label goes back to name + tagline |
| `searchHighlight` | `js/app.js` | a search leaves the taglines as plain, balanced text instead of flowing them with the matches bold |
| `localeText` | `js/text.js` | native names are prepared at the page's own locale instead of each place's (the `word-break` option is still applied) |
| `worker` | `js/map.js` | label and sea layout run on the main thread instead of in `js/text-worker.js` (same engines, same answers, counted by `ATLAS_MAP_DEBUG.mainThreadLayoutCalls()`) |
| `seaStories` | `js/map.js` | no tagline spills into the water on hover, and no field note follows when the place is opened |
| `idleSea` | `js/map.js` | no sentences drift after twelve idle seconds |
| `seaClick` | `js/map.js` | a drifting word no longer brightens under the pointer or opens its place when clicked |
| `asciiClouds` | `js/text.js` | the sky goes back to the blurred radial-gradient blobs (and back to fading out over Antarctica) instead of ASCII drawings |
| `bookMode` | `js/reader.js` | no `window.ATLAS_READER`, no `#/read/<id>` route, and the "Read as a book" control is not offered at all |
| `notebook` | `js/dialog.js` | no notes box in the dialog and no saved note in the field guide (anything already in `localStorage` is left untouched) |

For example `?noflags=labels,oceanLabels` gives the pre-Phase-1 map, which is
also what `pnpm smoke` loads to get a frame-timing baseline.

**Routing text through a ragged column.** `js/text-route.js` is the piece of
the label engine worth reusing: given a pretext `prepareWithSegments()` handle
and one available width per row, it lays the text out a row at a time and
reports whether the whole string survived (a candidate that would have to break
a word mid-word is rejected rather than drawn). It imports the vendored layout
kernel and nothing else — no `document`, no `window` — so it can move into a
Web Worker unchanged.

**Map debugging.** Served from `localhost` (or with `?debug=map`), every
placement is followed by an assertion pass that walks each rendered label's
cells against the land mask and warns in the console on any overlap. The same
entry points are on `window.ATLAS_MAP_DEBUG`: `setZoom(z)`, `place()`,
`checkLabels()`, `checkPainted()`, `labels()`, `oceanLabels()`, `nativeLabels()`,
`stats()` and `showCard(id)` (whose result now carries the hover card's native
line: its text, `lang`, `dir` and predicted line count).

**Grid debugging.** `window.ATLAS_GRID_DEBUG` exposes the layout's own
bookkeeping for the same reason: `agreement()` re-checks every card's predicted
top/height against the DOM (and, mid-search, that each flowed tagline carries
exactly the lines it was predicted to), `writes()` counts position writes per
card, `slots()`, `hero()` and `lastLayout()` report what the last pass decided,
and `setQuery(q)` / `flows()` / `natives()` drive and inspect the Phase 4
search highlighting without going through the debounced input handler.

**Dialog debugging.** `window.ATLAS_DIALOG` is both the dialog's public surface
— `open(id)`, `close()`, `step(dir)`, `currentId()`, `relayout()` — and its
inspection surface. `debug()` returns the whole spread as data and touches no
DOM: the column boxes, every line's `{col, row, x, y, width, justified,
hyphenated}`, the drop cap's size, the pull quote's box, the three column-width
trials with the river run each produced, the chosen `rivers` report
(`maxRun`, `riverCount`, `worst`), the two field flows with their chip counts, the second name under the title
(planned and as rendered),
the height bookkeeping the step animation uses, the last reveal's timing, and
the accessible copies of the story, field note and title. `pnpm smoke` drives
the whole Phase 3 check-list through it.

**Reader debugging.** `window.ATLAS_READER` is both the field guide's public
surface — `open(id)`, `close()`, `goTo(page)`, `pageFor(id)`, `placeAt(page)`,
`currentPage()`, `isOpen()`, `setVisibleProvider(fn)` — and its inspection
surface. `debug()` returns the pagination as data and reads no geometry:
`pages`, `pageHeight`, `contentHeight`, `measure`, `rows`, `lineHeight`,
`currentPage`, `printMode`, which page numbers are attached (`rendered`), and
`perPage` — one entry per page with `{ placeId, firstLine, lastLine, lineCount,
overflow, used, kinds, lines }`, where `firstLine`/`lastLine` index that place's
own run of flowed body lines. `linesFor(id)` hands back that whole run.
`pnpm smoke` walks every page of every viewport through exactly these.

**Notebook debugging.** `ATLAS_DIALOG.debug().notebook` carries what the box's
height was predicted from and what it became — `width` (the measure, derived
from the dialog's inner width, never read back), `lineHeight`, `lines`, `rows`,
`chrome`, `predictedHeight`, `appliedHeight` — plus the current `value`, what is
in `localStorage` (`stored`), whether the last save landed (`saved`), and the
exact `postcard` "Copy as postcard" would put on the clipboard.

**Keyboard.** In the grid, Enter or Space on a focused card expands it in place.
In the detail dialog: Escape closes, ← and → step to the previous/next place in
the current filter. In the field guide: ← / PageUp and → / PageDown turn pages,
Home and End jump to the first and last, Tab cycles within the reader (focus is
trapped) and Escape closes it and leaves the `#/read/<id>` route. The map takes
`+`, `−` and the pointer.

**Laying the spread out.** `js/justify.js` is the pure half: given a pretext
`prepareWithSegments()` handle it builds a break-candidate table once
(`prepareParagraph`), then `breakLines(para, width, { from, maxLines, justify,
x })` returns lines with per-word x offsets, the gaps between them, and where
to resume — first-fit when ragged, Knuth-Plass when justified, with the greedy
pass as the fallback if no feasible path exists. `riverReport(lines,
spaceWidth)` chains those gaps down the column. It imports nothing at all — no
pretext, no `document`, no `window` — so it can move into a Web Worker
unchanged. `js/dialog.js` is the half that owns the DOM: it reads the dialog's
inner width exactly once per open (and once per resize), plans the geometry,
flows the columns and writes the spans.

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
- **Notes stay in the browser.** The visitor's notebook writes to
  `localStorage` and nowhere else, keyed by place id, every access wrapped
  (a browser in private mode throws on the property itself, not just the call).
  A note never enters the URL — the reader's route carries a place id and
  nothing else — never enters the generated `places/<id>/` pages, which are
  built in Node from `js/data.js` long before a browser has a note to give
  them, and never enters a request. `pnpm smoke` asserts all four.
- **No cookies, no trackers, no analytics, no third-party requests.** The
  only third-party code is `@chenglou/pretext` (MIT), which is **vendored**
  into `vendor/pretext/` and loaded from the same origin — never from a CDN.
- `form-action 'self'` and a `preventDefault()` on the search form mean the
  page never navigates unexpectedly.
- No secrets are ever stored, and the one piece of visitor input the site keeps
  — the notebook — is stored only in that visitor's own browser.

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
  static host. `node_modules/` is ignored too. `scripts/` and `test/` are
  development-only (nothing at runtime loads them, and the service worker does
  not precache them), so they can be left out of a deploy. The service worker is
  same-origin only and never fetches external resources.

## Project layout

```
index.html        — page shell + strict CSP + Open Graph meta
css/style.css     — all styling (no external assets)
css/place.css     — styling for the generated per-place share pages
js/data.js        — the dataset (40 places, 7 categories; every place also
                    carries nativeName + nativeLang)
js/landmap.js     — generated ASCII land grids (150×39 desktop, 96×25 mobile,
                    from Natural Earth),
                    plus simplified outlines for the 31 countries the dataset
                    names, for the country reading view (+11 KB)
js/text.js       — text metrics on top of pretext: the font role registry,
                    window.ATLAS_TEXT, feature flags, dev agreement check,
                    grouped locale-aware preparation, bidi direction, and the
                    rich-inline wrappers a classic script can reach
js/app.js        — predictive masonry (FLIP, scroll anchor, fitted text,
                    expand in place), search, filters, URL state, routing,
                    daily pick, geolocation, distance sort, sw reg; delegates
                    the dialog to js/dialog.js (with a plain fallback)
js/text-route.js — pure variable-width text routing (worker-ready): pretext
                    handle + per-row widths -> the lines that fit
js/labels.js     — the map's label placement engine as pure data in / data out
                    (no DOM): coastline routing, the occupancy mask, ocean names
js/sea.js        — the living sea, pure: hover spills and the corridors the
                    idle sentences drift along
js/clouds.js     — the sky, pure: ASCII cloud silhouettes from templates or
                    lobes, traced into `.-_()~` on the character grid
js/text-worker.js— the same-origin module worker both engines run inside
js/justify.js    — pure Knuth-Plass line breaking + river detection
                    (worker-ready): prepared handle + width -> positioned words
js/dialog.js     — the detail dialog as an editorial spread: drop cap, pull
                    quote, justified columns, staggered reveal, soft hyphens,
                    rich-inline metadata chips, the visitor's notebook;
                    window.ATLAS_DIALOG
js/reader.js     — the field guide: every place in the current filter
                    paginated into fixed-height pages, three in the DOM at a
                    time (all of them while printing); window.ATLAS_READER
js/notebook.js   — the notebook's storage and its postcard (pure; shared by
                    js/dialog.js and js/reader.js)
js/map.js        — the Text Atlas (character-grid map, uses pretext), pan/zoom,
                    coastline-routed labels, ocean names, hover card,
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
scripts/check-text.mjs    — headless text-overflow checks (pnpm validate)
scripts/smoke.mjs         — headless smoke test of index.html (pnpm smoke)
scripts/checks/reader.mjs — the Phase 6 half of it: pagination at six window
                            sizes, printing, the notebook, the daily card
scripts/checks/clouds.mjs — the cloud generator's geometry (no browser needed:
                            `node scripts/checks/clouds.mjs`) plus the sky on
                            the page; `run-clouds.mjs` runs both on their own
scripts/browser-harness.mjs — dev server + Chromium plumbing for those two
scripts/build-place-pages.mjs — generates the places/<id>/ share pages
test/text-check.html      — dev-only page the overflow checks run in
test/text-check.js        — the overflow rules themselves (not shipped)
test/locale-check.html    — dev-only page the locale line-break checks run in
test/locale-check.js      — pretext vs the browser, per language and width
data/world-110m-*.geojson — source coastlines (Natural Earth 110m; not deployed)
server.mjs       — zero-dependency dev server (pnpm start)
package.json     — scripts + devDependencies (@chenglou/pretext, playwright)
.node-version    — pinned Node version for fnm
.gitignore       — ignores node_modules, places/, data/*.geojson, logs
```

## Roadmap continuation: the living sea, shapes, and serif ink

The original nine-phase [development roadmap](docs/atlas-pretext-roadmap.html)
is now preserved in this repository. The [Claude handoff](docs/claude-phase8-handoff.md)
describes the recovered Phase 5 work, the Phase 7–8 additions, verification,
flags, and the exact fallback behavior.

The desktop map now routes labels and sea text in a same-origin Web Worker
(with a synchronous fallback). Hover a marker for a tagline on the water;
after twelve idle seconds, clickable field-note sentences drift in the sea.
Idle animation is disabled on phones and under reduced motion.

Sea text is routed around the page's own floating chrome as well as around the
coast. The intro panel, the control cluster and the hover card are opaque boxes
over the water, so their cells are measured on each rebuild and handed to the
engine alongside the land mask: nothing is ever set behind them. That is a
readability rule first — a tagline half-hidden by the card it belongs to reads
as breakage — and a correctness rule second, because the intro panel carries an
outbound link, and a drifting word behind it would answer a click by leaving
the site. It costs some spills: on a real hover 11 of the 40 markers now place
a complete tagline on the water where 19 did before — but 10 of those 19 were
at least half-hidden behind the card, and 42% of all spilled cells were behind
it. Fewer spills, none of them mutilated. Landlocked and crowded markers
already degraded to the card alone.

A place dialog offers **Read on the map** and **Journey to / Show route**.
**Read on the map** fills the silhouette of the place's country with its whole
story: the map dims, the outline is drawn in the grid's own colour and texture
character, and each row of the polygon becomes a line width, so the text takes
the shape of Bolivia, of Jordan, of the Indonesian archipelago. The silhouette
is drawn at the smallest scale that holds the story in the site's serif at
14px (10px at worst), anchored on the country's real position and slid only as
far as it must to stay clear of the map's own panels. At 1280x800, 37 of the
40 stories fill their country; the three Chilean places fall back to the
regional reading inset, because a country 4,300 km long and 180 km wide is a
sliver at any scale that fits the map. A story too long even for the inset
stays in a full caption below the map. **Locate me** also draws a great-circle
journey to the nearest place. Route text avoids map labels; notes too long for
a route remain readable in a caption. **Clear story** removes the reading view.
**Serif map** re-sets the whole map in the site's Georgia face and is
remembered between visits. Every candidate glyph — printable ASCII, the
printable half of Latin-1, and the typographic marks a WGL4 face also carries —
is rendered once at the map's own cell size and its ink is counted, so a
glyph's tone is measured coverage rather than its position in a list; its
advance comes from `prepareWithSegments`, and anything wider than the cell is
rejected while narrower glyphs are centred in it. That gives a 24-rung ramp,
strictly increasing in measured coverage. Land takes its tone from a
distance-to-coast field over the land mask — dark coastlines fading to a
lighter interior — which is what keeps a continent's shape readable once the
glyphs are no longer all one width; the country colours are unchanged. The sea
picks its ink out of the same ramp from the wave field's own density, per cell
per frame, so crests and troughs read as continuous tone. Reduced motion gets
the static tonal sea and no fluid. Marker positions, cell positions, the land
mask and zoom are identical in both modes.

## The open ocean

The character map is 150 x 39 cells of equirectangular Earth, and it is centred
in the hero: on a wide or a tall screen that left dark nothing around it. The
sea now fills the viewport instead, and it flows the way the ocean does.

**One body of water.** The fluid simulation runs on an *extended* grid — the
world grid plus a margin of open ocean on each side, at the same cell size —
with the world grid at a fixed offset inside it. Both canvases — the static one
carrying the land and the sea's still floor, and the animated one above it — are
sized past the world grid and hung inside the pan/zoom wrapper at a negative
offset, so one transform still moves the map and the water around it together
and the two can never slide apart. (The static one reaches further: its margin
is uncapped, so the water still gets to the edge of a viewport too large to
simulate all of.) Nothing about the world grid's placement or size changes:
markers, labels, the land mask, the hover card, the drifting sentences and every
hit test still speak in world cells, and one helper converts. A splash at the
edge of the map ripples on into the open ocean because the neighbour graph the
spring runs on does not stop at the coastline of the printed map. The margin is
recomputed on every rebuild, and a resize that changes it — a window that gets
wider without changing the cell size — is now a rebuild. It is capped at 30 x 12
cells a side so a 4K viewport cannot ask for six times the world grid; past the
cap the water is the still floor alone, painted once.

**Currents, not sines.** The sea used to be three traveling sine trains crossing
the whole map in the same direction. `js/currents.js` carries a small table of
the real surface circulation — five subtropical gyres, the North Atlantic and
Alaska subpolar gyres, the Beaufort and Weddell gyres, six named boundary
currents (Gulf Stream, Kuroshio, Brazil, Agulhas, East Australian, Humboldt) and
seven zonal bands including the Antarctic Circumpolar Current and the equatorial
counter-current — as smooth kernels in lat/lon: a gyre is a vortex that is still
at its centre and fastest at its rim, a boundary current is a Gaussian ridge
along a polyline, a band is a Gaussian in latitude. At build they are summed into
one velocity per cell, damped to a standstill at the coast through a
distance-to-land field, wrapped round the antimeridian and folded over the poles
(past the pole, longitude turns by 180 degrees and north and south swap, which is
why the currents cross the top and bottom edges of the map without a seam), then
frozen into four flat typed arrays. A frame reads them and nothing else: the
wave's phase rises *along* the local flow, so `phase - omega * t` is a crest
lying across the current and traveling down it at that current's own speed.
Shape says direction (`- ~ ≈` along a zonal current, `/` and `\` on the
diagonals, `|` where a western boundary current runs poleward, `o` for an eddy in
water too slow to have a direction) and colour says speed, so the gyres read as
bright streams and their calm eyes, the doldrums and the enclosed seas stay
quiet water. The interactive ripple and the regional wave bias are layered on
top exactly as before, and the serif atlas still picks its ink out of the
measured ramp — taking a direction glyph only at a crest, and only when the
measured ramp contains that glyph.

Under `prefers-reduced-motion: reduce` the field is drawn once and stands still,
which is what the sea already did; on a phone the animation is unchanged and the
water fills the band.

Cost: at 1280x800 the extended grid is 156 x 41 cells (4,300 water cells, 15%
more than the world grid's 3,754); at 2000x900 it is 210 x 41 (6,514 water
cells, 74% more). It runs no slower than the sea it replaces at either size,
because the arithmetic got cheaper in the same change: a 2,048-entry sine table
instead of `Math.sin`, a squared gamma instead of `Math.pow`, per-cell paint
positions worked out once at build instead of an integer division per cell per
frame, the spring walking the water list instead of the whole grid, the far
margin repainted every other frame, and the quietest glyphs left to the still
floor underneath. `?noflags=openOcean` restores the world-grid-only sea and its
uniform sines exactly.

The new check is `scripts/checks/ocean.mjs`: the water reaches every edge of the
viewport at both sizes, markers and labels land on the same pixels and in the
same cells as with `?noflags=openOcean` (at 1x and at 2.5x, where every name is
out on the water), the currents move at least 80% of the world grid's water
cells and exactly none of its land, sixteen named currents run the direction
they really run, every flow glyph is one cell wide in the face the browser
resolved, and the frame budget holds at both sizes.

New modules: `js/labels.js`, `js/sea.js`, `js/currents.js`,
`js/text-worker.js`, `js/map-art.js`.
The service-worker cache is bumped to v3 and includes these modules and all
their transitive JavaScript imports, including the vendored pretext modules.
`pnpm smoke` includes the recovered sea checks, the open-ocean checks and the
map-art checks.
For the additional serif performance, offline, geolocation, mobile and
screenshot checks, run `node scripts/checks/run-map-art.mjs`.
