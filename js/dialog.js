/* Atlas of the Curious — the detail dialog, set as an editorial spread.

   Phase 3 moved the dialog out of js/app.js and gave the story a real page
   layout instead of a paragraph: a drop cap the first lines route around, the
   field note pulled out into a quote box the text flows past, and — on a wide
   screen — two justified columns that hand the text over from one to the next.

   How the layout is built, in the order it happens:

     1. `readGeometry()` reads the dialog's inner width. That is the ONLY
        layout read this file makes, and it happens once per open and once per
        resize — never per line.
     2. `planSpread()` decides the column geometry: how many columns, how wide
        the drop cap is, where the pull quote sits and how many rows it blocks.
        `walkLineRanges()` counts the story's natural lines at the column width
        (no strings built) so the two columns can be balanced before a single
        line is laid out.
     3. `flowSpread()` walks the columns row by row. Rows with the same free
        slot are grouped into a run, and each run is broken by js/justify.js —
        Knuth-Plass when the columns are justified, first-fit when they are
        ragged. The cursor (a break-candidate index) carries across runs and
        across the column boundary, so the right column resumes exactly where
        the left one stopped.
     4. When the columns are justified the whole of steps 2-3 is repeated at
        three column widths (the natural one and ±6%) and the width with the
        shortest river wins. `riverReport()` chains the *painted* gaps, so the
        number being minimised is the one a reader would see.
     5. `render()` turns the model into absolutely positioned spans. Nothing is
        measured again; the container's height comes from the layout.

   Accessibility: `#dialog-story` and the `.fact` block keep the original,
   un-hyphenated text and are visually hidden rather than removed, so a screen
   reader and find-in-page still see one ordinary paragraph. Every generated
   line, word, chip and the drop cap is `aria-hidden`.

   CSP: DOM APIs only — no innerHTML, no inline style attributes (every style
   goes through `el.style.setProperty`), no external requests. */
import { walkLineRanges } from "../vendor/pretext/layout.js";
import {
  prepareRichInline,
  walkRichInlineLineRanges,
  materializeRichInlineLineRange
} from "../vendor/pretext/rich-inline.js";
import { prepareParagraph, breakLines, riverReport } from "./justify.js";

/* ------------------------------------------------------------------ *
 * Tuning                                                              *
 * ------------------------------------------------------------------ */

const TWO_COL_MIN_VIEWPORT = 900;  // the viewport width the spread splits at
const COL_GAP = 34;                // gutter between the two columns
const DROP_CAP_LINES = 3;          // body lines the cap stands beside
const CAP_GAP = 12;                // breathing room to the right of the cap
const CAP_INK_RATIO = 0.74;        // Georgia cap height as a fraction of the em
const QUOTE_MAX_LINES = 6;         // the box is widened until the note fits in this
const PQ_MIN_FRAC = 0.5;           // …but never narrower than half the column
const PQ_STRIP_FRAC = 0.36;        // the text beside the box needs this much column
const PQ_GAP = 18;                 // gap between the box and the text beside it
const PQ_PAD = 14;                 // the box's own padding
const PQ_LABEL_H = 20;             // the "Field note" label inside the box
const MIN_SLOT = 132;              // a strip narrower than this holds no text
// The natural column is deliberately 6% narrower than the room available, so
// that the "+6%" justification trial has somewhere to grow into. The slack
// that the narrower trials leave over is split evenly as an outer margin.
const NATURAL_FRAC = 0.94;
const WIDTH_TRIALS = [0.94, 1, 1.06];
const MAX_ROWS = 400;              // a runaway-loop guard, never reached

const REVEAL_LINE_MS = 28;         // stagger between two lines arriving
const REVEAL_TOTAL_MS = 1200;      // …capped so a long story still finishes fast
const REVEAL_DUR_MS = 260;
const STEP_MS = 340;               // the prev/next height animation
const EASE = "cubic-bezier(0.22, 0.7, 0.3, 1)";

const SHY = "\u00AD";  // U+00AD SOFT HYPHEN
const CHIP_PAD_X = 6;              // .chip-inline horizontal padding …
const CHIP_BORDER = 1;             // … and border; together the `extraWidth`
const CHIP_EXTRA = (CHIP_PAD_X + CHIP_BORDER) * 2;

/* ------------------------------------------------------------------ *
 * Soft hyphens for the long names                                     *
 * ------------------------------------------------------------------ */

/* Pretext treats U+00AD as an optional break: unchosen ones stay invisible and
   a chosen one materialises a trailing "-". Automatic hyphenation is a bad
   idea across this many languages, so this is a hand-written dictionary of the
   names and words that actually wrap badly in a 200px column. It is applied at
   render time only — js/data.js never sees a soft hyphen, and the visually
   hidden accessible copies use the original text so find-in-page keeps
   matching. */
const HYPHEN_POINTS = {
  // The place names that overflow a narrow column.
  "Białowieża": [3, 5, 8],
  "Zhangjiajie": [5, 8],
  "Jökulsárlón": [2, 6, 8],
  "Sossusvlei": [3, 6],
  "Deadvlei": [4],
  "Vatnajökull": [5, 7],
  "Kilimanjaro": [4, 7],
  "Borobudur": [4, 6],
  "Pamukkale": [2, 5],
  "Antofagasta": [5, 8],
  "Dufourspitze": [6, 8],
  "Constantinople": [3, 6, 9, 11],
  "Suryavarman": [5, 8],
  "Gilgit": [6],
  "Sigiriya": [3, 6],
  "Aogashima": [3, 6],
  "Yucatán": [2, 5],
  // Long ordinary words the columns trip over.
  "prehistoric": [3, 7],
  "centimetres": [5, 8],
  "kilometres": [4, 7],
  "rainforest": [4, 6],
  "rainforests": [4, 6],
  "archipelago": [4, 6, 8],
  "escarpments": [2, 6, 8],
  "surrounding": [3, 6],
  "translucent": [4, 6],
  "continuously": [3, 6, 9],
  "engineering": [6, 8],
  "geopolitical": [3, 5, 8],
  "significance": [3, 6, 8],
  "inscriptions": [2, 6, 9],
  "destinations": [4, 7, 9],
  "expeditions": [2, 6, 8],
  "orientation": [3, 5, 8],
  "professional": [3, 6, 9],
  "traditional": [2, 5, 8],
  "distinctive": [2, 6, 8],
  "undisturbed": [2, 5, 8],
  "environment": [2, 6, 8],
  "butterflies": [6, 8],
  "silhouettes": [3, 5, 8],
  "precipitation": [3, 6, 8, 11],
  "Mediterranean": [4, 6, 9, 11]
};

// One alternation over every key, longest first so "rainforests" wins over
// "rainforest". Unicode lookarounds keep the match to whole words even when
// the neighbours carry diacritics (\b is ASCII-only).
const HYPHEN_RE = (function () {
  const keys = Object.keys(HYPHEN_POINTS).sort((a, b) => b.length - a.length);
  if (!keys.length) return null;
  const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  try {
    return new RegExp("(?<![\\p{L}\\p{M}])(" + escaped.join("|") + ")(?![\\p{L}\\p{M}])", "gu");
  } catch (e) {
    return new RegExp("\\b(" + escaped.join("|") + ")\\b", "g"); // no lookbehind
  }
})();

function hyphenateWord(word) {
  const points = HYPHEN_POINTS[word];
  if (!points) return word;
  let out = "";
  let at = 0;
  for (const cut of points) {
    if (cut <= at || cut >= word.length) continue;
    out += word.slice(at, cut) + SHY;
    at = cut;
  }
  return out + word.slice(at);
}

export function hyphenate(text) {
  const str = text == null ? "" : String(text);
  if (!HYPHEN_RE) return str;
  HYPHEN_RE.lastIndex = 0;
  return str.replace(HYPHEN_RE, (m) => hyphenateWord(m));
}

function stripSoftHyphens(text) { return String(text || "").split(SHY).join(""); }

/* ------------------------------------------------------------------ *
 * Metadata chips                                                      *
 * ------------------------------------------------------------------ */

const MONTH =
  "January|February|March|April|May|June|July|August|September|October|" +
  "November|December|Sept|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const DASH = "[\\u2013\\u2014-]";
// A month or a month range ("Dec–Mar", "April–June", "Sept–Oct"), or a
// distance / travel time introduced by ≈ ("≈ 260–400 km", "≈ 18 km",
// "≈ 1 hour"). Everything else stays plain text.
const CHIP_RE = new RegExp(
  "(?:\\u2248\\s*\\d[\\d,]*(?:\\s*" + DASH + "\\s*\\d[\\d,]*)?\\s*(?:km|hours?|minutes?))" +
  "|(?:\\b(?:" + MONTH + ")\\b(?:\\s*" + DASH + "\\s*(?:" + MONTH + ")\\b)?)",
  "g"
);

// Split one metadata string into rich-inline items: plain runs and chips.
export function chipItems(text, fonts) {
  const str = text == null ? "" : String(text);
  const items = [];
  const kinds = [];
  let at = 0;
  CHIP_RE.lastIndex = 0;
  let m;
  while ((m = CHIP_RE.exec(str)) !== null) {
    if (m.index > at) {
      items.push({ text: str.slice(at, m.index), font: fonts.text });
      kinds.push("text");
    }
    items.push({
      text: m[0], font: fonts.chip, break: "never", extraWidth: CHIP_EXTRA
    });
    kinds.push("chip");
    at = m.index + m[0].length;
    if (m[0].length === 0) CHIP_RE.lastIndex++; // never spin on an empty match
  }
  if (at < str.length) {
    items.push({ text: str.slice(at), font: fonts.text });
    kinds.push("text");
  }
  if (!items.length) { items.push({ text: "", font: fonts.text }); kinds.push("text"); }
  return { items: items, kinds: kinds };
}

/* ------------------------------------------------------------------ *
 * The module                                                          *
 * ------------------------------------------------------------------ */

function boot(win, doc) {
  const $ = (id) => doc.getElementById(id);
  const dialog = $("place-dialog");
  if (!dialog) return;

  const DATA = win.ATLAS_DATA || { categories: [], places: [] };
  const placesById = new Map(DATA.places.map((p) => [p.id, p]));
  const categoryById = new Map(DATA.categories.map((c) => [c.id, c]));
  const FLAGS = win.ATLAS_FLAGS || {};
  const flag = (name) => FLAGS[name] !== false;
  const T = win.ATLAS_TEXT || null;

  // Without the metrics module there is nothing to lay out by hand; app.js
  // keeps its plain fallback and this module never publishes itself.
  if (!T || !flag("editorial")) return;

  const motionQ = win.matchMedia ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const reduced = () => !!(motionQ && motionQ.matches);

  const body = dialog.querySelector(".dialog-body");
  const head = $("dialog-head");
  const foot = dialog.querySelector(".dialog-foot");
  const storyEl = $("dialog-story");
  const factBox = dialog.querySelector(".fact");
  const factEl = $("dialog-fact");
  if (!body || !storyEl || !factBox || !factEl) return;

  /* ---- DOM scaffolding, built once -------------------------------- */
  dialog.classList.add("is-editorial");
  storyEl.classList.add("visually-hidden");
  factBox.classList.add("visually-hidden");

  const spread = doc.createElement("div");
  spread.className = "story-spread";
  storyEl.parentNode.insertBefore(spread, storyEl.nextSibling);

  const capEl = doc.createElement("span");
  capEl.className = "drop-cap";
  capEl.setAttribute("aria-hidden", "true");

  const quoteEl = doc.createElement("div");
  quoteEl.className = "pull-quote";
  quoteEl.setAttribute("aria-hidden", "true");
  const quoteLabel = doc.createElement("span");
  quoteLabel.className = "pull-quote-label";
  quoteLabel.textContent = "Field note";
  quoteEl.appendChild(quoteLabel);

  const linesEl = doc.createElement("div");
  linesEl.className = "story-lines";
  linesEl.setAttribute("aria-hidden", "true");

  spread.appendChild(capEl);
  spread.appendChild(quoteEl);
  spread.appendChild(linesEl);

  // The two metadata values become rich inline flows in place.
  const fieldEls = [
    { key: "bestTime", el: $("dialog-besttime") },
    { key: "nearestCity", el: $("dialog-nearest") }
  ].filter((f) => !!f.el);
  for (const f of fieldEls) {
    f.plain = doc.createElement("span");
    f.plain.className = "visually-hidden";
    f.flow = doc.createElement("span");
    f.flow.className = "chip-flow";
    f.flow.setAttribute("aria-hidden", "true");
  }

  /* ---- Geometry (the one layout read) ------------------------------ */
  const geom = {
    innerWidth: 0, viewportWidth: 0, twoCol: false, maxBodyHeight: 0, read: false
  };

  function readGeometry() {
    const cs = win.getComputedStyle(body);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    geom.innerWidth = Math.max(120, Math.round((body.clientWidth || 0) - padX));
    geom.viewportWidth = doc.documentElement.clientWidth || win.innerWidth || 0;
    geom.twoCol = geom.viewportWidth >= TWO_COL_MIN_VIEWPORT;
    // The ceiling the body may animate to — the dialog's own max-height (a
    // calc() the browser has already resolved to px), not the height it
    // happens to have right now.
    const dialogMax = parseFloat(win.getComputedStyle(dialog).maxHeight);
    const chrome = (head ? head.offsetHeight : 0) + (foot ? foot.offsetHeight : 0);
    geom.maxBodyHeight = Math.max(
      80,
      Math.round((isFinite(dialogMax) ? dialogMax : (win.innerHeight || 800)) - chrome)
    );
    geom.read = true;
    dialog.classList.toggle("dlg-wide", geom.twoCol);
  }

  /* ---- Prepared handles, cached per place -------------------------- */
  const cache = new Map(); // placeId -> { bodyText, para, cap, quoteText, fields }

  function firstGrapheme(text) {
    const arr = Array.from(String(text || ""));
    return arr.length ? arr[0] : "";
  }

  function resourcesFor(place) {
    const key = place.id + "|" + (flag("hyphens") ? "h" : "p");
    let res = cache.get(key);
    if (res) return res;
    const cap = firstGrapheme(place.story);
    const rest = place.story.slice(cap.length);
    const bodyText = flag("hyphens") ? hyphenate(rest) : rest;
    const handle = T.handleForText("story", bodyText);
    res = {
      cap: cap,
      bodyText: bodyText,
      handle: handle,
      para: prepareParagraph(handle),
      quoteText: place.fact
    };
    cache.set(key, res);
    return res;
  }

  /* ---- Planning ---------------------------------------------------- */

  const storyFont = () => T.fontFor("story");
  const quoteFont = () => T.fontFor("quote");
  const fieldFont = () => T.fontFor("field");

  // Everything about one candidate column width, before any line is broken.
  function planSpread(res, colWidth, cols, forceFullBleed) {
    const lh = storyFont().lineHeight;
    const minSlot = Math.max(MIN_SLOT, Math.ceil(res.para.maxWordWidth) + 2);

    // --- the drop cap -------------------------------------------------
    let capLines = DROP_CAP_LINES;
    let capPx = 0;
    let capWidth = 0;
    if (res.cap) {
      for (; capLines >= 2; capLines--) {
        capPx = (capLines * lh) / CAP_INK_RATIO;
        capWidth = T.naturalWidthOfText("dropcap", res.cap, capPx);
        if (colWidth - capWidth - CAP_GAP >= minSlot) break;
      }
      if (colWidth - capWidth - CAP_GAP < minSlot) { capLines = 0; capWidth = 0; }
    } else {
      capLines = 0;
    }

    // --- the pull quote ----------------------------------------------
    // The box is widened until the field note fits in QUOTE_MAX_LINES — a tall
    // narrow note would out-weigh the whole story in a column this size. If
    // what is left beside it is too narrow to read, the box takes the column
    // and the text simply resumes underneath instead of flowing around.
    const qlh = quoteFont().lineHeight;
    const tight = T.tightWidthOfTextAt(
      "quote", res.quoteText, colWidth - PQ_PAD * 2, null, QUOTE_MAX_LINES
    );
    let quoteWidth = Math.min(
      colWidth,
      Math.max(Math.round(colWidth * PQ_MIN_FRAC), Math.ceil(tight) + PQ_PAD * 2)
    );
    const minStrip = Math.max(minSlot, colWidth * PQ_STRIP_FRAC);
    if (forceFullBleed || colWidth - quoteWidth - PQ_GAP < minStrip) {
      quoteWidth = colWidth; // full bleed
    }
    const quoteLines = T.linesOfText("quote", res.quoteText, quoteWidth - PQ_PAD * 2);
    const quoteHeight = PQ_PAD * 2 + PQ_LABEL_H + quoteLines.length * qlh;
    const quoteRows = Math.ceil(quoteHeight / lh);

    // --- balancing: how many natural lines is this story? --------------
    // walkLineRanges counts them without building a single line string.
    let naturalLines = 0;
    walkLineRanges(res.handle, colWidth, () => { naturalLines++; });
    const capExtra = capLines
      ? Math.ceil(capLines * ((capWidth + CAP_GAP) / colWidth)) : 0;
    const quoteExtra = quoteWidth >= colWidth
      ? quoteRows
      : Math.ceil(quoteRows * ((quoteWidth + PQ_GAP) / colWidth));
    const rowsPerCol = Math.max(
      capLines + 2,
      Math.ceil((naturalLines + capExtra + quoteExtra) / cols)
    );

    return {
      lh: lh, qlh: qlh, minSlot: minSlot,
      capLines: capLines, capPx: capPx, capWidth: capWidth,
      quoteWidth: quoteWidth, quoteLines: quoteLines,
      quoteHeight: quoteHeight, quoteRows: quoteRows,
      naturalLines: naturalLines, rowsPerCol: rowsPerCol
    };
  }

  // Where the pull quote sits: partway down the first column, never over the
  // drop cap and never hanging past the column foot.
  function quoteRowFor(plan, rowsPerCol) {
    const earliest = plan.capLines + 1;
    const latest = Math.max(earliest, rowsPerCol - plan.quoteRows);
    const wanted = Math.round(rowsPerCol * 0.42);
    return Math.min(latest, Math.max(earliest, wanted));
  }

  /* ---- The flow ---------------------------------------------------- */

  function slotFor(obstacles, colIndex, colX, colWidth, row, minSlot) {
    let left = colX;
    const right = colX + colWidth;
    for (let i = 0; i < obstacles.length; i++) {
      const ob = obstacles[i];
      if (ob.col !== colIndex) continue;
      if (row < ob.row0 || row >= ob.row0 + ob.rows) continue;
      const obRight = ob.x + ob.w;   // every obstacle is flush to the column's left
      if (obRight > left) left = obRight;
    }
    const width = right - left;
    if (width < minSlot) return null;
    return { x: left, width: width };
  }

  function flowSpread(res, plan, columns, obstacles, rowsPerCol, justify) {
    const lines = [];
    const colRows = [];     // the row the column's text stopped at
    const colLines = [];    // how many lines it actually placed
    const colCursor = [];   // the break candidate it handed on
    let cursor = 0;
    let done = false;

    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      const isLast = c === columns.length - 1;
      const cap = isLast ? MAX_ROWS : rowsPerCol;
      let row = 0;
      let placed = 0;
      let lastRow = -1;
      let guard = 0;
      while (row < cap && !done && guard++ < MAX_ROWS) {
        const slot = slotFor(obstacles, c, col.x, col.width, row, plan.minSlot);
        if (!slot) { row++; continue; }
        let runRows = 1;
        while (row + runRows < cap) {
          const next = slotFor(obstacles, c, col.x, col.width, row + runRows, plan.minSlot);
          if (!next || next.x !== slot.x || next.width !== slot.width) break;
          runRows++;
        }
        const res2 = breakLines(res.para, slot.width, {
          from: cursor, maxLines: runRows, justify: justify, x: slot.x
        });
        for (let i = 0; i < res2.lines.length; i++) {
          const line = res2.lines[i];
          line.col = c;
          line.row = row + i;
          line.y = (row + i) * plan.lh;
          lines.push(line);
          placed++;
          lastRow = row + i;
        }
        cursor = res2.next;
        row += res2.lines.length || runRows;
        if (res2.done) done = true;
      }
      colRows[c] = lastRow + 1;
      colLines[c] = placed;
      colCursor[c] = cursor;
    }
    return {
      lines: lines, colRows: colRows, colLines: colLines, colCursor: colCursor,
      done: done, cursor: cursor
    };
  }

  /* One full candidate: geometry, flow, rivers. Pure arithmetic.

     A narrow pull-quote box only earns its narrowness if text actually flows
     beside it; when the column balance ends up putting none there, the box is
     rebuilt at the full column width so the spread has no empty strip. */
  function buildCandidate(res, colWidth, cols, innerWidth, justify) {
    const first = buildCandidateOnce(res, colWidth, cols, innerWidth, justify, false);
    if (first.plan.quoteWidth >= colWidth) return first;
    const beside = first.lines.some(
      (l) => l.col === 0 && l.row >= first.quoteRow &&
             l.row < first.quoteRow + first.plan.quoteRows
    );
    if (beside) return first;
    return buildCandidateOnce(res, colWidth, cols, innerWidth, justify, true);
  }

  function buildCandidateOnce(res, colWidth, cols, innerWidth, justify, fullBleed) {
    const plan = planSpread(res, colWidth, cols, fullBleed);
    const spreadWidth = cols * colWidth + (cols - 1) * COL_GAP;
    const originX = Math.max(0, Math.round((innerWidth - spreadWidth) / 2));
    const columns = [];
    for (let c = 0; c < cols; c++) {
      columns.push({ x: originX + c * (colWidth + COL_GAP), width: colWidth });
    }

    // Balance the columns by how much *text* each takes, not how many rows:
    // the rows beside the drop cap and the pull quote are narrow and hold far
    // less than a full one, so a row count would leave the second column
    // nearly empty. `walkLineRanges()` supplies the first estimate; the search
    // below corrects it against the word width each column actually consumed.
    const totalWordWidth =
      res.para.candidates[res.para.candidates.length - 1].wordWidthBefore || 1;
    const share = 1 / cols;
    const minRows = plan.capLines + 1;
    let rowsPerCol = Math.max(minRows, plan.rowsPerCol);
    let quoteRow = quoteRowFor(plan, rowsPerCol);
    let flow = null;
    let best = null;
    const seen = new Set();

    const attempt = (rows) => {
      const obstacles = [];
      if (plan.capLines) {
        obstacles.push({
          col: 0, row0: 0, rows: plan.capLines,
          x: columns[0].x, w: plan.capWidth + CAP_GAP
        });
      }
      const qRow = quoteRowFor(plan, rows);
      obstacles.push({
        col: 0, row0: qRow, rows: plan.quoteRows,
        x: columns[0].x,
        w: plan.quoteWidth >= colWidth ? colWidth : plan.quoteWidth + PQ_GAP
      });
      const f = flowSpread(res, plan, columns, obstacles, rows, justify);
      const taken = (res.para.candidates[f.colCursor[0]] || {}).wordWidthBefore || 0;
      return { flow: f, quoteRow: qRow, rows: rows, score: Math.abs(taken / totalWordWidth - share) };
    };

    if (cols === 1) {
      const only = attempt(rowsPerCol);
      flow = only.flow;
      quoteRow = only.quoteRow;
    } else {
      // At most five probes, walking one row at a time towards the split that
      // gives the first column its fair share of the paragraph.
      for (let pass = 0; pass < 5; pass++) {
        if (seen.has(rowsPerCol)) break;
        seen.add(rowsPerCol);
        const tried = attempt(rowsPerCol);
        if (!best || tried.score < best.score) best = tried;
        const taken =
          (res.para.candidates[tried.flow.colCursor[0]] || {}).wordWidthBefore || 0;
        const next = taken / totalWordWidth > share ? rowsPerCol - 1 : rowsPerCol + 1;
        if (next < minRows) break;
        rowsPerCol = next;
      }
      flow = best.flow;
      quoteRow = best.quoteRow;
      rowsPerCol = best.rows;
    }

    // Column heights: the rows they consumed, and — for the first column —
    // never less than the bottom of the pull-quote box.
    const quoteTop = quoteRow * plan.lh;
    let height = 0;
    for (let c = 0; c < columns.length; c++) {
      let h = (flow.colRows[c] || 0) * plan.lh;
      if (c === 0) h = Math.max(h, quoteTop + plan.quoteHeight);
      columns[c].height = h;
      columns[c].rows = flow.colRows[c] || 0;
      if (h > height) height = h;
    }

    // Rivers, per column, over the painted gaps.
    const perColumn = [];
    let maxRun = 0;
    let riverCount = 0;
    let worst = null;
    for (let c = 0; c < columns.length; c++) {
      const colLines = flow.lines.filter((l) => l.col === c && l.justified);
      const report = riverReport(colLines, res.para.spaceWidth);
      perColumn.push(report);
      riverCount += report.riverCount;
      if (report.maxRun > maxRun) {
        maxRun = report.maxRun;
        worst = report.worst ? Object.assign({ col: c }, report.worst) : null;
      }
    }

    return {
      plan: plan, columns: columns, lines: flow.lines, height: Math.ceil(height),
      quoteRow: quoteRow, quoteTop: quoteTop, originX: originX,
      colWidth: colWidth, cols: cols, justified: justify, done: flow.done,
      rivers: { maxRun: maxRun, riverCount: riverCount, worst: worst, byColumn: perColumn },
      overflow: flow.lines.some((l) => l.overflow)
    };
  }

  /* ---- The metadata flows ------------------------------------------ */

  function fieldWidths(innerWidth, twoCol) {
    const cols = twoCol ? 2 : 1;
    const gap = 10;
    const outer = (innerWidth - gap * (cols - 1)) / cols;
    return { cols: cols, inner: Math.max(80, Math.floor(outer - 12 * 2 - 2)) };
  }

  function buildFieldFlow(text, width) {
    const fonts = { text: fieldFont().font, chip: T.fontFor("field-chip").font };
    const spec = chipItems(text, fonts);
    const prepared = prepareRichInline(spec.items);
    const lines = [];
    walkRichInlineLineRanges(prepared, width, (range) => {
      const line = materializeRichInlineLineRange(prepared, range);
      let x = 0;
      const frags = [];
      for (const f of line.fragments) {
        x += f.gapBefore;
        if (f.text.length || spec.kinds[f.itemIndex] === "chip") {
          frags.push({
            text: f.text, x: x, width: f.occupiedWidth,
            chip: spec.kinds[f.itemIndex] === "chip"
          });
        }
        x += f.occupiedWidth;
      }
      // The fragments are painted with `white-space: pre` so the collapsed
      // boundary gaps stay exact; a space hanging off the end of the line is
      // not part of its measured width, so it must not be painted either.
      const last = frags[frags.length - 1];
      if (last && !last.chip) last.text = last.text.replace(/\s+$/, "");
      lines.push({ fragments: frags, width: x });
    });
    return { lines: lines, width: width, lineHeight: fieldFont().lineHeight };
  }

  /* ---- The whole dialog body --------------------------------------- */

  function computeLayout(place) {
    const res = resourcesFor(place);
    const innerWidth = geom.innerWidth;
    const cols = geom.twoCol ? 2 : 1;
    const available = (innerWidth - COL_GAP * (cols - 1)) / cols;
    const natural = Math.max(120, Math.floor(available * NATURAL_FRAC));
    const justify = geom.twoCol && flag("justify");

    let best = null;
    const trials = [];
    const widths = justify ? WIDTH_TRIALS : [1];
    for (const scale of widths) {
      const w = Math.min(Math.floor(available), Math.round(natural * scale));
      if (trials.some((t) => t.width === w)) continue;
      const candidate = buildCandidate(res, w, cols, innerWidth, justify);
      trials.push({
        width: w, maxRun: candidate.rivers.maxRun,
        riverCount: candidate.rivers.riverCount,
        height: candidate.height, overflow: candidate.overflow
      });
      if (!best || betterThan(candidate, best)) best = candidate;
    }

    const taglineH = T.heightOfText("quote", place.tagline, innerWidth);
    const fw = fieldWidths(innerWidth, geom.twoCol);
    const fields = fieldEls.map((f) => ({
      key: f.key,
      flow: flag("chips") ? buildFieldFlow(place[f.key] || "", fw.inner) : null,
      text: place[f.key] || ""
    }));
    let fieldsH = 0;
    for (const f of fields) {
      const h = f.flow ? f.flow.lines.length * f.flow.lineHeight : 0;
      fieldsH = fw.cols > 1 ? Math.max(fieldsH, h) : fieldsH + h;
    }

    return {
      id: place.id, place: place, res: res, spread: best, trials: trials,
      taglineHeight: taglineH, fields: fields, fieldWidth: fw,
      fieldsHeight: fieldsH,
      // What the dialog body's height depends on. Constant chrome cancels out
      // of the difference, so the step animation needs no calibration pass.
      variable: taglineH + best.height + fieldsH
    };
  }

  // An over-set line disqualifies a candidate outright; after that the
  // shortest longest-river wins, then the fewest rivers, then the widest
  // column (the most comfortable measure of the three).
  function betterThan(a, b) {
    if (a.overflow !== b.overflow) return !a.overflow;
    if (a.rivers.maxRun !== b.rivers.maxRun) return a.rivers.maxRun < b.rivers.maxRun;
    if (a.rivers.riverCount !== b.rivers.riverCount) {
      return a.rivers.riverCount < b.rivers.riverCount;
    }
    return a.colWidth > b.colWidth;
  }

  /* ---- Rendering --------------------------------------------------- */

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function px(n) { return Math.round(n * 100) / 100 + "px"; }

  // The reveal runs on the Web Animations API, so cancelling it means
  // cancelling the animations still attached to the lines on screen. Lines
  // that are replaced take their animations with them when they are removed.
  function cancelReveal() {
    if (typeof linesEl.getAnimations !== "function") return;
    for (const anim of linesEl.getAnimations({ subtree: true })) anim.cancel();
  }

  function renderSpread(layout) {
    const s = layout.spread;
    const plan = s.plan;
    spread.style.setProperty("height", px(s.height));

    // Drop cap.
    if (plan.capLines) {
      capEl.textContent = layout.res.cap;
      capEl.style.setProperty("--dropcap-size", px(plan.capPx));
      capEl.style.setProperty("--dropcap-line", px(plan.capLines * plan.lh));
      capEl.style.setProperty("left", px(s.columns[0].x));
      capEl.style.setProperty("width", px(plan.capWidth));
      capEl.hidden = false;
    } else {
      capEl.hidden = true;
    }

    // Pull quote.
    clear(quoteEl);
    quoteEl.appendChild(quoteLabel);
    quoteEl.style.setProperty("left", px(s.columns[0].x));
    quoteEl.style.setProperty("top", px(s.quoteTop));
    quoteEl.style.setProperty("width", px(plan.quoteWidth));
    quoteEl.style.setProperty("height", px(plan.quoteHeight));
    for (let i = 0; i < plan.quoteLines.length; i++) {
      const line = doc.createElement("span");
      line.className = "pull-quote-line";
      line.setAttribute("aria-hidden", "true");
      line.textContent = plan.quoteLines[i];
      line.style.setProperty("top", px(PQ_PAD + PQ_LABEL_H + i * plan.qlh));
      line.style.setProperty("left", px(PQ_PAD));
      line.style.setProperty("line-height", px(plan.qlh));
      quoteEl.appendChild(line);
    }

    // Body lines: one positioned span per line, one per word inside it.
    clear(linesEl);
    const nodes = [];
    for (const line of s.lines) {
      const el = doc.createElement("span");
      el.className = "story-line";
      el.setAttribute("aria-hidden", "true");
      el.style.setProperty("left", px(line.x));
      el.style.setProperty("top", px(line.y));
      el.style.setProperty("width", px(Math.max(line.width, 1)));
      el.style.setProperty("height", px(plan.lh));
      el.style.setProperty("line-height", px(plan.lh));
      for (const word of line.words) {
        const w = doc.createElement("span");
        w.className = "story-word";
        w.textContent = word.text;
        w.style.setProperty("left", px(word.x - line.x));
        el.appendChild(w);
      }
      linesEl.appendChild(el);
      nodes.push(el);
    }
    return nodes;
  }

  function renderFields(layout) {
    for (let i = 0; i < fieldEls.length; i++) {
      const f = fieldEls[i];
      const data = layout.fields[i];
      clear(f.el);
      if (!data || !data.flow) {
        f.el.classList.remove("is-flowed");
        f.el.style.removeProperty("height");
        f.el.textContent = data ? data.text : "";
        continue;
      }
      f.el.classList.add("is-flowed");
      f.plain.textContent = data.text;
      f.el.appendChild(f.plain);
      clear(f.flow);
      const lh = data.flow.lineHeight;
      for (let li = 0; li < data.flow.lines.length; li++) {
        const line = data.flow.lines[li];
        for (const frag of line.fragments) {
          const span = doc.createElement("span");
          span.className = frag.chip ? "chip-inline" : "chip-text";
          span.textContent = frag.text;
          span.style.setProperty("left", px(frag.x));
          span.style.setProperty("top", px(li * lh));
          span.style.setProperty("line-height", px(lh));
          f.flow.appendChild(span);
        }
      }
      f.el.appendChild(f.flow);
      f.el.style.setProperty("height", px(data.flow.lines.length * lh));
    }
  }

  /* ---- Opening, stepping, closing ---------------------------------- */

  let current = null;      // the layout currently rendered
  let currentId = null;
  let index = 0;
  let visibleProvider = () => DATA.places;
  let stepAnimation = null;
  let swapTimer = null;
  let lastReveal = { lines: 0, stepMs: 0, totalMs: 0, played: false };
  let lastStep = { from: 0, to: 0 };   // what the last step animation did

  /* ---- The name in its own script ---------------------------------
     Shown only when it is genuinely a second name; printing "Pamukkale"
     twice would be noise. The direction is asked of pretext's per-segment
     bidi levels on the very handle js/text.js prepared under the place's own
     locale, so an Arabic name gets dir="rtl" because its first strong segment
     resolved to an odd embedding level — not because "ar" is on a list. */
  const nativeEl = $("dialog-native");

  function nativeInfoFor(place) {
    if (!nativeEl || !flag("nativeNames")) return null;
    const text = String(place.nativeName || "");
    if (!text || text === place.name) return null;
    let dir = "ltr";
    try { dir = T.directionOf("native-name", place.id, place.nativeLang); }
    catch (e) { dir = T.directionOfText("native-name", text, place.nativeLang); }
    const wb = T.localeFor("native-name", place.id);
    return {
      text: text, lang: place.nativeLang || "", dir: dir,
      wordBreak: (wb && wb.wordBreak) || "normal",
      locale: (wb && wb.locale) || ""
    };
  }

  function fillNative(place) {
    if (!nativeEl) return;
    const info = nativeInfoFor(place);
    if (!info) {
      nativeEl.hidden = true;
      nativeEl.textContent = "";
      nativeEl.removeAttribute("lang");
      nativeEl.removeAttribute("dir");
      nativeEl.removeAttribute("data-wb");
      return;
    }
    nativeEl.hidden = false;
    nativeEl.textContent = info.text;
    if (info.lang) nativeEl.setAttribute("lang", info.lang);
    else nativeEl.removeAttribute("lang");
    nativeEl.setAttribute("dir", info.dir);
    if (info.wordBreak === "keep-all") nativeEl.setAttribute("data-wb", "keep-all");
    else nativeEl.removeAttribute("data-wb");
  }

  function fillChrome(place) {
    const cat = categoryById.get(place.category);
    $("dialog-symbol").textContent = place.symbol;
    $("dialog-symbol").style.setProperty("color", cat ? cat.accent : "#e8b45a");
    const badge = $("dialog-category");
    badge.textContent = cat ? cat.label : "";
    badge.style.setProperty("--card-accent", cat ? cat.accent : "#e8b45a");
    // The title carries soft hyphens so a long name can break where a
    // typesetter would; they are zero-width and stripped from the search /
    // accessible copies below.
    $("dialog-title").textContent = flag("hyphens") ? hyphenate(place.name) : place.name;
    fillNative(place);
    $("dialog-loc").textContent = place.country + " — " + place.region;
    $("dialog-tagline").textContent = place.tagline;
    storyEl.textContent = place.story;   // the accessible, un-hyphenated copy
    factEl.textContent = place.fact;
    $("dialog-coords").textContent = "≈ " + place.coordinates;
  }

  function paint(layout) {
    fillChrome(layout.place);
    const nodes = renderSpread(layout);
    renderFields(layout);
    current = layout;
    currentId = layout.id;
    playReveal(nodes);
  }

  function playReveal(nodes) {
    cancelReveal();
    const on = flag("reveal") && !reduced() && nodes.length > 0 &&
      typeof nodes[0].animate === "function";
    lastReveal = {
      lines: nodes.length,
      stepMs: 0,
      totalMs: 0,
      played: on
    };
    if (!on) {
      for (const el of nodes) el.classList.remove("is-arriving");
      return;
    }
    const step = Math.min(REVEAL_LINE_MS, REVEAL_TOTAL_MS / Math.max(1, nodes.length));
    lastReveal.stepMs = Math.round(step * 100) / 100;
    lastReveal.totalMs = Math.round((step * (nodes.length - 1) + REVEAL_DUR_MS) * 10) / 10;
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].animate(
        [
          { opacity: 0, transform: "translateY(5px)" },
          { opacity: 1, transform: "none" }
        ],
        { duration: REVEAL_DUR_MS, delay: i * step, easing: EASE, fill: "backwards" }
      );
    }
  }

  function open(id) {
    const place = placesById.get(id);
    if (!place) return;
    // The head's text goes in before the dialog is shown, so the one geometry
    // read below sees the header at its real height.
    fillChrome(place);
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!geom.read) readGeometry();
    stopStepAnimation();
    paint(computeLayout(place));
    highlight(place.id);
    syncIndex(place);
  }

  function syncIndex(place) {
    const list = visibleProvider() || [];
    const at = list.indexOf(place);
    index = at < 0 ? Math.max(0, list.findIndex((p) => p.id === place.id)) : at;
    if (index < 0) index = 0;
  }

  function highlight(id) {
    if (typeof win.CustomEvent === "function") {
      win.dispatchEvent(new win.CustomEvent("atlas:highlight", { detail: id }));
    }
  }

  function close() {
    stopStepAnimation();
    cancelReveal();
    currentId = null;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function stopStepAnimation() {
    if (swapTimer) { win.clearTimeout(swapTimer); swapTimer = null; }
    if (stepAnimation) { try { stepAnimation.cancel(); } catch (e) { /* done */ } }
    stepAnimation = null;
    body.style.removeProperty("height");
    body.style.removeProperty("overflow-y");
  }

  const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

  function step(dir) {
    const list = visibleProvider() || [];
    if (!list.length) return;
    index = (index + dir + list.length) % list.length;
    const place = list[index];
    if (!place) return;
    if (!geom.read) readGeometry();

    const animate = flag("dialogAnimate") && !reduced() && dialog.open &&
      typeof body.animate === "function" && current;
    const layout = computeLayout(place);
    if (!animate) {
      stopStepAnimation();
      paint(layout);
      highlight(place.id);
      return;
    }

    // One layout read: where the body stands right now. The target height is
    // that plus the difference between the two layouts' variable parts, so no
    // chrome has to be measured.
    const from = body.getBoundingClientRect().height;
    const to = clamp(from + (layout.variable - current.variable), 60, geom.maxBodyHeight);
    stopStepAnimation();
    body.style.setProperty("overflow-y", "hidden");
    body.style.setProperty("height", px(to));
    stepAnimation = body.animate(
      [{ height: px(from) }, { height: px(to) }],
      { duration: STEP_MS, easing: EASE }
    );
    lastStep = { from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 };
    swapTimer = win.setTimeout(() => {
      swapTimer = null;
      paint(layout);
      highlight(place.id);
    }, STEP_MS / 2);
    const finish = () => {
      if (swapTimer) { win.clearTimeout(swapTimer); swapTimer = null; paint(layout); highlight(place.id); }
      stepAnimation = null;
      body.style.removeProperty("height");
      body.style.removeProperty("overflow-y");
    };
    if (stepAnimation.finished && stepAnimation.finished.then) {
      stepAnimation.finished.then(finish, () => {});
    } else {
      stepAnimation.onfinish = finish;
    }
  }

  /* ---- Resize ------------------------------------------------------ */
  let resizeTimer = null;
  win.addEventListener("resize", () => {
    win.clearTimeout(resizeTimer);
    resizeTimer = win.setTimeout(() => {
      if (!dialog.open || !currentId) { geom.read = false; return; }
      readGeometry();
      const place = placesById.get(currentId);
      if (place) paint(computeLayout(place));
    }, 140);
  });

  /* ---- The published surface --------------------------------------- */
  win.ATLAS_DIALOG = {
    open: open,
    close: close,
    step: step,
    currentId: () => currentId,
    isOpen: () => !!dialog.open,
    setVisibleProvider: (fn) => { if (typeof fn === "function") visibleProvider = fn; },
    relayout: () => {
      if (!dialog.open || !currentId) return;
      readGeometry();
      const place = placesById.get(currentId);
      if (place) paint(computeLayout(place));
    },
    // Development / smoke-test surface: the layout's own bookkeeping. Nothing
    // here touches the DOM, so calling it forces no layout.
    debug: function () {
      if (!current) {
        return { open: !!dialog.open, id: currentId, ready: false };
      }
      const s = current.spread;
      return {
        ready: true,
        open: !!dialog.open,
        id: current.id,
        innerWidth: geom.innerWidth,
        viewportWidth: geom.viewportWidth,
        twoCol: geom.twoCol,
        justified: s.justified,
        colWidth: s.colWidth,
        trials: current.trials,
        lineHeight: s.plan.lh,
        spreadHeight: s.height,
        columns: s.columns.map((c) => ({
          x: c.x, width: c.width, height: c.height, rows: c.rows
        })),
        lines: s.lines.map((l) => ({
          col: l.col, row: l.row, x: l.x, y: l.y, width: l.width,
          justified: l.justified, hyphenated: l.hyphenated,
          overflow: l.overflow, words: l.words.length
        })),
        dropCap: {
          lines: s.plan.capLines, width: s.plan.capWidth, fontPx: s.plan.capPx
        },
        pullQuote: {
          x: s.columns[0].x, top: s.quoteTop, width: s.plan.quoteWidth,
          height: s.plan.quoteHeight, rows: s.plan.quoteRows,
          lines: s.plan.quoteLines.length, fullBleed: s.plan.quoteWidth >= s.colWidth
        },
        rivers: s.rivers,
        fields: current.fields.map((f, i) => ({
          key: f.key,
          chips: f.flow
            ? f.flow.lines.reduce(
                (n, l) => n + l.fragments.filter((x) => x.chip).length, 0)
            : 0,
          lines: f.flow ? f.flow.lines.length : 0,
          width: current.fieldWidth.inner,
          maxLineWidth: f.flow
            ? f.flow.lines.reduce((m, l) => Math.max(m, l.width), 0) : 0
        })),
        heights: {
          variable: current.variable,
          tagline: current.taglineHeight,
          fields: current.fieldsHeight,
          maxBody: geom.maxBodyHeight,
          lastStep: lastStep
        },
        reveal: lastReveal,
        animating: !!stepAnimation,
        flags: {
          editorial: flag("editorial"), justify: flag("justify"),
          reveal: flag("reveal"), hyphens: flag("hyphens"),
          chips: flag("chips"), dialogAnimate: flag("dialogAnimate"),
          nativeNames: flag("nativeNames")
        },
        // The second name, and what the DOM ended up carrying for it.
        native: (function () {
          const info = nativeInfoFor(current.place);
          return {
            shown: !!info && !nativeEl.hidden,
            planned: info,
            rendered: nativeEl ? {
              text: nativeEl.textContent,
              lang: nativeEl.getAttribute("lang"),
              dir: nativeEl.getAttribute("dir"),
              wordBreak: nativeEl.getAttribute("data-wb")
            } : null
          };
        })(),
        // Handy for the accessibility assertions.
        accessible: {
          story: storyEl.textContent,
          fact: factEl.textContent,
          title: $("dialog-title").textContent,
          titlePlain: stripSoftHyphens($("dialog-title").textContent)
        }
      };
    }
  };

  win.ATLAS_DIALOG_READY = true;
  if (typeof win.CustomEvent === "function") {
    win.dispatchEvent(new win.CustomEvent("atlas:dialog-ready", {
      detail: { dialog: win.ATLAS_DIALOG }
    }));
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  boot(window, document);
}
