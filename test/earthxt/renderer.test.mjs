import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TextRenderer } from '../../earthxt/renderer.js';
import { Geography } from '../../earthxt/geography.js';
import { HOME, latLonToCartesian, project } from '../../earthxt/geometry.js';
import { LEVELS } from '../../earthxt/lod.js';
const raw = await readFile(new URL('../../earthxt/data/world.bin', import.meta.url));
const meta = JSON.parse(await readFile(new URL('../../earthxt/data/world.json', import.meta.url), 'utf8'));
const data = new Geography(meta, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

// A canvas-command recorder checks the renderer's output without pretending to
// measure browser painting or layout. The Playwright suite covers those APIs.
export function recorder() {
  const marks = [];
  const context = { setTransform() {}, clearRect() { marks.length = 0; }, measureText(text) { return { width: text.length * 6 }; },
    fillText(text, x, y) { marks.push({ text, x, y, color: this.fillStyle }); } };
  const canvas = { getContext: () => context };
  const renderer = new TextRenderer(canvas, { append() {} });
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
