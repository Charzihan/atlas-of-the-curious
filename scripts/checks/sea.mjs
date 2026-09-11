/* Atlas of the Curious — Phase 5 checks: the living sea.

   Four claims, each in its own page visit so nothing here can disturb the
   Phase 1–4 checks in scripts/smoke.mjs (they share a browser and a dev server,
   nothing else):

     1. Idle mode holds the frame rate. 120 frames are timed with the CPU
        throttled 4× through CDP `Emulation.setCPUThrottlingRate`, with the sea
        telling stories; the baseline is the same 120 frames, unthrottled, with
        idle mode off. The average may not exceed twice the baseline. While
        those frames run, ATLAS_MAP_DEBUG.mainThreadLayoutCalls() must stay at
        zero — the layout is happening in js/text-worker.js, and this is what
        says so.

     2. No glyph is ever drawn on a land cell. ATLAS_MAP_DEBUG.checkSeaText()
        walks every cell every sea glyph occupies against the land mask, the
        label mask and the ocean names. It is run after a marker hover, after
        the place is opened (the spill extends with the field note), and again
        during idle mode with the sentences drifting — and at 2.5×, where the
        labels have claimed the most water.

     3. Clicking a drifting sentence opens the place it came from. Twenty times
        over: read the live sentences, pick a random word, turn its cell into a
        point on screen with ATLAS_MAP_DEBUG.cellToClient(), click it, and
        require the dialog to open on that sentence's place id.

     4. The same again on the main thread (`?noflags=worker`), where the layout
        counter is expected to be *above* zero; plus the two places idle mode
        must never start at all — `prefers-reduced-motion: reduce`, and a phone.

   Nothing here ships with the site. */

/* ---- Thresholds --------------------------------------------------------- */

// done-when 1.
export const FRAME_SAMPLES = 120;
export const CPU_THROTTLE = 4;
export const FRAME_BUDGET_RATIO = 2;   // vs. the unthrottled, idle-off baseline
// done-when 3.
export const CLICK_PICKS = 20;

// A sentence needs a corridor of open water, and the sea only lets one more in
// every so often, so give it a few seconds before asking what it is saying.
const IDLE_WARMUP_MS = 4000;

/* ---- In-page helpers (serialised into the browser) ---------------------- */

// Time `n` painted frames and report the interval distribution, plus what the
// main thread did to itself while they ran.
const FRAME_RUN = (n) => new Promise((resolve) => {
  const D = window.ATLAS_MAP_DEBUG;
  D.resetCounters();
  const deltas = [];
  let left = n;
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    deltas.push(now - last);
    last = now;
    if (--left > 0) { requestAnimationFrame(tick); return; }
    const sorted = deltas.slice().sort((a, b) => a - b);
    resolve({
      frames: deltas.length,
      avg: deltas.reduce((a, b) => a + b, 0) / deltas.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted[sorted.length - 1],
      mainThreadLayoutCalls: D.mainThreadLayoutCalls(),
      workerActive: D.workerActive(),
      idle: D.idleState(),
      sentences: D.idleSentences().length
    });
  };
  requestAnimationFrame(() => { last = performance.now(); requestAnimationFrame(tick); });
});

const settleFrames = (page, n = 2) =>
  page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

async function openMap(browser, origin, viewport, options) {
  const opts = options || {};
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: opts.reducedMotion || "no-preference"
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" && !/frame-ancestors/.test(text)) errors.push(text);
  });
  page.on("pageerror", (e) => errors.push(`uncaught: ${e && e.message ? e.message : e}`));
  await page.goto(`${origin}/index.html${opts.query || ""}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.ATLAS_TEXT_READY === true, null, { timeout: 15000 });
  await page.waitForSelector(".map-stage .map-marker", { timeout: 15000 });
  await page.waitForFunction(() => !!window.ATLAS_MAP_DEBUG, null, { timeout: 15000 });
  // The worker has to boot, receive the land grid and prepare its handles.
  await page.waitForFunction(
    (want) => !want || window.ATLAS_MAP_DEBUG.workerActive(),
    !opts.noWorker, { timeout: 15000 }
  ).catch(() => {});
  await settleFrames(page, 3);
  return { context, page, errors };
}

/* ---- done-when 2: no glyph on land ------------------------------------- */

async function landSweep(page) {
  return page.evaluate(async (warmup) => {
    const D = window.ATLAS_MAP_DEBUG;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const frames = (n) => new Promise((resolve) => {
      let left = n;
      const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    const out = { stages: [], worker: D.workerActive() };
    const record = async (what) => {
      await frames(4);
      const r = D.checkSeaText();
      const labels = D.checkLabels();
      out.stages.push({
        what: what, cells: r.cells, violations: r.violations,
        selfOverlaps: r.selfOverlaps, seaLines: r.seaLines, idleLines: r.idleLines,
        sentences: r.sentences, hovered: r.hovered, extended: r.extended,
        labelOverlaps: labels.overlaps, labels: labels.labels,
        problems: r.problems
      });
      return r;
    };

    // Every place's tagline, spilled into the water in turn, at 1× and at 2.5×
    // where the labels have taken the most room.
    for (const zoom of [1, 2.5]) {
      D.setZoom(zoom);
      await frames(4);
      let spilled = 0, cells = 0, violations = 0, worst = null;
      for (const p of (window.ATLAS_DATA.places || [])) {
        D.showSeaText(p.id, false);
        await frames(3);   // the routing may be a worker round trip away
        const r = D.checkSeaText();
        if (r.seaLines) spilled++;
        cells += r.cells;
        violations += r.violations;
        if (r.violations && !worst) worst = r.problems.slice(0, 4);
      }
      D.hideSeaText();
      out.stages.push({
        what: "hover sweep @" + zoom + "x", spilled: spilled, places: 40,
        cells: cells, violations: violations, problems: worst || []
      });
    }

    D.setZoom(1);
    await frames(4);

    // …and the extended version, the one an opened place gets. Rapa Nui sits in
    // open Pacific, so there is water for the field note to spill into and the
    // check is about the extension rather than about a landlocked marker.
    D.showSeaText("rapa-nui", true);
    await record("opened place (tagline + field note)");
    D.hideSeaText();
    await frames(12);

    /* Now the drifting sentences — first in open water, then again at 2.5x,
       where the labels have claimed most of it and the corridors are scarce.
       The sea is restarted there rather than merely zoomed, so the second stage
       is a real measurement and not the leftovers of the first.

       Each stage is sampled repeatedly rather than once: the sentences are
       moving, so twelve walks a second apart check twelve different sets of
       cells, and a stage where the sea happened to be quiet at one instant
       still gets its chance to say something. */
    const soak = async (what, samples, gap) => {
      const total = {
        what: what, cells: 0, violations: 0, selfOverlaps: 0,
        seaLines: 0, idleLines: 0, sentences: 0, samples: 0, problems: []
      };
      for (let i = 0; i < samples; i++) {
        await wait(gap);
        const r = D.checkSeaText();
        total.samples++;
        total.cells += r.cells;
        total.violations += r.violations;
        total.selfOverlaps += r.selfOverlaps;
        total.seaLines += r.seaLines;
        total.idleLines += r.idleLines;
        total.sentences = Math.max(total.sentences, r.sentences);
        if (r.problems.length && total.problems.length < 8) {
          for (const p of r.problems) total.problems.push(p);
        }
      }
      const labels = D.checkLabels();
      total.labelOverlaps = labels.overlaps;
      total.labels = labels.labels;
      out.stages.push(total);
    };

    D.startIdle();
    await wait(warmup);
    await soak("idle sea", 12, 900);
    D.stopIdle();
    await wait(900);
    D.setZoom(2.5);
    await wait(500);
    D.startIdle();
    await wait(warmup);
    await soak("idle sea @2.5x", 12, 900);
    D.setZoom(1);
    await wait(300);
    D.stopIdle();
    return out;
  }, IDLE_WARMUP_MS);
}

/* ---- done-when 3: a drifting word is a link ---------------------------- */

async function clickSweep(page, picks) {
  const out = { picks: 0, opened: 0, wrong: [], skipped: 0, words: [], covered: [] };
  await page.evaluate(() => { window.ATLAS_MAP_DEBUG.setZoom(1); });
  await page.evaluate(() => window.ATLAS_MAP_DEBUG.startIdle());
  await page.waitForTimeout(IDLE_WARMUP_MS);

  // Every pick has to land; a sweep that quietly did nineteen would prove
  // nothing, so a moment where nothing is adrift is retried rather than counted.
  for (let attempt = 0; out.picks < picks && attempt < picks * 3; attempt++) {
    /* Read the sentences fresh each time: they are drifting, and Escape (or any
       key) would dissolve them, so the dialog is closed through the hash route.

       A candidate must be a word the sea itself will answer for, which means
       the topmost thing at its point has to be one of the map's own paint
       layers. Anything else there is a placement failure, not something to
       quietly skip: the engine put a readable, clickable word somewhere it is
       neither. Two ways that happens, and both are checked, because they need
       different questions asked.

         - Something on top answers the click first. A marker button, a label,
           the hover card, a zoom control — or the intro panel's outbound link,
           which took the whole page with it and left this sweep reporting
           "Execution context was destroyed". elementFromPoint finds these.

         - Something on top hides the word without taking the click. The intro
           panel is `pointer-events: none`, so elementFromPoint looks straight
           through it to the canvas and sees nothing wrong, while the panel is
           opaque and the sentence behind it cannot be read at all. Only the
           geometry says so, which is what ATLAS_MAP_DEBUG.seaObstacles() is
           for — the same boxes the engine is told to treat as land. */
    const found = await page.evaluate(() => {
      const D = window.ATLAS_MAP_DEBUG;
      window.scrollTo(0, 0);
      const SURFACE = /^(map-sea|map-base|map-markers|map-zoom|map-stage)$/;
      const boxes = D.seaObstacles().boxes;
      const name = (el) => {
        if (!el) return "(nothing)";
        const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).join(".") : "";
        return el.tagName.toLowerCase() + cls + (el.href ? ` -> ${el.href}` : "");
      };
      const cands = [], covered = [];
      for (const s of D.idleSentences()) {
        if (s.alpha < 0.5) continue;
        for (const w of s.words) {
          const at = D.cellToClient(w.col, w.row);
          if (!at) continue;
          if (at.x < 8 || at.y < 8 ||
              at.x > window.innerWidth - 8 || at.y > window.innerHeight - 8) continue;
          const box = boxes.find((b) =>
            at.x >= b.left && at.x <= b.right && at.y >= b.top && at.y <= b.bottom);
          if (box) {
            covered.push(`"${w.text}" (${s.id}) at r${w.row} c${w.col} is behind a ` +
              `floating panel (${Math.round(box.left)},${Math.round(box.top)}..` +
              `${Math.round(box.right)},${Math.round(box.bottom)})`);
            continue;
          }
          const el = document.elementFromPoint(at.x, at.y);
          const surface = el && el.classList
            ? [...el.classList].some((c) => SURFACE.test(c)) : false;
          if (!surface) {
            covered.push(`"${w.text}" (${s.id}) at r${w.row} c${w.col} sits under ` +
              `${name(el)}, which would answer the click instead of the sea`);
            continue;
          }
          cands.push({ id: s.id, word: w.text, col: w.col, row: w.row, x: at.x, y: at.y });
        }
      }
      return {
        pick: cands.length ? cands[(Math.random() * cands.length) | 0] : null,
        covered: covered
      };
    });
    for (const c of found.covered) if (out.covered.length < 12) out.covered.push(c);
    const pick = found.pick;
    if (!pick) {
      out.skipped++;
      await page.evaluate(() => window.ATLAS_MAP_DEBUG.startIdle());
      await page.waitForTimeout(600);
      continue;
    }
    out.picks++;
    out.words.push(pick.word);
    await page.mouse.click(pick.x, pick.y);
    await page.waitForTimeout(220);
    const state = await page.evaluate(() => ({
      open: !!document.getElementById("place-dialog").open,
      id: (window.ATLAS_DIALOG && window.ATLAS_DIALOG.currentId()) || null,
      hash: location.hash
    }));
    const landed = state.id || (/^#\/place\/(.+)$/.exec(state.hash) || [])[1];
    if (state.open && landed === pick.id) out.opened++;
    else out.wrong.push(`"${pick.word}" (${pick.id}) -> ${landed || "nothing"}`);
    await page.evaluate(() => { location.hash = "#/"; });
    // And wait for it to actually be gone. The next pick asks what is on top of
    // each word, and a dialog still closing over the map would answer for all
    // of them — the sweep would blame the sea for the test's own timing.
    await page.waitForFunction(
      () => !document.getElementById("place-dialog").open, null, { timeout: 5000 }
    ).catch(() => {});
    await page.waitForTimeout(140);
  }
  await page.evaluate(() => window.ATLAS_MAP_DEBUG.stopIdle());
  return out;
}

/* ---- done-when 1: frame rate under a 4× CPU throttle -------------------- */

async function frameRun(page, context, { throttle, idle }) {
  const cdp = await context.newCDPSession(page);
  try {
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.resetCounters());
    if (idle) {
      await page.evaluate(() => window.ATLAS_MAP_DEBUG.startIdle());
      await page.waitForTimeout(IDLE_WARMUP_MS);
    } else {
      await page.evaluate(() => window.ATLAS_MAP_DEBUG.stopIdle());
      await page.waitForTimeout(700);
    }
    if (throttle > 1) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    const warmupLayoutCalls = await page.evaluate(() => window.ATLAS_MAP_DEBUG.mainThreadLayoutCalls());
    const res = await page.evaluate(FRAME_RUN, FRAME_SAMPLES);
    res.warmupLayoutCalls = warmupLayoutCalls;
    if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    return res;
  } finally {
    await cdp.detach();
  }
}

/* ---- The run ------------------------------------------------------------ */

// One desktop visit, doing the three measurements that need the map on screen.
async function visitSea(browser, origin, options) {
  const opts = options || {};
  const { context, page, errors } = await openMap(
    browser, origin, { width: 1280, height: 800 }, opts
  );
  try {
    const flags = await page.evaluate(() => window.ATLAS_MAP_DEBUG.flags);
    const worker = await page.evaluate(() => window.ATLAS_MAP_DEBUG.workerActive());
    const pool = await page.evaluate(() => {
      window.ATLAS_MAP_DEBUG.startIdle();
      return window.ATLAS_MAP_DEBUG.idleState();
    });
    await page.waitForTimeout(IDLE_WARMUP_MS);
    const idleState = await page.evaluate(() => window.ATLAS_MAP_DEBUG.idleState());
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.stopIdle());
    await page.waitForTimeout(700);

    const baseline = await frameRun(page, context, { throttle: 1, idle: false });
    const throttled = await frameRun(page, context, { throttle: CPU_THROTTLE, idle: true });
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.stopIdle());
    await page.waitForTimeout(400);

    const land = await landSweep(page);
    const clicks = await clickSweep(page, CLICK_PICKS);
    const chrome = await page.evaluate(() => window.ATLAS_MAP_DEBUG.seaObstacles());
    const agreement = await page.evaluate(() => window.ATLAS_MAP_DEBUG.fontAgreement());
    return {
      flags, worker, pool, idleState, baseline, throttled, land, clicks,
      chrome, agreement, errors
    };
  } finally {
    await context.close();
  }
}

// The two places idle mode must never start.
async function visitNeverIdle(browser, origin, viewport, options) {
  const { context, page, errors } = await openMap(browser, origin, viewport, options);
  try {
    const state = await page.evaluate(() => {
      const D = window.ATLAS_MAP_DEBUG;
      const started = D.startIdle();
      return {
        started: !!started, after: D.idleState(),
        sentences: D.idleSentences().length,
        seaText: D.showSeaText(window.ATLAS_DATA.places[0].id, false)
      };
    });
    await page.waitForTimeout(600);
    const later = await page.evaluate(() => ({
      state: window.ATLAS_MAP_DEBUG.idleState(),
      sentences: window.ATLAS_MAP_DEBUG.idleSentences().length,
      check: window.ATLAS_MAP_DEBUG.checkSeaText()
    }));
    return { state, later, errors };
  } finally {
    await context.close();
  }
}

export async function runSeaChecks(browser, origin) {
  return {
    worker: await visitSea(browser, origin, {}),
    mainThread: await visitSea(browser, origin, {
      query: "?noflags=worker", noWorker: true
    }),
    reduced: await visitNeverIdle(browser, origin, { width: 1280, height: 800 }, {
      reducedMotion: "reduce"
    }),
    phone: await visitNeverIdle(browser, origin, { width: 390, height: 844 }, {})
  };
}

/* ---- Reporting ---------------------------------------------------------- */

const fmt = (n) => Math.round(n * 100) / 100;

function reportOne(label, res, fail, expectWorker) {
  const w = res.worker;
  console.log(
    `${label.padEnd(22)} worker ${w ? "active" : "off"}, ` +
    `${res.idleState.sentences} sentence(s) adrift of ${res.idleState.maxSentences} max, ` +
    `${res.idleState.prepared} prepared`
  );
  if (w !== expectWorker) {
    fail(`${label} workerActive() is ${w}, expected ${expectWorker}`);
  }
  if (!res.idleState.on) fail(`${label} idle mode did not start`);
  if (!res.idleState.sentences) fail(`${label} idle mode produced no drifting sentences`);

  /* ---- done-when 1: frame rate ------------------------------------- */
  const b = res.baseline, t = res.throttled;
  const budget = b.avg * FRAME_BUDGET_RATIO;
  console.log(
    `  frames: baseline (1x CPU, idle off) avg ${fmt(b.avg)}ms / p95 ${fmt(b.p95)}ms ` +
    `over ${b.frames}; idle at ${CPU_THROTTLE}x CPU avg ${fmt(t.avg)}ms / ` +
    `p95 ${fmt(t.p95)}ms / max ${fmt(t.max)}ms over ${t.frames} ` +
    `(budget ${fmt(budget)}ms = ${FRAME_BUDGET_RATIO}x baseline)`
  );
  console.log(
    `  main-thread pretext calls during those frames: ${t.mainThreadLayoutCalls} ` +
    `(warmup ${t.warmupLayoutCalls}, baseline run ${b.mainThreadLayoutCalls}); ${t.sentences} sentence(s) on the water`
  );
  if (t.frames !== FRAME_SAMPLES || b.frames !== FRAME_SAMPLES) {
    fail(`${label} timed ${t.frames}/${b.frames} frames, expected ${FRAME_SAMPLES}`);
  }
  if (t.avg > budget) {
    fail(`${label} idle frames average ${fmt(t.avg)}ms at ${CPU_THROTTLE}x CPU ` +
         `(budget ${fmt(budget)}ms)`);
  }
  if (!t.sentences) fail(`${label} nothing was drifting during the timed frames`);
  if (expectWorker) {
    if (t.mainThreadLayoutCalls !== 0) {
      fail(`${label} made ${t.mainThreadLayoutCalls} pretext call(s) on the main ` +
           `thread during idle frames (expected 0 with the worker active)`);
    }
  } else if (t.mainThreadLayoutCalls + t.warmupLayoutCalls <= 0) {
    fail(`${label} made no main-thread pretext calls with the worker off — the ` +
         `counter is not measuring the fallback`);
  }

  /* ---- The two hosts must be measuring the same font --------------- */
  // Nothing here has an @font-face, so both sides are looking at the same
  // installed faces and there is nothing to load into the worker. But "the same
  // stack resolves the same way in a worker" is an assumption, and if it were
  // wrong the sea would be routed against one cell width and painted at
  // another. Both sides measure the grid's reference string and must agree.
  const fa = res.agreement;
  console.log(
    `  cell width: page ${fmt(fa.main)}px, worker ` +
    (fa.reported ? `${fmt(fa.worker)}px (delta ${fmt(fa.delta)}px)` : "not reported")
  );
  if (expectWorker) {
    if (!fa.reported) fail(`${label} the worker never reported what it measured`);
    else if (fa.delta > 0.01) {
      fail(`${label} the worker measured the grid font at ${fmt(fa.worker)}px per ` +
           `cell and the page at ${fmt(fa.main)}px — the same font string resolved ` +
           `to different faces on the two threads`);
    }
  }

  /* ---- The page's own chrome is an obstacle, not water -------------- */
  const chrome = res.chrome || { boxes: [], rects: [] };
  console.log(
    `  floating over the water: ${chrome.boxes.length} box(es) masking ` +
    `${chrome.rects.map((r) => (r.r1 - r.r0 + 1) + "x" + (r.c1 - r.c0 + 1)).join(" + ") || "nothing"} cells`
  );
  if (chrome.rects.length < 2) {
    fail(`${label} only ${chrome.rects.length} floating box(es) were masked — the ` +
         `intro panel and the control cluster are both over the sea, so the ` +
         `"nothing hides behind the chrome" checks below prove nothing`);
  }

  /* ---- done-when 2: nothing on land -------------------------------- */
  let violations = 0, cells = 0;
  for (const s of res.land.stages) {
    violations += s.violations;
    cells += s.cells;
    if (s.what.indexOf("hover sweep") === 0) {
      console.log(
        `  ${s.what}: ${s.spilled}/${s.places} taglines found water, ` +
        `${s.cells} glyph cell(s), ${s.violations} on land/label/ocean name`
      );
      if (!s.spilled) fail(`${label} ${s.what}: no tagline reached the water`);
    } else {
      console.log(
        `  ${s.what}: ${s.cells} glyph cell(s) over ${s.seaLines} spilled line(s) ` +
        `and ${s.idleLines} drifting line(s) (up to ${s.sentences} sentence(s)` +
        (s.samples ? `, ${s.samples} walks as they drifted` : "") + `), ` +
        `${s.violations} on land/label/ocean name, ${s.selfOverlaps} self-overlap(s); ` +
        `labels still ${s.labelOverlaps} overlap(s) over ${s.labels} label(s)`
      );
      if (s.selfOverlaps) fail(`${label} ${s.what}: sea text overlaps itself`);
      if (s.labelOverlaps) fail(`${label} ${s.what}: the labels started overlapping`);
    }
    for (const p of (s.problems || []).slice(0, 4)) {
      console.error(`      ${p.what} "${p.id}" cell r${p.row} c${p.col}: ${p.why}`);
    }
  }
  if (violations) {
    fail(`${label} drew ${violations} glyph cell(s) on land, a label, an ocean ` +
         `name or the page's own chrome`);
  }
  if (!cells) fail(`${label} never drew a single sea glyph — the check proves nothing`);
  for (const what of ["idle sea", "idle sea @2.5x"]) {
    const stage = res.land.stages.find((s) => s.what === what);
    if (!stage || !stage.idleLines) {
      fail(`${label} "${what}" saw no drifting lines — the check proves nothing`);
    }
  }
  const opened = res.land.stages.find((s) => s.what.indexOf("opened place") === 0);
  if (!opened || opened.seaLines < 3) {
    fail(`${label} the opened place spilled ${opened ? opened.seaLines : 0} line(s) ` +
         `into the water — the tagline alone is two, so the field note did not follow`);
  }
  if (opened && !opened.extended) {
    fail(`${label} the opened place's spill was not extended with the field note`);
  }

  /* ---- done-when 3: clicking a drifting word ----------------------- */
  const c = res.clicks;
  console.log(
    `  drifting words clicked: ${c.opened}/${c.picks} opened the right place ` +
    `(${c.skipped} skipped, no sentence adrift); e.g. ` +
    c.words.slice(0, 4).map((s) => `"${s}"`).join(", ")
  );
  for (const bad of c.wrong.slice(0, 5)) console.error(`      ${bad}`);
  // A word that something else on the page owns is a placement failure: the sea
  // routed a readable, clickable sentence into cells it does not own.
  for (const bad of c.covered.slice(0, 6)) console.error(`      ${bad}`);
  if (c.covered.length) {
    fail(`${label} ${c.covered.length} drifting word(s) were under the page's own ` +
         `chrome — unreadable there, and a click would go somewhere else`);
  }
  if (c.picks < CLICK_PICKS) {
    fail(`${label} only ${c.picks} of ${CLICK_PICKS} click picks found a sentence`);
  }
  if (c.opened !== c.picks) {
    fail(`${label} ${c.picks - c.opened} clicked word(s) did not open their place`);
  }

  for (const e of res.errors) console.error(`  error: ${e}`);
  if (res.errors.length) fail(`${label} logged ${res.errors.length} console/page error(s)`);
}

function reportNeverIdle(label, res, fail, why) {
  console.log(
    `${label.padEnd(22)} startIdle() -> ${res.state.started}, ` +
    `idle on: ${res.later.state.on}, ${res.later.sentences} sentence(s), ` +
    `${res.later.check.cells} sea glyph cell(s) (${why})`
  );
  if (res.state.started || res.state.after.on || res.later.state.on) {
    fail(`${label} idle mode started even though ${why}`);
  }
  if (res.later.sentences || res.later.check.idleLines) {
    fail(`${label} ${res.later.sentences} sentence(s) drifted even though ${why}`);
  }
  for (const e of res.errors) console.error(`  error: ${e}`);
  if (res.errors.length) fail(`${label} logged ${res.errors.length} console/page error(s)`);
}

export function reportSeaChecks(results, fail) {
  reportOne("sea 1280x800", results.worker, fail, true);
  reportOne("sea main-thread", results.mainThread, fail, false);
  reportNeverIdle("sea reduced-motion", results.reduced, fail, "prefers-reduced-motion: reduce");
  reportNeverIdle("sea 390x844", results.phone, fail, "the viewport is a phone");
}
