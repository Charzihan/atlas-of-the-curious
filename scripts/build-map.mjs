/* Builds a real-world-colored, textured character map of the world.
   Sources (Natural Earth, public domain):
     - data/world-110m-countries.geojson  (country polygons + CONTINENT field)
   Output: js/landmap.js → window.LANDMAPS = { palette, continents, desktop: {...}, mobile: {...} }
   Each grid cell encodes a texture glyph (glyphs row) and a palette index
   (colors row; " " = water). Land is colored uniformly per continent (the
   geojson's CONTINENT property; Antarctica is white), so every country in a
   continent shares one flat color and one texture glyph.
   Run: pnpm build-map   (or: node scripts/build-map.mjs) */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ringBox, clusterPolygons, encodePolygons } from "./map-outline-geometry.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const geo = JSON.parse(readFileSync(join(root, "data", "world-110m-countries.geojson"), "utf8"));

// Equirectangular grids. Desktop fills a 16:9-ish hero; mobile fills a
// phone-width hero band (landscape strip).
const GRIDS = {
  desktop: { cols: 150, rows: 39 },
  mobile:  { cols: 96, rows: 25 },
};
const SAMPLE = 4;      // SAMPLE x SAMPLE sub-points per cell → tight coastlines
const THRESH = 6;      // land if ≥ THRESH of SAMPLE*SAMPLE samples hit a country

// One flat color per continent — every country in a continent shares one
// color. Antarctica is deliberately a white ice sheet. Colors chosen to stay
// legible on the dark sea.
const CONTINENT_COLORS = {
  "Africa": [0x6f, 0x9e, 0x5f],         // savanna green
  "Asia": [0xd0, 0xa0, 0x5a],           // ochre
  "Europe": [0xa8, 0x8a, 0xc4],         // heather purple
  "North America": [0x8f, 0xc9, 0x6a],  // prairie green
  "South America": [0xe0, 0x7a, 0x5a],  // terracotta
  "Oceania": [0x4f, 0xb0, 0xc9],        // lagoon teal
  "Antarctica": [0xec, 0xf2, 0xf6],     // ice white
};
const PALETTE = [];
const continentIdx = new Map();
for (const [name, rgb] of Object.entries(CONTINENT_COLORS)) {
  continentIdx.set(name, PALETTE.length);
  PALETTE.push("rgb(" + rgb.join(",") + ")");
}
const FALLBACK_IDX = continentIdx.get("Asia"); // unclassified land → largest continent
const PALETTE_STEPS = 1; // uniform color per continent: 1 palette entry each

// Texture glyph per continent, so a continent reads as one flat, uniform region.
const GLYPHS = ["#", "%", "+", "8", "@", ":", "x", "x"];

// Rings grouped by country for per-country even-odd containment.
const countryRings = new Map(); // code -> array of { pts, minX, minY, maxX, maxY }
// Country → its continent name (from the geojson CONTINENT property).
// "Seven seas (open ocean)" (Fr. S. Antarctic Lands, a sub-Antarctic archipelago)
// is folded into Antarctica so it takes the white ice color.
const countryContinent = new Map();
for (const f of geo.features) {
  const code = f.properties.ADM0_A3 || f.properties.ADMIN || String(f.properties.NAME || f);
  let cont = f.properties.CONTINENT || "Seven seas (open ocean)";
  if (cont === "Seven seas (open ocean)") cont = "Antarctica";
  countryContinent.set(code, cont);
  const ge = f.geometry;
  const polys = ge.type === "Polygon" ? [ge.coordinates] : ge.coordinates;
  let list = countryRings.get(code);
  if (!list) { list = []; countryRings.set(code, list); }
  for (const poly of polys) {
    for (const ring of poly) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [lon, lat] of ring) {
        if (lon < minX) minX = lon; if (lon > maxX) maxX = lon;
        if (lat < minY) minY = lat; if (lat > maxY) maxY = lat;
      }
      list.push({ pts: ring, minX, minY, maxX, maxY });
    }
  }
}

// Point-in-polygon per country (even-odd over all its rings, holes included).
function countryAt(lon, lat) {
  for (const [code, list] of countryRings) {
    let odd = false;
    for (const r of list) {
      if (lon < r.minX || lon > r.maxX || lat < r.minY || lat > r.maxY) continue;
      const pts = r.pts;
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        const xi = pts[a][0], yi = pts[a][1];
        const xj = pts[b][0], yj = pts[b][1];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) odd = !odd;
      }
    }
    if (odd) return code;
  }
  return null;
}

const countryCodes = [...countryRings.keys()];
const countryIndex = new Map(countryCodes.map((code, i) => [code, i + 1]));
const countryNames = Object.fromEntries(geo.features.map(f => [f.properties.ADMIN, f.properties.ADM0_A3]));

function buildGrid(cols, rows) {
  const glyphs = new Array(rows);
  const colors = new Array(rows);
  const countries = new Array(cols * rows).fill(0);
  const t0 = Date.now();
  for (let r = 0; r < rows; r++) {
    let gRow = "";
    let cRow = "";
    for (let c = 0; c < cols; c++) {
      let hits = 0;
      let code = null;
      for (let sy = 0; sy < SAMPLE; sy++) {
        for (let sx = 0; sx < SAMPLE; sx++) {
          const fx = (sx + 0.5) / SAMPLE;
          const fy = (sy + 0.5) / SAMPLE;
          const lon = -180 + ((c + fx) / cols) * 360;
          const lat = 90 - ((r + fy) / rows) * 180;
          const at = countryAt(lon, lat);
          if (at) { hits++; code = at; }
        }
      }
      if (hits >= THRESH && code) {
        countries[r * cols + c] = countryIndex.get(code);
        // One char per cell: 'A' + palette index. Uniform per continent —
        // every country in the continent shares one color + one glyph.
        const cont = countryContinent.get(code) || "Asia";
        const idx = continentIdx.has(cont) ? continentIdx.get(cont) : FALLBACK_IDX;
        cRow += String.fromCharCode(65 + idx);
        gRow += GLYPHS[idx % GLYPHS.length];
      } else {
        cRow += " ";
        gRow += " ";
      }
    }
    glyphs[r] = gRow;
    colors[r] = cRow;
  }
  console.log(`grid ${cols}x${rows}: ${Date.now() - t0}ms`);
  return { cols, rows, glyphs, colors, countries };
}

// ---- Country outlines for the map reading view --------------------------
// The 150x39 cell grid is far too coarse to hold a story inside most
// countries, so the reading view works from real polygon geometry instead and
// picks its own scale. Only the countries the dataset actually names get
// geometry, simplified (Douglas-Peucker) with a tolerance proportional to the
// country's own size — so the on-screen error stays roughly constant once the
// atlas has scaled the silhouette up — and quantised to 1/OUTLINE_UNITS of a
// degree, delta-encoded as integers. Emitted as `outlines`, keyed by ADM0_A3.
const OUTLINE_UNITS = 50;      // 1/50 degree ~ 2.2 km
const OUTLINE_GAP = 3.5;       // degrees an island may sit from the kept cluster
// The dataset spells a few countries differently from Natural Earth's ADMIN.
// Emitted as countryAliases so js/map.js uses this same table at runtime.
const OUTLINE_ALIASES = {
  "Türkiye": "Turkey",
  "Malaysia (Borneo)": "Malaysia",
  "United States": "United States of America",
  "Tanzania": "United Republic of Tanzania",
};

function datasetCountries() {
  // js/data.js is a plain IIFE over `window`; running it is cheaper and more
  // honest than pattern-matching the literal.
  const win = {};
  new Function("window", readFileSync(join(root, "js", "data.js"), "utf8"))(win);
  const names = new Map();
  for (const place of win.ATLAS_DATA.places) {
    for (const part of String(place.country).split(" / ")) {
      const name = OUTLINE_ALIASES[part] || part;
      if (!names.has(name)) names.set(name, new Set());
      names.get(name).add(part);
    }
  }
  return names;
}

function buildOutlines() {
  const wanted = datasetCountries();
  const byAdmin = new Map(geo.features.map(f => [f.properties.ADMIN, f]));
  const outlines = {};
  let points = 0;
  for (const [name, labels] of wanted) {
    const feature = byAdmin.get(name);
    if (!feature) { console.warn("outline: no Natural Earth ADMIN for " + name); continue; }
    const ge = feature.geometry;
    let polygons = ge.type === "Polygon" ? [ge.coordinates] : ge.coordinates;
    // Named dataset exception: "Malaysia (Borneo)" deliberately depicts only
    // Borneo. A plain "Malaysia" request keeps both substantial exteriors,
    // including the peninsula 5.41 degrees away, through clusterPolygons.
    if (labels.size === 1 && labels.has("Malaysia (Borneo)")) {
      polygons = polygons.filter(poly => ringBox(poly[0]).x0 >= 108);
    }
    const kept = clusterPolygons(polygons, OUTLINE_GAP);
    if (!kept.length) continue;
    const box = kept.map(poly => ringBox(poly[0])).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
    const tol = Math.max(0.02, Math.min(0.35, 0.006 * Math.max(box.x1 - box.x0, box.y1 - box.y0)));
    const encoded = encodePolygons(kept, tol, OUTLINE_UNITS);
    if (!encoded.length) continue;
    outlines[feature.properties.ADM0_A3] = encoded;
    points += encoded.reduce((n, ring) => n + ring.length / 2, 0);
  }
  console.log("outlines: " + Object.keys(outlines).length + " countries, " + points + " points");
  return outlines;
}

const out = {
  countryCodes, countryNames, countryAliases: OUTLINE_ALIASES,
  palette: PALETTE,
  paletteSteps: PALETTE_STEPS,
  continents: Object.fromEntries(continentIdx),
  desktop: buildGrid(GRIDS.desktop.cols, GRIDS.desktop.rows),
  mobile: buildGrid(GRIDS.mobile.cols, GRIDS.mobile.rows),
  outlineUnits: OUTLINE_UNITS,
  outlines: buildOutlines(),
};

const banner = "/* Generated by scripts/build-map.mjs from Natural Earth 110m countries. Do not edit by hand. */";
writeFileSync(join(root, "js", "landmap.js"), banner + "\nwindow.LANDMAPS = " + JSON.stringify(out) + ";\n");
console.log("landmap.js written", out.desktop.cols + "x" + out.desktop.rows + " +", out.mobile.cols + "x" + out.mobile.rows);
