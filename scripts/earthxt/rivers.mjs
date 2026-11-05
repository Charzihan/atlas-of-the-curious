/** Build-time river rasterization for the globe.
 * Source: Natural Earth 1:50m rivers and lake centrelines (public domain).
 * Each line is walked in steps of a quarter cell; every cell it crosses
 * records the most important river through it (Natural Earth's scalerank,
 * 1 = largest) and that river's direction there, so the globe can draw the
 * course with line glyphs. Encoding (one byte; 0 = no river):
 *   bits 0–3  scalerank (1–15)
 *   bits 4–5  direction: 0 east–west, 1 north–south, 2 rising (/), 3 falling (\)
 */

/** Direction of a step on the map, judged as drawn: longitude shrinks with latitude. */
export function riverDirection(dLon, dLat, latitude) {
  const dx = dLon * Math.cos(latitude * Math.PI / 180), dy = dLat;
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (angle < 0) angle += 180;
  if (angle < 22.5 || angle >= 157.5) return 0;
  if (angle >= 67.5 && angle < 112.5) return 1;
  return angle < 90 ? 2 : 3;
}

export function rasterizeRivers(features, width, height) {
  const out = new Uint8Array(width * height);
  const cellDegrees = 360 / width;
  const cellOf = (lon, lat) => {
    const col = ((Math.floor((lon + 180) / 360 * width) % width) + width) % width;
    const row = Math.min(height - 1, Math.max(0, Math.floor((90 - lat) / 180 * height)));
    return row * width + col;
  };
  for (const feature of features) {
    const rank = Math.min(15, Math.max(1, Math.round(feature.properties.scalerank ?? 15)));
    const geometry = feature.geometry;
    if (!geometry) continue;
    const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
    for (const line of lines) {
      // The ordered cells the line passes through (walked in quarter-cell steps).
      const path = [];
      for (let i = 1; i < line.length; i++) {
        const [lon0, lat0] = line[i - 1], [lon1, lat1] = line[i];
        let dLon = lon1 - lon0;
        if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
        const dLat = lat1 - lat0;
        const steps = Math.max(1, Math.ceil(Math.hypot(dLon, dLat) / (cellDegrees / 4)));
        for (let step = i === 1 ? 0 : 1; step <= steps; step++) {
          const cell = cellOf(lon0 + dLon * step / steps, lat0 + dLat * step / steps);
          if (path[path.length - 1] !== cell) path.push(cell);
        }
      }
      // Each cell's glyph follows the course two cells either side of it, so a
      // river reads as a line rather than a scribble of single-cell turns.
      for (let i = 0; i < path.length; i++) {
        const cell = path[i], current = out[cell] & 15;
        if (current && current <= rank) continue;
        const from = path[Math.max(0, i - 2)], to = path[Math.min(path.length - 1, i + 2)];
        const row = Math.floor(cell / width);
        let dCol = to % width - from % width;
        if (dCol > width / 2) dCol -= width; else if (dCol < -width / 2) dCol += width;
        const dRow = Math.floor(to / width) - Math.floor(from / width);
        const latitude = 90 - (row + 0.5) * 180 / height;
        out[cell] = rank | riverDirection(dCol, -dRow, latitude) << 4;
      }
    }
  }
  return out;
}
