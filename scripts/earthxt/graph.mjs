/** Static runtime graph shared by both packagers. The module transformer supports
 * the named imports and declaration exports used by Earthxt and vendored pretext,
 * and rejects unsupported syntax rather than silently omitting dependencies. */
import { readFile } from 'node:fs/promises';

export const root = new URL('../../', import.meta.url);
const origin = new URL('https://earthxt.invalid/');

export function resolveReference(file, reference) {
  if (!reference.startsWith('./') && !reference.startsWith('../')) {
    throw new Error(`Expected a relative runtime path in ${file}: ${reference}`);
  }
  // URL resolution clamps excess .. segments: check those before resolving.
  const parts = file.split('/').slice(0, -1);
  for (const part of reference.split('/')) {
    if (part === '..') {
      if (!parts.length) throw new Error(`Runtime path escapes repository: ${file}: ${reference}`);
      parts.pop();
    } else if (part !== '.' && part) parts.push(part);
  }
  if (/[?#%\\]/.test(reference)) throw new Error(`Unsupported runtime path: ${reference}`);
  return new URL(reference, new URL(file, origin)).pathname.slice(1);
}

export function moduleImports(source, file) {
  const matches = [...source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];[ \t]*(?:\r?\n|$)/gm)];
  return matches.map(match => {
    const names = match[1].trim().replace(/,\s*$/, '').split(',').map(name => name.trim());
    if (!names.every(name => /^[A-Za-z_$][\w$]*$/.test(name))) {
      throw new Error(`Unsupported named import in ${file}: ${match[0]}`);
    }
    const dependency = resolveReference(file, match[2]);
    if (!dependency.endsWith('.js')) throw new Error(`Unsupported module: ${dependency}`);
    return { statement: match[0], names, reference: match[2], dependency };
  });
}

export function moduleResources(source, file) {
  return [...source.matchAll(/new URL\(['"]([^'"]+)['"],\s*import\.meta\.url\)/g)]
    .map(match => ({ statement: match[0], reference: match[1], dependency: resolveReference(file, match[1]) }));
}

export function assertNoModuleSyntax(source, file) {
  if (/^\s*(?:import|export)\s|\bimport\s*[.(]/m.test(source)) {
    throw new Error(`Unsupported module syntax remains in ${file}`);
  }
}

export function declarationExports(source) {
  return [...source.matchAll(/^export\s+(?:async\s+)?(?:const|class|function)\s+([A-Za-z_$][\w$]*)/gm)];
}

export function stylesheetLinks(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)].filter(match => /\brel=['"]stylesheet['"]/.test(match[0]))
    .map(match => ({ statement: match[0], reference: match[0].match(/\bhref=['"]([^'"]+)['"]/)?.[1] }));
}

export function scriptLinks(html) {
  return [...html.matchAll(/<script\b[^>]*>\s*<\/script\s*>/gi)]
    .filter(match => /\bsrc=['"]/.test(match[0]))
    .map(match => ({ statement: match[0], reference: match[0].match(/\bsrc=['"]([^'"]+)['"]/)?.[1],
      type: match[0].match(/\btype=['"]([^'"]+)['"]/)?.[1] || 'classic' }));
}

export function cssImports(css) {
  return [...css.matchAll(/@import\s+(?:url\(\s*['"]?([^'"\s)]+)['"]?\s*\)|['"]([^'"]+)['"])\s*;/g)]
    .map(match => ({ statement: match[0], reference: match[1] ?? match[2] }));
}

export function resolveCSSReference(file, reference) {
  return resolveReference(file, reference.startsWith('.') || reference.startsWith('/') || reference.includes(':') ? reference : `./${reference}`);
}

export function runtimeReferences(file, source) {
  if (file.endsWith('.js')) {
    const imports = moduleImports(source, file), resources = moduleResources(source, file);
    let remaining = source;
    for (const item of [...imports, ...resources]) remaining = remaining.replace(item.statement, '');
    for (const match of declarationExports(remaining)) remaining = remaining.replace(match[0], match[0].replace(/^export\s+/, ''));
    assertNoModuleSyntax(remaining, file);
    return [...imports, ...resources];
  }
  if (file.endsWith('.html')) {
    const links = stylesheetLinks(source);
    const scripts = scriptLinks(source);
    return [...links, ...scripts].map(item => ({ ...item, dependency: resolveReference(file, item.reference) }));
  }
  if (file.endsWith('.css')) {
    const imports = cssImports(source);
    let remaining = source;
    for (const item of imports) remaining = remaining.replace(item.statement, '');
    if (/@import\b/.test(remaining)) throw new Error(`Unsupported CSS import in ${file}`);
    const resources = [...remaining.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)]
      .map(match => ({ reference: match[1] })).filter(item => !/^(data:|#)/.test(item.reference));
    return [...imports, ...resources].map(item => ({ ...item, dependency: resolveCSSReference(file, item.reference) }));
  }
  return [];
}

export async function runtimeGraph(entries = ['earthxt/index.html', 'earthxt/app.js'], sourceRoot = root) {
  const graph = new Map();
  async function visit(file) {
    if (graph.has(file)) return;
    const bytes = await readFile(new URL(file, sourceRoot));
    const references = runtimeReferences(file, bytes.toString('utf8'));
    graph.set(file, { bytes, references });
    for (const { dependency } of references) await visit(dependency);
  }
  for (const file of entries) {
    resolveReference('entry', `./${file}`);
    await visit(file);
  }
  return graph;
}
