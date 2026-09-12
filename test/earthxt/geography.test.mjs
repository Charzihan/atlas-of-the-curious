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
  assert.equal(geography.countries.length, 177);
  assert.ok(gzipSync(raw).byteLength + gzipSync(metadataText).byteLength < 10 * 1024 * 1024);
  assert.equal(geography.loadedBytes, raw.byteLength + Buffer.byteLength(metadataText));
  for (const id of raw) assert.ok(id <= geography.countries.length);
  assert.equal(metadata.levels.reduce((sum, level) => sum + level.bytes, 0), raw.byteLength);
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
