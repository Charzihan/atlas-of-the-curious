import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCountries, countryAt, classifyCell, scanlineOwnership } from '../../scripts/geo-raster.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const box = (west, south, east, north) => [
  [west, south], [east, south], [east, north], [west, north], [west, south],
];
const feature = (code, polygons) => ({
  properties: { ADM0_A3: code },
  geometry: polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons },
});
const byCode = f => f.properties.ADM0_A3;

test('parsing preserves feature IDs or first code appearance and bounds every ring', () => {
  const features = [
    feature('B', [[box(-20, -10, 20, 10)]]),
    feature('A', [[box(30, -10, 50, 10)]]),
    feature('B', [[box(60, -10, 80, 10)]]),
  ];
  const perFeature = parseCountries(features);
  const perCode = parseCountries(features, byCode);
  assert.deepEqual([...perFeature.keys()], [1, 2, 3]);
  assert.deepEqual([...perCode.keys()], ['B', 'A']);
  assert.equal(perCode.get('B').rings.length, 2);
  assert.equal(perCode.get('B').polygons.length, 2);
  assert.deepEqual(perCode.get('B').rings[0], {
    pts: features[0].geometry.coordinates[0], minX: -20, minY: -10, maxX: 20, maxY: 10,
  });
  assert.equal(countryAt(perFeature, 70, 0), 3);
  assert.equal(countryAt(perCode, 70, 0), 'B');
});

test('point containment includes holes and islands, with first-country precedence', () => {
  const countries = parseCountries([
    feature('A', [[box(-100, -60, 100, 60), box(-20, -20, 20, 20)], [box(120, 0, 160, 40)]]),
    feature('B', [[box(-10, -10, 80, 10)]]),
  ], byCode);
  assert.equal(countryAt(countries, 50, 0), 'A');
  assert.equal(countryAt(countries, 0, 0), 'B');
  assert.equal(countryAt(countries, -15, 0), null);
  assert.equal(countryAt(countries, 140, 20), 'A');
  assert.equal(countryAt(countries, 170, 20), null);
  assert.equal(countryAt(countries, -100, 0), 'A');
  assert.equal(countryAt(countries, 100, 0), null);
});

test('supersampling uses centred row-major samples, inclusive threshold, and last hit', () => {
  // On a 1x1 grid, A hits all four top-row centres and the first centre of
  // row two. B hits only row three, column three; later samples are water.
  const a = feature('A', [[box(-180, 45, 180, 90)], [box(-160, 10, -100, 40)]]);
  const b = feature('B', [[box(20, -40, 70, -10)]]);
  const countries = parseCountries([a, b], byCode);
  assert.equal(classifyCell(countries, 0, 0, 1, 1, 4, 6), 'B');
  assert.equal(classifyCell(countries, 0, 0, 1, 1, 4, 7), null);
  const fiveHits = parseCountries([feature('A', [[box(-180, 45, 180, 90)]]), b], byCode);
  assert.equal(classifyCell(fiveHits, 0, 0, 1, 1, 4, 6), null);
  assert.equal(classifyCell(fiveHits, 0, 0, 1, 1, 4, 5), 'B');
  assert.equal(classifyCell(new Map(), 0, 0, 1, 1, 4, 0), null);
});

test('scanlines retain centre-edge rules, holes, islands, and later feature ownership', () => {
  const pixelBox = (left, top, right, bottom) => box(
    left / 8 * 360 - 180, 90 - bottom / 4 * 180,
    right / 8 * 360 - 180, 90 - top / 4 * 180,
  );
  const countries = parseCountries([
    feature('A', [[pixelBox(0.5, 0.5, 6.5, 3.5), pixelBox(2.5, 1.5, 4.5, 2.5)], [pixelBox(7, 3, 8, 4)]]),
    feature('B', [[pixelBox(5, 1, 8, 3)]]),
  ]);
  assert.deepEqual([...scanlineOwnership(countries, 8, 4)], [
    1, 1, 1, 1, 1, 1, 0, 0,
    1, 1, 0, 0, 1, 2, 2, 2,
    1, 1, 1, 1, 1, 2, 2, 2,
    0, 0, 0, 0, 0, 0, 0, 1,
  ]);
  assert.throws(() => scanlineOwnership(new Map(Array.from({ length: 256 }, (_, i) => [i, {}])), 1, 1), /at most 255/);
});

test('overlapping polygons retain per-country point parity and per-polygon scanline fill', () => {
  const countries = parseCountries([feature('A', [
    [box(-100, -60, 40, 60)], [box(-40, -60, 100, 60)],
  ])]);
  assert.equal(countryAt(countries, 0, 0), null);
  assert.deepEqual([...scanlineOwnership(countries, 1, 1)], [1]);
});

test('both builders reproduce committed geography bytes in a temporary output directory', async t => {
  const source = join(root, 'data/world-110m-countries.geojson');
  try {
    await access(source);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('Natural Earth source data/world-110m-countries.geojson is absent (git-ignored); byte regeneration check skipped.');
    return;
  }
  const output = await mkdtemp(join(tmpdir(), 'geo-raster-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  for (const builder of ['scripts/build-map.mjs', 'scripts/earthxt/build-data.mjs']) {
    await run(process.execPath, [join(root, builder)], {
      cwd: output, env: { ...process.env, GEO_RASTER_OUTPUT_DIR: output }, timeout: 60_000,
    });
  }
  for (const path of ['js/landmap.js', 'earthxt/data/world.bin', 'earthxt/data/world.json']) {
    const actual = await readFile(join(output, path));
    const { stdout: committed } = await run('git', ['show', `HEAD:${path}`], {
      cwd: root, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024,
    });
    assert.ok(actual.equals(committed), `${path} must match committed bytes (got ${actual.length}, expected ${committed.length})`);
  }
});
