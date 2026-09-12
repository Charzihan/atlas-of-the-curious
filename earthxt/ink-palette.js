import { createMapArtEngine } from '../js/map-art.js';

// Font size follows cell height, so geometry + family + raster DPR fully
// describe the measurement. Viewport rows/columns and camera are irrelevant.
function paletteRequest(family, cellWidth, cellHeight, dpr) {
  return { family, charW: cellWidth, lineH: cellHeight, size: cellHeight, dpr, cols: 1, rows: 1 };
}
function paletteKey(request) {
  return JSON.stringify([request.family, request.charW, request.lineH, request.dpr]);
}

export class InkPaletteCache {
  constructor(build) {
    const engine = createMapArtEngine();
    this.build = build || (request => engine.paletteAsync(request));
    this.entries = new Map();
  }
  get(family, cellWidth, cellHeight, dpr) {
    return this.entries.get(paletteKey(paletteRequest(family, cellWidth, cellHeight, dpr)));
  }
  prepare(family, cellWidth, cellHeight, dpr) {
    const request = paletteRequest(family, cellWidth, cellHeight, dpr), key = paletteKey(request);
    const hit = this.entries.get(key);
    if (hit) return hit.promise;
    const entry = { key, status: 'building', palette: null, reason: '' };
    this.entries.set(key, entry);
    entry.promise = Promise.resolve().then(() => this.build(request)).then(palette => {
      entry.palette = palette;
      entry.status = palette.usable ? 'ready' : 'unavailable';
      entry.reason = palette.reason;
      if (palette.usable) {
        // On dark ground, ink density is brightness: light=0 is the dim limb,
        // light=3 the bright interior. Coasts always carry the densest ink.
        entry.land = [0.3, 0.47, 0.63, 0.8, 1].map(tone => palette.ramp[Math.round(tone * (palette.levels - 1))]);
        entry.ocean = palette.ramp.slice(0, Math.floor((palette.levels - 1) * 0.1) + 1);
      }
      return entry;
    }).catch(error => {
      entry.status = 'unavailable';
      entry.reason = `The measured glyph palette is unavailable: ${error.message}`;
      return entry;
    });
    return entry.promise;
  }
}
