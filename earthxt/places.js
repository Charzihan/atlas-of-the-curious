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

export function projectPlaces(places, camera, viewport, grid, out = []) {
  const view = { ...camera, basis: cameraBasis(camera.latitude, camera.longitude) };
  for (let i = 0; i < places.length; i++) {
    const place = places[i], point = project(place.point, view, viewport, out[i] ||= {});
    point.id = place.id;
    point.visible = point.visible && point.x >= 12 && point.x < viewport.width - 12 && point.y >= 12 && point.y < viewport.height - 12;
    point.col = Math.floor((point.x - grid.x) / grid.cellWidth);
    point.row = Math.floor((point.y - grid.y) / grid.cellHeight);
  }
  out.length = places.length;
  return out;
}

// Every rendered frame routes against the current land/off-disc mask. Previous
// candidates follow their markers and claim still-free cells before searches
// for replacements, so rotation neither drops stale labels nor flips sides.
export function createPlaceRouter(places, role) {
  const engine = createLabelEngine();
  engine.setRoles({ 'map-label': role });
  const routingPlaces = places.map(place => ({ id: place.id, name: place.name, col: 0, row: 0 }));
  const byId = new Map(routingPlaces.map(place => [place.id, place]));
  engine.setPlaces(routingPlaces);
  engine.preparePlaces();
  const preferred = new Map(), visible = [], markerCells = new Set();
  const output = { labels: [], oceans: [] };
  const result = { labels: output.labels, markerCells, placeLabelMs: 0 };
  let signature = null, passes = 0;
  function update(camera, level, viewport, grid, blocked, markers, enabled) {
    visible.length = 0;
    markerCells.clear();
    const dotCells = 1;
    for (const marker of markers) {
      if (!marker.visible) continue;
      visible.push(marker.id);
      const place = byId.get(marker.id);
      place.col = marker.col; place.row = marker.row;
      for (let dr = -dotCells; dr <= dotCells; dr++) for (let dc = -dotCells; dc <= dotCells; dc++) {
        const col = marker.col + dc, row = marker.row + dr;
        if (col >= 0 && col < grid.cols && row >= 0 && row < grid.rows) markerCells.add(row * grid.cols + col);
      }
    }
    if (!enabled || level.index < 1 || !visible.length) {
      signature = null; preferred.clear();
      output.labels.length = 0;
      result.placeLabelMs = 0;
      return result;
    }
    const start = performance.now();
    const nextSignature = `${level.index}/${grid.cols}/${grid.rows}/${grid.cellWidth}/${grid.cellHeight}`;
    if (signature !== nextSignature) preferred.clear();
    signature = nextSignature;
    engine.setGrid({ cols: grid.cols, rows: grid.rows, land: blocked,
      rowSpan: Math.ceil(role.lineHeight / grid.cellHeight), maxOffset: 12 });
    const labels = engine.place({ tier: 1, zoom: 1, cellW: grid.cellWidth, dotCells,
      visible, oceanOn: false, preferred, output }).labels;
    preferred.clear();
    for (const rec of labels) preferred.set(rec.id, rec);
    passes++;
    result.placeLabelMs = performance.now() - start;
    return result;
  }
  // Results are live until update(); take a copy for history or inspection.
  return { update, passes: () => passes, preparationCount: engine.preparationCount };
}
