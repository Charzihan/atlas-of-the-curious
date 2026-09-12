/** Real browser navigation checks against the combined source site.
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
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const globeReady = () => page.waitForFunction(() => window.EARTHXT_DEBUG?.snapshot().visibleGlyphs > 500);
    const palette = () => page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--bg', '--ink', '--gold'].map(name => style.getPropertyValue(name).trim());
    });

    await page.goto(`${server.origin}/earthxt/`);
    await globeReady();
    assert.equal(await page.title(), 'Globe · Atlas of the Curious');
    const globePalette = await palette();
    const brand = page.locator('.site-header a.brand');
    assert.ok(await brand.isVisible());
    assert.equal(await brand.evaluate(link => link.href), `${server.origin}/`);
    assert.equal(await page.locator('.site-header .view-label').innerText(), 'Globe');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    // Activate the real link by keyboard so focus access is exercised too.
    await brand.focus();
    await Promise.all([page.waitForURL(`${server.origin}/`), page.keyboard.press('Enter')]);
    await page.waitForFunction(() => window.ATLAS_TEXT_READY === true && window.ATLAS_MAP_DEBUG && document.querySelector('.map-marker'));
    assert.equal(await page.title(), 'Atlas of the Curious — 40 extraordinary places on Earth');
    assert.deepEqual(await palette(), globePalette);
    const globeLink = page.locator('.site-header a.surprise-btn');
    assert.equal(await globeLink.innerText(), '⊕ Globe');
    assert.equal(await globeLink.evaluate(link => link.href), `${server.origin}/earthxt/`);
    await Promise.all([page.waitForURL(`${server.origin}/earthxt/`), globeLink.click()]);
    await globeReady();
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: desktop/mobile atlas ↔ globe header navigation, keyboard brand link, shared palette, rendered views, and no console/page errors.');
} catch (error) {
  console.error(`Globe navigation smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await server.stop();
}
