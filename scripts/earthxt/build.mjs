/** Publish all of dist/; the globe entry is earthxt/index.html. */
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { root, runtimeGraph } from './graph.mjs';

const output = new URL('dist/', root);
const graph = await runtimeGraph();
let rawBytes = 0, compressedBytes = 0;
for (const [file, { bytes }] of graph) {
  const destination = new URL(file, output);
  await mkdir(new URL('./', destination), { recursive: true });
  await writeFile(destination, bytes);
  rawBytes += bytes.byteLength;
  compressedBytes += gzipSync(bytes).byteLength;
}
await writeFile(new URL('.nojekyll', output), '');
await cp(new URL('earthxt/data/README.md', root), new URL('earthxt/data/README.md', output));
console.log(`Static Earthxt build: ${output.pathname} (entry: earthxt/)`);
console.log(`${graph.size} runtime files · ${(rawBytes / 1024 / 1024).toFixed(2)} MiB raw · ${(compressedBytes / 1024).toFixed(1)} KiB with gzip`);
console.log('Publish the whole dist/ directory at any static-host root or subpath; open earthxt/.');
