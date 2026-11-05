import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { Geography, syntheticGeography } from '../../earthxt/geography.js';
import { LEVELS } from '../../earthxt/lod.js';
const raw = await readFile(new URL('../../earthxt/data/world.bin', import.meta.url));
const metadataText = await readFile(new URL('../../earthxt/data/world.json', import.meta.url), 'utf8');
const metadata = JSON.parse(metadataText);
const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const geography = new Geography(metadata, buffer, Buffer.byteLength(metadataText));
const sample = (lat, lon, level = LEVELS[2]) => { const out = {}; geography.sample(lat, lon, level, out); return out; };

test('local payload is complete, contains valid IDs, and meets the geographic budget', () => {
  assert.equal(geography.countries.length, 242);
  assert.ok(gzipSync(raw).byteLength + gzipSync(metadataText).byteLength < 10 * 1024 * 1024);
  assert.equal(geography.loadedBytes, raw.byteLength + Buffer.byteLength(metadataText));
  for (const { grid } of geography.levels.values()) for (const id of grid) assert.ok(id <= geography.countries.length);
  // Each level holds ownership, relief and river rasters of the same size.
  assert.equal(metadata.version, 3);
  assert.equal(metadata.levels.reduce((sum, level) => sum + 3 * level.bytes, 0), raw.byteLength);
  for (const level of metadata.levels) {
    assert.equal(level.reliefOffset, level.offset + level.bytes);
    assert.equal(level.riverOffset, level.offset + 2 * level.bytes);
  }
  assert.throws(() => new Geography(metadata, buffer.slice(0, 100)), /incomplete/);
});
test('real-world continental locations and oceans classify correctly at every LOD', () => {
  for (const level of LEVELS) {
    for (const [lat, lon, code] of [[56, -106, 'CAN'], [39, -100, 'USA'], [-10, -52, 'BRA'], [46, 2, 'FRA'], [26, 30, 'EGY'], [-25, 134, 'AUS'], [-80, 0, 'ATA']]) {
      const hit = sample(lat, lon, level);
      assert.equal(geography.countries[hit.country - 1]?.code, code, `${code} at ${level.id}`);
    }
    for (const [lat, lon] of [[0, -140], [0, -25], [-35, 75]]) assert.equal(sample(lat, lon, level).country, 0);
  }
});
test('relief reads real heights, mountains, ice sheets and sea depths', () => {
  const countries = LEVELS[2];
  const at = (lat, lon) => sample(lat, lon, countries);
  // Himalaya and Tibet: high and rugged.
  assert.ok(at(27.99, 86.93).height >= 4000 && at(27.99, 86.93).rugged, 'Everest');
  assert.ok(at(32, 88).height >= 4000, 'Tibetan Plateau');
  // Andes and Alps carry the mountain flag; the Amazon basin and the Netherlands are low.
  assert.ok(at(-32.65, -70.0).rugged, 'Aconcagua');
  assert.ok(at(46.5, 8.0).rugged && at(46.5, 8.0).height >= 1000, 'Bernese Alps');
  assert.ok(at(-3, -60).height <= 200 && !at(-3, -60).rugged, 'Amazon');
  assert.ok(at(52.5, 5.5).height <= 100, 'Netherlands');
  // The ice sheets read as their surface, not the bedrock beneath.
  assert.ok(at(72.58, -38.46).height >= 2500, 'Greenland Summit');
  assert.ok(at(-75.1, 123.35).height >= 2500, 'Dome C');
  assert.ok(at(-89.9, 0).height >= 2000, 'South Pole, beyond the Mercator tiles');
  // Sea depth: shallow shelf, abyssal plain, trench; land carries no depth.
  assert.ok(at(55, 3).depth < 200, 'North Sea shelf');
  assert.ok(at(30, -50).depth >= 3000, 'North Atlantic');
  assert.ok(at(11.35, 142.2).depth >= 6000, 'Mariana Trench');
  assert.equal(at(46, 2).depth, 0);
  for (const level of LEVELS) assert.ok(sample(27.99, 86.93, level).height >= 3000, `Himalaya at ${level.id}`);
});
test('rivers follow their courses, by rank, on land only', () => {
  const countries = LEVELS[2];
  const near = (lat, lon, radius = 0.5) => {
    let best = 0;
    for (let dLat = -radius; dLat <= radius; dLat += 0.25) for (let dLon = -radius; dLon <= radius; dLon += 0.25) {
      const river = sample(lat + dLat, lon + dLon, countries).river;
      if (river && (!best || river < best)) best = river;
    }
    return best;
  };
  // China's two great rivers: the Yangtze at Wuhan and Nanjing, the Yellow River at Lanzhou and Zhengzhou.
  assert.equal(near(30.6, 114.3), 1, 'Yangtze at Wuhan');
  assert.equal(near(32.05, 118.8), 1, 'Yangtze at Nanjing');
  assert.equal(near(36.06, 103.8), 3, 'Yellow River at Lanzhou');
  assert.ok(near(34.9, 113.6) && near(34.9, 113.6) <= 3, 'Yellow River at Zhengzhou');
  assert.ok(near(-3.1, -60.0) === 1, 'Amazon at Manaus');
  assert.ok(near(30.0, 31.2) && near(30.0, 31.2) <= 2, 'Nile at Cairo');
  // No river is recorded at sea, and directions are one of four line glyphs.
  for (const level of LEVELS) {
    const { grid, rivers } = geography.levels.get(level.id);
    let count = 0;
    for (let cell = 0; cell < grid.length; cell++) if (rivers[cell]) { count++; assert.ok(grid[cell] > 0); assert.ok((rivers[cell] & 15) >= 1); }
    assert.ok(count > 0, level.id);
  }
});
test('borders are one cell wide: only the west or north side of a line marks it', () => {
  const level = LEVELS[2], { width, height, grid } = geography.levels.get(level.id);
  let checked = 0;
  for (let row = 1; row < height - 1; row++) for (let col = 1; col < width - 1; col++) {
    const id = grid[row * width + col];
    if (!id) continue;
    const at = (r, c) => grid[r * width + c];
    const foreign = other => other > 0 && other !== id;
    const out = sample(90 - (row + 0.5) * 180 / height, -180 + (col + 0.5) * 360 / width, level);
    const eastOrSouth = foreign(at(row, col + 1)) || foreign(at(row + 1, col)) || foreign(at(row + 1, col + 1));
    assert.equal(out.border, eastOrSouth);
    if (!eastOrSouth && (foreign(at(row, col - 1)) || foreign(at(row - 1, col)))) checked++;
  }
  // Plenty of cells sit just east or south of a border and stay unmarked.
  assert.ok(checked > 1000, `${checked}`);
});
test('version 1 files without relief still load as flat land and sea', () => {
  const ownership = new Uint8Array(metadata.levels.reduce((sum, level) => sum + level.bytes, 0));
  let offset = 0;
  const levels = metadata.levels.map(level => {
    ownership.set(new Uint8Array(buffer, level.offset, level.bytes), offset);
    const moved = { id: level.id, width: level.width, height: level.height, offset, bytes: level.bytes };
    offset += level.bytes;
    return moved;
  });
  const legacy = new Geography({ version: 1, bytes: ownership.byteLength, levels, countries: metadata.countries }, ownership.buffer);
  const out = {};
  legacy.sample(27.99, 86.93, LEVELS[2], out);
  assert.ok(out.country > 0);
  assert.deepEqual([out.height, out.depth, out.rugged], [0, 0, false]);
  legacy.sample(11.35, 142.2, LEVELS[2], out);
  assert.deepEqual([out.country, out.depth, out.river], [0, 0, 0]);
});
test('longitude wraps seamlessly and pole lookups stay in bounds', () => {
  for (const lat of [-90, -70, 0, 50, 90]) {
    assert.deepEqual(sample(lat, -180), sample(lat, 180));
    assert.deepEqual(sample(lat, 45), sample(lat, 405));
    assert.ok(Number.isInteger(sample(lat, -180).country));
  }
});
test('finer levels retain more coastline and country detail', () => {
  const counts = LEVELS.map(level => {
    let coasts = 0, borders = 0;
    const { width, height } = geography.levels.get(level.id);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const hit = sample(90 - (y + 0.5) * 180 / height, -180 + (x + 0.5) * 360 / width, level);
      if (hit.coast) coasts++;
      if (hit.border) { assert.ok(hit.country); borders++; }
    }
    return { coasts, borders };
  });
  assert.ok(counts[2].coasts > counts[1].coasts && counts[1].coasts > counts[0].coasts);
  assert.ok(counts[2].borders > counts[1].borders && counts[1].borders > counts[0].borders);
});
test('synthetic mode supplies both land and water without loading geography', () => {
  const out = {}, ids = new Set();
  for (let lat = -80; lat <= 80; lat += 10) for (let lon = -180; lon < 180; lon += 10) {
    syntheticGeography.sample(lat, lon, LEVELS[2], out); ids.add(out.country);
  }
  assert.ok(ids.has(0) && ids.has(1)); assert.equal(syntheticGeography.loadedBytes, 0); assert.deepEqual(syntheticGeography.labels(), []);
});
