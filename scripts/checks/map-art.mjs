/* Browser acceptance checks for phases 7–8; runs both layout hosts. */
import assert from 'node:assert/strict';
import { containsLineBox, boxesOverlap, markerObstacle, buildInkRamp } from '../../js/map-art.js';

// At 1280x800 at least 34 stories must still fit after full-box containment
// and panel/marker clearance; report the actual silhouette/inset counts.
const MIN_SILHOUETTES = 34;

export async function runMapArtChecks(browser, origin) {
  checkRampConstruction();
  let workerRamp;
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
      let shaped = 0, regional = 0, captions = 0;
      const fellBack = [];
      for (const p of places) {
        await page.evaluate(id => window.ATLAS_MAP_ART.country(id), p.id);
        const snapshot = await page.waitForFunction(id => { const d = window.ATLAS_MAP_ART.debug(); return d.result?.id === id ? d : false; }, p.id);
        const out = await snapshot.jsonValue();
        
        assert(out.result.complete, p.id + ' story incomplete');
        const text = out.result.mode === 'caption' ? out.result.text : out.result.lines.map(l => l.text).join('');
        assert.equal(text.replace(/\s/g, ''), p.story.replace(/\s/g, ''), p.id + ' story lost words');
        if (out.result.mode === 'country') shaped++; else {
          if (out.result.mode === 'region') regional++; else captions++;
          fellBack.push(p.id + ':' + out.result.mode);
        }
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
          assert(out.panels.every(box => !boxesOverlap(l, box)), p.id + ' text under a panel');
          if (out.result.mode === 'country') {
            assert(containsLineBox(out.result.shape.rings, l), p.id + ' line escapes the silhouette');
            assert(!boxesOverlap(l, markerObstacle(out.result.marker)), p.id + ' text under its marker');
          }
        }
      }
      console.log(`map art ${query || 'worker'}: ${shaped} silhouettes + ${regional} insets + ${captions} captions${fellBack.length ? ' (' + fellBack.join(', ') + ')' : ''}`);
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
      const p = serif.palette;
      assert.deepEqual(serif.base.landPositions, mono.landPositions, 'serif mode changed land cell positions');
      const registry = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-serif').trim());
      // Canvas preserves the requested stack; headless Linux substitutes for
      // Georgia. This asserts the registry string, not which face supplied ink.
      const unquote = s => s.replace(/["']/g, '');
      assert(unquote(serif.base.font).includes(unquote(registry)), 'base canvas font omits the registry serif family: ' + serif.base.font);
      assert(!unquote(mono.font).includes(unquote(registry)), 'monospace base canvas claimed the serif family');
      const multiset = ink => Object.keys(ink.land).sort().map(g => g + ink.land[g]).join(' ');
      assert.notEqual(multiset(serif.base), multiset(mono), 'serif land glyphs are the monospace ones');
      const monoGlyphs = new Set(Object.keys(mono.land)), serifGlyphs = Object.keys(serif.base.land);
      // Land starts at the interior tone; a short ramp naturally uses fewer
      // than six rungs between that tone and the coast.
      const minLandGlyphs = Math.min(6, p.levels - Math.round(p.coast.interior * (p.levels - 1)));
      assert(serifGlyphs.length >= minLandGlyphs, 'serif land uses only ' + serifGlyphs.length + ' glyphs');
      assert(serifGlyphs.some(g => !monoGlyphs.has(g)), 'serif land introduced no new glyph');
      assert(serifGlyphs.some(g => /[\p{L}\p{M}]/u.test(g)), 'serif land has no letters in it');
      // The ramp is measured coverage, and it has to be monotone along the ramp.
      assert.equal(p.ramp.length, p.levels, 'ramp length disagrees with the level count');
      assert(p.usable && p.levels >= 6 && p.levels <= 24, 'invalid usable ramp length: ' + p.levels);
      assert(p.measured, 'palette coverage was not measured from rendered ink');
      assert.equal(p.canvas, query ? 'dom' : 'offscreen', 'wrong canvas measurement branch');
      assert.equal(p.dpr, await page.evaluate(() => Math.min(2, devicePixelRatio)));
      for (let i = 1; i < p.ramp.length; i++) {
        assert(p.ramp[i].coverage > p.ramp[i - 1].coverage, `ramp coverage not increasing at ${i}: ${p.ramp[i - 1].coverage} → ${p.ramp[i].coverage}`);
      }
      assert(p.ramp[0].coverage >= 0 && p.ramp[p.ramp.length - 1].coverage <= 1, 'ramp coverage outside 0..1');
      assert(p.ramp.every(g => g.width > 0 && g.width <= p.charW && g.spill <= 0.06), 'a ramp glyph violates the cell fit limits');
      assert.equal(new Set(p.ramp.map(g => g.glyph)).size, p.levels, 'ramp repeats glyphs');
      if (query) assert.deepEqual(p.ramp, workerRamp, 'worker and DOM-canvas ramps differ');
      else workerRamp = p.ramp;
      await checkRasterRamp(page, p);
      console.log(`  serif palette (${p.canvas}, DPR ${p.dpr}): ${p.levels} levels from ${p.fitting}/${p.candidates} candidates, coverage ${p.ramp[0].coverage.toFixed(3)}..${p.ramp[p.ramp.length - 1].coverage.toFixed(3)}, ramp "${p.ramp.map(g => g.glyph).join('')}", land in ${serifGlyphs.length} glyphs`);
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
      console.log(`map art ${query || 'worker'}: complete stories for all ${places.length}; route controls, dateline, text, marker stability and resize OK`);
    } finally { await context.close(); }
  }
  await checkSerifEdgeCases(browser, origin);
}

export function checkRampConstruction() {
  for (const count of [0, 1, 5, 6, 12, 24, 30]) {
    const glyphs = Array.from({ length: count }, (_, i) => ({ glyph: String.fromCharCode(65 + i), width: 7, coverage: (i + 1) / 40, spill: 0.06 }));
    const unsafe = [
      { glyph: 'wide', width: 8.01, coverage: 0.95, spill: 0 },
      { glyph: 'spill', width: 7, coverage: 0.96, spill: 0.0601 },
      { glyph: 'blank', width: 7, coverage: 0, spill: 0 }
    ];
    const out = buildInkRamp(glyphs.concat(unsafe), 8);
    assert.equal(out.ramp.length, Math.min(count, 24), 'sparse ramp was padded or unsafe ink admitted');
    assert.equal(out.usable, count >= 6, 'wrong minimum usable ramp length');
    assert(out.ramp.every((g, i) => i === 0 || g.inkCoverage > out.ramp[i - 1].inkCoverage), 'sparse ramp is not strictly monotone');
  }
  const tied = buildInkRamp([
    { glyph: 'narrow', width: 4, coverage: 0.2, spill: 0 },
    { glyph: 'wide', width: 8, coverage: 0.2, spill: 0 }
  ], 8);
  assert.equal(tied.ramp[0].glyph, 'wide', 'equal ink did not keep the widest glyph');
  console.log('serif ramp construction: 0/1/5/6/12/24/30 fitting tones, strict fit limits and widest tie OK');
}

async function checkRasterRamp(page, palette) {
  const raster = await page.evaluate(p => {
    const canvas = document.createElement('canvas'), pad = 64;
    canvas.width = Math.ceil(p.charW * p.dpr) + 2 * pad;
    canvas.height = Math.ceil(p.lineH * p.dpr) + 2 * pad;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.scale(p.dpr, p.dpr);
    ctx.translate(pad / p.dpr, pad / p.dpr);
    ctx.font = p.font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    return p.ramp.map(g => {
      ctx.clearRect(-pad / p.dpr, -pad / p.dpr, canvas.width / p.dpr, canvas.height / p.dpr);
      // Production placement, with a whole-device-pixel translation to retain
      // all overflow for inspection. Fractional CSS cell dimensions stay intact.
      ctx.fillText(g.glyph, (p.charW - g.width) / 2, 0.5 * p.lineH);
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let total = 0, inside = 0;
      for (let i = 3; i < rgba.length; i += 4) {
        const pixel = (i - 3) / 4, x = pixel % canvas.width - pad, y = Math.floor(pixel / canvas.width) - pad;
        const dx = Math.max(0, Math.min(x + 1, p.charW * p.dpr) - Math.max(0, x));
        const dy = Math.max(0, Math.min(y + 1, p.lineH * p.dpr) - Math.max(0, y));
        total += rgba[i]; inside += rgba[i] * dx * dy;
      }
      return { coverage: inside / (255 * p.charW * p.lineH * p.dpr ** 2), spill: (total - inside) / (total || 1), width: ctx.measureText(g.glyph).width };
    });
  }, palette);
  for (let i = 0; i < raster.length; i++) {
    const actual = raster[i], expected = palette.ramp[i];
    assert(i === 0 || actual.coverage > raster[i - 1].coverage, `production raster coverage not increasing at ${i} (DPR ${palette.dpr})`);
    assert(actual.spill <= 0.06 + 1e-10, `production raster spills ${(actual.spill * 100).toFixed(2)}% at ${i}`);
    assert(Math.abs(actual.coverage - expected.inkCoverage) < 1e-8, `probe/production coverage mismatch at ${i}`);
    assert(Math.abs(actual.spill - expected.spill) < 1e-8, `probe/production spill mismatch at ${i}`);
    assert(Math.abs(actual.width - expected.width) < 0.01, `probe/production advance mismatch at ${i}`);
  }
}

async function checkSerifEdgeCases(browser, origin) {
  for (const dpr of [1.25, 2]) {
    let workerRamp;
    for (const query of ['', '?noflags=worker']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
      try {
        const page = await context.newPage();
        await page.goto(origin + '/' + query);
        await page.waitForFunction(() => window.ATLAS_MAP_ART && document.querySelector('.map-marker'));
        if (!query) await page.waitForFunction(() => window.ATLAS_MAP_DEBUG.workerActive());
        await page.evaluate(() => window.ATLAS_MAP_ART.setSerif(true));
        const p = await (await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().base?.serif && window.ATLAS_MAP_ART.debug().palette)).jsonValue();
        assert.equal(p.dpr, dpr);
        assert.equal(p.canvas, query ? 'dom' : 'offscreen');
        await checkRasterRamp(page, p);
        if (query) assert.deepEqual(p.ramp, workerRamp, `host ramps differ at DPR ${dpr}`);
        else workerRamp = p.ramp;
        console.log(`  serif raster (${p.canvas}, DPR ${dpr}): ${p.levels} rungs, monotone coverage and <=6% spill OK`);
        if (query) {
          const cached = await page.evaluate(async p => {
            const { createMapArtEngine } = await import('/js/map-art.js');
            const engine = createMapArtEngine(), req = { ...window.ATLAS_MAP_ART.debug().geometry, size: p.size, dpr: p.dpr };
            const first = engine.palette(req), next = engine.palette({ ...req, dpr: 1 });
            return { reused: first === engine.palette(req), separated: first !== next, dprs: [first.dpr, next.dpr] };
          }, p);
          assert.deepEqual(cached, { reused: true, separated: true, dprs: [dpr, 1] }, 'DPR missing from palette cache key');
        }
      } finally { await context.close(); }
    }
  }
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(origin + '/?noflags=worker');
    await page.waitForFunction(() => window.ATLAS_MAP_ART && document.querySelector('.map-marker'));
    const out = await page.evaluate(() => {
      const proto = CanvasRenderingContext2D.prototype, read = proto.getImageData;
      // Simulate a font yielding no visible tones without changing the map's
      // drawing or advance measurement. The synchronous host answers here.
      proto.getImageData = function (...args) { const pixels = read.apply(this, args); pixels.data.fill(0); return pixels; };
      try { window.ATLAS_MAP_ART.setSerif(true); } finally { proto.getImageData = read; }
      return window.ATLAS_MAP_ART.debug();
    });
    assert.equal(out.palette.levels, 0);
    assert.equal(out.palette.usable, false);
    assert.equal(out.serif, false);
    assert.equal(out.base.serif, false);
    assert.equal(await page.getAttribute('#map-serif', 'aria-pressed'), 'false');
    assert(await page.locator('#map-serif').isDisabled());
    assert.match(await page.getAttribute('#map-serif', 'title'), /fewer than 6.*6%/);
    assert.equal(await page.evaluate(() => window.ATLAS_MAP_ART.setSerif(true)), false);
    console.log('serif unavailable palette: monospace retained, toggle disabled with reason OK');
  } finally { await context.close(); }
}
