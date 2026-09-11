/* Browser acceptance checks for phases 7–8; runs both layout hosts. */
import assert from 'node:assert/strict';

// At 1280x800 every country but Chile — three places, a 4300 km ribbon 180 km
// wide — holds its story inside its own outline.
const MIN_SILHOUETTES = 34;

// Even-odd containment against the returned view-space rings, the same rule
// the layout used to cut each row into runs.
function inside(rings, x, y) {
  let odd = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}

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
      const fellBack = [];
      for (const p of places) {
        await page.evaluate(id => window.ATLAS_MAP_ART.country(id), p.id);
        const snapshot = await page.waitForFunction(id => { const d = window.ATLAS_MAP_ART.debug(); return d.result?.id === id ? d : false; }, p.id);
        const out = await snapshot.jsonValue();
        
        assert(out.result.complete, p.id + ' story incomplete');
        assert.equal(out.result.lines.map(l => l.text).join('').replace(/\s/g, ''), p.story.replace(/\s/g, ''), p.id + ' story lost words');
        if (out.result.mode === 'country') shaped++; else { regional++; fellBack.push(p.id + ':' + out.result.mode); }
        const g = out.geometry;
        if (out.result.mode === 'country') {
          // The silhouette is its own drawing: readable type, inside the map,
          // and a marker for the place at its true position in the shape.
          assert(out.result.size >= 10, p.id + ' type below 10px: ' + out.result.size);
          assert(out.result.shape.rings.length > 0, p.id + ' silhouette without rings');
          // The marker lands where the place really is within the silhouette.
          // A bay, a strait or an offshore island sits just outside the
          // simplified coastline, so the box — not the polygon — is the bound.
          const box = out.result.shape.box;
          const mk = out.result.marker;
          assert(mk.x >= box.x - 2 && mk.x <= box.x + box.width + 2 && mk.y >= box.y - 2 && mk.y <= box.y + box.height + 2, p.id + ' marker outside its silhouette');
        }
        for (const l of out.result.lines) {
          assert(l.x >= 0 && l.y >= 0 && l.x + l.width <= g.cols * g.charW + 0.1 && l.y + l.height <= g.rows * g.lineH + 0.1, p.id + ' off map');
          if (out.result.mode === 'country') {
            for (const x of [l.x + 0.2, l.x + l.width / 2, l.x + l.width - 0.2]) for (const y of [l.y + 1, l.y + l.height / 2, l.y + l.height - 1]) {
              assert(inside(out.result.shape.rings, x, y), p.id + ' line escapes the silhouette');
            }
          }
        }
      }
      assert(shaped >= MIN_SILHOUETTES, `only ${shaped} of ${places.length} stories fill a silhouette (want ${MIN_SILHOUETTES}); fell back: ${fellBack.join(', ')}`);
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
      const mono = await page.evaluate(() => window.ATLAS_MAP_ART.debug().base);
      assert.equal(mono.serif, false, 'the map started in serif mode');
      await page.click('#map-serif');
      await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().base?.serif);
      assert.equal(await page.getAttribute('#map-serif', 'aria-pressed'), 'true');
      const after = await page.locator('.map-marker').evaluateAll(els => els.map(el => ({ left: el.style.left, top: el.style.top })));
      assert.deepEqual(after, before, 'serif toggle moved markers');
      assert.deepEqual(await page.evaluate(() => window.ATLAS_MAP_ART.debug().countries), route.countries);
      // Phase 8: the mode has to actually change the ink, not just the flag.
      // Read what the base canvas painted rather than diffing pixels.
      const serif = await page.evaluate(() => window.ATLAS_MAP_ART.debug());
      assert.equal(serif.base.landCells, mono.landCells, 'serif mode changed the land mask');
      assert(/Georgia/.test(serif.base.font), 'base canvas font is not the serif family: ' + serif.base.font);
      assert(!/Georgia/.test(mono.font || ''), 'monospace base canvas claimed the serif family');
      const multiset = ink => Object.keys(ink.land).sort().map(g => g + ink.land[g]).join(' ');
      assert.notEqual(multiset(serif.base), multiset(mono), 'serif land glyphs are the monospace ones');
      const monoGlyphs = new Set(Object.keys(mono.land)), serifGlyphs = Object.keys(serif.base.land);
      assert(serifGlyphs.length >= 6, 'serif land uses only ' + serifGlyphs.length + ' glyphs');
      assert(serifGlyphs.some(g => !monoGlyphs.has(g)), 'serif land introduced no new glyph');
      assert(serifGlyphs.some(g => /[\p{L}\p{M}]/u.test(g)), 'serif land has no letters in it');
      // The ramp is measured coverage, and it has to be monotone along the ramp.
      const p = serif.palette;
      assert.equal(p.ramp.length, p.levels, 'ramp length disagrees with the level count');
      assert(p.levels >= 16, 'ramp has only ' + p.levels + ' levels');
      assert(p.measured, 'palette coverage was not measured from rendered ink');
      for (let i = 1; i < p.ramp.length; i++) {
        assert(p.ramp[i].coverage > p.ramp[i - 1].coverage, `ramp coverage not increasing at ${i}: ${p.ramp[i - 1].coverage} → ${p.ramp[i].coverage}`);
      }
      assert(p.ramp[0].coverage >= 0 && p.ramp[p.ramp.length - 1].coverage <= 1, 'ramp coverage outside 0..1');
      assert(p.ramp.every(g => g.width > 0 && g.width <= p.charW + 0.3), 'a ramp glyph is wider than the cell');
      assert(new Set(p.ramp.map(g => g.glyph)).size >= p.levels - 1, 'ramp repeats glyphs');
      console.log(`  serif palette: ${p.levels} levels from ${p.usable}/${p.candidates} candidates, coverage ${p.ramp[0].coverage.toFixed(3)}..${p.ramp[p.ramp.length - 1].coverage.toFixed(3)}, ramp "${p.ramp.map(g => g.glyph).join('')}", land in ${serifGlyphs.length} glyphs`);
      await page.click('#map-serif');
      await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().base?.serif === false);
      await page.click('#map-art-clear');
      assert.equal(await page.evaluate(() => window.ATLAS_MAP_ART.debug().result), null);
      // Rebuild while the worker has pending requests, then keep using controls.
      await page.setViewportSize({ width: 1050, height: 760 });
      await page.waitForTimeout(300);
      await page.evaluate(() => window.ATLAS_MAP_ART.country('petra'));
      await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().result?.id === 'petra');
      assert.deepEqual(errors, []);
      console.log(`map art ${query || 'worker'}: ${shaped} silhouettes + ${regional} insets${fellBack.length ? ' (' + fellBack.join(', ') + ')' : ''}, complete stories for all ${places.length}; route controls, dateline, text, marker stability and resize OK`);
    } finally { await context.close(); }
  }
}
