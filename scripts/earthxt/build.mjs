/** Publish dist/earthxt/ at any static-host root or subdirectory. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
const root = new URL('../../', import.meta.url);
const output = new URL('dist/earthxt/', root);
const files = ['index.html', 'styles.css', 'app.js', 'geometry.js', 'geography.js', 'lod.js', 'renderer.js', 'data/world.bin', 'data/world.json'];
await mkdir(output, { recursive: true });
let rawBytes = 0, compressedBytes = 0;
for (const file of files) {
  const source = new URL(`earthxt/${file}`, root);
  const bytes = await readFile(source);
  rawBytes += bytes.byteLength;
  compressedBytes += gzipSync(bytes).byteLength;
  await cp(source, new URL(file, output), { recursive: true });
}
await writeFile(new URL('.nojekyll', output), '');
await cp(new URL('earthxt/data/README.md', root), new URL('data/README.md', output));
console.log(`Static Earthxt build: ${output.pathname}`);
console.log(`${files.length} runtime files · ${(rawBytes / 1024 / 1024).toFixed(2)} MiB raw · ${(compressedBytes / 1024).toFixed(1)} KiB with gzip`);
console.log('Serve this folder with any static HTTP host. No backend or install step is needed in production.');
