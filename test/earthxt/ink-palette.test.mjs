import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createMapArtEngine } from '../../js/map-art.js';
import { readFontRoles, readFontFamily, readMapStoryFamily } from '../../js/text.js';
import { InkPaletteCache } from '../../earthxt/ink-palette.js';
import { TextRenderer } from '../../earthxt/renderer.js';
import { PlaceLayer } from '../../earthxt/place-layer.js';
import { globePlaces } from '../../earthxt/places.js';
import { Geography } from '../../earthxt/geography.js';
import { LEVELS } from '../../earthxt/lod.js';
import { registryDocument } from './fonts-fixture.mjs';
import { bundleEarthxt } from '../../scripts/earthxt/standalone.mjs';

const doc = registryDocument(), roles = readFontRoles(doc);
const fonts = { label: roles['globe-label'], mono: readFontFamily(doc, '--font-mono'), serif: readMapStoryFamily(doc) };
let measurements = 0, inkReads = 0;
// Synthetic advances and alpha coverage exercise the real palette path, not
// browser font rasterization. Every candidate has a different measured tone.
class InkCanvas {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() {
    return {
      scale(dpr) { this.dpr = dpr; }, clearRect() {},
      measureText(text) { measurements++; return { width: [...text].length * 6 }; },
      fillText(glyph, x, y) { Object.assign(this, { glyph, x, y }); },
      getImageData(x, y, width, height) {
        inkReads++;
        const data = new Uint8ClampedArray(width * height * 4), dpr = this.dpr;
        if (this.glyph !== '\ue000') {
          const alpha = this.glyph.codePointAt(0) % 230 + 25;
          for (let row = Math.ceil((this.y - 3) * dpr); row < Math.floor((this.y + 3) * dpr); row++) {
            for (let col = Math.ceil((this.x + 1) * dpr); col < Math.floor((this.x + 5) * dpr); col++) data[(row * width + col) * 4 + 3] = alpha;
          }
        }
        return { data };
      }
    };
  }
}
globalThis.OffscreenCanvas = InkCanvas;

function scheduledEngine() {
  const engine = createMapArtEngine(), tasks = [];
  const cache = new InkPaletteCache(request => engine.paletteAsync(request, task => tasks.push(task)));
  async function finish(promise) {
    await Promise.resolve(); // let cache enqueue its builder
    while (tasks.length) {
      const before = inkReads;
      tasks.shift()();
      assert.ok(inkReads - before <= 1, 'timer fallback measures at most one glyph per task');
    }
    return promise;
  }
  return { engine, cache, tasks, finish };
}

test('palette preparation yields before measurement, shares the atlas path, and caches every key', async () => {
  const { engine, cache, tasks, finish } = scheduledEngine();
  const before = inkReads;
  const pending = cache.prepare(fonts.serif, 8, 11, 1);
  assert.equal(cache.prepare(fonts.serif, 8, 11, 1), pending, 'duplicate pending requests share a promise');
  assert.equal(cache.get(fonts.serif, 8, 11, 1).status, 'building');
  assert.equal(inkReads, before);
  await Promise.resolve();
  assert.equal(inkReads, before, 'even builder startup defers all ink measurement');
  assert.equal(tasks.length, 1);
  const entry = await finish(pending);
  assert.equal(entry.status, 'ready');
  assert.ok(entry.palette.levels >= 6);
  assert.ok(entry.palette.ramp.every(g => g.width <= 8 && g.spill <= 0.06));
  const built = inkReads;
  const request = { family: fonts.serif, charW: 8, lineH: 11, size: 11, dpr: 1, cols: 1, rows: 1 };
  assert.equal(engine.palette(request), entry.palette, 'synchronous atlas action shares the cache');
  assert.deepEqual(createMapArtEngine().palette(request), entry.palette, 'sliced and synchronous measurement return identical palettes');
  assert.ok(inkReads > built);
  const changes = [
    [fonts.serif, 9, 11, 1], [fonts.serif, 8, 12, 1], [fonts.serif, 8, 11, 2],
    [fonts.mono, 8, 11, 1]
  ];
  for (const key of changes) {
    const old = inkReads;
    const next = await finish(cache.prepare(...key));
    assert.equal(next.status, 'ready');
    assert.notEqual(next, entry);
    assert.ok(inkReads > old, 'family, width, height and DPR each invalidate the cache');
  }
  const prepared = { measurements, inkReads };
  for (const key of [[fonts.serif, 8, 11, 1], ...changes]) await cache.prepare(...key);
  assert.deepEqual({ measurements, inkReads }, prepared, 'returning to any prepared key reuses it');
  assert.equal(cache.get(fonts.serif, 8, 11, 1), entry);
});

test('idle preparation respects the available slice and unavailable palettes are cached', async () => {
  const engine = createMapArtEngine(), tasks = [];
  const pending = engine.paletteAsync({ family: fonts.serif, charW: 1, lineH: 9, size: 9, dpr: 1 }, task => tasks.push(task));
  const before = inkReads;
  tasks.shift()({ timeRemaining: () => 0 });
  assert.equal(inkReads, before, 'no work when the idle deadline has expired');
  while (tasks.length) tasks.shift()();
  const palette = await pending;
  assert.equal(palette.usable, false, 'no glyph advance fits a one-pixel cell');
  let builds = 0;
  const cache = new InkPaletteCache(() => { builds++; return palette; });
  assert.equal((await cache.prepare(fonts.serif, 1, 9, 1)).status, 'unavailable');
  await cache.prepare(fonts.serif, 1, 9, 1);
  assert.equal(builds, 1);
  const failed = new InkPaletteCache(() => { throw new Error('no canvas'); });
  assert.match((await failed.prepare(fonts.serif, 8, 11, 1)).reason, /no canvas/);
});

test('standalone bundle executes the same lazy palette without workers or network', async () => {
  const bundled = runInNewContext(await bundleEarthxt('ink-palette.js'), {
    OffscreenCanvas: InkCanvas, Intl, performance, setTimeout: callback => queueMicrotask(callback)
  });
  const cache = new bundled.InkPaletteCache();
  const pending = cache.prepare(fonts.serif, 8, 11, 1);
  assert.equal(cache.prepare(fonts.serif, 8, 11, 1), pending);
  const entry = await pending;
  assert.equal(entry.status, 'ready');
  assert.equal(entry.palette.font, `11px ${fonts.serif}`);
  assert.ok(entry.palette.ramp.every(glyph => glyph.width <= 8 && glyph.spill <= 0.06));
});

class Node {
  constructor() { this.style = { setProperty() {} }; this.dataset = {}; this.hidden = true; this.children = []; }
  setAttribute() {} addEventListener() {} append(...nodes) { this.children.push(...nodes); }
  contains() { return false; } matches() { return false; }
}
const raw = await readFile(new URL('../../earthxt/data/world.bin', import.meta.url));
const meta = JSON.parse(await readFile(new URL('../../earthxt/data/world.json', import.meta.url), 'utf8'));
const geography = new Geography(meta, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const window = {};
runInNewContext(await readFile(new URL('../../js/data.js', import.meta.url), 'utf8'), { window });
const places = globePlaces(window.ATLAS_DATA.places);

function recorder(nativeSpacing, inkHeight) {
  const marks = [];
  const context = { setTransform() {}, clearRect() { marks.length = 0; },
    measureText(text) {
      measurements++;
      return { width: [...text].length * 6, actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: [...text].length * 6 + Math.max(0, [...text].length - 1) * (parseFloat(this.letterSpacing) || 0),
        actualBoundingBoxAscent: inkHeight - 1, actualBoundingBoxDescent: 1 };
    },
    fillText(text, x, y) { marks.push({ text, x, y, font: this.font, color: this.fillStyle, spacing: this.letterSpacing, align: this.textAlign, baseline: this.textBaseline }); },
    beginPath() {}, fill() {}, arc(...args) { marks.push({ dot: args, color: this.fillStyle }); }
  };
  if (nativeSpacing) context.letterSpacing = '0px';
  const renderer = new TextRenderer({ getContext: () => context }, new Node(), fonts);
  renderer.prepareLabels(geography.labels());
  renderer.places = new PlaceLayer(new Node(), new Node(), places, roles, new Map(places.map(place => [place.category, '#abcdef'])));
  renderer.places.resize(1000, 800);
  renderer.resize(1000, 800);
  return { renderer, marks };
}

for (const nativeSpacing of [false, true]) test(`only raster glyphs change; all names and markers hold their pixels (spacing API ${nativeSpacing})`, async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: tag => tag === 'canvas' ? new InkCanvas() : new Node() };
  try {
    for (const inkHeight of [8, 18]) {
      const { renderer, marks } = recorder(nativeSpacing, inkHeight);
      const { cache, finish } = scheduledEngine();
      renderer.palettes = cache;
      const camera = { latitude: 18, longitude: 15, distance: 2.05 }, level = LEVELS[2];
      const options = { labels: true, grid: true, animateOcean: false, time: 1000 };
      const original = renderer.draw(camera, level, geography, options);
      const mono = structuredClone(marks), geometry = renderer.labelSnapshot();
      const placeGeometry = () => {
        const { placeLayoutPasses, ...rest } = renderer.places.snapshot();
        return rest;
      };
      const nodes = () => [...renderer.labelNodes.values(), ...renderer.places.nodes.values()].map(node => ({ hidden: node.hidden, transform: node.style.transform }));
      const originalPlaces = placeGeometry(), originalNodes = nodes();
      assert.ok(original.visibleMarkers > 0);
      assert.ok(original.labelledPlaces > 0);
      assert.ok(inkHeight === 8 ? original.silhouetteLabels >= 3 : original.fallbackLabels >= 3);
      const prepared = { measurements, inkReads };
      renderer.draw(camera, level, geography, { ...options, serif: true });
      assert.deepEqual(marks, mono, 'unrequested palette uses mono without starting a build');
      const pending = renderer.preparePalette(level);
      renderer.draw(camera, level, geography, { ...options, serif: true });
      assert.deepEqual(marks, mono, 'pending palette leaves mono visible');
      assert.deepEqual({ measurements, inkReads }, prepared);
      const entry = await finish(pending), warm = { measurements, inkReads };
      for (const time of [0, 1900, 5000]) {
        const result = renderer.draw(camera, level, geography, { ...options, serif: true, time });
        assert.equal(result.serifActive, true);
        assert.equal(result.visibleGlyphs, original.visibleGlyphs);
        assert.deepEqual(renderer.labelSnapshot(), geometry, 'classification, masks, names and pills stay identical');
        assert.deepEqual(placeGeometry(), originalPlaces);
        assert.deepEqual(nodes(), originalNodes);
        assert.deepEqual(marks.slice(result.visibleGlyphs), mono.slice(original.visibleGlyphs), 'all non-raster canvas marks keep their font and position');
        const raster = marks.slice(0, result.visibleGlyphs);
        const paletteGlyphs = new Map(entry.palette.ramp.map(g => [g.glyph, g]));
        assert.ok(raster.every(mark => paletteGlyphs.has(mark.text) && mark.font === entry.palette.font));
        for (let i = 0; i < raster.length; i++) {
          assert.equal(raster[i].x + paletteGlyphs.get(raster[i].text).width / 2, mono[i].x);
          assert.equal(raster[i].y, mono[i].y);
          assert.equal(raster[i].color, mono[i].color);
        }
      }
      const still = structuredClone(marks);
      renderer.draw(camera, level, geography, { ...options, serif: true, animateOcean: true, time: 1900 });
      assert.notDeepEqual(marks.slice(0, original.visibleGlyphs), still.slice(0, original.visibleGlyphs), 'ocean ripple changes the light-band glyphs');
      renderer.draw(camera, level, geography, options);
      assert.deepEqual(marks, mono, 'switching off restores mono exactly');
      await renderer.preparePalette(level);
      renderer.resize(1001, 800); // below the cap: cell dimensions unchanged
      assert.equal(await renderer.preparePalette(level), entry, 'viewport dimensions alone are not a palette key');
      assert.deepEqual({ measurements, inkReads }, warm, 'frames and prepared toggles perform no measurement');
      renderer.resize(1000, 800, 2);
      assert.equal(renderer.draw(camera, level, geography, { ...options, serif: true }).serifActive, false, 'new DPR cannot paint an old palette');
    }
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('coasts use the darkest tone even at Planet detail; oceans including grid cells use the light band', async () => {
  const { cache, finish } = scheduledEngine();
  const draws = [], samples = [];
  const context = { setTransform() {}, clearRect() { draws.length = 0; },
    fillText(text, x, y) { draws.push({ text, x, y }); } };
  const renderer = new TextRenderer({ getContext: () => context }, new Node(), fonts);
  renderer.palettes = cache;
  renderer.resize(400, 400);
  const entry = await finish(renderer.preparePalette(LEVELS[0]));
  const provider = { sample(latitude, longitude, level, out) {
    out.country = latitude > 0 ? 1 : 0;
    out.coast = out.country && latitude < 5;
    out.border = Boolean(out.coast);
    samples.push({ country: out.country, coast: out.coast });
  } };
  renderer.draw({ latitude: 0, longitude: 0, distance: 3.2 }, LEVELS[0], provider, { serif: true, grid: true });
  // The painter batches by colour; recover row/column order from positions.
  draws.sort((a, b) => a.y - b.y || a.x - b.x);
  assert.equal(draws.length, samples.length);
  assert.ok(samples.some(sample => sample.coast));
  const inland = new Set();
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].coast) assert.equal(draws[i].text, entry.palette.ramp.at(-1).glyph);
    else if (!samples[i].country) assert.ok(entry.ocean.some(g => g.glyph === draws[i].text));
    else inland.add(draws[i].text);
  }
  assert.ok(inland.size >= 2, 'lighting varies inland ink density');
});
