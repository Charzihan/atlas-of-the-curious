/* Outline-only geometry; grid ownership/colour/glyph generation is unchanged.
   GeoJSON polygons stay [exterior, ...holes] until final delta encoding. */
export function ringBox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
}
function ringArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a / 2);
}
function boxGap(a, b) {
  return Math.max(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));
}
// Reject unsplit dateline rings, including the closing edge. Reject the whole
// polygon if a hole crosses too: dropping just that ring would fill in water.
export function crossesAntimeridian(ring) {
  return ring.some((point, i) => Math.abs(point[0] - ring[(i + ring.length - 1) % ring.length][0]) > 180);
}

export function clusterPolygons(polygons, gap = 3.5) {
  const info = polygons.filter(poly => poly.length && !poly.some(crossesAntimeridian))
    .map(poly => ({ poly, area: ringArea(poly[0]), box: ringBox(poly[0]) })).sort((a, b) => b.area - a.area);
  if (!info.length) return [];
  const minArea = Math.max(0.01, info[0].area * 0.003);
  // Large parts are always kept, even far from the largest (e.g. peninsular
  // Malaysia and Alaska). Only small offshore exteriors are cluster-pruned.
  const kept = new Set(info.filter(ring => ring.area >= info[0].area * 0.15));
  let box = [...kept].map(ring => ring.box).reduce(unionBox);
  for (let added = true; added;) {
    added = false;
    for (const ring of info) {
      if (kept.has(ring) || ring.area < minArea || boxGap(box, ring.box) > gap) continue;
      kept.add(ring); box = unionBox(box, ring.box); added = true;
    }
  }
  return [...kept].map(ring => ring.poly);
}

function unionBox(a, b) {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function simplify(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0], py = pts[i][1];
      const d = len < 1e-12 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function encodeRing(pts, units) {
  const out = [];
  let px = 0, py = 0;
  const quantized = [];
  for (const [lon, lat] of pts) {
    const x = Math.round(lon * units), y = Math.round(lat * units);
    if (out.length && x === px && y === py) continue; // quantisation collapsed a step
    quantized.push([x, y]);
    out.push(out.length ? x - px : x, out.length ? y - py : y);
    px = x; py = y;
  }
  return out.length >= 8 && ringArea(quantized) > 0 ? out : null;
}

// Holes are never area-pruned or simplified. If quantisation cannot represent
// a hole, reject its exterior too; never emit an exterior with a missing lake.
export function encodePolygons(polygons, tolerance, units) {
  const rings = [];
  for (const [exterior, ...holes] of polygons) {
    const outer = encodeRing(simplify(exterior, tolerance), units) || encodeRing(exterior, units);
    const inner = holes.map(ring => encodeRing(ring, units));
    if (outer && inner.every(Boolean)) rings.push(outer, ...inner);
  }
  return rings;
}
