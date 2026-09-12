import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { globePlaces, parsePlaceHash, projectPlaces, createPlaceRouter } from '../../earthxt/places.js';
import { PlaceLayer } from '../../earthxt/place-layer.js';
import { TextRenderer } from '../../earthxt/renderer.js';
import { Geography } from '../../earthxt/geography.js';
import { LEVELS } from '../../earthxt/lod.js';
import { cellsOf } from '../../js/labels.js';
import { readFontRoles, readFontFamily, createMetrics } from '../../js/text.js';
import { readCategoryColors } from '../../js/category-colors.js';
import { fitHoverTagline } from '../../js/hover-card.js';
import { registryDocument, registryCSS } from './fonts-fixture.mjs';

let measurements = 0;
globalThis.OffscreenCanvas = class {
  getContext() { return { measureText(text) { measurements++; return { width: [...text].length * 6 }; } }; }
};
const win = {};
runInNewContext(await readFile(new URL('../../js/data.js', import.meta.url), 'utf8'), { window: win });
const places = globePlaces(win.ATLAS_DATA.places);
const doc = registryDocument();
const roles = readFontRoles(doc, ['map-label', 'hover-card', 'globe-label']);
const role = roles['map-label'];
const viewport = { width: 1000, height: 700, focal: 805 };
const grid = { cols: 100, rows: 70, cellWidth: 10, cellHeight: 10, x: 0, y: 0 };

test('place hashes are decoded and malformed paths are rejected', () => {
  assert.equal(parsePlaceHash('#/place/salar-de-uyuni'), 'salar-de-uyuni');
  assert.equal(parsePlaceHash('#/place/%73alar-de-uyuni'), 'salar-de-uyuni');
  for (const hash of ['', '#/', '#/place/', '#/place/a/b', '#/place/%', '#/place/%2F', '#/place/a?b', '#/place/a#b', '#/place/../', '#/place/%00']) assert.equal(parsePlaceHash(hash), null, hash);
});

test('all 40 atlas coordinates project; perspective horizon hides the far side', () => {
  assert.equal(places.length, 40);
  const home = places.find(place => place.id === 'salar-de-uyuni');
  assert.equal(home.latitude, -19.917);
  assert.equal(home.longitude, -67.846);
  const markers = projectPlaces(places, { ...home, distance: 2.05 }, viewport, grid);
  const at = markers.find(marker => marker.id === home.id);
  assert.equal(at.visible, true);
  assert.ok(Math.abs(at.x - viewport.width / 2) < 1e-7);
  assert.ok(Math.abs(at.y - viewport.height / 2) < 1e-7);
  assert.equal(markers.find(marker => marker.id === 'zhangjiajie').visible, false);
  const antipode = projectPlaces([home], { latitude: -home.latitude, longitude: home.longitude + 180, distance: 2.05 }, viewport, grid)[0];
  assert.equal(antipode.visible, false);
});

function assertClear(out, blocked, grid) {
  const occupied = new Set();
  for (const rec of out.labels) {
    assert.deepEqual(rec.cells, cellsOf(rec));
    for (const span of rec.cells) {
      assert.ok(span.row >= 0 && span.row < grid.rows && span.c0 >= 0 && span.c1 < grid.cols);
      for (let col = span.c0; col <= span.c1; col++) {
        const cell = span.row * grid.cols + col;
        assert.equal(blocked[cell], 0, 'cell is water on the disc');
        assert.ok(!out.markerCells.has(cell), 'no label cell under a marker');
        assert.ok(!occupied.has(cell), 'labels do not overlap');
        occupied.add(cell);
      }
    }
  }
}

test('routed labels stay on a synthetic disc, clear land and markers, and reserve full line height', () => {
  const blocked = new Uint8Array(grid.cols * grid.rows);
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    blocked[row * grid.cols + col] = Math.hypot(col - 50, row - 35) > 32 || (col >= 47 && col <= 53 && row >= 31 && row <= 38) ? 1 : 0;
  }
  const items = [{ id: 'island', name: 'AN ISLAND WITH A LONG NAME' }, { id: 'water', name: 'Blue Cove' }];
  const markers = [{ id: 'island', col: 50, row: 35, visible: true }, { id: 'water', col: 58, row: 40, visible: true }];
  const camera = { latitude: 0, longitude: 0, distance: 2.05 };
  const router = createPlaceRouter(items, role), prepared = measurements;
  const out = router.update(camera, LEVELS[1], viewport, grid, blocked, markers, true);
  assert.equal(out.labels.length, 2);
  assertClear(out, blocked, grid);
  assert.ok(out.labels.every(label => label.rowSpan === 2));
  for (const label of out.labels) for (let i = 1; i < label.lines.length; i++) assert.ok(label.lines[i].row - label.lines[i - 1].row >= 2);
  const held = router.update({ ...camera, longitude: 0.001 }, LEVELS[1], viewport, grid, blocked, markers, true);
  assert.equal(router.passes(), 1, 'subcell camera travel holds the last placement');
  assert.deepEqual(held.labels, out.labels);
  const span = out.labels[0].cells[0];
  blocked[span.row * grid.cols + span.c0] = 1;
  const clipped = router.update(camera, LEVELS[1], viewport, grid, blocked, markers, true);
  assert.equal(clipped.labels.length, 1, 'new land invalidates a held label immediately');
  assertClear(clipped, blocked, grid);
  router.update({ ...camera, longitude: 2 }, LEVELS[1], viewport, grid, blocked, markers, true);
  assert.equal(router.passes(), 2);
  assert.equal(measurements, prepared, 'frames never prepare text or measure glyphs');
  assert.equal(router.update(camera, LEVELS[0], viewport, grid, blocked, markers, true).labels.length, 0);
  assert.equal(router.update(camera, LEVELS[2], viewport, grid, blocked, markers, false).labels.length, 0);
});

test('real South American coastlines have at least four visible and routed places with stubbed advances', async () => {
  const bytes = await readFile(new URL('../../earthxt/data/world.bin', import.meta.url));
  const metadata = JSON.parse(await readFile(new URL('../../earthxt/data/world.json', import.meta.url), 'utf8'));
  const geography = new Geography(metadata, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const context = { setTransform() {}, clearRect() {}, fillText() {} };
  const renderer = new TextRenderer({ getContext: () => context }, { append() {} }, { label: roles['globe-label'], mono: readFontFamily(doc, '--font-mono') });
  renderer.resize(1000, 700);
  const camera = { latitude: -19.917, longitude: -67.846, distance: LEVELS[1].targetDistance };
  renderer.draw(camera, LEVELS[1], geography);
  const markers = projectPlaces(places, camera, renderer.viewport, renderer.grid);
  const router = createPlaceRouter(places, role);
  const out = router.update(camera, LEVELS[1], renderer.viewport, renderer.grid, renderer.blockedCells, markers, true);
  assert.ok(markers.filter(marker => marker.visible).length >= 4);
  assert.ok(out.labels.length >= 4, `${out.labels.length} routed names; Node advances are synthetic, not browser measurements`);
  assertClear(out, renderer.blockedCells, renderer.grid);
});

test('shared hover fitting preserves complete taglines and cached metrics across repeated layout', () => {
  const metrics = createMetrics(roles);
  for (const place of places) {
    const options = { maxWidth: 222, minWidth: 160,
      linesOfText: (text, width) => metrics.linesOfText('hover-card', text, width),
      tightWidthOfText: (text, width) => metrics.tightWidthOfText('hover-card', text, width) };
    const fit = fitHoverTagline(place.tagline, options);
    const prepared = measurements;
    assert.deepEqual(fitHoverTagline(place.tagline, options), fit);
    assert.equal(measurements, prepared);
    assert.equal(fit.lines.join('').replace(/\s/g, ''), place.tagline.replace(/\s/g, ''), 'wrapping preserves every non-whitespace character, including breaks at hyphens');
    assert.ok(fit.width <= 222);
    assert.ok(fit.lines.every(line => line === line.trimEnd()));
  }
});

test('both marker adapters resolve the atlas category palette from shared CSS', async () => {
  const css = await readFile(new URL('../../css/tokens.css', import.meta.url), 'utf8');
  const colors = readCategoryColors(registryDocument(registryCSS + css), win.ATLAS_DATA.categories);
  for (const category of win.ATLAS_DATA.categories) assert.equal(colors.get(category.id), category.accent);
  for (const file of ['js/map.js', 'earthxt/app.js']) assert.match(await readFile(new URL('../../' + file, import.meta.url), 'utf8'), /readCategoryColors/);
});


// A DOM/canvas command recorder verifies adapter state and preparation, not
// browser layout, focus order, hit testing, fonts, or navigation itself.
test('place adapter mirrors visibility, paints tracked names without preparation, and keeps standalone activation local', () => {
  class Node {
    constructor(tag) { this.tag = tag; this.dataset = {}; this.attributes = new Map(); this.events = new Map(); this.children = []; this.style = { setProperty() {} }; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(name, fn) { this.events.set(name, fn); }
    append(node) { this.children.push(node); }
    contains() { return false; }
    matches() { return false; }
    get offsetWidth() { return parseFloat(this.style.width) || 200; }
    get offsetHeight() { return 200; }
  }
  const document = globalThis.document, window = globalThis.window;
  const destinations = [];
  globalThis.document = { createElement: tag => new Node(tag), activeElement: null };
  globalThis.window = { location: { assign: url => destinations.push(url) } };
  try {
    const here = places.find(place => place.id === 'fez-medina');
    const items = [here, places.find(place => place.id === 'zhangjiajie')];
    const allRoles = readFontRoles(doc, ['map-label', 'hover-card', 'hover-name', 'native-name', 'hover-loc', 'hover-cta']);
    for (const standalone of [false, true]) {
      const adapter = new PlaceLayer(new Node('stage'), new Node('layer'), items, allRoles, new Map(items.map(place => [place.category, '#123456'])), { standalone });
      adapter.resize(viewport.width, viewport.height);
      const marks = [], dots = [];
      const ctx = { letterSpacing: '0px', fillText(text, x, y) { marks.push({ text, x, y, font: this.font, spacing: this.letterSpacing }); }, beginPath() {}, arc(...args) { dots.push(args); }, fill() {} };
      const camera = { ...here, distance: 2.05 };
      const blocked = new Uint8Array(grid.cols * grid.rows);
      const prepared = measurements;
      adapter.draw(ctx, camera, LEVELS[1], viewport, grid, blocked, true, true);
      const visible = adapter.markers.filter(marker => marker.visible);
      assert.equal(dots.length, visible.length);
      for (const marker of adapter.markers) assert.equal(adapter.nodes.get(marker.id).hidden, !marker.visible);
      assert.equal(adapter.nodes.get(here.id).attributes.get('aria-label'), `${here.name}, ${here.country}`);
      assert.ok(marks.length);
      assert.ok(marks.every(mark => mark.font === role.font && mark.spacing === `${role.letterSpacing}px` && mark.text === mark.text.toUpperCase()));
      adapter.show(here.id);
      assert.equal(adapter.parts.native.dir, 'rtl');
      assert.equal(adapter.card.hidden, false);
      adapter.nodes.get(here.id).events.get('click')();
      if (standalone) {
        assert.equal(adapter.parts.cta.tag, 'p');
        assert.ok(here.story.startsWith(adapter.parts.cta.textContent));
      } else assert.equal(destinations.at(-1), `../#/place/${here.id}`);
      const count = destinations.length;
      const lines = adapter.labels.flatMap(label => label.lines.map(line => line.text));
      delete ctx.letterSpacing;
      marks.length = 0;
      adapter.draw(ctx, camera, LEVELS[1], viewport, grid, blocked, true, true);
      assert.equal(marks.map(mark => mark.text).join(''), lines.join(''), 'fallback submits cached graphemes for every routed line');
      adapter.draw(ctx, camera, LEVELS[1], viewport, grid, blocked, true, false);
      assert.equal(adapter.card.hidden, true);
      assert.ok([...adapter.nodes.values()].every(node => node.hidden));
      assert.equal(measurements, prepared, 'show/draw/activation do not prepare or measure text');
      assert.equal(destinations.length, count);
    }
    assert.equal(destinations.length, 1, 'standalone click did not navigate');
  } finally {
    if (document === undefined) delete globalThis.document; else globalThis.document = document;
    if (window === undefined) delete globalThis.window; else globalThis.window = window;
  }
});
