/* Atlas of the Curious — smoke test.

   Opens the real index.html in headless Chromium at a desktop and a phone
   viewport, waits for the text-metrics module and the Text Atlas to come up,
   and fails on any console error or uncaught page error. Meant to be re-run
   after every roadmap phase.

   Phase 1 ("labels on the map") adds three claims about the labels on the map,
   each driven through window.ATLAS_MAP_DEBUG rather than synthetic pointer
   events:

     1. At 1.5× and 2.5× no label cell overlaps land, another place label or an
        ocean name — checked twice over, once from the placement records
        (checkLabels) and once from the painted DOM boxes mapped back onto the
        grid (checkPainted), and at least MIN_LABELS names are actually placed.
     2. No tagline in the hover card ends on a one-word last line, for all 40.
     3. A scripted zoom from 1× to 2.5× over 60 frames stays smooth. See
        PERF_NOTE below for what "smooth" can mean in headless Chromium.

   Phase 2 ("the predictive grid") adds four measurements on top of that:

     1. No forced synchronous layout during a filter change or a card
        expansion. Two independent probes:
        (a) every layout-forcing getter (offsetHeight/offsetWidth/offsetTop,
            client*, scroll*, getBoundingClientRect, getComputedStyle) is
            wrapped in the page and attributed to its caller via the stack, so
            a read that originates in js/app.js during the click is counted.
            The assertion is zero.
        (b) CDP `Performance.getMetrics` LayoutCount / RecalcStyleCount are
            sampled either side of a click that is dispatched *synchronously*
            inside page.evaluate — so the delta covers the click's own task
            plus at most the frame that paints it. The assertion is ≤ 2.
     2. Predicted card tops/heights match the rendered ones for all 40 cards
        (window.ATLAS_GRID_DEBUG.agreement(), zero mismatches).
     3. The hovered card keeps its on-screen position across a filter change.
     4. An expansion moves every other card at most once (position writes are
        counted in the layout's own bookkeeping), collapses cleanly, and the
        fitted hero headline lands on exactly 2 lines (≤ 3 on a phone).

   The two phases share one page visit, and the map checks run first: the grid
   checks scroll the grid to the top of the viewport, and the Text Atlas pauses
   its animation loop when it scrolls out of view. The zoom is put back to 1×
   before the grid work starts.

   Phase 3 ("the editorial field note") then opens the detail dialog itself, in
   its own page visits at three widths (360, 768 and 1280), and adds four
   claims about the hand-laid-out spread:

     1. All 40 stories fit. Every place is opened through
        window.ATLAS_DIALOG.open(id) at each of the three viewports; every
        laid-out line box must lie inside its column box (checked against the
        layout model AND against the painted DOM boxes) and the dialog, its
        body and the spread must have no horizontal scroll.
     2. At 1280 the two columns are justified, and no river — a chain of
        vertically aligned word gaps — may run longer than three lines. The
        report comes from ATLAS_DIALOG.debug().rivers, which chains the gaps
        the layout actually painted.
     3. Keyboard prev/next animates the dialog body's height: the height is
        sampled every frame across an ArrowRight, and a mid-flight sample must
        lie strictly between the start and end heights. Escape still closes,
        and #/place/<id> still opens.
     4. Accessibility: the visually hidden paragraph still carries the whole
        story (and the field note its whole text), every generated line span is
        aria-hidden, and the dialog's accessible name is still its title.

   Phase 4 ("names in their own script") adds three more:

     1. Every place whose native name is not Latin script has its hover card
        opened, and every line break the browser made in that name must land on
        an `Intl.Segmenter` word boundary (grapheme boundaries for CJK, which
        is the contract pretext offers there). Because a short name does not
        wrap in a real card, each one is then squeezed into a box exactly as
        wide as its own widest word — wrapping forced, no word ever asked to
        break — and judged again. A CJK name (prepared with `word-break:
        keep-all`) that wraps in the card at all is a failure: that is the
        overflow-wrap path pretext documents as approximate.
     2. The map label's middle line and the dialog's second line: at least one
        label carries a native line at 2.5x with the overlap count still zero,
        and all 33 places whose native name differs render it under the dialog
        title with the right text, `lang` and `dir`.
     3. For five searches, every highlighted tagline is painted as exactly the
        lines pretext's rich-inline flow predicted — one line box per block, no
        horizontal overflow, a plain accessible copy alongside, and every
        generated span aria-hidden — with ATLAS_GRID_DEBUG.agreement() still at
        zero mismatches while the search runs, and nothing left behind when it
        is cleared.

   Run: pnpm smoke  (or: node scripts/smoke.mjs) */
import { startServer, launchChromium, INSTALL_HINT } from "./browser-harness.mjs";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, heroLines: 2, expand: true },
  { name: "phone", width: 390, height: 844, heroLines: 3, expand: false }
];

// The layout budget for one interaction: the style + layout that paints the
// result. Anything above this means work was forced synchronously.
const LAYOUT_BUDGET = 2;

// Console messages that are advisories about the page's environment rather
// than faults in the page. Each one is listed explicitly, never a wildcard.
//   - frame-ancestors: only settable as an HTTP header, but the site is hosted
//     as static files, so the meta CSP declares it anyway and the browser says
//     (correctly) that it ignored that one directive.
const BENIGN_CONSOLE = [
  /'frame-ancestors' is ignored when delivered via a <meta> element/
];
const isBenign = (text) => BENIGN_CONSOLE.some((re) => re.test(text));

const fmt = (n) => Math.round(n * 100) / 100;

// Phase 1 thresholds.
const LABEL_ZOOMS = [1.5, 2.5];
// 40 places; the ones with no sea within four cells of the dot (Petra, the
// Libyan Glass Desert, Zhangjiajie…) legitimately go unlabelled.
const MIN_LABELS = 21;
// PERF_NOTE: headless Chromium serves requestAnimationFrame off the vsync
// clock, so the frame interval floors at ~16.7ms no matter how little work the
// page does — an "average frame under 16ms" is unreachable there even with the
// map switched off. So the run below measures the same 60-frame zoom twice,
// once with the labels on and once with ?noflags=labels,oceanLabels, and holds
// the labels to the delta between them plus the actual placement cost.
const MAX_FRAME_MS = 20;          // absolute ceiling on the average frame
const MAX_FRAME_OVERHEAD_MS = 4;  // what the labels may add to that average
const MAX_PLACEMENT_MS = 8;       // average cost of one placement pass

// Phase 3 thresholds.
// The three widths done-when 1 names, each in its own page visit.
const DIALOG_VIEWPORTS = [
  { name: "phone", width: 360, height: 780, twoCol: false },
  { name: "tablet", width: 768, height: 900, twoCol: false },
  { name: "desktop", width: 1280, height: 800, twoCol: true }
];
// A river may span three lines; a fourth is a channel the eye follows.
const MAX_RIVER_RUN = 3;
// Sub-pixel slack between what pretext computed and what Chromium painted.
const BOX_EPS = 1;
// One open() must stay cheap enough to feel instant.
const MAX_OPEN_MS = 60;

// Phase 4 thresholds.
// The searches the highlighted taglines are checked under. "temple" matches
// four stories but no tagline, which is the case worth keeping: a card can be
// in the results with nothing in its tagline to pick out.
const HIGHLIGHT_QUERIES = ["salt", "ice", "temple", "desert", "sea"];

/* ---------------------------------------------------------------------- *
 * In-page instrumentation                                                *
 * ---------------------------------------------------------------------- */

// Wrap every getter/method that can force a synchronous layout. While
// `window.__ATLAS_READS.on` is true each call is counted, and the call's stack
// decides whether js/app.js asked for it.
function installReadCounter() {
  const state = { on: false, total: 0, app: 0, byProp: {}, appStacks: [] };
  window.__ATLAS_READS = state;
  state.reset = () => {
    state.total = 0; state.app = 0; state.byProp = {}; state.appStacks = [];
  };
  const note = (prop) => {
    state.total++;
    state.byProp[prop] = (state.byProp[prop] || 0) + 1;
    const stack = new Error().stack || "";
    if (stack.indexOf("/js/app.js") !== -1) {
      state.app++;
      if (state.appStacks.length < 5) state.appStacks.push(prop + " <- " + stack);
    }
  };
  const wrapGetter = (proto, prop) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get() { if (state.on) note(prop); return d.get.call(this); },
      set: d.set
    });
  };
  for (const p of ["offsetHeight", "offsetWidth", "offsetTop", "offsetLeft"]) {
    wrapGetter(HTMLElement.prototype, p);
  }
  for (const p of ["clientHeight", "clientWidth", "clientTop", "clientLeft",
                   "scrollHeight", "scrollWidth"]) {
    wrapGetter(Element.prototype, p);
  }
  for (const m of ["getBoundingClientRect", "getClientRects"]) {
    const orig = Element.prototype[m];
    Element.prototype[m] = function () {
      if (state.on) note(m);
      return orig.apply(this, arguments);
    };
  }
  const gcs = window.getComputedStyle;
  window.getComputedStyle = function () {
    if (state.on) note("getComputedStyle");
    return gcs.apply(this, arguments);
  };
}

// Click something synchronously with the read counter armed, so the counted
// reads are exactly the ones the click's own task performed.
function clickAndCount(selector) {
  const el = document.querySelector(selector);
  if (!el) return { error: "no element for " + selector };
  const reads = window.__ATLAS_READS;
  reads.reset();
  reads.on = true;
  el.click();
  reads.on = false;
  return {
    total: reads.total, app: reads.app, byProp: reads.byProp,
    appStacks: reads.appStacks
  };
}

// Runs in the page (handed to page.evaluate): two frames.
const settle = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

// Node side: wait for `n` painted frames. (Named apart from the in-page
// `settle` above, which is serialised into the page rather than called here.)
const settleFrames = (page, n = 2) =>
  page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

/* ---------------------------------------------------------------------- *
 * Phase 1 probes: the map                                                *
 * ---------------------------------------------------------------------- */

// One scripted zoom from 1× to 2.5× over 60 frames, reporting the frame
// intervals and how much time the label placement itself took.
const ZOOM_RUN = `(async () => {
  const D = window.ATLAS_MAP_DEBUG;
  D.setZoom(1);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const before = D.stats();
  const deltas = [];
  let last = performance.now();
  for (let i = 1; i <= 60; i++) {
    D.setZoom(1 + (1.5 * i) / 60);
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    deltas.push(now - last);
    last = now;
  }
  const after = D.stats();
  const sorted = deltas.slice().sort((a, b) => a - b);
  return {
    frames: deltas.length,
    avg: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
    placements: after.placements - before.placements,
    placeAvgMs: after.avgMs
  };
})()`;

// Labels at one zoom, verified twice: from the placement records and from the
// painted boxes.
async function labelsAt(page, zoom) {
  await page.evaluate((z) => window.ATLAS_MAP_DEBUG.setZoom(z), zoom);
  await settleFrames(page);
  return page.evaluate(() => {
    const D = window.ATLAS_MAP_DEBUG;
    const routed = D.checkLabels();
    const painted = D.checkPainted();
    return {
      zoom: D.getZoom(), tier: routed.tier,
      labels: routed.labels, oceanLabels: routed.oceanLabels, lines: routed.lines,
      overlaps: routed.overlaps, problems: routed.problems,
      paintedBoxes: painted.boxes, paintedOverlaps: painted.overlaps,
      paintedProblems: painted.problems,
      domLabels: document.querySelectorAll(".map-label.is-placed").length,
      domOceanLabels: document.querySelectorAll(".map-ocean-label.is-placed").length
    };
  });
}

/* ---------------------------------------------------------------------- *
 * Phase 4 probes: names in their own script, and highlighted search hits  *
 * ---------------------------------------------------------------------- */

// Open the hover card for every place whose native name is not Latin script
// and check where the browser actually broke that line. A break has to land on
// an Intl.Segmenter WORD boundary (for Arabic, Thai, Khmer, Sinhala, Tibetan…)
// or, for the CJK scripts, on a grapheme boundary — which is the contract
// pretext offers there.
//
// Runs entirely inside the page: one evaluate, no per-place round trip.
function nativeHoverSweep() {
  const D = window.ATLAS_MAP_DEBUG;
  const T = window.ATLAS_TEXT;
  const out = {
    places: 0, nonLatin: 0, shown: 0, missing: [],
    lines: 0, wrapped: 0, breaks: 0, badBreaks: [],
    byScript: {}, dirs: {}, keepAll: 0, keepAllWrapped: [],
    predictionMismatch: [],
    narrow: {
      minWidth: Infinity, maxWidth: 0, checked: 0, wrapped: 0,
      unbreakable: [], lines: 0, breaks: 0, bad: []
    }
  };
  if (!D || !T || typeof T.scriptOf !== "function") {
    out.error = "ATLAS_MAP_DEBUG or ATLAS_TEXT (Phase 4 surface) missing";
    return out;
  }

  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const CJK = { Han: 1, Japanese: 1, Hangul: 1 };

  // The lines the browser painted, read a grapheme at a time off the live
  // element. A grapheme the browser collapsed at a soft wrap has no rect and
  // is carried onto the line before it, where trimming drops it.
  function paintedLines(el) {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) return [];
    const text = node.nodeValue;
    const range = document.createRange();
    const lines = [];
    let top = null, current = "";
    for (const g of graphemes.segment(text)) {
      range.setStart(node, g.index);
      range.setEnd(node, g.index + g.segment.length);
      const rects = range.getClientRects();
      if (!rects.length) { current += g.segment; continue; }
      const y = Math.round(rects[0].top * 4) / 4;
      if (top === null) { top = y; current = g.segment; continue; }
      if (Math.abs(y - top) > 1) { lines.push(current); current = g.segment; top = y; }
      else current += g.segment;
    }
    if (current) lines.push(current);
    return lines.map((l) => l.replace(/^\s+|\s+$/g, "")).filter((l) => l.length);
  }

  function boundaries(text, locale, script) {
    const set = new Set([0, text.length]);
    if (CJK[script]) {
      for (const g of graphemes.segment(text)) set.add(g.index + g.segment.length);
      return set;
    }
    const words = new Intl.Segmenter(locale || undefined, { granularity: "word" });
    for (const s of words.segment(text)) set.add(s.index + s.segment.length);
    return set;
  }

  // Where each painted line ended, as an offset into the source string.
  function offsetsOf(text, lines) {
    const offsets = [];
    let at = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      const found = text.indexOf(lines[i], at);
      if (found === -1) return null;
      at = found + lines[i].length;
      offsets.push(at);
    }
    return offsets;
  }

  function judge(id, where, text, lines, locale, script, sink) {
    const offsets = offsetsOf(text, lines);
    if (offsets === null) {
      sink.push({ id: id, where: where, why: "painted lines are not slices of the name" });
      return 0;
    }
    const set = boundaries(text, locale, script);
    for (const at of offsets) {
      if (set.has(at)) continue;
      if (/\s/.test(text.charAt(at)) && set.has(at + 1)) continue;
      sink.push({
        id: id, where: where, script: script, at: at,
        around: text.slice(Math.max(0, at - 4), at) + "|" + text.slice(at, at + 4)
      });
    }
    return offsets.length;
  }

  // The narrowest box that still fits this name's widest word. Squeezing to
  // that forces the name to wrap without ever asking the browser to break a
  // word — so a break that lands inside one is a real fault and not pretext's
  // (documented, approximate) overflow-wrap fallback for an overlong run. A
  // name that is a single word has nothing to wrap at and is reported as such.
  function probeWidthFor(text, locale) {
    const words = new Intl.Segmenter(locale || undefined, { granularity: "word" });
    let widest = 0, pieces = 0;
    for (const s of words.segment(text)) {
      if (!s.segment.replace(/\s+/g, "")) continue;
      pieces++;
      widest = Math.max(widest, T.naturalWidthOfText("native-name", s.segment));
    }
    if (!pieces) { widest = T.naturalWidthOfText("native-name", text); pieces = 1; }
    return { width: Math.ceil(widest) + 2, pieces: pieces };
  }

  // A narrow probe, so the wrapping is actually exercised: the same element
  // class (so the same font) at a width no real card ever uses.
  const host = document.createElement("div");
  host.className = "map-card";
  host.style.setProperty("position", "absolute");
  host.style.setProperty("left", "-9999px");
  host.style.setProperty("top", "0px");
  const probe = document.createElement("span");
  probe.className = "map-card-native";
  host.appendChild(probe);
  document.body.appendChild(host);

  for (const p of (window.ATLAS_DATA.places || [])) {
    out.places++;
    const native = String(p.nativeName || "");
    const script = T.scriptOf(native);
    if (script === "Latin") continue;
    out.nonLatin++;
    out.byScript[script] = (out.byScript[script] || 0) + 1;

    const shown = D.showCard(p.id);
    if (!shown || !shown.native) { out.missing.push(p.id); continue; }
    out.shown++;
    out.dirs[shown.native.dir] = (out.dirs[shown.native.dir] || 0) + 1;
    if (shown.native.wordBreak === "keep-all") out.keepAll++;

    const el = document.querySelector(".map-card .map-card-native");
    const lines = paintedLines(el);
    out.lines += lines.length;
    if (lines.length > 1) out.wrapped++;
    // `word-break: keep-all` on an overlong CJK run falls back to
    // overflow-wrap, which pretext documents as approximate — so a keep-all
    // name that actually wraps in the card is worth failing on.
    if (shown.native.wordBreak === "keep-all" && lines.length > 1) {
      out.keepAllWrapped.push(p.id + " → " + lines.length + " line(s)");
    }
    if (lines.length !== shown.native.predictedLines) {
      out.predictionMismatch.push({
        id: p.id, predicted: shown.native.predictedLines, painted: lines.length
      });
    }
    out.breaks += judge(p.id, "hover card", native, lines, p.nativeLang, script, out.badBreaks);

    // …and again, deliberately squeezed to its own widest word.
    const box = probeWidthFor(native, p.nativeLang);
    probe.textContent = native;
    if (shown.native.wordBreak === "keep-all") probe.setAttribute("data-wb", "keep-all");
    else probe.removeAttribute("data-wb");
    probe.setAttribute("dir", shown.native.dir);
    probe.style.setProperty("width", box.width + "px");
    probe.style.setProperty("max-width", box.width + "px");
    const tight = paintedLines(probe);
    out.narrow.checked++;
    out.narrow.lines += tight.length;
    out.narrow.minWidth = Math.min(out.narrow.minWidth, box.width);
    out.narrow.maxWidth = Math.max(out.narrow.maxWidth, box.width);
    if (tight.length > 1) out.narrow.wrapped++;
    else if (box.pieces < 2) out.narrow.unbreakable.push(p.id);
    out.narrow.breaks +=
      judge(p.id, "narrow probe", native, tight, p.nativeLang, script, out.narrow.bad);
  }

  host.remove();
  D.hideCard();
  return out;
}

// The tagline flow while a search is running: every visible card's tagline is
// laid out by pretext's rich-inline helper over two fonts, painted one block
// per line, and the card's predicted height uses that line count. For each
// query: the painted line boxes must be exactly the lines that were predicted
// (one line box each, no re-wrap, no horizontal overflow), and the grid must
// still agree with its own arithmetic.
function highlightSweep(queries) {
  const G = window.ATLAS_GRID_DEBUG;
  const out = { queries: [], error: null };
  if (!G || typeof G.setQuery !== "function") {
    out.error = "ATLAS_GRID_DEBUG.setQuery is missing (Phase 4 surface)";
    return out;
  }
  for (const q of queries) {
    G.setQuery(q);
    const flows = G.flows();
    const agreement = G.agreement();
    const row = {
      query: q,
      cards: document.querySelectorAll("#grid .card").length,
      flowed: Object.keys(flows).length,
      matches: 0, boldRuns: 0,
      lineMismatches: [], overflow: [], tallLines: [],
      agreementChecked: agreement.checked,
      agreementWarnings: agreement.warnings,
      highlighted: agreement.highlighted,
      flowMismatches: agreement.taglineFlowMismatches,
      plainCopies: 0, exposedLines: 0
    };
    for (const id of Object.keys(flows)) {
      const flow = flows[id];
      row.matches += flow.matches;
      const card = document.querySelector('.card[data-place-id="' + id + '"]');
      if (!card) { row.lineMismatches.push(id + ": no card"); continue; }
      const tag = card.querySelector(".card-tag");
      const painted = tag.querySelectorAll(".tag-line");
      if (painted.length !== flow.lines) {
        row.lineMismatches.push(
          id + ": predicted " + flow.lines + ", painted " + painted.length);
      }
      row.boldRuns += tag.querySelectorAll(".hl").length;
      if (tag.querySelector(".visually-hidden")) row.plainCopies++;
      for (const line of painted) {
        if (!line.getAttribute("aria-hidden")) row.exposedLines++;
        // One block per line means one line box per block; a re-wrap would
        // make the block two line-heights tall.
        const n = Math.round(line.offsetHeight / flow.lineHeight);
        if (n !== 1) row.tallLines.push(id + ": a line box is " + n + " lines tall");
      }
      if (tag.scrollWidth > tag.clientWidth + 1) {
        row.overflow.push(id + ": " + tag.scrollWidth + " > " + tag.clientWidth);
      }
    }
    out.queries.push(row);
  }
  G.setQuery("");
  out.cleared = {
    flowed: Object.keys(G.flows()).length,
    lineSpans: document.querySelectorAll("#grid .card-tag .tag-line").length,
    agreement: G.agreement()
  };
  return out;
}

// Every place's hover card, inspected for a one-word last line.
function taglineWidows(page) {
  return page.evaluate(() => {
    const D = window.ATLAS_MAP_DEBUG;
    const widows = [];
    let checked = 0, narrowest = Infinity, widest = 0;
    for (const p of (window.ATLAS_DATA.places || [])) {
      const shown = D.showCard(p.id);
      if (!shown) continue;
      checked++;
      narrowest = Math.min(narrowest, shown.width);
      widest = Math.max(widest, shown.width);
      const lines = shown.lines.map((l) => l.trim()).filter((l) => l.length);
      const last = lines[lines.length - 1] || "";
      if (lines.length >= 2 && !/\s/.test(last)) widows.push(p.id + ' → "' + last + '"');
    }
    D.hideCard();
    return { checked: checked, widows: widows, narrowest: narrowest, widest: widest };
  });
}

/* ---------------------------------------------------------------------- *
 * Phase 3 probes: the editorial dialog                                   *
 * ---------------------------------------------------------------------- */

// Open all 40 places and check each spread against both the layout model and
// the boxes Chromium actually painted. Runs entirely inside the page: one
// evaluate, no per-place round trip.
function dialogSweep(eps) {
  const D = window.ATLAS_DIALOG;
  const dlg = document.getElementById("place-dialog");
  const body = dlg.querySelector(".dialog-body");
  const spread = dlg.querySelector(".story-spread");
  const out = {
    opened: 0, twoCol: null, justified: null, colWidth: null, innerWidth: null,
    modelOutside: [], paintedOutside: [], overflowLines: [], scroll: [],
    worstRiver: null, riverPlaces: 0, riverTotal: 0,
    lineCounts: [], chipCounts: { chips: 0, fields: 0, plain: 0 },
    hyphenated: 0, dropCaps: 0, pullQuotes: 0, fullBleed: 0,
    native: { shown: 0, expected: 0, dirs: {}, wrong: [] },
    maxOpenMs: 0, a11y: { storyMismatch: [], factMismatch: [], exposedLines: 0,
                          nameMismatch: [], hiddenStory: 0 },
    trials: null, reveal: null
  };

  for (const p of (window.ATLAS_DATA.places || [])) {
    const t0 = performance.now();
    D.open(p.id);
    const took = performance.now() - t0;
    if (took > out.maxOpenMs) out.maxOpenMs = took;
    const d = D.debug();
    if (!d.ready) continue;
    out.opened++;
    out.twoCol = d.twoCol;

    // Phase 4: the second name under the title, and what the DOM carries.
    const wantNative = !!p.nativeName && p.nativeName !== p.name;
    if (wantNative) out.native.expected++;
    if (d.native && d.native.shown) {
      out.native.shown++;
      out.native.dirs[d.native.rendered.dir] =
        (out.native.dirs[d.native.rendered.dir] || 0) + 1;
      if (d.native.rendered.text !== p.nativeName ||
          d.native.rendered.lang !== (p.nativeLang || null) ||
          d.native.rendered.dir !== d.native.planned.dir) {
        out.native.wrong.push(p.id);
      }
    } else if (wantNative) {
      out.native.wrong.push(p.id + " (missing)");
    }
    out.justified = d.justified;
    out.colWidth = d.colWidth;
    out.innerWidth = d.innerWidth;
    out.trials = d.trials;
    out.reveal = d.reveal;
    out.lineCounts.push(d.lines.length);
    if (d.dropCap.lines) out.dropCaps++;
    if (d.pullQuote.lines) out.pullQuotes++;
    if (d.pullQuote.fullBleed) out.fullBleed++;

    // --- done-when 1: the model ---------------------------------------
    for (const line of d.lines) {
      const col = d.columns[line.col];
      if (line.x < col.x - 0.01 || line.x + line.width > col.x + col.width + 0.01) {
        out.modelOutside.push(
          p.id + " col" + line.col + " row" + line.row + ": " +
          Math.round(line.x) + "+" + Math.round(line.width) + " in " +
          Math.round(col.x) + "+" + Math.round(col.width));
      }
      if (line.overflow) out.overflowLines.push(p.id + " row" + line.row);
      if (line.hyphenated) out.hyphenated++;
    }

    // --- done-when 1: the painted boxes -------------------------------
    const spreadRect = spread.getBoundingClientRect();
    const lineEls = spread.querySelectorAll(".story-line");
    for (let i = 0; i < lineEls.length; i++) {
      const el = lineEls[i];
      const model = d.lines[i];
      if (!model) continue;
      const col = d.columns[model.col];
      const r = el.getBoundingClientRect();
      const left = r.left - spreadRect.left;
      const right = r.right - spreadRect.left;
      if (left < col.x - eps || right > col.x + col.width + eps) {
        out.paintedOutside.push(
          p.id + " row" + model.row + ": painted " + Math.round(left) + ".." +
          Math.round(right) + " outside " + Math.round(col.x) + ".." +
          Math.round(col.x + col.width));
      }
    }
    for (const [what, el] of [["dialog", dlg], ["body", body], ["spread", spread]]) {
      if (el.scrollWidth > el.clientWidth) {
        out.scroll.push(p.id + " " + what + " " + el.scrollWidth + " > " + el.clientWidth);
      }
    }

    // --- done-when 2: rivers ------------------------------------------
    if (d.rivers.riverCount) out.riverPlaces++;
    out.riverTotal += d.rivers.riverCount;
    if (!out.worstRiver || d.rivers.maxRun > out.worstRiver.run) {
      out.worstRiver = {
        id: p.id, run: d.rivers.maxRun,
        col: d.rivers.worst ? d.rivers.worst.col : null,
        startRow: d.rivers.worst ? d.rivers.worst.startRow : null,
        endRow: d.rivers.worst ? d.rivers.worst.endRow : null,
        gapRatio: d.rivers.worst ? d.rivers.worst.gapRatio : null,
        colWidth: d.colWidth
      };
    }

    // --- F: the metadata chips ----------------------------------------
    for (const f of d.fields) {
      out.chipCounts.fields++;
      out.chipCounts.chips += f.chips;
      if (!f.chips) out.chipCounts.plain++;
      if (f.maxLineWidth > f.width + 0.5) {
        out.scroll.push(p.id + " field " + f.key + " " +
                        Math.round(f.maxLineWidth) + " > " + f.width);
      }
    }

    // --- done-when 4: accessibility ------------------------------------
    if (d.accessible.story !== p.story) out.a11y.storyMismatch.push(p.id);
    if (d.accessible.fact !== p.fact) out.a11y.factMismatch.push(p.id);
    if (d.accessible.titlePlain !== p.name) out.a11y.nameMismatch.push(p.id);
    const storyEl = document.getElementById("dialog-story");
    const cs = getComputedStyle(storyEl);
    if (cs.display !== "none" && cs.visibility !== "hidden" &&
        storyEl.offsetWidth <= 2) out.a11y.hiddenStory++;
    for (const el of spread.querySelectorAll(".story-line, .pull-quote-line")) {
      if (el.getAttribute("aria-hidden") !== "true") out.a11y.exposedLines++;
    }
  }

  // The accessible name still comes from the title element.
  const labelledBy = dlg.getAttribute("aria-labelledby");
  const titleEl = labelledBy ? document.getElementById(labelledBy) : null;
  out.accessibleName = {
    labelledBy: labelledBy,
    text: titleEl ? titleEl.textContent.replace(/\u00AD/g, "") : null
  };
  D.close();
  out.closedAfterSweep = !dlg.open;
  return out;
}

// Sample the dialog body's height every frame so a real key press can be
// timed against it.
function armHeightSampler(ms) {
  const body = document.querySelector("#place-dialog .dialog-body");
  const samples = [];
  const t0 = performance.now();
  window.__ATLAS_DIALOG_HEIGHTS = samples;
  const tick = () => {
    samples.push({
      t: Math.round((performance.now() - t0) * 10) / 10,
      h: Math.round(body.getBoundingClientRect().height * 100) / 100
    });
    if (performance.now() - t0 < ms) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function dialogInteraction(page) {
  // Pick a neighbouring pair whose bodies are different heights, so "the
  // height animated" is a claim the measurement can actually falsify.
  const pair = await page.evaluate(() => {
    const D = window.ATLAS_DIALOG;
    const places = window.ATLAS_DATA.places;
    const heights = places.map((p) => {
      D.open(p.id);
      return D.debug().heights.variable;
    });
    D.close();
    for (let i = 0; i < places.length - 1; i++) {
      if (Math.abs(heights[i] - heights[i + 1]) > 12) {
        return { from: places[i].id, to: places[i + 1].id,
                 fromH: heights[i], toH: heights[i + 1] };
      }
    }
    return null;
  });
  if (!pair) return { pair: null };

  await page.evaluate((id) => window.ATLAS_DIALOG.open(id), pair.from);
  await settleFrames(page, 3);
  await page.evaluate(armHeightSampler, 900);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(950);

  const step = await page.evaluate((expected) => {
    const samples = window.__ATLAS_DIALOG_HEIGHTS || [];
    const D = window.ATLAS_DIALOG;
    const heights = samples.map((s) => s.h);
    const from = heights.length ? heights[0] : 0;
    const to = heights.length ? heights[heights.length - 1] : 0;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    // A sample strictly between the two ends is proof the body was animated
    // rather than snapped.
    let between = null;
    let distinct = new Set();
    for (const h of heights) {
      distinct.add(h);
      if (h > lo + 0.5 && h < hi - 0.5) {
        if (between === null || Math.abs(h - (lo + hi) / 2) < Math.abs(between - (lo + hi) / 2)) {
          between = h;
        }
      }
    }
    return {
      landedOn: D.currentId(), expected: expected,
      from: from, to: to, mid: between,
      distinct: distinct.size, samples: heights.length
    };
  }, pair.to);

  // Escape still closes, and the hash route still opens.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  const closed = await page.evaluate(() => !document.getElementById("place-dialog").open);

  const routeId = await page.evaluate(() => window.ATLAS_DATA.places[22].id);
  await page.evaluate((id) => { location.hash = "#/place/" + encodeURIComponent(id); }, routeId);
  await page.waitForTimeout(250);
  const routed = await page.evaluate(() => ({
    open: !!document.getElementById("place-dialog").open,
    id: window.ATLAS_DIALOG.currentId(),
    highlighted: document.querySelectorAll(".map-marker.is-pulsing, .map-marker.pulse").length
  }));
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForTimeout(200);
  const closedByRoute = await page.evaluate(
    () => !document.getElementById("place-dialog").open);

  return { pair, step, closed, routeId, routed, closedByRoute };
}

// One page visit dedicated to the dialog, at one width.
async function visitDialog(browser, origin, viewport) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    const text = m.text();
    if (!isBenign(text) && m.type() === "error") errors.push(text);
  });
  page.on("pageerror", (e) => errors.push(`uncaught: ${e && e.message ? e.message : e}`));
  try {
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.ATLAS_DIALOG_READY === true, null, { timeout: 15000 });
    await page.waitForFunction(() => !!window.ATLAS_GRID_DEBUG, null, { timeout: 15000 });
    await settleFrames(page, 2);
    const sweep = await page.evaluate(dialogSweep, BOX_EPS);
    const flags = await page.evaluate(() => window.ATLAS_DIALOG.debug().flags);
    const interaction = viewport.twoCol ? await dialogInteraction(page) : null;
    return { sweep, flags, interaction, errors };
  } finally {
    await context.close();
  }
}

/* ---------------------------------------------------------------------- *
 * CDP metrics                                                            *
 * ---------------------------------------------------------------------- */

async function readMetrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const by = Object.create(null);
  for (const m of metrics) by[m.name] = m.value;
  return { layout: by.LayoutCount || 0, recalc: by.RecalcStyleCount || 0 };
}

/* ---------------------------------------------------------------------- *
 * One viewport                                                           *
 * ---------------------------------------------------------------------- */

async function visit(browser, origin, viewport, options) {
  const query = (options && options.query) || "";
  const errors = [];
  const warnings = [];
  const ignored = [];
  const notes = [];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    const text = m.text();
    if (isBenign(text)) ignored.push(text);
    else if (m.type() === "error") errors.push(text);
    else if (m.type() === "warning") warnings.push(text);
  });
  page.on("pageerror", (e) => errors.push(`uncaught: ${e && e.message ? e.message : e}`));
  page.on("requestfailed", (r) => {
    // A same-origin asset that 404s would silently degrade the page.
    errors.push(`request failed: ${r.url()} (${r.failure() && r.failure().errorText})`);
  });

  try {
    // js/text.js sets ATLAS_TEXT_READY and fires atlas:text-ready; catching
    // either means a late attach cannot miss the event.
    await page.goto(`${origin}/index.html${query}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.ATLAS_TEXT_READY === true, null, { timeout: 15000 });
    await page.waitForSelector(".map-stage .map-marker", { timeout: 15000 });
    // The dev agreement check runs on a rAF after load.
    await page.waitForFunction(() => !!window.ATLAS_TEXT_AGREEMENT, null, { timeout: 15000 });
    await page.waitForFunction(() => !!window.ATLAS_GRID_DEBUG, null, { timeout: 15000 });
    await settleFrames(page, 2);

    const stats = await page.evaluate(() => ({
      cards: document.querySelectorAll("#grid .card").length,
      markers: document.querySelectorAll(".map-marker").length,
      roles: window.ATLAS_TEXT ? window.ATLAS_TEXT.roleNames().length : 0,
      agreement: window.ATLAS_TEXT_AGREEMENT,
      mapDebug: !!window.ATLAS_MAP_DEBUG,
      labelFlags: window.ATLAS_MAP_DEBUG ? window.ATLAS_MAP_DEBUG.flags : null,
      labelsNow: document.querySelectorAll(".map-label.is-placed").length,
      oceanLabelsNow: document.querySelectorAll(".map-ocean-label.is-placed").length
    }));

    // The frame-timing baseline (?noflags=labels,oceanLabels) wants the zoom
    // run and nothing else — no grid work, so the two runs stay comparable.
    if (options && options.perfOnly) {
      return { stats, errors, warnings, ignored, perf: await page.evaluate(ZOOM_RUN) };
    }

    /* ---- Phase 1: labels on the map ---------------------------------- *
     * First, while the map is still on screen and running: the grid checks
     * below scroll it out of view, which pauses its animation loop.       */
    let map = null;
    if (viewport.name === "desktop") {
      map = { zooms: [], perf: null, taglines: null };
      for (const z of LABEL_ZOOMS) map.zooms.push(await labelsAt(page, z));
      await page.evaluate(() => window.ATLAS_MAP_DEBUG.setZoom(1));
      await settleFrames(page);
      map.taglines = await taglineWidows(page);
      // Phase 4, done-when 2: the native name inside the hover card.
      map.native = await page.evaluate(nativeHoverSweep);
      map.nativeLabels = await page.evaluate(() => {
        window.ATLAS_MAP_DEBUG.setZoom(2.5);
        window.ATLAS_MAP_DEBUG.place();
        const rows = window.ATLAS_MAP_DEBUG.nativeLabels();
        window.ATLAS_MAP_DEBUG.setZoom(1);
        return {
          labels: rows.length,
          lines: rows.reduce((n, r) => n + r.lines, 0),
          rtl: rows.filter((r) => r.dir === "rtl").length,
          sample: rows.slice(0, 3)
        };
      });
      await settleFrames(page);
      map.perf = await page.evaluate(ZOOM_RUN);
    }
    // The zoom run leaves the map at 2.5×; hand the grid a page in its
    // resting state.
    await page.evaluate(() => {
      if (window.ATLAS_MAP_DEBUG) window.ATLAS_MAP_DEBUG.setZoom(1);
    });
    await settleFrames(page, 2);

    /* ---- Phase 2: the predictive grid -------------------------------- */

    // ---- Done-when 2: the whole grid agrees with the prediction ---------
    const grid = await page.evaluate(() => window.ATLAS_GRID_DEBUG.agreement());

    // ---- Done-when 4b: the fitted hero headline -------------------------
    const hero = await page.evaluate(() => {
      const fit = window.ATLAS_GRID_DEBUG.hero();
      const el = document.getElementById("hero-title");
      if (!fit || !el) return null;
      return {
        sizePx: fit.sizePx,
        lineHeight: fit.lineHeight,
        predictedLines: fit.lines,
        maxLines: fit.maxLines,
        maxWidth: fit.maxWidth,
        available: fit.available,
        renderedLines: Math.round(el.offsetHeight / fit.lineHeight),
        renderedHeight: el.offsetHeight
      };
    });

    // Bring the grid to the top of the viewport: the Text Atlas pauses its
    // animation loop when it scrolls out of view, so the layout counters below
    // measure this phase's work and not the sea.
    await page.evaluate(() => {
      document.getElementById("grid").scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.waitForTimeout(700);
    await page.evaluate(installReadCounter);
    await page.evaluate(settle);

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");

    // ---- Done-when 1a: a filter change ---------------------------------
    const chipSelector = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll("#category-chips .chip"));
      const i = chips.findIndex((c) => !c.classList.contains("active"));
      return "#category-chips .chip:nth-child(" + (i + 1) + ")";
    });
    const beforeFilter = await readMetrics(cdp);
    const filterReads = await page.evaluate(clickAndCount, chipSelector);
    const afterFilter = await readMetrics(cdp);
    const filter = {
      reads: filterReads,
      layout: afterFilter.layout - beforeFilter.layout,
      recalc: afterFilter.recalc - beforeFilter.recalc,
      cards: await page.evaluate(() => window.ATLAS_GRID_DEBUG.lastLayout())
    };
    await page.waitForTimeout(600);

    // Back to the full list.
    await page.evaluate(() => document.querySelector("#category-chips .chip").click());
    await page.waitForTimeout(600);

    // ---- Done-when 3: the hovered card stays under the cursor ----------
    // Dry run first: with no card hovered (so no anchoring happens) try every
    // category chip and record where each surviving card lands. That turns
    // "pick a card that will move" into a measurement instead of a guess, at
    // any viewport / column count.
    const moves = [];
    const chipCount = await page.evaluate(
      () => document.querySelectorAll("#category-chips .chip").length);
    const beforeSlots = await page.evaluate(() => window.ATLAS_GRID_DEBUG.slots());
    for (let i = 2; i <= chipCount; i++) {
      const sel = `#category-chips .chip:nth-child(${i})`;
      const after = await page.evaluate((s) => {
        document.querySelector(s).click();
        return window.ATLAS_GRID_DEBUG.slots();
      }, sel);
      for (const id of Object.keys(after)) {
        if (beforeSlots[id]) moves.push({ id, chip: sel, move: after[id].top - beforeSlots[id].top });
      }
      await page.evaluate(() => document.querySelector("#category-chips .chip").click());
    }
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      document.getElementById("grid").scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.waitForTimeout(300);
    // Prefer a card that rises by a few hundred pixels: far enough that the
    // check means something, near enough that the compensating scroll is not
    // clamped by the (now shorter) document. In a single column every move is
    // a whole category's worth of cards, so fall back to the smallest of those.
    const upward = moves
      .filter((m) => m.move < -80)
      .sort((a, b) => Math.abs(a.move) - Math.abs(b.move));
    const nearby = upward.filter((m) => m.move > -700);
    const target = (nearby.length ? nearby[nearby.length - 1] : upward[0]) || null;

    let anchor = null;
    if (target) {
      await page.hover(`.card[data-place-id="${target.id}"]`);
      await page.waitForTimeout(120);
      const hovered = await page.evaluate(() => window.ATLAS_GRID_DEBUG.anchorId());
      // Park the pointer off the grid before measuring. The anchor is sticky
      // (the last card the pointer was over), and `.card:hover` lifts the card
      // 3px — which would show up in the rects as a drift that is not one.
      // A single teleporting move never crosses another card.
      await page.mouse.move(4, 4);
      await page.waitForTimeout(120);
      const before = await page.evaluate((id) => {
        const el = document.querySelector(`.card[data-place-id="${id}"]`);
        return {
          top: el.getBoundingClientRect().top,
          scrollY: window.scrollY,
          slotTop: window.ATLAS_GRID_DEBUG.slots()[id].top,
          anchor: window.ATLAS_GRID_DEBUG.anchorId()
        };
      }, target.id);
      // Dispatched without moving the mouse, so the pointer's card is still
      // exactly the one that was hovered (a real click would drag the pointer
      // across other cards on its way to the chip).
      await page.evaluate((sel) => document.querySelector(sel).click(), target.chip);
      const after = await page.evaluate((id) => {
        const el = document.querySelector(`.card[data-place-id="${id}"]`);
        const layout = window.ATLAS_GRID_DEBUG.lastLayout();
        const slot = window.ATLAS_GRID_DEBUG.slots()[id];
        return {
          top: el ? el.getBoundingClientRect().top : null,
          scrollY: window.scrollY,
          scrollDelta: layout.scrollDelta,
          slotTop: slot ? slot.top : null
        };
      }, target.id);
      anchor = {
        id: target.id, hovered: before.anchor, hoveredLive: hovered, chip: target.chip,
        beforeTop: fmt(before.top), afterTop: after.top == null ? null : fmt(after.top),
        drift: after.top == null ? null : fmt(Math.abs(after.top - before.top)),
        slotMoved: after.slotTop == null ? null : fmt(after.slotTop - before.slotTop),
        scrollApplied: fmt(after.scrollY - before.scrollY),
        scrollWanted: after.scrollDelta
      };
      await page.waitForTimeout(600);
      await page.evaluate(() => document.querySelector("#category-chips .chip").click());
      await page.waitForTimeout(600);
      await page.evaluate(() => window.ATLAS_GRID_DEBUG.setHover(null));
    }

    // ---- Done-when 1b + 4a: expand a card in place ---------------------
    let expand = null;
    if (viewport.expand) {
      const cardSel = await page.evaluate(() => {
        const id = window.ATLAS_DATA.places[6].id;
        return `.card[data-place-id="${id}"]`;
      });
      await page.evaluate(() => window.ATLAS_GRID_DEBUG.resetWrites());
      const beforeExpand = await readMetrics(cdp);
      const expandReads = await page.evaluate(clickAndCount, cardSel);
      const afterExpand = await readMetrics(cdp);
      const state = await page.evaluate(() => ({
        expandedId: window.ATLAS_GRID_DEBUG.expandedId(),
        writes: window.ATLAS_GRID_DEBUG.writes(),
        lastLayout: window.ATLAS_GRID_DEBUG.lastLayout()
      }));
      const counts = Object.values(state.writes);
      await page.waitForTimeout(700);
      const openAgreement = await page.evaluate(() => window.ATLAS_GRID_DEBUG.agreement());
      // ... and collapse again.
      await page.evaluate((sel) => document.querySelector(sel).click(), cardSel);
      await page.waitForTimeout(700);
      const collapsed = await page.evaluate(() => ({
        expandedId: window.ATLAS_GRID_DEBUG.expandedId(),
        openBlocks: document.querySelectorAll("#grid .card-expand:not([hidden])").length,
        heights: Array.from(document.querySelectorAll("#grid .card"))
          .filter((c) => c.style.height).length,
        agreement: window.ATLAS_GRID_DEBUG.agreement()
      }));
      expand = {
        reads: expandReads,
        layout: afterExpand.layout - beforeExpand.layout,
        recalc: afterExpand.recalc - beforeExpand.recalc,
        expandedId: state.expandedId,
        cardsWritten: counts.length,
        maxWritesPerCard: counts.length ? Math.max(...counts) : 0,
        moved: state.lastLayout.moved,
        openAgreement,
        collapsed
      };
    }

    /* ---- Phase 4: the search terms picked out of the taglines --------- *
     * Last, because it leaves the grid filtered while it runs; the query is
     * cleared again before the sweep returns.                             */
    const highlight = await page.evaluate(highlightSweep, HIGHLIGHT_QUERIES);
    await settleFrames(page, 2);

    await cdp.detach();
    return {
      stats, map, grid, hero, filter, anchor, expand, highlight,
      errors, warnings, ignored, notes
    };
  } finally {
    await context.close();
  }
}

/* ---------------------------------------------------------------------- *
 * Reporting                                                              *
 * ---------------------------------------------------------------------- */

function reportViewport(label, res, viewport, fail) {
  const { stats, map, base, grid, hero, filter, anchor, expand, highlight } = res;
  console.log(
    `${label.padEnd(22)} cards ${stats.cards}, markers ${stats.markers}, ` +
    `roles ${stats.roles}, agreement ${stats.agreement.checked} card(s)/` +
    `${stats.agreement.warnings} warning(s), console warnings ${res.warnings.length}` +
    (res.ignored.length ? `, ${res.ignored.length} benign advisory(ies)` : "") +
    (res.errors.length ? `, ERRORS ${res.errors.length}` : "")
  );
  for (const w of res.warnings) console.log(`  warning: ${w}`);
  for (const i of res.ignored) console.log(`  ignored (known benign): ${i}`);
  if (!stats.cards || !stats.markers) fail(`${label} rendered no cards or no markers`);
  if (stats.agreement.warnings > 0) {
    fail(`${label} had ${stats.agreement.warnings} metrics disagreement(s)`);
  }
  if (!stats.mapDebug) fail(`${label} did not publish window.ATLAS_MAP_DEBUG`);

  /* ---- Phase 1: labels on the map ----------------------------------- */
  if (viewport.name === "phone") {
    // Below 640px the hover card carries the name; nothing is routed.
    console.log(
      `  labels: ${stats.labelsNow} place, ${stats.oceanLabelsNow} ocean ` +
      "(expected 0 and 0 on a phone)"
    );
    if (stats.labelsNow || stats.oceanLabelsNow) {
      fail(`${label} rendered labels below the 640px cut-off`);
    }
  }

  if (map) {
    for (const z of map.zooms) {
      console.log(
        `  zoom ${z.zoom.toFixed(2)}x (tier ${z.tier}): ${z.labels} place label(s) / ` +
        `${z.lines} line(s), ${z.oceanLabels} ocean name(s), ` +
        `${z.overlaps} routed overlap(s), ${z.paintedOverlaps} painted overlap(s) ` +
        `over ${z.paintedBoxes} painted box(es)`
      );
      if (z.overlaps || z.paintedOverlaps) {
        fail(`${label} at ${z.zoom.toFixed(2)}x has overlapping labels`);
        for (const p of z.problems.concat(z.paintedProblems).slice(0, 8)) {
          console.error(`      ${p.what} "${p.id}" cell r${p.row} c${p.col}: ${p.why}`);
        }
      }
      if (z.labels < MIN_LABELS) {
        fail(
          `only ${z.labels} label(s) placed at ${z.zoom.toFixed(2)}x ` +
          `(expected more than ${MIN_LABELS - 1})`
        );
      }
      if (z.labels !== z.domLabels || z.oceanLabels !== z.domOceanLabels) {
        fail(
          `placement records (${z.labels}/${z.oceanLabels}) and the DOM ` +
          `(${z.domLabels}/${z.domOceanLabels}) disagree at ${z.zoom.toFixed(2)}x`
        );
      }
    }

    const t = map.taglines;
    console.log(
      `  hover cards: ${t.checked} checked, ${t.widows.length} one-word last line(s), ` +
      `width ${Math.round(t.narrowest)}–${Math.round(t.widest)}px`
    );
    if (t.checked !== stats.cards) {
      fail(`only ${t.checked} of ${stats.cards} hover cards could be shown`);
    }
    if (t.widows.length) {
      fail(`${t.widows.length} tagline(s) end on a single word:`);
      for (const w of t.widows) console.error(`      ${w}`);
    }

    /* ---- Phase 4, done-when 2: the native name in the hover card ------ */
    const n = map.native;
    if (n.error) {
      fail(`${label} native-name sweep: ${n.error}`);
    } else {
      const scripts = Object.keys(n.byScript).sort()
        .map((s) => `${s} ${n.byScript[s]}`).join(", ");
      const dirs = Object.keys(n.dirs).sort()
        .map((d) => `${n.dirs[d]} ${d}`).join(", ");
      console.log(
        `  native names: ${n.nonLatin} of ${n.places} places are non-Latin ` +
        `(${scripts}); ${n.shown} hover card(s) showed one (${dirs}), ` +
        `${n.lines} painted line(s), ${n.wrapped} wrapped, ${n.breaks} break(s), ` +
        `${n.badBreaks.length} not on a word/grapheme boundary`
      );
      console.log(
        `  native names, squeezed to their own widest word ` +
        `(${n.narrow.minWidth}–${n.narrow.maxWidth}px): ${n.narrow.checked} name(s), ` +
        `${n.narrow.wrapped} forced to wrap, ${n.narrow.unbreakable.length} single-word ` +
        `(${n.narrow.unbreakable.join(", ") || "none"}), ${n.narrow.lines} line(s), ` +
        `${n.narrow.breaks} break(s), ${n.narrow.bad.length} not on a word/grapheme boundary`
      );
      if (n.shown !== n.nonLatin) {
        fail(`${label} showed ${n.shown} of ${n.nonLatin} non-Latin native names` +
             (n.missing.length ? `: ${n.missing.join(", ")}` : ""));
      }
      for (const bad of n.badBreaks.concat(n.narrow.bad)) {
        console.error(`      ${bad.where} "${bad.id}": ${bad.around || bad.why}`);
      }
      if (n.badBreaks.length || n.narrow.bad.length) {
        fail(`${label} broke ${n.badBreaks.length + n.narrow.bad.length} native ` +
             "name(s) inside a word");
      }
      if (n.predictionMismatch.length) {
        fail(`${label} painted a different number of native-name lines than ` +
             `predicted: ${JSON.stringify(n.predictionMismatch)}`);
      }
      // keep-all + an overlong CJK run is pretext's approximate path; the
      // dataset must never reach it in the card the reader sees.
      if (n.keepAllWrapped.length) {
        fail(`${label} a keep-all (CJK) native name wrapped in the hover card: ` +
             n.keepAllWrapped.join(", "));
      }
      // The squeeze has to actually squeeze: every name with more than one
      // word must have been forced onto more than one line.
      const breakable = n.narrow.checked - n.narrow.unbreakable.length;
      if (n.narrow.wrapped < breakable) {
        fail(`${label} only ${n.narrow.wrapped} of ${breakable} multi-word native ` +
             "name(s) were forced to wrap — the check proves little");
      }
    }

    const nl = map.nativeLabels;
    console.log(
      `  map labels at 2.50x: ${nl.labels} carry a native line ` +
      `(${nl.lines} line(s), ${nl.rtl} right-to-left)`
    );
    if (!nl.labels) fail(`${label} no map label carried a native-name line at 2.5x`);

    // Frame timing, against the baseline run with the labels off.
    const p = map.perf, b = base && base.perf;
    if (!b) {
      fail(`${label} has no labels-off baseline for the frame timing`);
    } else {
      const overhead = p.avg - b.avg;
      console.log(
        `  zoom 1x→2.5x over ${p.frames} frames: avg ${p.avg.toFixed(2)}ms/frame ` +
        `(median ${p.median.toFixed(2)}, p95 ${p.p95.toFixed(2)}, max ${p.max.toFixed(2)}); ` +
        `labels off: ${b.avg.toFixed(2)}ms → labels cost ${overhead.toFixed(2)}ms/frame; ` +
        `${p.placements} placement(s) at ${p.placeAvgMs.toFixed(2)}ms each`
      );
      console.log(
        "    note: headless Chromium's rAF is vsync-locked (~16.7ms floor), so the " +
        "budget below is the label overhead, not the raw interval"
      );
      if (p.avg > MAX_FRAME_MS) {
        fail(`average frame ${p.avg.toFixed(2)}ms exceeds ${MAX_FRAME_MS}ms`);
      }
      if (overhead > MAX_FRAME_OVERHEAD_MS) {
        fail(
          `labels add ${overhead.toFixed(2)}ms per frame ` +
          `(budget ${MAX_FRAME_OVERHEAD_MS}ms)`
        );
      }
      if (p.placeAvgMs > MAX_PLACEMENT_MS) {
        fail(
          `a placement pass averages ${p.placeAvgMs.toFixed(2)}ms ` +
          `(budget ${MAX_PLACEMENT_MS}ms)`
        );
      }
      if (!p.placements) fail("zooming from 1x to 2.5x triggered no label placement");
      for (const e of base.errors) console.error(`  error (labels off): ${e}`);
      if (base.errors.length) fail(`${label} labels-off baseline logged page error(s)`);
    }
  }

  /* ---- Phase 2: the predictive grid ---------------------------------- */

  // 2. Predicted vs rendered, all 40 cards.
  console.log(
    `  grid prediction: ${grid.checked} card(s) checked, ${grid.warnings} mismatch(es); ` +
    `worst top ${grid.maxTopDelta}px (tol ${grid.topTolerance}), ` +
    `left ${grid.maxLeftDelta}px, height ${grid.maxHeightDelta}px ` +
    `(tol ${grid.heightTolerance}), tagline line-count changes ${grid.taglineLineMismatches}`
  );
  if (!grid.predicted) fail(`${label} fell back to the measured layout (${grid.reason})`);
  if (grid.checked !== 40) fail(`${label} checked ${grid.checked} cards, expected 40`);
  if (grid.warnings) {
    fail(`${label} had ${grid.warnings} predicted/rendered mismatch(es): ` +
         JSON.stringify(grid.mismatches.slice(0, 3)));
  }

  // 4b. The fitted headline.
  if (!hero) {
    fail(`${label} produced no hero-title fit`);
  } else {
    console.log(
      `  hero headline: ${hero.sizePx}px/${hero.lineHeight}px in ${hero.maxWidth}px ` +
      `of ${hero.available}px → predicted ${hero.predictedLines} line(s), ` +
      `rendered ${hero.renderedLines} (${hero.renderedHeight}px), budget ${hero.maxLines}`
    );
    const want = viewport.heroLines;
    const ok = viewport.name === "desktop"
      ? hero.predictedLines === 2 && hero.renderedLines === 2
      : hero.predictedLines <= want && hero.renderedLines <= want;
    if (!ok) {
      fail(`${label} hero headline is ${hero.predictedLines} predicted / ` +
           `${hero.renderedLines} rendered line(s), wanted ` +
           (viewport.name === "desktop" ? "exactly 2" : `≤ ${want}`));
    }
    if (hero.predictedLines !== hero.renderedLines) {
      fail(`${label} hero headline prediction (${hero.predictedLines}) and ` +
           `rendering (${hero.renderedLines}) disagree`);
    }
  }

  // 1a. Filter change.
  console.log(
    `  filter click: LayoutCount +${filter.layout}, RecalcStyleCount +${filter.recalc}, ` +
    `layout-forcing reads ${filter.reads.total} total / ${filter.reads.app} from app.js ` +
    `(${filter.cards.cards} cards, ${filter.cards.positionWrites} position write(s), ` +
    `${filter.cards.moved} glide(s))`
  );
  if (filter.reads.error) fail(`${label} filter click: ${filter.reads.error}`);
  if (filter.reads.app > 0) {
    fail(`${label} forced ${filter.reads.app} synchronous layout read(s) from app.js ` +
         `during a filter change: ${JSON.stringify(filter.reads.byProp)}\n` +
         filter.reads.appStacks.join("\n"));
  }
  if (filter.layout > LAYOUT_BUDGET) {
    fail(`${label} filter change cost ${filter.layout} layouts (budget ${LAYOUT_BUDGET})`);
  }

  // 3. Scroll anchoring.
  if (!anchor) {
    fail(`${label} found no card/chip pair for the scroll-anchor check`);
  } else {
    console.log(
      `  scroll anchor: ${anchor.id} (hover saw "${anchor.hovered}") moved ` +
      `${anchor.slotMoved}px in the grid, page scrolled ${anchor.scrollApplied}px ` +
      `(wanted ${anchor.scrollWanted}) → on-screen top ${anchor.beforeTop} → ` +
      `${anchor.afterTop} (drift ${anchor.drift}px)`
    );
    if (anchor.hovered !== anchor.id) {
      fail(`${label} hover anchor was "${anchor.hovered}", expected "${anchor.id}"`);
    }
    if (anchor.afterTop === null) fail(`${label} anchored card left the filter`);
    else if (anchor.drift > 1) {
      fail(`${label} hovered card drifted ${anchor.drift}px (budget 1px)`);
    }
    if (anchor.slotMoved === 0) {
      fail(`${label} anchored card did not move in the grid — the check proves nothing`);
    }
  }

  // 1b + 4a. Expansion.
  if (!expand) {
    console.log("  card expansion: skipped (viewport is narrower than 900px — modal path)");
  } else {
    console.log(
      `  card expansion: LayoutCount +${expand.layout}, RecalcStyleCount +${expand.recalc}, ` +
      `layout-forcing reads ${expand.reads.total} total / ${expand.reads.app} from app.js; ` +
      `${expand.cardsWritten} card(s) repositioned, max ${expand.maxWritesPerCard} ` +
      `position write(s) each, ${expand.moved} glide(s)`
    );
    console.log(
      `  expanded agreement: ${expand.openAgreement.checked} card(s), ` +
      `${expand.openAgreement.warnings} mismatch(es), worst top ` +
      `${expand.openAgreement.maxTopDelta}px; after collapse: ` +
      `${expand.collapsed.openBlocks} open block(s), ` +
      `${expand.collapsed.heights} pinned height(s), ` +
      `${expand.collapsed.agreement.warnings} mismatch(es)`
    );
    if (expand.reads.app > 0) {
      fail(`${label} forced ${expand.reads.app} synchronous layout read(s) from app.js ` +
           `while expanding a card: ${JSON.stringify(expand.reads.byProp)}\n` +
           expand.reads.appStacks.join("\n"));
    }
    if (expand.layout > LAYOUT_BUDGET) {
      fail(`${label} card expansion cost ${expand.layout} layouts (budget ${LAYOUT_BUDGET})`);
    }
    if (!expand.expandedId) fail(`${label} clicking a card did not expand it`);
    if (expand.maxWritesPerCard > 1) {
      fail(`${label} a card was repositioned ${expand.maxWritesPerCard} times during one ` +
           `expansion (expected at most once)`);
    }
    if (expand.moved < 1) fail(`${label} expansion moved no neighbours`);
    if (expand.openAgreement.warnings) {
      fail(`${label} expanded grid had ${expand.openAgreement.warnings} mismatch(es): ` +
           JSON.stringify(expand.openAgreement.mismatches.slice(0, 3)));
    }
    if (expand.collapsed.expandedId) fail(`${label} card did not collapse`);
    if (expand.collapsed.openBlocks) {
      fail(`${label} ${expand.collapsed.openBlocks} expansion block(s) stayed visible ` +
           `after collapsing`);
    }
    if (expand.collapsed.heights) {
      fail(`${label} ${expand.collapsed.heights} card(s) kept a pinned height after ` +
           `collapsing`);
    }
    if (expand.collapsed.agreement.warnings) {
      fail(`${label} collapsed grid had ${expand.collapsed.agreement.warnings} mismatch(es)`);
    }
  }

  /* ---- Phase 4, done-when 4: highlighted taglines ------------------- */
  if (!highlight) {
    fail(`${label} ran no search-highlight sweep`);
  } else if (highlight.error) {
    fail(`${label} search highlight: ${highlight.error}`);
  } else {
    for (const row of highlight.queries) {
      console.log(
        `  search "${row.query}": ${row.cards} card(s), ${row.flowed} flowed ` +
        `tagline(s), ${row.boldRuns} bold run(s) over ${row.matches} match(es); ` +
        `line counts ${row.lineMismatches.length ? "DIFFER" : "match"}, ` +
        `${row.tallLines.length} re-wrapped line box(es), ` +
        `${row.overflow.length} overflow(s); agreement ${row.agreementChecked} ` +
        `card(s)/${row.agreementWarnings} mismatch(es) ` +
        `(${row.highlighted} highlighted, ${row.flowMismatches} flow mismatch(es))`
      );
      if (row.lineMismatches.length) {
        fail(`${label} search "${row.query}": ${row.lineMismatches.join("; ")}`);
      }
      if (row.tallLines.length) {
        fail(`${label} search "${row.query}": ${row.tallLines.join("; ")}`);
      }
      if (row.overflow.length) {
        fail(`${label} search "${row.query}" overflowed a card: ${row.overflow.join("; ")}`);
      }
      if (row.agreementWarnings || row.flowMismatches) {
        fail(`${label} search "${row.query}" left the grid with ` +
             `${row.agreementWarnings} mismatch(es)`);
      }
      if (row.plainCopies !== row.flowed) {
        fail(`${label} search "${row.query}": ${row.flowed - row.plainCopies} ` +
             "flowed tagline(s) carry no plain accessible copy");
      }
      if (row.exposedLines) {
        fail(`${label} search "${row.query}": ${row.exposedLines} generated line ` +
             "span(s) are not aria-hidden");
      }
    }
    const flowedTotal = highlight.queries.reduce((n, r) => n + r.flowed, 0);
    if (!flowedTotal) {
      fail(`${label} not one of the ${HIGHLIGHT_QUERIES.length} searches ` +
           "highlighted a single tagline");
    }
    const c = highlight.cleared;
    console.log(
      `  search cleared: ${c.flowed} flow(s) left, ${c.lineSpans} line span(s) left, ` +
      `agreement ${c.agreement.checked} card(s)/${c.agreement.warnings} mismatch(es)`
    );
    if (c.flowed || c.lineSpans) {
      fail(`${label} clearing the search left ${c.flowed} flow(s) and ` +
           `${c.lineSpans} generated line span(s) behind`);
    }
    if (c.agreement.warnings) {
      fail(`${label} the grid disagreed after the search was cleared`);
    }
  }

  for (const e of res.errors) console.error(`  error: ${e}`);
  if (res.errors.length) fail(`${label} logged ${res.errors.length} console/page error(s)`);
}

function reportDialog(label, res, viewport, fail, expectedPlaces) {
  const { sweep, flags, interaction } = res;
  const lines = sweep.lineCounts;
  const minLines = lines.length ? Math.min(...lines) : 0;
  const maxLines = lines.length ? Math.max(...lines) : 0;

  console.log(
    `${label.padEnd(22)} ${sweep.opened} place(s) opened, ` +
    `${sweep.twoCol ? 2 : 1} column(s) of ${Math.round(sweep.colWidth)}px in ` +
    `${sweep.innerWidth}px, ${sweep.justified ? "justified" : "ragged"}, ` +
    `${minLines}-${maxLines} line(s)/story, ${sweep.dropCaps} drop cap(s), ` +
    `${sweep.pullQuotes} pull quote(s) (${sweep.fullBleed} full-bleed), ` +
    `${sweep.hyphenated} soft-hyphen break(s), ` +
    `open() max ${fmt(sweep.maxOpenMs)}ms`
  );

  if (sweep.opened !== expectedPlaces) {
    fail(`${label} opened ${sweep.opened} place(s), expected ${expectedPlaces}`);
  }
  if (!flags.editorial) fail(`${label} did not run the editorial renderer`);
  if (sweep.dropCaps !== sweep.opened) {
    fail(`${label} rendered a drop cap for only ${sweep.dropCaps} of ${sweep.opened}`);
  }
  if (sweep.pullQuotes !== sweep.opened) {
    fail(`${label} rendered a pull quote for only ${sweep.pullQuotes} of ${sweep.opened}`);
  }
  if (sweep.maxOpenMs > MAX_OPEN_MS) {
    fail(`${label} one open() took ${fmt(sweep.maxOpenMs)}ms (budget ${MAX_OPEN_MS}ms)`);
  }

  // ---- Done-when 1: nothing overflows ---------------------------------
  console.log(
    `  spread fit: ${sweep.modelOutside.length} line(s) outside a column in the ` +
    `model, ${sweep.paintedOutside.length} painted outside, ` +
    `${sweep.overflowLines.length} over-set line(s), ` +
    `${sweep.scroll.length} horizontal scroll(s)`
  );
  for (const bad of sweep.modelOutside.slice(0, 4)) console.error(`      model: ${bad}`);
  for (const bad of sweep.paintedOutside.slice(0, 4)) console.error(`      painted: ${bad}`);
  for (const bad of sweep.scroll.slice(0, 4)) console.error(`      scroll: ${bad}`);
  if (sweep.modelOutside.length) {
    fail(`${label} laid ${sweep.modelOutside.length} line(s) outside their column`);
  }
  if (sweep.paintedOutside.length) {
    fail(`${label} painted ${sweep.paintedOutside.length} line(s) outside their column`);
  }
  if (sweep.overflowLines.length) {
    fail(`${label} produced ${sweep.overflowLines.length} over-set line(s)`);
  }
  if (sweep.scroll.length) {
    fail(`${label} scrolls horizontally in ${sweep.scroll.length} case(s)`);
  }

  // ---- Done-when 2: rivers --------------------------------------------
  const w = sweep.worstRiver;
  if (viewport.twoCol) {
    console.log(
      `  rivers: worst run ${w ? w.run : 0} line(s)` +
      (w && w.startRow != null
        ? ` ("${w.id}", column ${w.col}, rows ${w.startRow}-${w.endRow}, ` +
          `gap ${w.gapRatio}x normal, column ${Math.round(w.colWidth)}px)` : "") +
      `; ${sweep.riverTotal} river(s) over ${sweep.riverPlaces} story(ies); ` +
      `width trials ${JSON.stringify(sweep.trials.map((t) => [t.width, t.maxRun]))}`
    );
    if (!sweep.justified) fail(`${label} did not justify the columns`);
    if (w && w.run > MAX_RIVER_RUN) {
      fail(`${label} has a river ${w.run} lines long in "${w.id}" ` +
           `(budget ${MAX_RIVER_RUN})`);
    }
  } else {
    console.log(`  rivers: n/a (ragged right below the ${900}px two-column breakpoint)`);
    if (sweep.justified) fail(`${label} justified a single ragged column`);
  }

  // ---- Phase 4: the second name under the title -----------------------
  const nat = sweep.native;
  console.log(
    `  native names: ${nat.shown} of ${nat.expected} shown under the title (` +
    Object.keys(nat.dirs).sort().map((d) => `${nat.dirs[d]} ${d}`).join(", ") +
    `), ${nat.wrong.length} with the wrong text/lang/dir`
  );
  if (nat.shown !== nat.expected) {
    fail(`${label} showed ${nat.shown} of ${nat.expected} native names in the dialog`);
  }
  if (nat.wrong.length) {
    fail(`${label} native name text/lang/dir is wrong for: ` +
         nat.wrong.slice(0, 3).join(", "));
  }

  // ---- Done-when 4: accessibility -------------------------------------
  const a = sweep.a11y;
  console.log(
    `  a11y: ${sweep.opened - a.storyMismatch.length}/${sweep.opened} hidden story ` +
    `paragraph(s) carry the full text, ${a.hiddenStory} of them visually hidden ` +
    `(not display:none), ${sweep.opened - a.factMismatch.length}/${sweep.opened} ` +
    `field note(s) intact, ${a.exposedLines} laid-out line(s) not aria-hidden, ` +
    `accessible name via #${sweep.accessibleName.labelledBy} = ` +
    `"${sweep.accessibleName.text}"`
  );
  if (a.storyMismatch.length) {
    fail(`${label} lost the story text for: ${a.storyMismatch.slice(0, 3).join(", ")}`);
  }
  if (a.factMismatch.length) {
    fail(`${label} lost the field-note text for: ${a.factMismatch.slice(0, 3).join(", ")}`);
  }
  if (a.nameMismatch.length) {
    fail(`${label} title text differs from the place name for: ` +
         a.nameMismatch.slice(0, 3).join(", "));
  }
  if (a.exposedLines) {
    fail(`${label} left ${a.exposedLines} laid-out line span(s) exposed to ` +
         `assistive technology`);
  }
  if (a.hiddenStory !== sweep.opened) {
    fail(`${label} only ${a.hiddenStory} of ${sweep.opened} story paragraph(s) were ` +
         `visually hidden without display:none`);
  }
  if (sweep.accessibleName.labelledBy !== "dialog-title") {
    fail(`${label} dialog is no longer labelled by #dialog-title`);
  }
  if (!sweep.closedAfterSweep) fail(`${label} dialog stayed open after close()`);

  // ---- F: the chips ----------------------------------------------------
  console.log(
    `  metadata: ${sweep.chipCounts.chips} chip(s) across ` +
    `${sweep.chipCounts.fields} field flow(s) (${sweep.chipCounts.plain} with no chip)`
  );
  if (!sweep.chipCounts.chips) fail(`${label} produced no metadata chips`);

  // ---- Done-when 3: the animated step ----------------------------------
  if (interaction) {
    if (!interaction.pair) {
      fail(`${label} found no neighbouring places with different body heights`);
    } else {
      const st = interaction.step;
      console.log(
        `  step (ArrowRight ${interaction.pair.from} -> ${interaction.pair.to}): ` +
        `body height ${fmt(st.from)}px -> ${st.mid == null ? "—" : fmt(st.mid)}px ` +
        `mid-flight -> ${fmt(st.to)}px, ${st.distinct} distinct height(s) over ` +
        `${st.samples} frame(s); Escape closed it: ${interaction.closed}; ` +
        `#/place/${interaction.routeId} opened "${interaction.routed.id}"`
      );
      if (st.landedOn !== st.expected) {
        fail(`${label} ArrowRight landed on "${st.landedOn}", expected "${st.expected}"`);
      }
      if (Math.abs(st.from - st.to) < 1) {
        fail(`${label} the dialog body did not change height across a step`);
      }
      if (st.mid == null) {
        fail(`${label} the dialog body snapped from ${fmt(st.from)}px to ` +
             `${fmt(st.to)}px without an intermediate height`);
      }
      if (st.distinct < 3) {
        fail(`${label} the step animation only produced ${st.distinct} height(s)`);
      }
      if (!interaction.closed) fail(`${label} Escape no longer closes the dialog`);
      if (!interaction.routed.open || interaction.routed.id !== interaction.routeId) {
        fail(`${label} #/place/${interaction.routeId} did not open that place`);
      }
      if (!interaction.closedByRoute) {
        fail(`${label} leaving the place route did not close the dialog`);
      }
    }
  }

  for (const e of res.errors) console.error(`  error: ${e}`);
  if (res.errors.length) fail(`${label} logged ${res.errors.length} console/page error(s)`);
}

async function main() {
  const { browser, reason } = await launchChromium();
  if (!browser) {
    console.error(`\nerror: ${reason}`);
    console.error(`  install the browser with: ${INSTALL_HINT}`);
    process.exit(1);
  }

  let server;
  let failed = false;
  const fail = (msg) => { console.error(`  error: ${msg}`); failed = true; };
  try {
    server = await startServer();
    for (const viewport of VIEWPORTS) {
      const res = await visit(browser, server.origin, viewport);
      // Baseline for the frame timing: the same zoom with the labels off.
      if (res.map) {
        res.base = await visit(browser, server.origin, viewport, {
          query: "?noflags=labels,oceanLabels", perfOnly: true
        });
      }
      reportViewport(`${viewport.name} ${viewport.width}x${viewport.height}`, res, viewport, fail);
    }

    /* ---- Phase 3: the editorial dialog ------------------------------- */
    for (const viewport of DIALOG_VIEWPORTS) {
      const res = await visitDialog(browser, server.origin, viewport);
      reportDialog(`dialog ${viewport.width}x${viewport.height}`, res, viewport, fail, 40);
    }
  } catch (err) {
    console.error(`\nerror: ${err.stack || err.message}`);
    failed = true;
  } finally {
    if (server) await server.stop();
    await browser.close();
  }

  if (failed) {
    console.error("\nsmoke FAILED");
    process.exit(1);
  }
  console.log("\nsmoke OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
