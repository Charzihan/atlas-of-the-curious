/** Real browser checks. Fails explicitly if the server or browser is unavailable.
 * Run npm run build:earthxt first, then npm run smoke:earthxt.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer, launchChromium } from '../browser-harness.mjs';
import { buildStandalone } from './standalone.mjs';

function assertSilhouetteContainment(snapshot) {
  const { grid, labelPlacements } = snapshot;
  const silhouettes = labelPlacements.filter(label => label.mode === 'silhouette');
  assert.ok(silhouettes.length >= 3, 'at least three country names are silhouette-set over Africa');
  assert.equal(silhouettes.length, snapshot.silhouetteLabels);
  const inside = (box, slot) => box.x >= slot.x - 1e-7 && box.y >= slot.y - 1e-7 &&
    box.x + box.width <= slot.x + slot.width + 1e-7 && box.y + box.height <= slot.y + slot.height + 1e-7;
  const ownCells = (box, id) => {
    const left = Math.floor((box.x - grid.x + 1e-7) / grid.cellWidth);
    const right = Math.ceil((box.x + box.width - grid.x - 1e-7) / grid.cellWidth);
    const top = Math.floor((box.y - grid.y + 1e-7) / grid.cellHeight);
    const bottom = Math.ceil((box.y + box.height - grid.y - 1e-7) / grid.cellHeight);
    assert.ok(left >= 0 && right <= grid.cols && top >= 0 && bottom <= grid.rows);
    for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
      assert.equal(grid.countryIds[row * grid.cols + col], id, `country ${id} owns drawn cell ${col},${row}`);
    }
  };
  const boxes = [];
  for (const label of labelPlacements) {
    if (label.mode === 'pill') { boxes.push(label.box); continue; }
    assert.ok(label.lines.length > 0 && label.lines.length <= 3);
    for (const line of label.lines) {
      assert.ok(inside(line.box, line.slot), `${label.name} ink stays in its slot`);
      ownCells(line.slot, label.id);
      ownCells(line.box, label.id);
      for (const glyph of line.glyphs) {
        assert.ok(inside(glyph.box, line.slot), `${label.name}: ${glyph.text} stays in its slot`);
        ownCells(glyph.box, label.id);
      }
      boxes.push(line.box);
    }
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, 'names do not overlap');
  }
}

// Instrument only explicit comparison frames; restore native submission before
// profiling. The source of truth is the actual canvas commands, not the ramp.
async function captureInk(page) {
  return page.evaluate(async () => {
    const canvas = document.getElementById('globe'), ctx = canvas.getContext('2d');
    const fillText = ctx.fillText, clearRect = ctx.clearRect;
    let marks = [];
    ctx.fillText = function (text, x, y, ...rest) {
      marks.push({ text, x, y, font: this.font });
      return fillText.call(this, text, x, y, ...rest);
    };
    ctx.clearRect = function (...args) { marks = []; return clearRect.apply(this, args); };
    try {
      document.getElementById('grid-toggle').dispatchEvent(new Event('change'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const state = EARTHXT_DEBUG.snapshot({ includeGeometry: true });
      const raster = marks.slice(0, state.visibleGlyphs);
      return { glyphs: [...new Set(raster.map(mark => mark.text))].sort(),
        rasterText: raster.map(mark => mark.text).join(''),
        rasterFonts: [...new Set(raster.map(mark => mark.font))],
        overlays: marks.slice(state.visibleGlyphs), grid: state.grid, labelPlacements: state.labelPlacements,
        markers: state.markers, placeLabels: state.placeLabels,
        nodes: [...document.querySelectorAll('.country-label, .globe-marker')].map(node => ({ hidden: node.hidden, transform: node.style.transform })) };
    } finally { ctx.fillText = fillText; ctx.clearRect = clearRect; }
  });
}

async function assertSerifToggle(page) {
  await page.waitForFunction(() => {
    const state = EARTHXT_DEBUG.snapshot();
    return !state.autoRotate && state.distance === state.targetDistance;
  });
  const mono = await captureInk(page);
  await page.locator('#serif-toggle').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => EARTHXT_DEBUG.snapshot().serifActive, null, { timeout: 15000 });
  assert.ok(await page.locator('#serif-toggle').isChecked());
  assert.equal(await page.locator('#serif-toggle').getAttribute('aria-busy'), 'false');
  const serif = await captureInk(page);
  assert.notDeepEqual(serif.glyphs, mono.glyphs, 'toggling changes the submitted raster glyph set');
  assert.notDeepEqual(serif.rasterFonts, mono.rasterFonts);
  const ramp = await page.evaluate(() => EARTHXT_DEBUG.snapshot().serifPalette.ramp.map(g => g.glyph));
  assert.ok(serif.glyphs.every(glyph => ramp.includes(glyph)));
  for (const key of ['overlays', 'grid', 'labelPlacements', 'markers', 'placeLabels', 'nodes']) {
    assert.deepEqual(serif[key], mono[key], `${key} stays at the same pixels when Serif is toggled`);
  }
}

let server, browser;
try {
  const standalone = await buildStandalone();
  server = await startServer();
  const launch = await launchChromium();
  if (!launch.browser) throw new Error(launch.reason);
  browser = launch.browser;
  await mkdir(new URL('../../test-results/earthxt/', import.meta.url), { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [], externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (!request.url().startsWith(server.origin) && !request.url().startsWith('data:')) externalRequests.push(request.url()); });
  const snapshot = () => page.evaluate(() => window.EARTHXT_DEBUG.snapshot());
  const settled = () => page.waitForFunction(() => Math.abs(EARTHXT_DEBUG.snapshot().distance - EARTHXT_DEBUG.snapshot().targetDistance) < 0.001);
  // Exercise the published copy under a project subpath, not just source files.
  await page.goto(server.origin + '/dist/earthxt/');
  await page.waitForFunction(() => window.EARTHXT_DEBUG?.snapshot().visibleGlyphs > 500);
  await page.locator('#reset-view').click(); await settled();
  assert.equal((await snapshot()).countryCount, 177);
  assert.equal((await snapshot()).lod, 0);
  await page.screenshot({ path: new URL('../../test-results/earthxt/desktop.png', import.meta.url).pathname, fullPage: true });
  const box = await page.locator('#globe').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const beforeDrag = await snapshot();
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 120, cy + 25, { steps: 8 }); await page.mouse.up();
  assert.ok(Math.abs((await snapshot()).longitude - beforeDrag.longitude) > 5);
  assert.equal((await snapshot()).activePointers, 0);
  const beforeWheel = (await snapshot()).distance;
  await page.mouse.wheel(0, -250); await settled();
  assert.ok((await snapshot()).distance < beforeWheel);
  for (const lod of [1, 2, 0]) {
    await page.locator(`[data-level="${lod}"]`).click(); await settled();
    assert.equal((await snapshot()).lod, lod);
  }
  // Turn toward Africa, ensuring several label anchors are on the near surface.
  await page.locator('#reset-view').click(); await settled();
  await page.locator('#globe').focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await page.locator('[data-level="2"]').click(); await settled();
  await page.waitForFunction(() => EARTHXT_DEBUG.snapshot().silhouetteLabels >= 3);
  assertSilhouetteContainment(await page.evaluate(() => EARTHXT_DEBUG.snapshot({ includeGeometry: true })));
  await page.screenshot({ path: new URL('../../test-results/earthxt/countries.png', import.meta.url).pathname, fullPage: true });
  // Sample actual rendered frames with names enabled. CPU submission and rAF
  // intervals are reported separately; this is not a GPU completion benchmark.
  await page.locator('#rotate-toggle').click();
  await page.waitForFunction(() => EARTHXT_DEBUG.snapshot().autoRotate);
  const rotation = await page.evaluate(async () => {
    const samples = [];
    const start = performance.now(), initial = EARTHXT_DEBUG.snapshot();
    let previousFrame = initial.frameNumber, previousTime = 0;
    while (performance.now() - start < 2000) {
      const time = await new Promise(resolve => requestAnimationFrame(resolve));
      const state = EARTHXT_DEBUG.snapshot();
      if (state.frameNumber === previousFrame) continue;
      if (previousTime) samples.push({ intervalMs: time - previousTime, cpuMs: state.projectionMs + state.renderMs,
        labelMs: state.labelMs, silhouetteLabels: state.silhouetteLabels, lod: state.lod, labels: state.labels });
      previousFrame = state.frameNumber; previousTime = time;
    }
    return { samples, fromLongitude: initial.longitude, toLongitude: EARTHXT_DEBUG.snapshot().longitude };
  });
  assert.ok(rotation.samples.length > 1, 'rotation produced multiple rendered frames');
  assert.ok(rotation.toLongitude > rotation.fromLongitude);
  for (const sample of rotation.samples) {
    assert.equal(sample.lod, 2); assert.equal(sample.labels, true);
    assert.ok(sample.silhouetteLabels >= 3);
    for (const key of ['intervalMs', 'cpuMs', 'labelMs']) assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0);
    assert.ok(sample.labelMs <= sample.cpuMs);
  }
  const percentile = (key, p) => rotation.samples.map(sample => sample[key]).sort((a, b) => a - b)[Math.floor((rotation.samples.length - 1) * p)];
  const timing = { frames: rotation.samples.length,
    intervalMs: { median: percentile('intervalMs', 0.5), p95: percentile('intervalMs', 0.95) },
    cpuMs: { median: percentile('cpuMs', 0.5), p95: percentile('cpuMs', 0.95) },
    labelMs: { median: percentile('labelMs', 0.5), p95: percentile('labelMs', 0.95) } };
  await writeFile(new URL('../../test-results/earthxt/countries-timing.json', import.meta.url), JSON.stringify({ timing, ...rotation }, null, 2) + '\n');
  console.log('Countries auto-rotation timing:', JSON.stringify(timing));
  await page.locator('#rotate-toggle').click();
  assertSilhouetteContainment(await page.evaluate(() => EARTHXT_DEBUG.snapshot({ includeGeometry: true })));
  await assertSerifToggle(page);
  await page.screenshot({ path: new URL('../../test-results/earthxt/countries-serif.png', import.meta.url).pathname, fullPage: true });
  // Cached palettes must hold the Countries auto-rotation submission budget.
  await page.locator('#rotate-toggle').click();
  const serifRotation = await page.evaluate(async () => {
    const samples = [], start = performance.now();
    let frame = -1, previous = 0;
    while (performance.now() - start < 2000) {
      const time = await new Promise(resolve => requestAnimationFrame(resolve));
      const state = EARTHXT_DEBUG.snapshot();
      if (frame === state.frameNumber) continue;
      if (previous) samples.push({ intervalMs: time - previous, cpuMs: state.projectionMs + state.renderMs,
        labelMs: state.labelMs, serifActive: state.serifActive, lod: state.lod, labels: state.labels });
      frame = state.frameNumber; previous = time;
    }
    return samples;
  });
  assert.ok(serifRotation.length > 1);
  const serifP95 = key => serifRotation.map(sample => sample[key]).sort((a, b) => a - b)[Math.floor((serifRotation.length - 1) * 0.95)];
  const serifTiming = { cpuMs: serifP95('cpuMs'), intervalMs: serifP95('intervalMs'), labelMs: serifP95('labelMs'), mono: timing };
  await writeFile(new URL('../../test-results/earthxt/serif-timing.json', import.meta.url), JSON.stringify({ timing: serifTiming, samples: serifRotation }, null, 2) + '\n');
  console.log('Countries Serif auto-rotation timing:', JSON.stringify(serifTiming));
  assert.ok(serifRotation.every(sample => sample.serifActive && sample.lod === 2 && sample.labels));
  assert.ok(serifTiming.cpuMs < 33.4, 'Serif p95 CPU submission stays below 33.4 ms');
  assert.ok(serifTiming.intervalMs < 50, 'Serif p95 frame interval stays below 50 ms');
  assert.ok(serifTiming.cpuMs <= Math.max(8, timing.cpuMs.p95 * 1.35), 'Serif keeps the mono CPU budget within 35% (8 ms floor)');
  await page.locator('#rotate-toggle').click();
  await page.locator('#serif-toggle').uncheck();
  await page.waitForFunction(() => !EARTHXT_DEBUG.snapshot().serifActive);
  await page.locator('#labels-toggle').uncheck();
  await page.waitForFunction(() => EARTHXT_DEBUG.snapshot().visibleLabels === 0);
  const hiddenNames = await page.evaluate(() => EARTHXT_DEBUG.snapshot({ includeGeometry: true }));
  assert.equal(hiddenNames.silhouetteLabels, 0); assert.equal(hiddenNames.fallbackLabels, 0);
  assert.deepEqual(hiddenNames.labelPlacements, []);
  assert.equal(await page.locator('.country-label:visible').count(), 0);
  await page.locator('#labels-toggle').check();
  await page.locator('#grid-toggle').check(); assert.equal((await snapshot()).grid, true);
  await page.locator('#source-synthetic').click();
  assert.equal((await snapshot()).source, 'synthetic');
  await page.waitForFunction(() => EARTHXT_DEBUG.snapshot().visibleLabels === 0);
  await page.locator('#source-earth').click(); assert.equal((await snapshot()).source, 'earth');
  await page.locator('#zoom-slider').focus(); await page.keyboard.press('End'); await settled();
  assert.ok(Math.abs((await snapshot()).distance - 1.16) < 0.001);
  assert.ok(await page.locator('#zoom-in').isDisabled());
  await page.locator('#zoom-slider').focus(); await page.keyboard.press('Home'); await settled();
  assert.equal((await snapshot()).lod, 0);
  assert.ok(await page.locator('#zoom-out').isDisabled());
  await page.locator('#globe').focus(); await page.keyboard.press('0'); await settled();
  const keyBefore = await snapshot(); await page.keyboard.press('ArrowLeft');
  assert.ok((await snapshot()).longitude < keyBefore.longitude);
  await page.keyboard.press('+'); await settled(); assert.ok((await snapshot()).distance < keyBefore.distance);
  await page.keyboard.press('d'); assert.ok(await page.locator('#debug-panel').isVisible());
  await page.locator('#about-open').click(); assert.ok(await page.locator('#about-dialog').isVisible());
  await page.keyboard.press('Escape'); assert.ok(!(await page.locator('#about-dialog').isVisible()));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'about-open');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal((await snapshot()).autoRotate, false);
  assert.equal((await snapshot()).reducedMotion, true);
  // Startup with reduced motion must also remain still.
  await page.reload(); await page.waitForFunction(() => window.EARTHXT_DEBUG?.snapshot().visibleGlyphs > 0);
  assert.equal((await snapshot()).autoRotate, false);
  await assertSerifToggle(page);
  const reducedInk = await captureInk(page), reducedState = await snapshot();
  await page.waitForTimeout(1000);
  assert.equal((await captureInk(page)).rasterText, reducedInk.rasterText, 'reduced motion keeps every ocean glyph still');
  assert.equal((await snapshot()).longitude, reducedState.longitude);
  assert.equal((await snapshot()).autoRotate, false);
  // Place deep links set the camera and open a card before interaction.
  await page.goto(server.origin + '/dist/earthxt/#/place/salar-de-uyuni');
  await page.waitForFunction(() => window.EARTHXT_DEBUG?.snapshot().lod === 2 && !document.getElementById('globe-place-card').hidden);
  const linked = await snapshot();
  assert.equal(linked.placeCount, 40);
  assert.equal(linked.autoRotate, false);
  assert.ok(Math.abs(linked.latitude + 19.917) < 0.001 && Math.abs(linked.longitude + 67.846) < 0.001);
  assert.equal(await page.locator('#globe-place-card').getAttribute('data-id'), 'salar-de-uyuni');
  await page.locator('#globe').focus(); await page.keyboard.press('Escape');
  await page.locator('[data-level="1"]').click(); await settled();
  await page.waitForFunction(() => EARTHXT_DEBUG.snapshot().visibleMarkers >= 4 && EARTHXT_DEBUG.snapshot().labelledPlaces >= 4);
  const poi = await page.evaluate(() => EARTHXT_DEBUG.snapshot({ includeGeometry: true }));
  const occupied = new Set();
  for (const label of poi.labelCells) for (const span of label.cells) for (let col = span.c0; col <= span.c1; col++) {
    const cell = span.row * poi.grid.cols + col;
    assert.ok(span.row >= 0 && span.row < poi.grid.rows && col >= 0 && col < poi.grid.cols);
    assert.equal(poi.grid.countryIds[cell], 0);
    assert.equal(poi.grid.blockedCells[cell], 0, 'label stays on water within the disc');
    assert.ok(!poi.markerCells.includes(cell), 'label clears marker footprint');
    assert.ok(!occupied.has(cell), 'place labels do not overlap');
    occupied.add(cell);
  }
  const marker = page.locator('.globe-marker[data-id="salar-de-uyuni"]');
  await marker.hover();
  const card = page.locator('#globe-place-card');
  assert.ok(await card.isVisible());
  const tagline = await page.evaluate(() => ATLAS_DATA.places.find(place => place.id === 'salar-de-uyuni').tagline);
  assert.equal((await card.locator('.map-card-tag').innerText()).replace(/\s+/g, ' ').trim(), tagline);
  const cardBounds = await card.boundingBox(), stageBounds = await page.locator('#globe-stage').boundingBox();
  assert.ok(cardBounds.x >= stageBounds.x && cardBounds.y >= stageBounds.y && cardBounds.x + cardBounds.width <= stageBounds.x + stageBounds.width && cardBounds.y + cardBounds.height <= stageBounds.y + stageBounds.height);
  await page.mouse.move(0, 0);
  await page.locator('#globe').focus(); await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement.matches('.globe-marker:not([hidden])')), 'Tab reaches a visible marker');
  await page.keyboard.press('Escape');
  assert.ok(!(await card.isVisible()));
  // Real rotation timing with routed place names enabled, at a fixed viewport.
  await page.locator('#rotate-toggle').click();
  const placeTiming = await page.evaluate(async () => {
    const samples = [], start = performance.now();
    let previous = 0, frame = -1, visible = 0;
    while (performance.now() - start < 2000) {
      const time = await new Promise(resolve => requestAnimationFrame(resolve));
      const state = EARTHXT_DEBUG.snapshot();
      if (state.frameNumber === frame) continue;
      if (previous) samples.push({ intervalMs: time - previous, cpuMs: state.projectionMs + state.renderMs,
        placeLabelMs: state.placeLabelMs, placeRenderMs: state.placeRenderMs, placeLayoutPasses: state.placeLayoutPasses,
        labelledPlaces: state.labelledPlaces, visibleMarkers: state.visibleMarkers, visibleMarkersDropped: state.visibleMarkers < visible });
      frame = state.frameNumber; previous = time; visible = state.visibleMarkers;
    }
    return samples;
  });
  assert.ok(placeTiming.length > 1);
  const min = Math.min(...placeTiming.map(sample => sample.labelledPlaces));
  const max = Math.max(...placeTiming.map(sample => sample.labelledPlaces));
  const visible = placeTiming.map(sample => sample.visibleMarkers);
  const p95 = key => placeTiming.map(sample => sample[key]).sort((a, b) => a - b)[Math.floor((placeTiming.length - 1) * 0.95)];
  const placeBudget = { cpuMs: p95('cpuMs'), intervalMs: p95('intervalMs'), placeLabelMs: p95('placeLabelMs'), placeRenderMs: p95('placeRenderMs') };
  await writeFile(new URL('../../test-results/earthxt/places-timing.json', import.meta.url), JSON.stringify({ min, max, visible, p95: placeBudget, samples: placeTiming }, null, 2) + '\n');
  console.log('Coastlines places timing:', JSON.stringify(placeBudget));
  assert.ok(placeTiming.every(sample => sample.labelledPlaces >= max - 1 || sample.visibleMarkersDropped),
    `labelled places stay within one of the sample maximum unless markers leave that frame (min ${min}, max ${max})`);
  assert.ok(placeBudget.placeLabelMs < 2, 'p95 place placement stays within the 2 ms budget');
  assert.ok(placeBudget.cpuMs < 33.4, 'p95 CPU submission stays within the 33.4 ms smoke budget');
  assert.ok(placeBudget.intervalMs < 50, 'p95 frame interval stays below 50 ms');
  await page.locator('#rotate-toggle').click();
  // Dist intentionally ships only the globe; intercept the atlas destination
  // to assert its URL. smoke-nav exercises the combined site's real dialog.
  const atlasDestination = server.origin + '/dist/#/place/salar-de-uyuni';
  await page.route(server.origin + '/dist/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Atlas destination</title>' }));
  await Promise.all([page.waitForURL(atlasDestination), marker.click()]);
  assert.equal(page.url(), atlasDestination);
  // Real touch events via Chromium's input protocol, including pinch and cancel.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const touchPage = await mobile.newPage();
  touchPage.on('pageerror', error => errors.push(error.message));
  await touchPage.goto(server.origin + '/dist/earthxt/');
  await touchPage.waitForFunction(() => window.EARTHXT_DEBUG?.snapshot().visibleGlyphs > 0);
  assert.ok(await touchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await touchPage.screenshot({ path: new URL('../../test-results/earthxt/mobile.png', import.meta.url).pathname, fullPage: true });
  const cdp = await mobile.newCDPSession(touchPage);
  const b = await touchPage.locator('#globe').boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const touchBefore = await touchPage.evaluate(() => EARTHXT_DEBUG.snapshot());
  await touch('touchStart', [{ x, y, id: 1 }]);
  await touch('touchMove', [{ x: x + 40, y: y + 10, id: 1 }]);
  await touch('touchEnd', []);
  assert.notEqual((await touchPage.evaluate(() => EARTHXT_DEBUG.snapshot())).longitude, touchBefore.longitude);
  await touch('touchStart', [{ x: x - 30, y, id: 1 }, { x: x + 30, y, id: 2 }]);
  await touch('touchMove', [{ x: x - 65, y, id: 1 }, { x: x + 65, y, id: 2 }]);
  await touch('touchCancel', []);
  const pinched = await touchPage.evaluate(() => EARTHXT_DEBUG.snapshot());
  assert.ok(pinched.targetDistance < touchBefore.targetDistance);
  assert.equal(pinched.activePointers, 0);
  // Loading failure is recoverable and never strands the user on a blank globe.
  const fallback = await context.newPage();
  await fallback.route('**/data/world.bin', route => route.fulfill({ status: 503, body: '' }));
  await fallback.goto(server.origin + '/dist/earthxt/');
  await fallback.waitForFunction(() => window.EARTHXT_DEBUG?.snapshot().visibleGlyphs > 0);
  assert.equal(await fallback.evaluate(() => EARTHXT_DEBUG.snapshot().source), 'synthetic');
  assert.ok(await fallback.locator('#data-error').isVisible());
  assert.ok(await fallback.locator('#source-earth').isDisabled());
  // Opening the standalone file must work with all HTTP access blocked.
  const offline = await context.newPage();
  offline.on('pageerror', error => errors.push(error.message));
  offline.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await offline.route(/^https?:/, route => {
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await offline.goto(standalone.output.href + '#/place/salar-de-uyuni');
  await offline.waitForFunction(() => window.EARTHXT_DEBUG?.snapshot().visibleGlyphs > 500);
  assert.equal(await offline.evaluate(() => EARTHXT_DEBUG.snapshot().countryCount), 177);
  assert.equal(await offline.evaluate(() => EARTHXT_DEBUG.snapshot().source), 'earth');
  await offline.locator('[data-level="2"]').click();
  await offline.waitForFunction(() => EARTHXT_DEBUG.snapshot().lod === 2);
  assert.equal(await offline.evaluate(() => EARTHXT_DEBUG.snapshot().placeCount), 40);
  const offlineCard = offline.locator('#globe-place-card');
  assert.ok(await offlineCard.isVisible());
  await assertSerifToggle(offline);
  assert.equal(await offlineCard.locator('a').count(), 0);
  const excerpt = await offlineCard.locator('.map-card-cta').innerText();
  assert.ok(excerpt.length > 40);
  assert.ok(await offline.evaluate(text => ATLAS_DATA.places.find(place => place.id === 'salar-de-uyuni').story.startsWith(text), excerpt));
  await offline.locator('.globe-marker[data-id="salar-de-uyuni"]').focus();
  await offline.keyboard.press('Enter');
  assert.equal(offline.url(), standalone.output.href + '#/place/salar-de-uyuni');
  assert.ok(await offlineCard.isVisible());
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log('PASS: deployed subpath, all LODs, drag, wheel, zoom limits, silhouette name containment, rotation timing, Serif glyphs/placement/performance, labels toggle, source modes, keyboard, dialogs, reduced motion, mobile layout, touch rotation/pinch/cancel, load-error fallback, and standalone file without HTTP access.');
  console.log('Browser captures: test-results/earthxt/');
} catch (error) {
  console.error(`Earthxt browser smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.stop();
}
