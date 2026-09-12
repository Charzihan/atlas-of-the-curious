import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { root, runtimeGraph } from '../../scripts/earthxt/graph.mjs';

const source = await readFile(new URL('sw.js', root), 'utf8');
test('service worker v10 precaches every globe dependency', async () => {
  const { CORE, CACHE } = runInNewContext(`${source}\n({ CORE, CACHE });`, { self: { addEventListener() {} } });
  assert.equal(CACHE, 'atlas-of-the-curious-v10');
  assert.ok(CORE.includes('/earthxt/'));
  for (const file of (await runtimeGraph()).keys()) assert.ok(CORE.includes(`/${file}`), file);
});

test('offline navigations fall back to the appropriate atlas or globe entry', async () => {
  const handlers = new Map();
  runInNewContext(source, {
    URL,
    self: { location: { origin: 'https://atlas.example' }, addEventListener: (name, callback) => handlers.set(name, callback) },
    fetch: async () => { throw new Error('offline'); },
    caches: { match: async key => typeof key === 'string' ? key : undefined },
  });
  for (const [path, fallback] of [['/earthxt/', '/earthxt/index.html'], ['/earthxt/somewhere', '/earthxt/index.html'], ['/places/test', '/index.html']]) {
    let response;
    handlers.get('fetch')({ request: { method: 'GET', mode: 'navigate', url: `https://atlas.example${path}` }, respondWith: promise => { response = promise; } });
    assert.equal(await response, fallback);
  }
});
