/* Atlas of the Curious — automated text-overflow checks.

   The dataset validator (scripts/validate-data.mjs) can prove a place is
   well-formed, but not that its name fits in a card. That needs a real font
   engine, so this script starts the dev server, opens test/text-check.html in
   headless Chromium and reports what the page measured through the font-role
   registry in css/style.css.

   Fails (exit 1) when:
     - a place name needs more than two lines in a grid card at the card widths
       for 320 / 768 / 1280px viewports,
     - a category chip label breaks across lines,
     - a hover-card tagline needs more than three lines.

   If the browser cannot be launched it prints the install command and exits 0
   (the dataset validation still ran) — unless --strict is passed.

   Run: pnpm validate  (or: node scripts/check-text.mjs [--strict]) */
import { startServer, launchChromium, INSTALL_HINT } from "./browser-harness.mjs";
import { readFileSync } from "node:fs";

const strict = process.argv.includes("--strict");

// test/text-check.js re-implements js/app.js's masonry column heuristic (a
// classic-script IIFE cannot be imported from a module). Assert the original
// is still what the copy claims, so the two cannot drift apart unnoticed.
function assertMasonryHeuristicUnchanged() {
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  const expected = [
    "var GAP = 16;",
    "if (w <= 520) return 1;",
    "var minCol = 100 + w * 0.1;",
    "var n = Math.floor((w + GAP) / (minCol + GAP));",
    "return Math.max(2, n);"
  ];
  const missing = expected.filter((line) => !app.includes(line));
  if (missing.length) {
    console.error(
      "\njs/app.js's masonry heuristic changed; update the copy in test/text-check.js.\n" +
      "Lines no longer found in js/app.js:"
    );
    for (const line of missing) console.error(`  - ${line}`);
    process.exit(1);
  }
}

function skip(reason) {
  console.warn(`\nwarning: skipping the text overflow checks — ${reason}`);
  console.warn(`  install the browser with: ${INSTALL_HINT}`);
  if (strict) {
    console.error("  --strict was passed, so this is an error.");
    process.exit(1);
  }
  process.exit(0);
}

function fmt(n) { return Math.round(n * 100) / 100; }

async function main() {
  assertMasonryHeuristicUnchanged();

  const { browser, reason } = await launchChromium();
  if (!browser) skip(reason);

  let server;
  try {
    server = await startServer();
  } catch (err) {
    await browser.close();
    console.error(`\nerror: ${err.message}`);
    process.exit(1);
  }

  let result;
  const consoleErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(`${server.origin}/test/text-check.html`, { waitUntil: "load" });
    await page.waitForFunction(() => !!window.__ATLAS_TEXT_CHECK, null, { timeout: 15000 });
    result = await page.evaluate(() => window.__ATLAS_TEXT_CHECK);
  } catch (err) {
    console.error(`\nerror: the check page failed to run — ${err.message}`);
    await server.stop();
    await browser.close();
    process.exit(1);
  } finally {
    if (server) await server.stop();
    await browser.close();
  }

  if (result.error) {
    console.error(`\nerror: ${result.error}`);
    process.exit(1);
  }

  console.log(
    `text checks: ${result.places} places, ${result.roles.length} font roles ` +
    "(headless Chromium)"
  );
  for (const g of result.geometry) {
    console.log(
      `  ${String(g.viewportWidth).padStart(4)}px viewport → ${g.columns} column(s), ` +
      `card ${fmt(g.columnWidth)}px, text ${fmt(g.cardTextWidth)}px`
    );
  }
  console.log(`  hover card text box ${fmt(result.hoverCardWidth)}px (.map-card-tag)`);
  console.log(
    `  worst case: name ${result.worst.nameLines} line(s) (max 2), ` +
    `chip ${result.worst.chipLines} line(s) (max 1), ` +
    `hover tagline ${result.worst.hoverTaglineLines} line(s) (max 3)`
  );

  if (consoleErrors.length) {
    console.error(`\n${consoleErrors.length} console error(s) on the check page:`);
    for (const e of consoleErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (result.failures.length) {
    console.error(`\n${result.failures.length} text overflow failure(s):`);
    for (const f of result.failures) {
      console.error(`  - [${f.rule}] ${f.subject}`);
      console.error(`      at ${f.where}: ${f.lines} lines — ${f.detail}`);
    }
    process.exit(1);
  }

  console.log("\nOK: no place name, chip label or hover tagline overflows.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
