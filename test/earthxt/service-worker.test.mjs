import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { root, runtimeGraph } from '../../scripts/earthxt/graph.mjs';

const source = await readFile(new URL('sw.js', root), 'utf8');
test('service worker precaches every globe dependency', async () => {
  const { CORE, CACHE } = runInNewContext(`${source}\n({ CORE, CACHE });`, { self: { addEventListener() {} } });
  assert.equal(CACHE, 'atlas-of-the-curious-v17');
  assert.ok(CORE.includes('/earthxt/'));
  for (const file of (await runtimeGraph()).keys()) assert.ok(CORE.includes(`/${file}`), file);
});

function worker({ scope, fetch }) {
  const handlers = new Map(), cached = [];
  runInNewContext(source, {
    URL, Request,
    self: { location: { origin: 'https://atlas.example' }, registration: scope && { scope },
      addEventListener: (name, callback) => handlers.set(name, callback), skipWaiting() {} },
    fetch,
    caches: { match: async key => typeof key === 'string' ? key : undefined,
      open: async () => ({ addAll: async requests => { cached.push(...requests); }, add: async () => {}, put: async () => {} }) },
  });
  return { handlers, cached };
}

test('offline navigations fall back to the appropriate atlas or globe entry, at the root and under a subpath', async () => {
  for (const [base, scope] of [['https://atlas.example', undefined], ['https://atlas.example/atlas-of-the-curious', 'https://atlas.example/atlas-of-the-curious/']]) {
    const { handlers } = worker({ scope, fetch: async () => { throw new Error('offline'); } });
    for (const [path, fallback] of [['/earthxt/', '/earthxt/index.html'], ['/earthxt/somewhere', '/earthxt/index.html'], ['/places/test', '/index.html']]) {
      let response;
      handlers.get('fetch')({ request: { method: 'GET', mode: 'navigate', url: `${base}${path}` }, respondWith: promise => { response = promise; } });
      assert.equal(await response, `${base}${fallback}`);
    }
  }
});

test('precache and runtime fills bypass the HTTP cache and stay inside the scope', async () => {
  const fetched = [];
  const { handlers, cached } = worker({ scope: 'https://atlas.example/atlas-of-the-curious/',
    fetch: async request => { fetched.push(request); return { clone() { return this; } }; } });
  await new Promise(resolve => handlers.get('install')({ waitUntil: promise => promise.then(resolve) }));
  assert.ok(cached.length > 40);
  for (const request of cached) {
    assert.equal(request.cache, 'no-cache');
    assert.ok(request.url.startsWith('https://atlas.example/atlas-of-the-curious/'), request.url);
  }
  assert.ok(cached.some(request => request.url.endsWith('/atlas-of-the-curious/earthxt/data/world.bin')));
  let response;
  const asset = new Request('https://atlas.example/atlas-of-the-curious/earthxt/data/world.json');
  handlers.get('fetch')({ request: asset, respondWith: promise => { response = promise; } });
  await response;
  assert.equal(fetched.at(-1).cache, 'no-cache');
  assert.equal(fetched.at(-1).url, asset.url);
});
