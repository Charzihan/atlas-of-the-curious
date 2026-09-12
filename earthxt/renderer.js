import { measureNaturalWidth } from '../vendor/pretext/layout.js';
import { prepareFlowText, flowIntoSlots, boxesOverlap } from '../js/map-art.js';
import { cameraBasis, latLonToCartesian, project, RAD } from './geometry.js';

const PALETTE = ['#213e42', '#2e5558', '#3c6969', '#598580', '#45695a', '#73977a', '#a0bea0', '#c6dfb3', '#dfd4a6', '#dcad79', '#3b5651'];
const MAX_CELLS = 24000;

/** Maximal same-country runs, inset by one cell at each end. Geometry uses
 * the top-left grid edge in CSS pixels; minRun counts remaining cells. */
export function countryRunSlots(ids, cols, rows, { cellWidth, cellHeight, x = 0, y = 0, minRun = 3 }) {
  const countries = new Map();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols;) {
      const start = col, id = ids[row * cols + col++];
      while (col < cols && ids[row * cols + col] === id) col++;
      if (!id || col - start - 2 < minRun) continue;
      if (!countries.has(id)) countries.set(id, []);
      countries.get(id).push({ x: x + (start + 1) * cellWidth, y: y + row * cellHeight,
        width: (col - start - 2) * cellWidth, height: cellHeight });
    }
  }
  return countries;
}

function inside(box, slot) {
  return box.x >= slot.x - 1e-7 && box.y >= slot.y - 1e-7 &&
    box.x + box.width <= slot.x + slot.width + 1e-7 && box.y + box.height <= slot.y + slot.height + 1e-7;
}

// Select the run on the anchor's column, then rows outward (above before
// below at equal distance). Flow in reading order, keeping the role's leading.
export function placeSilhouetteName(text, role, measured, slots, anchor) {
  const candidates = slots.filter(slot => anchor.x >= slot.x && anchor.x < slot.x + slot.width && slot.height >= measured.inkHeight)
    .sort((a, b) => Math.abs(a.y + a.height / 2 - anchor.y) - Math.abs(b.y + b.height / 2 - anchor.y) || a.y - b.y);
  const selected = [];
  for (const slot of candidates) {
    if (selected.some(other => Math.abs(other.y - slot.y) < role.lineHeight)) continue;
    selected.push(slot);
    const ordered = [...selected].sort((a, b) => a.y - b.y);
    const flowSlots = ordered.map(slot => ({ ...slot, slot, x: slot.x + measured.overhang,
      width: slot.width - 2 * measured.overhang }));
    const out = flowIntoSlots(text, role.font, flowSlots, { wholeWords: true, prepared: measured.pre, maxLines: 3 });
    if (out.complete && out.lines.length) {
      const lines = out.lines.map(line => {
        // Pretext's range can retain hanging whitespace in the materialized
        // text; its paint width already excludes that whitespace.
        const text = line.text.trimEnd();
        const plan = measured.plans.get(text);
        if (!plan) return null;
        const x = line.slot.x + (line.slot.width - line.width) / 2;
        const baseline = line.y + (line.height - measured.inkHeight) / 2 + measured.ascent;
        const glyphs = plan.glyphs.map(glyph => ({ text: glyph.text, x: x + glyph.x,
          y: baseline, box: { x: x + glyph.x - glyph.left, y: baseline - glyph.ascent,
            width: glyph.left + glyph.right, height: glyph.ascent + glyph.descent } }));
        const box = { x: x - plan.left, y: baseline - plan.ascent,
          width: plan.left + plan.right, height: plan.ascent + plan.descent };
        return { text, x, y: baseline, width: line.width, slot: line.slot, box, glyphs };
      });
      if (lines.every(line => line && inside(line.box, line.slot) && line.glyphs.every(glyph => inside(glyph.box, line.slot)))) return lines;
    }
    if (selected.length === 3) break;
  }
  return null;
}

/** Display adapter: geography is painted exclusively with browser text glyphs. */
export class TextRenderer {
  constructor(canvas, labelLayer, fonts) {
    this.fonts = fonts;
    this.preparedLabels = new Map();
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: true });
    if (!this.context) throw new Error('This browser cannot create a 2D text canvas.');
    this.labelLayer = labelLayer;
    this.labelNodes = new Map();
    this.viewport = { width: 1, height: 1, focal: 1 };
    this.metrics = { visibleGlyphs: 0, totalGlyphs: 0, projectionMs: 0, renderMs: 0, labelMs: 0, placeLabelMs: 0, visibleMarkers: 0, labelledPlaces: 0, visibleLabels: 0, silhouetteLabels: 0, fallbackLabels: 0 };
    this.cells = new Uint8Array(MAX_CELLS);
    this.variants = new Uint8Array(MAX_CELLS);
    this.countryIds = new Uint8Array(MAX_CELLS);
    this.blockedCells = new Uint8Array(MAX_CELLS);
    this.labelPlacements = [];
    this.nativeSpacing = 'letterSpacing' in this.context;
  }
  // Called at load/font changes, never by draw(): all names are ready before
  // they reach the frame loop. Keep handles by font, spacing, and uppercase text.
  prepareLabels(countries) {
    const role = this.fonts.label;
    const key = JSON.stringify([role.font, role.letterSpacing]);
    let prepared = this.preparedLabels.get(key);
    if (!prepared) { prepared = new Map(); this.preparedLabels.set(key, prepared); }
    this.labelMetrics = prepared;
    const ctx = this.context;
    ctx.font = role.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (this.nativeSpacing) ctx.letterSpacing = '0px';
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const country of countries) {
      const text = country.name.toUpperCase();
      if (prepared.has(text)) continue;
      const pre = prepareFlowText(text, role.font, role);
      const plans = new Map(), ink = new Map();
      let ascent = 0, descent = 0, overhang = 0;
      // Only preparation reads canvas ink bounds. Advances always come from
      // pretext; all possible whole-segment lines and graphemes are cached.
      for (const { segment } of segmenter.segment(text)) {
        if (ink.has(segment)) continue;
        const bounds = ctx.measureText(segment);
        const glyph = { text: segment, left: bounds.actualBoundingBoxLeft, right: bounds.actualBoundingBoxRight,
          ascent: bounds.actualBoundingBoxAscent, descent: bounds.actualBoundingBoxDescent,
          width: measureNaturalWidth(prepareFlowText(segment, role.font)) };
        ink.set(segment, glyph);
        ascent = Math.max(ascent, glyph.ascent); descent = Math.max(descent, glyph.descent);
      }
      for (let start = 0; start < pre.segments.length; start++) {
        for (let end = start + 1; end <= pre.segments.length; end++) {
          const line = pre.segments.slice(start, end).join('').trim();
          if (!line || plans.has(line)) continue;
          const width = measureNaturalWidth(prepareFlowText(line, role.font, role));
          const glyphs = [];
          let prefix = '';
          for (const { segment } of segmenter.segment(line)) {
            prefix += segment;
            const glyph = ink.get(segment);
            // Prefix advances preserve kerning and use terminal spacing once.
            const x = measureNaturalWidth(prepareFlowText(prefix, role.font, role)) - glyph.width - role.letterSpacing;
            glyphs.push({ ...glyph, x });
          }
          if (this.nativeSpacing) ctx.letterSpacing = `${role.letterSpacing}px`;
          const bounds = ctx.measureText(line);
          if (this.nativeSpacing) ctx.letterSpacing = '0px';
          const left = Math.max(this.nativeSpacing ? bounds.actualBoundingBoxLeft : 0, ...glyphs.map(g => g.left - g.x));
          const right = Math.max(this.nativeSpacing ? bounds.actualBoundingBoxRight : 0, ...glyphs.map(g => g.x + g.right));
          const planAscent = Math.max(bounds.actualBoundingBoxAscent, ...glyphs.map(g => g.ascent));
          const planDescent = Math.max(bounds.actualBoundingBoxDescent, ...glyphs.map(g => g.descent));
          ascent = Math.max(ascent, planAscent); descent = Math.max(descent, planDescent);
          overhang = Math.max(overhang, left, right - width);
          plans.set(line, { glyphs, left, right, ascent: planAscent, descent: planDescent });
        }
      }
      // This vendored version includes terminal CSS spacing in natural width
      // (line-break.js: finalizeLinePaintWidth). Add only padding/borders.
      prepared.set(text, { pre, width: measureNaturalWidth(pre) + 22, plans, ascent, inkHeight: ascent + descent, overhang });
    }
  }
  resize(width, height, pixelRatio = 1) {
    const dpr = Math.min(pixelRatio, 2);
    this.viewport = { width, height, focal: Math.min(width, height) * 1.15 };
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  draw(camera, level, geography, options = {}) {
    const start = performance.now();
    const { width, height, focal } = this.viewport;
    const scale = Math.max(1, Math.sqrt((width / level.cellWidth) * (height / level.cellHeight) / MAX_CELLS));
    const cellWidth = level.cellWidth * scale, cellHeight = level.cellHeight * scale;
    const cols = Math.floor(width / cellWidth), rows = Math.floor(height / cellHeight);
    const xOffset = (width - cols * cellWidth) / 2 + cellWidth / 2;
    const yOffset = (height - rows * cellHeight) / 2 + cellHeight / 2;
    this.grid = { cols, rows, cellWidth, cellHeight, x: xOffset - cellWidth / 2, y: yOffset - cellHeight / 2 };
    const { east, north, front } = cameraBasis(camera.latitude, camera.longitude);
    const distance = camera.distance, d2 = distance * distance;
    const sample = { country: 0, coast: false, border: false };
    let visible = 0;
    for (let row = 0; row < rows; row++) {
      const rayY = (height / 2 - (yOffset + row * cellHeight)) / focal;
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        const rayX = (xOffset + col * cellWidth - width / 2) / focal;
        const a = rayX * rayX + rayY * rayY + 1;
        const discriminant = d2 - a * (d2 - 1);
        this.cells[index] = 0;
        this.countryIds[index] = 0;
        this.blockedCells[index] = 1;
        if (discriminant <= 0) continue;
        // Inverse projection bounds work by viewport size instead of world size.
        // Choosing the near root excludes every point behind the visible surface.
        const t = (distance - Math.sqrt(discriminant)) / a;
        const x = t * rayX, y = t * rayY, z = distance - t;
        const wx = east[0] * x + north[0] * y + front[0] * z;
        const wy = north[1] * y + front[1] * z;
        const wz = east[2] * x + north[2] * y + front[2] * z;
        const latitude = Math.asin(Math.max(-1, Math.min(1, wy))) / RAD;
        const longitude = Math.atan2(wx, wz) / RAD;
        geography.sample(latitude, longitude, level, sample);
        this.countryIds[index] = sample.country;
        // A routed cell's corners must stay on the disc, including at the rim.
        const farX = Math.abs(xOffset + col * cellWidth - width / 2) + cellWidth / 2;
        const farY = Math.abs(yOffset + row * cellHeight - height / 2) + cellHeight / 2;
        this.blockedCells[index] = sample.country || farX * farX + farY * farY >= focal * focal / (d2 - 1) ? 1 : 0;
        const facing = (distance * z - 1) / Math.hypot(x, y, distance - z);
        const light = Math.max(0, Math.min(3, Math.floor((facing * 0.85 - x * 0.24 + y * 0.1) * 4)));
        let color = sample.country ? 4 + (level.labels ? Math.max(1, light) : light) : light;
        let variant = sample.country ? 1 : 0;
        if (sample.coast && level.index > 0) { color = 8; variant = 2; }
        if (sample.border && level.borders) { color = 9; variant = 3; }
        if (options.grid && !sample.country && (Math.abs(latitude % 30) < 0.4 || Math.abs(longitude % 30) < 0.4)) { color = 10; variant = 4; }
        this.cells[index] = color + 1;
        this.variants[index] = variant;
        visible++;
      }
    }
    const projected = performance.now();
    const ctx = this.context;
    ctx.clearRect(0, 0, width, height);
    ctx.font = `${level.fontSize * scale}px ${this.fonts.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this.nativeSpacing) ctx.letterSpacing = '0px';
    const oceanPhase = options.animateOcean ? Math.floor((options.time ?? 0) / 900) : 0;
    const glyphs = [level.ocean, level.land, '+', '·', '+'];
    // Batch by palette to avoid thousands of canvas state changes.
    for (let color = 0; color < PALETTE.length; color++) {
      ctx.fillStyle = PALETTE[color];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const index = row * cols + col;
          if (this.cells[index] !== color + 1) continue;
          const variant = this.variants[index];
          let glyph = glyphs[variant];
          if (variant === 0 && (row * 13 + col * 7 + oceanPhase) % 17 === 0) glyph = '~';
          if (variant === 1 && level.index === 0 && (row + col) % 5 === 0) glyph = '+';
          ctx.fillText(glyph, xOffset + col * cellWidth, yOffset + row * cellHeight);
        }
      }
    }
    const labelStart = performance.now();
    const visibleLabels = this.drawLabels(camera, level, geography, options.labels);
    // DOM country pills can occupy water; reserve their rectangles too.
    for (const label of this.labelPlacements) {
      if (label.mode !== 'pill') continue;
      const { box } = label;
      for (let row = Math.max(0, Math.floor((box.y - this.grid.y) / cellHeight)); row < Math.min(rows, Math.ceil((box.y + box.height - this.grid.y) / cellHeight)); row++) {
        for (let col = Math.max(0, Math.floor((box.x - this.grid.x) / cellWidth)); col < Math.min(cols, Math.ceil((box.x + box.width - this.grid.x) / cellWidth)); col++) this.blockedCells[row * cols + col] = 1;
      }
    }
    const placeStart = performance.now();
    const placeMetrics = this.places?.draw(ctx, camera, level, this.viewport, this.grid, this.blockedCells,
      options.labels, options.places !== false) || { visibleMarkers: 0, labelledPlaces: 0 };
    const placeLabelMs = performance.now() - placeStart;
    const labelMs = performance.now() - labelStart;
    const silhouetteLabels = this.labelPlacements.filter(label => label.mode === 'silhouette').length;
    this.metrics = { visibleGlyphs: visible, totalGlyphs: cols * rows, projectionMs: projected - start,
      renderMs: performance.now() - projected, labelMs, visibleLabels, silhouetteLabels,
      fallbackLabels: visibleLabels - silhouetteLabels, ...placeMetrics, placeLabelMs, cellWidth, cellHeight };
    return this.metrics;
  }
  drawLabels(camera, level, geography, enabled) {
    for (const node of this.labelNodes.values()) node.hidden = true;
    this.labelPlacements = [];
    if (!enabled || !level.labels) return 0;
    const occupied = [], { width, height } = this.viewport;
    const { cols, rows } = this.grid;
    const slots = countryRunSlots(this.countryIds, cols, rows, this.grid);
    const fallback = [];
    const role = this.fonts.label, ctx = this.context;
    ctx.font = role.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#e4e4ca';
    if (this.nativeSpacing) ctx.letterSpacing = `${role.letterSpacing}px`;
    const safe = { x: 32, y: 60, width: width - 96, height: height - 150 };
    const labels = [...geography.labels()].sort((a, b) => a.rank - b.rank || a.id - b.id);
    for (const country of labels) {
      const point = project(latLonToCartesian(country.latitude, country.longitude), camera, this.viewport);
      if (!point.visible) continue;
      const text = country.name.toUpperCase();
      const measured = this.labelMetrics?.get(text);
      if (!measured) throw new Error('Country labels must be prepared before drawing.');
      const lines = placeSilhouetteName(text, role, measured, (slots.get(country.id) || []).filter(slot => inside(slot, safe)), point);
      if (!lines || lines.some(line => occupied.some(other => boxesOverlap(line.box, other)))) {
        fallback.push({ country, point, measured });
        continue;
      }
      for (const line of lines) {
        if (this.nativeSpacing) ctx.fillText(line.text, line.x, line.y);
        else for (const glyph of line.glyphs) ctx.fillText(glyph.text, glyph.x, glyph.y);
        occupied.push(line.box);
      }
      this.labelPlacements.push({ id: country.id, name: text, mode: 'silhouette', lines });
    }
    // Silhouette ink owns its ground first. Pills retain the existing viewport
    // margins and collision padding, including against all canvas name lines.
    for (const { country, point, measured } of fallback) {
      const box = { x: point.x - measured.width / 2, y: point.y - 12, width: measured.width, height: 24 };
      if (!inside(box, safe)) continue;
      if (occupied.some(other => box.x < other.x + other.width + 12 && box.x + box.width + 12 > other.x && box.y < other.y + other.height + 8 && box.y + box.height + 8 > other.y)) continue;
      let item = this.labelNodes.get(country.id);
      if (!item) {
        item = document.createElement('span');
        item.className = 'country-label';
        item.textContent = country.name.toUpperCase();
        this.labelLayer.append(item);
        this.labelNodes.set(country.id, item);
      }
      item.labelWidth = measured.width;
      occupied.push(box);
      item.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px) translate(-50%, -50%)`;
      item.hidden = false;
      this.labelPlacements.push({ id: country.id, name: item.textContent, mode: 'pill', box });
    }
    return this.labelPlacements.length;
  }
  // Copy only on explicit inspection, never in the frame loop. Callers cannot
  // mutate the reusable country buffer or the renderer's placement records.
  labelSnapshot() {
    return structuredClone({ labelPlacements: this.labelPlacements, grid: this.grid && { ...this.grid,
      blockedCells: Array.from(this.blockedCells.subarray(0, this.grid.cols * this.grid.rows)),
      countryIds: Array.from(this.countryIds.subarray(0, this.grid.cols * this.grid.rows)) } });
  }
}
