import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

export async function runMapArtExtraChecks(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('frame-ancestors')) errors.push(m.text()); });
  const frames = () => new Promise(resolve => {
    const samples = [], sentences = [], idleOn = []; let last;
    const tick = t => {
      if (last) {
        samples.push(t - last);
        const state = window.ATLAS_MAP_DEBUG.idleState();
        sentences.push(state.sentences); idleOn.push(state.on);
      }
      last = t;
      if (samples.length < 120) requestAnimationFrame(tick);
      else resolve({ avg: samples.reduce((a, b) => a + b, 0) / samples.length, p95: samples.sort((a, b) => a - b)[113], sentences, idleOn, layouts: window.ATLAS_MAP_DEBUG.mainThreadLayoutCalls() });
    }; requestAnimationFrame(tick);
  });
  try {
    await page.goto(origin);
    await page.waitForFunction(() => window.ATLAS_MAP_DEBUG?.workerActive());
    await page.waitForTimeout(600);
    await page.evaluate(() => { window.ATLAS_MAP_ART.clear(); window.ATLAS_MAP_DEBUG.resetCounters(); });
    const baseline = await page.evaluate(frames);
    // Prepare both modes before sampling so palette construction is outside
    // the frame timings and cannot age the sentences between the two samples.
    await page.evaluate(() => window.ATLAS_MAP_ART.setSerif(true));
    await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().base?.serif);
    await page.evaluate(() => window.ATLAS_MAP_ART.setSerif(false));
    // The roadmap asks whether the typographic fluid holds frame rate under the
    // same throttle as idle mode, so the comparison is like for like: the same
    // sea, the same drifting sentences, the same 4x CPU, monospace then serif.
    assert(await page.evaluate(() => window.ATLAS_MAP_DEBUG.startIdle()), 'idle mode did not start');
    // A full sea, and a full sea again before the second sample: a sentence
    // reaches the far coast about twenty seconds after it spawns, and the six
    // that start together come to the end of their corridors together, so
    // whichever sample happens to run at that moment would otherwise be timing
    // a thinner sea than the other one.
    const seaIsFull = () => page.waitForFunction(() => {
      const d = window.ATLAS_MAP_DEBUG.idleState();
      return d.on && d.alpha === 1 && d.sentences === d.maxSentences;
    });
    await seaIsFull();
    const sentenceCount = await page.evaluate(() => window.ATLAS_MAP_DEBUG.idleSentences().length);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.resetCounters());
    const idle = await page.evaluate(frames);
    await page.evaluate(() => window.ATLAS_MAP_ART.setSerif(true));
    // The serif ink has to be on the canvas before the frames are timed, not
    // merely requested: wait for the repaint the palette's arrival triggers.
    await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().base?.serif);
    await seaIsFull();
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.resetCounters());
    const serif = await page.evaluate(frames);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const counts = sample => `${Math.min(...sample.sentences)}..${Math.max(...sample.sentences)}`;
    console.log(`serif fluid at 4x CPU: avg ${serif.avg.toFixed(2)}ms, p95 ${serif.p95.toFixed(2)}ms, sentences ${counts(serif)}; idle at 4x CPU: avg ${idle.avg.toFixed(2)}ms, p95 ${idle.p95.toFixed(2)}ms, sentences ${counts(idle)}; unthrottled vsync: avg ${baseline.avg.toFixed(2)}ms, p95 ${baseline.p95.toFixed(2)}ms; main-thread layouts ${serif.layouts}`);
    assert(sentenceCount > 0, 'no sentences adrift');
    for (const [name, sample] of [['idle', idle], ['serif', serif]]) {
      assert(sample.idleOn.every(Boolean), `${name} sample ended idle mode`);
      // Both samples start on a full sea. One sentence finishing its drift
      // inside the three seconds a sample takes is the sea working, not the
      // workload changing; two would mean the two timings are no longer
      // comparable, which is the whole point of the assertion.
      assert(sample.sentences.every(n => n >= sentenceCount - 1), `${name} workload changed: ${counts(sample)} sentences, expected ${sentenceCount}`);
    }
    assert.equal(serif.layouts, 0, 'serif fluid performed main-thread layout');
    assert.equal(idle.layouts, 0, 'idle mode performed main-thread layout');
    // Both the relative idle comparison and the absolute 2x vsync ceiling
    // must pass, for the average and the tail of the frame distribution.
    // Under a 4x throttle every frame lands on a whole vsync quantum, so the
    // tail sits exactly on the two-frame line (33.4ms) when it holds 30fps;
    // the ceiling allows 1ms of rAF timestamp jitter so that line is inclusive.
    const ceiling = baseline.avg * 2 + 1;
    for (const metric of ['avg', 'p95']) {
      assert(serif[metric] <= idle[metric] * 1.25, `serif ${metric} ${serif[metric].toFixed(2)}ms exceeds 1.25x idle ${idle[metric].toFixed(2)}ms`);
      assert(serif[metric] <= ceiling, `serif ${metric} ${serif[metric].toFixed(2)}ms exceeds 2x vsync ${ceiling.toFixed(2)}ms`);
    }
    await mkdir('docs/screenshots', { recursive: true });
    await page.screenshot({ path: 'docs/screenshots/phase8-serif.png' });
    // The same serif atlas close up, where the glyphs are legible as type.
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.setZoom(2.5));
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'docs/screenshots/phase8-serif-zoom.png' });
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.setZoom(1));
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.stopIdle());
    for (const shot of [['salar-de-uyuni', 'phase7-story'], ['wadi-rum', 'phase7-wadi-rum']]) {
      await page.evaluate(id => window.ATLAS_MAP_ART.country(id), shot[0]);
      const shaped = await (await page.waitForFunction(id => { const d = window.ATLAS_MAP_ART.debug(); return d.result?.id === id ? d.result : false; }, shot[0])).jsonValue();
      assert.equal(shaped.mode, 'country', shot[0] + ' did not fill its country');
      await page.waitForTimeout(400);
      await page.screenshot({ path: 'docs/screenshots/' + shot[1] + '.png' });
    }
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
    // Serif mode was on before the reload, so it is on after it — and the
    // palette is rebuilt from the cached worker modules with no network at all.
    await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().base?.serif);
    assert.equal(await page.getAttribute('#map-serif', 'aria-pressed'), 'true', 'serif mode did not persist across a reload');
    await page.click('#map-serif');
    assert.equal(await page.getAttribute('#map-serif', 'aria-pressed'), 'false');
    await page.reload();
    await page.waitForFunction(() => window.ATLAS_MAP_DEBUG?.workerActive());
    assert.equal(await page.getAttribute('#map-serif', 'aria-pressed'), 'false', 'serif mode came back after being turned off');
    await page.click('#map-serif');
    await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().base?.serif);
    assert.deepEqual(errors, []);
    console.log('map art: painted labels at 2.5x, degenerate routes, geolocation, offline worker/serif reload and a remembered toggle OK');
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
      console.log(`map art ${options.reducedMotion || 'phone'}: complete story as a ${out.result.mode}, serif toggle, no idle, no horizontal overflow OK`);
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
