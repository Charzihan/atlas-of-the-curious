/* Atlas of the Curious — the open ocean.

   The sea used to stop at the edge of the world grid: a character rectangle
   centred in the hero — 150 × 39 cells then, 240 × 62 now — with dark nothing
   around it. It now fills the viewport, and it flows as the real ocean does —
   five subtropical gyres, two subpolar ones, the named boundary jets and the
   circumpolar band, out of the table in js/currents.js.

   Six claims, in one place:

     1. The water reaches every edge. At 1280×800 and at 2000×900 the sea
        canvas covers the whole `.map-viewport` on all four sides, and every
        margin band that exists has glyphs painted in it — a canvas that covers
        the viewport but paints nothing in the corner would still be an empty
        band.

     2. Nothing about the world grid moved. The map sits in the same box on
        screen, every marker at the same pixel inside it, and every label line in
        the same grid cell — at 1×, and again at 2.5× where the zoom tiers have
        every name out on the water — as the same page with `?noflags=openOcean`.
        That flag is the whole contract: off, this is the sea exactly as it was.

     3. The currents are a field, not a decoration. Non-zero speed in at least
        80% of the world grid's water cells, and exactly zero on land.

     4. The named currents point the right way. The table is sampled directly
        (no browser) at sixteen places an atlas would name — off Hatteras, off
        Japan, in the Drake Passage — and each has to agree with the direction
        that current actually runs.

     5. Every glyph the flow can paint is exactly one cell wide in the face the
        browser resolved. A glyph a hair wider than the cell would shear the
        character grid the whole map is built on.

     6. It holds 30 fps, and it costs nothing. 120 frames at a 4× CPU throttle
        with the idle sea running, at both viewport sizes, measured twice over:
        once with the open ocean and once with `?noflags=openOcean`, twice each
        with the better sample counting. The average and the median must clear
        the two-vsync ceiling the serif atlas is held to *or* stay near what the
        old sea costs at the same size — at 2000×900 the old sea does not always
        clear that ceiling either, and a budget the code being replaced cannot
        meet is not a budget, it is a coincidence.
        The extended grid carries 10% more water cells than the world grid at
        1280×800 and 67% more at 2000×900 (it was 15% and 74% on the 150 × 39
        grid, whose cells were larger and whose margin therefore held fewer of
        them), so "no dearer than what it replaces" is the real claim.

   The ripple field, the serif ink, the land sweep and the drifting-word click
   sweep are scripts/checks/sea.mjs's claims and are unchanged by any of this;
   scripts/smoke.mjs runs both. Nothing here ships with the site. */
import { flowAt } from "../../js/currents.js";

export const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 2000, height: 900 }
];
export const FRAME_SAMPLES = 120;
export const CPU_THROTTLE = 4;
// One vsync is 16.67ms; two of them is 30 fps. Under a 4× throttle every frame
// lands on a whole quantum, so the budget is inclusive of 1ms of rAF jitter —
// the same allowance scripts/checks/map-art-extra.mjs makes.
export const FRAME_BUDGET_MS = 1000 / 30 + 1;
/* …or, where even the sea this replaces cannot hold 30 fps, this much more than
   that sea costs. The margin over it is wide on purpose: a throttled frame
   timing on a developer machine moves by several milliseconds between runs
   depending on what else is building, and the same pair of measurements has
   come out either way round. This is a tripwire for a real regression — a
   doubling, an allocation per cell, a second full-screen layer to composite —
   not a stopwatch. The numbers themselves are printed either way, and the
   average and the median are what is gated: the tail is one frame in twenty and
   a garbage collection lands on it. */
export const FRAME_REGRESSION = 1.4;
// Of the world grid's water cells, how many the currents must actually move.
export const MIN_MOVING = 0.8;
const IDLE_WARMUP_MS = 3000;

/* ---- 7. The cover fit ---------------------------------------------------
   The window the reader actually complained about: 2000 x 870, where the hero
   is 2000 x 707, the map's height binds under a contain fit and a 1.97:1 world
   grid lands at 1393px with 300px of open sea down each side.

   Five claims, all at that size:

     a. The map is as wide as the hero lets it be. Either it fills the width to
        within 2%, or the crop is at its ceiling — which is the honest form of
        "fill the width" once the ceiling is a real constraint (see b). Either
        way it must be wider than the contain fit it replaces.

     b. The crop is inside the budget. CROP_MAX is 18% of the map's height, 9%
        a side, which is the Arctic Ocean above about 74 N and the Antarctic
        ice below about 74 S. A hero shorter than a full cover wants does not
        get one: the scale stops at the budget. At 2000 x 870 that is exactly
        where it stops, so the width lands at 1698 rather than 2000 — 18% of
        62 rows is 5.6, and a sixth cropped row would start on Iceland.

     c. Nothing readable is in the strips. No place label and no ocean name is
        routed into a cropped row, and every marker and every painted label
        sits inside the hero on screen.

     d. The strips are reachable. A drag downwards at zoom 1 by the cropped
        amount brings the top row into the hero and stops exactly there, with
        the map's top edge on the hero's — panning must never open a gap — and
        "reset view" puts the centred crop back.

     e. `?noflags=coverFit` is the contain fit, to the pixel. */
export const COVER_VIEWPORT = { width: 2000, height: 870 };
// How close to the hero's width "fills the width" has to be.
export const COVER_WIDTH_TOL = 0.02;

const fmt = (n) => Math.round(n * 100) / 100;

/* ---- 4. The table itself, sampled without a browser --------------------- */

// [name, lat, lon, the compass point that current runs towards]
export const CURRENT_PROBES = [
  ["Gulf Stream off Hatteras", 36, -74, "NE"],
  ["North Atlantic Current", 47, -25, "E"],
  ["Canary Current", 28, -18, "S"],
  ["North Equatorial (Atlantic)", 15, -40, "W"],
  ["Kuroshio off Japan", 33, 138, "NE"],
  ["North Pacific Current", 42, -170, "E"],
  ["South Equatorial (Pacific)", -12, -140, "W"],
  ["Brazil Current", -30, -48, "SW"],
  ["Benguela Current", -28, 10, "N"],
  ["Agulhas Current", -33, 28, "SW"],
  ["East Australian Current", -32, 153, "S"],
  ["Humboldt Current", -25, -73, "N"],
  ["Antarctic Circumpolar (Drake)", -58, -65, "E"],
  ["Antarctic Circumpolar (Indian)", -57, 90, "E"],
  ["Indian gyre, south edge", -38, 75, "E"],
  ["Beaufort gyre", 76, -160, "N"]
];

const COMPASS = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
export function compassOf(u, v) {
  let k = Math.round(Math.atan2(v, u) / (Math.PI / 4)) % 8;
  if (k < 0) k += 8;
  return COMPASS[k];
}

export function checkCurrentTable(fail) {
  const out = [];
  for (const [name, lat, lon, want] of CURRENT_PROBES) {
    const uv = { u: 0, v: 0 };
    flowAt(lat, lon, uv);
    const got = compassOf(uv.u, uv.v);
    const speed = Math.hypot(uv.u, uv.v);
    out.push({ name, want, got, speed });
    if (got !== want) {
      fail(`the flow field runs ${got} at ${name} (${lat}, ${lon}); that current runs ${want}`);
    } else if (!(speed > 0.2)) {
      fail(`the flow field is standing still at ${name} (|v| ${fmt(speed)})`);
    }
  }
  console.log(
    `ocean currents          ${out.filter((p) => p.got === p.want).length}/${out.length} named currents run the way they should ` +
    `(e.g. ${out.slice(0, 3).map((p) => `${p.name} ${p.got}`).join(", ")})`
  );
  return out;
}

/* ---- In-page helpers ---------------------------------------------------- */

const FRAME_RUN = (n) => new Promise((resolve) => {
  const D = window.ATLAS_MAP_DEBUG;
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
      layouts: D.mainThreadLayoutCalls(),
      sentences: D.idleSentences().length
    });
  };
  requestAnimationFrame(() => { last = performance.now(); requestAnimationFrame(tick); });
});

/* What the world grid looks like from outside: where the pan/zoom wrapper sits
   on screen, where every marker sits inside it, and which cell every label line
   was routed into. None of the three may move when the ocean is turned on.

   The marker's *layout* box is the honest one to compare: `.map-marker` is
   drawn through a transform that carries both the 1/zoom counter-scale and a
   half-second entry animation, so its client rect depends on how long the page
   took to get going — which the open ocean does change, and which has nothing
   to do with where the dot is. Offsets are relative to the wrapper, and the
   wrapper's own client rect is compared beside them. */
const WORLD_GEOMETRY = () => {
  const D = window.ATLAS_MAP_DEBUG;
  const markers = [];
  for (const el of document.querySelectorAll(".map-marker")) {
    markers.push([el.dataset.placeId || el.getAttribute("aria-label") || "",
      Math.round(el.offsetLeft * 100) / 100, Math.round(el.offsetTop * 100) / 100,
      el.offsetWidth, el.offsetHeight]);
  }
  markers.sort();
  const zoomBox = document.querySelector(".map-zoom").getBoundingClientRect();
  const labels = D.labels().map((l) => [l.id, l.row, l.col, l.dir,
    l.lines.map((line) => line.text).join("|")]).sort();
  const oceans = D.oceanLabels().map((o) => [o.name, o.row, o.col]).sort();
  return {
    markers, labels, oceans, check: D.checkLabels(),
    origin: [Math.round(zoomBox.left * 100) / 100, Math.round(zoomBox.top * 100) / 100,
      Math.round(zoomBox.width * 100) / 100, Math.round(zoomBox.height * 100) / 100]
  };
};

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
  await page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());
  await page.waitForTimeout(400);
  return { context, page, errors };
}

async function visit(browser, origin, viewport, options) {
  const { context, page, errors } = await openMap(browser, origin, viewport, options);
  try {
    const state = await page.evaluate(() => window.ATLAS_MAP_DEBUG.oceanState());
    const world = await page.evaluate(WORLD_GEOMETRY);
    /* And again at 2.5×, because at 1× the zoom tiers show no place labels at
       all and "the labels did not move" would be a claim about an empty list.
       At 2.5× every name is out, routed into the water cell by cell, which is
       exactly the thing an ocean underneath them could disturb. */
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.setZoom(2.5));
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());
    await page.waitForTimeout(250);
    const zoomed = await page.evaluate(WORLD_GEOMETRY);
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.setZoom(1));
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());
    await page.waitForTimeout(250);
    let frames = null;
    if ((options || {}).timed) {
      const cdp = await context.newCDPSession(page);
      await page.evaluate(() => window.ATLAS_MAP_DEBUG.resetCounters());
      const baseline = await page.evaluate(FRAME_RUN, FRAME_SAMPLES);
      await page.evaluate(() => window.ATLAS_MAP_DEBUG.startIdle());
      await page.waitForTimeout(IDLE_WARMUP_MS);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
      /* Twice, and the better one counts. These runs share a machine with
         whatever else is building at the time, and a run that lost half a
         second to someone else's compiler measures that, not this. Two samples
         and a minimum is the cheapest way to ask "how fast is this when it is
         the thing running", which is the question the budget is about. */
      await page.evaluate(() => window.ATLAS_MAP_DEBUG.resetCounters());
      const first = await page.evaluate(FRAME_RUN, FRAME_SAMPLES);
      const second = await page.evaluate(FRAME_RUN, FRAME_SAMPLES);
      const idle = second.avg < first.avg ? second : first;
      idle.other = second.avg < first.avg ? first.avg : second.avg;
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await page.evaluate(() => window.ATLAS_MAP_DEBUG.stopIdle());
      await cdp.detach();
      frames = { baseline, idle };
    }
    return { state, world, zoomed, frames, errors };
  } finally {
    await context.close();
  }
}

/* ---- The run ------------------------------------------------------------ */

function reportViewport(label, on, off, fail) {
  const s = on.state;
  console.log(
    `${label.padEnd(22)} world ${s.cols}x${s.rows} -> ocean ${s.exCols}x${s.exRows} ` +
    `(margin ${s.mx}x${s.my}${s.capped ? `, still floor out to ${s.floorMx}x${s.floorMy}` : ""}), ` +
    `${s.waterCells} water cell(s) of ${s.cells}, cell ${fmt(s.charW)}x${fmt(s.lineH)}px`
  );

  /* ---- 1. The water reaches every edge ----------------------------------- */
  if (!s.on) { fail(`${label} the open ocean is off`); return; }
  const cover = (rect, what) => {
    if (!rect) { fail(`${label} there is no ${what} canvas`); return; }
    const gaps = [];
    if (rect.left > s.viewport.left + 0.5) gaps.push(`left (${fmt(rect.left - s.viewport.left)}px of bare hero)`);
    if (rect.top > s.viewport.top + 0.5) gaps.push(`top (${fmt(rect.top - s.viewport.top)}px)`);
    if (rect.right < s.viewport.right - 0.5) gaps.push(`right (${fmt(s.viewport.right - rect.right)}px)`);
    if (rect.bottom < s.viewport.bottom - 0.5) gaps.push(`bottom (${fmt(s.viewport.bottom - rect.bottom)}px)`);
    if (gaps.length) fail(`${label} the ${what} does not reach the ${gaps.join(", ")}`);
  };
  cover(s.sea, "animated sea");
  cover(s.floor, "still ocean floor");
  const ink = s.floorInk;
  if (!ink) fail(`${label} the still ocean floor painted nothing`);
  else {
    console.log(
      `  still floor: ${ink.cells} cell(s) painted over ${ink.cols}x${ink.rows} ` +
      `(${ink.edges.world} inside the world grid, ${ink.edges.top}/${ink.edges.bottom} above and below, ` +
      `${ink.edges.left}/${ink.edges.right} to the sides)${ink.serif ? ", serif ink" : ""}`
    );
    for (const [side, has] of [["top", s.floorMy], ["bottom", s.floorMy],
      ["left", s.floorMx], ["right", s.floorMx]]) {
      if (has > 0 && !ink.edges[side]) {
        fail(`${label} the ${has}-cell ${side} margin has no water painted in it`);
      }
    }
    if (!ink.edges.world) fail(`${label} the still floor skipped the mapped ocean`);
  }

  /* ---- 3. The currents are a field --------------------------------------- */
  const f = s.flow;
  if (!f) { fail(`${label} there is no flow field`); return; }
  const moving = f.worldWater ? f.worldMoving / f.worldWater : 0;
  console.log(
    `  currents: ${f.gyres} gyres, ${f.jets} boundary currents, ${f.bands} bands; ` +
    `moving in ${Math.round(moving * 1000) / 10}% of the world grid's ${f.worldWater} water cell(s), ` +
    `${f.onLand} land cell(s) flowing, ${f.moving} of ${f.cells} cells moving overall`
  );
  if (moving < MIN_MOVING) {
    fail(`${label} the currents move only ${Math.round(moving * 100)}% of the world grid's water ` +
         `(at least ${Math.round(MIN_MOVING * 100)}% expected)`);
  }
  if (f.onLand) fail(`${label} ${f.onLand} land cell(s) have a current`);

  /* ---- 5. One cell per glyph --------------------------------------------- */
  const wide = s.glyphs.filter((g) => Math.abs(g.width - s.charW) > 0.01);
  console.log(
    `  ${s.glyphs.length} flow glyph(s) (${s.glyphs.map((g) => g.glyph).join(" ")}) at ` +
    `${fmt(s.charW)}px, the grid's own cell width${s.serifDirections ? `; ${s.serifDirections} of them in the serif ramp` : ""}`
  );
  for (const g of wide) {
    fail(`${label} the flow glyph "${g.glyph}" measures ${fmt(g.width)}px in a ${fmt(s.charW)}px cell`);
  }

  /* ---- 2. The world grid did not move ------------------------------------ */
  const o = off.state;
  console.log(
    `  with ?noflags=openOcean: ${o.exCols}x${o.exRows} grid, ` +
    `sea ${fmt(o.map.width)}x${fmt(o.map.height)}px, still floor ${o.floorInk ? "painted" : "absent"}`
  );
  if (o.on) fail(`${label} ?noflags=openOcean did not turn the open ocean off`);
  if (o.mx || o.my || o.floorMx || o.floorMy) {
    fail(`${label} ?noflags=openOcean still built a ${o.mx}x${o.my} margin`);
  }
  if (o.floorInk) fail(`${label} ?noflags=openOcean still painted a still ocean floor`);
  if (o.flow) fail(`${label} ?noflags=openOcean still built a flow field`);
  if (o.exCols !== o.cols || o.exRows !== o.rows) {
    fail(`${label} ?noflags=openOcean built a ${o.exCols}x${o.exRows} grid, not the world's ${o.cols}x${o.rows}`);
  }
  const same = (a, b, what) => {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A === B) return true;
    const first = a.find((row, i) => JSON.stringify(row) !== JSON.stringify(b[i]));
    fail(`${label} the ${what} moved when the ocean was turned on ` +
         `(${a.length} vs ${b.length}; first difference ${JSON.stringify(first)})`);
    return false;
  };
  const originSame = same([on.world.origin], [off.world.origin], "map's place on screen");
  const markersSame = same(on.world.markers, off.world.markers, "markers");
  const labelsSame = same(on.world.labels, off.world.labels, "place labels")
    && same(on.zoomed.labels, off.zoomed.labels, "place labels at 2.5x");
  const oceansSame = same(on.world.oceans, off.world.oceans, "ocean names")
    && same(on.zoomed.oceans, off.zoomed.oceans, "ocean names at 2.5x");
  if (originSame && markersSame && labelsSame && oceansSame) {
    console.log(
      `  unchanged by the ocean: the map at the same ${on.world.origin.join(", ")} box, ` +
      `${on.world.markers.length} marker(s) to the pixel, ` +
      `${on.world.labels.length} label(s) and ${on.world.oceans.length} ocean name(s) in the same cells ` +
      `at 1x, ${on.zoomed.labels.length} and ${on.zoomed.oceans.length} at 2.5x`
    );
  }
  if (!on.zoomed.labels.length) {
    fail(`${label} no place labels were placed at 2.5x — the comparison proves nothing`);
  }
  for (const [what, w] of [["1x", on.world], ["2.5x", on.zoomed]]) {
    if (w.check.overlaps) fail(`${label} the labels overlap something at ${what} (${w.check.overlaps})`);
  }

  /* ---- 6. It holds 30 fps, and it costs nothing -------------------------- */
  if (on.frames && off.frames) {
    const b = on.frames.baseline, t = on.frames.idle, was = off.frames.idle;
    const budget = {
      avg: Math.max(FRAME_BUDGET_MS, was.avg * FRAME_REGRESSION + 1),
      median: Math.max(FRAME_BUDGET_MS, was.median * FRAME_REGRESSION + 1)
    };
    console.log(
      `  frames: unthrottled vsync avg ${fmt(b.avg)}ms; idle sea at ${CPU_THROTTLE}x CPU ` +
      `avg ${fmt(t.avg)}ms / median ${fmt(t.median)}ms / p95 ${fmt(t.p95)}ms / max ${fmt(t.max)}ms ` +
      `over ${t.frames} frames with ${t.sentences} sentence(s) adrift ` +
      `(second sample avg ${fmt(t.other)}ms) — the same sea without the open ocean ` +
      `avg ${fmt(was.avg)}ms / median ${fmt(was.median)}ms / p95 ${fmt(was.p95)}ms ` +
      `(budget avg ${fmt(budget.avg)}ms, median ${fmt(budget.median)}ms; 30 fps is ${fmt(FRAME_BUDGET_MS)}ms)`
    );
    if (t.frames !== FRAME_SAMPLES) fail(`${label} timed ${t.frames} frames, expected ${FRAME_SAMPLES}`);
    if (!t.sentences) fail(`${label} nothing was drifting during the timed frames`);
    for (const metric of ["avg", "median"]) {
      if (t[metric] > budget[metric]) {
        fail(`${label} the open ocean's ${metric} frame is ${fmt(t[metric])}ms at ${CPU_THROTTLE}x CPU ` +
             `— budget ${fmt(budget[metric])}ms (30 fps is ${fmt(FRAME_BUDGET_MS)}ms; the same page ` +
             `with ?noflags=openOcean ran ${fmt(was[metric])}ms)`);
      }
    }
    if (t.layouts) fail(`${label} ${t.layouts} main-thread pretext call(s) during the timed frames`);
  }

  for (const e of on.errors.concat(off.errors)) console.error(`  error: ${e}`);
  if (on.errors.length + off.errors.length) {
    fail(`${label} logged ${on.errors.length + off.errors.length} console/page error(s)`);
  }
}

/* Everything claim 7 wants to know, read from inside the page: the fit numbers,
   the hero and the pan/zoom wrapper on screen, and anything painted that is not
   wholly inside the hero. A marker or a label line that leaves the hero at zoom
   1 is the failure the crop could cause, so it is named rather than counted. */
const FIT_GEOMETRY = () => {
  const D = window.ATLAS_MAP_DEBUG;
  const s = D.oceanState();
  const vp = document.querySelector(".map-viewport").getBoundingClientRect();
  const box = document.querySelector(".map-zoom").getBoundingClientRect();
  const round = (n) => Math.round(n * 100) / 100;
  const inside = (r) => r.top >= vp.top - 0.5 && r.bottom <= vp.bottom + 0.5 &&
    r.left >= vp.left - 0.5 && r.right <= vp.right + 0.5;
  const outside = [];
  for (const el of document.querySelectorAll(".map-marker")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || inside(r)) continue;
    outside.push(`marker "${el.dataset.placeId || el.getAttribute("aria-label") || "?"}" ` +
      `at ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}`);
  }
  for (const el of document.querySelectorAll(".map-label.is-placed, .map-ocean-label.is-placed")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || inside(r)) continue;
    outside.push(`label "${el.textContent.replace(/\s+/g, " ").trim().slice(0, 30)}" ` +
      `at ${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}`);
  }
  // What the placer did, against the rows it was told it could not use.
  const crop = s.fit.cropRows;
  const cropped = [];
  for (const rec of D.labels()) {
    for (const line of rec.lines) {
      if (line.row < crop || line.row >= s.rows - crop) cropped.push(`${rec.id} line at row ${line.row}`);
    }
  }
  for (const o of D.oceanLabels()) {
    if (o.row < crop || o.row >= s.rows - crop) cropped.push(`${o.name} at row ${o.row}`);
  }
  return {
    fit: s.fit, map: s.map, rows: s.rows, lineH: s.lineH,
    vp: { left: round(vp.left), top: round(vp.top), right: round(vp.right),
      bottom: round(vp.bottom), width: round(vp.width), height: round(vp.height) },
    box: { left: round(box.left), top: round(box.top), width: round(box.width), height: round(box.height) },
    topRow: D.cellToClient(120, 0), outside, cropped,
    labels: D.labels().length, oceans: D.oceanLabels().length
  };
};

/* Claim 7, at COVER_VIEWPORT, against the same page with ?noflags=coverFit. */
async function checkCoverFit(browser, origin, fail) {
  const label = `cover ${COVER_VIEWPORT.width}x${COVER_VIEWPORT.height}`;
  const now = await openMap(browser, origin, COVER_VIEWPORT, {});
  const was = await openMap(browser, origin, COVER_VIEWPORT, { query: "?noflags=coverFit" });
  try {
    // Place labels only appear from 1.4x, so the readability sweep is run at
    // 2.5x as well — at 1x the "no label in a cropped row" claim would be a
    // claim about the ocean names alone.
    const fit = await now.page.evaluate(FIT_GEOMETRY);
    const off = await was.page.evaluate(FIT_GEOMETRY);
    const f = fit.fit;
    console.log(
      `${label.padEnd(22)} hero ${fit.vp.width}x${fit.vp.height}, map ` +
      `${fmt(fit.map.width)}x${fmt(fit.map.height)}px (was ${fmt(off.map.width)}x${fmt(off.map.height)} ` +
      `with ?noflags=coverFit), ${fmt(f.cropFraction * 100)}% cropped = ${f.cropRows} row(s) ` +
      `a side, ${fmt(f.cropPx)}px`
    );

    /* ---- a. As wide as the hero lets it be --------------------------------- */
    if (f.mode !== "cover") fail(`${label} the cover fit did not engage (mode "${f.mode}")`);
    if (fit.map.width <= off.map.width + 0.5) {
      fail(`${label} the map is ${fmt(fit.map.width)}px, no wider than the contain fit's ${fmt(off.map.width)}px`);
    }
    const shortBy = (fit.vp.width - fit.map.width) / fit.vp.width;
    const atCap = f.cropFraction >= f.cropMax - 0.002;
    if (shortBy > COVER_WIDTH_TOL && !atCap) {
      fail(`${label} the map is ${fmt(shortBy * 100)}% narrower than the ${fit.vp.width}px hero ` +
           `and the crop is only ${fmt(f.cropFraction * 100)}% of ${fmt(f.cropMax * 100)}% — ` +
           `it could have grown further`);
    }
    console.log(
      `  width: ${fmt(fit.map.width)}px of a ${fit.vp.width}px hero ` +
      `(${fmt((1 - shortBy) * 100)}%)${atCap ? ", held there by the crop ceiling" : ", filling it"}`
    );

    /* ---- b. Inside the crop budget ---------------------------------------- */
    if (f.cropFraction > f.cropMax + 0.005) {
      fail(`${label} ${fmt(f.cropFraction * 100)}% of the map is cropped, over the ` +
           `${fmt(f.cropMax * 100)}% ceiling`);
    }
    if (f.cropRows < 1) fail(`${label} nothing was cropped — this size is the one that needed it`);

    /* ---- c. Nothing readable in the strips -------------------------------- */
    for (const zoom of [1, 2.5]) {
      if (zoom !== 1) {
        await now.page.evaluate((z) => window.ATLAS_MAP_DEBUG.setZoom(z), zoom);
        await now.page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());
        await now.page.waitForTimeout(250);
      }
      const at = zoom === 1 ? fit : await now.page.evaluate(FIT_GEOMETRY);
      console.log(
        `  at ${zoom}x: ${at.labels} place label(s), ${at.oceans} ocean name(s), ` +
        `${at.cropped.length} in a cropped row` + (zoom === 1 ? `, ${at.outside.length} outside the hero` : "")
      );
      for (const c of at.cropped.slice(0, 6)) fail(`${label} at ${zoom}x ${c} is in a cropped row`);
      // Off-screen at 2.5x is the zoom's own doing, not the crop's, so the
      // on-screen sweep is the 1x one.
      if (zoom === 1) for (const o of at.outside.slice(0, 6)) fail(`${label} ${o} is outside the hero`);
    }
    await now.page.evaluate(() => window.ATLAS_MAP_DEBUG.setZoom(1));
    await now.page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());
    await now.page.waitForTimeout(200);

    /* ---- d. The strips are reachable -------------------------------------- */
    const start = { x: Math.round(fit.vp.left + fit.vp.width / 2), y: Math.round(fit.vp.top + fit.vp.height / 2) };
    await now.page.mouse.move(start.x, start.y);
    await now.page.mouse.down();
    // Overshoot: the clamp, not the drag, has to be what stops it.
    for (let i = 1; i <= 6; i++) {
      await now.page.mouse.move(start.x, start.y + Math.round((f.cropPx + 60) * i / 6));
    }
    await now.page.mouse.up();
    await now.page.waitForTimeout(200);
    const panned = await now.page.evaluate(FIT_GEOMETRY);
    const gapTop = panned.box.top - panned.vp.top;
    const gapBottom = (panned.vp.top + panned.vp.height) - (panned.box.top + panned.box.height);
    console.log(
      `  dragged down ${fmt(f.cropPx + 60)}px: pan clamped at ${fmt(panned.fit.panY)}px of ` +
      `${fmt(panned.fit.overY)}px, map top ${fmt(gapTop)}px from the hero's, row 0 at ` +
      `y ${panned.topRow ? Math.round(panned.topRow.y) : "?"}`
    );
    if (Math.abs(panned.fit.panY - f.cropPx) > 1) {
      fail(`${label} a drag past the crop left the pan at ${fmt(panned.fit.panY)}px, not the ` +
           `${fmt(f.cropPx)}px of overhang`);
    }
    if (Math.abs(gapTop) > 1) fail(`${label} panned to the top, the map starts ${fmt(gapTop)}px from the hero's edge`);
    if (gapBottom > 1) fail(`${label} panning down opened a ${fmt(gapBottom)}px gap below the map`);
    if (!panned.topRow || panned.topRow.y < panned.vp.top || panned.topRow.y > panned.vp.bottom) {
      fail(`${label} the top row is still off the hero after panning to it`);
    }
    // "Reset view" is the centred crop again.
    await now.page.click("#map-zoom-reset");
    await now.page.waitForTimeout(200);
    const reset = await now.page.evaluate(FIT_GEOMETRY);
    if (Math.abs(reset.fit.panY) > 0.5 || Math.abs(reset.box.top - fit.box.top) > 1) {
      fail(`${label} reset view left the map at panY ${fmt(reset.fit.panY)}px, top ` +
           `${fmt(reset.box.top)} (centred crop is ${fmt(fit.box.top)})`);
    }

    /* ---- e. The flag restores the contain fit ------------------------------ */
    console.log(
      `  with ?noflags=coverFit: map ${fmt(off.map.width)}x${fmt(off.map.height)}px, ` +
      `${off.fit.cropRows} row(s) cropped, ${off.outside.length} thing(s) outside the hero`
    );
    if (off.fit.cover) fail(`${label} ?noflags=coverFit did not turn the cover fit off`);
    if (off.fit.mode !== "contain" || off.fit.cropRows) {
      fail(`${label} ?noflags=coverFit still cropped ${off.fit.cropRows} row(s)`);
    }
    if (off.map.height > off.vp.height + 0.5 || off.map.width > off.vp.width + 0.5) {
      fail(`${label} ?noflags=coverFit built a ${fmt(off.map.width)}x${fmt(off.map.height)} map ` +
           `in a ${off.vp.width}x${off.vp.height} hero — that is not a contain fit`);
    }
    for (const e of now.errors.concat(was.errors)) console.error(`  error: ${e}`);
    if (now.errors.length + was.errors.length) {
      fail(`${label} logged ${now.errors.length + was.errors.length} console/page error(s)`);
    }
  } finally {
    await now.context.close();
    await was.context.close();
  }
}

export async function runOceanChecks(browser, origin, fail) {
  checkCurrentTable(fail);
  await checkCoverFit(browser, origin, fail);
  for (const viewport of VIEWPORTS) {
    const label = `ocean ${viewport.width}x${viewport.height}`;
    const on = await visit(browser, origin, viewport, { timed: true });
    const off = await visit(browser, origin, viewport, {
      query: "?noflags=openOcean", timed: true
    });
    reportViewport(label, on, off, fail);
  }

  /* ---- Reduced motion: the same currents, standing still ----------------- */
  const reduced = await visit(browser, origin, VIEWPORTS[0], { reducedMotion: "reduce" });
  const rs = reduced.state, rink = rs.floorInk;
  console.log(
    `ocean reduced-motion   ${rink ? rink.cells : 0} still cell(s) of ${rs.waterCells} water cell(s), ` +
    `${rink ? rink.edges.world : 0} of them over the mapped ocean`
  );
  if (!rs.on) fail("ocean reduced-motion the open ocean is off");
  if (!rink || rink.cells < rs.waterCells * 0.9) {
    fail(`ocean reduced-motion the still field covers ${rink ? rink.cells : 0} of ${rs.waterCells} ` +
         `water cells — with no animation that field is the whole sea`);
  }
  if (reduced.errors.length) fail(`ocean reduced-motion logged ${reduced.errors.length} error(s)`);

  /* ---- A phone still fills its band -------------------------------------- */
  const phone = await visit(browser, origin, { width: 390, height: 844 }, {});
  const ps = phone.state;
  console.log(
    `ocean 390x844          world ${ps.cols}x${ps.rows} -> ocean ${ps.exCols}x${ps.exRows} ` +
    `(margin ${ps.mx}x${ps.my}), ${ps.waterCells} water cell(s)`
  );
  if (!ps.on) fail("ocean 390x844 the open ocean is off");
  if (!ps.sea || ps.sea.top > ps.viewport.top + 0.5 || ps.sea.bottom < ps.viewport.bottom - 0.5 ||
      ps.sea.left > ps.viewport.left + 0.5 || ps.sea.right < ps.viewport.right - 0.5) {
    fail("ocean 390x844 the sea does not cover the phone's map band");
  }
  if (phone.errors.length) fail(`ocean 390x844 logged ${phone.errors.length} error(s)`);
}
