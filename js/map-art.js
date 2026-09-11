/* Pure worker-side geometry for country stories, great-circle notes and
   proportional map ink. Pixel units always refer to the unzoomed map. */
import { prepareWithSegments, layoutNextLineRange, materializeLineRange } from '../vendor/pretext/layout.js';

// ---- Phase 8 helpers: glyph ink, and the land's distance-to-coast field -----
// Printable ASCII, the printable half of Latin-1, and the typographic marks a
// WGL4 face such as Georgia also carries. Nothing here should need a fallback
// font; anything that does is detected and dropped when the palette is built.
const PALETTE_CANDIDATES = (function () {
  let s = '';
  for (let c = 0x21; c <= 0x7e; c++) s += String.fromCharCode(c);
  for (let c = 0xa1; c <= 0xff; c++) if (c !== 0xad) s += String.fromCharCode(c);
  s += '†‡•≈∞œŒ–—‰';
  return Array.from(new Set(Array.from(s)));
})();
// An unassigned private-use code point: whatever this measures as is notdef.
const TOFU_PROBE = '\ue000';
const PALETTE_LEVELS = 24;
// How much a glyph is penalised for being narrower than the cell it fills.
const NARROW_WEIGHT = 0.4;
// Coastlines take the darkest land tone; the interior fades to INTERIOR_TONE
// over COAST_REACH cells.
const COAST_REACH = 5, INTERIOR_TONE = 0.3;

// The worker has OffscreenCanvas; the synchronous fallback host has a document.
function inkContext(w, h) {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      return canvas.getContext('2d', { willReadFrequently: true });
    }
  } catch (e) { /* measured tone is unavailable; the caller falls back */ }
  return null;
}

// Ink coverage per glyph, counted inside one cell drawn exactly the way
// js/map.js draws it (left aligned, middle baseline). `spill` is the fraction of
// a glyph's ink that lands outside its own cell.
function measureGlyphs(font, charW, lineH, glyphs, advance) {
  const cellW = Math.max(1, Math.round(charW)), cellH = Math.max(1, Math.round(lineH));
  const padX = cellW + 2, padY = cellH + 2;
  const w = cellW + padX * 2, h = cellH + padY * 2;
  const ctx = inkContext(w, h);
  // No canvas at all: ordinal tone, so the palette still answers. Nothing in a
  // browser takes this path.
  if (!ctx) return glyphs.map((glyph, i) => ({ glyph, width: advance(glyph), coverage: i / Math.max(1, glyphs.length - 1), spill: 0, measured: false }));
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  return glyphs.map(glyph => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillText(glyph, padX, padY + cellH / 2);
    const data = ctx.getImageData(0, 0, w, h).data;
    let inside = 0, outside = 0;
    for (let y = 0; y < h; y++) {
      const row = y >= padY && y < padY + cellH;
      for (let x = 0; x < w; x++) {
        const alpha = data[(y * w + x) * 4 + 3];
        if (!alpha) continue;
        if (row && x >= padX && x < padX + cellW) inside += alpha; else outside += alpha;
      }
    }
    return {
      glyph, width: advance(glyph), measured: true,
      coverage: inside / (cellW * cellH * 255),
      spill: outside / (inside + outside || 1)
    };
  });
}

// Distance to the nearest coast, in cells: a multi-source breadth-first search
// from every land cell that touches water or a pole. Columns wrap, so the
// antimeridian is not a false coastline.
function coastField(land, cols, rows) {
  const n = cols * rows;
  const dist = new Int16Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const at = (c, r) => r * cols + ((c + cols) % cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!land[i]) continue;
      if (r === 0 || r === rows - 1 || !land[at(c - 1, r)] || !land[at(c + 1, r)] || !land[i - cols] || !land[i + cols]) {
        dist[i] = 0; queue[tail++] = i;
      }
    }
  }
  while (head < tail) {
    const i = queue[head++], c = i % cols, r = (i / cols) | 0, d = dist[i] + 1;
    const push = j => { if (land[j] && dist[j] < 0) { dist[j] = d; queue[tail++] = j; } };
    push(at(c - 1, r)); push(at(c + 1, r));
    if (r > 0) push(i - cols);
    if (r < rows - 1) push(i + cols);
  }
  return dist;
}

// The per-cell target tone for land: dark at the coast, lighter inland, with a
// trace of the existing colour dither so a wide interior does not flatten into
// one even grey. The continents keep their shape once the glyphs stop being one
// character wide because their outline stays the darkest thing on the map.
function landTones(req, levels) {
  const out = new Uint8Array(req.cols * req.rows);
  if (!req.land) return out;
  const dist = coastField(req.land, req.cols, req.rows);
  for (let i = 0; i < out.length; i++) {
    if (!req.land[i]) continue;
    const d = dist[i] < 0 ? COAST_REACH : Math.min(COAST_REACH, dist[i]);
    let tone = 1 - (1 - INTERIOR_TONE) * (d / COAST_REACH);
    if (req.color) tone += ((req.color[i] % 3) - 1) * 0.025;
    out[i] = Math.max(0, Math.min(levels - 1, Math.round(tone * (levels - 1))));
  }
  return out;
}

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
  // ---- Phase 8: the measured serif palette ---------------------------------
  // The roadmap asks for pretext's variable-typographic-ascii idea applied to
  // the land mask, and that needs measured numbers rather than a hand-sorted
  // list of glyphs: every candidate is rendered once, at the map's own cell
  // size, in the serif face, and its ink is counted. "Tone" is therefore
  // measured coverage; the advance comes from `prepareWithSegments`, the same
  // measurement pretext lays text out with, so a glyph that would not fit its
  // cell is rejected on the font engine's own numbers.
  //
  // Built once per geometry and font and cached here; never called from a frame.
  function palette(req) {
    const font = req.size + 'px ' + req.family;
    const key = ['palette', font, req.charW, req.lineH, req.cols, req.rows].join('\n');
    const hit = cache.get(key);
    if (hit) return hit;
    const advance = glyph => prepare(glyph, font).widths.reduce((a, b) => a + b, 0);
    const all = measureGlyphs(font, req.charW, req.lineH, PALETTE_CANDIDATES.concat([TOFU_PROBE]), advance);
    // A glyph the resolved face does not have renders as the same notdef box as
    // an unassigned private-use code point. Those are dropped rather than
    // painted: the atlas must be set in one face, not in whatever the browser
    // would substitute for a missing mark.
    const probe = all[all.length - 1];
    let list = all.slice(0, -1);
    if (probe.measured && probe.coverage > 0) {
      list = list.filter(g => !(Math.abs(g.width - probe.width) < 0.01 && Math.abs(g.coverage - probe.coverage) < 0.002));
    }
    // Narrower than the cell is fine — it gets centred. Wider would push the
    // ink out of step with the markers, and a glyph whose ink escapes its own
    // cell would smear into the row above or below.
    const fits = (allowance, spill) => list.filter(g => g.width > 0.05 && g.width <= req.charW * allowance + 0.25 && g.spill <= spill);
    let usable = fits(1, 0.06);
    if (usable.length < PALETTE_LEVELS) usable = fits(1, 0.14);
    if (usable.length < PALETTE_LEVELS) usable = fits(1.15, 0.2);
    if (usable.length < PALETTE_LEVELS) usable = list.slice();
    // Coverage is normalised over the glyphs that can actually be used, so tone
    // 0 and tone 1 are this cell's real lightest and darkest ink rather than a
    // range the ramp would saturate in.
    const lo = usable.reduce((m, g) => Math.min(m, g.coverage), Infinity);
    const span = usable.reduce((m, g) => Math.max(m, g.coverage), -Infinity) - lo || 1;
    const scaled = usable
      .map(g => ({ glyph: g.glyph, width: g.width, coverage: (g.coverage - lo) / span }))
      .sort((a, b) => a.coverage - b.coverage || a.width - b.width || (a.glyph < b.glyph ? -1 : 1));
    // Two glyphs that measure to the same ink are one rung, not two.
    const sorted = scaled.filter((g, i) => i === 0 || g.coverage > scaled[i - 1].coverage);
    // One pass per level, left to right: each level takes the best-scoring glyph
    // that is darker than the level below it, and leaves one glyph behind for
    // every level still to come. The ramp is therefore strictly increasing in
    // measured coverage, and no level has to repeat its neighbour's glyph.
    const ramp = [];
    let from = 0;
    for (let level = 0; level < PALETTE_LEVELS; level++) {
      const target = level / (PALETTE_LEVELS - 1);
      const score = g => Math.abs(g.coverage - target) + NARROW_WEIGHT * Math.max(0, (req.charW - g.width) / req.charW);
      const until = Math.max(from + 1, Math.min(sorted.length, sorted.length - (PALETTE_LEVELS - 1 - level)));
      let at = Math.min(from, sorted.length - 1);
      for (let i = at; i < until && i < sorted.length; i++) if (score(sorted[i]) < score(sorted[at])) at = i;
      const best = sorted[at];
      ramp.push({ glyph: best.glyph, coverage: best.coverage, width: best.width });
      from = at + 1;
    }
    const out = {
      font, family: req.family, size: req.size, charW: req.charW, lineH: req.lineH,
      levels: PALETTE_LEVELS, measured: probe.measured,
      candidates: list.length, usable: sorted.length,
      coast: { reach: COAST_REACH, interior: INTERIOR_TONE },
      ramp, landLevel: landTones(req, PALETTE_LEVELS)
    };
    cache.set(key, out);
    return out;
  }
  return { country, route, palette };
}
