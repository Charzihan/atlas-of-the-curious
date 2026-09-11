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
  // The width of the next whole word still to be set. pretext breaks a word at
  // grapheme boundaries when it cannot fit, which is right for a paragraph and
  // wrong for a shape: a run too narrow for the coming word stays empty.
  function nextWordWidth(pre, cursor) {
    if (cursor.graphemeIndex > 0) return 0; // already inside a word: finish it
    let i = cursor.segmentIndex;
    while (i < pre.kinds.length && pre.kinds[i] !== 'text') i++;
    return i < pre.widths.length ? pre.widths[i] : 0;
  }
  function flow(text, font, slots, wholeWords) {
    const pre = prepare(text, font);
    let cursor = { segmentIndex: 0, graphemeIndex: 0 };
    const lines = [];
    for (const slot of slots) {
      if (slot.width < 20) continue;
      if (wholeWords && slot.width < nextWordWidth(pre, cursor)) continue;
      const range = layoutNextLineRange(pre, cursor, slot.width);
      if (!range) break;
      const line = materializeLineRange(pre, range);
      if (line.width > slot.width + 0.01) continue;
      lines.push({ ...slot, text: line.text, width: line.width });
      cursor = range.end;
    }
    return { lines, complete: layoutNextLineRange(pre, cursor, 1e7) === null };
  }
  /* ---- The silhouette --------------------------------------------------
     A country arrives as simplified lon/lat rings (js/landmap.js `outlines`),
     not as grid cells: the 150x39 land grid is far too coarse to hold 400-odd
     words inside anything smaller than a continent. The rings are projected
     with the map's own equirectangular projection, then scaled about the
     country's own centre by k. Per text row the scanline runs of the polygon
     (even-odd over every ring, so holes are water) become the line widths fed
     to layoutNextLineRange, and the smallest k at which the whole story still
     fits is the one that is drawn — a larger k would leave the bottom of the
     country empty. */
  const VIEW_MARGIN = 8;
  const SIZES = [14, 13, 12, 11, 10];
  function clamp(v, a, b) { return a > b ? (a + b) / 2 : Math.max(a, Math.min(b, v)); }
  function projectRings(rings, w, h) {
    return rings.map(ring => {
      const out = new Array(ring.length);
      for (let i = 0; i < ring.length; i += 2) {
        out[i] = ((ring[i] + 180) / 360) * w;
        out[i + 1] = ((90 - ring[i + 1]) / 180) * h;
      }
      return out;
    });
  }
  function polyBox(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of poly) for (let i = 0; i < ring.length; i += 2) {
      if (ring[i] < x0) x0 = ring[i]; if (ring[i] > x1) x1 = ring[i];
      if (ring[i + 1] < y0) y0 = ring[i + 1]; if (ring[i + 1] > y1) y1 = ring[i + 1];
    }
    return { x0, y0, x1, y1 };
  }
  // The x spans inside the polygon on one horizontal line, even-odd.
  function spansAt(poly, y) {
    const xs = [];
    for (const ring of poly) for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const yi = ring[i + 1], yj = ring[j + 1];
      if ((yi > y) !== (yj > y)) xs.push(ring[i] + ((y - yi) / (yj - yi)) * (ring[j] - ring[i]));
    }
    xs.sort((a, b) => a - b);
    const spans = [];
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
    return spans;
  }
  function overlap(a, b) {
    const out = [];
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
      if (hi > lo) out.push([lo, hi]);
      if (a[i][1] < b[j][1]) i++; else j++;
    }
    return out;
  }
  // One candidate view: where the scaled silhouette sits, and the line slots
  // inside it. The view is anchored on the country's true position and only
  // slides far enough to stay on the map, so a place keeps its whereabouts.
  // Where the scaled silhouette sits. It starts on the country's own position
  // — a story should still be read where the place is — and only slides as far
  // as it must to stay on the map and clear of the panels drawn over it.
  function anchor(w, h, vw, vh, cx, cy, avoid) {
    const lox = VIEW_MARGIN + vw / 2, hix = w - VIEW_MARGIN - vw / 2;
    const loy = VIEW_MARGIN + vh / 2, hiy = h - VIEW_MARGIN - vh / 2;
    const home = { x: clamp(cx, lox, hix), y: clamp(cy, loy, hiy) };
    const tries = [home];
    for (const box of avoid || []) {
      tries.push({ x: home.x, y: clamp(box.y + box.height + vh / 2 + 4, loy, hiy) });
      tries.push({ x: home.x, y: clamp(box.y - vh / 2 - 4, loy, hiy) });
      tries.push({ x: clamp(box.x + box.width + vw / 2 + 4, lox, hix), y: home.y });
      tries.push({ x: clamp(box.x - vw / 2 - 4, lox, hix), y: home.y });
    }
    let best = home, score = Infinity;
    for (const at of tries) {
      let covered = 0;
      for (const box of avoid || []) {
        covered += Math.max(0, Math.min(at.x + vw / 2, box.x + box.width) - Math.max(at.x - vw / 2, box.x))
          * Math.max(0, Math.min(at.y + vh / 2, box.y + box.height) - Math.max(at.y - vh / 2, box.y));
      }
      // Least hidden, but not at the cost of moving the country across the
      // world to dodge a corner of a panel.
      const rank = covered + 40 * Math.hypot(at.x - home.x, at.y - home.y);
      if (rank < score) { score = rank; best = at; }
    }
    return best;
  }
  function silhouetteView(poly, box, k, size, w, h, avoid) {
    const lh = Math.round(size * 1.26);
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const vw = (box.x1 - box.x0) * k, vh = (box.y1 - box.y0) * k;
    const at = anchor(w, h, vw, vh, cx, cy, avoid);
    const ox = at.x, oy = at.y;
    const toX = px => (px - cx) * k + ox, toY = py => (py - cy) * k + oy;
    const top = oy - vh / 2;
    // A minimum run: a sliver of coastline never holds a word.
    const minRun = Math.max(20, size * 2.4);
    const slots = [];
    for (let y = top; y + lh <= top + vh + 0.01; y += lh) {
      // The whole line box has to be inside the shape, so intersect the runs
      // at its top, middle and bottom rather than sampling one height.
      let runs = null;
      for (const at of [y + 1, y + lh * 0.3, y + lh * 0.5, y + lh * 0.7, y + lh - 1]) {
        const spans = spansAt(poly, (at - oy) / k + cy);
        runs = runs ? overlap(runs, spans) : spans;
        if (!runs.length) break;
      }
      for (const run of runs || []) {
        const width = (run[1] - run[0]) * k - 2;
        if (width >= minRun) slots.push({ x: toX(run[0]) + 1, y: y, width: width, height: lh });
      }
    }
    return { slots: slots, lh: lh, k: k, toX: toX, toY: toY, box: { x: ox - vw / 2, y: top, width: vw, height: vh } };
  }
  function silhouette(req, w, h) {
    const poly = projectRings(req.rings, w, h);
    const box = polyBox(poly);
    const bw = Math.max(1e-6, box.x1 - box.x0), bh = Math.max(1e-6, box.y1 - box.y0);
    const kMax = Math.min((w - 2 * VIEW_MARGIN) / bw, (h - 2 * VIEW_MARGIN) / bh);
    if (!(kMax > 0)) return null;
    for (const size of SIZES) {
      const font = size + 'px ' + req.family;
      const fit = k => {
        const view = silhouetteView(poly, box, k, size, w, h, req.avoid);
        if (!view.slots.length) return null;
        const out = flow(req.text, font, view.slots, true);
        return out.complete && out.lines.length ? { view: view, lines: out.lines } : null;
      };
      let keep = fit(kMax);
      if (!keep) continue;
      // The smallest scale that still holds the story fills the shape.
      let lo = Math.min(1, kMax), hi = kMax;
      for (let i = 0; i < 10 && hi - lo > kMax * 0.02; i++) {
        const mid = (lo + hi) / 2;
        const attempt = fit(mid);
        if (attempt) { keep = attempt; hi = mid; } else lo = mid;
      }
      const view = keep.view;
      return {
        lines: keep.lines, complete: true, font: font, size: size, scale: view.k,
        mode: 'country', id: req.id,
        shape: {
          box: view.box,
          rings: poly.map(ring => {
            const out = new Array(ring.length);
            for (let i = 0; i < ring.length; i += 2) { out[i] = view.toX(ring[i]); out[i + 1] = view.toY(ring[i + 1]); }
            return out;
          })
        },
        marker: req.at ? { x: view.toX(((req.at.lon + 180) / 360) * w), y: view.toY(((90 - req.at.lat) / 180) * h) } : null
      };
    }
    return null;
  }
  function country(req) {
    const { cols, rows, charW, lineH, text, family } = req;
    const w = cols * charW, h = rows * lineH;
    if (req.rings && req.rings.length) {
      const shaped = silhouette(req, w, h);
      if (shaped) return shaped;
    }
    // The country is too thin or too fragmented to hold the story at 10px
    // within the map height. A regional inset keeps all the words at a
    // readable size, anchored near the place.
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
