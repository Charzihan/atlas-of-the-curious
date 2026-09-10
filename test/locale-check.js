/* Does pretext break a non-Latin paragraph where the browser breaks it?

   scripts/check-text.mjs serves this page, opens it in headless Chromium and
   reads `window.__ATLAS_LOCALE_CHECK`. Phase 4 gave every place a name in its
   own language and script, and prepared those strings under their own locale
   (pretext segments through `Intl.Segmenter`, which is locale-sensitive — Thai
   in particular has no spaces at all and is broken by dictionary). This page
   is the evidence that the locale-aware preparation actually agrees with what
   Chromium lays out.

   For each sample, at each width:

     1. pretext lays the string out through window.ATLAS_TEXT — the same
        font-role registry the site uses — after js/text.js's grouped
        `prepareLocalized()` / `flushLocalized()` pass has prepared it under
        that sample's locale.
     2. The same string is written into a real element with the same font,
        line-height, letter-spacing, width and `word-break`, and the lines the
        browser actually painted are read back a grapheme at a time with
        Range.getClientRects() (grouped by the top of each rect).
     3. The two line lists must match, string for string.
     4. For the scripts whose words are not delimited by spaces (Thai) or
        whose breaks should still respect words (Arabic), every break offset
        must also be an `Intl.Segmenter` word boundary in that locale.

   One deliberate omission: the probe carries no `lang` attribute. Canvas
   measureText() has no language either, and Chromium's per-glyph font
   fallback can pick a different face for `lang="zh-Hans"` than for no lang at
   all — comparing a lang-tagged element against an untagged canvas would be
   comparing two different fonts. The `langDrift` section below re-renders each
   sample WITH its `lang` and reports (without failing) whether that changed a
   single line, so the risk is measured rather than assumed. */

const ROLE = "story";

// Four samples, one per writing system the check is about. Every string is a
// plausible atlas tagline: a real sentence, not a run of filler.
const SAMPLES = [
  {
    id: "ja",
    label: "Japanese",
    locale: "ja",
    wordBreak: "normal",
    text: "夜の渋谷スクランブル交差点では、青信号のたびに三千人が一斉に歩き出します。",
    words: false           // CJK: grapheme boundaries are the contract
  },
  {
    id: "th",
    label: "Thai (no spaces)",
    locale: "th",
    wordBreak: "normal",
    text: "ทะเลทรายอาตากามาเป็นที่แห้งแล้งที่สุดในโลกและบางแห่งไม่เคยมีฝนตกเลย",
    words: true
  },
  {
    id: "ar",
    label: "Arabic",
    locale: "ar",
    wordBreak: "normal",
    text: "وادي رم صحراء من الرمال الحمراء والصخور الرملية تدربت فيها وكالات الفضاء",
    words: true
  },
  {
    id: "zh-Hans",
    label: "Chinese (Simplified)",
    locale: "zh-Hans",
    wordBreak: "normal",
    text: "张家界的石英砂岩峰林在云雾中若隐若现，像悬浮在半空中的岛屿。",
    words: false
  },
  /* The same two CJK samples under the option the native NAMES really use.
     These are informational, not assertions, and deliberately so: with
     `word-break: keep-all` the whole CJK run becomes one unbreakable word, so
     every break here is the `overflow-wrap: break-word` fallback — which
     pretext documents as approximate for overlong runs, and which Chromium
     resolves differently (it will hang an ideographic comma on a line of its
     own). No native name in the dataset is long enough to reach that path;
     scripts/smoke.mjs asserts exactly that, so the approximation is never
     what the reader sees. The rows are kept because the day a longer name
     arrives, this is where it shows up. */
  {
    id: "ja-keep-all",
    label: "Japanese (word-break: keep-all)",
    locale: "ja",
    wordBreak: "keep-all",
    text: "夜の渋谷スクランブル交差点では、青信号のたびに三千人が一斉に歩き出します。",
    words: false,
    informational: true
  },
  {
    id: "zh-keep-all",
    label: "Chinese (word-break: keep-all)",
    locale: "zh-Hans",
    wordBreak: "keep-all",
    text: "张家界的石英砂岩峰林在云雾中若隐若现，像悬浮在半空中的岛屿。",
    words: false,
    informational: true
  }
];

const WIDTHS = [160, 240, 320];

/* ---- The browser's own lines -------------------------------------- */

// Group the rendered graphemes by the top of their client rect. A grapheme
// the browser collapsed away (the space at a soft wrap) has no rect at all,
// and is carried onto the line before it — where trimming then drops it,
// exactly as the painted line does.
function renderedLines(el) {
  const node = el.firstChild;
  if (!node) return [];
  const text = node.nodeValue;
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const range = document.createRange();
  const lines = [];
  let top = null;
  let current = "";
  for (const g of graphemes.segment(text)) {
    const start = g.index;
    range.setStart(node, start);
    range.setEnd(node, start + g.segment.length);
    const rects = range.getClientRects();
    if (!rects.length) { current += g.segment; continue; }
    const y = Math.round(rects[0].top * 4) / 4;
    if (top === null) { top = y; current = g.segment; continue; }
    if (Math.abs(y - top) > 1) { lines.push(current); current = g.segment; top = y; }
    else current += g.segment;
  }
  if (current) lines.push(current);
  return lines.map(trim).filter((l) => l.length);
}

function trim(s) { return s.replace(/^\s+|\s+$/g, ""); }

/* ---- Word boundaries ----------------------------------------------- */

function boundariesOf(text, locale) {
  const words = new Intl.Segmenter(locale, { granularity: "word" });
  const set = new Set([0, text.length]);
  for (const s of words.segment(text)) set.add(s.index + s.segment.length);
  return set;
}

// Where each line ended, as an offset into the original string. The lines are
// trimmed, so a break taken at a space lands one character short of the space
// — both offsets are accepted when the character between them is whitespace.
function breakOffsets(text, lines) {
  const offsets = [];
  let at = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const found = text.indexOf(lines[i], at);
    if (found === -1) return null;    // the lines are not slices of the text
    at = found + lines[i].length;
    offsets.push(at);
  }
  return offsets;
}

function insideAWord(text, offsets, boundaries) {
  const bad = [];
  for (const at of offsets) {
    if (boundaries.has(at)) continue;
    if (/\s/.test(text.charAt(at)) && boundaries.has(at + 1)) continue;
    bad.push({
      at: at,
      around: text.slice(Math.max(0, at - 6), at) + "|" + text.slice(at, at + 6)
    });
  }
  return bad;
}

/* ---- The run ------------------------------------------------------- */

function run() {
  const T = window.ATLAS_TEXT;
  if (!T) throw new Error("window.ATLAS_TEXT is missing (js/text.js did not boot)");
  if (typeof T.prepareLocalized !== "function") {
    throw new Error("window.ATLAS_TEXT has no prepareLocalized() (Phase 4 helper missing)");
  }

  // One grouped preparation pass for every sample: setLocale() once per
  // locale, then once back to the default — never one call per string.
  for (const s of SAMPLES) {
    T.prepareLocalized(ROLE, "locale-check/" + s.id, s.text,
      { locale: s.locale, wordBreak: s.wordBreak });
  }
  const prep = T.flushLocalized();

  const role = T.fontFor(ROLE);
  const host = document.getElementById("probe-host");
  const probe = document.createElement("div");
  probe.style.setProperty("font", role.font);
  probe.style.setProperty("line-height", role.lineHeight + "px");
  probe.style.setProperty("letter-spacing", role.letterSpacing + "px");
  probe.style.setProperty("white-space", "normal");
  probe.style.setProperty("overflow-wrap", "break-word");
  host.appendChild(probe);

  const results = [];
  const failures = [];
  const notes = [];
  const langDrift = [];

  for (const s of SAMPLES) {
    const boundaries = boundariesOf(s.text, s.locale);
    for (const width of WIDTHS) {
      const predicted = T.linesOf(ROLE, "locale-check/" + s.id, width).map(trim)
        .filter((l) => l.length);
      probe.style.setProperty("width", width + "px");
      probe.style.setProperty("word-break", s.wordBreak);
      probe.removeAttribute("lang");
      probe.textContent = s.text;
      const actual = renderedLines(probe);

      const same = predicted.length === actual.length &&
        predicted.every((l, i) => l === actual[i]);

      // The same element again, this time tagged with its language — the way
      // the site itself marks a native name up. Reported, never asserted.
      probe.setAttribute("lang", s.locale);
      probe.textContent = s.text;
      const tagged = renderedLines(probe);
      const taggedSame = tagged.length === actual.length &&
        tagged.every((l, i) => l === actual[i]);
      if (!taggedSame) {
        langDrift.push({
          sample: s.id, width: width,
          untagged: actual.length, tagged: tagged.length
        });
      }

      const sink = s.informational ? notes : failures;

      let wordBreaks = null;
      if (s.words) {
        const offsets = breakOffsets(s.text, predicted);
        if (offsets === null) {
          sink.push({
            sample: s.id, width: width, rule: "lines are not slices of the source",
            predicted: predicted, actual: actual
          });
          wordBreaks = { checked: 0, inside: [{ at: -1, around: "(unmappable)" }] };
        } else {
          const inside = insideAWord(s.text, offsets, boundaries);
          wordBreaks = { checked: offsets.length, inside: inside };
          if (inside.length) {
            sink.push({
              sample: s.id, width: width,
              rule: "a break falls inside an Intl.Segmenter word",
              detail: inside
            });
          }
        }
      }

      results.push({
        sample: s.id, label: s.label, locale: s.locale, wordBreak: s.wordBreak,
        width: width, informational: !!s.informational,
        predictedLines: predicted.length, renderedLines: actual.length,
        match: same, taggedSame: taggedSame,
        wordBreaks: wordBreaks,
        predicted: predicted, actual: actual
      });

      if (!same) {
        sink.push({
          sample: s.id, width: width, rule: "pretext and the browser disagree",
          predicted: predicted, actual: actual
        });
      }
    }
  }

  probe.remove();

  return {
    ok: failures.length === 0,
    role: ROLE,
    font: role,
    prep: prep,
    widths: WIDTHS,
    samples: SAMPLES.map((s) => ({
      id: s.id, label: s.label, locale: s.locale, wordBreak: s.wordBreak,
      length: s.text.length, informational: !!s.informational
    })),
    results: results,
    langDrift: langDrift,
    notes: notes,
    failures: failures
  };
}

const statusEl = document.getElementById("status");
const reportEl = document.getElementById("report");
try {
  const result = run();
  window.__ATLAS_LOCALE_CHECK = result;
  statusEl.textContent = result.ok
    ? "OK — pretext and the browser agree"
    : result.failures.length + " locale failure(s)";
  reportEl.textContent = JSON.stringify(result, null, 2);
} catch (err) {
  window.__ATLAS_LOCALE_CHECK = {
    ok: false, error: String((err && err.stack) || err), failures: [], results: []
  };
  statusEl.textContent = "ERROR";
  reportEl.textContent = String((err && err.stack) || err);
}
