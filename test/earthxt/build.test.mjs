import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { root, runtimeGraph, runtimeReferences, resolveReference } from '../../scripts/earthxt/graph.mjs';
import { inlineStyles } from '../../scripts/earthxt/standalone.mjs';
import '../../scripts/earthxt/build.mjs';

const output = new URL('dist/', root);
test('static output contains the whole graph and resolves within dist at a nested base URL', async () => {
  const graph = await runtimeGraph();
  const builtGraph = await runtimeGraph(undefined, output);
  assert.deepEqual([...builtGraph.keys()], [...graph.keys()]);
  for (const required of ['earthxt/app.js', 'earthxt/places.js', 'earthxt/place-layer.js', 'js/data.js', 'js/hover-card.js', 'js/category-colors.js', 'js/map-art.js', 'js/labels.js', 'js/text-route.js', 'js/text.js', 'vendor/pretext/layout.js', 'vendor/pretext/generated/bidi-data.js', 'css/fonts.css']) {
    assert.ok(graph.has(required), required);
  }
  const servedRoot = new URL('https://static.example/project/');
  let compressedBytes = 0;
  for (const [file, { bytes, references }] of graph) {
    assert.deepEqual(builtGraph.get(file).bytes, bytes);
    compressedBytes += gzipSync(bytes).byteLength;
    for (const { reference, dependency } of references) {
      const resolved = new URL(reference, new URL(file, servedRoot));
      assert.ok(resolved.href.startsWith(servedRoot.href), `${file}: ${reference}`);
      assert.equal(resolved.href.slice(servedRoot.href.length), dependency);
      await access(new URL(dependency, output));
    }
  }
  assert.ok(compressedBytes < 1024 * 1024, 'runtime stays under 1 MiB gzip');
  await access(new URL('.nojekyll', output));
  await access(new URL('earthxt/data/README.md', output));
});

test('graph follows multiline imports, parent paths, data URLs, stylesheet links and CSS import chains', async () => {
  const fixture = pathToFileURL(`${await mkdtemp(`${tmpdir()}/earthxt-graph-`)}/`);
  const files = {
    'earthxt/index.html': '<link rel="stylesheet" href="../css/main.css"><script src="../js/data.js"></script><script type="module" src="./app.js"></script>',
    'earthxt/app.js': "import {\n value,\n} from '../js/shared.js';\nconst data = new URL('./data.json', import.meta.url);\n",
    'earthxt/data.json': '{}',
    'js/data.js': 'window.ATLAS_DATA = { places: [1, 2] };',
    'js/shared.js': 'export const value = 1;',
    'css/main.css': '@import url("nested.css");\nbody { color: red; }',
    'css/nested.css': '@import "./fonts.css";\n:root { color: blue; }',
    'css/fonts.css': ':root { --font-mono: Fixture; }',
  };
  try {
    for (const [file, source] of Object.entries(files)) {
      const url = new URL(file, fixture);
      await mkdir(new URL('./', url), { recursive: true });
      await writeFile(url, source);
    }
    const graph = await runtimeGraph(undefined, fixture);
    assert.deepEqual([...graph.keys()].sort(), Object.keys(files).sort());
    const css = inlineStyles(graph, 'css/main.css');
    assert.ok(css.indexOf('--font-mono') < css.indexOf('color: blue'));
    assert.ok(css.indexOf('color: blue') < css.indexOf('color: red'));
    assert.doesNotMatch(css, /@import/);
  } finally { await rm(fixture, { recursive: true }); }
});

test('unsupported module syntax and paths outside the publish root fail loudly', () => {
  for (const source of ["import x from './x.js';", "import('./x.js');", "export { x } from './x.js';"]) {
    assert.throws(() => runtimeReferences('earthxt/app.js', source), /Unsupported module syntax/);
  }
  for (const path of ['../../outside.js', '/js/text.js', 'https://example.com/x.js', '../%2e%2e/x.js']) {
    assert.throws(() => resolveReference('earthxt/app.js', path), /relative runtime path|escapes repository|Unsupported runtime path/);
  }
});
