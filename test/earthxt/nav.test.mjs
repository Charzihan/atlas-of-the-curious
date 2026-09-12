import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { root, runtimeGraph, stylesheetLinks, resolveReference } from '../../scripts/earthxt/graph.mjs';
import { buildStandalone, inlineStyles } from '../../scripts/earthxt/standalone.mjs';

const read = file => readFile(new URL(file, root), 'utf8');
const [tokens, atlasCSS, globeCSS, atlasHTML, globeHTML, sw] = await Promise.all([
  'css/tokens.css', 'css/style.css', 'earthxt/styles.css', 'index.html', 'earthxt/index.html', 'sw.js',
].map(read));
// Source contracts only: these tests do not assert browser rendering or navigation.
const palette = {
  bg: '#0b1020', 'bg-soft': '#101733', panel: '#141c3a', 'panel-2': '#1a2450',
  ink: '#e8ecf8', 'ink-dim': '#9aa4c8', gold: '#e8b45a',
  'gold-soft': 'rgba(232, 180, 90, 0.16)', line: 'rgba(154, 164, 200, 0.18)',
};
const declarations = css => [...css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)];

test('shared palette is declared once with the original atlas values', () => {
  assert.match(tokens, /:root\s*\{/);
  const definitions = declarations(tokens);
  assert.deepEqual(Object.fromEntries(definitions.map(([, key, value]) => [key.slice(2), value.trim()])), palette);
  for (const name of Object.keys(palette)) {
    const matches = declarations([tokens, atlasCSS, globeCSS].join('\n')).filter(([, key]) => key === `--${name}`);
    assert.equal(matches.length, 1, `one definition of --${name}`);
  }
});

test('both pages load shared tokens before their own rules and packaging reaches them', async () => {
  assert.match(atlasCSS, /^@import url\("fonts\.css"\);\s*@import url\("tokens\.css"\);/);
  const atlasLinks = stylesheetLinks(atlasHTML).map(link => resolveReference('index.html', `./${link.reference}`));
  assert.ok(atlasLinks.includes('css/style.css'));
  const globeLinks = stylesheetLinks(globeHTML).map(link => resolveReference('earthxt/index.html', link.reference));
  assert.ok(globeLinks.indexOf('css/tokens.css') >= 0);
  assert.ok(globeLinks.indexOf('css/tokens.css') < globeLinks.indexOf('earthxt/styles.css'));
  const atlasGraph = await runtimeGraph(atlasLinks);
  const globeGraph = await runtimeGraph();
  for (const graph of [atlasGraph, globeGraph]) assert.ok(graph.has('css/tokens.css'));
  const atlasStyles = atlasLinks.map(file => inlineStyles(atlasGraph, file)).join('\n');
  const globeStyles = globeLinks.map(file => inlineStyles(globeGraph, file)).join('\n');
  for (const css of [atlasStyles, globeStyles]) {
    for (const name of Object.keys(palette)) {
      assert.equal(declarations(css).filter(([, key]) => key === `--${name}`).length, 1, name);
    }
  }
});

test('globe stylesheet derives every colour from the shared palette', () => {
  const css = globeCSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|\b(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\(/i);
  const defined = new Set(declarations(tokens).map(([, key]) => key));
  for (const [, name] of css.matchAll(/var\((--[\w-]+)\)/g)) {
    if (/^--(?:font|lh|ls)-/.test(name) || name === '--mono') continue;
    assert.ok(defined.has(name), `${name} must come from the shared palette`);
  }
  for (const [, property, value] of css.matchAll(/(?:^|[;{])\s*(color|background(?:-color|-image)?|border(?:-color|-top|-bottom)?|outline|accent-color|box-shadow)\s*:\s*([^;}]+)/gm)) {
    if (/^(?:none|0|inherit|transparent)$/.test(value.trim())) continue;
    assert.match(value, /var\(--|\btransparent\b/, `${property}: ${value}`);
  }
});

const header = html => html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)[1];
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
test('header links and document identity connect the globe to the atlas', () => {
  const atlasHeader = header(atlasHTML), globeHeader = header(globeHTML);
  assert.match(atlasHeader, /<a class="surprise-btn" href="earthxt\/">⊕ Globe<\/a>/);
  assert.match(atlasHeader, /<a class="brand" href="#\/">/);
  const brand = globeHeader.match(/<a class="brand" href="\.\.\/">([\s\S]*?)<\/a>/);
  assert.ok(brand);
  assert.equal(text(brand[1]), '✦ Atlas of the Curious');
  assert.match(globeHeader, /<span class="view-label">Globe<\/span>/);
  assert.doesNotMatch(globeHeader, /earthxt|MVP/i);
  assert.match(globeHTML, /<title>Globe · Atlas of the Curious<\/title>/);
  assert.match(atlasHTML, /<title>Atlas of the Curious — 40 extraordinary places on Earth<\/title>/);
  assert.match(globeHTML, /<meta name="description" content="[^"]*Atlas of the Curious/);
  assert.match(globeHTML, /the spherical view of Atlas of the Curious/);
  assert.match(globeHTML, /https:\/\/www\.naturalearthdata\.com\/about\/terms-of-use\//);
});

test('navigation preserves strict globe CSP and source text hygiene', () => {
  assert.match(globeHTML, /content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"/);
  assert.doesNotMatch(globeHTML, /\sstyle=|<style\b|<script(?![^>]*\bsrc=)/i);
  for (const source of [tokens, atlasCSS, globeCSS, atlasHTML, globeHTML, sw]) {
    assert.doesNotMatch(source, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
  }
});

test('standalone retains globe identity and resolves the adjacent atlas entry', async () => {
  const { html, output } = await buildStandalone();
  assert.match(html, /<title>Globe · Atlas of the Curious<\/title>/);
  const href = header(html).match(/<a class="brand" href="([^"]+)">/)[1];
  assert.equal(new URL(href, output).href, new URL('index.html', root).href);
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const name of Object.keys(palette)) {
    assert.equal(declarations(style).filter(([, key]) => key === `--${name}`).length, 1, name);
  }
});

test('service worker cache is bumped and includes shared tokens', () => {
  const { CORE, CACHE } = runInNewContext(`${sw}\n({ CORE, CACHE });`, { self: { addEventListener() {} } });
  assert.ok(Number(CACHE.match(/-v(\d+)$/)[1]) >= 7);
  assert.equal(CORE.filter(file => file === '/css/tokens.css').length, 1);
});
