import { clamp, wrapLongitude, RAD } from './geometry.js';

/** The atlas's continent order (js/landmap.js `continents`); colours and
 * texture glyphs are indexed by it in both views. */
export const CONTINENTS = Object.freeze(['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania', 'Antarctica']);
const FALLBACK_CONTINENT = CONTINENTS.indexOf('Asia');

/** Relief encoding (scripts/earthxt/build-data.mjs): one byte per cell. On
 * land, bit 7 marks rugged ground and bits 0–6 hold height in landStep metres;
 * at sea, the byte holds depth in seaStep metres. ruggedSpread is the build's
 * threshold: the spread of heights inside a finest-level cell. */
export const RELIEF = Object.freeze({ landStep: 50, seaStep: 100, ruggedSpread: 250 });

/** Local raster provider. Future providers can implement sample() and labels(). */
export class Geography {
  constructor(metadata, buffer, metadataBytes = 0) {
    if ((metadata.version !== 1 && metadata.version !== 2) || buffer.byteLength !== metadata.bytes || metadata.countries.length > 255) {
      throw new Error('The local geography files are incomplete or incompatible.');
    }
    this.metadata = metadata;
    this.loadedBytes = buffer.byteLength + metadataBytes;
    this.countries = metadata.countries;
    // Country id → continent index, read once per frame cell without lookups.
    this.continentByCountry = new Uint8Array(256).fill(FALLBACK_CONTINENT);
    for (const country of this.countries) {
      const index = CONTINENTS.indexOf(country.continent);
      if (index >= 0) this.continentByCountry[country.id] = index;
    }
    // Version 1 files carry ownership only; their relief reads as flat ground and sea.
    this.relief = metadata.relief || null;
    this.levels = new Map(metadata.levels.map(level => {
      if (level.bytes !== level.width * level.height || level.offset + level.bytes > buffer.byteLength) throw new Error('Invalid geography level.');
      if (this.relief && !(level.reliefOffset + level.bytes <= buffer.byteLength)) throw new Error('Invalid geography relief.');
      return [level.id, { ...level, grid: new Uint8Array(buffer, level.offset, level.bytes),
        relief: this.relief ? new Uint8Array(buffer, level.reliefOffset, level.bytes) : null }];
    }));
  }
  sample(latitude, longitude, level, result) {
    const { width, height, grid, relief } = this.levels.get(level.id);
    const col = Math.floor((wrapLongitude(longitude) + 180) / 360 * width);
    const row = clamp(Math.floor((90 - latitude) / 180 * height), 0, height - 1);
    const id = grid[row * width + col];
    const code = relief ? relief[row * width + col] : 0;
    result.country = id;
    result.coast = false;
    result.border = false;
    // Metres above sea level on land, below it at sea; rugged only on land.
    result.height = id && relief ? (code & 127) * this.relief.landStep : 0;
    result.depth = id || !relief ? 0 : code * this.relief.seaStep;
    result.rugged = Boolean(id && code & 128);
    if (!id) return;
    const left = grid[row * width + (col + width - 1) % width];
    const right = grid[row * width + (col + 1) % width];
    const top = grid[Math.max(0, row - 1) * width + col];
    const bottom = grid[Math.min(height - 1, row + 1) * width + col];
    result.coast = !left || !right || !top || !bottom;
    result.border = (left > 0 && left !== id) || (right > 0 && right !== id) || (top > 0 && top !== id) || (bottom > 0 && bottom !== id);
  }
  labels() { return this.countries; }
}

export const syntheticGeography = {
  loadedBytes: 0,
  continentByCountry: Uint8Array.from({ length: 256 }, (_, id) => id === 1 ? 3 : FALLBACK_CONTINENT),
  labels: () => [],
  sample(latitude, longitude, level, result) {
    const lat = latitude * RAD, lon = longitude * RAD;
    const field = Math.sin(2.3 * lon + Math.cos(lat * 3)) + Math.cos(lat * 4.6 - lon) * 0.64 + Math.sin(lon * 7 + lat * 9) * (0.025 + level.index * 0.055);
    result.country = field > 0.24 ? (longitude < 0 ? 1 : 2) : 0;
    result.coast = result.country > 0 && field < 0.37;
    // Invented relief: higher ground inland, deeper water offshore.
    result.height = result.country ? Math.max(0, Math.round((field - 0.24) * 2400)) : 0;
    result.depth = result.country ? 0 : Math.round(Math.min(1, 0.24 - field) * 4800);
    result.rugged = result.height > 1800;
    result.border = result.country > 0 && Math.abs(longitude) < 1;
  },
};

export async function loadGeography() {
  const [metadataResponse, binaryResponse] = await Promise.all([
    fetch(new URL('./data/world.json', import.meta.url)),
    fetch(new URL('./data/world.bin', import.meta.url)),
  ]);
  if (!metadataResponse.ok || !binaryResponse.ok) throw new Error('Could not load the local geography.');
  const [text, buffer] = await Promise.all([metadataResponse.text(), binaryResponse.arrayBuffer()]);
  return new Geography(JSON.parse(text), buffer, new TextEncoder().encode(text).byteLength);
}
