import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

export async function runMapArtExtraChecks(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('frame-ancestors')) errors.push(m.text()); });
  const frames = () => new Promise(resolve => {
    const samples = []; let last;
    const tick = t => {
      if (last) samples.push(t - last);
      last = t;
      if (samples.length < 120) requestAnimationFrame(tick);
      else resolve({ avg: samples.reduce((a, b) => a + b, 0) / samples.length, p95: samples.sort((a, b) => a - b)[114], layouts: window.ATLAS_MAP_DEBUG.mainThreadLayoutCalls() });
    }; requestAnimationFrame(tick);
  });
  try {
    await page.goto(origin);
    await page.waitForFunction(() => window.ATLAS_MAP_DEBUG?.workerActive());
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.ATLAS_MAP_ART.clear(); window.ATLAS_MAP_DEBUG.resetCounters(); });
    const baseline = await page.evaluate(frames);
    await page.click('#map-serif');
    await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().palette);
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.startIdle());
    await page.waitForFunction(() => window.ATLAS_MAP_DEBUG.idleSentences().length > 0);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.resetCounters());
    const serif = await page.evaluate(frames);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    assert.equal(serif.layouts, 0, 'serif fluid performed main-thread layout');
    assert(serif.avg < baseline.avg * 2, `serif frame time ${serif.avg.toFixed(2)}ms exceeds 2x baseline ${baseline.avg.toFixed(2)}ms`);
    console.log(`serif fluid at 4x CPU: avg ${serif.avg.toFixed(2)}ms, p95 ${serif.p95.toFixed(2)}ms; baseline ${baseline.avg.toFixed(2)}ms; main-thread layouts ${serif.layouts}`);
    await mkdir('docs/screenshots', { recursive: true });
    await page.screenshot({ path: 'docs/screenshots/phase8-serif.png' });
    await page.evaluate(() => { window.ATLAS_MAP_DEBUG.stopIdle(); window.ATLAS_MAP_ART.country('salar-de-uyuni'); });
    await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().result?.id === 'salar-de-uyuni');
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'docs/screenshots/phase7-story.png' });
    await page.evaluate(() => window.ATLAS_MAP_ART.route({ lat: -35, lon: -130 }, 'shibuya-crossing'));
    await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().result?.mode === 'route');
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.setZoom(2.5));
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());
    const out = await (await page.waitForFunction(() => { const d = window.ATLAS_MAP_ART.debug(); return d.result?.mode === 'route' ? d : false; })).jsonValue();
    const rects = await page.locator('.map-label-line, .map-ocean-label.is-placed').evaluateAll(els => {
      const z = window.ATLAS_MAP_DEBUG.getZoom(), origin = document.querySelector('.map-zoom').getBoundingClientRect();
      return els.map(el => el.getBoundingClientRect()).filter(r => r.width && r.height).map(r => ({ x0: (r.left - origin.left) / z, x1: (r.right - origin.left) / z, y0: (r.top - origin.top) / z, y1: (r.bottom - origin.top) / z }));
    });
    for (const l of out.result.lines) for (const b of rects) {
      const a = l.bounds;
      assert(a.x1 <= b.x0 + .2 || a.x0 >= b.x1 - .2 || a.y1 <= b.y0 + .2 || a.y0 >= b.y1 - .2, 'route overlaps a painted place/ocean label');
    }
    // Nearly identical and antipodal endpoints must remain finite.
    for (const from of [{ lat: 35.66, lon: 139.7 }, { lat: -35.66, lon: -40.3 }]) {
      await page.evaluate(from => window.ATLAS_MAP_ART.route(from, 'shibuya-crossing'), from);
      const d = await (await page.waitForFunction(() => { const d = window.ATLAS_MAP_ART.debug(); return d.result?.mode === 'route' ? d : false; })).jsonValue();
      assert(d.result.segments.every(s => [s.a.x, s.a.y, s.b.x, s.b.y].every(Number.isFinite)));
    }
    // Geolocation exercises the actual application event and nearest-place lookup.
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 48, longitude: -123 });
    await page.click('#map-locate');
    await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().request?.from?.lat === 48 && window.ATLAS_MAP_ART.debug().request?.from?.lon === -123);
    assert.equal(await page.evaluate(() => window.ATLAS_MAP_ART.debug().request.id), 'hoh-rainforest');
    // Confirm the new worker modules are in the active offline cache.
    await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })); });
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.ATLAS_MAP_DEBUG?.workerActive());
    await page.click('#map-serif');
    await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().palette);
    assert.deepEqual(errors, []);
    console.log('map art: painted labels at 2.5x, degenerate routes, geolocation and offline worker/serif reload OK');
  } finally { await context.close(); }

  for (const options of [{ viewport: { width: 390, height: 844 } }, { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }]) {
    const c = await browser.newContext(options), p = await c.newPage();
    try {
      await p.goto(origin);
      await p.waitForFunction(() => window.ATLAS_MAP_DEBUG?.workerActive());
      await p.waitForTimeout(400);
      await p.evaluate(() => window.ATLAS_MAP_ART.country('petra'));
      const out = await (await p.waitForFunction(() => { const d = window.ATLAS_MAP_ART.debug(); return d.result?.id === 'petra' ? d : false; })).jsonValue();
      assert(out.result.complete);
      await p.click('#map-serif');
      await p.waitForFunction(() => window.ATLAS_MAP_ART.debug().palette);
      assert.equal(await p.getAttribute('#map-serif', 'aria-pressed'), 'true');
      assert.equal(await p.evaluate(() => window.ATLAS_MAP_DEBUG.startIdle()), false);
      assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
      if (options.viewport.width === 390) await p.waitForTimeout(200);
      if (options.viewport.width === 390) await p.screenshot({ path: 'docs/screenshots/phase7-phone.png' });
      console.log(`map art ${options.reducedMotion || 'phone'}: complete story, serif toggle, no idle, no horizontal overflow OK`);
    } finally { await c.close(); }
  }
  for (const query of ['?noflags=countryStories,routeText,serifAtlas', '?noflags=editorial']) {
    const c = await browser.newContext(), p = await c.newPage();
    try {
      await p.goto(origin + '/' + query);
      await p.waitForFunction(() => window.ATLAS_MAP_ART && window.ATLAS_TEXT_READY);
      await p.waitForSelector('.map-marker');
      assert.equal(await p.locator('#dialog-map-actions').evaluate(el => el.hidden), true);
      if (query.includes('serifAtlas')) {
        assert.equal(await p.locator('#map-serif').isVisible(), false);
        const result = await p.evaluate(() => {
          window.ATLAS_MAP_ART.country('petra');
          window.ATLAS_MAP_ART.route({ lat: 0, lon: 0 }, 'petra');
          return { serif: window.ATLAS_MAP_ART.setSerif(true), art: window.ATLAS_MAP_ART.debug().request };
        });
        assert.deepEqual(result, { serif: false, art: null });
      }
    } finally { await c.close(); }
  }
  console.log('map art: feature flags and editorial fallback hide unavailable controls OK');

}
