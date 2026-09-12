import { clamp, wrapLongitude, RAD } from './geometry.js';

/** Local raster provider. Future providers can implement sample() and labels(). */
export class Geography {
  constructor(metadata, buffer, metadataBytes = 0) {
    if (metadata.version !== 1 || buffer.byteLength !== metadata.bytes || metadata.countries.length > 255) {
      throw new Error('The local geography files are incomplete or incompatible.');
    }
    this.metadata = metadata;
    this.loadedBytes = buffer.byteLength + metadataBytes;
    this.countries = metadata.countries;
    this.levels = new Map(metadata.levels.map(level => {
      if (level.bytes !== level.width * level.height || level.offset + level.bytes > buffer.byteLength) throw new Error('Invalid geography level.');
      return [level.id, { ...level, grid: new Uint8Array(buffer, level.offset, level.bytes) }];
    }));
  }
  sample(latitude, longitude, level, result) {
    const { width, height, grid } = this.levels.get(level.id);
    const col = Math.floor((wrapLongitude(longitude) + 180) / 360 * width);
    const row = clamp(Math.floor((90 - latitude) / 180 * height), 0, height - 1);
    const id = grid[row * width + col];
    result.country = id;
    result.coast = false;
    result.border = false;
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
  labels: () => [],
  sample(latitude, longitude, level, result) {
    const lat = latitude * RAD, lon = longitude * RAD;
    const field = Math.sin(2.3 * lon + Math.cos(lat * 3)) + Math.cos(lat * 4.6 - lon) * 0.64 + Math.sin(lon * 7 + lat * 9) * (0.025 + level.index * 0.055);
    result.country = field > 0.24 ? (longitude < 0 ? 1 : 2) : 0;
    result.coast = result.country > 0 && field < 0.37;
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
