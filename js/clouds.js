/* Atlas of the Curious — ASCII clouds (pure).

   The map is a page of characters, so its sky is drawn in the map's own
   alphabet: every cloud is a little ASCII drawing that lands on whole cells of
   the character grid,

           .--.
        .-(    ).
       (__________)

   generated rather than stamped, so six clouds in the sky never show the same
   shape twice and a cloud is never quite the shape it was a minute ago.

   The module is pure data in / data out: no DOM, no canvas, no `Math.random`.
   js/map.js paints the strings it returns (one fillText per row) and fills the
   blank interior with the soft white sprite; scripts/checks/clouds.mjs checks
   the same geometry in Node. Identical seeds give byte-identical clouds in
   both, which is what makes the outline testable at all.

   The pipeline has three stages:

     1. A silhouette — a filled cell mask — from either a hand-drawn template
        (the classic drawings, below) or 3..6 overlapping lobes rasterised onto
        a small grid. Both are then stretched, mirrored and jittered, so a
        template is a seed for a family of clouds rather than a stamp.

     2. Closure. Every row's filled cells are collapsed into one run, and so is
        every column's, repeatedly until nothing changes; then every row is
        nested inside the row below it and made one to three cells narrower,
        because a cloud is wider at the bottom than at the top. That leaves the
        bottom row as the widest — the flat `_` base line — with every column
        running unbroken down to it, and it is exactly what makes the outline
        closed: an interior cell always has a boundary cell to its left and to
        its right on its row, and one above and one below in its column.

     3. Tracing. Each boundary cell picks a glyph out of the classic cloud
        vocabulary — `.` `-` along the top, `_` along the base, `(` `)` down the
        sides and wherever the edge turns into the white interior, `~` for a
        frayed west edge (the drift runs west to east), `,` `'` and a backtick
        for the odd curled corner — and the cells inside stay blank for the soft
        fill to show through.

   Cells are about twice as tall as they are wide, so the raster is aspect
   corrected: a lobe that is round on screen is wide and flat in cells. */

// The silhouette's size envelope, in grid cells. A cloud narrower than
// minCols cannot hold an outline and an interior; wider than maxCols and it
// stops reading as one cloud. scripts/checks/clouds.mjs asserts these.
export const CLOUD_BOUNDS = Object.freeze({
  minCols: 8, maxCols: 26, minRows: 2, maxRows: 6
});

// Grid cell height / cell width. js/map.js passes its measured value
// (LINEH / CHARW, about 2); this is the fallback for tests and for callers
// that only want a shape.
export const DEFAULT_ASPECT = 1.95;

// Every glyph the tracer is allowed to emit, interior blank included.
export const CLOUD_GLYPHS = Object.freeze(Array.from(" .-_()~,'`"));

/* The hand-drawn seeds. Only the silhouette is read off these: any non-space
   is "filled", and the closure stage turns the drawing into a solid mask, so
   the interior spaces of `(    )` count as inside. The first is the classic
   three-line cloud; the rest are a low shelf, a two-line wisp and a tower. */
export const CLOUD_TEMPLATES = Object.freeze([
  {
    name: "puff",
    art: Object.freeze([
      "    .--.",
      " .-(    ).",
      "(___.__)__)"
    ])
  },
  {
    name: "shelf",
    art: Object.freeze([
      "      .--.",
      "   .-(    )--.",
      "  (____________)"
    ])
  },
  {
    name: "wisp",
    art: Object.freeze([
      "   .-~-.",
      "  (_____)"
    ])
  },
  {
    name: "tower",
    art: Object.freeze([
      "        .-.",
      "      .(   ).",
      "   .-(       )-.",
      " .(             ).",
      "(_________________)"
    ])
  }
]);

/* ------------------------------------------------------------------ *
 * Deterministic randomness                                            *
 * ------------------------------------------------------------------ */

// mulberry32: small, fast, and good enough for shapes. A cloud's identity is
// its seed, so the same seed must give the same cloud in Node and the browser.
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Two integers into one well-mixed seed: a cloud's structure comes from its
// seed alone, its edge detail from (seed, morph), so a morph rewrites the
// fringe of the same cloud instead of handing back a different cloud.
export function mixSeed(a, b) {
  let h = ((a >>> 0) ^ Math.imul(((b >>> 0) + 0x9e3779b9) >>> 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/* ------------------------------------------------------------------ *
 * Masks                                                               *
 * ------------------------------------------------------------------ */

function newMask(width, height) {
  return { cells: new Uint8Array(Math.max(0, width * height)), width: width, height: height };
}

function maskFromArt(art) {
  let width = 0;
  for (const line of art) width = Math.max(width, line.length);
  const mask = newMask(width, art.length);
  for (let r = 0; r < art.length; r++) {
    const line = art[r];
    for (let c = 0; c < line.length; c++) {
      if (line.charCodeAt(c) !== 32) mask.cells[r * width + c] = 1;
    }
  }
  return mask;
}

// One run per row and one per column, iterated to a fixed point. Only ever
// adds cells, so it terminates; six rounds is far more than any cloud needs.
function closeMask(mask) {
  const cells = mask.cells, width = mask.width, height = mask.height;
  for (let round = 0; round < 6; round++) {
    let changed = false;
    for (let r = 0; r < height; r++) {
      const base = r * width;
      let lo = -1, hi = -1;
      for (let c = 0; c < width; c++) if (cells[base + c]) { if (lo < 0) lo = c; hi = c; }
      for (let c = lo; c >= 0 && c <= hi; c++) if (!cells[base + c]) { cells[base + c] = 1; changed = true; }
    }
    for (let c = 0; c < width; c++) {
      let lo = -1, hi = -1;
      for (let r = 0; r < height; r++) if (cells[r * width + c]) { if (lo < 0) lo = r; hi = r; }
      for (let r = lo; r >= 0 && r <= hi; r++) if (!cells[r * width + c]) { cells[r * width + c] = 1; changed = true; }
    }
    if (!changed) break;
  }
  return mask;
}

function trimMask(mask) {
  const cells = mask.cells, width = mask.width, height = mask.height;
  let c0 = width, c1 = -1, r0 = height, r1 = -1;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!cells[r * width + c]) continue;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
    }
  }
  if (c1 < 0) return newMask(0, 0);
  const out = newMask(c1 - c0 + 1, r1 - r0 + 1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      out.cells[(r - r0) * out.width + (c - c0)] = cells[r * width + c];
    }
  }
  return out;
}

// Nearest-neighbour resample: how a template is stretched, and how a traced
// shape is pulled back inside CLOUD_BOUNDS.
function scaleMask(mask, width, height) {
  if (!mask.width || !mask.height) return newMask(0, 0);
  if (width === mask.width && height === mask.height) return mask;
  const out = newMask(Math.max(1, width), Math.max(1, height));
  for (let r = 0; r < out.height; r++) {
    const sr = Math.min(mask.height - 1, Math.floor((r + 0.5) * mask.height / out.height));
    for (let c = 0; c < out.width; c++) {
      const sc = Math.min(mask.width - 1, Math.floor((c + 0.5) * mask.width / out.width));
      out.cells[r * out.width + c] = mask.cells[sr * mask.width + sc];
    }
  }
  return out;
}

function mirrorMask(mask) {
  const out = newMask(mask.width, mask.height);
  for (let r = 0; r < mask.height; r++) {
    for (let c = 0; c < mask.width; c++) {
      out.cells[r * mask.width + c] = mask.cells[r * mask.width + (mask.width - 1 - c)];
    }
  }
  return out;
}

// Aspect-corrected ellipses. `cy` is in rows, `rx`/`ry` in cell widths, so a
// lobe that looks round on screen is flat in cells.
function paintLobes(mask, lobes, aspect) {
  const cells = mask.cells, width = mask.width, height = mask.height;
  for (const lobe of lobes) {
    const rx2 = lobe.rx * lobe.rx, ry2 = lobe.ry * lobe.ry;
    for (let r = 0; r < height; r++) {
      const dy = ((r + 0.5) - lobe.cy) * aspect;
      const yy = (dy * dy) / ry2;
      if (yy > 1) continue;
      for (let c = 0; c < width; c++) {
        const dx = (c + 0.5) - lobe.cx;
        if ((dx * dx) / rx2 + yy <= 1) cells[r * width + c] = 1;
      }
    }
  }
  return mask;
}

// The cloud's profile: taller lobes in the middle, smaller ones at the ends,
// all of them sitting on the same floor so the silhouette has a base to flatten.
function lobesFor(width, height, count, aspect, rng) {
  const lobes = [];
  const floor = height - 0.1;
  for (let i = 0; i < count; i++) {
    const span = (i + 0.5) / count;
    const cx = width * (0.10 + 0.80 * span) + (rng() - 0.5) * (width / count) * 0.6;
    const middling = 1 - Math.abs(span - 0.5) * 1.4;        // 0.3 at the ends, 1 in the middle
    const reach = clamp(middling * (0.55 + rng() * 0.45), 0.18, 1);
    const top = (height - 0.6) * (1 - reach);
    const ry = Math.max(0.55, (floor - top) / 2);
    lobes.push({
      cx: cx,
      cy: (top + floor) / 2,
      rx: width * (0.13 + rng() * 0.15) + 1,
      ry: ry * aspect
    });
  }
  return lobes;
}

// The morph: the same lobes, nudged. Small enough that a cross-fade reads as
// the cloud churning rather than as one cloud replacing another.
function jitterLobes(lobes, rng, amount) {
  return lobes.map((lobe) => ({
    cx: lobe.cx + (rng() - 0.5) * 1.6 * amount,
    cy: lobe.cy + (rng() - 0.5) * 0.35 * amount,
    rx: Math.max(1, lobe.rx * (1 + (rng() - 0.5) * 0.22 * amount)),
    ry: Math.max(0.6, lobe.ry * (1 + (rng() - 0.5) * 0.22 * amount))
  }));
}

// A template's edges, nudged a cell at a time. The mask is padded first so a
// row can also grow outward, and re-closed afterwards.
function jitterEdges(mask, rng, amount) {
  if (!mask.width || !mask.height) return mask;
  const pad = 2;
  const out = newMask(mask.width + pad * 2, mask.height);
  for (let r = 0; r < mask.height; r++) {
    let lo = -1, hi = -1;
    for (let c = 0; c < mask.width; c++) if (mask.cells[r * mask.width + c]) { if (lo < 0) lo = c; hi = c; }
    if (lo < 0) continue;
    const step = () => {
      const d = rng();
      if (d < 0.3 * amount) return -1;
      if (d > 1 - 0.3 * amount) return 1;
      return 0;
    };
    lo = clamp(lo + pad + step(), 0, out.width - 1);
    hi = clamp(hi + pad + step(), lo, out.width - 1);
    for (let c = lo; c <= hi; c++) out.cells[r * out.width + c] = 1;
  }
  return out;
}

/* A cloud is wider at the bottom than at the top, and that one fact is what
   turns a lumpy blob into the classic drawing: every row's run is nested inside
   the run below it and is one to three cells narrower, so

     - the bottom row is the widest, and becomes the flat `_` base line;
     - every column runs unbroken from wherever it starts down to that base, so
       the silhouette is orthogonally convex and the outline closes;
     - each step between two rows is where the top edge turns into a side, which
       is where `(` and `)` belong.

   Rows shrink by an unequal amount at each end, so the profile stays lumpy and
   asymmetric; a row with nothing left of it is dropped (and so is everything
   above it, since nothing may float). */
function nestRows(mask, rng) {
  const cells = mask.cells, width = mask.width, height = mask.height;
  const lo = new Int16Array(height).fill(-1);
  const hi = new Int16Array(height).fill(-1);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!cells[r * width + c]) continue;
      if (lo[r] < 0) lo[r] = c;
      hi[r] = c;
    }
  }
  for (let r = height - 2; r >= 0; r--) {
    if (hi[r] < 0) continue;
    if (hi[r + 1] < 0) { lo[r] = -1; hi[r] = -1; continue; }
    let a = Math.max(lo[r], lo[r + 1]), b = Math.min(hi[r], hi[r + 1]);
    const cap = (hi[r + 1] - lo[r + 1] + 1) - (1 + ((rng() * 2.6) | 0));
    while (b - a + 1 > cap && b >= a) { if (rng() < 0.5) a++; else b--; }
    // Under three cells there is no room for a `.-.` crown, only a stray
    // dash, so the row (and everything above it) is dropped instead.
    if (b - a + 1 < 3 || cap < 3) { lo[r] = -1; hi[r] = -1; } else { lo[r] = a; hi[r] = b; }
  }
  cells.fill(0);
  for (let r = 0; r < height; r++) {
    for (let c = lo[r]; c >= 0 && c <= hi[r]; c++) cells[r * width + c] = 1;
  }
  return mask;
}

/* ------------------------------------------------------------------ *
 * Tracing the outline                                                 *
 * ------------------------------------------------------------------ */

// Cell codes in the traced grid.
export const CELL_EMPTY = 0, CELL_OUTLINE = 1, CELL_INTERIOR = 2;

const WISP = 0.20;   // how often a trailing edge frays into `~`
const CURL = 0.16;   // how often a corner curls into `,`, a backtick, or `'`
// How hard a morph shakes the shape. Small: a cross-fade should read as the
// same cloud churning, not as one cloud being swapped for another.
const MORPH_AMOUNT = 0.55;

function trace(mask, rng) {
  const cells = mask.cells, width = mask.width, height = mask.height;
  const top = new Int16Array(width).fill(-1);
  const bot = new Int16Array(width).fill(-1);
  for (let c = 0; c < width; c++) {
    for (let r = 0; r < height; r++) {
      if (!cells[r * width + c]) continue;
      if (top[c] < 0) top[c] = r;
      bot[c] = r;
    }
  }
  const rowLo = new Int16Array(height).fill(-1);
  const rowHi = new Int16Array(height).fill(-1);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!cells[r * width + c]) continue;
      if (rowLo[r] < 0) rowLo[r] = c;
      rowHi[r] = c;
    }
  }
  // A filled cell is inside only when it is not the end of its row's run and
  // not the end of its column's run. Everything else is the outline.
  const grid = new Uint8Array(width * height);
  let interiorCells = 0, outlineCells = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (!cells[i]) continue;
      const inside = top[c] !== r && bot[c] !== r && rowLo[r] !== c && rowHi[r] !== c;
      grid[i] = inside ? CELL_INTERIOR : CELL_OUTLINE;
      if (inside) interiorCells++; else outlineCells++;
    }
  }

  const lines = new Array(height);
  const interior = [];
  for (let r = 0; r < height; r++) {
    const lo = rowLo[r], hi = rowHi[r];
    if (lo < 0) { lines[r] = ""; continue; }
    let out = "";
    for (let c = 0; c < lo; c++) out += " ";
    let opens = 0, closes = 0, runStart = -1;
    for (let c = lo; c <= hi; c++) {
      const i = r * width + c;
      if (grid[i] === CELL_INTERIOR) {
        if (runStart < 0) runStart = c;
        out += " ";
        continue;
      }
      if (runStart >= 0) { interior.push([r, runStart, c - 1]); runStart = -1; }
      const isTop = top[c] === r, isBot = bot[c] === r;
      const leftIn = c > lo && grid[i - 1] === CELL_INTERIOR;
      const rightIn = c < hi && grid[i + 1] === CELL_INTERIOR;
      let g;
      if (leftIn && rightIn) {
        // One cell wedged between two white runs: it closes one and opens the
        // next, and only one glyph fits. Pick whichever keeps the row balanced.
        g = opens > closes ? ")" : "(";
      } else if (rightIn) {
        g = "(";                                  // the edge turns into the left wall
      } else if (leftIn) {
        g = ")";                                  // ...and back out of the right wall
      } else if (!isTop && !isBot) {
        g = c === lo ? "(" : ")";                 // a plain side wall
      } else if (isTop && isBot) {
        // A column one row tall: part of the base line, or a wisp off the side.
        const onBase = r === height - 1;
        if (c === lo) g = onBase ? "(" : (rng() < WISP ? "~" : ".");
        else if (c === hi) g = onBase ? ")" : (rng() < WISP ? "~" : ".");
        else g = onBase ? "_" : "-";
      } else if (isTop) {
        const stepL = c === lo || top[c - 1] !== r;
        const stepR = c === hi || top[c + 1] !== r;
        if (stepL && stepR) g = rng() < WISP ? "~" : "-";
        else if (stepL) {
          // The west end trails: the drift runs west to east, so this is the
          // edge that frays. `,` and a backtick read as a curl, `~` as a wisp.
          const d = rng();
          g = d < WISP ? "~" : d < WISP + CURL ? "," : d < WISP + CURL * 2 ? "`" : ".";
        } else if (stepR) g = rng() < CURL ? "'" : ".";
        else g = "-";
      } else if (c === lo) {
        g = "(";                                  // the base line's own left corner
      } else if (c === hi) {
        g = ")";
      } else {
        g = "_";                                  // the base, and every under-edge
      }
      if (g === "(") opens++;
      else if (g === ")") closes++;
      out += g;
    }
    if (runStart >= 0) interior.push([r, runStart, hi]);   // unreachable: hi is outline
    lines[r] = out;
  }
  return {
    cols: width, rows: height, lines: lines, grid: grid,
    interior: interior, interiorCells: interiorCells, outlineCells: outlineCells
  };
}

/* ------------------------------------------------------------------ *
 * The generator                                                       *
 * ------------------------------------------------------------------ */

/* One cloud.

     seed    integer; the cloud's identity. The template or lobe layout, the
             size and the mirroring all come from here and only from here.
     morph   integer, default 0; the edge detail. Same seed, next morph = the
             same cloud a moment later, which is what js/map.js cross-fades.
     size    0..1, optional; how big inside CLOUD_BOUNDS. Default: from the seed.
     aspect  cell height / cell width. Default DEFAULT_ASPECT.

   Returns { seed, morph, source, cols, rows, lines, key, grid, interior,
             interiorCells, outlineCells }, where `lines` is one padded string
             per grid row (drawn with one fillText each), `grid` is a
             cols*rows Uint8Array of CELL_* codes and `interior` is the blank
             inside as [row, firstCol, lastCol] runs — the mask the soft white
             fill is clipped to. */
export function generateCloud(options) {
  const opts = options || {};
  const seed = (opts.seed === undefined ? 1 : opts.seed) >>> 0;
  const morph = (opts.morph || 0) | 0;
  const aspect = opts.aspect > 0 ? opts.aspect : DEFAULT_ASPECT;
  const B = CLOUD_BOUNDS;
  const shapeRng = makeRng(seed);
  // Structure first, always in the same order, so `morph` cannot change it.
  // Skewed to the larger half of the envelope: a cloud has to be a few cells
  // across before an outline of single characters reads as a drawing at all.
  const size = opts.size === undefined || opts.size === null
    ? Math.pow(shapeRng(), 0.7) : clamp(opts.size, 0, 1);
  const useTemplate = shapeRng() < 0.45;
  const template = CLOUD_TEMPLATES[(shapeRng() * CLOUD_TEMPLATES.length) | 0];
  const flipped = shapeRng() < 0.5;
  const lobeCount = 3 + ((shapeRng() * 4) | 0);        // 3..6 lobes
  const baseLobes = lobesFor(
    Math.round(B.minCols + size * (B.maxCols - B.minCols)),
    clamp(Math.round(B.minRows + 0.5 + size * (B.maxRows - B.minRows)), B.minRows, B.maxRows),
    lobeCount, aspect, shapeRng
  );

  let cols = Math.round(B.minCols + size * (B.maxCols - B.minCols));
  let rows = clamp(Math.round(B.minRows + 0.5 + size * (B.maxRows - B.minRows)), B.minRows, B.maxRows);
  let traced = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    // A fresh detail stream per attempt, so the answer depends on the inputs
    // and not on how many attempts it took to get an interior.
    const detail = makeRng(mixSeed(mixSeed(seed, morph + 1), attempt));
    let mask;
    // A hand-drawn seed is already a legal silhouette, so the later attempts
    // fall back to one: whatever the lobes did, the loop still ends in a cloud.
    if (useTemplate || attempt >= 2) {
      mask = scaleMask(maskFromArt(template.art), cols, rows);
      if (flipped) mask = mirrorMask(mask);
      mask = jitterEdges(mask, detail, MORPH_AMOUNT);
    } else {
      mask = paintLobes(newMask(cols, rows), jitterLobes(baseLobes, detail, MORPH_AMOUNT), aspect);
      if (flipped) mask = mirrorMask(mask);
    }
    // Trim first: nesting hangs everything off the bottom row, so that row has
    // to be a row of the cloud and not the empty bottom of the raster. The taper
    // runs off the seed alone, so a morph re-frays the edges of the same cloud
    // rather than restacking it.
    mask = trimMask(nestRows(trimMask(closeMask(mask)), makeRng(mixSeed(seed, ~attempt))));
    // Back inside the envelope if the jitter pushed a shape out of it.
    const fitCols = clamp(mask.width, B.minCols, B.maxCols);
    const fitRows = clamp(mask.height, B.minRows, B.maxRows);
    if (fitCols !== mask.width || fitRows !== mask.height) {
      mask = trimMask(closeMask(scaleMask(mask, fitCols, fitRows)));
    }
    traced = trace(mask, makeRng(mixSeed(seed ^ 0x2545f491, morph + 1)));
    // A cloud with no white inside it is an outline, not a cloud: give the
    // next attempt another row and a couple more columns to work with.
    if (traced.interiorCells >= 2) break;
    rows = Math.min(B.maxRows, rows + 1);
    cols = Math.min(B.maxCols, cols + 2);
  }
  return {
    seed: seed, morph: morph,
    source: useTemplate ? "template:" + template.name : "lobes:" + lobeCount,
    cols: traced.cols, rows: traced.rows, lines: traced.lines,
    key: traced.lines.join("|"),
    grid: traced.grid, interior: traced.interior,
    interiorCells: traced.interiorCells, outlineCells: traced.outlineCells
  };
}

/* A skyful of clouds, all different. Seeds are walked forward until the shape
   is one this set has not already used, so `count` clouds are `count` distinct
   drawings — the thing that stops a generated sky from looking stamped. */
export function generateCloudSet(count, options) {
  const opts = options || {};
  const base = (opts.seed === undefined ? 1 : opts.seed) >>> 0;
  const out = [];
  const seen = new Set();
  let seed = base;
  for (let i = 0; i < count; i++) {
    let cloud = null;
    for (let tries = 0; tries < 32; tries++) {
      seed = mixSeed(seed, i + 1);
      const candidate = generateCloud({
        seed: seed, morph: opts.morph || 0, size: opts.size, aspect: opts.aspect
      });
      if (!seen.has(candidate.key)) { cloud = candidate; break; }
    }
    if (!cloud) cloud = generateCloud({ seed: seed, morph: opts.morph || 0, aspect: opts.aspect });
    seen.add(cloud.key);
    out.push(cloud);
  }
  return out;
}
