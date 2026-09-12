import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TextRenderer, countryRunSlots, placeSilhouetteName } from '../../earthxt/renderer.js';
import { prepareFlowText, flowIntoSlots, createMapArtEngine, boxesOverlap } from '../../js/map-art.js';
import { measureNaturalWidth } from '../../vendor/pretext/layout.js';
import { Geography } from '../../earthxt/geography.js';
import { HOME, latLonToCartesian, project } from '../../earthxt/geometry.js';
import { readFontRoles, readFontFamily } from '../../js/text.js';
import { registryDocument } from './fonts-fixture.mjs';
import { LEVELS } from '../../earthxt/lod.js';
const raw = await readFile(new URL('../../earthxt/data/world.bin', import.meta.url));
const meta = JSON.parse(await readFile(new URL('../../earthxt/data/world.json', import.meta.url), 'utf8'));
const data = new Geography(meta, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

const doc = registryDocument();
const fonts = { label: readFontRoles(doc, ['globe-label'])['globe-label'], mono: readFontFamily(doc, '--font-mono') };
let measurements = 0;
globalThis.OffscreenCanvas = class {
  getContext() { return { measureText(text) { measurements++; return { width: [...text].length * 6 }; } }; }
};

// A canvas-command recorder checks the renderer's output without pretending to
// measure browser painting or layout. The Playwright suite covers those APIs.
export function recorder({ nativeSpacing = false, inkHeight = 8 } = {}) {
  const marks = [];
  const context = { setTransform() {}, clearRect() { marks.length = 0; },
    measureText(text) {
      measurements++;
      const spacing = parseFloat(this.letterSpacing) || 0;
      return { width: [...text].length * 6, actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: [...text].length * 6 + Math.max(0, [...text].length - 1) * spacing,
        actualBoundingBoxAscent: inkHeight - 1, actualBoundingBoxDescent: 1 };
    },
    fillText(text, x, y) { marks.push({ text, x, y, color: this.fillStyle, font: this.font, spacing: this.letterSpacing }); } };
  if (nativeSpacing) context.letterSpacing = '0px';
  const canvas = { getContext: () => context };
  const renderer = new TextRenderer(canvas, { append() {} }, fonts);
  renderer.prepareLabels(data.labels());
  return { renderer, marks, canvas };
}
test('globe silhouette matches perspective radius; only text is drawn', () => {
  const { renderer, marks } = recorder();
  renderer.resize(900, 700, 2);
  const metrics = renderer.draw(HOME, LEVELS[0], data);
  const radius = renderer.viewport.focal / Math.sqrt(HOME.distance ** 2 - 1);
  assert.ok(marks.length > 2000);
  assert.equal(metrics.visibleGlyphs, marks.length);
  for (const mark of marks) {
    assert.ok(Math.hypot(mark.x - 450, mark.y - 350) <= radius + 1e-8);
    assert.ok(['#', '+', '·', '~'].includes(mark.text));
  }
  assert.ok(marks.some(mark => mark.text === '#'));
  assert.ok(marks.some(mark => mark.text === '·'));
});
test('rotation changes geography while keeping the spherical silhouette stable', () => {
  const { renderer, marks } = recorder();
  renderer.resize(900, 700);
  renderer.draw(HOME, LEVELS[0], data);
  const original = JSON.stringify(marks), count = marks.length;
  renderer.draw({ ...HOME, longitude: 140 }, LEVELS[0], data);
  assert.equal(marks.length, count);
  assert.notEqual(JSON.stringify(marks), original);
});
test('finer LODs use richer glyphs, show borders, and remain under the viewport budget', () => {
  const { renderer, marks } = recorder();
  let previous = 0;
  renderer.resize(900, 700);
  for (const level of LEVELS) {
    const metrics = renderer.draw({ latitude: 25, longitude: 15, distance: level.targetDistance }, level, data);
    assert.ok(marks.length > previous); previous = marks.length;
    assert.ok(marks.some(mark => mark.text === level.land));
    if (level.borders) assert.ok(marks.some(mark => mark.color === '#dcad79'));
    assert.ok(metrics.totalGlyphs <= 24000);
    assert.ok(Number.isFinite(metrics.projectionMs) && Number.isFinite(metrics.renderMs));
  }
  renderer.resize(5120, 2880, 2);
  assert.ok(renderer.draw({ ...HOME, distance: 1.16 }, LEVELS[2], data).totalGlyphs <= 24000);
});
test('projected country labels are visible, in bounds, and do not overlap', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, hidden: true, textContent: '' }) };
  try {
    const { renderer } = recorder();
    renderer.resize(1000, 800);
    const camera = { latitude: 20, longitude: 15, distance: 1.4 };
    const result = renderer.draw(camera, LEVELS[2], data, { labels: true });
    assert.ok(result.visibleLabels >= 3);
    assert.ok(result.silhouetteLabels >= 3);
    const boxes = [];
    for (const country of data.labels()) {
      const node = renderer.labelNodes.get(country.id);
      if (!node || node.hidden) continue;
      const screen = project(latLonToCartesian(country.latitude, country.longitude), camera, renderer.viewport);
      assert.ok(screen.visible);
      const box = { x: screen.x - node.labelWidth / 2, y: screen.y - 12, w: node.labelWidth, h: 24 };
      assert.ok(box.x >= 32 && box.y >= 60 && box.x + box.w <= 936 && box.y + box.h <= 710);
      for (const b of boxes) assert.ok(box.x + box.w <= b.x || b.x + b.w <= box.x || box.y + box.h <= b.y || b.y + b.h <= box.y);
      boxes.push(box);
    }
    assert.equal(renderer.draw(camera, LEVELS[2], data, { labels: false }).visibleLabels, 0);
    assert.ok([...renderer.labelNodes.values()].every(node => node.hidden));
  } finally { globalThis.document = previousDocument; }
});

test('maximal row runs respect ids, ocean, grid edges, inset and minimum length', () => {
  const ids = Uint8Array.from([
    1, 1, 1, 1, 1, 0, 2, 2, 2, 2, 2, 2,
    1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2,
    0, 0, 0, 0, 0, 3, 3, 3, 0, 0, 0, 0,
  ]);
  const original = ids.slice();
  const slots = countryRunSlots(ids, 12, 3, { cellWidth: 6, cellHeight: 9, x: 2, y: 3 });
  assert.deepEqual([...slots], [
    [1, [{ x: 8, y: 3, width: 18, height: 9 }]],
    [2, [{ x: 44, y: 3, width: 24, height: 9 }, { x: 32, y: 12, width: 36, height: 9 }]],
  ]);
  assert.deepEqual(ids, original);
  assert.equal(countryRunSlots(ids, 0, 0, { cellWidth: 6, cellHeight: 9 }).size, 0);
});

function assertCountryBox(box, id, grid) {
  const { x, y, cols, rows, cellWidth, cellHeight, countryIds } = grid;
  const left = Math.floor((box.x - x + 1e-7) / cellWidth), right = Math.ceil((box.x + box.width - x - 1e-7) / cellWidth);
  const top = Math.floor((box.y - y + 1e-7) / cellHeight), bottom = Math.ceil((box.y + box.height - y - 1e-7) / cellHeight);
  assert.ok(left >= 0 && right <= cols && top >= 0 && bottom <= rows);
  for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
    assert.equal(countryIds[row * cols + col], id, `country ${id} owns cell ${col},${row}`);
  }
}

for (const nativeSpacing of [false, true]) test(`name ink stays over its own cells; spacing API ${nativeSpacing}`, () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, hidden: true }) };
  try {
    const { renderer, marks } = recorder({ nativeSpacing });
    renderer.resize(1000, 800);
    const ids = renderer.countryIds;
    const before = measurements;
    for (const longitude of [15, 25, -106, 130]) {
      const result = renderer.draw({ latitude: 18, longitude, distance: 1.4 }, LEVELS[2], data, { labels: true });
      const { grid, labelPlacements } = renderer.labelSnapshot();
      if (longitude === 15) assert.ok(result.silhouetteLabels >= 3);
      const boxes = [];
      for (const label of labelPlacements) {
        if (label.mode === 'pill') { boxes.push(label.box); continue; }
        assert.ok(label.lines.length <= 3);
        assert.equal(label.lines.map(line => line.text).join(' '), label.name);
        for (const line of label.lines) {
          assertCountryBox(line.slot, label.id, grid);
          assertCountryBox(line.box, label.id, grid);
          boxes.push(line.box);
          assert.ok(Math.abs(line.x - (line.slot.x + (line.slot.width - line.width) / 2)) < 1e-7);
          for (const glyph of line.glyphs) {
            assertCountryBox(glyph.box, label.id, grid);
            assert.ok(glyph.box.x >= line.slot.x && glyph.box.x + glyph.box.width <= line.slot.x + line.slot.width + 1e-7);
          }
          const expected = nativeSpacing ? [line] : line.glyphs;
          for (const part of expected) {
            const mark = marks.find(mark => mark.font === fonts.label.font && mark.text === part.text && mark.x === part.x && mark.y === part.y);
            assert.ok(mark);
            assert.equal(mark.spacing, nativeSpacing ? `${fonts.label.letterSpacing}px` : undefined);
          }
          const last = line.glyphs.at(-1);
          assert.ok(Math.abs(last.x + 6 + fonts.label.letterSpacing - line.x - line.width) < 1e-7,
            'fallback glyph advances include exactly one terminal spacing');
          assert.equal(line.width, measureNaturalWidth(prepareFlowText(line.text, fonts.label.font, fonts.label)));
        }
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!boxesOverlap(boxes[i], boxes[j]));
      assert.equal(result.visibleLabels, labelPlacements.length);
      assert.ok(result.labelMs >= 0 && result.labelMs <= result.renderMs);
      grid.countryIds.fill(0);
      assert.ok(renderer.countryIds.some(id => id > 0), 'snapshot does not expose the mutable buffer');
    }
    assert.equal(measurements, before, 'no pretext or ink measurement in frames');
    assert.equal(renderer.countryIds, ids, 'country buffer is reused');
    renderer.draw(HOME, LEVELS[0], data);
    assert.equal(renderer.labelPlacements.length, 0);
    if (nativeSpacing) assert.ok(marks.every(mark => mark.spacing === '0px'), 'surface glyphs do not inherit label spacing');
    for (let i = 0; i < renderer.grid.cols * renderer.grid.rows; i++) if (!renderer.cells[i]) assert.equal(ids[i], 0, 'off-sphere cells are cleared');
  } finally { globalThis.document = previousDocument; }
});

test('too-tall ink falls back to collision-filtered pills, and toggle hides both modes', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, hidden: true }) };
  try {
    const { renderer } = recorder({ inkHeight: 18 });
    renderer.resize(1000, 800);
    const camera = { latitude: 20, longitude: 15, distance: 1.4 };
    const result = renderer.draw(camera, LEVELS[2], data, { labels: true });
    assert.equal(result.silhouetteLabels, 0);
    assert.ok(result.fallbackLabels >= 3);
    assert.equal(result.visibleLabels, result.fallbackLabels);
    renderer.draw(camera, LEVELS[2], data, { labels: false });
    assert.equal(renderer.labelPlacements.length, 0);
    assert.ok([...renderer.labelNodes.values()].every(node => node.hidden));
    renderer.resize(80, 80);
    assert.equal(renderer.draw(camera, LEVELS[2], data, { labels: true }).visibleLabels, 0);
  } finally { globalThis.document = previousDocument; }
});

test('shared flow keeps whole words, counts terminal spacing once, and limits names to three lines', () => {
  const { renderer } = recorder();
  const text = 'UNITED STATES OF AMERICA', role = fonts.label;
  const measured = renderer.labelMetrics.get(text);
  assert.equal(measured.pre, prepareFlowText(text, role.font, role), 'globe uses shared prepared handle');
  const slots = [0, 1, 2].map(row => ({ x: 0, y: row * 18, width: 50, height: 9 }));
  const lines = placeSilhouetteName(text, role, measured, slots, { x: 25, y: 22.5 });
  assert.equal(lines, null, 'four lines cannot be squeezed into three');
  const wider = placeSilhouetteName(text, role, measured, slots.map(slot => ({ ...slot, width: 70 })), { x: 25, y: 22.5 });
  assert.deepEqual(wider.map(line => line.text), ['UNITED', 'STATES OF', 'AMERICA']);
  const canada = renderer.labelMetrics.get('CANADA');
  const tooNarrow = { x: 0, y: 0, width: 38.75, height: 9 };
  assert.equal(flowIntoSlots('CANADA', role.font, [tooNarrow], { wholeWords: true, prepared: canada.pre }).complete, false);
  const exact = flowIntoSlots('CANADA', role.font, [{ ...tooNarrow, width: 39 }], { wholeWords: true, prepared: canada.pre });
  assert.equal(exact.complete, true);
  assert.equal(exact.lines[0].width, 39);
});

test('atlas silhouette and exported flow reuse the same preparation and line results', () => {
  const engine = createMapArtEngine();
  const request = { cols: 100, rows: 80, charW: 10, lineH: 13, family: fonts.mono,
    text: 'A story flows through the country in whole words. '.repeat(8),
    rings: [[-20, 20, 20, 20, 20, -20, -20, -20]], id: 1 };
  const atlas = engine.country(request);
  assert.equal(atlas.mode, 'country');
  const before = measurements;
  const prepared = prepareFlowText(request.text, atlas.font);
  assert.equal(measurements, before, 'atlas already populated the shared cache');
  const shared = flowIntoSlots(request.text, atlas.font, atlas.lines, { wholeWords: true, prepared });
  assert.equal(shared.complete, true);
  assert.deepEqual(shared.lines, atlas.lines);
  assert.deepEqual(engine.country(request), atlas);
  assert.equal(measurements, before);
});

test('country names are prepared once per font and draw uses cached widths with CSS spacing', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, hidden: true, textContent: '' }) };
  try {
    const { renderer } = recorder();
    const first = renderer.labelMetrics;
    const handle = first.get('CANADA');
    assert.ok(handle.pre);
    assert.equal(handle.width, 6 * 6 + 6 * fonts.label.letterSpacing + 22);
    const measuredBefore = measurements;
    renderer.prepareLabels(data.labels());
    renderer.resize(1000, 800);
    for (const longitude of [15, 25, -106]) {
      renderer.draw({ latitude: 20, longitude, distance: 1.4 }, LEVELS[2], data, { labels: true });
    }
    assert.equal(measurements, measuredBefore, 'no text measurement during repeated preparation or frames');
    assert.equal(first.get('CANADA'), handle);
    renderer.fonts = { ...fonts, label: { ...fonts.label, font: fonts.label.font.replace('10px', '12px') } };
    renderer.prepareLabels(data.labels());
    assert.notEqual(renderer.labelMetrics.get('CANADA').pre, handle.pre);
    renderer.fonts = fonts;
    renderer.prepareLabels(data.labels());
    assert.equal(renderer.labelMetrics.get('CANADA'), handle, 'returning to a font reuses its prepared handle');
  } finally { globalThis.document = previousDocument; }
});
