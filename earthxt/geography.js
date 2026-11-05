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
    if (![1, 2, 3].includes(metadata.version) || buffer.byteLength !== metadata.bytes || metadata.countries.length > 255) {
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
    // Version 1 files carry ownership only; their relief reads as flat ground
    // and sea. Rivers arrive with version 3.
    this.relief = metadata.relief || null;
    this.rivers = metadata.rivers || null;
    this.levels = new Map(metadata.levels.map(level => {
      if (level.bytes !== level.width * level.height || level.offset + level.bytes > buffer.byteLength) throw new Error('Invalid geography level.');
      if (this.relief && !(level.reliefOffset + level.bytes <= buffer.byteLength)) throw new Error('Invalid geography relief.');
      if (this.rivers && !(level.riverOffset + level.bytes <= buffer.byteLength)) throw new Error('Invalid geography rivers.');
      return [level.id, { ...level, grid: new Uint8Array(buffer, level.offset, level.bytes),
        relief: this.relief ? new Uint8Array(buffer, level.reliefOffset, level.bytes) : null,
        rivers: this.rivers ? new Uint8Array(buffer, level.riverOffset, level.bytes) : null }];
    }));
  }
  sample(latitude, longitude, level, result) {
    const { width, height, grid, relief, rivers } = this.levels.get(level.id);
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
    // River rank (Natural Earth scalerank, 1 = largest; 0 = none) and direction.
    const river = rivers ? rivers[row * width + col] : 0;
    result.river = river & 15;
    result.riverDirection = river >> 4 & 3;
    if (!id) return;
    const left = grid[row * width + (col + width - 1) % width];
    const right = grid[row * width + (col + 1) % width];
    const top = grid[Math.max(0, row - 1) * width + col];
    const bottom = grid[Math.min(height - 1, row + 1) * width + col];
    const diagonal = grid[Math.min(height - 1, row + 1) * width + (col + 1) % width];
    result.coast = !left || !right || !top || !bottom;
    // A border is one cell wide: only the cell west or north of the line marks
    // it (its east, south or south-east neighbour belongs to another country).
    result.border = (right > 0 && right !== id) || (bottom > 0 && bottom !== id) || (diagonal > 0 && diagonal !== id);
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
    result.river = 0;
    result.riverDirection = 0;
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
