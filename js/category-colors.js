/* Canvas needs resolved colours; DOM consumers can use the same tokens. */
export function readCategoryColors(doc, categories) {
  const css = doc.defaultView.getComputedStyle(doc.documentElement);
  const fallback = css.getPropertyValue('--gold').trim();
  return new Map(categories.map(category => [category.id,
    css.getPropertyValue(`--category-${category.id}`).trim() || fallback]));
}

/* Continent land colours (--continent-<name>), in the order given, as hex. */
export function readContinentColors(doc, continents) {
  const css = doc.defaultView.getComputedStyle(doc.documentElement);
  return continents.map(name =>
    css.getPropertyValue(`--continent-${name.toLowerCase().replace(/\s+/g, '-')}`).trim() || '#d0a05a');
}

/* One text glyph per category, so a marker and its legend entry say the
   category in shape as well as colour (both projections and the legend). */
export const CATEGORY_GLYPHS = Object.freeze({
  geology: '▲', coastal: '≈', desert: '∴', forest: '♣', glacier: '❄', sacred: '✧', urban: '■'
});
export const categoryGlyph = id => CATEGORY_GLYPHS[id] || '•';
