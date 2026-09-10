/* Atlas of the Curious — Phase 6 ("ways to read") smoke checks.

   Kept out of scripts/smoke.mjs so that file stays the roadmap's index: it
   imports `runReaderChecks` and calls it once. Everything here opens its own
   page visits, prints its own lines and reports failures through the `fail`
   callback smoke.mjs owns.

   What it proves:

     1. The page count is right at every window height. At 1280x600, 800, 1000
        and 1200, at 390x844, and at a deliberately cramped 1280x380 (small
        enough that a story has to run across a page boundary), the reader is
        opened and EVERY page is walked with goTo(). For each page: the page
        box does not overflow (`scrollHeight <= clientHeight`) and every line
        box inside it sits within it. For each place: the lines of its story,
        concatenated across its pages, are its story exactly — checked twice,
        once on the text and once on the line indices, which is what makes
        "nothing lost, nothing duplicated" a countable claim; and no paragraph
        that spans a page boundary leaves fewer than two lines on either side
        of it.
     2. Printing matches the screen. `emulateMedia({ media: "print" })` must
        make the reader render ALL pages, each with `break-after: page`, with
        the same page height and the same per-page line assignment as on
        screen — compared field by field against the screen's `perPage`.
     3. The notebook. Typing into it must set the textarea's height to the
        predicted height (and leave the box unscrolled), must force no layout
        read from js/dialog.js or js/reader.js (the read-counter pattern from
        smoke.mjs, attributed to those two files), and must keep the note out
        of the URL, out of every request the page makes and out of the share
        link. A reload restores it. The generated places/<id>/index.html is
        read off disk and must not contain it either.
     4. "Copy as postcard" puts exactly the expected text on the clipboard,
        read back through navigator.clipboard.readText().
     5. The daily card at 390px sets its name on at most two lines — for the
        name the day actually picked, and for all 40 it could have picked.

   Run through: pnpm smoke */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

const fmt = (n) => Math.round(n * 100) / 100;

// The same benign-advisory list smoke.mjs keeps: frame-ancestors is only
// settable as an HTTP header, and the site is served as static files.
const BENIGN = [/frame-ancestors.*is ignored when delivered via a <meta> element/i];
const isBenign = (text) => BENIGN.some((re) => re.test(text));

const settleFrames = (page, n = 2) =>
  page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

/* ---------------------------------------------------------------------- *
 * Thresholds                                                             *
 * ---------------------------------------------------------------------- */

// The window heights done-when 1 names, plus the phone, plus one page short
// enough that stories actually have to be carried over.
const READER_VIEWPORTS = [
  { name: "reader 1280x600", width: 1280, height: 600 },
  { name: "reader 1280x800", width: 1280, height: 800 },
  { name: "reader 1280x1000", width: 1280, height: 1000 },
  { name: "reader 1280x1200", width: 1280, height: 1200 },
  { name: "reader 390x844", width: 390, height: 844 },
  { name: "reader 1280x380", width: 1280, height: 380, cramped: true }
];

// Sub-pixel slack between the model and what Chromium painted.
const BOX_EPS = 1;
// The textarea's height is written from the prediction, so they must agree to
// the rounding the writer does.
const NOTE_EPS = 0.5;
// A keystroke costs the browser its own text-input layout. Anything much
// above one layout + one style recalc per character means the page forced one.
const LAYOUT_PER_KEY = 2;
const LAYOUT_SLACK = 8;
// The daily card's name, on a phone.
const MAX_DAILY_NAME_LINES = 2;

// Seeded into localStorage before the pagination sweep so the reader's
// note path (pre-wrap lines, hard breaks, tabs) is exercised too.
const SEEDED_NOTES = {
  "salar-de-uyuni":
    "Arrived at dawn.\n\tThe salt was still wet.\n\n" +
    "A long paragraph now, so the note runs past the foot of a page and the " +
    "reader has to carry it over: the horizon vanished entirely and the sky " +
    "was underfoot, which is the sort of thing you only believe once you " +
    "have stood in it and looked down at a cloud.",
  "ha-long-bay": "Fog, then karst, then more fog.\nCame back twice."
};

const NOTE_TEXT =
  "Salt crust like broken tiles.\n\tWind from the south all afternoon, and the " +
  "horizon simply gone — no line at all between the water and the sky.";

/* ---------------------------------------------------------------------- *
 * In-page instrumentation                                                *
 * ---------------------------------------------------------------------- */

// The read-counter pattern from smoke.mjs, attributed to the two files this
// phase owns: while `window.__ATLAS_NOTE_READS.on` is true, every getter or
// method that can force a synchronous layout is counted, and the call's stack
// decides whether js/dialog.js or js/reader.js asked for it.
function installNoteReadCounter() {
  const state = { on: false, total: 0, mine: 0, byProp: {}, stacks: [] };
  window.__ATLAS_NOTE_READS = state;
  state.reset = () => {
    state.total = 0; state.mine = 0; state.byProp = {}; state.stacks = [];
  };
  const MINE = ["/js/dialog.js", "/js/reader.js"];
  const note = (prop) => {
    state.total++;
    state.byProp[prop] = (state.byProp[prop] || 0) + 1;
    const stack = new Error().stack || "";
    if (MINE.some((f) => stack.indexOf(f) !== -1)) {
      state.mine++;
      if (state.stacks.length < 5) state.stacks.push(prop + " <- " + stack);
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

async function readMetrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const by = Object.create(null);
  for (const m of metrics) by[m.name] = m.value;
  return { layout: by.LayoutCount || 0, recalc: by.RecalcStyleCount || 0 };
}

/* ---------------------------------------------------------------------- *
 * Done-when 1: every page, at every height                               *
 * ---------------------------------------------------------------------- */

// Runs entirely inside the page: open the reader, walk every page with
// goTo(), and judge each one against both the layout model and the boxes
// Chromium actually painted. One evaluate, no per-page round trip.
function paginationSweep(eps) {
  const R = window.ATLAS_READER;
  const places = new Map(window.ATLAS_DATA.places.map((p) => [p.id, p]));
  const out = {
    pages: 0, walked: 0, pageHeight: 0, contentHeight: 0, measure: 0, rows: 0,
    lineHeight: 0, placesCovered: 0, multiPagePlaces: 0, storySplits: 0,
    maxFill: 0, minFill: 1, worstFill: null, renderedMax: 0,
    overflowPages: [], scrollPages: [], outsideLines: [], wrongPage: [],
    roundTrip: [], indexGaps: [], widows: [], notePlaces: 0, error: null
  };

  const first = window.ATLAS_DATA.places[0].id;
  R.open(first);
  const d0 = R.debug();
  if (!d0.open) { out.error = "the reader did not open"; return out; }

  out.pages = d0.pages;
  out.pageHeight = d0.pageHeight;
  out.contentHeight = d0.contentHeight;
  out.measure = d0.measure;
  out.rows = d0.rows;
  out.lineHeight = d0.lineHeight;

  // --- (a) walk every page and judge the painted boxes ------------------
  for (let n = 1; n <= d0.pages; n++) {
    R.goTo(n);
    out.walked++;
    const el = document.querySelector(".reader-page.is-current");
    if (!el) { out.wrongPage.push(n + " has no current page element"); continue; }
    if (el.getAttribute("data-page") !== String(n)) {
      out.wrongPage.push(n + " rendered page " + el.getAttribute("data-page"));
    }
    const d = R.debug();
    if (d.currentPage !== n) out.wrongPage.push(n + " debug says " + d.currentPage);
    if (d.rendered.length > out.renderedMax) out.renderedMax = d.rendered.length;

    if (el.scrollHeight > el.clientHeight + eps) {
      out.scrollPages.push(n + " " + el.scrollHeight + " > " + el.clientHeight);
    }
    const box = el.getBoundingClientRect();
    const lines = el.querySelectorAll(".reader-page-body > span");
    for (const span of lines) {
      const b = span.getBoundingClientRect();
      if (b.top < box.top - eps || b.bottom > box.bottom + eps ||
          b.left < box.left - eps || b.right > box.right + eps) {
        out.outsideLines.push(
          "page " + n + " " + span.className + " [" +
          fmtN(b.top - box.top) + "," + fmtN(b.bottom - box.bottom) + "," +
          fmtN(b.left - box.left) + "," + fmtN(b.right - box.right) + "] " +
          JSON.stringify(span.textContent.slice(0, 24))
        );
      }
    }
  }

  // --- (b) the model: what is on which page -----------------------------
  const d = R.debug();
  if (d.perPage.length !== d.pages) {
    out.wrongPage.push("perPage has " + d.perPage.length + " of " + d.pages);
  }
  const byPlace = new Map();
  for (const page of d.perPage) {
    if (page.overflow) out.overflowPages.push(String(page.page));
    const fill = d.contentHeight > 0 ? page.used / d.contentHeight : 0;
    if (fill > out.maxFill) { out.maxFill = fill; out.worstFill = page.page; }
    if (fill < out.minFill) out.minFill = fill;
    let rec = byPlace.get(page.placeId);
    if (!rec) {
      rec = { pages: [], kindLines: {}, indices: [] };
      byPlace.set(page.placeId, rec);
    }
    rec.pages.push(page);
    for (const line of page.lines) {
      (rec.kindLines[line.kind] = rec.kindLines[line.kind] || []).push(line.text);
      rec.indices.push(line.index);
    }
  }
  out.placesCovered = byPlace.size;

  /* Whitespace is stripped from BOTH sides before the comparison, because a
     line broken after a real hyphen ("flash-" / "melt") carries no space to
     rejoin on while a line broken at a space does — so no single join string
     reconstructs both. Stripping it makes the claim exactly the one that
     matters: the same characters, in the same order, once each. A lost or a
     duplicated line changes that sequence; the line-index run below then says
     which line it was. */
  const bare = (s) => String(s).replace(/\s+/g, "");

  for (const [id, rec] of byPlace.entries()) {
    const place = places.get(id);
    if (rec.pages.length > 1) out.multiPagePlaces++;

    // The lines, concatenated, are the text — for the story exactly (word for
    // word), for a pre-wrap note ignoring where the wraps fell.
    const story = (rec.kindLines.story || []).join("");
    if (bare(story) !== bare(place.story)) {
      out.roundTrip.push(id + " story: " + bare(story).length +
                         " chars vs " + bare(place.story).length);
    }
    const fact = (rec.kindLines.fact || []).join("");
    if (place.fact && bare(fact) !== bare(place.fact)) {
      out.roundTrip.push(id + " field note: " + bare(fact).length +
                         " chars vs " + bare(place.fact).length);
    }
    const seeded = window.__ATLAS_SEEDED_NOTES && window.__ATLAS_SEEDED_NOTES[id];
    if (seeded) {
      out.notePlaces++;
      const note = (rec.kindLines.note || []).join("");
      if (bare(note) !== bare(seeded)) {
        out.roundTrip.push(id + " note: " + bare(note).length +
                           " chars vs " + bare(seeded).length);
      }
    }

    // Nothing lost and nothing duplicated, counted rather than compared: the
    // body-line indices this place's pages carry must be 0, 1, 2, … exactly.
    for (let i = 0; i < rec.indices.length; i++) {
      if (rec.indices[i] !== i) {
        out.indexGaps.push(id + " line " + i + " is index " + rec.indices[i]);
        break;
      }
    }
    const expected = d.bodyLines[id];
    if (expected != null && rec.indices.length !== expected) {
      out.indexGaps.push(id + " carries " + rec.indices.length + " of " + expected + " lines");
    }

    // Widows and orphans: a paragraph that runs over a page boundary leaves
    // at least two of its lines on each side of it.
    const kinds = {};
    for (const page of rec.pages) {
      for (const kind of Object.keys(page.kinds)) {
        (kinds[kind] = kinds[kind] || []).push(page.kinds[kind]);
      }
    }
    for (const kind of Object.keys(kinds)) {
      const runs = kinds[kind];
      if (runs.length < 2) continue;
      if (kind === "story") out.storySplits++;
      const total = runs.reduce((a, b) => a + b, 0);
      if (total < 2) continue;
      for (let i = 0; i < runs.length; i++) {
        if (runs[i] < 2) {
          out.widows.push(id + " " + kind + " leaves " + runs[i] +
                          " line(s) on page " + rec.pages[i].page +
                          " of [" + runs.join(",") + "]");
        }
      }
    }
  }

  R.close();
  out.closed = !R.isOpen();
  return out;

  function fmtN(n) { return Math.round(n * 100) / 100; }
}

async function visitPagination(browser, origin, viewport) {
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
    await page.waitForFunction(() => window.ATLAS_READER_READY === true, null, { timeout: 15000 });
    await page.evaluate((notes) => {
      window.__ATLAS_SEEDED_NOTES = notes;
      for (const id of Object.keys(notes)) {
        try { localStorage.setItem("atlas:note:" + id, notes[id]); } catch (e) { /* no store */ }
      }
    }, SEEDED_NOTES);
    await settleFrames(page, 2);
    const sweep = await page.evaluate(paginationSweep, BOX_EPS);
    return { sweep, errors };
  } finally {
    await context.close();
  }
}

function reportPagination(label, res, fail) {
  const s = res.sweep;
  if (s.error) { fail(`${label} ${s.error}`); return; }

  console.log(
    `${label.padEnd(18)} ${s.pages} page(s) for ${s.placesCovered} place(s), ` +
    `page ${fmt(s.pageHeight)}px = ${s.rows} line(s) of ${fmt(s.lineHeight)}px + chrome, ` +
    `measure ${s.measure}px, ${s.multiPagePlaces} place(s) over more than one page ` +
    `(${s.storySplits} story split), worst fill ${Math.round(s.maxFill * 100)}% ` +
    `(page ${s.worstFill}), at most ${s.renderedMax} page(s) in the DOM`
  );

  if (s.walked !== s.pages) fail(`${label} walked ${s.walked} of ${s.pages} page(s)`);
  if (!s.pages) fail(`${label} paginated nothing`);
  if (s.placesCovered !== 40) {
    fail(`${label} covered ${s.placesCovered} place(s), expected 40`);
  }
  if (s.renderedMax > 3) {
    fail(`${label} kept ${s.renderedMax} pages in the DOM at once (budget 3)`);
  }
  if (s.notePlaces !== Object.keys(SEEDED_NOTES).length) {
    fail(`${label} showed ${s.notePlaces} of ${Object.keys(SEEDED_NOTES).length} saved note(s)`);
  }

  for (const bad of s.wrongPage.slice(0, 4)) console.error(`      page: ${bad}`);
  for (const bad of s.overflowPages.slice(0, 4)) console.error(`      overflow: page ${bad}`);
  for (const bad of s.scrollPages.slice(0, 4)) console.error(`      scrolls: ${bad}`);
  for (const bad of s.outsideLines.slice(0, 4)) console.error(`      outside: ${bad}`);
  for (const bad of s.roundTrip.slice(0, 4)) console.error(`      round trip: ${bad}`);
  for (const bad of s.indexGaps.slice(0, 4)) console.error(`      lines: ${bad}`);
  for (const bad of s.widows.slice(0, 4)) console.error(`      widow: ${bad}`);

  if (s.wrongPage.length) fail(`${label} showed the wrong page ${s.wrongPage.length} time(s)`);
  if (s.overflowPages.length) fail(`${label} over-filled ${s.overflowPages.length} page(s)`);
  if (s.scrollPages.length) fail(`${label} ${s.scrollPages.length} page(s) scroll`);
  if (s.outsideLines.length) {
    fail(`${label} painted ${s.outsideLines.length} line(s) outside their page`);
  }
  if (s.roundTrip.length) {
    fail(`${label} ${s.roundTrip.length} text(s) did not survive pagination`);
  }
  if (s.indexGaps.length) fail(`${label} lost or duplicated lines (${s.indexGaps.length})`);
  if (s.widows.length) fail(`${label} left ${s.widows.length} widow/orphan line(s)`);
  if (!s.closed) fail(`${label} did not close`);
  for (const e of res.errors) console.error(`  error: ${e}`);
  if (res.errors.length) fail(`${label} logged ${res.errors.length} console/page error(s)`);
}

/* ---------------------------------------------------------------------- *
 * Done-when 2: printing matches the screen                               *
 * ---------------------------------------------------------------------- */

const assignment = (perPage) => perPage.map((p) => ({
  placeId: p.placeId, page: p.page, firstLine: p.firstLine,
  lastLine: p.lastLine, lineCount: p.lineCount
}));

async function visitPrint(browser, origin) {
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    const text = m.text();
    if (!isBenign(text) && m.type() === "error") errors.push(text);
  });
  page.on("pageerror", (e) => errors.push(`uncaught: ${e && e.message ? e.message : e}`));
  try {
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.ATLAS_READER_READY === true, null, { timeout: 15000 });
    await settleFrames(page, 2);

    const screen = await page.evaluate(() => {
      const R = window.ATLAS_READER;
      R.open(window.ATLAS_DATA.places[0].id);
      R.goTo(3);
      const d = R.debug();
      return {
        pages: d.pages, pageHeight: d.pageHeight, current: d.currentPage,
        rendered: d.rendered.length, printMode: d.printMode,
        perPage: d.perPage.map((p) => ({
          placeId: p.placeId, page: p.page, firstLine: p.firstLine,
          lastLine: p.lastLine, lineCount: p.lineCount
        })),
        inDom: document.querySelectorAll(".reader-page").length
      };
    });

    // No beforeprint is dispatched by hand: emulating print media is what a
    // real print preview does, and the reader listens for that change.
    await page.emulateMedia({ media: "print" });
    await settleFrames(page, 2);
    const printed = await page.evaluate(() => {
      const d = window.ATLAS_READER.debug();
      const els = Array.from(document.querySelectorAll(".reader-page"));
      const styles = els.map((el) => {
        const cs = getComputedStyle(el);
        return { breakAfter: cs.breakAfter, display: cs.display, height: cs.height };
      });
      return {
        printMode: d.printMode, pages: d.pages, pageHeight: d.pageHeight,
        rendered: d.rendered.length, inDom: els.length,
        matches: window.matchMedia("print").matches,
        notPaged: styles.filter((s) => s.breakAfter !== "page").length,
        notShown: styles.filter((s) => s.display === "none").length,
        heights: Array.from(new Set(styles.map((s) => s.height))),
        perPage: d.perPage.map((p) => ({
          placeId: p.placeId, page: p.page, firstLine: p.firstLine,
          lastLine: p.lastLine, lineCount: p.lineCount
        }))
      };
    });

    await page.emulateMedia({ media: null });
    await settleFrames(page, 2);
    const back = await page.evaluate(() => {
      const d = window.ATLAS_READER.debug();
      return {
        printMode: d.printMode, rendered: d.rendered.length,
        inDom: document.querySelectorAll(".reader-page").length,
        current: d.currentPage
      };
    });
    return { screen, printed, back, errors };
  } finally {
    await context.close();
  }
}

function reportPrint(res, fail) {
  const { screen, printed, back } = res;
  const same = JSON.stringify(screen.perPage) === JSON.stringify(printed.perPage);
  console.log(
    `print                 ${printed.inDom} of ${printed.pages} page(s) rendered ` +
    `(screen kept ${screen.inDom}), break-after: page on ` +
    `${printed.inDom - printed.notPaged}/${printed.inDom}, page height ` +
    `${fmt(printed.pageHeight)}px (screen ${fmt(screen.pageHeight)}px), ` +
    `line assignment ${same ? "identical" : "DIFFERENT"}, back to ${back.inDom} after`
  );

  if (!printed.matches) fail("print media did not match after emulateMedia");
  if (!printed.printMode) fail("the reader did not switch into print mode");
  if (printed.inDom !== printed.pages) {
    fail(`print rendered ${printed.inDom} of ${printed.pages} page(s)`);
  }
  if (printed.rendered !== printed.pages) {
    fail(`print reported ${printed.rendered} of ${printed.pages} page(s) rendered`);
  }
  if (printed.notPaged) {
    fail(`print left ${printed.notPaged} page(s) without break-after: page`);
  }
  if (printed.notShown) fail(`print hid ${printed.notShown} page(s)`);
  if (printed.heights.length !== 1) {
    fail(`print produced ${printed.heights.length} different page heights: ${printed.heights.join(", ")}`);
  }
  if (fmt(printed.pageHeight) !== fmt(screen.pageHeight)) {
    fail(`print page height ${fmt(printed.pageHeight)} != screen ${fmt(screen.pageHeight)}`);
  }
  if (!same) fail("print assigned lines to pages differently from the screen");
  if (back.printMode) fail("the reader stayed in print mode after the media query cleared");
  if (back.inDom > 3) fail(`the reader kept ${back.inDom} page(s) after printing`);
  if (back.current !== screen.current) {
    fail(`printing moved the reader from page ${screen.current} to ${back.current}`);
  }
  for (const e of res.errors) console.error(`  error: ${e}`);
  if (res.errors.length) fail(`print logged ${res.errors.length} console/page error(s)`);
}

/* ---------------------------------------------------------------------- *
 * Done-when 3 and 4: the notebook and the postcard                       *
 * ---------------------------------------------------------------------- */

async function visitNotebook(browser, origin) {
  const errors = [];
  const requests = [];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"]
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    const text = m.text();
    if (!isBenign(text) && m.type() === "error") errors.push(text);
  });
  page.on("pageerror", (e) => errors.push(`uncaught: ${e && e.message ? e.message : e}`));

  const id = "salar-de-uyuni";
  try {
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.ATLAS_DIALOG_READY === true, null, { timeout: 15000 });
    await page.waitForSelector(".map-stage .map-marker", { timeout: 15000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* no store */ } });

    // The Text Atlas pauses its animation loop when it scrolls out of view, so
    // the layout counters below measure the typing and not the sea.
    await page.evaluate(() => {
      document.getElementById("grid").scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.waitForTimeout(700);
    await page.evaluate(installNoteReadCounter);
    await settleFrames(page, 2);

    await page.evaluate((placeId) => { window.ATLAS_DIALOG.open(placeId); }, id);
    await settleFrames(page, 2);
    const present = await page.evaluate(() => !!document.getElementById("notebook-input"));
    if (!present) return { missing: true, errors };

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");

    // Every request the page makes while the note is being typed.
    const onRequest = (r) => requests.push({ url: r.url(), post: r.postData() || "" });
    page.on("request", onRequest);

    await page.click("#notebook-input");
    const before = await readMetrics(cdp);
    await page.evaluate(() => {
      window.__ATLAS_NOTE_READS.reset();
      window.__ATLAS_NOTE_READS.on = true;
    });
    await page.type("#notebook-input", NOTE_TEXT, { delay: 4 });
    const after = await readMetrics(cdp);
    const reads = await page.evaluate(() => {
      const s = window.__ATLAS_NOTE_READS;
      s.on = false;
      return { total: s.total, mine: s.mine, byProp: s.byProp, stacks: s.stacks };
    });
    page.off("request", onRequest);
    await cdp.detach();

    // The box: what was predicted, what the browser gave it, whether it fits.
    await page.waitForTimeout(500);   // let the debounced save land
    const box = await page.evaluate(() => {
      const el = document.getElementById("notebook-input");
      const d = window.ATLAS_DIALOG.debug().notebook;
      const rect = el.getBoundingClientRect();
      return {
        predicted: d.predictedHeight, applied: d.appliedHeight,
        rect: rect.height, scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight, clientWidth: el.clientWidth,
        measure: d.width, lines: d.lines, rows: d.rows, chrome: d.chrome,
        lineHeight: d.lineHeight, value: d.value, stored: d.stored,
        saved: d.saved, postcard: d.postcard,
        bodyScroll: (function () {
          const b = document.querySelector("#place-dialog .dialog-body");
          return { w: b.scrollWidth, cw: b.clientWidth };
        })()
      };
    });

    // The note is nowhere near the URL.
    const href = page.url();
    const hash = await page.evaluate(() => location.hash);

    // …nor in the share link the "Copy link" button copies.
    // A real click, not el.click(): a synthesised click reports clientX/clientY
    // of 0, which js/app.js's backdrop handler reads as a click outside the
    // dialog and closes it.
    await page.click("#dialog-share");
    await page.waitForTimeout(400);
    const shareLink = await page.evaluate(() => navigator.clipboard.readText());

    // Done-when 4: the postcard, read back off the real clipboard.
    const expectedPostcard = await page.evaluate((placeId) => {
      const p = window.ATLAS_DATA.places.find((x) => x.id === placeId);
      const note = document.getElementById("notebook-input").value;
      const out = [p.name];
      if (p.nativeName && p.nativeName !== p.name) out.push(p.nativeName);
      out.push(p.country);
      out.push(p.coordinates);
      out.push("");
      out.push(note.replace(/\s+$/, ""));
      out.push("");
      out.push("— Atlas of the Curious");
      return out.join("\n");
    }, id);
    await page.click("#notebook-postcard");
    await page.waitForTimeout(400);
    const postcard = await page.evaluate(() => navigator.clipboard.readText());

    // A reload must bring the note back.
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.ATLAS_DIALOG_READY === true, null, { timeout: 15000 });
    await settleFrames(page, 2);
    const restored = await page.evaluate((placeId) => {
      window.ATLAS_DIALOG.open(placeId);
      const d = window.ATLAS_DIALOG.debug().notebook;
      const el = document.getElementById("notebook-input");
      return {
        value: el.value, predicted: d.predictedHeight,
        rect: el.getBoundingClientRect().height,
        scrollHeight: el.scrollHeight, clientHeight: el.clientHeight
      };
    }, id);

    // And the reader must show it at the end of that place's pages.
    const inReader = await page.evaluate((placeId) => {
      const R = window.ATLAS_READER;
      R.open(placeId);
      const d = R.debug();
      const lines = d.perPage.filter((p) => p.placeId === placeId)
        .flatMap((p) => p.lines.filter((l) => l.kind === "note").map((l) => l.text));
      R.close();
      return { lines: lines, joined: lines.join("") };
    }, id);

    // The "Clear" button.
    await page.evaluate((placeId) => { window.ATLAS_DIALOG.open(placeId); }, id);
    await settleFrames(page, 2);
    await page.click("#notebook-clear");
    await page.waitForTimeout(200);
    const cleared = await page.evaluate((placeId) => ({
      value: document.getElementById("notebook-input").value,
      stored: (function () {
        try { return localStorage.getItem("atlas:note:" + placeId); }
        catch (e) { return "?"; }
      })(),
      height: window.ATLAS_DIALOG.debug().notebook.predictedHeight,
      rows: window.ATLAS_DIALOG.debug().notebook.rows
    }), id);

    return {
      id, box, reads, requests, href, hash, shareLink, postcard,
      expectedPostcard, restored, inReader, cleared, errors,
      keys: NOTE_TEXT.length,
      layout: after.layout - before.layout,
      recalc: after.recalc - before.recalc
    };
  } finally {
    await context.close();
  }
}

async function reportNotebook(res, fail) {
  if (res.missing) { fail("the notebook did not render in the dialog"); return; }
  const b = res.box;
  const perKey = res.keys ? res.layout / res.keys : 0;

  console.log(
    `notebook              ${b.lines} wrapped line(s) in a ${b.rows}-row box at ` +
    `${fmt(b.measure)}px: predicted ${fmt(b.predicted)}px, painted ${fmt(b.rect)}px, ` +
    `content ${b.scrollHeight}px in ${b.clientHeight}px`
  );
  console.log(
    `  typing ${res.keys} character(s): LayoutCount +${res.layout} ` +
    `(${fmt(perKey)}/key), RecalcStyleCount +${res.recalc}, ` +
    `${res.reads.total} layout-forcing read(s) in the page, ` +
    `${res.reads.mine} from js/dialog.js or js/reader.js`
  );

  if (Math.abs(b.rect - b.predicted) > NOTE_EPS) {
    fail(`the notebook is ${fmt(b.rect)}px but was predicted ${fmt(b.predicted)}px`);
  }
  if (Math.abs(b.applied - b.predicted) > NOTE_EPS) {
    fail(`the notebook wrote ${fmt(b.applied)}px for a prediction of ${fmt(b.predicted)}px`);
  }
  if (b.scrollHeight > b.clientHeight + 1) {
    fail(`the notebook's text overflows its box (${b.scrollHeight} > ${b.clientHeight})`);
  }
  if (b.clientWidth - b.measure !== 24) {
    fail(`the notebook measured ${fmt(b.measure)}px inside a ${b.clientWidth}px box`);
  }
  if (b.bodyScroll.w > b.bodyScroll.cw) {
    fail(`the notebook made the dialog body scroll horizontally (${b.bodyScroll.w} > ${b.bodyScroll.cw})`);
  }
  for (const stack of res.reads.stacks.slice(0, 3)) console.error(`      read: ${stack.split("\n")[1] || stack}`);
  if (res.reads.mine > 0) {
    fail(`typing forced ${res.reads.mine} layout read(s) from js/dialog.js / js/reader.js`);
  }
  const budget = res.keys * LAYOUT_PER_KEY + LAYOUT_SLACK;
  if (res.layout > budget) {
    fail(`typing cost ${res.layout} layouts for ${res.keys} keystrokes (budget ${budget})`);
  }
  if (!b.saved) fail("the notebook never reported a successful save");
  if (b.stored !== NOTE_TEXT) fail("the note in localStorage is not what was typed");

  // ---- the note never leaves the browser -------------------------------
  const leaked = [];
  const fragment = NOTE_TEXT.slice(0, 24);
  if (res.href.indexOf(fragment) !== -1) leaked.push("location.href");
  if ((res.hash || "").indexOf(fragment) !== -1) leaked.push("location.hash");
  if ((res.shareLink || "").indexOf(fragment) !== -1) leaked.push("the share link");
  const carriers = res.requests.filter(
    (r) => r.url.indexOf(encodeURIComponent(fragment)) !== -1 ||
           r.url.indexOf(fragment) !== -1 || r.post.indexOf(fragment) !== -1
  );
  if (carriers.length) leaked.push(`${carriers.length} request(s)`);

  // The generated share page is built in Node from js/data.js, long before a
  // browser has a note to give it — read it back off disk and prove it.
  let pageBytes = "";
  try {
    pageBytes = await readFile(new URL(`places/${res.id}/index.html`, `file://${root}`), "utf8");
  } catch (e) {
    pageBytes = "";
  }
  if (pageBytes && pageBytes.indexOf(fragment) !== -1) leaked.push("the generated share page");

  console.log(
    `  the note stays put: URL clean, share link ${JSON.stringify(res.shareLink.slice(-28))}, ` +
    `none of the ${res.requests.length} request(s) made while typing carried it, ` +
    `places/${res.id}/index.html (${pageBytes.length} bytes${pageBytes ? "" : " — NOT BUILT"}) has no trace`
  );
  if (leaked.length) fail(`the note leaked into ${leaked.join(", ")}`);
  if (!pageBytes) {
    fail(`places/${res.id}/index.html is missing — run pnpm build`);
  }

  // ---- restored, shown in the reader, cleared --------------------------
  console.log(
    `  reload restores it (${res.restored.value.length} chars, ` +
    `${fmt(res.restored.rect)}px box), the reader sets it as ` +
    `${res.inReader.lines.length} pre-wrap line(s), "Clear" empties it back to ` +
    `${res.cleared.rows} rows`
  );
  if (res.restored.value !== NOTE_TEXT) fail("a reload did not restore the note");
  if (Math.abs(res.restored.rect - res.restored.predicted) > NOTE_EPS) {
    fail(`the restored notebook is ${fmt(res.restored.rect)}px, predicted ${fmt(res.restored.predicted)}px`);
  }
  if (res.restored.scrollHeight > res.restored.clientHeight + 1) {
    fail("the restored note overflows its box");
  }
  if (!res.inReader.lines.length) fail("the reader did not show the saved note");
  if (res.inReader.joined.replace(/\s+/g, "") !== NOTE_TEXT.replace(/\s+/g, "")) {
    fail("the reader's copy of the note is not the note");
  }
  if (res.cleared.value !== "") fail('"Clear" left text in the notebook');
  if (res.cleared.stored !== null) fail('"Clear" left the note in localStorage');
  if (res.cleared.rows !== 3) fail(`an empty notebook is ${res.cleared.rows} rows, expected 3`);

  // ---- done-when 4: the postcard ---------------------------------------
  const ok = res.postcard === res.expectedPostcard;
  console.log(
    `  postcard: ${res.postcard.split("\n").length} line(s), ` +
    `${res.postcard.length} chars, read back from the clipboard — ` +
    `${ok ? "exactly as expected" : "DIFFERENT"}`
  );
  if (!ok) {
    console.error(`      expected: ${JSON.stringify(res.expectedPostcard)}`);
    console.error(`      actual:   ${JSON.stringify(res.postcard)}`);
    fail("the postcard is not the expected text");
  }
  if (res.postcard.indexOf(NOTE_TEXT) === -1) {
    fail("the postcard does not carry the note verbatim");
  }
  if (!/— Atlas of the Curious$/.test(res.postcard)) {
    fail("the postcard does not end with the signature");
  }

  for (const e of res.errors) console.error(`  error: ${e}`);
  if (res.errors.length) fail(`the notebook logged ${res.errors.length} console/page error(s)`);
}

/* ---------------------------------------------------------------------- *
 * Done-when 5: the daily card on a phone                                 *
 * ---------------------------------------------------------------------- */

async function visitDaily(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.ATLAS_TEXT_READY === true, null, { timeout: 15000 });
    await settleFrames(page, 2);
    return await page.evaluate(() => {
      const el = document.querySelector(".daily-name");
      if (!el) return { missing: true };
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) ||
        parseFloat(cs.fontSize) * 1.55;
      const today = el.textContent;
      const linesOf = () => Math.round(el.offsetHeight / lh);
      const out = {
        today: today, todayLines: linesOf(), lineHeight: lh,
        width: el.clientWidth, worst: null, worstLines: 0, over: []
      };
      // The daily pick is deterministic per UTC day, so today's card is only
      // one of forty. Try all of them in the very same box.
      for (const p of window.ATLAS_DATA.places) {
        el.textContent = p.name + " — " + p.country;
        const n = linesOf();
        if (n > out.worstLines) { out.worstLines = n; out.worst = el.textContent; }
        if (n > 2) out.over.push(p.id + " (" + n + ")");
      }
      el.textContent = today;
      out.stacked = getComputedStyle(document.getElementById("daily-card")).display;
      out.readButton = !document.getElementById("read-book-btn").hidden;
      return out;
    });
  } finally {
    await context.close();
  }
}

function reportDaily(res, fail) {
  if (res.missing) { fail("the daily card has no name element"); return; }
  console.log(
    `daily card 390x844    "${res.today}" on ${res.todayLines} line(s) in ` +
    `${res.width}px (.daily-card is ${res.stacked}); the worst of all 40 is ` +
    `"${res.worst}" on ${res.worstLines}`
  );
  if (res.todayLines > MAX_DAILY_NAME_LINES) {
    fail(`the daily card's name wraps onto ${res.todayLines} lines at 390px`);
  }
  if (res.worstLines > MAX_DAILY_NAME_LINES) {
    fail(`${res.over.length} place name(s) wrap past ${MAX_DAILY_NAME_LINES} lines: ${res.over.slice(0, 4).join(", ")}`);
  }
  if (res.stacked !== "grid") {
    fail(`the daily card is still ${res.stacked} at 390px, not stacked`);
  }
  if (!res.readButton) fail('"Read as a book" is not offered');
}

/* ---------------------------------------------------------------------- *
 * The entry point smoke.mjs calls                                        *
 * ---------------------------------------------------------------------- */

export async function runReaderChecks(browser, origin, fail) {
  for (const viewport of READER_VIEWPORTS) {
    const res = await visitPagination(browser, origin, viewport);
    reportPagination(viewport.name, res, fail);
  }
  reportPrint(await visitPrint(browser, origin), fail);
  await reportNotebook(await visitNotebook(browser, origin), fail);
  reportDaily(await visitDaily(browser, origin), fail);
}
