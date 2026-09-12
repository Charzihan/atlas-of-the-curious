import { createLabelEngine } from '../js/labels.js';
import { cameraBasis, latLonToCartesian, project } from './geometry.js';

export function parsePlaceHash(hash) {
  const match = /^#\/place\/([^/]+)$/.exec(hash || '');
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? id : null;
  } catch { return null; }
}

export function globePlaces(places) {
  return places.map(place => {
    const match = /(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])[\s,]+(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])/.exec(place.coordinates);
    if (!match) throw new Error(`Invalid atlas coordinates: ${place.id}`);
    const latitude = Number(match[1]) * (match[2].toUpperCase() === 'S' ? -1 : 1);
    const longitude = Number(match[3]) * (match[4].toUpperCase() === 'W' ? -1 : 1);
    return { ...place, latitude, longitude, point: latLonToCartesian(latitude, longitude) };
  });
}

export function projectPlaces(places, camera, viewport, grid) {
  const view = { ...camera, basis: cameraBasis(camera.latitude, camera.longitude) };
  return places.map(place => {
    const point = project(place.point, view, viewport);
    return { id: place.id, ...point,
      visible: point.visible && point.x >= 12 && point.x < viewport.width - 12 && point.y >= 12 && point.y < viewport.height - 12,
      col: Math.floor((point.x - grid.x) / grid.cellWidth), row: Math.floor((point.y - grid.y) / grid.cellHeight) };
  });
}

// Every rendered frame routes against the current land/off-disc mask. Previous
// candidates follow their markers and claim still-free cells before searches
// for replacements, so rotation neither drops stale labels nor flips sides.
export function createPlaceRouter(places, role) {
  const engine = createLabelEngine();
  engine.setRoles({ 'map-label': role });
  engine.setPlaces(places.map(place => ({ id: place.id, name: place.name, col: 0, row: 0 })));
  engine.preparePlaces();
  let signature = null, preferred = new Map(), passes = 0;
  function update(camera, level, viewport, grid, blocked, markers, enabled) {
    const visible = markers.filter(marker => marker.visible);
    const dotCells = 1;
    const markerCells = new Set();
    for (const marker of visible) for (let dr = -dotCells; dr <= dotCells; dr++) for (let dc = -dotCells; dc <= dotCells; dc++) {
      const col = marker.col + dc, row = marker.row + dr;
      if (col >= 0 && col < grid.cols && row >= 0 && row < grid.rows) markerCells.add(row * grid.cols + col);
    }
    if (!enabled || level.index < 1 || !visible.length) {
      signature = null; preferred.clear();
      return { labels: [], markerCells, placeLabelMs: 0 };
    }
    const start = performance.now();
    const nextSignature = [level.index, grid.cols, grid.rows, grid.cellWidth, grid.cellHeight].join('/');
    if (signature !== nextSignature) preferred.clear();
    signature = nextSignature;
    engine.setGrid({ cols: grid.cols, rows: grid.rows, land: blocked,
      rowSpan: Math.ceil(role.lineHeight / grid.cellHeight), maxOffset: 12 });
    engine.setMarkerCells(Object.fromEntries(visible.map(marker => [marker.id, [marker.col, marker.row]])));
    const labels = engine.place({ tier: 1, zoom: 1, cellW: grid.cellWidth, dotCells,
      visible: visible.map(marker => marker.id), oceanOn: false, preferred }).labels;
    preferred = new Map(labels.map(rec => [rec.id, rec]));
    passes++;
    return { labels, markerCells, placeLabelMs: performance.now() - start };
  }
  return { update, passes: () => passes };
}
