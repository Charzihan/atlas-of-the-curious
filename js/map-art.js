/* Pure worker-side geometry for country stories, great-circle notes and
   proportional map ink. Pixel units always refer to the unzoomed map. */
import { prepareWithSegments, layoutNextLineRange, materializeLineRange } from '../vendor/pretext/layout.js';

export function createMapArtEngine() {
  const cache = new Map();
  function prepare(text, font) {
    const key = font + '\n' + text;
    if (!cache.has(key)) cache.set(key, prepareWithSegments(text, font));
    return cache.get(key);
  }
  function flow(text, font, slots) {
    const pre = prepare(text, font);
    let cursor = { segmentIndex: 0, graphemeIndex: 0 };
    const lines = [];
    for (const slot of slots) {
      if (slot.width < 20) continue;
      const range = layoutNextLineRange(pre, cursor, slot.width);
      if (!range) break;
      const line = materializeLineRange(pre, range);
      if (line.width > slot.width + 0.01) continue;
      lines.push({ ...slot, text: line.text, width: line.width });
      cursor = range.end;
    }
    return { lines, complete: layoutNextLineRange(pre, cursor, 1e7) === null };
  }
  function country(req) {
    const { cols, rows, countries, codes, charW, lineH, text, family } = req;
    const w = cols * charW, h = rows * lineH;
    for (const size of [9, 8, 7, 6]) {
      const lh = size + 2;
      const font = size + 'px ' + family;
      const slots = [];
      for (let y = 0; y + lh <= h; y += lh) {
        const r0 = Math.floor(y / lineH), r1 = Math.floor((y + lh - 0.01) / lineH);
        let c = 0;
        const inside = c => {
          for (let r = r0; r <= r1; r++) if (!codes.includes(countries[r * cols + c])) return false;
          return true;
        };
        while (c < cols) {
          if (!inside(c)) { c++; continue; }
          const start = c;
          while (c < cols && inside(c)) c++;
          if (c - start >= 3) slots.push({ x: start * charW + 1, y: y + 1, width: (c - start) * charW - 2, height: lh });
        }
      }
      const shaped = flow(text, font, slots);
      if (shaped.complete && shaped.lines.length) return { ...shaped, font, mode: 'country', id: req.id };
    }
    // A small silhouette cannot hold a whole story legibly. A regional inset
    // keeps all the words at a readable size, anchored near the place.
    const width = Math.min(460, w - 24);
    const insetFont = '12px ' + family;
    const trial = flow(text, insetFont, Array.from({ length: 100 }, (_, i) => ({ x: 0, y: i * 16, width: width - 24, height: 16 })));
    const height = trial.lines.length * 16 + 24;
    if (height > h - 24) return { complete: true, lines: [], font: insetFont, mode: "caption", id: req.id, text };
    const x = Math.max(12, Math.min(w - width - 12, req.col * charW - width / 2));
    let y = Math.max(12, Math.min(h - height - 12, req.row * lineH + lineH));
    // Keep western insets below the map introduction at the base view.
    if (w > 640 && x < 440) y = Math.max(y, Math.min(320, h - height - 12));
    return { ...trial, lines: trial.lines.map(l => ({ ...l, x: l.x + x + 12, y: l.y + y + 12 })), font: insetFont, mode: 'region', id: req.id, box: { x, y, width, height } };
  }
  function route(req) {
    const { from, to, charW, lineH, cols, rows, occupancy, text, family } = req;
    const w = cols * charW, h = rows * lineH;
    const rad = Math.PI / 180;
    const vector = p => [Math.cos(p.lat * rad) * Math.cos(p.lon * rad), Math.cos(p.lat * rad) * Math.sin(p.lon * rad), Math.sin(p.lat * rad)];
    const a = vector(from), b = vector(to);
    const dot = Math.max(-1, Math.min(1, a.reduce((n, v, i) => n + v * b[i], 0)));
    const omega = Math.acos(dot);
    // A stable orthogonal axis also defines a deterministic antipodal path.
    let tangent = b.map((v, i) => v - dot * a[i]);
    let norm = Math.hypot(...tangent);
    if (norm < 1e-8) { const axis = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]; const d = a.reduce((n, v, i) => n + v * axis[i], 0); tangent = axis.map((v, i) => v - d * a[i]); norm = Math.hypot(...tangent); }
    tangent = tangent.map(v => v / norm);
    const points = Array.from({ length: 65 }, (_, i) => {
      const t = i / 64;
      const v = a.map((v, k) => v * Math.cos(omega * t) + tangent[k] * Math.sin(omega * t));
      return { x: (Math.atan2(v[1], v[0]) / rad + 180) / 360 * w, y: (90 - Math.asin(Math.max(-1, Math.min(1, v[2]))) / rad) / 180 * h };
    });
    const slots = [], segments = [];
    const font = '10px ' + family, height = 13;
    // Group nearby samples into short, nearly straight text runs. Reserve the
    // entire rotated box against labels, including markers and ocean names.
    for (let i = 0; i < points.length - 4; i += 4) {
      let a = points[i], b = points[i + 4];
      if (Math.abs(a.x - b.x) > w / 2) continue; // antimeridian, never draw across the map
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 2) continue;
      segments.push({ a, b });
      if (a.x > b.x) [a, b] = [b, a];
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const corners = [a, b, { x: a.x - Math.sin(angle) * height, y: a.y + Math.cos(angle) * height }, { x: b.x - Math.sin(angle) * height, y: b.y + Math.cos(angle) * height }];
      const bounds = { x0: Math.min(...corners.map(p => p.x)), x1: Math.max(...corners.map(p => p.x)), y0: Math.min(...corners.map(p => p.y)), y1: Math.max(...corners.map(p => p.y)) };
      let clear = bounds.x0 >= 0 && bounds.x1 < w && bounds.y0 >= 0 && bounds.y1 < h;
      for (let r = Math.floor(bounds.y0 / lineH); clear && r <= Math.floor(bounds.y1 / lineH); r++) {
        for (let c = Math.floor(bounds.x0 / charW); c <= Math.floor(bounds.x1 / charW); c++) if (occupancy[r * cols + c]) { clear = false; break; }
      }
      if (clear && length >= 24) slots.push({ x: a.x, y: a.y, width: length - 2, height, angle, bounds });
    }
    const out = flow(text, font, slots);
    return { ...out, font, segments, id: req.id, mode: 'route', text };
  }
  function palette(req) {
    const font = req.size + 'px ' + req.family;
    const glyphs = ['·', '.', ':', '~', '≈', '+', 'x', '*', 'o', '%', '#', '@', 'M', 'W'];
    const candidates = glyphs.map((glyph, i) => ({ glyph, tone: i / (glyphs.length - 1), width: prepare(glyph, font).widths.reduce((a, b) => a + b, 0) }));
    const ramp = Array.from({ length: 8 }, (_, level) => candidates.reduce((best, g) => {
      const score = x => Math.abs(x.tone - level / 7) + 0.7 * Math.abs(x.width - req.charW) / req.charW + (x.width > req.charW ? 1 : 0);
      return score(g) < score(best) ? g : best;
    }));
    return { font, ramp };
  }
  return { country, route, palette };
}
