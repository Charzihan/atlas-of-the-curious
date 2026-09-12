/** Offline file:// edition. Each supported ES module gets its own registry scope;
 * data resources become data URLs and stylesheets are expanded in cascade order.
 * Unsupported syntax and circular module imports fail the build. */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { root, runtimeGraph, moduleImports, moduleResources, declarationExports,
  assertNoModuleSyntax, stylesheetLinks, cssImports, resolveReference, resolveCSSReference } from './graph.mjs';

function bundleModules(graph, entry) {
  const bundled = new Set(), visiting = new Set(), blocks = [];
  function visit(filename) {
    if (bundled.has(filename)) return;
    if (visiting.has(filename)) throw new Error(`Circular import: ${filename}`);
    visiting.add(filename);
    let source = graph.get(filename).bytes.toString('utf8');
    for (const { statement, names, dependency } of moduleImports(source, filename)) {
      visit(dependency);
      const available = new Set(declarationExports(graph.get(dependency).bytes.toString('utf8')).map(match => match[1]));
      for (const name of names) {
        if (!available.has(name)) throw new Error(`Unsupported or missing export ${name} from ${dependency}`);
      }
      source = source.replace(statement, `const { ${names.join(', ')} } = modules[${JSON.stringify(dependency)}];\n`);
    }
    // Data URLs are decoded locally by fetch; file:// needs no file/network reads.
    for (const { statement, dependency } of moduleResources(source, filename)) {
      const bytes = graph.get(dependency).bytes;
      const mime = dependency.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      source = source.replace(statement, JSON.stringify(`data:${mime};base64,${bytes.toString('base64')}`));
    }
    const exports = declarationExports(source);
    for (const match of exports) source = source.replace(match[0], match[0].replace(/^export\s+/, ''));
    assertNoModuleSyntax(source, filename);
    blocks.push(`modules[${JSON.stringify(filename)}] = (() => {\n${source}\nreturn Object.freeze({ ${exports.map(match => match[1]).join(', ')} });\n})();`);
    visiting.delete(filename);
    bundled.add(filename);
  }
  visit(entry);
  const script = `(() => {\n'use strict';\nconst modules = Object.create(null);\n${blocks.join('\n')}\nreturn modules[${JSON.stringify(entry)}];\n})();`;
  new Script(script, { filename: 'earthxt-standalone.js' });
  return script;
}

export async function bundleEarthxt(entry = 'app.js') {
  const filename = resolveReference('earthxt/entry.js', entry.startsWith('.') ? entry : `./${entry}`);
  return bundleModules(await runtimeGraph([filename]), filename);
}

export function inlineStyles(graph, filename, visiting = new Set()) {
  if (visiting.has(filename)) throw new Error(`Circular CSS import: ${filename}`);
  visiting.add(filename);
  let css = graph.get(filename).bytes.toString('utf8');
  for (const { statement, reference } of cssImports(css)) {
    css = css.replace(statement, () => inlineStyles(graph, resolveCSSReference(filename, reference), visiting));
  }
  visiting.delete(filename);
  // No external CSS resources occur in this graph. Fail if one is introduced:
  // leaving a relative URL here would break file:// and the hash-only CSP.
  if (/@import\b|url\(\s*['"]?(?!data:|#)/.test(css)) throw new Error(`Unsupported standalone CSS resource: ${filename}`);
  return css;
}

const hash = text => createHash('sha256').update(text).digest('base64');

export async function buildStandalone() {
  const graph = await runtimeGraph();
  const template = graph.get('earthxt/index.html').bytes.toString('utf8');
  const links = stylesheetLinks(template);
  const css = links.map(link => inlineStyles(graph, resolveReference('earthxt/index.html', link.reference))).join('\n');
  const bundled = bundleModules(graph, 'earthxt/app.js');
  const style = `\n${css}\n`;
  const script = `\n${bundled.replace(/<\/script/gi, '<\\/script')}\n`;
  const policy = `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; img-src data:; connect-src data:; object-src 'none'; base-uri 'none'; form-action 'none'`;
  let html = template.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]+(">)/, `$1${policy}$2`);
  for (const [index, link] of links.entries()) html = html.replace(link.statement, () => index === 0 ? `<style>${style}</style>` : '');
  html = html.replace('<script type="module" src="./app.js"></script>', '')
    // The generated file lives beside the atlas entry, one level above the globe.
    .replace('href="../"', 'href="./index.html"')
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
