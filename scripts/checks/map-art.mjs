/* Browser acceptance checks for phases 7–8; runs both layout hosts. */
import assert from 'node:assert/strict';
export async function runMapArtChecks(browser, origin) {
  for (const query of ['', '?noflags=worker']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(origin + '/' + query);
      await page.waitForFunction(() => window.ATLAS_MAP_ART && document.querySelector('.map-marker'));
      if (!query) await page.waitForFunction(() => window.ATLAS_MAP_DEBUG.workerActive());
      await page.waitForTimeout(600);
      await page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());
      const places = await page.evaluate(() => window.ATLAS_DATA.places.map(p => ({ id: p.id, story: p.story })));
      let shaped = 0, regional = 0;
      for (const p of places) {
        await page.evaluate(id => window.ATLAS_MAP_ART.country(id), p.id);
        const snapshot = await page.waitForFunction(id => { const d = window.ATLAS_MAP_ART.debug(); return d.result?.id === id ? d : false; }, p.id);
        const out = await snapshot.jsonValue();
        
        assert(out.result.complete, p.id + ' story incomplete');
        assert.equal(out.result.lines.map(l => l.text).join('').replace(/\s/g, ''), p.story.replace(/\s/g, ''), p.id + ' story lost words');
        if (out.result.mode === 'country') shaped++; else regional++;
        const g = out.geometry;
        for (const l of out.result.lines) {
          assert(l.x >= 0 && l.y >= 0 && l.x + l.width <= g.cols * g.charW + 0.1 && l.y + l.height <= g.rows * g.lineH + 0.1, p.id + ' off map');
          if (out.result.mode === 'country') {
            const cells = [];
            for (let r = Math.floor(l.y / g.lineH); r <= Math.floor((l.y + l.height - 1.01) / g.lineH); r++) for (let c = Math.floor(l.x / g.charW); c <= Math.floor((l.x + l.width - 0.01) / g.charW); c++) cells.push(out.countries[r * g.cols + c]);
            assert(cells.every(c => c > 0), p.id + ' shape crosses water');
          }
        }
      }
      // Click real dialog controls, including a dateline-crossing journey.
      await page.evaluate(() => { window.ATLAS_MAP_ART.clear(); location.hash = '#/place/shibuya-crossing'; });
      await page.waitForSelector('#place-dialog[open]');
      await page.selectOption('#dialog-route-to', 'hoh-rainforest');
      await page.click('#dialog-map-route');
      await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().result?.mode === 'route');
      assert.equal(await page.locator('#place-dialog').evaluate(el => el.open), false);
      let route = await (await page.waitForFunction(() => { const d = window.ATLAS_MAP_ART.debug(); return d.result?.mode === 'route' ? d : false; })).jsonValue();
      assert(route.result.segments.length > 0);
      assert(route.result.segments.every(s => Math.abs(s.a.x - s.b.x) < route.geometry.cols * route.geometry.charW / 2));
      // A longer journey must actually typeset some words, and avoid labels.
      await page.evaluate(() => window.ATLAS_MAP_ART.route({ lat: -35, lon: -130 }, 'shibuya-crossing'));
      await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().result?.id === 'shibuya-crossing');
      route = await page.evaluate(() => ({ ...window.ATLAS_MAP_ART.debug(), labels: window.ATLAS_MAP_DEBUG.labels() }));
      assert(route.result.lines.length > 0, 'route produced no text');
      for (const l of route.result.lines) for (const label of route.labels) for (const cell of label.cells) {
        const g = route.geometry, b = l.bounds;
        assert(b.x1 < cell.c0 * g.charW || b.x0 >= (cell.c1 + 1) * g.charW || b.y1 < cell.row * g.lineH || b.y0 >= (cell.row + 1) * g.lineH, 'route crosses label');
      }
      const before = await page.locator('.map-marker').evaluateAll(els => els.map(el => ({ left: el.style.left, top: el.style.top })));
      await page.click('#map-serif');
      await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().palette);
      assert.equal(await page.getAttribute('#map-serif', 'aria-pressed'), 'true');
      const after = await page.locator('.map-marker').evaluateAll(els => els.map(el => ({ left: el.style.left, top: el.style.top })));
      assert.deepEqual(after, before, 'serif toggle moved markers');
      assert.deepEqual(await page.evaluate(() => window.ATLAS_MAP_ART.debug().countries), route.countries);
      await page.click('#map-serif');
      await page.click('#map-art-clear');
      assert.equal(await page.evaluate(() => window.ATLAS_MAP_ART.debug().result), null);
      // Rebuild while the worker has pending requests, then keep using controls.
      await page.setViewportSize({ width: 1050, height: 760 });
      await page.waitForTimeout(300);
      await page.evaluate(() => window.ATLAS_MAP_ART.country('petra'));
      await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().result?.id === 'petra');
      assert.deepEqual(errors, []);
      console.log(`map art ${query || 'worker'}: ${shaped} silhouettes + ${regional} insets, complete stories for all 40; route controls, dateline, text, marker stability and resize OK`);
    } finally { await context.close(); }
  }
}
