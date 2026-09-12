import { readFile } from 'node:fs/promises';

export const registryCSS = await readFile(new URL('../../css/fonts.css', import.meta.url), 'utf8');
// Model computed custom properties for Node tests, including recursive var().
// Actual browser font selection/layout remains the browser smoke suite's job.
export function registryDocument(css = registryCSS) {
  const properties = new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2]]));
  const value = name => (properties.get(name) ?? '').replace(/var\((--[\w-]+)\)/g, (_, ref) => value(ref));
  const style = { fontSize: '16px', getPropertyValue: value };
  return { documentElement: {}, defaultView: { getComputedStyle: () => style } };
}
