import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import '../../scripts/earthxt/build.mjs';

const root = new URL('../../', import.meta.url);
const output = new URL('dist/earthxt/', root);
test('static output contains exact local assets and works at a nested base URL', async () => {
  const files = ['index.html', 'styles.css', 'app.js', 'geometry.js', 'geography.js', 'lod.js', 'renderer.js', 'data/world.bin', 'data/world.json'];
  const servedRoot = new URL('https://static.example/project/earthxt/');
  let compressedBytes = 0;
  for (const file of files) {
    const built = await readFile(new URL(file, output));
    assert.deepEqual(built, await readFile(new URL(`earthxt/${file}`, root)));
    compressedBytes += gzipSync(built).byteLength;
    if (!file.endsWith('.js')) continue;
    const text = built.toString('utf8');
    const references = [...text.matchAll(/from\s+['"]([^'"]+)['"]|new URL\(['"]([^'"]+)['"],\s*import.meta.url\)/g)].map(match => match[1] ?? match[2]);
    for (const reference of references) {
      assert.ok(reference.startsWith('./'));
      const resolved = new URL(reference, new URL(file, servedRoot));
      assert.ok(resolved.href.startsWith(servedRoot.href));
      await access(new URL(resolved.href.slice(servedRoot.href.length), output));
    }
  }
  const html = await readFile(new URL('index.html', output), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="(\.\/[^\"]+)"/g)) await access(new URL(match[1], output));
  assert.ok(!/<script[^>]+src="https?:/i.test(html));
  assert.ok(!/@import\s+url\(https?:/i.test(await readFile(new URL('styles.css', output), 'utf8')));
  assert.ok(compressedBytes < 1024 * 1024, 'entire runtime payload stays under 1 MiB gzip');
  await access(new URL('.nojekyll', output));
  await access(new URL('data/README.md', output));
});
