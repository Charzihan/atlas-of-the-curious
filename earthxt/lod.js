/** Extend this registry to add regions or local static data providers. */
export const LEVELS = Object.freeze([
  { id: 'planet', index: 0, name: 'Planet', minZoom: 0, sampleDegrees: 1.5, cellWidth: 8, cellHeight: 11, fontSize: 10, land: '#', ocean: '·', description: 'The whole world. A few thousand characters.', targetDistance: 3.2, labels: false, borders: false },
  { id: 'coastlines', index: 1, name: 'Coastlines', minZoom: 0.26, sampleDegrees: 0.5, cellWidth: 7, cellHeight: 10, fontSize: 9, land: '≡', ocean: '~', description: 'Closer coastlines. Islands come into view.', targetDistance: 2.05, labels: false, borders: false },
  { id: 'countries', index: 2, name: 'Countries', minZoom: 0.54, sampleDegrees: 0.25, cellWidth: 6.5, cellHeight: 9, fontSize: 9, land: ':', ocean: '≈', description: 'Borders and names. Another layer of Earth.', targetDistance: 1.4, labels: true, borders: true },
]);

export function selectLOD(zoom, current = null) {
  let index = 0;
  for (let i = 1; i < LEVELS.length; i++) if (zoom >= LEVELS[i].minZoom) index = i;
  // A dead band avoids rapid switching around a threshold during wheel/pinch input.
  if (current && index < current.index && zoom > current.minZoom - 0.018) return current;
  return LEVELS[index];
}
