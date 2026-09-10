/* Atlas of the Curious — variable-width text routing.

   One job: given a pretext `prepareWithSegments()` handle and a list of
   per-row available widths, lay the text out one row at a time — each row may
   be a different width — and hand back the lines that fit.

   That is what a coastline needs. The Text Atlas places a name into the sea
   next to its marker, and the sea is not a rectangle: row 14 might have nine
   free cells before it hits Newfoundland while row 15 has twenty-two. Feeding
   those widths to `layoutNextLineRange()` one at a time (the routine pretext's
   /demos/dynamic-layout uses to flow an article around a logo) makes the label
   hug the coast instead of overlapping it.

   The module is deliberately pure: it imports the vendored pretext layout
   kernel and nothing else — no `document`, no `window`, no timers — so Phase 5
   can move it into a Web Worker unchanged, and so it can be reasoned about in
   plain Node given a prepared handle.

   The whole-text check is the important subtlety. `layoutNextLineRange()`
   always returns *something* for a positive width: asked to fit "ZHANGJIAJIE"
   into three cells it breaks inside the word. A label that reads "ZHANGJIA /
   JIE" is worse than no label, so `routeText()` reports `complete: false`
   unless the routed lines, joined with single spaces, reproduce the original
   string exactly. A caller that passes `options.text` therefore gets a clean
   "did this candidate work?" answer, and map.js can move on to the next
   anchor direction. */
import { layoutNextLineRange, materializeLineRange } from "../vendor/pretext/layout.js";

// A width no real column reaches, used to ask "is the text exhausted?".
const UNBOUNDED = 1e7;
const START_CURSOR = { segmentIndex: 0, graphemeIndex: 0 };

// pretext normalizes runs of whitespace when it prepares text; do the same to
// the comparison string so `complete` compares like with like.
export function normalizeText(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

/* Route `prepared` through a ragged column.

   prepared   — a pretext prepareWithSegments() handle
   rowWidths  — available width per row, in the same px unit the handle was
                measured in (for the Text Atlas: free cells × cell width on
                screen). A row narrower than `minWidth` is skipped, not broken
                into — the text simply continues on the next row.
   lineHeight — px per row; only used to fill in each line's `y`.
   options
     maxLines    cap on the number of lines (default: rowWidths.length)
     minWidth    rows narrower than this hold no text (default 0)
     contiguous  when true, a row too narrow to hold text ends the run instead
                 of being skipped. A map label wants this: its lines are
                 painted as one stacked block, so a hole in the middle of the
                 column would silently shift every line below it up a row —
                 and straight onto whatever already owns that row
     extraWidth  px of chrome each rendered line pays on top of the measured
                 text — CSS letter-spacing paints one extra gap after the last
                 grapheme that pretext does not count, so passing the role's
                 letter-spacing keeps the routed width equal to the painted one
     startRow    row index the first entry of rowWidths stands for (default 0),
                 so a second call can continue below the first
     cursor      resume from a previous result's `cursor`
     text        the original string; supplying it turns on the whole-text
                 check described above

   Returns { lines, cursor, complete, height, width } where `lines` is an
   array of { text, width, row, y }. */
export function routeText(prepared, rowWidths, lineHeight, options) {
  const opts = options || {};
  const widths = rowWidths || [];
  const maxLines = Number.isFinite(opts.maxLines) ? Math.max(0, Math.floor(opts.maxLines)) : widths.length;
  const minWidth = Number(opts.minWidth) || 0;
  const contiguous = !!opts.contiguous;
  const extra = Number(opts.extraWidth) || 0;
  const startRow = Math.floor(Number(opts.startRow) || 0);
  const lh = Number(lineHeight) || 0;

  const lines = [];
  let cursor = opts.cursor || START_CURSOR;
  let widest = 0;
  let ranOut = false;

  for (let i = 0; i < widths.length && lines.length < maxLines; i++) {
    const available = Number(widths[i]) || 0;
    const usable = available - extra;
    if (available < minWidth || usable <= 0) {  // no usable water on this row
      if (contiguous) break;
      continue;
    }
    const range = layoutNextLineRange(prepared, cursor, usable);
    if (range === null) { ranOut = true; break; }
    cursor = range.end;
    const line = materializeLineRange(prepared, range);
    // pre-wrap keeps a hanging trailing space; it would paint past the edge.
    const text = line.text.replace(/\s+$/, "");
    if (!text) continue;
    const width = line.width + extra;
    if (width > widest) widest = width;
    const row = startRow + i;
    lines.push({ text: text, width: width, row: row, y: row * lh });
  }

  let complete;
  if (opts.text == null) {
    // No reference string: "complete" just means pretext has nothing left.
    complete = ranOut || layoutNextLineRange(prepared, cursor, UNBOUNDED) === null;
  } else {
    complete = lines.map(lineTextOf).join(" ") === normalizeText(opts.text);
  }

  return {
    lines: lines,
    cursor: cursor,
    complete: complete,
    height: lines.length * lh,
    width: widest
  };
}

function lineTextOf(line) { return line.text; }
