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
