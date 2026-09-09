/* Atlas of the Curious — per-place static share pages
   Generates one self-contained HTML file per place into places/<id>/index.html
   so that https://<host>/places/<id>/ is a real, indexable URL (each page has
   its own <title>, meta description, and Open Graph tags) instead of only a
   #/place/<id> hash fragment on the single main page.

   The content is written into the HTML at BUILD time from js/data.js — there is
   no runtime interpolation, so the strict CSP on these pages stays intact.
   All values are escaped and only ever inserted as static text.

   Run: pnpm build-pages  (or: node scripts/build-place-pages.mjs) */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(root, "places");

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; " +
  "form-action 'self'; frame-ancestors 'self'";

function load() {
  const src = readFileSync(path.join(root, "js", "data.js"), "utf8");
  const win = {};
  new Function("window", src)(win);
  return win.ATLAS_DATA;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pageFor(p, cat) {
  const accent = cat ? cat.accent : "#e8b45a";
  const title = `${p.name}, ${p.country} — Atlas of the Curious`;
  const desc = p.tagline;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="color-scheme" content="dark">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta http-equiv="Content-Security-Policy" content="${CSP}">
  <link rel="icon" href="../../img/icon.svg">
  <link rel="stylesheet" href="../../css/place.css">
  <script src="../../js/place.js" defer></script>
</head>
<body>
  <div class="wrap">
    <a class="back" href="../../">&#8592; Back to the atlas</a>
    <p class="kicker">Hand-curated field note</p>
    <div class="head">
      <span class="symbol" data-accent="${esc(accent)}" aria-hidden="true">${esc(p.symbol)}</span>
      <div>
        <span class="badge" data-accent="${esc(accent)}">${esc(cat ? cat.label : "")}</span>
        <h1>${esc(p.name)}</h1>
        <p class="loc">${esc(p.country)} &mdash; ${esc(p.region)}</p>
      </div>
    </div>
    <p class="tagline">${esc(p.tagline)}</p>
    <p class="story">${esc(p.story)}</p>
    <div class="fact">
      <span class="fact-label">Field note</span>
      <p>${esc(p.fact)}</p>
    </div>
    <div class="field-grid">
      <div class="field"><span>Best time to visit</span><em>${esc(p.bestTime)}</em></div>
      <div class="field"><span>Nearest major city</span><em>${esc(p.nearestCity)}</em></div>
      <div class="field"><span>Approximate coordinates</span><em>${esc(p.coordinates)}</em></div>
    </div>
    <div class="actions">
      <a class="btn" href="../../">Browse the full atlas</a>
      <button class="btn" id="share" type="button">Copy link</button>
    </div>
    <p class="foot">
      <span class="brand">&#10038;</span> Atlas of the Curious &mdash; a static, dependency-free site. No cookies, no trackers, no external requests.
      <br>
      <span class="note">Coordinates approximate. Pack water, sunscreen, and humility.</span>
    </p>
  </div>
</body>
</html>
`;
}

function main() {
  const data = load();
  const byId = new Map(data.categories.map((c) => [c.id, c]));

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  let n = 0;
  for (const p of data.places) {
    const dir = path.join(OUT, p.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), pageFor(p, byId.get(p.category)), "utf8");
    n++;
  }
  console.log(`wrote ${n} place pages to places/`);
}

main();
