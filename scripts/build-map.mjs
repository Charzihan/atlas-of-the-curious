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

function buildGrid(cols, rows) {
  const glyphs = new Array(rows);
  const colors = new Array(rows);
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
  return { cols, rows, glyphs, colors };
}

const out = {
  palette: PALETTE,
  paletteSteps: PALETTE_STEPS,
  continents: Object.fromEntries(continentIdx),
  desktop: buildGrid(GRIDS.desktop.cols, GRIDS.desktop.rows),
  mobile: buildGrid(GRIDS.mobile.cols, GRIDS.mobile.rows),
};

const banner = "/* Generated by scripts/build-map.mjs from Natural Earth 110m countries. Do not edit by hand. */";
writeFileSync(join(root, "js", "landmap.js"), banner + "\nwindow.LANDMAPS = " + JSON.stringify(out) + ";\n");
console.log("landmap.js written", out.desktop.cols + "x" + out.desktop.rows + " +", out.mobile.cols + "x" + out.mobile.rows);
