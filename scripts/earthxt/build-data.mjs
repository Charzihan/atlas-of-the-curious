/** Rasterize public-domain Natural Earth polygons through ../geo-raster.mjs.
 * Row-centre scanline ownership retains feature-order IDs and polygon holes.
 * Set GEO_RASTER_OUTPUT_DIR to write earthxt/data/ beneath another root.
 * Only run when regenerating geography; the generated files are checked in.
 * Usage: node scripts/earthxt/build-data.mjs [path/to/countries.geojson]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseCountries, scanlineOwnership } from '../geo-raster.mjs';
import { LEVELS } from '../../earthxt/lod.js';

const root = new URL('../../', import.meta.url);
const source = process.argv[2] ?? fileURLToPath(new URL('data/world-110m-countries.geojson', root));
const geo = JSON.parse(await readFile(source, 'utf8'));
if (geo.features.length > 255) throw new Error('Ownership encoding supports at most 255 countries.');
const countries = geo.features.map((feature, index) => ({
  id: index + 1, code: feature.properties.ADM0_A3, name: feature.properties.NAME,
  latitude: feature.properties.LABEL_Y, longitude: feature.properties.LABEL_X,
  rank: feature.properties.LABELRANK,
}));

const countryRings = parseCountries(geo.features);

const chunks = [], levels = [];
let offset = 0;
for (const level of LEVELS) {
  const width = Math.round(360 / level.sampleDegrees), height = Math.round(180 / level.sampleDegrees);
  const raster = scanlineOwnership(countryRings, width, height);
  chunks.push(raster);
  levels.push({ id: level.id, width, height, offset, bytes: raster.byteLength });
  offset += raster.byteLength;
}
const binary = Buffer.concat(chunks);
const metadata = JSON.stringify({ version: 1, source: 'Natural Earth 1:110m Admin 0 countries', license: 'Public domain',
  sourceURL: 'https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/',
  bytes: binary.byteLength, levels, countries });
if (gzipSync(binary).byteLength + gzipSync(metadata).byteLength > 10 * 1024 * 1024) throw new Error('Geographic payload exceeds the 10 MB compressed budget.');
const outputRoot = process.env.GEO_RASTER_OUTPUT_DIR ?? fileURLToPath(root);
const outputDir = join(outputRoot, 'earthxt', 'data');
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'world.bin'), binary);
await writeFile(join(outputDir, 'world.json'), metadata + '\n');
console.log(`${countries.length} countries, ${levels.length} LODs, ${binary.byteLength.toLocaleString()} bytes; ${gzipSync(binary).byteLength + gzipSync(metadata).byteLength} bytes gzip.`);
