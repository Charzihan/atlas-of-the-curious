import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Script, runInNewContext } from 'node:vm';
import { buildStandalone, bundleEarthxt, bundlePageScripts } from '../../scripts/earthxt/standalone.mjs';

test('standalone HTML embeds executable code, styles, and matching CSP hashes', async () => {
  const { html, output } = await buildStandalone();
  assert.equal(await readFile(output, 'utf8'), html);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(script && style);
  assert.doesNotThrow(() => new Script(script));
  for (const content of [script, style]) {
    const hash = createHash('sha256').update(content).digest('base64');
    assert.ok(html.includes(`'sha256-${hash}'`));
  }
  assert.ok(html.includes("connect-src data:"));
  assert.ok(!/<script[^>]+src=|<link[^>]+rel="stylesheet"/.test(html));
  assert.ok(!/^\s*(?:import|export)\s|\bimport\.meta/m.test(script));
  assert.ok(!html.includes('href="./"'), 'Home must not navigate out of the standalone file');
});

test('bundled data loader loads the complete real geography using only embedded data', async () => {
  const requests = [];
  const code = await bundleEarthxt('geography.js');
  const { loadGeography } = runInNewContext(code, {
    TextEncoder,
    fetch: async url => {
      assert.ok(url.startsWith('data:'), 'No server or network request is allowed');
      requests.push(url.slice(0, url.indexOf(',')));
      return fetch(url);
    },
  });
  const geography = await loadGeography();
  assert.equal(requests.length, 2);
  assert.equal(geography.countries.length, 177);
  assert.ok(geography.loadedBytes > 1324800);
  const sample = {};
  geography.sample(56, -106, { id: 'countries' }, sample);
  assert.equal(geography.countries[sample.country - 1].code, 'CAN');
  geography.sample(0, -140, { id: 'planet' }, sample);
  assert.equal(sample.country, 0);
});

test('standalone embeds pretext and metrics remain importable without atlas data', async () => {
  const { runtimeGraph } = await import('../../scripts/earthxt/graph.mjs');
  const { registryDocument } = await import('./fonts-fixture.mjs');
  const { html } = await buildStandalone();
  for (const file of (await runtimeGraph()).keys()) {
    if (file.startsWith('vendor/pretext/')) assert.ok(html.includes(`modules[${JSON.stringify(file)}] =`), file);
  }
  assert.ok(html.includes('function prepareWithSegments('));
  assert.ok(html.includes('function measureNaturalWidth('));
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.ok(style.indexOf('--font-mono:') < style.indexOf('--mono:'));
  const doc = registryDocument(style);
  const win = {};
  const code = await bundleEarthxt('../js/text.js');
  const { readFontRoles, readFontFamily } = runInNewContext(code, { document: doc, window: win });
  assert.equal(win.ATLAS_TEXT_READY, undefined, 'globe imports must not boot atlas');
  const role = readFontRoles(doc, ['globe-label'])['globe-label'];
  assert.equal(role.font, `normal 10px ${readFontFamily(doc, '--font-mono')}`);
  assert.equal(role.lineHeight, 10);
  assert.equal(role.letterSpacing, 0.5);
});


test('page bundling executes classic atlas data before its dependent module', async () => {
  const source = await readFile(new URL('../../js/data.js', import.meta.url), 'utf8');
  const template = '<script src="../js/data.js"></script><script type="module" src="./probe.js"></script>';
  const graph = new Map([
    ['js/data.js', { bytes: Buffer.from(source) }],
    ['earthxt/probe.js', { bytes: Buffer.from('window.observedPlaces = window.ATLAS_DATA.places.length;') }]
  ]);
  const window = {};
  runInNewContext(bundlePageScripts(graph, template), { window });
  assert.equal(window.observedPlaces, 40);
  const { html } = await buildStandalone();
  assert.match(html, /<html lang="en" data-standalone>/);
  assert.ok(html.indexOf('window.ATLAS_DATA = Object.freeze') < html.indexOf('function boot(win, doc)'));
  assert.match(html, /id="globe-markers"/);
  for (const file of ['earthxt/places.js', 'earthxt/place-layer.js', 'js/hover-card.js']) assert.ok(html.includes(`modules[${JSON.stringify(file)}] =`));
  // NUL and other HTML-normalized control bytes would invalidate CSP hashes.
  for (const [file, { bytes }] of (await (await import('../../scripts/earthxt/graph.mjs')).runtimeGraph())) {
    if (/\.(?:js|css|html)$/.test(file)) assert.doesNotMatch(bytes.toString('utf8'), /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/, file);
  }
});
