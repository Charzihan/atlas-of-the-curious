/** Real browser checks. Fails explicitly if the server or browser is unavailable.
 * Run npm run build:earthxt first, then npm run smoke:earthxt.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { startServer, launchChromium } from '../browser-harness.mjs';

let server, browser;
try {
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
  assert.ok((await snapshot()).visibleLabels >= 2);
  await page.screenshot({ path: new URL('../../test-results/earthxt/countries.png', import.meta.url).pathname, fullPage: true });
  await page.locator('#labels-toggle').uncheck();
  await page.waitForFunction(() => EARTHXT_DEBUG.snapshot().visibleLabels === 0);
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
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log('PASS: deployed subpath, all LODs, drag, wheel, zoom limits, labels, source modes, keyboard, dialogs, reduced motion, mobile layout, touch rotation/pinch/cancel, and load-error fallback.');
  console.log('Browser captures: test-results/earthxt/');
} catch (error) {
  console.error(`Earthxt browser smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.stop();
}
