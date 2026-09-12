// Node CPU benchmark: real Coastlines masks and all 40 atlas places, with
// synthetic font advances. This does not measure browser fonts, paint or FPS.
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createLabelEngine } from '../../js/labels.js';
import { readFontRoles, readFontFamily } from '../../js/text.js';
import { globePlaces, projectPlaces, createPlaceRouter } from '../../earthxt/places.js';
import { TextRenderer } from '../../earthxt/renderer.js';
import { Geography } from '../../earthxt/geography.js';
import { LEVELS } from '../../earthxt/lod.js';
import { registryDocument } from '../../test/earthxt/fonts-fixture.mjs';

globalThis.OffscreenCanvas = class {
  getContext() { return { measureText: text => ({ width: [...text].length * 6 }) }; }
};
const win = {};
runInNewContext(await readFile(new URL('../../js/data.js', import.meta.url), 'utf8'), { window: win });
const places = globePlaces(win.ATLAS_DATA.places);
const doc = registryDocument(), roles = readFontRoles(doc, ['map-label', 'globe-label']);
const role = roles['map-label'], level = LEVELS[1];
const bytes = await readFile(new URL('../../earthxt/data/world.bin', import.meta.url));
const metadata = JSON.parse(await readFile(new URL('../../earthxt/data/world.json', import.meta.url), 'utf8'));
const geography = new Geography(metadata, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const context = { setTransform() {}, clearRect() {}, fillText() {} };
const renderer = new TextRenderer({ getContext: () => context }, { append() {} },
  { label: roles['globe-label'], mono: readFontFamily(doc, '--font-mono') });
renderer.resize(1440, 1000);
const frames = [];
for (let i = 0; i < 120; i++) {
  const camera = { latitude: -19.917, longitude: -67.846 + i * 1.6 / 60, distance: level.targetDistance };
  renderer.draw(camera, level, geography);
  frames.push({ camera, grid: renderer.grid, blocked: renderer.blockedCells.slice(),
    markers: projectPlaces(places, camera, renderer.viewport, renderer.grid) });
}

const engine = createLabelEngine();
engine.setRoles({ 'map-label': role });
engine.setPlaces(places.map(place => ({ id: place.id, name: place.name, col: 0, row: 0 })));
engine.preparePlaces();
const router = createPlaceRouter(places, role);
const fresh = [], routed = [];
for (let round = 0; round < 3; round++) for (const { camera, grid, blocked, markers } of frames) {
  const visible = markers.filter(marker => marker.visible);
  const start = performance.now();
  engine.setGrid({ cols: grid.cols, rows: grid.rows, land: blocked,
    rowSpan: Math.ceil(role.lineHeight / grid.cellHeight), maxOffset: 12 });
  engine.setMarkerCells(Object.fromEntries(visible.map(marker => [marker.id, [marker.col, marker.row]])));
  const labels = engine.place({ tier: 1, zoom: 1, cellW: grid.cellWidth, dotCells: 1,
    visible: visible.map(marker => marker.id), oceanOn: false }).labels;
  const freshMs = performance.now() - start;
  const before = router.passes(), routeStart = performance.now();
  const out = router.update(camera, level, renderer.viewport, grid, blocked, markers, true);
  const updateMs = performance.now() - routeStart;
  if (round > 0) {
    fresh.push({ ms: freshMs, labels: labels.length, visible: visible.length });
    routed.push({ ms: out.placeLabelMs ?? updateMs, labels: out.labels.length,
      visible: visible.length, passes: router.passes() - before });
  }
}
function summary(samples) {
  const costs = samples.filter(sample => sample.passes !== 0).map(sample => sample.ms).sort((a, b) => a - b);
  return { samples: samples.length, passes: costs.length, p95Ms: costs[Math.floor((costs.length - 1) * 0.95)],
    min: Math.min(...samples.map(sample => sample.labels)), max: Math.max(...samples.map(sample => sample.labels)),
    visible: [...new Set(samples.map(sample => sample.visible))] };
}
console.log(JSON.stringify({ viewport: renderer.viewport, places: places.length,
  fontMetrics: 'synthetic 6px advances; routing only, no browser paint',
  freshPlacement: summary(fresh), router: summary(routed) }, null, 2));
