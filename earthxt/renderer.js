import { cameraBasis, latLonToCartesian, project, RAD } from './geometry.js';

const PALETTE = ['#213e42', '#2e5558', '#3c6969', '#598580', '#45695a', '#73977a', '#a0bea0', '#c6dfb3', '#dfd4a6', '#dcad79', '#3b5651'];
const MONO = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';
const MAX_CELLS = 24000;

/** Display adapter: geography is painted exclusively with browser text glyphs. */
export class TextRenderer {
  constructor(canvas, labelLayer) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: true });
    if (!this.context) throw new Error('This browser cannot create a 2D text canvas.');
    this.labelLayer = labelLayer;
    this.labelNodes = new Map();
    this.viewport = { width: 1, height: 1, focal: 1 };
    this.metrics = { visibleGlyphs: 0, totalGlyphs: 0, projectionMs: 0, renderMs: 0, visibleLabels: 0 };
    this.cells = new Uint8Array(MAX_CELLS);
    this.variants = new Uint8Array(MAX_CELLS);
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
        const facing = (distance * z - 1) / Math.hypot(x, y, distance - z);
        const light = Math.max(0, Math.min(3, Math.floor((facing * 0.85 - x * 0.24 + y * 0.1) * 4)));
        let color = sample.country ? 4 + light : light;
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
    ctx.font = `${level.fontSize * scale}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
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
    const visibleLabels = this.drawLabels(camera, level, geography, options.labels);
    this.metrics = { visibleGlyphs: visible, totalGlyphs: cols * rows, projectionMs: projected - start,
      renderMs: performance.now() - projected, visibleLabels, cellWidth, cellHeight };
    return this.metrics;
  }
  drawLabels(camera, level, geography, enabled) {
    for (const node of this.labelNodes.values()) node.hidden = true;
    if (!enabled || !level.labels) return 0;
    const occupied = [], { width, height } = this.viewport;
    const labels = [...geography.labels()].sort((a, b) => a.rank - b.rank || a.id - b.id);
    for (const country of labels) {
      const point = project(latLonToCartesian(country.latitude, country.longitude), camera, this.viewport);
      if (!point.visible) continue;
      let item = this.labelNodes.get(country.id);
      if (!item) {
        item = document.createElement('span');
        item.className = 'country-label';
        item.textContent = country.name.toUpperCase();
        this.context.font = `10px ${MONO}`;
        item.labelWidth = this.context.measureText(item.textContent).width + 22;
        this.labelLayer.append(item);
        this.labelNodes.set(country.id, item);
      }
      const box = { x: point.x - item.labelWidth / 2, y: point.y - 12, width: item.labelWidth, height: 24 };
      if (box.x < 32 || box.y < 60 || box.x + box.width > width - 64 || box.y + box.height > height - 90) continue;
      if (occupied.some(other => box.x < other.x + other.width + 12 && box.x + box.width + 12 > other.x && box.y < other.y + other.height + 8 && box.y + box.height + 8 > other.y)) continue;
      occupied.push(box);
      item.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px) translate(-50%, -50%)`;
      item.hidden = false;
    }
    return occupied.length;
  }
}
