/* Atlas of the Curious — paragraph justification and river detection.

   A port of the model behind pretext's /demos/justification-comparison into a
   pure module: prepared text + a width in, lines with per-word x offsets and a
   river report out. It imports the vendored pretext layout kernel for nothing
   at all — every number it needs is already inside the
   `prepareWithSegments()` handle (`segments`, `widths`, `kinds`,
   `discretionaryHyphenWidth`), so this file has no imports, no `document`, no
   `window` and no timers. Phase 5 can move it into a Web Worker unchanged.

   Two line breakers share one break-candidate table:

     - `greedy`  — first fit, the same decision CSS makes. Cheap; used for the
                   ragged-right column and as the safety net when the optimal
                   pass finds no feasible path (a word wider than the column).
     - `optimal` — Knuth-Plass: a dynamic program over break candidates whose
                   badness is the cube of the space-stretch ratio plus explicit
                   penalties for rivers, over-tight lines and hyphenated
                   breaks. The pruning is what keeps it near-linear: candidate
                   ranges are scanned backwards and abandoned as soon as even
                   the allowed compression cannot fit the words.

   A "river" here is the vertical channel a reader's eye follows down a
   justified column: gaps on consecutive lines whose centres line up within a
   fraction of the gap's own width. `riverReport()` returns the longest such
   chain, which is the number the dialog optimises for when it tries three
   column widths.

   Nothing in this file paints; the caller turns `lines[].words[].x` into
   positioned spans. */

/* ------------------------------------------------------------------ *
 * Tuning                                                              *
 * ------------------------------------------------------------------ */

// A line shorter than this fraction of the column is left ragged rather than
// stretched — the demo's SHORT_LINE_RATIO.
const SHORT_LINE_RATIO = 0.6;
// A gap wider than this multiple of the normal space reads as a river.
const RIVER_THRESHOLD = 1.5;
// The DP may not even consider a line whose spaces would have to compress
// below this multiple of the normal space.
const INFEASIBLE_SPACE_RATIO = 0.4;
// Below this multiple the line is declared an overflow instead of justified.
const OVERFLOW_SPACE_RATIO = 0.2;
// Below this multiple the line is "tight" and pays a penalty.
const TIGHT_SPACE_RATIO = 0.65;
// Two gaps on consecutive lines join a river when their centres are within
// this fraction of the wider gap.
const RIVER_ALIGN_RATIO = 0.5;
// …but never closer than this many px, so hairline gaps still chain.
const RIVER_ALIGN_MIN_PX = 1.5;

/* ------------------------------------------------------------------ *
 * 1. The break-candidate table                                        *
 * ------------------------------------------------------------------ */

/* One pass over a prepared handle produces everything both breakers need:

     candidates[i] = { segIndex, kind, wordWidthBefore, spacesBefore }

   `wordWidthBefore` / `spacesBefore` are running totals, so the width of any
   candidate range is one subtraction rather than a scan. `kind` is "start",
   "space", "soft-hyphen" or "end".

   Call it once per (text, font); the result is width-independent, exactly like
   the pretext handle it is derived from. */
export function prepareParagraph(prepared) {
  const kinds = (prepared && prepared.kinds) || [];
  const widths = (prepared && prepared.widths) || [];
  const segments = (prepared && prepared.segments) || [];
  const n = widths.length;

  let spaceWidth = 0;
  for (let i = 0; i < n; i++) {
    if (isSpaceKind(kinds[i])) { spaceWidth = widths[i]; break; }
  }

  const candidates = [];
  let wordWidthBefore = 0;
  let spacesBefore = 0;
  const push = (segIndex, kind) => {
    candidates.push({
      segIndex: segIndex, kind: kind,
      wordWidthBefore: wordWidthBefore, spacesBefore: spacesBefore
    });
  };

  push(0, "start");
  for (let i = 0; i < n; i++) {
    const kind = kinds[i];
    if (kind === "soft-hyphen") {
      if (i + 1 < n) push(i + 1, "soft-hyphen");
    } else if (isSpaceKind(kind)) {
      spacesBefore++;
      if (i + 1 < n) push(i + 1, "space");
    } else {
      wordWidthBefore += widths[i] || 0;
    }
  }
  push(n, "end");

  return {
    segments: segments,
    widths: widths,
    kinds: kinds,
    candidates: candidates,
    spaceWidth: spaceWidth,
    hyphenWidth: (prepared && prepared.discretionaryHyphenWidth) || 0,
    // The widest single word: a column narrower than this cannot be broken
    // without splitting a word, so the caller can widen instead of overflowing.
    maxWordWidth: maxWordWidthOf(segments, widths, kinds),
    segmentCount: n
  };
}

function isSpaceKind(kind) { return kind === "space" || kind === "preserved-space"; }

function maxWordWidthOf(segments, widths, kinds) {
  let worst = 0;
  let run = 0;
  for (let i = 0; i < widths.length; i++) {
    const kind = kinds[i];
    if (isSpaceKind(kind)) { if (run > worst) worst = run; run = 0; continue; }
    if (kind === "soft-hyphen") continue;
    run += widths[i] || 0;
  }
  return run > worst ? run : worst;
}

/* ------------------------------------------------------------------ *
 * 2. Line stats between two candidates                                *
 * ------------------------------------------------------------------ */

function statsBetween(para, from, to) {
  const a = para.candidates[from];
  const b = para.candidates[to];
  const hyphenated = b.kind === "soft-hyphen";
  const wordWidth =
    b.wordWidthBefore - a.wordWidthBefore + (hyphenated ? para.hyphenWidth : 0);
  const spaceCount = b.spacesBefore - a.spacesBefore - (b.kind === "space" ? 1 : 0);
  return {
    wordWidth: wordWidth,
    spaceCount: spaceCount < 0 ? 0 : spaceCount,
    naturalWidth: wordWidth + Math.max(0, spaceCount) * para.spaceWidth,
    hyphenated: hyphenated,
    lastLine: b.kind === "end"
  };
}

// How a line of these stats would be painted in a column of `maxWidth`.
function spacingFor(para, stats, maxWidth, justify) {
  if (!justify || stats.lastLine || stats.spaceCount <= 0 ||
      stats.naturalWidth < maxWidth * SHORT_LINE_RATIO) {
    return stats.naturalWidth <= maxWidth
      ? { kind: "ragged", width: para.spaceWidth }
      : { kind: "overflow", width: para.spaceWidth };
  }
  const gap = (maxWidth - stats.wordWidth) / stats.spaceCount;
  if (gap < para.spaceWidth * OVERFLOW_SPACE_RATIO) {
    return { kind: "overflow", width: gap };
  }
  return {
    kind: "justified", width: gap,
    isRiver: gap > para.spaceWidth * RIVER_THRESHOLD
  };
}

function badnessOf(para, stats, maxWidth) {
  const spacing = spacingFor(para, stats, maxWidth, true);
  if (spacing.kind === "overflow") return Infinity;
  if (spacing.kind === "ragged") {
    if (stats.lastLine) return 0;               // a short final line is free
    const slack = maxWidth - stats.naturalWidth;
    return slack * slack * 10;
  }

  const gap = spacing.width;
  const normal = para.spaceWidth || 1;
  if (gap < normal * INFEASIBLE_SPACE_RATIO) return Infinity;

  const ratio = (gap - normal) / normal;
  const abs = Math.abs(ratio);
  let badness = abs * abs * abs * 1000;

  const riverExcess = gap / normal - RIVER_THRESHOLD;
  if (riverExcess > 0) badness += 5000 + riverExcess * riverExcess * 10000;

  const tight = normal * TIGHT_SPACE_RATIO;
  if (gap < tight) badness += 3000 + (tight - gap) * (tight - gap) * 10000;

  if (stats.hyphenated) badness += 50;
  return badness;
}

/* ------------------------------------------------------------------ *
 * 3. The two breakers                                                 *
 * ------------------------------------------------------------------ */

// First fit: take the farthest candidate whose natural width still fits.
function breakGreedy(para, from, maxWidth) {
  const cands = para.candidates;
  const last = cands.length - 1;
  const breaks = [];
  let at = from;
  while (at < last) {
    let best = -1;
    for (let to = at + 1; to <= last; to++) {
      const stats = statsBetween(para, at, to);
      if (stats.naturalWidth <= maxWidth) { best = to; continue; }
      // Ranges only grow, so the first overflow ends the search — unless
      // nothing fitted at all, in which case one word has to overflow.
      if (best === -1) best = to;
      break;
    }
    if (best === -1) break;
    breaks.push(best);
    at = best;
  }
  return breaks;
}

// Knuth-Plass: minimise the summed badness of every line in the paragraph.
// Returns null when no feasible path exists (a word wider than the column).
function breakOptimal(para, from, maxWidth) {
  const cands = para.candidates;
  const count = cands.length;
  if (from >= count - 1) return [];

  const dp = new Float64Array(count).fill(Infinity);
  const previous = new Int32Array(count).fill(-1);
  dp[from] = 0;

  for (let to = from + 1; to < count; to++) {
    const isLast = cands[to].kind === "end";
    for (let at = to - 1; at >= from; at--) {
      const stats = statsBetween(para, at, to);
      // Widening the range only adds content: once even the allowed
      // compression cannot fit, no earlier `at` can either.
      const minSpace = para.spaceWidth * (isLast ? 1 : INFEASIBLE_SPACE_RATIO);
      if (stats.wordWidth + stats.spaceCount * minSpace > maxWidth) break;
      if (dp[at] === Infinity) continue;
      const total = dp[at] + badnessOf(para, stats, maxWidth);
      if (total < dp[to]) { dp[to] = total; previous[to] = at; }
    }
  }

  if (dp[count - 1] === Infinity) return null;
  const breaks = [];
  let cur = count - 1;
  while (cur > from) {
    if (previous[cur] === -1) return null;
    breaks.push(cur);
    cur = previous[cur];
  }
  breaks.reverse();
  return breaks;
}

/* ------------------------------------------------------------------ *
 * 4. The public entry point                                           *
 * ------------------------------------------------------------------ */

/* Break `para` into lines of `maxWidth`, starting at break candidate
   `options.from` (0 = the beginning of the paragraph).

   options
     from       break-candidate index to resume at (default 0)
     maxLines   stop after this many lines; the rest of the paragraph is left
                for the next call (default: all of it)
     justify    stretch every line but the last to `maxWidth` (default false)
     x          x offset every word position is measured from (default 0)

   The optimal breaker always optimises the *whole* remaining paragraph, even
   when only `maxLines` of it are wanted here: the lines a column shows should
   be the ones a well-set paragraph would have, not the ones a paragraph that
   happened to end at the column foot would have.

   Returns { lines, next, done, method } where `next` is the break-candidate
   index to resume from and `lines[i]` is

     { words: [{ text, x, width }], x, width, naturalWidth, gap, spaceCount,
       justified, hyphenated, lastLine, gaps: [{ x, width }] }

   `gaps[].x` is the *centre* of the gap in the same coordinate space as
   `words[].x`, which is what `riverReport()` chains together. */
export function breakLines(para, maxWidth, options) {
  const opts = options || {};
  const from = Math.max(0, Math.min(opts.from || 0, para.candidates.length - 1));
  const maxLines = opts.maxLines == null ? Infinity : Math.max(0, opts.maxLines);
  const justify = !!opts.justify;
  const originX = Number(opts.x) || 0;

  if (maxLines === 0 || from >= para.candidates.length - 1) {
    return { lines: [], next: from, done: from >= para.candidates.length - 1, method: "none" };
  }

  let method = justify ? "optimal" : "greedy";
  let breaks = justify ? breakOptimal(para, from, maxWidth) : breakGreedy(para, from, maxWidth);
  if (breaks === null) { breaks = breakGreedy(para, from, maxWidth); method = "greedy-fallback"; }

  const lines = [];
  let at = from;
  for (let i = 0; i < breaks.length && lines.length < maxLines; i++) {
    const to = breaks[i];
    lines.push(buildLine(para, at, to, maxWidth, justify, originX));
    at = to;
  }
  return {
    lines: lines,
    next: at,
    done: at >= para.candidates.length - 1,
    method: method
  };
}

function buildLine(para, from, to, maxWidth, justify, originX) {
  const stats = statsBetween(para, from, to);
  const spacing = spacingFor(para, stats, maxWidth, justify);
  const justified = spacing.kind === "justified";
  const gap = justified ? spacing.width : para.spaceWidth;

  // Words: maximal runs of non-space segments. A soft hyphen contributes no
  // glyph unless its break was the one taken, in which case the line pays for
  // (and paints) a trailing "-" — exactly pretext's own rule.
  const words = [];
  const segStart = para.candidates[from].segIndex;
  const segEnd = para.candidates[to].segIndex;
  let text = "";
  let width = 0;
  for (let i = segStart; i < segEnd; i++) {
    const kind = para.kinds[i];
    if (kind === "soft-hyphen") continue;
    if (isSpaceKind(kind)) {
      if (text) { words.push({ text: text, width: width }); text = ""; width = 0; }
      continue;
    }
    text += para.segments[i];
    width += para.widths[i] || 0;
  }
  if (text) words.push({ text: text, width: width });
  if (stats.hyphenated && words.length) {
    const lastWord = words[words.length - 1];
    lastWord.text += "-";
    lastWord.width += para.hyphenWidth;
  }

  // Positions. The gap the DP costed is the one painted here, so the river
  // report below measures the layout that ships rather than a model of it.
  let x = originX;
  const gaps = [];
  for (let i = 0; i < words.length; i++) {
    words[i].x = x;
    x += words[i].width;
    if (i < words.length - 1) {
      gaps.push({ x: x + gap / 2, width: gap });
      x += gap;
    }
  }

  return {
    words: words,
    gaps: gaps,
    x: originX,
    width: x - originX,
    naturalWidth: stats.naturalWidth,
    maxWidth: maxWidth,
    gap: gap,
    spaceCount: words.length > 0 ? words.length - 1 : 0,
    justified: justified,
    hyphenated: stats.hyphenated,
    lastLine: stats.lastLine,
    overflow: spacing.kind === "overflow"
  };
}

/* ------------------------------------------------------------------ *
 * 5. Rivers                                                           *
 * ------------------------------------------------------------------ */

/* Chain the gaps of vertically adjacent lines into rivers.

   `lines` must be in painting order and carry a `row` (an integer line index
   inside one column); only lines whose rows differ by exactly one can share a
   river, so a column break or a skipped row ends every chain.

   Returns { maxRun, riverCount, worst, gapCount } where `maxRun` is the number
   of lines the longest channel spans and `worst` describes it. */
export function riverReport(lines, spaceWidth, options) {
  const opts = options || {};
  const alignRatio = opts.alignRatio == null ? RIVER_ALIGN_RATIO : opts.alignRatio;
  const minRun = opts.minRun == null ? 3 : opts.minRun;
  const normal = spaceWidth || 1;

  // Each gap starts a chain of length 1; a gap on the next row that lines up
  // extends the longest chain that reaches it.
  let previous = null; // { row, gaps: [{ x, width, run, startRow, startX }] }
  let maxRun = 1;
  let worst = null;
  let riverCount = 0;
  let gapCount = 0;
  const finishedRuns = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const gaps = line.gaps || [];
    gapCount += gaps.length;
    const nodes = [];
    const adjacent = previous !== null && line.row === previous.row + 1;
    for (let g = 0; g < gaps.length; g++) {
      const gap = gaps[g];
      let run = 1;
      let startRow = line.row;
      let startX = gap.x;
      if (adjacent) {
        for (let p = 0; p < previous.gaps.length; p++) {
          const other = previous.gaps[p];
          const tol = Math.max(RIVER_ALIGN_MIN_PX,
                               Math.max(gap.width, other.width) * alignRatio);
          if (Math.abs(gap.x - other.x) <= tol && other.run + 1 > run) {
            run = other.run + 1;
            startRow = other.startRow;
            startX = other.startX;
          }
        }
      }
      nodes.push({ x: gap.x, width: gap.width, run: run, startRow: startRow, startX: startX });
      if (run >= minRun) finishedRuns.push({ run: run, startRow: startRow, endRow: line.row, x: gap.x });
      if (run > maxRun) {
        maxRun = run;
        worst = {
          run: run, startRow: startRow, endRow: line.row,
          x: Math.round(gap.x * 10) / 10,
          gapRatio: Math.round((gap.width / normal) * 100) / 100
        };
      }
    }
    previous = { row: line.row, gaps: nodes };
  }

  // Only the maximal extent of each channel counts as one river.
  const seen = new Map();
  for (const run of finishedRuns) {
    const key = run.startRow + ":" + Math.round(run.x / 4);
    const prior = seen.get(key);
    if (prior == null || run.run > prior) seen.set(key, run.run);
  }
  riverCount = seen.size;

  return {
    maxRun: lines.length ? maxRun : 0,
    riverCount: riverCount,
    worst: worst,
    gapCount: gapCount,
    lineCount: lines.length
  };
}
