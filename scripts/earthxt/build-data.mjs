/** Build the globe's local geography: country ownership and relief rasters.
 * Countries: public-domain Natural Earth 1:50m polygons through ../geo-raster.mjs.
 * Row-centre scanline ownership retains feature-order IDs and polygon holes.
 * Relief: Terrain Tiles (land heights, sea depths) with Copernicus GLO-90 for
 * the Greenland and Antarctic ice surface (see ./terrain.mjs, ./fetch-sources.mjs).
 * Fetch the sources first with `pnpm fetch:earthxt-sources`.
 * Set GEO_RASTER_OUTPUT_DIR to write earthxt/data/ beneath another root.
 * Only run when regenerating geography; the generated files are checked in.
 * Usage: node scripts/earthxt/build-data.mjs [countries.geojson] [terrain-dir] [ice-surface.bin]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseCountries, scanlineOwnership } from '../geo-raster.mjs';
import { LEVELS } from '../../earthxt/lod.js';
import { RELIEF } from '../../earthxt/geography.js';
import { decodePNG, TerrainGrid, decodeIceGrid, ICE_GRID, TERRAIN_ZOOM } from './terrain.mjs';

const root = new URL('../../', import.meta.url);
const data = name => fileURLToPath(new URL(`data/${name}`, root));
const source = process.argv[2] ?? data('ne_50m_admin_0_countries.geojson');
const terrainDir = process.argv[3] ?? data('terrarium');
const iceSource = process.argv[4] ?? data('ice-surface.bin');

const geo = JSON.parse(await readFile(source, 'utf8'));
if (geo.features.length > 255) throw new Error('Ownership encoding supports at most 255 countries.');
const countries = geo.features.map((feature, index) => ({
  id: index + 1, code: feature.properties.ADM0_A3, name: feature.properties.NAME,
  latitude: feature.properties.LABEL_Y, longitude: feature.properties.LABEL_X,
  rank: feature.properties.LABELRANK,
  // The atlas colours land by continent (scripts/build-map.mjs); the open-ocean
  // archipelagos join Antarctica there, so they do here too.
  continent: feature.properties.CONTINENT === 'Seven seas (open ocean)' ? 'Antarctica' : feature.properties.CONTINENT,
}));
const countryRings = parseCountries(geo.features);
const ownership = LEVELS.map(level => {
  const width = Math.round(360 / level.sampleDegrees), height = Math.round(180 / level.sampleDegrees);
  return { level, width, height, raster: scanlineOwnership(countryRings, width, height) };
});

// Relief is sampled once on the finest grid, then pooled into coarser cells.
const fine = ownership[ownership.length - 1];
if (fine.width !== ICE_GRID.width || fine.height !== ICE_GRID.height) throw new Error('The ice-surface grid must match the finest level.');
const terrain = new TerrainGrid(fine.width, fine.height);
for (let x = 0; x < 2 ** TERRAIN_ZOOM; x++) for (let y = 0; y < 2 ** TERRAIN_ZOOM; y++) {
  terrain.addTile(TERRAIN_ZOOM, x, y, decodePNG(await readFile(join(terrainDir, `${TERRAIN_ZOOM}-${x}-${y}.png`))));
}
terrain.fillPolarRows();
const ice = decodeIceGrid(await readFile(iceSource));
const iceSheets = new Set(countries.filter(country => country.code === 'GRL' || country.code === 'ATA').map(country => country.id));
const cells = fine.width * fine.height;
const height = new Float64Array(cells), depth = new Float64Array(cells), spread = new Float64Array(cells);
const landWeight = new Float64Array(cells), seaWeight = new Float64Array(cells);
for (let cell = 0; cell < cells; cell++) {
  const stats = terrain.stats(cell);
  height[cell] = stats.height; depth[cell] = stats.depth; spread[cell] = stats.spread;
  landWeight[cell] = stats.land; seaWeight[cell] = stats.sea;
  // Terrain Tiles hold bedrock beneath the ice sheets; their surface is ice.
  if (iceSheets.has(fine.raster[cell]) && Number.isFinite(ice.height(cell))) {
    height[cell] = ice.height(cell); spread[cell] = ice.spread(cell);
    landWeight[cell] = stats.land + stats.sea; seaWeight[cell] = 0;
  }
}

/** One byte per cell, read against that level's ownership. Land: bit 7 marks
 * rugged ground, bits 0–6 hold height in RELIEF.landStep metres. Sea: depth in
 * RELIEF.seaStep metres. */
function reliefRaster({ width, height: rows, raster }) {
  const factor = fine.width / width, out = new Uint8Array(width * rows);
  for (let row = 0; row < rows; row++) for (let col = 0; col < width; col++) {
    let land = 0, sea = 0, h = 0, d = 0, s = 0;
    for (let y = row * factor; y < (row + 1) * factor; y++) for (let x = col * factor; x < (col + 1) * factor; x++) {
      const cell = y * fine.width + x;
      land += landWeight[cell]; sea += seaWeight[cell];
      h += height[cell] * landWeight[cell]; s += spread[cell] * landWeight[cell]; d += depth[cell] * seaWeight[cell];
    }
    const index = row * width + col;
    if (raster[index]) {
      const metres = land ? h / land : 0, rough = land ? s / land : 0;
      out[index] = Math.min(127, Math.round(metres / RELIEF.landStep)) | (rough >= RELIEF.ruggedSpread ? 128 : 0);
    } else out[index] = Math.min(127, Math.round((sea ? d / sea : 0) / RELIEF.seaStep));
  }
  return out;
}

const chunks = [], levels = [];
let offset = 0;
for (const entry of ownership) {
  const { level, width, height: rows, raster } = entry;
  const relief = reliefRaster(entry);
  chunks.push(raster, relief);
  levels.push({ id: level.id, width, height: rows, offset, bytes: raster.byteLength, reliefOffset: offset + raster.byteLength });
  offset += raster.byteLength + relief.byteLength;
}
const binary = Buffer.concat(chunks);
const metadata = JSON.stringify({ version: 2, source: 'Natural Earth 1:50m Admin 0 countries', license: 'Public domain',
  sourceURL: 'https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/',
  relief: { landStep: RELIEF.landStep, seaStep: RELIEF.seaStep, ruggedSpread: RELIEF.ruggedSpread,
    source: `Terrain Tiles (zoom ${TERRAIN_ZOOM}); Copernicus GLO-90 DEM over the Greenland and Antarctic ice sheets`,
    sourceURL: 'https://registry.opendata.aws/terrain-tiles/' },
  bytes: binary.byteLength, levels, countries });
if (gzipSync(binary).byteLength + gzipSync(metadata).byteLength > 10 * 1024 * 1024) throw new Error('Geographic payload exceeds the 10 MB compressed budget.');
const outputRoot = process.env.GEO_RASTER_OUTPUT_DIR ?? fileURLToPath(root);
const outputDir = join(outputRoot, 'earthxt', 'data');
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'world.bin'), binary);
await writeFile(join(outputDir, 'world.json'), metadata + '\n');
console.log(`${countries.length} countries, ${levels.length} LODs, ${binary.byteLength.toLocaleString()} bytes; ${gzipSync(binary).byteLength + gzipSync(metadata).byteLength} bytes gzip.`);
