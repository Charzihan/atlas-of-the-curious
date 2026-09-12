/* Pure worker-side geometry for country stories, great-circle notes and
   proportional map ink. Pixel units always refer to the unzoomed map. */
import { prepareWithSegments, layoutNextLineRange, materializeLineRange } from '../vendor/pretext/layout.js';
import { MAP_STORY_TYPE } from './text.js';
import { scaleCells } from './labels.js';

// ---- Phase 8 helpers: glyph ink, and the land's distance-to-coast field -----
// Printable ASCII, the printable half of Latin-1, and the typographic marks a
// WGL4 face such as Georgia commonly carries. The browser may substitute faces
// or individual glyphs; the notdef heuristic below cannot detect that fallback.
const PALETTE_CANDIDATES = (function () {
  let s = '';
  for (let c = 0x21; c <= 0x7e; c++) s += String.fromCharCode(c);
  for (let c = 0xa1; c <= 0xff; c++) if (c !== 0xad) s += String.fromCharCode(c);
  s += '†‡•≈∞œŒ–—‰';
  return Array.from(new Set(Array.from(s)));
})();
// A private-use probe for likely notdef boxes, not a font-availability test.
const TOFU_PROBE = '\ue000';
const PALETTE_LEVELS = 24, MIN_PALETTE_LEVELS = 6;
const MAX_SPILL = 0.06;
// How much a glyph is penalised for being narrower than the cell it fills.
const NARROW_WEIGHT = 0.4;
// Coastlines take the darkest land tone; the interior fades to INTERIOR_TONE
// over COAST_REACH cells — a distance on screen, so it is counted in cells of
// the 150-column grid it was tuned on and scaled to whatever grid the request
// carries (240 columns now: eight cells, the same band of coast as five were).
const COAST_REACH = 5, INTERIOR_TONE = 0.3;

// The worker has OffscreenCanvas; the synchronous fallback host has a document.
function inkContext(w, h) {
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      return { ctx: canvas.getContext('2d', { willReadFrequently: true }), host: 'dom' };
    }
    if (typeof OffscreenCanvas !== 'undefined') return { ctx: new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true }), host: 'offscreen' };
  } catch (e) { /* measured tone is unavailable; the caller falls back */ }
  return null;
}

// Ink coverage per glyph, counted inside one cell drawn exactly the way
// js/map.js draws it: centred by advance, middle baseline, fractional CSS cells
// and DPR scaling. The reference is cell (0, 0), before the sea's ripple lift;
// integer device-pixel padding preserves that cell's subpixel raster phase.
// Fractional edge pixels contribute in proportion to their overlap with the
// cell. `spill` counts ink outside any edge, not only the neighbouring rows.
function* measureGlyphs(font, charW, lineH, dpr, glyphs, advance) {
  const cellW = charW * dpr, cellH = lineH * dpr;
  const pad = Math.ceil(Math.max(charW, lineH, parseFloat(font)) * dpr) + 2;
  const w = Math.ceil(cellW) + pad * 2, h = Math.ceil(cellH) + pad * 2;
  const probe = inkContext(w, h), ctx = probe && probe.ctx;
  if (!ctx) return { glyphs: [], host: 'unavailable', measured: false };
  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  try {
    const measured = [];
    for (const glyph of glyphs) {
      const width = advance(glyph);
      ctx.clearRect(0, 0, w / dpr, h / dpr);
      ctx.fillText(glyph, pad / dpr + (charW - width) / 2, pad / dpr + lineH / 2);
      const data = ctx.getImageData(0, 0, w, h).data;
      let inside = 0, outside = 0;
      for (let y = 0; y < h; y++) {
        const row = Math.max(0, Math.min(y + 1, pad + cellH) - Math.max(y, pad));
        for (let x = 0; x < w; x++) {
          const alpha = data[(y * w + x) * 4 + 3];
          if (!alpha) continue;
          const share = row * Math.max(0, Math.min(x + 1, pad + cellW) - Math.max(x, pad));
          inside += alpha * share; outside += alpha * (1 - share);
        }
      }
      measured.push({
        glyph, width,
        coverage: inside / (cellW * cellH * 255),
        spill: outside / (inside + outside || 1)
      });
      // The synchronous atlas worker consumes this without yielding. The
      // globe/standalone host resumes between glyphs in idle tasks.
      yield;
    }
    return { glyphs: measured, host: probe.host, measured: true };
  } catch (e) { return { glyphs: [], host: probe.host, measured: false }; }
}

// Fixed fit limits: fewer distinct coverages produce a shorter ramp. Exported
// so acceptance checks can exercise sparse palettes without relying on a font.
export function buildInkRamp(glyphs, charW) {
  const fitting = glyphs.filter(g => g.width > 0.05 && g.width <= charW && g.spill <= MAX_SPILL && g.coverage > 0);
  const lo = fitting.reduce((m, g) => Math.min(m, g.coverage), Infinity);
  const span = fitting.reduce((m, g) => Math.max(m, g.coverage), -Infinity) - lo || 1;
  const scaled = fitting
    .map(g => ({ ...g, inkCoverage: g.coverage, coverage: (g.coverage - lo) / span }))
    .sort((a, b) => a.coverage - b.coverage || b.width - a.width || (a.glyph < b.glyph ? -1 : 1));
  // Equal coverage keeps the widest fitting glyph, matching the width score.
  const sorted = scaled.filter((g, i) => i === 0 || g.coverage > scaled[i - 1].coverage);
  const levels = Math.min(PALETTE_LEVELS, sorted.length), ramp = [];
  let from = 0;
  for (let level = 0; level < levels; level++) {
    const target = levels > 1 ? level / (levels - 1) : 0;
    const score = g => Math.abs(g.coverage - target) + NARROW_WEIGHT * Math.max(0, (charW - g.width) / charW);
    const until = sorted.length - (levels - 1 - level);
    let at = from;
    for (let i = from + 1; i < until; i++) if (score(sorted[i]) < score(sorted[at])) at = i;
    ramp.push(sorted[at]);
    from = at + 1;
  }
  return { ramp, fitting: sorted.length, usable: levels >= MIN_PALETTE_LEVELS };
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
  const reach = scaleCells(COAST_REACH, req.cols);
  for (let i = 0; i < out.length; i++) {
    if (!req.land[i]) continue;
    const d = dist[i] < 0 ? reach : Math.min(reach, dist[i]);
    let tone = 1 - (1 - INTERIOR_TONE) * (d / reach);
    if (req.color) tone += ((req.color[i] % 3) - 1) * 0.025;
    out[i] = Math.max(0, Math.min(levels - 1, Math.round(tone * (levels - 1))));
  }
  return out;
}

// Phase 7: share the painted marker dimensions with layout (outer stroke too).
export const COUNTRY_MARKER = Object.freeze({ radius: 5.5, stroke: 3.6, innerStroke: 1.6, dot: 1.8 });

function overlap(a, b) {
  const out = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

// Exact full-height runs for simple, non-crossing polygon rings (even-odd).
// Between consecutive vertex heights, active edges and their order are fixed
// and each x endpoint is linear in y. Intersect both limits of every slab:
// this includes narrow holes/notches and both sides of horizontal boundaries.
export function polygonBoxRuns(poly, top, bottom) {
  if (!(bottom > top)) return [];
  const cuts = new Set([top, bottom]);
  for (const ring of poly) for (let i = 1; i < ring.length; i += 2) {
    if (ring[i] > top && ring[i] < bottom) cuts.add(ring[i]);
  }
  const ys = [...cuts].sort((a, b) => a - b);
  let runs = null;
  for (let s = 0; s + 1 < ys.length; s++) {
    const lo = ys[s], hi = ys[s + 1], edges = [];
    for (const ring of poly) for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const yi = ring[i + 1], yj = ring[j + 1];
      if (Math.min(yi, yj) >= hi || Math.max(yi, yj) <= lo || yi === yj) continue;
      const xAt = y => ring[i] + ((y - yi) / (yj - yi)) * (ring[j] - ring[i]);
      edges.push([xAt(lo), xAt(hi)]);
    }
    edges.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
    const spans = [];
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const left = Math.max(...edges[i]), right = Math.min(...edges[i + 1]);
      if (right > left) spans.push([left, right]);
    }
    runs = runs ? overlap(runs, spans) : spans;
    if (!runs.length) break;
  }
  return runs || [];
}

export function containsLineBox(poly, box) {
  return box.width > 0 && polygonBoxRuns(poly, box.y, box.y + box.height)
    .some(([left, right]) => box.x >= left - 1e-7 && box.x + box.width <= right + 1e-7);
}

export function boxesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function markerObstacle(marker) {
  const radius = COUNTRY_MARKER.radius + COUNTRY_MARKER.stroke / 2;
  return { x: marker.x - radius, y: marker.y - radius, width: radius * 2, height: radius * 2 };
}

export function countrySlots(poly, top, bottom, lineHeight, minRun) {
  const slots = [];
  for (let y = top; y + lineHeight <= bottom; y += lineHeight) {
    for (const [left, right] of polygonBoxRuns(poly, y, y + lineHeight)) {
      const width = right - left - 2;
      if (width >= minRun) slots.push({ x: left + 1, y, width, height: lineHeight });
    }
  }
  return slots;
}

const flowCache = new Map();
let flowPreparationCalls = 0;
// Count calls including warm hits: zero measurements does not prove a frame
// avoided preparation. Inspection itself never changes this counter.
export function flowPreparationCount() { return flowPreparationCalls; }

// Both silhouette adapters share preparation and line breaking. Animation
// callers warm this cache before their loop and pass the handle to the flow.
export function prepareFlowText(text, font, { letterSpacing = 0 } = {}) {
  flowPreparationCalls++;
  const key = JSON.stringify([font, letterSpacing, text]);
  if (!flowCache.has(key)) flowCache.set(key, prepareWithSegments(text, font, { letterSpacing }));
  return flowCache.get(key);
}

export function flowIntoSlots(text, font, slots, { wholeWords = false, letterSpacing = 0, prepared, maxLines = Infinity } = {}) {
  const pre = prepared || prepareFlowText(text, font, { letterSpacing });
  // The width of the next whole word still to be set. pretext breaks a word at
  // grapheme boundaries when it cannot fit, which is right for a paragraph and
  // wrong for a shape: a run too narrow for the coming word stays empty.
  function nextWordWidth(pre, cursor) {
    if (cursor.graphemeIndex > 0) return 0; // already inside a word: finish it
    let i = cursor.segmentIndex;
    while (i < pre.kinds.length && pre.kinds[i] !== 'text') i++;
    return i < pre.widths.length ? pre.widths[i] + pre.letterSpacing : 0;
  }
  let cursor = { segmentIndex: 0, graphemeIndex: 0 };
  const lines = [];
  for (const slot of slots) {
    if (lines.length >= maxLines) break;
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

export function createMapArtEngine() {
  const cache = new Map();
  const prepare = prepareFlowText;
  const flow = (text, font, slots, wholeWords) => flowIntoSlots(text, font, slots, { wholeWords });
  /* ---- The silhouette --------------------------------------------------
     A country arrives as simplified lon/lat rings (js/landmap.js `outlines`),
     not as grid cells: even the 240x62 land grid is far too coarse to hold
     400-odd words inside anything smaller than a continent. The rings are projected
     with the map's own equirectangular projection, then scaled about the
     country's own centre by k. Per text row the scanline runs of the polygon
     (even-odd over every ring, so holes are water) become the line widths fed
     to layoutNextLineRange, and the smallest k at which the whole story still
     fits is the one that is drawn — a larger k would leave the bottom of the
     country empty. */
  const VIEW_MARGIN = 8;
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
  // Start at the country's true position. Prefer the fewest removed text
  // slots, then the shortest move; panel clearance is never traded for distance.
  function anchor(w, h, vw, vh, cx, cy, slots, avoid) {
    const lox = VIEW_MARGIN + vw / 2, hix = w - VIEW_MARGIN - vw / 2;
    const loy = VIEW_MARGIN + vh / 2, hiy = h - VIEW_MARGIN - vh / 2;
    const home = { x: clamp(cx, lox, hix), y: clamp(cy, loy, hiy) };
    const xs = new Set([home.x]), ys = new Set([home.y]);
    for (const box of avoid || []) {
      ys.add(clamp(box.y + box.height + vh / 2 + 4, loy, hiy));
      ys.add(clamp(box.y - vh / 2 - 4, loy, hiy));
      xs.add(clamp(box.x + box.width + vw / 2 + 4, lox, hix));
      xs.add(clamp(box.x - vw / 2 - 4, lox, hix));
    }
    let best = null, removed = Infinity, distance = Infinity;
    for (const x of xs) for (const y of ys) {
      const moved = slots.map(slot => ({ ...slot, x: slot.x + x - cx, y: slot.y + y - cy }));
      const clear = moved.filter(slot => !(avoid || []).some(box => boxesOverlap(slot, box)));
      const lost = slots.length - clear.length, d = Math.hypot(x - home.x, y - home.y);
      if (lost < removed || (lost === removed && d < distance)) {
        best = { x, y, slots: clear }; removed = lost; distance = d;
      }
    }
    return best;
  }
  function silhouetteView(poly, box, k, type, w, h, avoid, place) {
    const { size, lineHeight: lh } = type;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const vw = (box.x1 - box.x0) * k, vh = (box.y1 - box.y0) * k;
    const scaled = poly.map(ring => ring.map((v, i) => i % 2 ? (v - cy) * k + cy : (v - cx) * k + cx));
    const marker = place ? { x: (((place.lon + 180) / 360) * w - cx) * k + cx, y: (((90 - place.lat) / 180) * h - cy) * k + cy } : null;
    // Reserve the whole outer stroke before fitting, in the same coordinates
    // as the slots. The marker moves with the shape, so anchoring cannot clear it.
    const obstacle = marker && markerObstacle(marker);
    const slots = countrySlots(scaled, cy - vh / 2, cy + vh / 2, lh, Math.max(20, size * 2.4))
      .filter(slot => !obstacle || !boxesOverlap(slot, obstacle));
    const at = anchor(w, h, vw, vh, cx, cy, slots, avoid);
    const toX = px => (px - cx) * k + at.x, toY = py => (py - cy) * k + at.y;
    return {
      slots: at.slots, lh, k, toX, toY,
      box: { x: at.x - vw / 2, y: at.y - vh / 2, width: vw, height: vh },
      marker: marker ? { x: marker.x + at.x - cx, y: marker.y + at.y - cy } : null
    };
  }
  function silhouette(req, w, h) {
    const poly = projectRings(req.rings, w, h);
    const box = polyBox(poly);
    const bw = Math.max(1e-6, box.x1 - box.x0), bh = Math.max(1e-6, box.y1 - box.y0);
    const kMax = Math.min((w - 2 * VIEW_MARGIN) / bw, (h - 2 * VIEW_MARGIN) / bh);
    if (!(kMax > 0)) return null;
    for (const type of MAP_STORY_TYPE.candidates) {
      const { size } = type;
      const font = size + 'px ' + req.family;
      const fit = k => {
        const view = silhouetteView(poly, box, k, type, w, h, req.avoid, req.at);
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
        marker: view.marker
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
    const { size, lineHeight: lh } = MAP_STORY_TYPE.inset;
    const insetFont = size + 'px ' + family;
    const trial = flow(text, insetFont, Array.from({ length: 100 }, (_, i) => ({ x: 0, y: i * lh, width: width - 24, height: lh })));
    const height = trial.lines.length * lh + 24;
    if (height > h - 24) return { complete: true, lines: [], font: insetFont, mode: "caption", id: req.id, text };
    const x = Math.max(12, Math.min(w - width - 12, req.col * charW - width / 2));
    let y = Math.max(12, Math.min(h - height - 12, req.row * lineH + lineH));
    // Keep western insets below the map introduction at the base view.
    if (w > 640 && x < 440) y = Math.max(y, Math.min(320, h - height - 12));
    const slots = trial.lines.map(l => ({ ...l, x: l.x + x + 12, y: l.y + y + 12 }));
    const at = anchor(w, h, width, height, x + width / 2, y + height / 2, slots, req.avoid);
    if (at.slots.length < slots.length) return { complete: true, lines: [], font: insetFont, mode: 'caption', id: req.id, text };
    return { ...trial, lines: at.slots, font: insetFont, mode: 'region', id: req.id, box: { x: at.x - width / 2, y: at.y - height / 2, width, height } };
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
  function* paletteSteps(req) {
    const font = req.size + 'px ' + req.family;
    const dpr = req.dpr || 1;
    const key = ['palette', font, req.charW, req.lineH, dpr, req.cols, req.rows].join('\n');
    const hit = cache.get(key);
    if (hit) return hit;
    const advance = glyph => prepare(glyph, font).widths.reduce((a, b) => a + b, 0);
    const measurement = yield* measureGlyphs(font, req.charW, req.lineH, dpr, PALETTE_CANDIDATES.concat([TOFU_PROBE]), advance);
    // This only rejects likely notdef boxes: a real fallback glyph can differ
    // from U+E000, and a real supported glyph can resemble it. Canvas does not
    // identify the face supplying each glyph. We measure the resolved stack,
    // including substitutions, and make no claim that all ink uses one face.
    const all = measurement.glyphs, probe = all[all.length - 1];
    let list = all.slice(0, -1);
    if (probe && probe.coverage > 0) {
      list = list.filter(g => !(Math.abs(g.width - probe.width) < 0.01 && Math.abs(g.coverage - probe.coverage) < 0.002));
    }
    const { ramp, fitting, usable } = buildInkRamp(list, req.charW);
    const levels = ramp.length;
    const out = {
      font, family: req.family, size: req.size, charW: req.charW, lineH: req.lineH, dpr,
      levels, measured: measurement.measured, canvas: measurement.host,
      candidates: list.length, fitting, usable,
      reason: usable ? '' : !measurement.measured ? 'Serif map unavailable: canvas ink measurement failed.'
        : 'Serif map unavailable: fewer than ' + MIN_PALETTE_LEVELS + ' distinct tones fit this cell within the 6% ink spill limit.',
      coast: { reach: scaleCells(COAST_REACH, req.cols), interior: INTERIOR_TONE },
      ramp, landLevel: usable ? landTones(req, levels) : null
    };
    cache.set(key, out);
    return out;
  }
  function palette(req) {
    const steps = paletteSteps(req);
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
  }
  // Same measurements, fit limits and cache as the worker's palette action.
  // Schedule even the first step: calling this from an input/LOD change never
  // measures synchronously. Without idle callbacks, do one glyph per task.
  function paletteAsync(req, schedule = callback => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(callback);
    else setTimeout(callback, 0);
  }) {
    const steps = paletteSteps(req);
    return new Promise((resolve, reject) => {
      const step = deadline => {
        if (deadline && deadline.timeRemaining() < 2) { schedule(step); return; }
        const start = performance.now();
        try {
          let next;
          do { next = steps.next(); }
          while (!next.done && deadline && deadline.timeRemaining() > 2 && performance.now() - start < 2);
          if (next.done) resolve(next.value);
          else schedule(step);
        } catch (error) { reject(error); }
      };
      schedule(step);
    });
  }
  return { country, route, palette, paletteAsync };
}
