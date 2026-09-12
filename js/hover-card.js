/* Shared hover-card tagline composition. Callers supply cached metrics and
 * cache the result; widening the card never changes these baked line breaks. */
export function fitHoverTagline(text, { maxWidth, minWidth, linesOfText, tightWidthOfText, maxLines = 4 }) {
  const linesAt = width => linesOfText(text, width).map(line => line.trimEnd()).filter(Boolean);
  if (!tightWidthOfText) return { width: maxWidth, lines: linesAt(maxWidth) };
  let width = tightWidthOfText(text, maxWidth), lines = linesAt(width);
  const widow = value => value.length >= 2 && !/\s/.test(value[value.length - 1].trim());
  if (widow(lines)) {
    let found;
    for (let w = width - 3; w >= minWidth && !found; w -= 3) {
      const candidate = linesAt(w);
      if (candidate.length > maxLines) break;
      if (!widow(candidate)) found = { width: w, lines: candidate };
    }
    for (let w = width + 3; w <= maxWidth && !found; w += 3) {
      const candidate = linesAt(w);
      if (!widow(candidate)) found = { width: w, lines: candidate };
    }
    if (found) ({ width, lines } = found);
  }
  return { width, lines };
}
