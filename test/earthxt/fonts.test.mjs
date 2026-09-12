import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { readFontRoles, readFontFamily, ROLE_NAMES } from '../../js/text.js';
import { registryCSS, registryDocument } from './fonts-fixture.mjs';

const root = new URL('../../', import.meta.url);
test('atlas and globe share one complete CSS font registry', async () => {
  const roles = readFontRoles(registryDocument());
  assert.deepEqual(Object.keys(roles), ROLE_NAMES);
  for (const role of ROLE_NAMES) {
    for (const prefix of ['font', 'lh', 'ls']) assert.match(registryCSS, new RegExp(`--${prefix}-${role}:`));
  }
  const label = roles['globe-label'];
  assert.equal(label.font, `normal 10px ${readFontFamily(registryDocument(), '--font-mono')}`);
  assert.equal(label.lineHeight, 10);
  assert.equal(label.letterSpacing, 0.5);
  const atlas = await readFile(new URL('css/style.css', root), 'utf8');
  assert.ok(atlas.startsWith('@import url("fonts.css");'));
  assert.doesNotMatch(atlas, /--(?:font|lh|ls)-[\w-]+\s*:/);
  const globe = await readFile(new URL('earthxt/styles.css', root), 'utf8');
  assert.match(globe, /--mono:\s*var\(--font-mono\)/);
  const rule = globe.match(/\.country-label\{([^}]+)\}/)[1];
  for (const prefix of ['font', 'lh', 'ls']) assert.ok(rule.includes(`var(--${prefix}-globe-label)`));
  assert.match(rule, /text-transform:uppercase/);
  const html = await readFile(new URL('earthxt/index.html', root), 'utf8');
  assert.ok(html.indexOf('../css/fonts.css') < html.indexOf('./styles.css'));
});

test('Earthxt JavaScript contains no font family literals or frame-time measurement', async () => {
  const families = ['serif', 'sans-serif', 'monospace', 'ui-monospace', 'Arial', 'Helvetica'];
  for (const match of registryCSS.matchAll(/--font-(?:mono|serif|sans):([^;]+);/g)) {
    families.push(...match[1].split(',').map(name => name.trim().replaceAll('"', '')));
  }
  for (const file of await readdir(new URL('earthxt/', root))) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(new URL(`earthxt/${file}`, root), 'utf8');
    for (const family of families) {
      const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match whole family names, including inside CSS shorthands/stacks,
      // without mistaking a hyphenated control id for a font family value.
      assert.doesNotMatch(source, new RegExp(`['"\x60][^'"\x60\\n]*(?<![\\w-])${escaped}(?![\\w-])[^'"\x60\\n]*['"\x60]`, 'i'), file);
    }
    if (file === 'renderer.js') {
      // Canvas ink bounds are needed at preparation, but advances still come
      // from pretext. The recorder separately counts both kinds of measurement.
      assert.doesNotMatch(source.slice(source.indexOf('  draw(camera')), /\.measureText\(|prepareFlowText\(/, file);
    } else assert.doesNotMatch(source, /\.measureText\(/, file);
  }
});
