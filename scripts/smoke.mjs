/* Atlas of the Curious — smoke test.

   Opens the real index.html in headless Chromium at a desktop and a phone
   viewport, waits for the text-metrics module and the Text Atlas to come up,
   and fails on any console error or uncaught page error. Meant to be re-run
   after every roadmap phase.

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

const settle = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

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

async function visit(browser, origin, viewport) {
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
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.ATLAS_TEXT_READY === true, null, { timeout: 15000 });
    await page.waitForSelector(".map-stage .map-marker", { timeout: 15000 });
    // The dev agreement check runs on a rAF after load.
    await page.waitForFunction(() => !!window.ATLAS_TEXT_AGREEMENT, null, { timeout: 15000 });
    await page.waitForFunction(() => !!window.ATLAS_GRID_DEBUG, null, { timeout: 15000 });

    const stats = await page.evaluate(() => ({
      cards: document.querySelectorAll("#grid .card").length,
      markers: document.querySelectorAll(".map-marker").length,
      roles: window.ATLAS_TEXT ? window.ATLAS_TEXT.roleNames().length : 0,
      agreement: window.ATLAS_TEXT_AGREEMENT
    }));

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

    await cdp.detach();
    return { stats, grid, hero, filter, anchor, expand, errors, warnings, ignored, notes };
  } finally {
    await context.close();
  }
}

/* ---------------------------------------------------------------------- *
 * Reporting                                                              *
 * ---------------------------------------------------------------------- */

function reportViewport(label, res, viewport, fail) {
  const { stats, grid, hero, filter, anchor, expand } = res;
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
      reportViewport(`${viewport.name} ${viewport.width}x${viewport.height}`, res, viewport, fail);
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
