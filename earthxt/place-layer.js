import { createMetrics, dirForLang } from '../js/text.js';
import { fitHoverTagline } from '../js/hover-card.js';
import { prepareFlowText } from '../js/map-art.js';
import { measureNaturalWidth } from '../vendor/pretext/layout.js';
import { createPlaceRouter, projectPlaces } from './places.js';

export class PlaceLayer {
  constructor(stage, layer, places, roles, colors, { standalone = false, onInspect = () => {} } = {}) {
    this.stage = stage;
    this.layer = layer;
    this.places = places;
    this.byId = new Map(places.map(place => [place.id, place]));
    this.colors = colors;
    this.roles = roles;
    this.standalone = standalone;
    this.router = createPlaceRouter(places, roles['map-label']);
    this.metrics = createMetrics(roles);
    this.nodes = new Map();
    this.labels = [];
    this.markers = [];
    this.activeId = null;
    this.dismissTimer = 0;
    this.fits = new Map();
    this.plans = new Map();
    // The fallback canvas path uses cached prefix advances, including tracking
    // once. Possible whole-word lines are finite and prepared before animation.
    const role = roles['map-label'];
    for (const place of places) {
      const words = place.name.toUpperCase().split(/\s+/);
      for (let start = 0; start < words.length; start++) for (let end = start + 1; end <= words.length; end++) {
        const text = words.slice(start, end).join(' ');
        if (this.plans.has(text)) continue;
        let prefix = '';
        const glyphs = [];
        for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
          prefix += segment;
          const advance = measureNaturalWidth(prepareFlowText(prefix, role.font, role));
          const width = measureNaturalWidth(prepareFlowText(segment, role.font));
          glyphs.push({ text: segment, x: advance - width - role.letterSpacing });
        }
        this.plans.set(text, glyphs);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'globe-marker';
      button.dataset.id = place.id;
      button.setAttribute('aria-label', `${place.name}, ${place.country}`);
      button.setAttribute('aria-describedby', 'globe-place-card');
      button.style.setProperty('--accent', colors.get(place.category));
      button.hidden = true;
      const inspect = () => { onInspect(); this.show(place.id); };
      button.addEventListener('pointerenter', inspect);
      button.addEventListener('focus', inspect);
      button.addEventListener('pointerleave', () => this.scheduleHide());
      button.addEventListener('blur', () => this.scheduleHide());
      button.addEventListener('click', () => {
        if (standalone) inspect();
        else window.location.assign(`../#/place/${encodeURIComponent(place.id)}`);
      });
      layer.append(button);
      this.nodes.set(place.id, button);
    }
    this.card = document.createElement('div');
    this.card.id = 'globe-place-card';
    this.card.className = 'map-card';
    this.card.setAttribute('role', 'region');
    this.card.setAttribute('aria-label', 'Place preview');
    this.card.hidden = true;
    this.parts = {};
    for (const [name, tag] of [['name', 'span'], ['native', 'span'], ['loc', 'span'], ['tag', 'pre'], ['cta', standalone ? 'p' : 'a']]) {
      const element = document.createElement(tag);
      element.className = `map-card-${name}`;
      this.parts[name] = element;
      this.card.append(element);
    }
    stage.append(this.card);
    this.card.addEventListener('pointerenter', () => clearTimeout(this.dismissTimer));
    this.card.addEventListener('pointerleave', () => this.scheduleHide());
    this.card.addEventListener('focusin', () => clearTimeout(this.dismissTimer));
    this.card.addEventListener('focusout', () => this.scheduleHide());
    stage.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.activeId) { event.preventDefault(); this.hide(); }
    });
  }
  // Resize callbacks run outside draw. Measure every card there so neither a
  // hash-open nor a card following a moving marker can prepare text in a frame.
  resize(width, height) {
    this.size = { width, height };
    this.fits.clear();
    const maxWidth = Math.max(40, Math.min(222, width - 46));
    for (const place of this.places) {
      const fit = fitHoverTagline(place.tagline, {
        maxWidth, minWidth: Math.min(160, maxWidth),
        linesOfText: (text, room) => this.metrics.linesOfText('hover-card', text, room),
        tightWidthOfText: (text, room) => this.metrics.tightWidthOfText('hover-card', text, room)
      });
      const story = new Intl.Segmenter('en', { granularity: 'sentence' }).segment(place.story);
      const excerpt = Array.from(story).slice(0, 2).map(part => part.segment).join('').trim();
      const cta = this.standalone ? excerpt : 'Open field note →';
      const native = place.nativeName !== place.name ? place.nativeName : '';
      let textWidth = fit.width;
      for (const [role, text] of [['hover-name', place.name], ['native-name', native], ['hover-loc', place.country.toUpperCase()], ['hover-cta', cta]]) {
        if (text) textWidth = Math.max(textWidth, this.metrics.tightWidthOfText(role, text, maxWidth));
      }
      this.fits.set(place.id, { width: Math.ceil(Math.min(maxWidth, textWidth)) + 30, lines: fit.lines, native, cta });
    }
    if (this.activeId) this.show(this.activeId);
  }
  show(id) {
    const place = this.byId.get(id), fit = this.fits.get(id);
    if (!place || !fit) return;
    clearTimeout(this.dismissTimer);
    this.activeId = id;
    this.card.dataset.id = id;
    this.card.style.setProperty('--accent', this.colors.get(place.category));
    this.card.style.width = `${fit.width}px`;
    this.parts.name.textContent = place.name;
    this.parts.native.textContent = fit.native;
    this.parts.native.hidden = !fit.native;
    this.parts.native.lang = place.nativeLang || '';
    this.parts.native.dir = dirForLang(place.nativeLang);
    this.parts.loc.textContent = place.country;
    this.parts.tag.textContent = fit.lines.join('\n');
    this.parts.cta.textContent = fit.cta;
    if (!this.standalone) this.parts.cta.href = `../#/place/${encodeURIComponent(id)}`;
    this.card.hidden = false;
    // One layout read on inspection/resize; moving frames only write position.
    this.cardSize = { width: this.card.offsetWidth, height: this.card.offsetHeight };
    this.positionCard();
  }
  scheduleHide() {
    clearTimeout(this.dismissTimer);
    this.dismissTimer = setTimeout(() => {
      if (this.nodes.get(this.activeId) === document.activeElement || this.card.contains(document.activeElement) || this.card.matches(':hover')) return;
      this.hide();
    }, 160);
  }
  hide() {
    clearTimeout(this.dismissTimer);
    this.activeId = null;
    this.card.hidden = true;
  }
  positionCard() {
    if (!this.activeId || !this.cardSize || !this.size) return;
    const marker = this.markers.find(point => point.id === this.activeId && point.visible);
    if (!marker) { this.hide(); return; }
    const { width, height } = this.cardSize;
    const right = marker.x + 18 + width <= this.size.width - 8;
    this.card.dataset.side = right ? 'right' : 'left';
    const x = Math.max(8, Math.min(this.size.width - width - 8, right ? marker.x + 18 : marker.x - width - 18));
    const y = Math.max(8, Math.min(this.size.height - height - 8, marker.y - height / 2));
    this.card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  draw(ctx, camera, level, viewport, grid, blocked, enabled, earth) {
    this.markers = projectPlaces(this.places, camera, viewport, grid);
    if (!earth) for (const marker of this.markers) marker.visible = false;
    const out = this.router.update(camera, level, viewport, grid, blocked, this.markers, enabled && earth);
    this.labels = out.labels;
    this.markerCells = Array.from(out.markerCells);
    const role = this.roles['map-label'];
    ctx.font = role.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const nativeSpacing = 'letterSpacing' in ctx;
    if (nativeSpacing) ctx.letterSpacing = `${role.letterSpacing}px`;
    for (const label of this.labels) {
      ctx.fillStyle = this.colors.get(this.byId.get(label.id).category);
      for (const line of label.lines) {
        const x = grid.x + (label.dir > 0 ? label.col * grid.cellWidth : (label.col + 1) * grid.cellWidth - line.width);
        const y = grid.y + line.row * grid.cellHeight;
        if (nativeSpacing) ctx.fillText(line.text, x, y);
        else for (const glyph of this.plans.get(line.text) || []) ctx.fillText(glyph.text, x + glyph.x, y);
      }
    }
    for (const marker of this.markers) {
      const node = this.nodes.get(marker.id);
      node.hidden = !marker.visible;
      if (!marker.visible) continue;
      node.style.transform = `translate(${marker.x}px, ${marker.y}px) translate(-50%, -50%)`;
      ctx.fillStyle = this.colors.get(this.byId.get(marker.id).category);
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    this.positionCard();
    return { visibleMarkers: this.markers.filter(point => point.visible).length, labelledPlaces: this.labels.length };
  }
  snapshot() {
    return structuredClone({ placeCount: this.places.length, placeLabels: this.labels,
      labelCells: this.labels.map(label => ({ id: label.id, cells: label.cells })),
      markerCells: this.markerCells || [], markers: this.markers, placeLayoutPasses: this.router.passes() });
  }
}
