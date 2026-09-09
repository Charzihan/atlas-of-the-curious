/* Atlas of the Curious — dataset validation
   Loads js/data.js the same way the browser does (a `window` shim) and checks
   the invariants the app and the Text Atlas rely on:
     - place ids are unique and non-empty
     - every place references a known category
     - required text fields are present and non-empty
     - coordinates parse with the SAME regex the map uses, and fall in range
   Run: pnpm validate  (or: node scripts/validate-data.mjs)
   Exits non-zero on any error so it can gate a CI step. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// The map (js/map.js) uses exactly this regex; a coordinate the validator
// accepts here is a coordinate that will project correctly on the map.
const COORD_RE =
  /(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])[\s,]+(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])/;

const REQUIRED = [
  "id", "name", "country", "region", "category", "symbol",
  "tagline", "story", "fact", "coordinates", "bestTime", "nearestCity"
];

function load() {
  const src = readFileSync(path.join(root, "js", "data.js"), "utf8");
  const win = {};
  new Function("window", src)(win);
  const data = win.ATLAS_DATA;
  if (!data || !Array.isArray(data.places) || !Array.isArray(data.categories)) {
    throw new Error("js/data.js did not define window.ATLAS_DATA");
  }
  return data;
}

function parseCoords(s) {
  const m = COORD_RE.exec(s || "");
  if (!m) return null;
  return {
    lat: m[1] * (m[2].toUpperCase() === "S" ? -1 : 1),
    lon: m[3] * (m[4].toUpperCase() === "W" ? -1 : 1)
  };
}

function main() {
  const { categories, places } = load();
  const errors = [];
  const warnings = [];
  const catIds = new Set(categories.map((c) => c.id));

  // Categories
  const catLabels = new Map();
  for (const c of categories) {
    catLabels.set(c.id, c.label);
    if (!c.id || !c.label || !c.accent) errors.push(`category missing id/label/accent: ${JSON.stringify(c)}`);
  }

  const seen = new Set();
  for (const p of places) {
    const where = p.name || p.id || "(unnamed)";
    for (const f of REQUIRED) {
      if (typeof p[f] !== "string" || !p[f].trim()) errors.push(`${where}: missing/empty field "${f}"`);
    }
    if (!p.id || seen.has(p.id)) errors.push(`${where}: duplicate or empty id "${p.id}"`);
    seen.add(p.id);
    if (!catIds.has(p.category)) errors.push(`${where}: unknown category "${p.category}"`);

    const c = parseCoords(p.coordinates);
    if (!c) {
      errors.push(`${where}: coordinates do not match the map's regex: "${p.coordinates}"`);
    } else {
      if (c.lat < -90 || c.lat > 90) errors.push(`${where}: latitude ${c.lat} out of range`);
      if (c.lon < -180 || c.lon > 180) errors.push(`${where}: longitude ${c.lon} out of range`);
    }
  }

  // Distribution sanity (informational)
  const byCat = new Map();
  for (const p of places) byCat.set(p.category, (byCat.get(p.category) || 0) + 1);
  const countries = new Set(places.map((p) => p.country));

  console.log(`dataset: ${places.length} places, ${categories.length} categories, ${countries.size} countries`);
  for (const c of categories) {
    console.log(`  ${c.label}: ${byCat.get(c.id) || 0}`);
  }

  for (const w of warnings) console.warn(`  warning: ${w}`);
  if (errors.length) {
    console.error(`\n${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`\nOK: all ${places.length} places valid.`);
}

main();
