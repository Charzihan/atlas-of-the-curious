/** Package the existing app into one HTML file that opens without an HTTP server.
 * This small packager supports Earthxt's named, local ES module imports only.
 * It fails on unsupported syntax instead of silently generating a broken app.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = new URL('../../', import.meta.url);
const sourceRoot = new URL('earthxt/', root);

export async function bundleEarthxt(entry = 'app.js') {
  const bundled = new Set(), visiting = new Set(), blocks = [];
  async function visit(filename) {
    if (bundled.has(filename)) return;
    if (visiting.has(filename)) throw new Error(`Circular import: ${filename}`);
    if (!/^[a-z-]+\.js$/.test(filename)) throw new Error(`Unsupported module: ${filename}`);
    visiting.add(filename);
    let source = await readFile(new URL(filename, sourceRoot), 'utf8');
    const imports = [...source.matchAll(/^import\s+\{([^}]+)\}\s+from\s+['"]\.\/([a-z-]+\.js)['"];\s*$/gm)];
    for (const match of imports) {
      const [, names, dependency] = match;
      if (!names.split(',').every(name => /^\s*[A-Za-z_$][\w$]*\s*$/.test(name))) {
        throw new Error(`Only named imports without aliases are supported: ${filename}`);
      }
      await visit(dependency);
      source = source.replace(match[0], `const { ${names.trim()} } = modules[${JSON.stringify(dependency)}];\n`);
    }
    // Data URLs are decoded locally by fetch; opening file:// never needs a
    // server, a cross-origin file read, or permission to make network requests.
    const resources = [...source.matchAll(/new URL\(['"](\.\/data\/[a-z.]+)['"],\s*import\.meta\.url\)/g)];
    for (const match of resources) {
      const bytes = await readFile(new URL(match[1], sourceRoot));
      const mime = match[1].endsWith('.json') ? 'application/json' : 'application/octet-stream';
      source = source.replace(match[0], JSON.stringify(`data:${mime};base64,${bytes.toString('base64')}`));
    }
    const exports = [...source.matchAll(/^export\s+(?:async\s+)?(?:const|class|function)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1]);
    source = source.replace(/^export\s+/gm, '');
    if (/^\s*(?:import|export)\s|\bimport\s*[.(]/m.test(source)) {
      throw new Error(`Unsupported module syntax remains in ${filename}`);
    }
    blocks.push(`modules[${JSON.stringify(filename)}] = (() => {\n${source}\nreturn Object.freeze({ ${exports.join(', ')} });\n})();`);
    visiting.delete(filename);
    bundled.add(filename);
  }
  await visit(entry);
  const script = `(() => {\n'use strict';\nconst modules = Object.create(null);\n${blocks.join('\n')}\nreturn modules[${JSON.stringify(entry)}];\n})();`;
  new Script(script, { filename: 'earthxt-standalone.js' });
  return script;
}

const hash = text => createHash('sha256').update(text).digest('base64');

export async function buildStandalone() {
  const [template, css, bundled] = await Promise.all([
    readFile(new URL('index.html', sourceRoot), 'utf8'),
    readFile(new URL('styles.css', sourceRoot), 'utf8'),
    bundleEarthxt(),
  ]);
  const style = `\n${css}\n`;
  const script = `\n${bundled.replace(/<\/script/gi, '<\\/script')}\n`;
  const policy = `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; img-src data:; connect-src data:; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const html = template
    .replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]+(">)/, `$1${policy}$2`)
    .replace('<link rel="stylesheet" href="./styles.css">', () => `<style>${style}</style>`)
    .replace('<script type="module" src="./app.js"></script>', '')
    .replace('href="./"', 'href="#"')
    .replace('</body>', () => `<script>${script}</script>\n</body>`);
  if (/<script[^>]+src=|<link[^>]+rel="stylesheet"/.test(html)) throw new Error('An external runtime dependency remains.');
  const output = new URL('earthxt-standalone.html', root);
  await writeFile(output, html);
  return { output, html };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { output } = await buildStandalone();
  console.log(`Open this file directly in your browser: ${fileURLToPath(output)}`);
  console.log('No localhost, server, install step, or network connection required.');
}
