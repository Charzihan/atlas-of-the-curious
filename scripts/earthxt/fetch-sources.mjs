/** Download the globe's build-time sources into data/ (git-ignored).
 * Only `pnpm build:earthxt-data` reads them; the globe itself never fetches.
 *   data/ne_50m_admin_0_countries.geojson  Natural Earth 1:50m countries (public domain)
 *   data/terrarium/5-<x>-<y>.png           Terrain Tiles, zoom 5 (land + sea floor)
 *   data/ice-surface.bin                   Copernicus GLO-90 surface heights over the
 *                                          Greenland and Antarctic ice sheets
 * Terrain Tiles carry bedrock under the polar ice, so Greenland and Antarctica
 * would read as low ground; Copernicus supplies the ice surface for those two.
 * Existing files are kept; delete one to fetch it again.
 * Usage: node scripts/earthxt/fetch-sources.mjs
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { ICE_GRID, encodeIceGrid, TERRAIN_ZOOM } from './terrain.mjs';

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const COUNTRIES_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const COPERNICUS = 'https://copernicus-dem-90m.s3.amazonaws.com';

const exists = path => access(path).then(() => true, () => false);
async function download(url, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= attempts) throw new Error(`${url}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}
async function pool(items, limit, work) {
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      await work(items[next++]);
      if (++done % 500 === 0) console.log(`  ${done}/${items.length}`);
    }
  }));
}

await mkdir(join(dataDir, 'terrarium'), { recursive: true });

const countries = join(dataDir, 'ne_50m_admin_0_countries.geojson');
if (!await exists(countries)) {
  console.log('Natural Earth 1:50m countries…');
  await writeFile(countries, await download(COUNTRIES_URL));
}

const tiles = [];
for (let x = 0; x < 2 ** TERRAIN_ZOOM; x++) for (let y = 0; y < 2 ** TERRAIN_ZOOM; y++) tiles.push([x, y]);
const missing = [];
for (const [x, y] of tiles) if (!await exists(join(dataDir, 'terrarium', `${TERRAIN_ZOOM}-${x}-${y}.png`))) missing.push([x, y]);
if (missing.length) {
  console.log(`Terrain Tiles zoom ${TERRAIN_ZOOM}: ${missing.length} tiles…`);
  await pool(missing, 32, async ([x, y]) => {
    await writeFile(join(dataDir, 'terrarium', `${TERRAIN_ZOOM}-${x}-${y}.png`), await download(TERRARIUM(TERRAIN_ZOOM, x, y)));
  });
}

const iceFile = join(dataDir, 'ice-surface.bin');
if (!await exists(iceFile)) {
  const { fromUrl, Pool } = await import('geotiff');
  // Each overview is one padded 2048 px DEFLATE tile: decode on worker threads.
  const decoders = new Pool(Math.max(1, availableParallelism() - 1));
  // Every 1° tile south of 60°S, and the box around Greenland. Only cells the
  // countries raster assigns to Greenland or Antarctica use these heights.
  const inIceBox = (lat, lon) => lat < -60 || (lat >= 59 && lat < 84 && lon >= -74 && lon < -10);
  const names = (await download(`${COPERNICUS}/tileList.txt`)).toString('utf8').split(/\s+/).filter(name => {
    const match = /_([NS])(\d\d)_00_([EW])(\d\d\d)_00_DEM$/.exec(name);
    if (!match) return false;
    const lat = (match[1] === 'S' ? -1 : 1) * Number(match[2]), lon = (match[3] === 'W' ? -1 : 1) * Number(match[4]);
    return inIceBox(lat + 0.5, lon + 0.5);
  });
  console.log(`Copernicus GLO-90 ice surface: ${names.length} tiles (coarsest overview of each)…`);
  const { width, height } = ICE_GRID, sum = new Float64Array(width * height), squares = new Float64Array(width * height), count = new Uint32Array(width * height);
  await pool(names, 32, async name => {
    let tiff, image, raster;
    for (let attempt = 1; ; attempt++) {
      try {
        tiff = await fromUrl(`${COPERNICUS}/${name}/${name}.tif`);
        image = await tiff.getImage((await tiff.getImageCount()) - 1);
        [raster] = await image.readRasters({ pool: decoders });
        break;
      } catch (error) {
        if (attempt >= 4) throw new Error(`${name}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
    // The overview spans the full-resolution image's bounds.
    const [west, south, east, north] = (await tiff.getImage(0)).getBoundingBox();
    const w = image.getWidth(), h = image.getHeight();
    for (let py = 0; py < h; py++) {
      const lat = north - (py + 0.5) / h * (north - south);
      const row = Math.min(height - 1, Math.floor((90 - lat) / 180 * height));
      for (let px = 0; px < w; px++) {
        const metres = raster[py * w + px];
        if (!(metres > 0)) continue;
        const lon = west + (px + 0.5) / w * (east - west);
        const cell = row * width + Math.min(width - 1, Math.floor((lon + 180) / 360 * width));
        sum[cell] += metres; squares[cell] += metres * metres; count[cell]++;
      }
    }
  });
  decoders.destroy();
  await writeFile(iceFile, encodeIceGrid(sum, squares, count));
}
console.log('Sources ready in data/.');
