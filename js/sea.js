/* Atlas of the Curious — the living sea: text poured into the water itself.

   Two jobs, one engine, and both of them pure: no `document`, no `window`, no
   timers, no canvas element. js/text-worker.js runs this off the main thread;
   js/map.js runs the very same module synchronously when there is no worker.

   1. Stories on the water. Hovering a marker spills its tagline into the free
      sea cells around the dot, routed around the coast row by row with the same
      variable-width router the labels use (js/text-route.js). Opening the place
      extends it with the opening sentences of the field note, up to a cell
      budget. The engine only ever answers with cells; the ripple field and the
      painting live on the main thread.

   2. The sea of stories. After a long enough silence, sentences lifted out of
      random field notes drift along the ocean rows like slow currents, one cell
      a second, alternating direction by row. Each sentence is given a
      *corridor*: a rectangle of free water bounded by the coastlines on either
      side and by whatever the labels have already claimed. It is routed to fit
      inside that corridor and then slides from one end to the other; when it
      reaches the far coast it fades and another sentence takes its place.

   The geometry is deliberately grid-native. The sea is painted in the map's own
   monospace font, so one character is exactly one cell and the text scales with
   the map instead of counter-scaling like the DOM labels do. That is what makes
   "no glyph is ever drawn on a land cell" a claim a walk over the cells can
   settle: ATLAS_MAP_DEBUG.checkSeaText() does exactly that walk.

   Per-word geometry comes out of the prepared handle itself. js/text-route.js
   now reports the pretext cursors each line was cut from, so the engine can walk
   the handle's own `segments` / `widths` back out of a routed line and hand the
   main thread a word list — which is what lets a pointer be mapped to a
   sentence, then a line, then a word, and a click open the place it came from. */
import { prepareWithSegments } from "../vendor/pretext/layout.js";
import { routeText } from "./text-route.js";
import { LABEL_DIRS, scaleCells, REF_COLS } from "./labels.js";

/* ---- Tuning -------------------------------------------------------------

   Every distance below is in cells of the 150-column grid the sea was tuned
   on. The desktop world grid is now 240 columns of the same Earth, so a cell
   is 1.6 times narrower on screen: a corridor of twenty cells is two thirds of
   the water it used to be, and a sentence drifting one cell a second crawls.
   `scaleCells()` (js/labels.js, one rule for both engines) converts them
   against the grid `setGrid()` was actually given, so a spill covers the same
   stretch of sea and drifts at the same speed on screen as it did at 150
   columns — and the phone grid is not retuned by the desktop's change.

   What is *not* scaled is anything counting text rather than distance: the
   number of sentences adrift, the rows a spill may use, and the sentence
   lengths themselves. One character is one cell whatever the grid is, so those
   are already in the sea's own units. */

// Stories on the water, on hover.
export const HOVER_MAX_OFFSET = 5;      // cells from the dot an anchor may sit
export const HOVER_RUN_LIMIT = 52;      // longest free run worth scanning
export const HOVER_MIN_CELLS = 14;      // a row narrower than this holds no text
export const HOVER_TAG_LINES = 4;       // rows the tagline may use
export const HOVER_STORY_LINES = 5;     // rows one extra sentence may use
export const HOVER_CELL_BUDGET = 320;   // total cells a spilled story may claim

// The sea of stories, when idle.
export const IDLE_MAX_SENTENCES = 6;    // enough to feel like a sea, few enough to read
export const IDLE_SPEED_CELLS = 1;      // cells per second — a current, not a ticker
export const IDLE_FADE_MS = 700;        // per-sentence fade in / fade out
export const IDLE_SPAWN_GAP_MS = 700;   // never more than one new sentence per gap
export const IDLE_MIN_CORRIDOR = 20;    // cells of open water a sentence needs
export const IDLE_MIN_TRAVEL = 6;       // cells it must have room to drift
// …and the most it is given. A sentence holds its whole corridor for as long as
// it lives, so an uncapped one would reserve half the Pacific and the sea would
// never get past two or three voices. Capping the drift lets a wide ocean row
// carry a second sentence beside the first.
export const IDLE_MAX_TRAVEL = 22;
export const IDLE_MIN_WIDTH = 14;       // narrowest a drifting line may be set
export const IDLE_MAX_WIDTH = 42;       // widest — leaves room to drift
export const IDLE_MAX_LINES = 4;

/* A field note, cut into sentences. Only the middles are kept: a three-word
   fragment reads as noise on the water and a 200-character sentence never finds
   a corridor wide enough. */
export function splitSentences(text) {
  const str = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  if (!str) return [];
  const out = [];
  for (const raw of str.split(/(?<=[.!?…])\s+/)) {
    const s = raw.trim();
    if (s.length >= 34 && s.length <= 160) out.push(s);
  }
  return out;
}

/* The words of one routed line, read back out of the prepared handle.

   js/text-route.js hands each line the pretext cursors it was cut from, so the
   handle's own `segments` / `widths` / `kinds` arrays can be walked between
   them: runs of `text` segments are one word, anything else is a gap that still
   advances the pen. The x offsets that come out are the same numbers pretext
   used to break the line, which is why a word's cell can be trusted. */
export function wordsOfLine(pre, line) {
  const segs = (pre && pre.segments) || null;
  if (!segs) return [];
  const widths = pre.widths || [];
  const kinds = pre.kinds || null;
  const s0 = line.start.segmentIndex;
  let s1 = line.end.segmentIndex;
  if (line.end.graphemeIndex > 0) s1++;
  const words = [];
  let x = 0, curX = 0, curText = "", curW = 0, open = false;
  for (let i = s0; i < s1 && i < segs.length; i++) {
    const isText = kinds ? kinds[i] === "text" : /\S/.test(segs[i]);
    const w = widths[i] || 0;
    if (isText) {
      if (!open) { open = true; curX = x; curText = ""; curW = 0; }
      curText += segs[i];
      curW += w;
    } else if (open) {
      words.push({ text: curText, x: curX, width: curW });
      open = false;
    }
    x += w;
  }
  if (open) words.push({ text: curText, x: curX, width: curW });
  return words;
}

function cellsWide(width, charW) {
  return Math.max(1, Math.ceil((width - 0.001) / charW));
}

/* ---- The engine --------------------------------------------------------- */

/* options
     onLayout(n)  called once per pretext routing call, so the host can count
                  the layout work it is doing on its own thread
     random()     injectable, so a test can make the drift reproducible */
export function createSeaEngine(options) {
  const opts = options || {};
  const onLayout = typeof opts.onLayout === "function" ? opts.onLayout : null;
  const random = typeof opts.random === "function" ? opts.random : Math.random;

  let COLS = 0, ROWS = 0;
  /* The tuning above, converted to this grid once per build (see the header). */
  let hoverMaxOffset = HOVER_MAX_OFFSET, hoverRunLimit = HOVER_RUN_LIMIT;
  let hoverMinCells = HOVER_MIN_CELLS, hoverBudget = HOVER_CELL_BUDGET;
  let idleSpeed = IDLE_SPEED_CELLS, idleMinCorridor = IDLE_MIN_CORRIDOR;
  let idleMinTravel = IDLE_MIN_TRAVEL, idleMaxTravel = IDLE_MAX_TRAVEL;
  let idleMinWidth = IDLE_MIN_WIDTH, idleMaxWidth = IDLE_MAX_WIDTH;
  let land = new Uint8Array(0);
  let occ = new Uint8Array(0);          // the labels' occupancy mask, live
  let reserve = new Uint8Array(0);      // corridors the drifting sentences hold
  let chrome = new Uint8Array(0);       // cells the host's own DOM sits over
  let font = "", charW = 1;
  let stories = [];                     // [{ id, tagline, sentences: [string] }]
  let flat = [];                        // every sentence, flat: [{ story, text }]
  const byId = new Map();
  const handles = new Map();            // font + "|" + text -> { text, pre }

  let idleOn = false;
  let live = [];                        // the drifting sentences
  let lastNow = 0, lastSpawn = -1e9, nextKey = 1;
  let pausedKey = 0;                    // the sentence under the pointer

  function tick() { if (onLayout) onLayout(1); }

  function handleFor(text) {
    const str = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    const key = font + "|" + str;
    let h = handles.get(key);
    if (!h) { h = { text: str, pre: prepareWithSegments(str, font) }; handles.set(key, h); }
    return h;
  }

  const inGrid = (row, col) => row >= 0 && row < ROWS && col >= 0 && col < COLS;
  function open(row, col) {
    if (!inGrid(row, col)) return false;
    const i = row * COLS + col;
    return !land[i] && !occ[i] && !chrome[i];
  }
  function openIdle(row, col) {
    if (!open(row, col)) return false;
    return !reserve[row * COLS + col];
  }
  function runFrom(row, col, dir, limit, test) {
    let n = 0, c = col;
    while (n < limit && test(row, c)) { n++; c += dir; }
    return n;
  }

  /* ---- 1. Stories on the water ------------------------------------------ */

  // Route one string from `startRow` down, anchored at `anchorCol` and running
  // in `dir`. Returns the routed lines with their leftmost cell and their words.
  function routeUnit(handleText, anchorCol, dir, startRow, maxLines, kindName) {
    const h = handleFor(handleText);
    const widths = [];
    for (let i = 0; i < maxLines; i++) {
      widths.push(runFrom(startRow + i, anchorCol, dir, hoverRunLimit, open) * charW);
    }
    tick();
    const res = routeText(h.pre, widths, 1, {
      maxLines: maxLines,
      text: h.text,
      startRow: startRow,
      minWidth: hoverMinCells * charW,
      contiguous: true
    });
    if (!res.complete || !res.lines.length) return null;
    const lines = [];
    let cells = 0;
    for (const line of res.lines) {
      const n = cellsWide(line.width, charW);
      const c0 = dir > 0 ? anchorCol : anchorCol - n + 1;
      if (c0 < 0 || c0 + n > COLS) return null;
      cells += n;
      lines.push({
        row: line.row, col: c0, text: line.text, width: line.width, cells: n,
        kind: kindName,
        words: wordsOfLine(h.pre, line).map(function (w) {
          return {
            text: w.text, dcol: Math.round(w.x / charW),
            cells: cellsWide(w.width, charW), width: w.width
          };
        })
      });
    }
    return { lines: lines, cells: cells };
  }

  /* Spill a place's tagline (and, when the place has been opened, the opening
     sentences of its field note) into the free water beside its dot. The eight
     anchor directions and their penalties are the label engine's, so the text
     lands beside the dot the way a name would. */
  function hover(req) {
    const r = req || {};
    const story = byId.get(r.id);
    if (!story || !COLS) return null;
    const units = [{ text: story.tagline, kind: "tagline", maxLines: HOVER_TAG_LINES }];
    if (r.extend) {
      for (const s of story.sentences) {
        units.push({ text: s, kind: "story", maxLines: HOVER_STORY_LINES });
        if (units.length >= 4) break;
      }
    }
    let best = null;
    for (let off = 1; off <= hoverMaxOffset && !best; off++) {
      for (const d of LABEL_DIRS) {
        const col = (r.col | 0) + d.dc * off;
        const row = (r.row | 0) + d.dr * off;
        if (!open(row, col)) continue;
        const first = routeUnit(units[0].text, col, d.dir, row, units[0].maxLines, "tagline");
        if (!first) continue;
        const lines = first.lines.slice();
        let cells = first.cells;
        let from = lines[lines.length - 1].row + 1;
        for (let u = 1; u < units.length; u++) {
          if (cells >= hoverBudget) break;
          const next = routeUnit(units[u].text, col, d.dir, from, units[u].maxLines, units[u].kind);
          if (!next || cells + next.cells > hoverBudget) break;
          for (const line of next.lines) lines.push(line);
          cells += next.cells;
          from = lines[lines.length - 1].row + 1;
        }
        const score = first.lines.length * 100 + off * 12 + d.pen;
        if (!best || score < best.score) {
          best = { score: score, col: col, row: row, dir: d.dir, lines: lines, cells: cells };
        }
      }
    }
    if (!best) return null;
    return {
      id: r.id, col: best.col, row: best.row, dir: best.dir,
      extended: !!r.extend, cells: best.cells, lines: best.lines
    };
  }

  /* ---- 2. The sea of stories -------------------------------------------- */

  function rebuildReserve() {
    reserve.fill(0);
    for (const s of live) {
      for (let i = 0; i < s.rows; i++) {
        const row = s.row + i;
        if (row < 0 || row >= ROWS) continue;
        const base = row * COLS;
        for (let c = s.col0; c < s.col0 + s.span; c++) reserve[base + c] = 1;
      }
    }
  }

  // Maximal runs of open water on one row, long enough to hold a sentence.
  function corridorsOn(row) {
    const out = [];
    let c = 0;
    while (c < COLS) {
      if (!openIdle(row, c)) { c++; continue; }
      const start = c;
      while (c < COLS && openIdle(row, c)) c++;
      if (c - start >= idleMinCorridor) out.push({ c0: start, len: c - start });
    }
    return out;
  }

  /* Give one sentence a corridor. The corridor is a rectangle: `span` columns
     wide from `c0`, `rows` rows deep, every cell of it open water. The sentence
     is set at a width capped well below the corridor so there is room left to
     drift, and it is only accepted if the whole sentence fits — a sentence
     broken mid-word would read as damage rather than as a current. */
  function trySpawn(now) {
    if (!flat.length) return false;

    // Every stretch of open water on the whole map, once. Land, the labels and
    // the corridors already taken are all out by construction.
    const runs = [];
    for (let row = 1; row < ROWS - 1; row++) {
      for (const r of corridorsOn(row)) runs.push({ row: row, c0: r.c0, len: r.len });
    }
    if (!runs.length) return false;
    // Walk the candidates in a shuffled order rather than sampling with
    // replacement: when the labels have left only a handful of usable stretches,
    // random picks keep landing on the same unusable one.
    for (let i = runs.length - 1; i > 0; i--) {
      const j = (random() * (i + 1)) | 0;
      const tmp = runs[i]; runs[i] = runs[j]; runs[j] = tmp;
    }

    // A bounded number of tries: this whole routine runs in one frame (on the main
    // thread when there is no worker), and a spawn that does not find water now
    // waits out a gap and tries again rather than searching harder.
    const tries = Math.min(24, runs.length);
    for (let attempt = 0; attempt < tries; attempt++) {
      const run = runs[attempt];
      const row = run.row;
      // Claim a window inside the run rather than the whole thing, at a random
      // offset, so two sentences can share one wide ocean row.
      const want = Math.min(run.len, idleMaxWidth + idleMaxTravel);
      const slack = run.len - want;
      const c0 = run.c0 + (slack > 0 ? ((random() * (slack + 1)) | 0) : 0);

      // How far the window stays open on each row under the first one.
      const avail = [];
      for (let i = 0; i < IDLE_MAX_LINES; i++) {
        avail.push(row + i >= ROWS ? 0 : runFrom(row + i, c0, 1, want, openIdle));
      }

      // Choose from the space that is actually free on successive rows,
      // leaving travel room before laying out. Using the first row times four
      // could repeatedly choose stories that cannot fit a narrow corridor.
      let cap = 0, available = Infinity;
      for (let i = 0; i < avail.length; i++) {
        available = Math.min(available, avail[i]);
        const width = Math.min(idleMaxWidth, available - idleMinTravel);
        if (width >= idleMinWidth) cap = Math.max(cap, width * (i + 1));
      }
      let lo = 0, hi = flat.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (flat[mid].text.length <= cap) lo = mid + 1; else hi = mid;
      }
      if (!lo) continue;
      const text = flat[(random() * lo) | 0];
      const story = text.story;
      const h = handleFor(text.text);
      // One character is one cell here, so the character count over the widest
      // line divides straight into a lower bound on the rows this sentence
      // needs. Starting there instead of at one saves two or three routings per
      // attempt, which is most of the cost of a spawn.
      const floorLines = Math.max(1, Math.min(
        IDLE_MAX_LINES,
        Math.ceil(h.text.length / Math.max(1, Math.min(avail[0] - idleMinTravel, idleMaxWidth)))
      ));
      for (let used = floorLines; used <= IDLE_MAX_LINES; used++) {
        let span = avail[0];
        for (let i = 1; i < used; i++) span = Math.min(span, avail[i]);
        if (span < idleMinWidth) break;
        const setWidth = Math.min(span - idleMinTravel, idleMaxWidth);
        if (setWidth < idleMinWidth) break;
        const widths = [];
        for (let i = 0; i < used; i++) widths.push(setWidth * charW);
        tick();
        const res = routeText(h.pre, widths, 1, {
          maxLines: used, text: h.text, startRow: row,
          minWidth: idleMinWidth * charW, contiguous: true
        });
        if (!res.complete || res.lines.length !== used) continue;
        let block = 1;
        for (const line of res.lines) block = Math.max(block, cellsWide(line.width, charW));
        const corridor = Math.min(span, block + idleMaxTravel);
        if (corridor - block < idleMinTravel) continue;

        const lines = res.lines.map(function (line, i) {
          return {
            row: row + i, text: line.text, width: line.width,
            cells: cellsWide(line.width, charW),
            words: wordsOfLine(h.pre, line).map(function (w) {
              return {
                text: w.text, dcol: Math.round(w.x / charW),
                cells: cellsWide(w.width, charW), width: w.width
              };
            })
          };
        });
        // Rows alternate: even rows carry an eastward current, odd rows a
        // westward one, so the sea reads as circulation rather than a ticker.
        const dir = (row % 2 === 0) ? 1 : -1;
        live.push({
          key: nextKey++, placeId: story.id, text: h.text,
          row: row, rows: used, col0: c0, span: corridor, block: block, dir: dir,
          travelMs: ((corridor - block) / idleSpeed) * 1000,
          elapsed: 0, fading: false, fadeMs: 0, lines: lines, isNew: true
        });
        lastSpawn = now;
        rebuildReserve();
        return true;
      }
    }
    return false;
  }

  // The block's left-most column at the sentence's current age.
  function colAt(s) {
    const travel = Math.max(0, s.span - s.block);
    const k = s.travelMs > 0 ? Math.min(1, s.elapsed / s.travelMs) : 1;
    const off = Math.round(k * travel);
    return s.dir > 0 ? s.col0 + off : s.col0 + travel - off;
  }

  // Every cell of the corridor the block currently sits in must still be open
  // water: a zoom can re-place the labels underneath a drifting sentence.
  function stillClear(s, col) {
    for (let i = 0; i < s.rows; i++) {
      const row = s.row + i;
      for (let c = col; c < col + s.block; c++) if (!open(row, c)) return false;
    }
    return true;
  }

  function alphaOf(s) {
    if (s.fading) return Math.max(0, 1 - s.fadeMs / IDLE_FADE_MS);
    const inA = Math.min(1, s.elapsed / IDLE_FADE_MS);
    const left = s.travelMs - s.elapsed;
    const outA = left >= IDLE_FADE_MS ? 1 : Math.max(0, left / IDLE_FADE_MS);
    return Math.min(inA, outA);
  }

  /* One frame of the current. The main thread only paints what comes back. */
  function idleFrame(now) {
    const fresh = [];
    if (!idleOn) return { sentences: [], fresh: fresh, retired: [], active: 0 };
    const dt = lastNow ? Math.max(0, Math.min(120, now - lastNow)) : 0;
    lastNow = now;

    const retired = [];
    const keep = [];
    for (const s of live) {
      if (!s.fading && s.key !== pausedKey) s.elapsed += dt;
      if (s.fading) s.fadeMs += dt;
      const col = colAt(s);
      // A zoom can re-place the labels straight over a drifting sentence. The
      // labels are the map's real content, so the sentence goes at once rather
      // than fading over half a second on top of a name.
      if (!stillClear(s, col)) { retired.push(s.key); continue; }
      if (!s.fading && s.elapsed >= s.travelMs) { s.fading = true; s.fadeMs = 0; }
      if (s.fading && s.fadeMs >= IDLE_FADE_MS) { retired.push(s.key); continue; }
      keep.push(s);
    }
    if (retired.length) { live = keep; rebuildReserve(); }

    if (live.length < IDLE_MAX_SENTENCES && now - lastSpawn >= IDLE_SPAWN_GAP_MS) {
      // A failed attempt scanned every row for open water and tried a couple of
      // dozen routings; that is the single most expensive thing this engine
      // does, so a failure waits out a whole gap rather than retrying next
      // frame. It only fails when the water is genuinely full.
      if (!trySpawn(now)) lastSpawn = now;
    }

    const out = [];
    for (const s of live) {
      const col = colAt(s);
      if (s.isNew) {
        s.isNew = false;
        fresh.push({
          key: s.key, id: s.placeId, text: s.text, row: s.row, rows: s.rows,
          dir: s.dir, block: s.block,
          lines: s.lines.map(function (l) {
            return {
              row: l.row, text: l.text, cells: l.cells,
              words: l.words.map(function (w) {
                return { text: w.text, dcol: w.dcol, cells: w.cells, width: w.width };
              })
            };
          })
        });
      }
      out.push({
        key: s.key, col: col, alpha: alphaOf(s), paused: s.key === pausedKey ? 1 : 0
      });
    }
    return { sentences: out, fresh: fresh, retired: retired, active: live.length };
  }

  return {
    setGrid: function (cfg) {
      COLS = cfg.cols | 0;
      ROWS = cfg.rows | 0;
      hoverMaxOffset = scaleCells(HOVER_MAX_OFFSET, COLS);
      hoverRunLimit = scaleCells(HOVER_RUN_LIMIT, COLS);
      hoverMinCells = scaleCells(HOVER_MIN_CELLS, COLS);
      hoverBudget = scaleCells(HOVER_CELL_BUDGET, COLS);
      idleSpeed = IDLE_SPEED_CELLS * (COLS > 0 ? COLS : REF_COLS) / REF_COLS;
      idleMinCorridor = scaleCells(IDLE_MIN_CORRIDOR, COLS);
      idleMinTravel = scaleCells(IDLE_MIN_TRAVEL, COLS);
      idleMaxTravel = scaleCells(IDLE_MAX_TRAVEL, COLS);
      idleMinWidth = scaleCells(IDLE_MIN_WIDTH, COLS);
      idleMaxWidth = scaleCells(IDLE_MAX_WIDTH, COLS);
      land = cfg.land;
      occ = cfg.occupancy;
      reserve = new Uint8Array(COLS * ROWS);
      chrome = new Uint8Array(COLS * ROWS);
      live = [];
    },
    // The sea is painted in the map's own monospace grid font, so one character
    // is one cell; a rebuild at a new cell size re-prepares (cached by font).
    setFont: function (cfg) {
      font = String(cfg.font || "");
      charW = Number(cfg.charW) || 1;
      live = [];
      if (reserve.length) reserve.fill(0);
    },
    /* The cells the host's own chrome covers.

       The sea canvas is not the top layer. A floating intro panel sits over the
       water and a control cluster sits over it in the other corner, both opaque
       boxes on a layer of their own, and the hover card is a third. A sentence
       routed behind one of them is a sentence nobody can read, and a word
       behind a *link* in one of them would answer a click with a navigation
       instead of a place — which is exactly how this was found.

       So the host measures those boxes, turns them into cell rectangles and
       hands them over; from here on they are simply not water. `rects` is
       [{ r0, c0, r1, c1 }], inclusive, in grid cells. A sentence already
       drifting through a cell that has just been covered fails its stillClear()
       test on the next frame and is retired, the same way it is when a zoom
       re-places a label on top of it. */
    setObstacles: function (rects) {
      if (!chrome.length) return 0;
      chrome.fill(0);
      let cells = 0;
      for (const r of (rects || [])) {
        const r0 = Math.max(0, r.r0 | 0), r1 = Math.min(ROWS - 1, r.r1 | 0);
        const c0 = Math.max(0, r.c0 | 0), c1 = Math.min(COLS - 1, r.c1 | 0);
        for (let row = r0; row <= r1; row++) {
          const base = row * COLS;
          for (let c = c0; c <= c1; c++) {
            if (!chrome[base + c]) cells++;
            chrome[base + c] = 1;
          }
        }
      }
      return cells;
    },
    // [{ id, tagline, story }] — the sentences are cut here, once.
    setStories: function (list) {
      stories = (list || []).map(function (s) {
        return { id: s.id, tagline: s.tagline, sentences: splitSentences(s.story) };
      });
      byId.clear();
      flat = [];
      for (const s of stories) {
        byId.set(s.id, s);
        for (const text of s.sentences) flat.push({ story: s, text: text });
      }
      // Sorted by length, so trySpawn() can binary-search the ones short enough
      // for a given stretch of water.
      flat.sort(function (a, b) { return a.text.length - b.text.length; });
    },
    hover: hover,
    // Idempotent and always a clean start: the host clears its own copy of the
    // sentences when it starts idle mode, so a session that carried live ones
    // over would leave positions arriving for text the host no longer has.
    startIdle: function (now) {
      idleOn = true;
      live = [];
      lastNow = now;
      lastSpawn = -1e9;
      pausedKey = 0;
      if (reserve.length) reserve.fill(0);
    },
    stopIdle: function () {
      idleOn = false;
      live = [];
      lastNow = 0;
      pausedKey = 0;
      if (reserve.length) reserve.fill(0);
    },
    idleFrame: idleFrame,
    // Hovering a drifting sentence brightens it and holds it still.
    setPaused: function (key) { pausedKey = key | 0; },
    isIdle: function () { return idleOn; },
    activeCount: function () { return live.length; },
    sentencePool: function () {
      let n = 0;
      for (const s of stories) n += s.sentences.length;
      return n;
    }
  };
}
