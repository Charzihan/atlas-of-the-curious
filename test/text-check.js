/* Overflow checks that need a real font engine, run in the page.

   scripts/check-text.mjs serves this page, opens it in headless Chromium and
   reads `window.__ATLAS_TEXT_CHECK`. Everything measured here goes through
   window.ATLAS_TEXT (js/text.js), i.e. through the font-role registry in
   css/style.css — so a font change in the CSS is a font change in the check.

   Three rules, one per place the atlas can visibly overflow:
     1. a place name may not need more than 2 lines in a grid card,
     2. a category chip label may not break across lines,
     3. a hover-card tagline may not need more than 3 lines. */

// ---- Grid geometry -------------------------------------------------------
// Mirrors the masonry column logic in js/app.js (colCountFor + layoutMasonry)
// and the .wrap / .card box model in css/style.css. scripts/check-text.mjs
// asserts that js/app.js still contains this heuristic, so the copy cannot
// drift silently.
const WRAP_MAX = 1080;   // .wrap { max-width: 1080px }
const WRAP_PAD = 20;     // .wrap { padding: 0 20px }
const GAP = 16;          // js/app.js: var GAP = 16
const CARD_PAD = 18;     // .card { padding: 18px }
const CHIP_PAD_X = 13;   // .chip { padding: 7px 13px }
const CHIP_BORDER = 1;   // .chip { border: 1px solid }

// Hover card: js/map.js's CARD_W only decides which side of a marker the card
// flips to — the card itself is sized by .map-card in css/style.css (a fixed
// 252px at every viewport). So build a real, off-screen .map-card and read the
// content box of its .map-card-tag: the exact width js/map.js wraps at.
const HOVER_CARD_FALLBACK_WIDTH = 252 - 2 /* border */ - 14 * 2 /* padding */;
function hoverCardTextWidth() {
  const card = document.createElement("div");
  card.className = "map-card";
  const tag = document.createElement("pre");
  tag.className = "map-card-tag";
  tag.textContent = "M";
  card.appendChild(tag);
  document.body.appendChild(card);
  const width = tag.clientWidth || HOVER_CARD_FALLBACK_WIDTH;
  card.remove();
  return width;
}

const VIEWPORTS = [320, 768, 1280];

const MAX_NAME_LINES = 2;
const MAX_CHIP_LINES = 1;
const MAX_HOVER_TAGLINE_LINES = 3;

function colCountFor(w) {
  if (w <= 520) return 1;
  const minCol = 100 + w * 0.1;
  const n = Math.floor((w + GAP) / (minCol + GAP));
  return Math.max(2, n);
}

function geometryFor(viewportWidth) {
  const wrapWidth = Math.min(WRAP_MAX, viewportWidth) - WRAP_PAD * 2;
  const columns = colCountFor(wrapWidth);
  const columnWidth = (wrapWidth - GAP * (columns - 1)) / columns;
  return {
    viewportWidth,
    wrapWidth,
    columns,
    columnWidth,
    cardTextWidth: columnWidth - CARD_PAD * 2,
    chipTextWidth: wrapWidth - CHIP_PAD_X * 2 - CHIP_BORDER * 2
  };
}

// ---- The checks ----------------------------------------------------------

function run() {
  const T = window.ATLAS_TEXT;
  const DATA = window.ATLAS_DATA;
  if (!T) throw new Error("window.ATLAS_TEXT is missing (js/text.js did not boot)");
  if (!DATA || !DATA.places || !DATA.places.length) throw new Error("window.ATLAS_DATA is missing");

  const failures = [];
  const geometry = VIEWPORTS.map(geometryFor);

  // 1. Place names in grid cards.
  for (const g of geometry) {
    for (const p of DATA.places) {
      const lines = T.linesOf("card-name", p.id, g.cardTextWidth);
      if (lines.length > MAX_NAME_LINES) {
        failures.push({
          rule: "card name over " + MAX_NAME_LINES + " lines",
          where: g.viewportWidth + "px viewport (" + g.columns + " col, card text " +
                 round(g.cardTextWidth) + "px)",
          subject: p.name,
          lines: lines.length,
          detail: lines.join(" / ")
        });
      }
    }
  }

  // 2. Category chip labels. A chip is never allowed to break: it is a pill.
  // Measured at the `chip` role's normal weight. The selected chip renders
  // bold (.chip.active) and so is a few percent wider; the labels clear the
  // narrowest chip row by ~100px, so that margin is not close to mattering.
  const chipLabels = DATA.categories.map(function (c) {
    const count = DATA.places.filter(function (p) { return p.category === c.id; }).length;
    return c.label + " · " + count; // exactly what js/app.js renderChips() writes
  }).concat(["All"]);
  for (const g of geometry) {
    for (const label of chipLabels) {
      const lines = T.lineCountOfText("chip", label, g.chipTextWidth);
      if (lines > MAX_CHIP_LINES) {
        failures.push({
          rule: "chip label breaks across lines",
          where: g.viewportWidth + "px viewport (chip room " + round(g.chipTextWidth) + "px)",
          subject: label,
          lines: lines,
          detail: T.linesOfText("chip", label, g.chipTextWidth).join(" / ")
        });
      }
    }
  }

  // 3. Hover-card taglines, at the width the CSS actually gives them.
  const hoverWidth = hoverCardTextWidth();
  for (const p of DATA.places) {
    const lines = T.linesOfText("hover-card", p.tagline, hoverWidth);
    if (lines.length > MAX_HOVER_TAGLINE_LINES) {
      failures.push({
        rule: "hover-card tagline over " + MAX_HOVER_TAGLINE_LINES + " lines",
        where: ".map-card-tag content box, " + round(hoverWidth) + "px",
        subject: p.name,
        lines: lines.length,
        detail: lines.join(" / ")
      });
    }
  }

  // Widest observed values, useful when a check starts to get close.
  const worst = {
    nameLines: max(geometry, function (g) {
      return max(DATA.places, function (p) { return T.lineCountOf("card-name", p.id, g.cardTextWidth); });
    }),
    chipLines: max(geometry, function (g) {
      return max(chipLabels, function (l) { return T.lineCountOfText("chip", l, g.chipTextWidth); });
    }),
    hoverTaglineLines: max(DATA.places, function (p) {
      return T.linesOfText("hover-card", p.tagline, hoverWidth).length;
    })
  };

  return {
    ok: failures.length === 0,
    places: DATA.places.length,
    roles: T.roleNames(),
    fonts: T.roleNames().reduce(function (acc, role) { acc[role] = T.fontFor(role); return acc; }, {}),
    geometry,
    hoverCardWidth: hoverWidth,
    worst,
    failures
  };
}

function max(list, fn) {
  let m = 0;
  for (const item of list) { const v = fn(item); if (v > m) m = v; }
  return m;
}
function round(n) { return Math.round(n * 100) / 100; }

const statusEl = document.getElementById("status");
const reportEl = document.getElementById("report");
try {
  const result = run();
  window.__ATLAS_TEXT_CHECK = result;
  statusEl.textContent = result.ok
    ? "OK — no overflow"
    : result.failures.length + " overflow failure(s)";
  reportEl.textContent = JSON.stringify(result, null, 2);
} catch (err) {
  window.__ATLAS_TEXT_CHECK = { ok: false, error: String(err && err.stack || err), failures: [] };
  statusEl.textContent = "ERROR";
  reportEl.textContent = String(err && err.stack || err);
}
