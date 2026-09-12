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
  await offline.goto(standalone.output.href);
  await offline.waitForFunction(() => window.EARTHXT_DEBUG?.snapshot().visibleGlyphs > 500);
  assert.equal(await offline.evaluate(() => EARTHXT_DEBUG.snapshot().countryCount), 177);
  assert.equal(await offline.evaluate(() => EARTHXT_DEBUG.snapshot().source), 'earth');
  await offline.locator('[data-level="2"]').click();
  await offline.waitForFunction(() => EARTHXT_DEBUG.snapshot().lod === 2);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log('PASS: deployed subpath, all LODs, drag, wheel, zoom limits, silhouette name containment, rotation timing sample, labels toggle, source modes, keyboard, dialogs, reduced motion, mobile layout, touch rotation/pinch/cancel, load-error fallback, and standalone file without HTTP access.');
  console.log('Browser captures: test-results/earthxt/');
} catch (error) {
  console.error(`Earthxt browser smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.stop();
}
