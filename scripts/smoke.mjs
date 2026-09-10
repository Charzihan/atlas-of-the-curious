/* Atlas of the Curious — smoke test.

   Opens the real index.html in headless Chromium at a desktop and a phone
   viewport, waits for the text-metrics module and the Text Atlas to come up,
   and fails on any console error or uncaught page error. Meant to be re-run
   after every roadmap phase.

   Phase 1 adds three claims about the labels on the map, each driven through
   window.ATLAS_MAP_DEBUG rather than synthetic pointer events:

     1. At 1.5× and 2.5× no label cell overlaps land, another place label or an
        ocean name — checked twice over, once from the placement records
        (checkLabels) and once from the painted DOM boxes mapped back onto the
        grid (checkPainted), and at least MIN_LABELS names are actually placed.
     2. No tagline in the hover card ends on a one-word last line, for all 40.
     3. A scripted zoom from 1× to 2.5× over 60 frames stays smooth. See
        PERF_NOTE below for what "smooth" can mean in headless Chromium.

   Run: pnpm smoke  (or: node scripts/smoke.mjs) */
import { startServer, launchChromium, INSTALL_HINT } from "./browser-harness.mjs";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 }
];

// Console messages that are advisories about the page's environment rather
// than faults in the page. Each one is listed explicitly, never a wildcard.
//   - frame-ancestors: only settable as an HTTP header, but the site is hosted
//     as static files, so the meta CSP declares it anyway and the browser says
//     (correctly) that it ignored that one directive.
const BENIGN_CONSOLE = [
  /'frame-ancestors' is ignored when delivered via a <meta> element/
];
const isBenign = (text) => BENIGN_CONSOLE.some((re) => re.test(text));

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

// Wait for `n` painted frames.
const settle = (page, n = 2) =>
  page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

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
  await settle(page);
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

async function visit(browser, origin, viewport, options) {
  const query = (options && options.query) || "";
  const errors = [];
  const warnings = [];
  const ignored = [];
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
    await settle(page, 2);

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

    if (options && options.perfOnly) {
      return { stats, errors, warnings, ignored, perf: await page.evaluate(ZOOM_RUN) };
    }

    let map = null;
    if (viewport.name === "desktop") {
      map = { zooms: [], perf: null, taglines: null };
      for (const z of LABEL_ZOOMS) map.zooms.push(await labelsAt(page, z));
      await page.evaluate(() => window.ATLAS_MAP_DEBUG.setZoom(1));
      await settle(page);
      map.taglines = await taglineWidows(page);
      map.perf = await page.evaluate(ZOOM_RUN);
    }
    return { stats, errors, warnings, ignored, map };
  } finally {
    await context.close();
  }
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
  try {
    server = await startServer();
    for (const viewport of VIEWPORTS) {
      const { stats, errors, warnings, ignored, map } = await visit(browser, server.origin, viewport);
      const label = `${viewport.name} ${viewport.width}x${viewport.height}`;
      console.log(
        `${label.padEnd(22)} cards ${stats.cards}, markers ${stats.markers}, ` +
        `roles ${stats.roles}, agreement ${stats.agreement.checked} card(s)/` +
        `${stats.agreement.warnings} warning(s), console warnings ${warnings.length}` +
        (ignored.length ? `, ${ignored.length} benign advisory(ies)` : "") +
        (errors.length ? `, ERRORS ${errors.length}` : "")
      );
      for (const w of warnings) console.log(`  warning: ${w}`);
      for (const i of ignored) console.log(`  ignored (known benign): ${i}`);
      if (!stats.cards || !stats.markers) {
        console.error(`  error: ${label} rendered no cards or no markers`);
        failed = true;
      }
      if (stats.agreement.warnings > 0) {
        console.error(`  error: ${label} had ${stats.agreement.warnings} metrics disagreement(s)`);
        failed = true;
      }
      if (!stats.mapDebug) {
        console.error(`  error: ${label} did not publish window.ATLAS_MAP_DEBUG`);
        failed = true;
      }

      // ---- Phase 1: labels on the map ---------------------------------
      if (viewport.name === "phone") {
        // Below 640px the hover card carries the name; nothing is routed.
        console.log(
          `  labels: ${stats.labelsNow} place, ${stats.oceanLabelsNow} ocean ` +
          "(expected 0 and 0 on a phone)"
        );
        if (stats.labelsNow || stats.oceanLabelsNow) {
          console.error(`  error: ${label} rendered labels below the 640px cut-off`);
          failed = true;
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
            console.error(`  error: ${label} at ${z.zoom.toFixed(2)}x has overlapping labels`);
            for (const p of z.problems.concat(z.paintedProblems).slice(0, 8)) {
              console.error(`      ${p.what} "${p.id}" cell r${p.row} c${p.col}: ${p.why}`);
            }
            failed = true;
          }
          if (z.labels < MIN_LABELS) {
            console.error(
              `  error: only ${z.labels} label(s) placed at ${z.zoom.toFixed(2)}x ` +
              `(expected more than ${MIN_LABELS - 1})`
            );
            failed = true;
          }
          if (z.labels !== z.domLabels || z.oceanLabels !== z.domOceanLabels) {
            console.error(
              `  error: placement records (${z.labels}/${z.oceanLabels}) and the DOM ` +
              `(${z.domLabels}/${z.domOceanLabels}) disagree at ${z.zoom.toFixed(2)}x`
            );
            failed = true;
          }
        }

        const t = map.taglines;
        console.log(
          `  hover cards: ${t.checked} checked, ${t.widows.length} one-word last line(s), ` +
          `width ${Math.round(t.narrowest)}–${Math.round(t.widest)}px`
        );
        if (t.checked !== stats.cards) {
          console.error(`  error: only ${t.checked} of ${stats.cards} hover cards could be shown`);
          failed = true;
        }
        if (t.widows.length) {
          console.error(`  error: ${t.widows.length} tagline(s) end on a single word:`);
          for (const w of t.widows) console.error(`      ${w}`);
          failed = true;
        }

        // Baseline for the frame timing: the same zoom with the labels off.
        const base = await visit(browser, server.origin, viewport, {
          query: "?noflags=labels,oceanLabels", perfOnly: true
        });
        const p = map.perf, b = base.perf;
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
          console.error(`  error: average frame ${p.avg.toFixed(2)}ms exceeds ${MAX_FRAME_MS}ms`);
          failed = true;
        }
        if (overhead > MAX_FRAME_OVERHEAD_MS) {
          console.error(
            `  error: labels add ${overhead.toFixed(2)}ms per frame ` +
            `(budget ${MAX_FRAME_OVERHEAD_MS}ms)`
          );
          failed = true;
        }
        if (p.placeAvgMs > MAX_PLACEMENT_MS) {
          console.error(
            `  error: a placement pass averages ${p.placeAvgMs.toFixed(2)}ms ` +
            `(budget ${MAX_PLACEMENT_MS}ms)`
          );
          failed = true;
        }
        if (!p.placements) {
          console.error("  error: zooming from 1x to 2.5x triggered no label placement");
          failed = true;
        }
        for (const e of base.errors) console.error(`  error (labels off): ${e}`);
        if (base.errors.length) failed = true;
      }

      for (const e of errors) console.error(`  error: ${e}`);
      if (errors.length) failed = true;
    }
  } catch (err) {
    console.error(`\nerror: ${err.message}`);
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
