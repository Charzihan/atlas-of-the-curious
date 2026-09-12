/* Atlas of the Curious — the map's label placement engine, as plain data.

   This is Phase 1's label engine lifted out of js/map.js with the DOM left
   behind. It takes plain data in — the grid size, the land mask as a
   Uint8Array, one cell per marker, the strings to place, the font roles, a
   tier and a zoom — and returns plain data out: for every label, the cell it
   is anchored at, the direction it runs, and one entry per line with its text,
   its measured width and its row. Nothing here touches `document`, `window`,
   a timer or a canvas element, so the whole thing runs unchanged inside
   js/text-worker.js (pretext reaches for `OffscreenCanvas` when there is no
   DOM, and `Intl.Segmenter` exists in workers).

   The three ideas from Phase 1 are unchanged, and this file is where they now
   live:

   1. Two masks. `kind` (the land grid, never changes) and `occupancy` (rebuilt
      from scratch on every placement). A cell is free when it is water and
      unclaimed. `occupancy` is exposed, because the sea-text engine in
      js/sea.js has to route *around* whatever the labels claimed.

   2. Screen px, not map px. Labels counter-scale with 1/--zoom, so a grid cell
      is `cellW = CHARW * zoom` wide on screen and zooming in buys a label more
      cells for the same characters.

   3. One line per grid row, so a routed line and a painted line share cells.

   Preparation (the expensive pretext pass) happens once per string. A zoom
   change only re-runs the routing.

   Handles for the native names are the one place the two hosts differ. On the
   main thread js/map.js hands in a `handleProvider` so the handle prepared by
   js/text.js under the place's own locale is reused (calling `setLocale()`
   there would throw away pretext's shared caches for the whole page). Inside
   the worker there is no such registry, so the engine prepares them itself in
   one grouped pass — setLocale() per locale, then back to the default — which
   is exactly what js/text.js does at boot, and produces the same handles. */
import {
  prepareWithSegments,
  measureNaturalWidth,
  setLocale
} from "../vendor/pretext/layout.js";
import { directionFromLevels, dirForLang } from "./text.js";
import { routeText } from "./text-route.js";

/* ---- The Phase 1 constants, now shared by both hosts ------------------- */

// Zoom tiers. Below NAME the map is a picture, not a gazetteer; from NAME each
// dot gets its name; from TAG the name is joined by its tagline.
export const TIER_NAME_Z = 1.4;
export const TIER_TAG_Z = 2.4;
export const NAME_MAX_LINES = 3;
export const TAG_MAX_LINES = 3;
// The native name sits between the two. Two rows is plenty for every name in
// the dataset; a name that will not fit in them is simply left off this label
// rather than pushing the tagline out of the water.
export const NATIVE_MAX_LINES = 2;
/* ---- Cells, and the grid they were tuned on ----------------------------
   Every distance below is in cells of the 150-column grid this engine was
   tuned on. The desktop world grid is now 240 columns of the same Earth, so a
   cell is 1.6 times narrower on screen while a label is still set in the same
   11px type — the same name needs 1.6 times as many cells, and a search that
   still reached four of them would reach two thirds as far across the water as
   it used to. `scaleCells()` converts at the point of use, against whatever
   grid `setGrid()` was given, so the labels keep the density they had at the
   same screen size and the mobile grid is not silently retuned with the
   desktop one. */
export const REF_COLS = 150;
export function scaleCells(n, cols) {
  return Math.max(1, Math.round(n * (cols > 0 ? cols : REF_COLS) / REF_COLS));
}
// How far from the dot an anchor may sit, in cells.
export const LABEL_MAX_OFFSET = 4;
export const LABEL_RUN_LIMIT = 44;    // longest free run worth scanning, in cells
// Ocean names breathe: the tracking opens up as you zoom in. pretext takes
// letter-spacing as a px number at prepare() time, so the value is quantized to
// four steps and each (name, step) is prepared at most once for the life of the
// page — a zoom never triggers a new prepare().
export const OCEAN_LS_EM = [0.18, 0.22, 0.26, 0.30];
export const OCEAN_SLIDE = 16;

// Ocean and sea names. Extents are conservative placement windows in degrees
// [west, south, east, north], not coastline polygons (the land mask supplies
// those). Every occupied cell's full lon/lat box must stay inside the window.
// The two Pacific windows stop at the dateline rather than wrapping a label.
// The 240-column Mediterranean has a fifteen-cell run where the 150-column one
// had five, so it takes the stacked "MEDITER- / RANEAN" at zoom 1 and its whole
// name from 1.5x, where it used to fall all the way back to "Med.".
export const OCEANS = [
  { name: "Pacific Ocean", lat: 0, lon: -132, extent: [-170, -50, -85, 60], parts: ["Pacific", "Ocean"], short: "Pacific" },
  { name: "Pacific Ocean", lat: 2, lon: 172, extent: [145, -25, 180, 45], parts: ["Pacific", "Ocean"], short: "Pacific" },
  { name: "Atlantic Ocean", lat: 33, lon: -42, extent: [-65, 0, -10, 60], parts: ["Atlantic", "Ocean"], short: "Atlantic" },
  { name: "Atlantic Ocean", lat: -28, lon: -18, extent: [-50, -55, 18, 0], parts: ["Atlantic", "Ocean"], short: "Atlantic" },
  { name: "Indian Ocean", lat: -22, lon: 78, extent: [40, -50, 110, 0], parts: ["Indian", "Ocean"], short: "Indian" },
  { name: "Southern Ocean", lat: -60, lon: 26, extent: [-180, -70, 180, -55], parts: ["Southern", "Ocean"], short: "Southern" },
  { name: "Arctic Ocean", lat: 84, lon: 10, extent: [-180, 75, 180, 90], parts: ["Arctic", "Ocean"], short: "Arctic" },
  { name: "Mediterranean", lat: 37, lon: 15, extent: [-6, 30, 36, 46], parts: ["Mediter-", "ranean"], short: "Med." },
  { name: "Caribbean Sea", lat: 15, lon: -74, extent: [-88, 9, -60, 22], parts: ["Caribbean", "Sea"], short: "Carib. Sea" },
  { name: "Arabian Sea", lat: 15, lon: 63, extent: [50, 5, 77, 26], parts: ["Arabian", "Sea"], short: "Arab. Sea" },
  { name: "South China Sea", lat: 14, lon: 114, extent: [106, 2, 121, 23], parts: ["South China", "Sea"], short: "S. China Sea" },
  { name: "Tasman Sea", lat: -38, lon: 161, extent: [150, -48, 174, -30], parts: ["Tasman", "Sea"], short: "Tasman" }
];

// Anchor directions, tried in this order at each offset. `dir` is the direction
// the text runs (+1 east, −1 west); `pen` biases the score so a label prefers
// to sit beside its dot rather than above or below it.
export const LABEL_DIRS = [
  { dc: 1, dr: 0, dir: 1, pen: 0 },    // E
  { dc: -1, dr: 0, dir: -1, pen: 1 },  // W
  { dc: 0, dr: -1, dir: 1, pen: 4 },   // N
  { dc: 0, dr: 1, dir: 1, pen: 4 },    // S
  { dc: 1, dr: -1, dir: 1, pen: 6 },   // NE
  { dc: 1, dr: 1, dir: 1, pen: 6 },    // SE
  { dc: -1, dr: -1, dir: -1, pen: 7 }, // NW
  { dc: -1, dr: 1, dir: -1, pen: 7 }   // SW
];

export function tierFor(z) {
  return z >= TIER_TAG_Z ? 2 : (z >= TIER_NAME_Z ? 1 : 0);
}

// The cells a rendered label covers, derived from the geometry that also
// positions it: the anchor cell, the run direction, and each line's painted
// width. Placement marks these; the checks re-walk them.
export function cellsOf(rec) {
  const out = [];
  for (const line of rec.lines) {
    const cells = Math.max(1, Math.ceil((line.width - 0.001) / rec.cellW));
    const col = line.col == null ? rec.col : line.col;
    const c0 = rec.dir > 0 ? col : col - cells + 1;
    for (let dr = 0; dr < (rec.rowSpan || 1); dr++) {
      out.push({ row: line.row + dr, c0: c0, c1: c0 + cells - 1 });
    }
  }
  return out;
}

function fontPxOf(role) {
  const m = role && /(\d*\.?\d+)px/.exec(role.font);
  return m ? parseFloat(m[1]) : 0;
}

/* ---- The engine --------------------------------------------------------- */

/* options
     onLayout(n)        called once per pretext routing/layout call, so the host
                        can count the work it is doing on the main thread
     handleProvider(role, id, text)
                        an already-prepared pretext handle for a localized
                        string, or null. Used on the main thread only. */
export function createLabelEngine(options) {
  const opts = options || {};
  const onLayout = typeof opts.onLayout === "function" ? opts.onLayout : null;
  const provider = typeof opts.handleProvider === "function" ? opts.handleProvider : null;

  let COLS = 0, ROWS = 0, rowSpan = 1;
  // The three cell distances above, converted to this grid once per build.
  let maxOffset = LABEL_MAX_OFFSET, runLimit = LABEL_RUN_LIMIT, oceanSlide = OCEAN_SLIDE;
  let kind = new Uint8Array(0);
  let occupancy = new Uint8Array(0);
  let roles = {};
  let places = [];                  // [{ id, name, native, nativeLang, locale, wordBreak, tagline, col, row }]
  let oceans = OCEANS;

  const nameHandles = new Map();    // place id -> handle (name, uppercased)
  const nativeHandles = new Map();  // place id -> handle or null
  const tagHandles = new Map();     // place id -> handle
  const oceanHandles = new Map();   // name + "|" + step -> handle
  let localizedPrepared = false;
  let preparationCalls = 0;
  const widths = [], visibleIds = new Set(), retained = new Map();

  function tick() { if (onLayout) onLayout(1); }

  const toGridCol = (lon) => Math.max(0, Math.min(COLS - 1, Math.round(((lon + 180) / 360) * COLS)));
  const toGridRow = (lat) => Math.max(0, Math.min(ROWS - 1, Math.round(((90 - lat) / 180) * ROWS)));

  function makeHandle(text, role, extraOptions) {
    preparationCalls++;
    const str = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    const o = {};
    if (role.letterSpacing) o.letterSpacing = role.letterSpacing;
    if (extraOptions && extraOptions.wordBreak && extraOptions.wordBreak !== "normal") {
      o.wordBreak = extraOptions.wordBreak;
    }
    return {
      text: str,
      // Tracking is already included once by the vendored pretext kernel.
      // Keep it only as paint metadata; never add it to a measured width.
      ls: role.letterSpacing || 0,
      pre: prepareWithSegments(str, role.font, Object.keys(o).length ? o : undefined)
    };
  }

  function nameHandleFor(x) {
    let h = nameHandles.get(x.id);
    // .map-label is `text-transform: uppercase` and pretext does not model
    // text-transform, so the string is uppercased before it is measured.
    if (!h) { h = makeHandle(String(x.name).toUpperCase(), roles["map-label"]); nameHandles.set(x.id, h); }
    return h;
  }

  /* The native names, prepared in one grouped pass exactly the way js/text.js
     does it at boot: setLocale() is global and clears pretext's shared
     measurement caches, so every locale is visited once and the library is put
     back on the page's own locale at the end. Only the worker reaches this —
     on the main thread `handleProvider` hands back js/text.js's own handles. */
  function prepareLocalized() {
    if (localizedPrepared) return;
    localizedPrepared = true;
    const role = roles["map-label-native"];
    if (!role) return;
    const groups = new Map();
    for (const x of places) {
      const text = String(x.native || "");
      if (!text || text === x.name) continue;
      const key = (x.locale || "") + " " + (x.wordBreak || "normal");
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(x);
    }
    if (!groups.size) return;
    for (const group of groups.values()) {
      setLocale(group[0].locale || undefined);
      for (const x of group) {
        nativeHandles.set(x.id, makeHandle(x.native, role, { wordBreak: x.wordBreak }));
      }
    }
    setLocale();   // back to the host's own locale, exactly once
  }

  // The name in its own script, for the label's middle line. Only a genuinely
  // different name earns a line; never uppercased.
  function nativeHandleFor(x) {
    const role = roles["map-label-native"];
    if (!role) return null;
    if (nativeHandles.has(x.id)) return nativeHandles.get(x.id);
    const text = String(x.native || "");
    let h = null;
    if (text && text !== x.name) {
      if (provider) {
        const pre = provider("map-label-native", x.id, text);
        if (pre) h = { text: text, ls: role.letterSpacing || 0, pre: pre };
      }
      if (!h) h = makeHandle(text, role, { wordBreak: x.wordBreak });
    }
    nativeHandles.set(x.id, h);
    return h;
  }

  function tagHandleFor(x) {
    const role = roles["hover-card"];
    if (!role) return null;
    let h = tagHandles.get(x.id);
    if (!h) { h = makeHandle(x.tagline, role); tagHandles.set(x.id, h); }
    return h;
  }

  function oceanHandleFor(name, step) {
    const role = roles["ocean-label"];
    const key = name + "|" + step;
    let h = oceanHandles.get(key);
    if (!h) {
      // Step -1 is the compact fallback; the usual zoom tiers stay unchanged.
      const ls = (step < 0 ? 0 : OCEAN_LS_EM[step]) * fontPxOf(role);
      h = makeHandle(name.toUpperCase(), { font: role.font, letterSpacing: ls });
      tick();
      h.width = measureNaturalWidth(h.pre);
      oceanHandles.set(key, h);
    }
    return h;
  }

  // Free water cells on `row`, starting at `col` and walking in `dir`.
  function freeRun(row, col, dir, limit) {
    if (row < 0 || row >= ROWS) return 0;
    let n = 0, c = col;
    while (n < limit && c >= 0 && c < COLS) {
      const i = row * COLS + c;
      if (kind[i] || occupancy[i]) break;
      n++; c += dir;
    }
    return n;
  }

  function markCells(cells) {
    for (const s of cells) {
      if (s.row < 0 || s.row >= ROWS) continue;
      const base = s.row * COLS;
      for (let c = Math.max(0, s.c0); c <= Math.min(COLS - 1, s.c1); c++) occupancy[base + c] = 1;
    }
  }

  // ---- Routing one candidate ---------------------------------------------
  // Read the free run on each row the label would use, hand those widths to
  // the pure router one row at a time, and let it say whether the whole string
  // survived. A candidate that would have to break a word mid-word comes back
  // incomplete and is discarded.
  function routeAt(handle, anchorCol, dir, cellW, maxLines, startRow) {
    widths.length = 0;
    for (let i = 0; i < maxLines; i++) {
      let run = runLimit;
      for (let dr = 0; dr < rowSpan; dr++) run = Math.min(run, freeRun(startRow + i * rowSpan + dr, anchorCol, dir, runLimit));
      widths.push(run * cellW);
    }
    tick();
    const routed = routeText(handle.pre, widths, 1, {
      maxLines: maxLines,
      text: handle.text,
      startRow: startRow,
      minWidth: cellW,         // a single free cell is not worth a line
      // The lines are painted as one stacked block, so they must live on
      // consecutive rows: a blocked row ends this candidate rather than being
      // skipped over.
      contiguous: true
    });
    for (const line of routed.lines) {
      line.row = startRow + (line.row - startRow) * rowSpan;
      line.y = line.row;
    }
    return routed;
  }

  // Best anchor for one marker, or null when the name cannot be fitted into
  // the sea anywhere near it at this zoom. Moving hosts can prefer an earlier
  // candidate: try its offset, then nearby offsets on the same side first.
  function findAnchor(x, tier, cellW, nativeOn, preferred) {
    const nameH = nameHandleFor(x);
    const nativeH = tier >= 2 && nativeOn ? nativeHandleFor(x) : null;
    const tagH = tier >= 2 ? tagHandleFor(x) : null;
    function candidate(d, off) {
      const col = x.col + d.dc * off;
      const row = x.row + d.dr * off;
      if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
      if (kind[row * COLS + col] || occupancy[row * COLS + col]) return null;
      const name = routeAt(nameH, col, d.dir, cellW, NAME_MAX_LINES, row);
      if (!name.complete || !name.lines.length) return null;
      let from = name.lines[name.lines.length - 1].row + rowSpan;
      // The native name takes the rows straight under the Latin one; if the
      // water there is too narrow for it the label falls back to name +
      // tagline rather than losing the anchor altogether.
      let nativeLines = [];
      if (nativeH) {
        const nat = routeAt(nativeH, col, d.dir, cellW, NATIVE_MAX_LINES, from);
        if (nat.complete && nat.lines.length) {
          nativeLines = nat.lines;
          from = nat.lines[nat.lines.length - 1].row + rowSpan;
        }
      }
      let tagLines = [];
      if (tagH) {
        const tag = routeAt(tagH, col, d.dir, cellW, TAG_MAX_LINES, from);
        if (tag.complete) tagLines = tag.lines;
      }
      const score = name.lines.length * 100 + off * 12 + d.pen +
        (tagH && !tagLines.length ? 40 : 0) +
        (nativeH && !nativeLines.length ? 20 : 0);
      return {
        score: score, row: row, col: col, dir: d.dir,
        anchor: { dc: d.dc, dr: d.dr, off: off },
        nameLines: name.lines, nativeLines: nativeLines, tagLines: tagLines
      };
    }
    if (preferred) {
      const d = LABEL_DIRS.find(d => d.dc === preferred.dc && d.dr === preferred.dr);
      if (d) for (let delta = 0; delta < maxOffset; delta++) {
        for (const off of delta === 0 ? [preferred.off] : [preferred.off - delta, preferred.off + delta]) {
          if (off < 1 || off > maxOffset) continue;
          const at = candidate(d, off);
          if (at) return at;
        }
      }
    }
    let best = null;
    for (let off = 1; off <= maxOffset; off++) {
      for (const d of LABEL_DIRS) {
        const at = candidate(d, off);
        if (at && (!best || at.score < best.score)) best = at;
      }
      if (best) break;   // nearest offset that works wins; distance matters
    }
    return best;
  }

  // Preserve the previous line breaks and marker-relative offset if every
  // occupied cell is still free. Reserve all surviving records before finding
  // replacements so a new search cannot displace a still-valid neighbour.
  function retainAnchor(x, rec, cellW, reuse) {
    if (!rec?.anchor || rec.cellW !== cellW || rec.rowSpan !== rowSpan) return null;
    const { dc, dr, off } = rec.anchor;
    if (off > maxOffset) return null;
    const col = x.col + dc * off, row = x.row + dr * off;
    const dx = col - rec.col, dy = row - rec.row;
    for (const span of rec.cells) {
      if (span.row + dy < 0 || span.row + dy >= ROWS || span.c0 + dx < 0 || span.c1 + dx >= COLS) return null;
      for (let col = span.c0 + dx; col <= span.c1 + dx; col++) {
        const i = (span.row + dy) * COLS + col;
        if (kind[i] || occupancy[i]) return null;
      }
    }
    // Only an animation host lends mutable records. Default atlas results
    // remain independent, including when passed back as preferred anchors.
    const next = reuse ? rec : { ...rec, lines: rec.lines.map(line => ({ ...line })), cells: rec.cells.map(span => ({ ...span })) };
    next.col = col; next.row = row;
    for (const line of next.lines) {
      line.row += dy; line.y += dy;
      if (line.col != null) line.col += dx;
    }
    for (const span of next.cells) { span.row += dy; span.c0 += dx; span.c1 += dx; }
    return next;
  }

  // Which way the native name runs. pretext's richer handle carries an
  // approximate bidi level per segment; the first strong (text) segment
  // decides, and the BCP 47 tag is only the fallback.
  function nativeDirFor(x) {
    const h = nativeHandleFor(x);
    const fallback = dirForLang(x.nativeLang);
    return h ? directionFromLevels(h.pre, fallback) : fallback;
  }

  // ---- Ocean and sea names ------------------------------------------------
  // Search nearby rows and columns, but never let a whole cell leave the named
  // water's extent. Stacks use consecutive rows with independently centred
  // lines. Only a complete form claims occupancy, before place names route.
  function placeOceanLabels(cellW, z, out) {
    const t = Math.max(0, Math.min(1, (z - 1) / (TIER_TAG_Z - 1)));
    const step = Math.round(t * (OCEAN_LS_EM.length - 1));
    for (const ocean of oceans) {
      if (!ocean.extent) continue;   // unknown water is never a safe fallback
      const [west, south, east, north] = ocean.extent;
      const cMin = Math.max(0, Math.ceil((west + 180) / 360 * COLS));
      const cMax = Math.min(COLS - 1, Math.floor((east + 180) / 360 * COLS) - 1);
      const rMin = Math.max(0, Math.ceil((90 - north) / 180 * ROWS));
      const rMax = Math.min(ROWS - 1, Math.floor((90 - south) / 180 * ROWS) - 1);
      const anchorRow = toGridRow(ocean.lat);
      const anchorCol = toGridCol(ocean.lon);
      const rows = [];
      for (let row = rMin; row <= rMax; row++) rows.push(row);
      rows.sort((a, b) => Math.abs(a - anchorRow) - Math.abs(b - anchorRow) || a - b);

      function tryForm(texts, spacing) {
        const handles = texts.map((text) => oceanHandleFor(text, spacing));
        const needs = handles.map((h) => Math.max(1, Math.ceil((h.width - 0.001) / cellW)));
        for (const row of rows) {
          if (row + handles.length - 1 > rMax) continue;
          const lines = [];
          for (let line = 0; line < handles.length; line++) {
            const h = handles[line], need = needs[line];
            const centre = anchorCol - Math.floor(need / 2);
            let start = -1;
            for (let slide = 0; slide <= oceanSlide && start < 0; slide++) {
              for (const delta of slide === 0 ? [0] : [-slide, slide]) {
                const c0 = centre + delta;
                if (c0 < cMin || c0 + need - 1 > cMax) continue;
                if (freeRun(row + line, c0, 1, need) === need) { start = c0; break; }
              }
            }
            if (start < 0) break;
            lines.push({ text: h.text, width: h.width, row: row + line, col: start });
          }
          if (lines.length !== handles.length) continue;
          return {
            id: ocean.name, row: row, col: lines[0].col, dir: 1, cellW: cellW, lsPx: handles[0].ls,
            nameCount: lines.length, nativeCount: 0, lines: lines
          };
        }
        return null;
      }

      const forms = [[ocean.name]];
      if (ocean.parts && ocean.parts.length === 2) forms.push(ocean.parts);
      if (ocean.short) forms.push([ocean.short]);
      let rec = null;
      for (const form of forms) {
        for (let spacing = step; spacing >= -1 && !rec; spacing--) rec = tryForm(form, spacing);
        if (rec) break;
      }
      if (!rec) continue;
      rec.cells = cellsOf(rec);
      markCells(rec.cells);
      out.push(rec);
    }
  }

  /* ---- One placement pass -------------------------------------------------
     params
       tier        0 (nothing), 1 (name), 2 (name + native + tagline)
       zoom        the current view zoom
       cellW       one grid cell in screen px (CHARW * zoom)
       dotCells    radius, in cells, of the marker dot's keep-clear square
       cropRows    rows off the top (and the bottom) of the viewport, 0 usually
       oceanOn     place the ocean and sea names
       nativeNames the label carries the name in its own script from tier 2
       visible     array of visible place ids, or null for "everything"
       preferred   optional Map of id -> previous label record, from the same
                   strings, font roles and tier; offsets follow each marker
       output      optional reusable result with labels/ oceans arrays; also
                   permits updating retained records in place */
  function place(params) {
    const p = params || {};
    const tier = p.tier | 0;
    const cellW = Number(p.cellW) || 1;
    const dotCells = Math.max(0, p.dotCells | 0);
    visibleIds.clear();
    if (p.visible) for (const id of p.visible) visibleIds.add(id);
    const visible = p.visible ? visibleIds : null;
    // The atlas owns each returned result. Animation hosts may instead lend
    // output arrays whose contents are valid only until the next placement.
    const labels = p.output?.labels || [];
    const oceanRecs = p.output?.oceans || [];
    labels.length = 0;
    oceanRecs.length = 0;

    occupancy.fill(0);

    /* Rows the viewport is not showing. Under js/map.js's cover fit the world
       grid fills the hero's width and its polar rows run off the top and the
       bottom, so those rows are claimed before anything routes into them: a
       name placed there would be unreadable until the reader panned, and an
       ocean name with nowhere else to go — the Arctic, the Southern Ocean — is
       dropped rather than hidden. Zero under the contain fit, where this loop
       does nothing at all. */
    const crop = Math.max(0, Math.min(ROWS >> 1, p.cropRows | 0));
    for (let r = 0; r < crop; r++) {
      const top = r * COLS, bottom = (ROWS - 1 - r) * COLS;
      for (let c = 0; c < COLS; c++) { occupancy[top + c] = 1; occupancy[bottom + c] = 1; }
    }

    // The dots come first: no label may sit under one.
    for (const x of places) {
      if (visible && !visible.has(x.id)) continue;
      for (let dr = -dotCells; dr <= dotCells; dr++) {
        const rr = x.row + dr;
        if (rr < 0 || rr >= ROWS) continue;
        for (let dc = -dotCells; dc <= dotCells; dc++) {
          const cc = x.col + dc;
          if (cc < 0 || cc >= COLS) continue;
          occupancy[rr * COLS + cc] = 1;
        }
      }
    }

    if (p.oceanOn) placeOceanLabels(cellW, Number(p.zoom) || 1, oceanRecs);

    if (tier > 0) {
      retained.clear();
      if (p.preferred) for (const x of places) {
        if (visible && !visible.has(x.id)) continue;
        const rec = retainAnchor(x, p.preferred.get(x.id), cellW, Boolean(p.output));
        if (!rec) continue;
        markCells(rec.cells);
        retained.set(x.id, rec);
      }
      for (const x of places) {
        if (visible && !visible.has(x.id)) continue;
        if (retained.has(x.id)) { labels.push(retained.get(x.id)); continue; }
        const best = findAnchor(x, tier, cellW, p.nativeNames !== false, p.preferred?.get(x.id)?.anchor);
        if (!best) continue;
        const rec = {
          id: x.id, row: best.row, col: best.col, dir: best.dir, cellW: cellW,
          anchor: best.anchor,
          rowSpan: rowSpan, nameCount: best.nameLines.length,
          nativeCount: best.nativeLines.length,
          nativeLang: best.nativeLines.length ? (x.nativeLang || "") : "",
          nativeDir: best.nativeLines.length ? nativeDirFor(x) : "ltr",
          lines: best.nameLines.concat(best.nativeLines, best.tagLines)
        };
        rec.cells = cellsOf(rec);
        markCells(rec.cells);
        labels.push(rec);
      }
    }

    const result = p.output || {};
    result.labels = labels; result.oceans = oceanRecs;
    result.tier = tier; result.zoom = Number(p.zoom) || 1;
    return result;
  }

  return {
    setGrid: function (cfg) {
      const sameSize = COLS === (cfg.cols | 0) && ROWS === (cfg.rows | 0);
      COLS = cfg.cols | 0;
      ROWS = cfg.rows | 0;
      rowSpan = Math.max(1, cfg.rowSpan | 0);
      maxOffset = scaleCells(cfg.maxOffset ?? LABEL_MAX_OFFSET, COLS);
      runLimit = scaleCells(LABEL_RUN_LIMIT, COLS);
      oceanSlide = scaleCells(OCEAN_SLIDE, COLS);
      kind = cfg.land;
      if (!sameSize) occupancy = new Uint8Array(COLS * ROWS);
      else occupancy.fill(0);
    },
    setRoles: function (r) { roles = r || {}; },
    setOceans: function (list) { oceans = list || OCEANS; },
    // [{ id, name, native, nativeLang, locale, wordBreak, tagline, col, row }]
    setPlaces: function (list) {
      places = list || [];
      if (!provider) prepareLocalized();
    },
    // The marker cells move when the map is rebuilt at a new cell size.
    setMarkerCells: function (cells) {
      for (const x of places) {
        const at = cells[x.id];
        if (!at) continue;
        x.col = at[0]; x.row = at[1];
      }
    },
    // Animation hosts explicitly warm every handle before their first frame.
    preparePlaces: function () {
      for (const x of places) { nameHandleFor(x); nativeHandleFor(x); tagHandleFor(x); }
    },
    preparationCount: function () { return preparationCalls; },
    place: place,
    // The live occupancy mask, so js/sea.js can route around this pass's labels.
    occupancy: function () { return occupancy; },
    land: function () { return kind; },
    dims: function () { return { cols: COLS, rows: ROWS }; }
  };
}
