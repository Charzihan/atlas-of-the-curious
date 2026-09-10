/* Atlas of the Curious — the field guide: every place, paginated.

   "Read as a book" lays the whole of the current filter out as a printed book
   would: one place per opening, a heading block, the story and the field note
   flowed at a comfortable measure, and a running footer. Nothing scrolls —
   pages turn.

   How a page is built, in the order it happens:

     1. `readGeometry()` reads the reader stage's width and height. Those are
        the ONLY layout reads in this file, and they happen once per open and
        once per resize — never per page, never per line. The page box is then
        rounded DOWN to a whole number of body lines, so a line can never be
        half-cut by the page edge.
     2. `buildPlace()` turns one place into blocks: an atomic heading block
        (name, native name, country · region, tagline) and a run of flowed
        paragraphs. Each paragraph's lines come from pretext's cursor —
        `layoutNextLineRange()` / `materializeLineRange()` — at the page
        measure, which is the same routine the map's label router uses.
     3. `paginate()` pours those blocks into pages. It knows every line of a
        paragraph before it closes a page, so the widow/orphan rule is a
        lookahead rather than a guess: a paragraph that spans a page boundary
        leaves at least two of its lines on each side of it. A place always
        starts a new page, so the page count is exact the moment the mode
        opens — before a single pixel is painted.
     4. `renderPage()` writes one absolutely positioned span per line at the
        coordinates step 3 computed. Nothing is measured again.

   Only the current page and its two neighbours are in the DOM. Printing is the
   exception: `beforeprint` (or `matchMedia("print")` matching) renders every
   page, each with `break-after: page` and the very same pixel geometry, so the
   paper matches the screen page for page; `afterprint` goes back to three.

   Accessibility: each place's first page carries a visually hidden paragraph
   with its whole story, field note and note, so a screen reader and
   find-in-page still see ordinary prose. Every generated line span is
   aria-hidden.

   CSP: DOM APIs only — no innerHTML, no inline style attributes (every style
   goes through `el.style.setProperty`), no external requests. */
import { layoutNextLineRange, materializeLineRange } from "../vendor/pretext/layout.js";
import { readNote } from "./notebook.js";

/* ------------------------------------------------------------------ *
 * Tuning                                                              *
 * ------------------------------------------------------------------ */

const MAX_MEASURE = 600;   // the widest a body line is ever set
const MIN_MEASURE = 240;
const PAD_X = 22;          // the page's left/right margin
const PAD_TOP = 26;        // the page's head margin
const FOOT_H = 30;         // the running footer, exactly
const STAGE_PAD_Y = 8;     // .reader-stage's own padding, top and bottom
const MIN_ROWS = 4;        // a page always holds at least this many body lines
const HEAD_GAP = 18;       // below the heading block
const PARA_GAP = 10;       // between two flowed paragraphs
const LABEL_H = 22;        // a "Field note" / "Your note" label
const NEIGHBOURS = 1;      // pages kept in the DOM either side of the current
const EPS = 0.01;          // floating-point slack when counting whole lines
const RESIZE_MS = 140;

/* ------------------------------------------------------------------ *
 * The module                                                          *
 * ------------------------------------------------------------------ */

function boot(win, doc) {
  const $ = (id) => doc.getElementById(id);
  const root = $("reader");
  if (!root) return;

  const DATA = win.ATLAS_DATA || { categories: [], places: [] };
  const placesById = new Map(DATA.places.map((p) => [p.id, p]));
  const FLAGS = win.ATLAS_FLAGS || {};
  const flag = (name) => FLAGS[name] !== false;
  const T = win.ATLAS_TEXT || null;

  // Without the metrics module there is nothing to paginate by hand.
  if (!T || !flag("bookMode")) return;

  const stage = $("reader-stage");
  const countEl = $("reader-count");
  const titleEl = $("reader-title");
  if (!stage) return;

  /* ---- Geometry (the only layout reads) ---------------------------- */
  const geom = {
    stageWidth: 0, stageHeight: 0, measure: 0, rows: 0,
    contentH: 0, pageH: 0, lh: 0, read: false
  };

  function readGeometry() {
    const width = stage.clientWidth || doc.documentElement.clientWidth || 320;
    const height = stage.clientHeight ||
      Math.max(320, (win.innerHeight || 800) - 56);
    geom.stageWidth = width;
    geom.stageHeight = height;
    geom.measure = Math.max(
      MIN_MEASURE, Math.min(MAX_MEASURE, Math.floor(width - PAD_X * 2))
    );
    geom.lh = T.fontFor("book-body").lineHeight;
    const box = height - STAGE_PAD_Y * 2 - PAD_TOP - FOOT_H;
    geom.rows = Math.max(MIN_ROWS, Math.floor(box / geom.lh));
    // Whole lines only: the content box is an exact multiple of the body line
    // height, so the page edge always falls between two lines.
    geom.contentH = geom.rows * geom.lh;
    geom.pageH = PAD_TOP + geom.contentH + FOOT_H;
    geom.read = true;
  }

  /* ---- Flowing one paragraph through pretext's cursor -------------- */

  // The routine from pretext's dynamic-layout demo: ask for the next line
  // range at the width this row has, materialise it, carry the cursor on.
  // Every line of the paragraph is known before the first page is closed,
  // which is what makes the widow/orphan rule a lookahead instead of a guess.
  function flowLines(handle, width) {
    const out = [];
    let cursor = { segmentIndex: 0, graphemeIndex: 0 };
    for (let guard = 0; guard < 4000; guard++) {
      const range = layoutNextLineRange(handle, cursor, width);
      if (range === null) break;
      const line = materializeLineRange(handle, range);
      out.push({ text: line.text, width: line.width });
      cursor = range.end;
    }
    return out;
  }

  /* ---- One place, as blocks ---------------------------------------- */

  function nativeInfo(place) {
    if (!flag("nativeNames")) return null;
    const text = String(place.nativeName || "");
    if (!text || text === place.name) return null;
    let dir = "ltr";
    try { dir = T.directionOf("native-name", place.id, place.nativeLang); }
    catch (e) { dir = T.directionOfText("native-name", text, place.nativeLang); }
    const rec = T.localeFor ? T.localeFor("native-name", place.id) : null;
    return {
      text: text, lang: place.nativeLang || "", dir: dir,
      wordBreak: (rec && rec.wordBreak) || "normal"
    };
  }

  function headBlock(place) {
    const measure = geom.measure;
    const records = [];
    let y = 0;
    const push = (cls, role, text, extra) => {
      const f = T.fontFor(role);
      for (const line of T.linesOfText(role, text, measure)) {
        const rec = { cls: cls, text: line, y: y, lh: f.lineHeight, kind: "head" };
        if (extra) Object.assign(rec, extra);
        records.push(rec);
        y += f.lineHeight;
      }
    };
    push("book-title", "book-title", place.name);
    const native = nativeInfo(place);
    if (native) {
      y += 2;
      push("book-native", "native-name", native.text, {
        lang: native.lang, dir: native.dir, wordBreak: native.wordBreak
      });
    }
    y += 8;
    push("book-meta", "book-meta", (place.country + " · " + place.region).toUpperCase());
    y += 6;
    push("book-tagline", "book-tagline", place.tagline);
    return { type: "head", records: records, height: y + HEAD_GAP };
  }

  function labelBlock(text) {
    return {
      type: "label", height: LABEL_H, sticky: true,
      records: [{ cls: "book-label", text: text, y: 0, lh: LABEL_H, kind: "label" }]
    };
  }

  function flowBlock(kind, cls, role, text, preWrap) {
    const f = T.fontFor(role);
    const handle = preWrap
      ? T.handleForPreWrap(role, text)
      : T.handleForText(role, text);
    return {
      type: "flow", kind: kind, cls: cls, lh: f.lineHeight,
      lines: flowLines(handle, geom.measure)
    };
  }

  // The story is NOT soft-hyphenated here: the field guide's promise is that
  // the lines of a place, concatenated back together, are its story exactly.
  function buildPlace(place) {
    const blocks = [headBlock(place)];
    blocks.push(flowBlock("story", "book-line", "book-body", place.story, false));
    if (place.fact) {
      blocks.push(labelBlock("Field note"));
      blocks.push(flowBlock("fact", "book-line book-fact", "book-body", place.fact, false));
    }
    const note = flag("notebook") ? readNote(win, place.id) : "";
    if (note) {
      blocks.push(labelBlock("Your note"));
      // pre-wrap, so the visitor's own line breaks and tabs are honoured.
      blocks.push(flowBlock("note", "book-note-line", "notebook", note, true));
    }
    return { place: place, blocks: blocks, note: note };
  }

  /* ---- Pagination -------------------------------------------------- */

  function paginate(list) {
    const pages = [];
    const byPlace = new Map();
    for (const place of list) {
      const built = buildPlace(place);
      const bodyLines = [];   // every flowed line of this place, in order
      let page = null;
      let used = 0;
      let first = true;

      const openPage = () => {
        page = {
          placeId: place.id, place: place, records: [], used: 0, bottom: 0,
          first: first, firstLine: -1, lastLine: -1, lineCount: 0,
          kinds: {}, accessible: first ? built : null
        };
        first = false;
        used = 0;
      };
      const closePage = () => {
        if (!page || !page.records.length) return;
        // What the page actually occupies is the bottom of its lowest line —
        // not the running cursor, which carries the gap that would have
        // separated the next paragraph if there had been one.
        page.used = page.bottom;
        page.overflow = page.bottom > geom.contentH + EPS;
        pages.push(page);
        page = null;
      };
      const flush = () => { closePage(); openPage(); };
      const noteLine = (rec) => {
        page.records.push(rec);
        const bottom = rec.y + rec.lh;
        if (bottom > page.bottom) page.bottom = bottom;
        if (rec.bodyIndex == null) return;
        if (page.firstLine < 0) page.firstLine = rec.bodyIndex;
        page.lastLine = rec.bodyIndex;
        page.lineCount++;
        page.kinds[rec.kind] = (page.kinds[rec.kind] || 0) + 1;
      };

      openPage();
      const blocks = built.blocks;
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi];

        if (block.type !== "flow") {
          // An atomic block. A label is "sticky": it may not be stranded at
          // the foot of a page with its paragraph overleaf, so it asks for
          // room for its own height plus the first two lines of what follows.
          let need = block.height;
          if (block.sticky) {
            const next = blocks[bi + 1];
            if (next && next.type === "flow") {
              need += Math.min(2, next.lines.length) * next.lh;
            }
          }
          if (used > 0 && used + need > geom.contentH + EPS) flush();
          for (const rec of block.records) {
            noteLine({
              cls: rec.cls, text: rec.text, y: used + rec.y, lh: rec.lh,
              kind: rec.kind, lang: rec.lang, dir: rec.dir,
              wordBreak: rec.wordBreak
            });
          }
          used += block.height;
          continue;
        }

        // A flowed paragraph.
        const base = bodyLines.length;
        for (const line of block.lines) {
          bodyLines.push({ kind: block.kind, text: line.text, width: line.width });
        }
        let i = 0;
        let guard = 0;
        while (i < block.lines.length && guard++ < 4000) {
          const room = geom.contentH - used;
          const avail = Math.floor((room + EPS) / block.lh);
          if (avail <= 0) { flush(); continue; }
          const left = block.lines.length - i;
          let take = Math.min(avail, left);
          // --- widows and orphans -------------------------------------
          // A paragraph that carries on overleaf must leave at least two
          // lines on each side of the boundary. `block.lines` is already the
          // whole paragraph, so this is a real lookahead.
          if (geom.rows >= 4 && take < left) {
            if (left - take === 1) take -= 1;   // no lone line overleaf
            if (take === 1) take = 0;           // no lone line down here
          }
          if (take <= 0) {
            // Never stall: on a page that is still empty, take what fits.
            if (used <= 0) take = Math.min(avail, left);
            else { flush(); continue; }
          }
          for (let k = 0; k < take; k++) {
            noteLine({
              cls: block.cls, text: block.lines[i + k].text,
              y: used + k * block.lh, lh: block.lh, kind: block.kind,
              bodyIndex: base + i + k
            });
          }
          used += take * block.lh;
          i += take;
          if (i < block.lines.length) flush();
        }
        used += PARA_GAP;
      }
      closePage();
      byPlace.set(place.id, { bodyLines: bodyLines, note: built.note });
    }
    // The running footer needs "page N of M", so the totals go in last.
    for (let i = 0; i < pages.length; i++) {
      pages[i].number = i + 1;
      pages[i].total = pages.length;
    }
    return { pages: pages, byPlace: byPlace };
  }

  /* ---- Rendering --------------------------------------------------- */

  let pages = [];
  let byPlace = new Map();
  let firstPageOf = new Map();   // place id -> 1-based page number
  let current = 1;
  let opened = false;
  let listIds = [];
  let printMode = false;
  let lastFocus = null;
  const nodes = new Map();       // page number -> element

  function px(n) { return Math.round(n * 100) / 100 + "px"; }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function renderPage(page) {
    const el = doc.createElement("article");
    el.className = "reader-page";
    el.setAttribute("data-page", String(page.number));
    el.setAttribute("aria-label", page.place.name + ", page " + page.number);
    el.style.setProperty("width", px(geom.measure + PAD_X * 2));
    el.style.setProperty("height", px(geom.pageH));

    // The accessible copy: ordinary prose, once per place, on its first page.
    if (page.accessible) {
      const a = doc.createElement("p");
      a.className = "visually-hidden";
      const parts = [page.place.name, page.place.story];
      if (page.place.fact) parts.push("Field note. " + page.place.fact);
      if (page.accessible.note) parts.push("Your note. " + page.accessible.note);
      a.textContent = parts.join(" ");
      el.appendChild(a);
    }

    const bodyEl = doc.createElement("div");
    bodyEl.className = "reader-page-body";
    bodyEl.setAttribute("aria-hidden", "true");
    bodyEl.style.setProperty("left", px(PAD_X));
    bodyEl.style.setProperty("top", px(PAD_TOP));
    bodyEl.style.setProperty("width", px(geom.measure));
    bodyEl.style.setProperty("height", px(geom.contentH));
    for (const rec of page.records) {
      const span = doc.createElement("span");
      span.className = rec.cls;
      span.textContent = rec.text;
      span.setAttribute("aria-hidden", "true");
      span.style.setProperty("top", px(rec.y));
      span.style.setProperty("width", px(geom.measure));
      span.style.setProperty("line-height", px(rec.lh));
      if (rec.lang) span.setAttribute("lang", rec.lang);
      if (rec.dir) span.setAttribute("dir", rec.dir);
      if (rec.wordBreak === "keep-all") span.setAttribute("data-wb", "keep-all");
      bodyEl.appendChild(span);
    }
    el.appendChild(bodyEl);

    const foot = doc.createElement("footer");
    foot.className = "reader-page-foot";
    foot.style.setProperty("left", px(PAD_X));
    foot.style.setProperty("right", px(PAD_X));
    foot.style.setProperty("height", px(FOOT_H));
    const who = doc.createElement("span");
    who.className = "reader-foot-place";
    who.textContent = page.place.name;
    const where = doc.createElement("span");
    where.className = "reader-foot-page";
    where.textContent = "page " + page.number + " of " + page.total;
    foot.appendChild(who);
    foot.appendChild(where);
    el.appendChild(foot);

    // Turning zones: the outer thirds of the page. Inert to the keyboard (the
    // header buttons and the arrow keys are the accessible path) and to the
    // accessibility tree; the middle third is left alone so the text there can
    // still be selected.
    for (const dir of [-1, 1]) {
      const zone = doc.createElement("div");
      zone.className = dir < 0 ? "reader-turn reader-turn-prev" : "reader-turn reader-turn-next";
      zone.setAttribute("aria-hidden", "true");
      zone.addEventListener("click", () => goTo(current + dir));
      el.appendChild(zone);
    }
    return el;
  }

  function wanted() {
    if (printMode) {
      const all = [];
      for (let i = 1; i <= pages.length; i++) all.push(i);
      return all;
    }
    const out = [];
    for (let n = current - NEIGHBOURS; n <= current + NEIGHBOURS; n++) {
      if (n >= 1 && n <= pages.length) out.push(n);
    }
    return out;
  }

  // Only the pages that should be there are built; the rest are removed. No
  // element is read, only written.
  function syncDom() {
    const want = wanted();
    const keep = new Set(want);
    for (const [number, el] of Array.from(nodes.entries())) {
      if (keep.has(number)) continue;
      if (el.parentNode) el.parentNode.removeChild(el);
      nodes.delete(number);
    }
    let previous = null;
    for (const number of want) {
      let el = nodes.get(number);
      if (!el) {
        el = renderPage(pages[number - 1]);
        nodes.set(number, el);
        if (previous && previous.nextSibling) {
          stage.insertBefore(el, previous.nextSibling);
        } else if (previous) {
          stage.appendChild(el);
        } else if (stage.firstChild) {
          stage.insertBefore(el, stage.firstChild);
        } else {
          stage.appendChild(el);
        }
      }
      el.classList.toggle("is-current", number === current);
      previous = el;
    }
  }

  function syncChrome() {
    const page = pages[current - 1];
    if (countEl) {
      countEl.textContent = pages.length
        ? "page " + current + " of " + pages.length
        : "no places in this filter";
    }
    if (titleEl) {
      titleEl.textContent = page ? page.place.name : "The field guide";
    }
  }

  function syncRoute() {
    const page = pages[current - 1];
    if (!page) return;
    const hash = "#/read/" + encodeURIComponent(page.placeId);
    if (win.location.hash === hash) return;
    try {
      const u = new win.URL(win.location.href);
      win.history.replaceState(null, "", u.pathname + u.search + hash);
    } catch (e) { /* file:// — the reader still works, the URL just lags */ }
  }

  function goTo(page) {
    if (!pages.length) return current;
    const n = page < 1 ? 1 : page > pages.length ? pages.length : Math.round(page);
    current = n;
    syncDom();
    syncChrome();
    syncRoute();
    return current;
  }

  /* ---- Print ------------------------------------------------------- */

  const printQ = win.matchMedia ? win.matchMedia("print") : null;

  function setPrintMode(on) {
    const next = !!on;
    if (next === printMode) return;
    printMode = next;
    if (opened) syncDom();
  }

  if (printQ) {
    const onChange = (e) => setPrintMode(e.matches);
    if (printQ.addEventListener) printQ.addEventListener("change", onChange);
    else if (printQ.addListener) printQ.addListener(onChange);
  }
  win.addEventListener("beforeprint", () => setPrintMode(true));
  win.addEventListener("afterprint", () => setPrintMode(false));

  /* ---- Opening and closing ----------------------------------------- */

  let visibleProvider = () => DATA.places;

  function listFor(id) {
    let list = (visibleProvider() || []).slice();
    if (!list.length) list = DATA.places.slice();
    if (id && !list.some((p) => p.id === id)) {
      const place = placesById.get(id);
      if (place) list = [place];
    }
    return list;
  }

  function build(list) {
    const out = paginate(list);
    pages = out.pages;
    byPlace = out.byPlace;
    firstPageOf = new Map();
    for (const page of pages) {
      if (!firstPageOf.has(page.placeId)) firstPageOf.set(page.placeId, page.number);
    }
    listIds = list.map((p) => p.id);
    for (const el of nodes.values()) if (el.parentNode) el.parentNode.removeChild(el);
    nodes.clear();
  }

  function sameList(list) {
    if (list.length !== listIds.length) return false;
    for (let i = 0; i < list.length; i++) if (list[i].id !== listIds[i]) return false;
    return true;
  }

  function open(id) {
    const list = listFor(id);
    if (!list.length) return;
    if (!opened) {
      lastFocus = doc.activeElement;
      root.hidden = false;
      root.classList.add("is-open");
      doc.body.classList.add("is-reading");
      opened = true;
      readGeometry();          // once per open, with the stage on screen
      build(list);
    } else if (!geom.read || !sameList(list)) {
      readGeometry();
      build(list);
    }
    if (printQ && printQ.matches) printMode = true;
    goTo(id && firstPageOf.has(id) ? firstPageOf.get(id) : current);
    if (typeof root.focus === "function") root.focus();
  }

  function close() {
    if (!opened) return;
    opened = false;
    root.classList.remove("is-open");
    root.hidden = true;
    doc.body.classList.remove("is-reading");
    clear(stage);
    nodes.clear();
    if (lastFocus && typeof lastFocus.focus === "function") {
      try { lastFocus.focus(); } catch (e) { /* gone from the DOM */ }
    }
    lastFocus = null;
    // Leaving the route is what closes the reader, so a close from inside
    // (Escape, the ✕) has to leave the route too.
    if (/^#\/read\//.test(win.location.hash || "")) win.location.hash = "#/";
  }

  /* ---- Keyboard and pointer ---------------------------------------- */

  const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea, " +
    "[tabindex]:not([tabindex=\"-1\"])";

  function trapTab(e) {
    const items = Array.prototype.slice.call(root.querySelectorAll(FOCUSABLE));
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement;
    if (e.shiftKey && (active === first || active === root || !root.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || active === root || !root.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  doc.addEventListener("keydown", (e) => {
    if (!opened) return;
    switch (e.key) {
      case "Escape": e.preventDefault(); close(); break;
      case "ArrowRight": case "PageDown": e.preventDefault(); goTo(current + 1); break;
      case "ArrowLeft": case "PageUp": e.preventDefault(); goTo(current - 1); break;
      case "Home": e.preventDefault(); goTo(1); break;
      case "End": e.preventDefault(); goTo(pages.length); break;
      case "Tab": trapTab(e); break;
      default: break;
    }
  });

  const prevBtn = $("reader-prev");
  const nextBtn = $("reader-next");
  const closeBtn = $("reader-close");
  if (prevBtn) prevBtn.addEventListener("click", () => goTo(current - 1));
  if (nextBtn) nextBtn.addEventListener("click", () => goTo(current + 1));
  if (closeBtn) closeBtn.addEventListener("click", close);

  /* ---- Resize ------------------------------------------------------ */
  let resizeTimer = null;
  win.addEventListener("resize", () => {
    win.clearTimeout(resizeTimer);
    resizeTimer = win.setTimeout(() => {
      if (!opened) { geom.read = false; return; }
      const at = pages[current - 1];
      const placeId = at ? at.placeId : null;
      readGeometry();                       // the second (and only other) read
      build(listFor(placeId));
      goTo(placeId && firstPageOf.has(placeId) ? firstPageOf.get(placeId) : 1);
    }, RESIZE_MS);
  });

  /* ---- The published surface --------------------------------------- */

  win.ATLAS_READER = {
    open: open,
    close: close,
    goTo: goTo,
    isOpen: () => opened,
    pageFor: (id) => (firstPageOf.has(id) ? firstPageOf.get(id) : 0),
    placeAt: (page) => {
      const p = pages[(page || current) - 1];
      return p ? p.placeId : null;
    },
    currentPage: () => current,
    setVisibleProvider: (fn) => { if (typeof fn === "function") visibleProvider = fn; },
    // Everything below reads the layout's own bookkeeping. It touches the DOM
    // only to list which pages are attached, which forces no layout.
    debug: function () {
      return {
        open: opened,
        pages: pages.length,
        pageHeight: geom.pageH,
        contentHeight: geom.contentH,
        measure: geom.measure,
        lineHeight: geom.lh,
        rows: geom.rows,
        padX: PAD_X,
        padTop: PAD_TOP,
        footHeight: FOOT_H,
        currentPage: current,
        printMode: printMode,
        rendered: Array.from(nodes.keys()).sort((a, b) => a - b),
        places: listIds.length,
        perPage: pages.map((p) => ({
          placeId: p.placeId,
          page: p.number,
          firstLine: p.firstLine,
          lastLine: p.lastLine,
          lineCount: p.lineCount,
          overflow: !!p.overflow,
          used: Math.round(p.used * 100) / 100,
          kinds: p.kinds,
          lines: p.records
            .filter((r) => r.bodyIndex != null)
            .map((r) => ({ kind: r.kind, text: r.text, index: r.bodyIndex }))
        })),
        bodyLines: (function () {
          const out = {};
          byPlace.forEach((v, id) => { out[id] = v.bodyLines.length; });
          return out;
        })(),
        flags: { bookMode: flag("bookMode"), notebook: flag("notebook") }
      };
    },
    // The flowed lines of one place, for a round-trip check.
    linesFor: function (id) {
      const rec = byPlace.get(id);
      return rec ? rec.bodyLines.slice() : [];
    }
  };

  win.ATLAS_READER_READY = true;
  if (typeof win.CustomEvent === "function") {
    win.dispatchEvent(new win.CustomEvent("atlas:reader-ready", {
      detail: { reader: win.ATLAS_READER }
    }));
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  boot(window, document);
}
