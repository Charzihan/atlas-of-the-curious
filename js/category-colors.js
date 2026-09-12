/* Canvas needs resolved colours; DOM consumers can use the same tokens. */
export function readCategoryColors(doc, categories) {
  const css = doc.defaultView.getComputedStyle(doc.documentElement);
  const fallback = css.getPropertyValue('--gold').trim();
  return new Map(categories.map(category => [category.id,
    css.getPropertyValue(`--category-${category.id}`).trim() || fallback]));
}
