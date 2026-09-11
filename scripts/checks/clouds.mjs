/* The sky, checked.

   Two halves, the same as the other phase checks:

     1. Geometry, in Node, against the pure generator (js/clouds.js). Twenty
        clouds from one fixed seed have to be twenty different drawings, every
        row has to balance its `(` against its `)`, every outline has to be
        closed around its white interior, and every cloud has to fit inside
        CLOUD_BOUNDS. This half needs no browser and runs from `node
        scripts/checks/clouds.mjs`.

     2. The same clouds on the page: ink actually on the cloud canvas, the
        canvas still in the monospace face with the serif atlas on, six distinct
        shapes in the sky, a morph that cross-fades and resolves, the frame cost
        of all of it under a 4x CPU throttle measured against the sprite path it
        replaces, and `?noflags=asciiClouds` running the old blobs with a clean
        console.

   The two 4x CPU frame-time ceilings this phase must not break live in
   scripts/checks/sea.mjs and scripts/checks/map-art-extra.mjs; both run in
   `pnpm smoke` alongside this file. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import {
  generateCloud, generateCloudSet, makeRng, mixSeed,
  CLOUD_BOUNDS, CLOUD_GLYPHS, CLOUD_TEMPLATES, CELL_INTERIOR, CELL_OUTLINE
} from '../../js/clouds.js';

const GEOMETRY_SEED = 0x0c10d5;   // a fixed seed: these assertions are exact
const GEOMETRY_COUNT = 20;
const ALLOWED = new Set(CLOUD_GLYPHS);

// Every claim this file makes about one cloud's outline.
function checkOutline(cloud, label) {
  const B = CLOUD_BOUNDS;
  assert(cloud.cols >= B.minCols && cloud.cols <= B.maxCols,
    `${label}: ${cloud.cols} columns is outside ${B.minCols}..${B.maxCols}`);
  assert(cloud.rows >= B.minRows && cloud.rows <= B.maxRows,
    `${label}: ${cloud.rows} rows is outside ${B.minRows}..${B.maxRows}`);
  assert.equal(cloud.lines.length, cloud.rows, `${label}: ${cloud.lines.length} lines for ${cloud.rows} rows`);
  assert(cloud.interiorCells >= 2, `${label}: no white inside the outline`);

  for (let r = 0; r < cloud.rows; r++) {
    const line = cloud.lines[r];
    assert(line.length <= cloud.cols, `${label} row ${r}: ${line.length} glyphs in ${cloud.cols} columns`);
    let opens = 0, closes = 0;
    for (const ch of line) {
      assert(ALLOWED.has(ch), `${label} row ${r}: ${JSON.stringify(ch)} is not a cloud glyph`);
      if (ch === '(') opens++;
      else if (ch === ')') closes++;
    }
    // A row draws one side of the cloud and then the other; a row that opens
    // two walls and closes none is a cloud with a hole in its side.
    assert(Math.abs(opens - closes) <= 1,
      `${label} row ${r}: ${opens} "(" against ${closes} ")" in ${JSON.stringify(line)}`);
    // The strings and the cell grid have to agree, cell for cell.
    for (let c = 0; c < cloud.cols; c++) {
      const code = cloud.grid[r * cloud.cols + c];
      const glyph = c < line.length ? line[c] : ' ';
      if (code === CELL_OUTLINE) assert(glyph !== ' ', `${label} r${r}c${c}: outline cell drew a blank`);
      else assert.equal(glyph, ' ', `${label} r${r}c${c}: ${JSON.stringify(glyph)} on a cell that is not outline`);
    }
  }

  // Closed: every white cell has drawn ink to its left and right on its own row,
  // and drawn ink above and below it in its own column.
  let interiorSeen = 0;
  for (let r = 0; r < cloud.rows; r++) {
    for (let c = 0; c < cloud.cols; c++) {
      if (cloud.grid[r * cloud.cols + c] !== CELL_INTERIOR) continue;
      interiorSeen++;
      let left = false, right = false, above = false, below = false;
      for (let x = c - 1; x >= 0; x--) if (cloud.grid[r * cloud.cols + x] === CELL_OUTLINE) { left = true; break; }
      for (let x = c + 1; x < cloud.cols; x++) if (cloud.grid[r * cloud.cols + x] === CELL_OUTLINE) { right = true; break; }
      for (let y = r - 1; y >= 0; y--) if (cloud.grid[y * cloud.cols + c] === CELL_OUTLINE) { above = true; break; }
      for (let y = r + 1; y < cloud.rows; y++) if (cloud.grid[y * cloud.cols + c] === CELL_OUTLINE) { below = true; break; }
      assert(left && right && above && below,
        `${label} r${r}c${c}: white cell open ${[!left && 'left', !right && 'right', !above && 'above', !below && 'below'].filter(Boolean).join(', ')}`);
    }
  }
  assert.equal(interiorSeen, cloud.interiorCells, `${label}: interior count disagrees with the grid`);

  // The interior runs js/map.js clips the soft fill to are those same cells.
  let runCells = 0;
  for (const [row, c0, c1] of cloud.interior) {
    assert(row >= 0 && row < cloud.rows && c0 >= 0 && c1 >= c0 && c1 < cloud.cols, `${label}: interior run out of bounds`);
    for (let c = c0; c <= c1; c++) {
      assert.equal(cloud.grid[row * cloud.cols + c], CELL_INTERIOR, `${label}: interior run r${row}c${c} is not white`);
      runCells++;
    }
  }
  assert.equal(runCells, cloud.interiorCells, `${label}: interior runs cover ${runCells} of ${cloud.interiorCells} cells`);
}

export function runCloudGeometryChecks() {
  const set = generateCloudSet(GEOMETRY_COUNT, { seed: GEOMETRY_SEED });
  assert.equal(set.length, GEOMETRY_COUNT);
  const keys = new Set();
  let widest = 0, narrowest = Infinity, tallest = 0, fromTemplate = 0;
  for (let i = 0; i < set.length; i++) {
    const cloud = set[i];
    checkOutline(cloud, `cloud ${i} (${cloud.source}, seed ${cloud.seed})`);
    assert(!keys.has(cloud.key), `clouds ${i} and an earlier one are the same drawing:\n${cloud.lines.join('\n')}`);
    keys.add(cloud.key);
    widest = Math.max(widest, cloud.cols);
    narrowest = Math.min(narrowest, cloud.cols);
    tallest = Math.max(tallest, cloud.rows);
    if (cloud.source.startsWith('template:')) fromTemplate++;
  }
  assert.equal(keys.size, GEOMETRY_COUNT, 'the sky repeated itself');
  // Both halves of the generator have to be pulling their weight, or "no two
  // alike" is only true because one of them is doing all the work.
  assert(fromTemplate > 0, 'no hand-drawn template was used');
  assert(fromTemplate < GEOMETRY_COUNT, 'no cloud was generated from lobes');

  // Same seed, same cloud — in Node and in the browser, which is what makes
  // the outline testable at all.
  for (const seed of [GEOMETRY_SEED, 1, 99991, 0x7fffffff]) {
    const a = generateCloud({ seed });
    const b = generateCloud({ seed });
    assert.equal(a.key, b.key, `seed ${seed} is not deterministic`);
    assert.notEqual(generateCloud({ seed, morph: 1 }).key, a.key, `seed ${seed} did not morph`);
  }

  // A morph re-frays one cloud; it does not hand back a different cloud. The
  // base line is what js/map.js anchors, so the width may only wander a little.
  let morphed = 0;
  for (let i = 0; i < 24; i++) {
    const seed = mixSeed(GEOMETRY_SEED, i);
    const first = generateCloud({ seed });
    for (let morph = 1; morph <= 4; morph++) {
      const next = generateCloud({ seed, morph });
      checkOutline(next, `morph ${morph} of seed ${seed}`);
      assert(Math.abs(next.cols - first.cols) <= 6 && Math.abs(next.rows - first.rows) <= 2,
        `morph ${morph} of seed ${seed} changed the cloud, not its edges: ${first.cols}x${first.rows} -> ${next.cols}x${next.rows}`);
      if (next.key !== first.key) morphed++;
    }
  }
  assert(morphed >= 24 * 4 * 0.8, `only ${morphed} of ${24 * 4} morphs changed anything`);

  // The aspect the map passes changes the shape (cells are twice as tall as
  // they are wide, and a lobe has to know that), but never its legality.
  for (const aspect of [1.2, 1.95, 2.6]) {
    for (const cloud of generateCloudSet(6, { seed: 4242, aspect })) {
      checkOutline(cloud, `aspect ${aspect} cloud`);
    }
  }
  // The hand-drawn seeds are legal silhouettes in their own right.
  assert(CLOUD_TEMPLATES.length >= 3, 'fewer than three hand-drawn templates');
  // The rng underneath all of it is a pure function of its seed, and stays
  // inside 0..1 (a lobe radius or a row index computed from it must not blow up).
  const a = makeRng(7), b = makeRng(7), c = makeRng(8);
  let differs = false;
  for (let i = 0; i < 64; i++) {
    const x = a(), y = b(), z = c();
    assert.equal(x, y, 'makeRng is not deterministic');
    assert(x >= 0 && x < 1, `makeRng returned ${x}`);
    if (x !== z) differs = true;
  }
  assert(differs, 'two different seeds gave the same stream');

  return { count: GEOMETRY_COUNT, narrowest, widest, tallest, fromTemplate };
}

/* ---- On the page ---------------------------------------------------------- */

const frames = () => new Promise(resolve => {
  const samples = []; let last;
  const tick = t => {
    if (last) samples.push(t - last);
    last = t;
    if (samples.length < 120) requestAnimationFrame(tick);
    else resolve({
      avg: samples.reduce((a, b) => a + b, 0) / samples.length,
      p95: samples.slice().sort((a, b) => a - b)[113]
    });
  };
  requestAnimationFrame(tick);
});

export async function runCloudChecks(browser, origin, fail) {
  const report = fail || ((m) => { throw new Error(m); });
  const geometry = runCloudGeometryChecks();
  console.log(`clouds: ${geometry.count} generated outlines, all different; ` +
    `${geometry.narrowest}..${geometry.widest} columns, up to ${geometry.tallest} rows; ` +
    `${geometry.fromTemplate} from hand-drawn templates`);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('frame-ancestors')) errors.push(m.text()); });
  try {
    await page.goto(origin);
    await page.waitForFunction(() => window.ATLAS_MAP_DEBUG?.clouds);
    await page.waitForTimeout(700);
    const sky = await page.evaluate(() => window.ATLAS_MAP_DEBUG.clouds());
    assert.equal(sky.ascii, true, 'the ASCII cloud path is not the default');
    assert(sky.count >= 4, `only ${sky.count} clouds`);
    assert(sky.canvas.ink > 400, `the cloud canvas is empty (${sky.canvas.ink} inked pixels)`);
    assert(/mono|courier|consolas|menlo/i.test(sky.font) || sky.font.includes('px'),
      `the cloud canvas font is ${sky.font}`);

    // Every shape in the sky is a different drawing, and each one is the same
    // closed outline Node checked — the browser is running the same module.
    const keys = new Set();
    for (const shape of sky.shapes) {
      checkOutlineFromLines(shape, `on-page cloud (${shape.source})`);
      assert(!keys.has(shape.key), `two clouds in the sky are the same drawing:\n${shape.lines.join('\n')}`);
      keys.add(shape.key);
    }
    assert.equal(keys.size, sky.count, 'the sky repeated itself');

    // Clouds now cross the whole map, the polar ice included: the rows the base
    // canvas paints in the palest ink are no longer out of bounds for a cloud.
    const paleRows = sky.paleRows.reduce((a, b) => a + b, 0);
    assert(paleRows > 0, 'no pale polar rows found on the map');
    const overIce = await page.evaluate(() => {
      const d = window.ATLAS_MAP_DEBUG.clouds();
      return d.shapes.filter(s => {
        for (let r = s.topRow; r <= s.baseRow; r++) if (d.paleRows[r]) return true;
        return false;
      }).length;
    });
    // Whole cells, always: an outline half a column off the grid is a misprint.
    for (const shape of sky.shapes) {
      assert(shape.drawCol !== null, 'a cloud was never painted');
      assert.equal(shape.drawCol, Math.round(shape.drawCol),
        `a cloud was drawn at column ${shape.drawCol}, off the character grid`);
    }

    // Park a cloud on the last row and check the ink changes: over the white
    // ice the outline has to stop being soft white, or there is nothing to see.
    const overSea = await page.evaluate(() => {
      const d = window.ATLAS_MAP_DEBUG.clouds();
      let row = 0;                                    // the last row that is not ice
      for (let r = 0; r < d.paleRows.length; r++) if (!d.paleRows[r]) row = r;
      return window.ATLAS_MAP_DEBUG.cloudTo(0, row);
    });
    assert(overSea && !overSea.ice, 'a cloud parked clear of the ice still reports ice');
    const parked = await page.evaluate(() => {
      const d = window.ATLAS_MAP_DEBUG.clouds();
      return window.ATLAS_MAP_DEBUG.cloudTo(0, d.cell.rows - 1);
    });
    assert(parked && parked.ice, 'a cloud parked on the bottom row is not over the ice');
    const iceInks = new Set(parked.inks);
    assert(iceInks.size >= 1, 'the parked cloud has no ink');
    const soft = overSea.inks[overSea.inks.length - 1];
    assert(![...iceInks].every(c => c === soft),
      `the outline over the ice is still ${soft}`);
    await page.waitForTimeout(200);
    const iced = await page.evaluate(() => window.ATLAS_MAP_DEBUG.clouds());
    assert(iced.canvas.ink > 400, 'the sky went blank with a cloud over Antarctica');
    console.log(`clouds on the page: ${sky.count} distinct shapes, ${sky.canvas.ink} inked pixels, ` +
      `${paleRows} pale polar rows, ${overIce} of them reached by the random sky, ` +
      `ink over the ice ${[...iceInks].join(' + ')}`);

    // The morph: a new outline from the same seed, cross-faded and resolved.
    const morph = await page.evaluate(() => window.ATLAS_MAP_DEBUG.morphCloud(1));
    assert(morph, 'no cloud to morph');
    assert.notEqual(morph.to, morph.was, 'the morph regenerated the same outline');
    assert(await page.evaluate(() => window.ATLAS_MAP_DEBUG.clouds().shapes[1].morphing), 'the cross-fade never started');
    await page.waitForFunction(() => !window.ATLAS_MAP_DEBUG.clouds().shapes[1].morphing, { timeout: 5000 });
    const after = await page.evaluate(() => window.ATLAS_MAP_DEBUG.clouds().shapes[1]);
    assert.equal(after.key, morph.to, 'the cross-fade did not land on the new outline');
    checkOutlineFromLines(after, 'the morphed cloud');
    console.log(`morph: seed ${after.seed} redrew its outline (${after.cols}x${after.rows}) and cross-faded in ${morph.ms}ms`);

    // The serif atlas repaints the land and the sea; the sky stays in type.
    await page.evaluate(() => window.ATLAS_MAP_ART.setSerif(true));
    await page.waitForFunction(() => window.ATLAS_MAP_ART.debug().base?.serif);
    await page.waitForTimeout(200);
    const serifSky = await page.evaluate(() => window.ATLAS_MAP_DEBUG.clouds());
    assert.equal(serifSky.font, sky.font, `serif mode changed the cloud font to ${serifSky.font}`);
    assert(serifSky.canvas.ink > 400, 'the clouds went out in serif mode');
    await page.evaluate(() => window.ATLAS_MAP_ART.setSerif(false));
    await page.waitForTimeout(200);

    // Screenshots: the sky at 1280x800, and one cloud close up at zoom 2.5.
    await mkdir('docs/screenshots', { recursive: true });
    await page.screenshot({ path: 'docs/screenshots/clouds-1280.png' });
    // Park a cloud in the middle of the map before zooming, so the close-up is
    // of a cloud and not of whatever the viewport centre happened to hold.
    await page.evaluate(() => {
      const d = window.ATLAS_MAP_DEBUG.clouds();
      let widest = 0;
      for (let i = 1; i < d.shapes.length; i++) if (d.shapes[i].cols > d.shapes[widest].cols) widest = i;
      window.ATLAS_MAP_DEBUG.cloudTo(widest, Math.round(d.cell.rows / 2));
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.setZoom(2.5));
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'docs/screenshots/clouds-zoom.png' });
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.setZoom(1));
    await page.evaluate(() => window.ATLAS_MAP_DEBUG.settle());

    // The frame cost of drawing the sky in type, against the sprite path it
    // replaces, under the same 4x CPU throttle the sea and serif checks use.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const ascii = await page.evaluate(frames);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const baseline = await page.evaluate(frames);

    const blob = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const blobPage = await blob.newPage();
    const blobErrors = [];
    blobPage.on('pageerror', e => blobErrors.push(e.message));
    blobPage.on('console', m => { if (m.type() === 'error' && !m.text().includes('frame-ancestors')) blobErrors.push(m.text()); });
    await blobPage.goto(origin + '/?noflags=asciiClouds');
    await blobPage.waitForFunction(() => window.ATLAS_MAP_DEBUG?.clouds);
    await blobPage.waitForTimeout(700);
    const oldSky = await blobPage.evaluate(() => window.ATLAS_MAP_DEBUG.clouds());
    assert.equal(oldSky.ascii, false, '?noflags=asciiClouds still drew ASCII clouds');
    assert(oldSky.canvas.ink > 400, `the sprite clouds are not drawing (${oldSky.canvas.ink} inked pixels)`);
    assert.equal(oldSky.canvas.dpr, 1, 'the sprite path no longer draws at 1x');
    const blobCdp = await blob.newCDPSession(blobPage);
    await blobCdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const sprite = await blobPage.evaluate(frames);
    await blobCdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    for (const e of blobErrors) console.error(`  error: ${e}`);
    if (blobErrors.length) report(`?noflags=asciiClouds logged ${blobErrors.length} console/page error(s)`);
    await blob.close();

    console.log(`clouds at 4x CPU: ascii avg ${ascii.avg.toFixed(2)}ms, p95 ${ascii.p95.toFixed(2)}ms; ` +
      `sprites avg ${sprite.avg.toFixed(2)}ms, p95 ${sprite.p95.toFixed(2)}ms; ` +
      `unthrottled vsync avg ${baseline.avg.toFixed(2)}ms`);
    const ceiling = baseline.avg * 2 + 1;
    for (const metric of ['avg', 'p95']) {
      if (ascii[metric] > sprite[metric] * 1.25 + 1) {
        report(`ascii clouds ${metric} ${ascii[metric].toFixed(2)}ms exceeds 1.25x the sprite path ${sprite[metric].toFixed(2)}ms`);
      }
      if (ascii[metric] > ceiling) {
        report(`ascii clouds ${metric} ${ascii[metric].toFixed(2)}ms exceeds 2x vsync ${ceiling.toFixed(2)}ms`);
      }
    }

    for (const e of errors) console.error(`  error: ${e}`);
    if (errors.length) report(`the cloud page logged ${errors.length} console/page error(s)`);
  } finally {
    await context.close();
  }
}

// The on-page shapes arrive as plain JSON (no typed grid), so the closure
// assertions are re-derived from the strings the canvas actually drew.
function checkOutlineFromLines(shape, label) {
  const B = CLOUD_BOUNDS;
  assert(shape.cols >= B.minCols && shape.cols <= B.maxCols, `${label}: ${shape.cols} columns`);
  assert(shape.rows >= B.minRows && shape.rows <= B.maxRows, `${label}: ${shape.rows} rows`);
  assert.equal(shape.lines.length, shape.rows, `${label}: line count`);
  const ink = shape.lines.map(line => {
    const row = new Array(shape.cols).fill(false);
    for (let c = 0; c < line.length; c++) {
      assert(ALLOWED.has(line[c]), `${label}: ${JSON.stringify(line[c])} is not a cloud glyph`);
      if (line[c] !== ' ') row[c] = true;
    }
    return row;
  });
  for (let r = 0; r < shape.rows; r++) {
    let opens = 0, closes = 0;
    for (const ch of shape.lines[r]) { if (ch === '(') opens++; else if (ch === ')') closes++; }
    assert(Math.abs(opens - closes) <= 1, `${label} row ${r}: ${opens} "(" against ${closes} ")"`);
  }
  // The white interior: a blank cell with ink both sides of it on its row and
  // ink above and below it in its column. Every such cell must be enclosed —
  // which, drawn from the strings alone, is the same statement as "the blanks
  // inside the outline are inside the outline".
  let interior = 0;
  for (let r = 1; r < shape.rows - 1; r++) {
    for (let c = 1; c < shape.cols - 1; c++) {
      if (ink[r][c]) continue;
      let left = false, right = false, above = false, below = false;
      for (let x = c - 1; x >= 0; x--) if (ink[r][x]) { left = true; break; }
      for (let x = c + 1; x < shape.cols; x++) if (ink[r][x]) { right = true; break; }
      for (let y = r - 1; y >= 0; y--) if (ink[y][c]) { above = true; break; }
      for (let y = r + 1; y < shape.rows; y++) if (ink[y][c]) { below = true; break; }
      if (left && right && above && below) interior++;
      else assert(!(left && right) || !(above || below),
        `${label} r${r}c${c}: a blank between two walls is not enclosed`);
    }
  }
  assert.equal(interior, shape.interiorCells, `${label}: ${interior} enclosed blanks for ${shape.interiorCells} interior cells`);
}

// node scripts/checks/clouds.mjs — the geometry half, no browser needed.
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = runCloudGeometryChecks();
  console.log(`cloud geometry OK: ${out.count} outlines, ${out.narrowest}..${out.widest} columns, ` +
    `up to ${out.tallest} rows, ${out.fromTemplate} from templates`);
  for (const cloud of generateCloudSet(4, { seed: 1234 })) {
    console.log('');
    for (const line of cloud.lines) console.log('  ' + line);
  }
}
