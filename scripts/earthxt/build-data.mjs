/** Rasterize the existing public-domain Natural Earth polygons, including holes.
 * Only run when regenerating geography; the generated files are checked in.
 * Usage: node scripts/earthxt/build-data.mjs [path/to/countries.geojson]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
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

function rasterize(width, height) {
  const raster = new Uint8Array(width * height);
  geo.features.forEach((feature, index) => {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      const rings = polygon.map(ring => ring.map(([lon, lat]) => [(lon + 180) / 360 * width, (90 - lat) / 180 * height]));
      let minY = height, maxY = 0;
      for (const ring of rings) for (const [, y] of ring) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      for (let row = Math.max(0, Math.floor(minY)); row < Math.min(height, Math.ceil(maxY)); row++) {
        const scan = row + 0.5, crossings = [];
        for (const ring of rings) {
          for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
            const [ax, ay] = ring[a], [bx, by] = ring[b];
            if ((ay > scan) !== (by > scan)) crossings.push(ax + (scan - ay) * (bx - ax) / (by - ay));
          }
        }
        crossings.sort((a, b) => a - b);
        for (let i = 0; i + 1 < crossings.length; i += 2) {
          const start = Math.max(0, Math.ceil(crossings[i] - 0.5));
          const end = Math.min(width, Math.ceil(crossings[i + 1] - 0.5));
          for (let col = start; col < end; col++) raster[row * width + col] = index + 1;
        }
      }
    }
  });
  return raster;
}

const chunks = [], levels = [];
let offset = 0;
for (const level of LEVELS) {
  const width = Math.round(360 / level.sampleDegrees), height = Math.round(180 / level.sampleDegrees);
  const raster = rasterize(width, height);
  chunks.push(raster);
  levels.push({ id: level.id, width, height, offset, bytes: raster.byteLength });
  offset += raster.byteLength;
}
const binary = Buffer.concat(chunks);
const metadata = JSON.stringify({ version: 1, source: 'Natural Earth 1:110m Admin 0 countries', license: 'Public domain',
  sourceURL: 'https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/',
  bytes: binary.byteLength, levels, countries });
if (gzipSync(binary).byteLength + gzipSync(metadata).byteLength > 10 * 1024 * 1024) throw new Error('Geographic payload exceeds the 10 MB compressed budget.');
await mkdir(new URL('earthxt/data/', root), { recursive: true });
await writeFile(new URL('earthxt/data/world.bin', root), binary);
await writeFile(new URL('earthxt/data/world.json', root), metadata + '\n');
console.log(`${countries.length} countries, ${levels.length} LODs, ${binary.byteLength.toLocaleString()} bytes; ${gzipSync(binary).byteLength + gzipSync(metadata).byteLength} bytes gzip.`);
