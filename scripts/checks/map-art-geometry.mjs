/* Node-only Phase 7 regressions. Geometry needs no browser or font engine;
   the flow integration fixtures use explicitly synthetic, deterministic widths. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { containsLineBox, polygonBoxRuns, countrySlots, boxesOverlap, markerObstacle, createMapArtEngine } from '../../js/map-art.js';
import { MAP_STORY_TYPE, readMapStoryFamily } from '../../js/text.js';
import { clusterPolygons, crossesAntimeridian, encodePolygons, ringBox } from '../map-outline-geometry.mjs';

const rectangle = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const outer = rectangle(0, 0, 100, 40).flat();
// Both exclusions lie between the old row samples (1, 3, 5, 7, 9).
const hole = [outer, rectangle(40, 2.1, 20, 0.1).flat()];
const notch = [[0, 0, 100, 0, 100, 2.1, 50, 2.1, 50, 2.2, 100, 2.2, 100, 40, 0, 40, 0, 0]];
for (const [name, poly, excluded] of [
  ['hole', hole, { x: 40, y: 2.1, width: 20, height: 0.1 }],
  ['notch', notch, { x: 50, y: 2.1, width: 50, height: 0.1 }]
]) {
  const slots = countrySlots(poly, 0, 40, 10, 20);
  assert(slots.some(slot => slot.y === 0), name + ' fixture lost its first row');
  for (const slot of slots) {
    assert(containsLineBox(poly, slot), name + ' returned a box outside land');
    assert(!boxesOverlap(slot, excluded), name + ' returned a box crossing water');
  }
  assert(!containsLineBox(poly, { x: 1, y: 0, width: 98, height: 10 }), name + ' was missed');
}
assert.deepEqual(polygonBoxRuns(hole, 0, 10), [[0, 40], [60, 100]]);
assert.deepEqual(polygonBoxRuns(notch, 0, 10), [[0, 50]]);
// Full row boundaries and both one-sided limits of a horizontal hole edge.
assert.deepEqual(polygonBoxRuns(hole, 2.1, 2.2), [[0, 40], [60, 100]]);
assert.deepEqual(polygonBoxRuns(hole, 2.2, 10), [[0, 100]]);
assert(!containsLineBox([outer], { x: 1, y: -0.1, width: 20, height: 10 }));
assert(!containsLineBox([outer], { x: 1, y: 31, width: 20, height: 10 }));
// A moving diagonal hole must exclude its entire sweep, not just its ends.
assert.deepEqual(polygonBoxRuns([outer, [20, 2, 22, 2, 40, 8, 38, 8, 20, 2]], 0, 10), [[0, 20], [40, 100]]);
assert.deepEqual(polygonBoxRuns([[0, 0, 100, 0, 50, 40, 0, 0]], 0, 10), [[12.5, 87.5]]);

const smallHole = rectangle(2, 2, 0.1, 0.1);
const mainland = [rectangle(0, 0, 10, 10), smallHole];
const distant = [rectangle(30, 0, 4, 4)]; // 16% of the largest, far beyond the gap
const smallIsland = [rectangle(50, 0, 1, 1), rectangle(50.2, 0.2, 0.1, 0.1)];
const kept = clusterPolygons([mainland, distant, smallIsland]);
assert.deepEqual(kept, [mainland, distant], 'lost a large exterior or retained an orphan hole');
assert.equal(encodePolygons(kept, 0.35, 50).length, 3, 'small retained hole disappeared during encoding');
assert.equal(encodePolygons([[mainland[0], rectangle(2, 2, 0.001, 0.001)]], 0.35, 50).length, 0, 'quantisation turned a lake into land');
const dateline = [[179, 0], [-179, 0], [-179, 5], [179, 5], [179, 0]];
assert(crossesAntimeridian(dateline));
assert(crossesAntimeridian([[-179, 0], [0, 2], [179, 0]]), 'closing edge was not checked');
assert.deepEqual(clusterPolygons([[dateline], [mainland[0], dateline], mainland]), [mainland]);
assert.equal(clusterPolygons([[rectangle(178, 0, 2, 2)]]).length, 1, 'already split ring ending at 180 was rejected');
const geo = JSON.parse(readFileSync(new URL('../../data/world-110m-countries.geojson', import.meta.url), 'utf8'));
const malaysia = geo.features.find(f => f.properties.ADMIN === 'Malaysia').geometry.coordinates;
const malaysiaKept = clusterPolygons(malaysia);
assert.equal(malaysiaKept.length, 2, 'peninsular Malaysia was gap-pruned');
assert(malaysiaKept.some(poly => ringBox(poly[0]).x1 < 108));
assert(malaysiaKept.some(poly => ringBox(poly[0]).x0 > 108));

assert.deepEqual(MAP_STORY_TYPE.candidates.map(t => [t.size, t.lineHeight]), [[14, 18], [13, 16], [12, 15], [11, 14], [10, 13]]);
assert.deepEqual(MAP_STORY_TYPE.inset, { size: 12, lineHeight: 16 });
assert.equal(readMapStoryFamily({ defaultView: { getComputedStyle: () => ({ getPropertyValue: name => name === '--font-serif' ? ' Georgia, "Times New Roman", serif ' : '' }) } }), 'Georgia, "Times New Roman", serif');

// Exercise real pretext flow and the anchor/obstacle path with mock metrics.
globalThis.OffscreenCanvas = class {
  getContext() { return { font: '', measureText(text) { return { width: text.length * parseFloat(this.font) * 0.5 }; } }; }
};
try {
  const engine = createMapArtEngine();
  const panel = { x: 0, y: 0, width: 450, height: 600 };
  const req = {
    id: 'fixture', cols: 100, rows: 60, charW: 10, lineH: 10,
    rings: [rectangle(-20, -20, 40, 40).flat()], at: { lon: 0, lat: 0 },
    text: 'A story needs room around its place marker. '.repeat(20).trim(),
    family: 'Georgia, serif', col: 50, row: 30, avoid: [panel]
  };
  const out = engine.country(req);
  assert.equal(out.mode, 'country');
  assert(out.complete);
  assert.equal(out.lines.map(l => l.text).join('').replace(/\s/g, ''), req.text.replace(/\s/g, ''));
  assert(out.shape.box.x >= panel.x + panel.width, 'anchor did not prefer a clear position');
  const marker = markerObstacle(out.marker);
  assert.equal(marker.width, 14.6, 'marker outer stroke was not reserved');
  for (const line of out.lines) {
    assert(containsLineBox(out.shape.rings, line));
    assert(!boxesOverlap(line, panel), 'panel did not remove a slot');
    assert(!boxesOverlap(line, marker), 'marker did not remove a slot');
  }
  // No clear silhouette or inset exists: keep the full text in the caption.
  const blocked = engine.country({ ...req, avoid: [{ x: 0, y: 0, width: 1000, height: 600 }] });
  assert.equal(blocked.mode, 'caption');
  assert.equal(blocked.text, req.text);
} finally { delete globalThis.OffscreenCanvas; }

console.log('Phase 7 Node geometry: exact hole/notch/sloped-edge boxes, panel/marker clearance, complete fallback, font registry, Malaysia, retained holes and antimeridian rejection PASS');
