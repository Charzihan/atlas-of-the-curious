/** Real browser checks of the atlas's two views (flat map and globe) on one page.
 * Run pnpm build first, then node scripts/earthxt/smoke-nav.mjs.
 * The globe-only dist build does not include the atlas entry.
 * Browser/server unavailability is a failure, never a skipped pass.
 */
import assert from 'node:assert/strict';
import { startServer, launchChromium } from '../browser-harness.mjs';

let server, browser;
try {
  server = await startServer();
  const launch = await launchChromium();
  if (!launch.browser) throw new Error(launch.reason);
  browser = launch.browser;
  const errors = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    // Chromium reports the atlas page's meta-delivered `frame-ancestors` as an
    // error; it is a known no-op of CSP-in-meta, not a page failure.
    const KNOWN = /'frame-ancestors' is ignored when delivered via a <meta> element/;
    page.on('console', message => { if (message.type() === 'error' && !KNOWN.test(message.text())) errors.push(message.text()); });
    const globeReady = () => page.waitForFunction(() => window.EARTHXT_DEBUG?.snapshot().visibleGlyphs > 500);
    const palette = () => page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--bg', '--ink', '--gold'].map(name => style.getPropertyValue(name).trim());
    });

    const view = () => page.evaluate(() => document.getElementById('text-atlas').dataset.view);
    const roomy = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

    // One page: the atlas opens flat, and its hero switch turns the same
    // viewport into the globe without leaving the document.
    await page.goto(`${server.origin}/`);
    await page.waitForFunction(() => window.ATLAS_TEXT_READY === true && window.ATLAS_MAP_DEBUG && document.querySelector('.map-marker'));
    assert.equal(await page.title(), 'Atlas of the Curious — 40 extraordinary places on Earth');
    assert.equal(await view(), 'flat');
    assert.ok(await page.locator('#globe-view').isHidden());
    assert.equal(await page.locator('.site-header a[href*="earthxt"]').count(), 0);
    const flatPalette = await palette();
    const globeButton = page.locator('[data-view-target="globe"]');
    await globeButton.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(`${server.origin}/#/globe`);
    await globeReady();
    assert.equal(await view(), 'globe');
    assert.equal(await globeButton.getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('.globe-controls').isVisible());
    assert.ok(await page.locator('.map-controls[data-for="flat"]').isHidden());
    assert.deepEqual(await palette(), flatPalette);
    assert.ok(await roomy());
    // Back returns to the flat map; the globe stops drawing while hidden.
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('text-atlas').dataset.view === 'flat');
    const frames = await page.evaluate(() => EARTHXT_DEBUG.snapshot().frameNumber);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => EARTHXT_DEBUG.snapshot().frameNumber), frames, 'a hidden globe draws nothing');

    // The field note's globe link turns the hero into the globe at that place.
    await page.goto(`${server.origin}/#/place/salar-de-uyuni`);
    await page.waitForFunction(() => document.getElementById('place-dialog').open && document.getElementById('dialog-globe'));
    const placeLink = page.locator('#dialog-globe');
    assert.equal(await placeLink.innerText(), 'See on the globe →');
    await Promise.all([page.waitForURL(`${server.origin}/#/globe/place/salar-de-uyuni`), placeLink.click()]);
    await globeReady();
    await page.waitForFunction(() => EARTHXT_DEBUG.snapshot().lod === 2 && !document.getElementById('globe-place-card').hidden);
    assert.equal(await page.evaluate(() => document.getElementById('place-dialog').open), false);
    const state = await page.evaluate(() => EARTHXT_DEBUG.snapshot());
    assert.ok(Math.abs(state.latitude + 19.917) < 0.001 && Math.abs(state.longitude + 67.846) < 0.001);
    // A globe marker opens the same field note, over the globe.
    const marker = page.locator('.globe-marker[data-id="salar-de-uyuni"]');
    await marker.focus();
    await Promise.all([page.waitForURL(`${server.origin}/#/place/salar-de-uyuni`), page.keyboard.press('Enter')]);
    await page.waitForFunction(() => document.getElementById('place-dialog').open);
    assert.equal(await view(), 'globe');
    // A closed note keeps its hash; the same marker opens it again.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('place-dialog').open);
    await marker.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('place-dialog').open);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('place-dialog').open);
    // A plain wheel turn over an unfocused globe scrolls the page and hints.
    if (viewport.width > 640) {
      await page.locator('#search-input').focus();
      const before = await page.evaluate(() => EARTHXT_DEBUG.snapshot().targetDistance);
      const box = await page.locator('#globe').boundingBox();
      await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.5);
      await page.mouse.wheel(0, -200);
      await page.waitForFunction(() => !document.getElementById('gesture-hint').hidden);
      assert.equal(await page.evaluate(() => EARTHXT_DEBUG.snapshot().targetDistance), before, 'unfocused wheel must not zoom');
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -200);
      await page.keyboard.up('Control');
      assert.ok(await page.evaluate(() => EARTHXT_DEBUG.snapshot().targetDistance) < before, 'Ctrl + wheel zooms');
    }
    // Pause motion stops the globe and is remembered.
    await page.locator('#motion-toggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'paused');
    assert.equal(await page.evaluate(() => EARTHXT_DEBUG.snapshot().autoRotate), false);
    await page.locator('#motion-toggle').click();

    // Old globe links land in the unified page with their place.
    await page.goto(`${server.origin}/earthxt/#/place/fez-medina`);
    await page.waitForURL(`${server.origin}/#/globe/place/fez-medina`);
    await globeReady();
    await page.waitForFunction(() => !document.getElementById('globe-place-card').hidden);
    const native = page.locator('#globe-place-card .map-card-native');
    assert.ok(await native.isVisible());
    assert.equal(await native.getAttribute('dir'), 'rtl');
    assert.equal(await native.innerText(), await page.evaluate(() => ATLAS_DATA.places.find(place => place.id === 'fez-medina').nativeName));
    // The atlas filter dims the globe's dots too.
    await page.fill('#search-input', 'salt');
    await page.waitForFunction(() => document.querySelector('.globe-marker[data-id="fez-medina"]').classList.contains('is-dimmed'));
    assert.ok(await roomy());
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: desktop/mobile flat ↔ globe switch on one page, Back, paused hidden globe, dialog and marker links, old-URL redirect, shared filter and palette, reopen, cooperative wheel, pause motion, no console/page errors.');
} catch (error) {
  console.error(`Globe navigation smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.stop();
}
