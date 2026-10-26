import { createMetrics, dirForLang } from '../js/text.js';
import { fitHoverTagline } from '../js/hover-card.js';
import { prepareFlowText } from '../js/map-art.js';
import { measureNaturalWidth } from '../vendor/pretext/layout.js';
import { createPlaceRouter, projectPlaces } from './places.js';
import { categoryGlyph } from '../js/category-colors.js';

const MAX_LEADER = 80;

export class PlaceLayer {
  constructor(stage, layer, places, roles, colors, { standalone = false, onInspect = () => {},
    placeHref = id => `../#/place/${encodeURIComponent(id)}`, onCluster = null } = {}) {
    this.placeHref = placeHref;
    this.ringFont = roles['map-label'].font.replace(/[\d.]+px/, '8px');
    this.categoryLabels = new Map((globalThis.ATLAS_DATA?.categories || []).map(category => [category.id, category.label]));
    this.onCluster = onCluster;
    this.clusterByKey = new Map();
    this.onInspect = onInspect;
    this.clustered = new Set();
    this.dimmed = new Set();
    const view = stage.ownerDocument?.defaultView;
    const css = view?.getComputedStyle ? view.getComputedStyle(stage) : null;
    this.ground = css?.getPropertyValue('--bg').trim() || '#0b1020';
    this.clusterInk = css?.getPropertyValue('--gold').trim() || '#e8b45a';
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
    this.markerCells = new Set();
    this.drawMetrics = { visibleMarkers: 0, labelledPlaces: 0, placeLabelMs: 0 };
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
      const category = this.categoryLabel(place.category);
      button.setAttribute('aria-label', `${place.name}, ${place.country}${category ? ` — ${category}` : ''}`);
      button.setAttribute('aria-describedby', 'globe-place-card');
      button.style.setProperty('--accent', `var(--category-${place.category}, var(--gold))`);
      button.hidden = true;
      const inspect = () => { if (this.restoring) return; onInspect(); this.show(place.id); };
      button.addEventListener('pointerenter', inspect);
      button.addEventListener('focus', inspect);
      button.addEventListener('pointerleave', () => this.scheduleHide());
      button.addEventListener('blur', () => this.scheduleHide());
      button.addEventListener('click', () => {
        if (standalone) inspect();
        else if (placeHref(place.id) === window.location.hash) {
          // The atlas keeps a closed note's hash; re-run its route to reopen.
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        } else window.location.assign(placeHref(place.id));
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
    for (const [name, tag] of [['cat', 'span'], ['name', 'span'], ['native', 'span'], ['loc', 'span'], ['tag', 'pre'], ['cta', standalone ? 'p' : 'a']]) {
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
      // The category pill is tracked uppercase in a padded, bordered box.
      const pill = `${categoryGlyph(place.category)} ${this.categoryLabel(place.category)}`.toUpperCase();
      textWidth = Math.max(textWidth, this.metrics.tightWidthOfText('hover-loc', pill, maxWidth * 2) * 1.12 + 22);
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
    this.card.style.setProperty('--accent', `var(--category-${place.category}, var(--gold))`);
    this.card.style.width = `${fit.width}px`;
    // Category in words and in its glyph, as on the flat map's card.
    this.parts.cat.textContent = `${categoryGlyph(place.category)} ${this.categoryLabel(place.category)}`;
    this.parts.cat.style.color = `var(--category-${place.category}, var(--gold))`;
    this.parts.name.textContent = place.name;
    this.parts.native.textContent = fit.native;
    this.parts.native.hidden = !fit.native;
    this.parts.native.lang = place.nativeLang || '';
    this.parts.native.dir = dirForLang(place.nativeLang);
    this.parts.loc.textContent = place.country;
    this.parts.tag.textContent = fit.lines.join('\n');
    this.parts.cta.textContent = fit.cta;
    if (!this.standalone) this.parts.cta.href = this.placeHref(id);
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
    // Never strand keyboard focus in a vanishing card: hand it back to the
    // ring it came from, or to the globe when that ring has gone.
    if (this.card.contains(document.activeElement)) {
      const origin = this.nodes.get(this.activeId);
      this.restoring = true;
      (origin && !origin.hidden ? origin : this.stage.querySelector('canvas'))?.focus({ preventScroll: true });
      this.restoring = false;
    }
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
    projectPlaces(this.places, camera, viewport, grid, this.markers);
    if (!earth) for (const marker of this.markers) marker.visible = false;
    const out = this.router.update(camera, level, viewport, grid, blocked, this.markers, enabled && earth);
    this.labels = out.labels;
    this.markerCells = out.markerCells;
    this.clustered = this.clusterMarkers(ctx, level);
    const role = this.roles['map-label'];
    ctx.font = role.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const nativeSpacing = 'letterSpacing' in ctx;
    if (nativeSpacing) ctx.letterSpacing = `${role.letterSpacing}px`;
    const markerById = new Map(this.markers.map(marker => [marker.id, marker]));
    for (const label of this.labels) {
      if (this.dimmed.has(label.id)) continue;
      const color = this.colors.get(this.byId.get(label.id).category);
      ctx.fillStyle = color;
      // A name routed away from its dot gets a hairline back to the ring.
      const marker = markerById.get(label.id), first = label.lines[0];
      if (this.clustered.has(label.id)) continue;
      if (marker?.visible && first) {
        const x0 = grid.x + (label.dir > 0 ? label.col * grid.cellWidth : (label.col + 1) * grid.cellWidth - first.width);
        const y0 = grid.y + first.row * grid.cellHeight;
        const nx = Math.max(x0, Math.min(marker.x, x0 + first.width));
        const ny = Math.max(y0, Math.min(marker.y, y0 + grid.cellHeight));
        const gap = Math.hypot(nx - marker.x, ny - marker.y);
        // A name routed this far no longer reads as its dot's; the card has it.
        if (gap > MAX_LEADER) continue;
        if (gap > 14) {
          const ux = (nx - marker.x) / gap, uy = (ny - marker.y) / gap;
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(marker.x + ux * 7, marker.y + uy * 7);
          ctx.lineTo(nx - ux * 2, ny - uy * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      for (const line of label.lines) {
        const x = grid.x + (label.dir > 0 ? label.col * grid.cellWidth : (label.col + 1) * grid.cellWidth - line.width);
        const y = grid.y + line.row * grid.cellHeight;
        if (nativeSpacing) ctx.fillText(line.text, x, y);
        else for (const glyph of this.plans.get(line.text) || []) ctx.fillText(glyph.text, x + glyph.x, y);
      }
    }
    let visibleMarkers = 0;
    const clustered = this.clustered;
    // Ring glyphs in the registry's map face, at ring size.
    ctx.font = this.ringFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (nativeSpacing) ctx.letterSpacing = '0px';
    for (const marker of this.markers) {
      const node = this.nodes.get(marker.id);
      node.hidden = !marker.visible || clustered.has(marker.id);
      if (!marker.visible) continue;
      if (clustered.has(marker.id)) { visibleMarkers++; continue; }
      visibleMarkers++;
      node.style.transform = `translate(${marker.x}px, ${marker.y}px) translate(-50%, -50%)`;
      // The atlas marker: a ground-coloured disc in a category ring, with a
      // bright core. Places outside the atlas filter fade to background.
      const color = this.colors.get(this.byId.get(marker.id).category);
      ctx.globalAlpha = this.dimmed.has(marker.id) ? 0.18 : 1;
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = this.ground;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      // The category glyph in the ring, as in the flat map's markers.
      ctx.fillStyle = color;
      ctx.fillText(categoryGlyph(this.byId.get(marker.id).category), marker.x, marker.y + 0.5);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    this.positionCard();
    this.drawMetrics.visibleMarkers = visibleMarkers;
    this.drawMetrics.labelledPlaces = this.labels.length;
    this.drawMetrics.placeLabelMs = out.placeLabelMs;
    return this.drawMetrics;
  }
  categoryLabel(id) { return this.categoryLabels.get(id) || ''; }
  /** At planet scale, rings closer than a ring's width merge into one count
   * that zooms toward its places (`onCluster`); returns the merged ids. */
  clusterMarkers(ctx, level) {
    const merged = new Set(), live = new Set();
    const retire = () => {
      // A cluster that dissolved while focused hands focus to the globe.
      for (const [key, button] of this.clusterByKey) {
        if (live.has(key)) continue;
        if (button === document.activeElement) {
          this.restoring = true;
          this.stage.querySelector('canvas')?.focus({ preventScroll: true });
          this.restoring = false;
        }
        button.remove();
        this.clusterByKey.delete(key);
      }
    };
    if (!this.onCluster || level.index !== 0) { retire(); return merged; }
    const groups = [];
    for (const marker of this.markers) {
      if (!marker.visible || this.dimmed.has(marker.id)) continue;
      const near = groups.find(group => Math.hypot(group.x - marker.x, group.y - marker.y) < 15);
      if (near) {
        near.members.push(marker);
        near.x = near.members.reduce((sum, m) => sum + m.x, 0) / near.members.length;
        near.y = near.members.reduce((sum, m) => sum + m.y, 0) / near.members.length;
      } else groups.push({ x: marker.x, y: marker.y, members: [marker] });
    }
    for (const group of groups) {
      if (group.members.length < 2) continue;
      // A cluster is its membership, so a focused one keeps its places while
      // the globe turns beneath it.
      const key = group.members.map(member => member.id).sort().join('|');
      live.add(key);
      for (const member of group.members) merged.add(member.id);
      ctx.beginPath();
      ctx.arc(group.x, group.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = this.ground;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this.clusterInk;
      ctx.stroke();
      ctx.fillStyle = this.clusterInk;
      ctx.font = this.roles['hover-cta'].font; // the card's sans, from the registry
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.fillText(String(group.members.length), group.x, group.y + 0.5);
      let button = this.clusterByKey.get(key);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'globe-marker globe-cluster';
        button.addEventListener('click', () => this.onCluster(button.places));
        // Reaching for a cluster stops the globe, as reaching for a ring does.
        button.addEventListener('pointerenter', () => this.onInspect());
        button.addEventListener('focus', () => { if (!this.restoring) this.onInspect(); });
        this.layer.append(button);
        this.clusterByKey.set(key, button);
      }
      button.places = group.members.map(member => this.byId.get(member.id));
      button.setAttribute('aria-label', `${group.members.length} places close together: ${button.places.map(place => place.name).join(', ')}. Zoom in to separate them.`);
      button.style.setProperty('--accent', 'var(--gold)');
      button.style.transform = `translate(${group.x}px, ${group.y}px) translate(-50%, -50%)`;
      button.hidden = false;
    }
    ctx.textAlign = 'left';
    retire();
    return merged;
  }
  /** Mirror the atlas search/category filter: `ids` is the visible set, or null for all. */
  setFilter(ids) {
    this.dimmed = new Set(ids ? this.places.filter(place => !ids.has(place.id)).map(place => place.id) : []);
    for (const [id, node] of this.nodes) {
      const out = this.dimmed.has(id);
      node.tabIndex = out ? -1 : 0;
      node.classList.toggle('is-dimmed', out);
      // Filtered out means out of the accessibility tree too.
      node.inert = out;
      if (out) node.setAttribute('aria-hidden', 'true');
      else node.removeAttribute('aria-hidden');
    }
    if (this.activeId && this.dimmed.has(this.activeId)) this.hide();
  }
  snapshot() {
    return structuredClone({ placeCount: this.places.length, placeLabels: this.labels,
      labelCells: this.labels.map(label => ({ id: label.id, cells: label.cells })),
      markerCells: Array.from(this.markerCells), markers: this.markers, placeLayoutPasses: this.router.passes() });
  }
}
