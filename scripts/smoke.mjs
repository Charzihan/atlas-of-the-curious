/* Atlas of the Curious — smoke test.

   Opens the real index.html in headless Chromium at a desktop and a phone
   viewport, waits for the text-metrics module and the Text Atlas to come up,
   and fails on any console error or uncaught page error. Meant to be re-run
   after every roadmap phase.

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

async function visit(browser, origin, viewport) {
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
    await page.goto(`${origin}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.ATLAS_TEXT_READY === true, null, { timeout: 15000 });
    await page.waitForSelector(".map-stage .map-marker", { timeout: 15000 });
    // The dev agreement check runs on a rAF after load.
    await page.waitForFunction(() => !!window.ATLAS_TEXT_AGREEMENT, null, { timeout: 15000 });

    const stats = await page.evaluate(() => ({
      cards: document.querySelectorAll("#grid .card").length,
      markers: document.querySelectorAll(".map-marker").length,
      roles: window.ATLAS_TEXT ? window.ATLAS_TEXT.roleNames().length : 0,
      agreement: window.ATLAS_TEXT_AGREEMENT
    }));
    return { stats, errors, warnings, ignored };
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
      const { stats, errors, warnings, ignored } = await visit(browser, server.origin, viewport);
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
