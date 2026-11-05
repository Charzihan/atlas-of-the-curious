/** Build-time terrain sampling for the globe's relief layer.
 * Source: Terrarium-encoded elevation tiles (Tilezen/Mapzen "Terrain Tiles",
 * served from the AWS Open Data registry). Each pixel stores metres as
 * (R * 256 + G + B / 256) - 32768 in Web Mercator. The tiles blend SRTM,
 * GMTED2010, ETOPO1 bathymetry and national DEMs; see earthxt/data/README.md
 * for the required attribution. Only the build reads tiles: the globe ships a
 * small pre-sampled raster and makes no terrain requests at runtime.
 */
import { inflateSync } from 'node:zlib';

/** Zoom 5: 32 × 32 tiles of 256 px, about 0.044° per pixel at the equator. */
export const TERRAIN_ZOOM = 5;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimal decoder for the tiles' format: 8-bit, non-interlaced RGB or RGBA. */
export function decodePNG(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG file.');
  let width = 0, height = 0, channels = 0;
  const data = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const depth = body[8], colour = body[9], interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) throw new Error('Unsupported PNG layout.');
      channels = colour === 2 ? 3 : 4;
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data)), stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride, prev = out - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[prev + x] : 0;
      const c = y > 0 && x >= channels ? pixels[prev + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}.`);
      pixels[out + x] = value;
    }
  }
  return { width, height, channels, pixels };
}

/** Accumulates every tile pixel into an equirectangular grid of `width` × `height`
 * cells. Land (> 0 m) and sea (≤ 0 m) pixels keep separate sums, so a coastal
 * cell's height is not dragged down by its own shelf, nor its depth up by its cliffs. */
export class TerrainGrid {
  constructor(width, height) {
    this.width = width; this.height = height;
    const n = width * height;
    this.landSum = new Float64Array(n); this.landSquares = new Float64Array(n); this.landCount = new Uint32Array(n);
    this.seaSum = new Float64Array(n); this.seaCount = new Uint32Array(n);
  }
  addTile(zoom, tileX, tileY, png) {
    const { width: size, channels, pixels } = png, world = size * 2 ** zoom;
    for (let py = 0; py < size; py++) {
      const mercator = Math.PI * (1 - 2 * (tileY * size + py + 0.5) / world);
      const latitude = Math.atan(Math.sinh(mercator)) * 180 / Math.PI;
      const row = Math.min(this.height - 1, Math.floor((90 - latitude) / 180 * this.height));
      for (let px = 0; px < size; px++) {
        const longitude = (tileX * size + px + 0.5) / world * 360 - 180;
        const col = Math.min(this.width - 1, Math.floor((longitude + 180) / 360 * this.width));
        const i = (py * size + px) * channels;
        const metres = pixels[i] * 256 + pixels[i + 1] + pixels[i + 2] / 256 - 32768;
        const cell = row * this.width + col;
        if (metres > 0) { this.landSum[cell] += metres; this.landSquares[cell] += metres * metres; this.landCount[cell]++; }
        else { this.seaSum[cell] += metres; this.seaCount[cell]++; }
      }
    }
  }
  /** Web Mercator stops at ±85.05°. Rows beyond it borrow the nearest sampled
   * row: the Arctic Ocean floor near the pole and the polar ice plateau. */
  fillPolarRows() {
    const { width, height } = this;
    const sampled = row => { for (let col = 0; col < width; col++) if (this.landCount[row * width + col] + this.seaCount[row * width + col]) return true; return false; };
    let first = 0, last = height - 1;
    while (first < height && !sampled(first)) first++;
    while (last > first && !sampled(last)) last--;
    const copy = (from, to) => {
      for (const array of [this.landSum, this.landSquares, this.landCount, this.seaSum, this.seaCount]) {
        array.copyWithin(to * width, from * width, (from + 1) * width);
      }
    };
    for (let row = 0; row < first; row++) copy(first, row);
    for (let row = last + 1; row < height; row++) copy(last, row);
  }
  /** Mean land height (m, ≥ 0), mean sea depth (m, ≥ 0) and the spread of
   * land heights (m) for one cell. */
  stats(cell) {
    const n = this.landCount[cell], m = this.seaCount[cell];
    const height = n ? this.landSum[cell] / n : 0;
    const spread = n > 1 ? Math.sqrt(Math.max(0, this.landSquares[cell] / n - height * height)) : 0;
    return { height, depth: m ? -this.seaSum[cell] / m : 0, spread, land: n, sea: m };
  }
}

/** The ice-surface cache (data/ice-surface.bin): mean height and spread (m)
 * per cell of the finest globe raster, Float32, NaN where no ice-sheet tile
 * reached. Written by fetch-sources.mjs, read by build-data.mjs. */
export const ICE_GRID = Object.freeze({ width: 1440, height: 720 });
export function encodeIceGrid(sum, squares, count) {
  const out = new Float32Array(sum.length * 2);
  for (let cell = 0; cell < sum.length; cell++) {
    const n = count[cell], mean = n ? sum[cell] / n : NaN;
    out[cell * 2] = mean;
    out[cell * 2 + 1] = n ? Math.sqrt(Math.max(0, squares[cell] / n - mean * mean)) : NaN;
  }
  return Buffer.from(out.buffer);
}
export function decodeIceGrid(bytes) {
  const values = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (values.length !== ICE_GRID.width * ICE_GRID.height * 2) throw new Error('data/ice-surface.bin does not match the globe grid.');
  return { height: cell => values[cell * 2], spread: cell => values[cell * 2 + 1] };
}
