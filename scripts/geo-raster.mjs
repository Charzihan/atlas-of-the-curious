/** Shared Natural Earth rasterization, with each consumer's ownership rules intact.
 * parseCountries preserves first key appearance (feature order by default), groups
 * rings with geographic bounds, and retains polygon boundaries for scanline fill.
 * countryAt uses even-odd parity across a country's rings; first matching key wins.
 * classifyCell samples row-major at (s + 0.5) / samples, applies the hit threshold,
 * and returns the LAST hit's key, not the most frequent country (null for water).
 * scanlineOwnership fills polygon interiors at pixel centres, holes included;
 * later countries overwrite earlier ones, with byte IDs = iteration index + 1.
 * These paths deliberately retain their original floating-point operation order.
 */

export function parseCountries(features, keyForFeature = (_feature, index) => index + 1) {
  const countries = new Map();
  features.forEach((feature, index) => {
    const key = keyForFeature(feature, index);
    let country = countries.get(key);
    if (!country) {
      country = { rings: [], polygons: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      countries.set(key, country);
    }
    const geometry = feature.geometry;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      const rings = polygon.map(pts => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [lon, lat] of pts) {
          if (lon < minX) minX = lon; if (lon > maxX) maxX = lon;
          if (lat < minY) minY = lat; if (lat > maxY) maxY = lat;
        }
        return { pts, minX, minY, maxX, maxY };
      });
      for (const ring of rings) {
        country.minX = Math.min(country.minX, ring.minX);
        country.minY = Math.min(country.minY, ring.minY);
        country.maxX = Math.max(country.maxX, ring.maxX);
        country.maxY = Math.max(country.maxY, ring.maxY);
      }
      country.rings.push(...rings);
      country.polygons.push(rings);
    }
  });
  return countries;
}

export function countryAt(countries, lon, lat) {
  for (const [key, country] of countries) {
    // The union bounds enclose every ring: outside them parity is always even.
    if (lon < country.minX || lon > country.maxX || lat < country.minY || lat > country.maxY) continue;
    let odd = false;
    for (const r of country.rings) {
      if (lon < r.minX || lon > r.maxX || lat < r.minY || lat > r.maxY) continue;
      const pts = r.pts;
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        const xi = pts[a][0], yi = pts[a][1];
        const xj = pts[b][0], yj = pts[b][1];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) odd = !odd;
      }
    }
    if (odd) return key;
  }
  return null;
}

export function classifyCell(countries, col, row, cols, rows, samples, threshold) {
  let hits = 0;
  let key = null;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const fx = (sx + 0.5) / samples;
      const fy = (sy + 0.5) / samples;
      const lon = -180 + ((col + fx) / cols) * 360;
      const lat = 90 - ((row + fy) / rows) * 180;
      const at = countryAt(countries, lon, lat);
      if (at) { hits++; key = at; }
    }
  }
  return hits >= threshold && key ? key : null;
}

export function scanlineOwnership(countries, width, height) {
  if (countries.size > 255) throw new Error('Ownership encoding supports at most 255 countries.');
  const raster = new Uint8Array(width * height);
  let id = 0;
  for (const country of countries.values()) {
    id++;
    for (const polygon of country.polygons) {
      const rings = polygon.map(ring => ring.pts.map(([lon, lat]) => [(lon + 180) / 360 * width, (90 - lat) / 180 * height]));
      let minY = height, maxY = 0;
      for (const ring of rings) for (const [, y] of ring) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      for (let row = Math.max(0, Math.floor(minY)); row < Math.min(height, Math.ceil(maxY)); row++) {
        const scan = row + 0.5, crossings = [];
        for (const ring of rings) {
          for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
            const [ax, ay] = ring[a], [bx, by] = ring[b];
            if ((ay > scan) !== (by > scan)) crossings.push(ax + (scan - ay) * (bx - ax) / (by - ay));
          }
        }
        crossings.sort((a, b) => a - b);
        for (let i = 0; i + 1 < crossings.length; i += 2) {
          const start = Math.max(0, Math.ceil(crossings[i] - 0.5));
          const end = Math.min(width, Math.ceil(crossings[i + 1] - 0.5));
          if (start < end) raster.fill(id, row * width + start, row * width + end);
        }
      }
    }
  }
  return raster;
}
