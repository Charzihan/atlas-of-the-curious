/* Atlas of the Curious — automated text-overflow checks.

   The dataset validator (scripts/validate-data.mjs) can prove a place is
   well-formed, but not that its name fits in a card. That needs a real font
   engine, so this script starts the dev server, opens test/text-check.html in
   headless Chromium and reports what the page measured through the font-role
   registry in css/style.css.

   Phase 4 adds a second page, test/locale-check.html: the same string laid out
   by pretext (under its own locale) and by the browser, at three widths, for a
   Japanese, a Thai, an Arabic and a Simplified-Chinese sample.

   Fails (exit 1) when:
     - a place name needs more than two lines in a grid card at the card widths
       for 320 / 768 / 1280px viewports,
     - a category chip label breaks across lines,
     - a hover-card tagline needs more than three lines,
     - pretext and the browser break one of the locale samples differently,
     - a Thai or Arabic break falls inside an Intl.Segmenter word.

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
  let locale;
  const consoleErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(`${server.origin}/test/text-check.html`, { waitUntil: "load" });
    await page.waitForFunction(() => !!window.__ATLAS_TEXT_CHECK, null, { timeout: 15000 });
    result = await page.evaluate(() => window.__ATLAS_TEXT_CHECK);

    // Phase 4: the locale line-breaking fixture, in its own page.
    const localePage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    localePage.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    localePage.on("pageerror", (e) => consoleErrors.push(String(e)));
    await localePage.goto(`${server.origin}/test/locale-check.html`, { waitUntil: "load" });
    await localePage.waitForFunction(() => !!window.__ATLAS_LOCALE_CHECK, null, { timeout: 15000 });
    locale = await localePage.evaluate(() => window.__ATLAS_LOCALE_CHECK);
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

  /* ---- Phase 4: locale line breaking -------------------------------- */
  if (locale && locale.error) {
    console.error(`\nerror: ${locale.error}`);
    process.exit(1);
  }
  if (locale) {
    console.log(
      `\nlocale line breaks: ${locale.samples.length} sample(s) x ` +
      `${locale.widths.length} width(s), role "${locale.role}" ` +
      `(${locale.font.font}); ${locale.prep.groups} locale group(s), ` +
      `${locale.prep.prepared} string(s) prepared`
    );
    for (const s of locale.samples) {
      const rows = locale.results.filter((r) => r.sample === s.id);
      const cells = rows.map((r) => {
        const words = r.wordBreaks
          ? `, ${r.wordBreaks.checked} break(s) on word boundaries`
          : "";
        return `${r.width}px → ${r.predictedLines}/${r.renderedLines} line(s)` +
          `${r.match ? "" : (s.informational ? " differs" : " MISMATCH")}${words}`;
      });
      console.log(
        `  ${s.label.padEnd(32)} [${s.locale}, word-break: ${s.wordBreak}]` +
        (s.informational ? " (informational)" : "") + " " +
        cells.join("; ")
      );
    }
    if (locale.notes && locale.notes.length) {
      console.log(
        `  note: ${locale.notes.length} informational difference(s) — ` +
        "`word-break: keep-all` makes an overlong CJK run one unbreakable " +
        "word, so the break is pretext's documented-approximate " +
        "`overflow-wrap: break-word` fallback. No native name in the dataset " +
        "is long enough to reach it (pnpm smoke asserts that)."
      );
    }
    if (locale.langDrift.length) {
      console.log(
        `  note: ${locale.langDrift.length} sample/width pair(s) render a ` +
        "different number of lines once the element carries its `lang` " +
        "(Chromium picks a different fallback face than the untagged canvas):"
      );
      for (const d of locale.langDrift) {
        console.log(`    ${d.sample} at ${d.width}px: ${d.untagged} → ${d.tagged} line(s)`);
      }
    } else {
      console.log("  note: adding `lang` to the element changed no sample's line breaks");
    }
  }

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

  if (locale && locale.failures.length) {
    console.error(`\n${locale.failures.length} locale line-breaking failure(s):`);
    for (const f of locale.failures) {
      console.error(`  - [${f.rule}] ${f.sample} at ${f.width}px`);
      if (f.predicted) console.error(`      pretext: ${JSON.stringify(f.predicted)}`);
      if (f.actual) console.error(`      browser: ${JSON.stringify(f.actual)}`);
      if (f.detail) console.error(`      inside: ${JSON.stringify(f.detail)}`);
    }
    process.exit(1);
  }

  console.log(
    "\nOK: no place name, chip label or hover tagline overflows, and pretext " +
    "breaks every locale sample where the browser does."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
