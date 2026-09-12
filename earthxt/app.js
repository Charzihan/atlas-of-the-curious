import { readFontRoles, readFontFamily, readMapStoryFamily } from '../js/text.js';
import { HOME, EARTH_RADIUS_KM, MIN_DISTANCE, MAX_DISTANCE, clamp, wrapLongitude, distanceToZoom, zoomToDistance } from './geometry.js';
import { LEVELS, selectLOD } from './lod.js';
import { loadGeography, syntheticGeography } from './geography.js';
import { TextRenderer } from './renderer.js';
import { globePlaces, parsePlaceHash } from './places.js';
import { PlaceLayer } from './place-layer.js';
import { readCategoryColors } from '../js/category-colors.js';

const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const state = { ...HOME, targetDistance: HOME.distance, autoRotate: !reducedMotion.matches, source: 'earth', labels: true, grid: false, serif: false };
let geography = null, renderer, level = selectLOD(distanceToZoom(state.distance));
let dirty = true, lastTime = 0, lastOceanPhase = -1, frameId = 0, metricTime = 0, renderedFrames = 0;
let fps = 0, projectionSum = 0, renderSum = 0, averageProjection = 0, averageRender = 0;
let labelSum = 0, averageLabels = 0, frameNumber = 0;
const pointers = new Map();
let pinchDistance = 0;
let placeLayer;
const places = globePlaces(window.ATLAS_DATA?.places || []);

function setRotation(enabled) {
  state.autoRotate = enabled;
  $('rotate-toggle').setAttribute('aria-pressed', String(enabled));
  $('rotate-toggle').setAttribute('aria-label', enabled ? 'Pause automatic rotation' : 'Start automatic rotation');
  $('rotate-icon').textContent = enabled ? 'Ⅱ' : '▷';
  $('rotate-text').textContent = enabled ? 'Pause rotation' : 'Auto-rotate';
  dirty = true;
}
function zoomTo(distance) {
  state.targetDistance = clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
  if (reducedMotion.matches) state.distance = state.targetDistance;
  $('zoom-slider').value = distanceToZoom(state.targetDistance) * 100;
  $('zoom-in').disabled = state.targetDistance <= MIN_DISTANCE + 0.0001;
  $('zoom-out').disabled = state.targetDistance >= MAX_DISTANCE - 0.0001;
  dirty = true;
}
function zoomBy(factor) { zoomTo(1 + (state.targetDistance - 1) * factor); }
function reset() {
  placeLayer?.hide();
  state.latitude = HOME.latitude;
  state.longitude = HOME.longitude;
  setRotation(false);
  zoomTo(HOME.distance);
}
function setSource(source) {
  state.source = source;
  $('source-earth').setAttribute('aria-pressed', String(source === 'earth'));
  $('source-synthetic').setAttribute('aria-pressed', String(source === 'synthetic'));
  $('view-name').textContent = `${source === 'earth' ? 'EARTH' : 'SYNTHETIC'} / LIVE VIEW`;
  $('live-status').textContent = source === 'earth' ? 'Showing Earth geography.' : 'Showing invented synthetic geography.';
  dirty = true;
}
function prepareSerif() {
  if (!state.serif) return;
  const toggle = $('serif-toggle');
  toggle.setAttribute('aria-busy', 'true');
  renderer.preparePalette(level).then(entry => {
    // A late palette can populate the cache, but cannot activate a stale
    // size/LOD or re-enable a switch the user has since turned off.
    if (!state.serif || renderer.paletteFor(level) !== entry) return;
    toggle.setAttribute('aria-busy', 'false');
    $('live-status').textContent = entry.status === 'ready' ? 'Measured glyphs ready.' : entry.reason;
    dirty = true;
  });
}
function updateLOD(next) {
  level = next;
  prepareSerif();
  for (const button of document.querySelectorAll('[data-level]')) {
    const active = Number(button.dataset.level) === next.index;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  $('level-number').textContent = `${String(next.index).padStart(2, '0')} / ${String(LEVELS.length - 1).padStart(2, '0')}`;
  $('view-level').textContent = `${String(next.index).padStart(2, '0')} — ${next.name.toUpperCase()} VIEW`;
  $('view-description').textContent = next.description;
  $('border-legend').hidden = !next.borders;
  $('live-status').textContent = `${next.name} detail. ${next.description}`;
}
function toggleDebug(force) {
  const show = force ?? $('debug-panel').hidden;
  $('debug-panel').hidden = !show;
  $('debug-toggle').setAttribute('aria-expanded', String(show));
  if (show) updateMetrics();
}
const number = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
function updateMetrics() {
  const metrics = renderer.metrics;
  $('coordinates').textContent = `${Math.abs(state.latitude).toFixed(2)}° ${state.latitude >= 0 ? 'N' : 'S'}   ${Math.abs(state.longitude).toFixed(2)}° ${state.longitude >= 0 ? 'E' : 'W'}`;
  $('metric-fps').textContent = fps ? String(Math.round(fps)) : '0';
  $('metric-glyphs').textContent = number.format(metrics.visibleGlyphs);
  $('metric-altitude').textContent = number.format((state.distance - 1) * EARTH_RADIUS_KM);
  $('metric-data').textContent = geography ? `${(geography.loadedBytes / 1024 / 1024).toFixed(2)} MB` : 'Synthetic';
  $('globe').setAttribute('aria-label', `Text globe, ${state.source === 'earth' ? 'Earth' : 'synthetic geography'}, ${level.name.toLowerCase()} detail, centered at ${$('coordinates').textContent}.`);
  if (!$('debug-panel').hidden) {
    const values = {
      'Rendered frames': `${Math.round(fps)} fps`,
      'Visible / screen slots': `${number.format(metrics.visibleGlyphs)} / ${number.format(metrics.totalGlyphs)}`,
      'Current LOD': `${level.index} · ${level.name}`,
      'Camera distance': `${state.distance.toFixed(3)} R⊕`,
      'Projection + lookup': `${averageProjection.toFixed(2)} ms`,
      'Text render + labels': `${averageRender.toFixed(2)} ms`,
      'Name layout + drawing': `${metrics.labelMs.toFixed(2)} ms (avg ${averageLabels.toFixed(2)})`,
      'Visible / labelled places': `${metrics.visibleMarkers} / ${metrics.labelledPlaces}`,
      'Place label placement': `${metrics.placeLabelMs.toFixed(2)} ms`,
      'Place routing + drawing': `${metrics.placeRenderMs.toFixed(2)} ms`,
      'Silhouette / pill names': `${metrics.silhouetteLabels} / ${metrics.fallbackLabels}`,
      'Resident geography': geography ? `${(geography.loadedBytes / 1024).toFixed(1)} KiB` : 'None',
      'JS heap': performance.memory ? `${(performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1)} MiB` : 'Unavailable',
      'Source': state.source === 'earth' ? 'Natural Earth 110m' : 'Synthetic field',
    };
    $('debug-values').replaceChildren(...Object.entries(values).map(([key, value]) => {
      const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = key; dd.textContent = String(value); row.append(dt, dd); return row;
    }));
  }
}
function frame(time) {
  frameId = 0;
  if (document.hidden) return;
  const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.06) : 0;
  lastTime = time;
  if (state.autoRotate && pointers.size === 0) {
    state.longitude = wrapLongitude(state.longitude + dt * 1.6);
    dirty = true;
  }
  if (Math.abs(state.distance - state.targetDistance) > 0.00001) {
    state.distance += (state.targetDistance - state.distance) * (1 - Math.exp(-dt * 12));
    if (Math.abs(state.distance - state.targetDistance) < 0.00001) state.distance = state.targetDistance;
    dirty = true;
  }
  const nextLevel = selectLOD(distanceToZoom(state.distance), level);
  if (nextLevel !== level) { updateLOD(nextLevel); dirty = true; }
  const oceanPhase = reducedMotion.matches ? 0 : Math.floor(time / 900);
  if (oceanPhase !== lastOceanPhase) { dirty = true; lastOceanPhase = oceanPhase; }
  if (dirty) {
    const metrics = renderer.draw(state, level, state.source === 'earth' && geography ? geography : syntheticGeography,
      { labels: state.labels, places: state.source === 'earth', grid: state.grid, serif: state.serif, animateOcean: !reducedMotion.matches, time });
    renderedFrames++;
    frameNumber++;
    projectionSum += metrics.projectionMs;
    renderSum += metrics.renderMs;
    labelSum += metrics.labelMs;
    dirty = false;
  }
  if (time - metricTime >= 600) {
    fps = renderedFrames * 1000 / (time - metricTime);
    averageProjection = renderedFrames ? projectionSum / renderedFrames : 0;
    averageRender = renderedFrames ? renderSum / renderedFrames : 0;
    averageLabels = renderedFrames ? labelSum / renderedFrames : 0;
    updateMetrics();
    renderedFrames = 0; projectionSum = 0; renderSum = 0; labelSum = 0; metricTime = time;
  }
  frameId = requestAnimationFrame(frame);
}
function gestureDistance() {
  const [a, b] = [...pointers.values()];
  return b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}
function setupControls() {
  const canvas = $('globe');
  canvas.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({ preventScroll: true });
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pinchDistance = gestureDistance();
    canvas.classList.add('dragging');
    setRotation(false);
  });
  canvas.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      const sensitivity = 165 * (state.distance - 1) / 2.2 / Math.min(renderer.viewport.width, renderer.viewport.height);
      state.longitude = wrapLongitude(state.longitude - (event.clientX - previous.x) * sensitivity);
      state.latitude = clamp(state.latitude + (event.clientY - previous.y) * sensitivity, -89, 89);
    } else {
      const nextDistance = gestureDistance();
      if (pinchDistance > 0 && nextDistance > 0) zoomBy(pinchDistance / nextDistance);
      pinchDistance = nextDistance;
    }
    dirty = true;
  });
  const endPointer = event => {
    pointers.delete(event.pointerId);
    pinchDistance = gestureDistance();
    if (!pointers.size) canvas.classList.remove('dragging');
  };
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, endPointer);
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? renderer.viewport.height : 1);
    zoomBy(Math.exp(clamp(pixels * 0.0015, -0.5, 0.5)));
  }, { passive: false });
  canvas.addEventListener('keydown', event => {
    const step = 5 * (state.distance - 1) / 2.2;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); setRotation(false);
      if (event.key === 'ArrowLeft') state.longitude = wrapLongitude(state.longitude - step);
      if (event.key === 'ArrowRight') state.longitude = wrapLongitude(state.longitude + step);
      if (event.key === 'ArrowUp') state.latitude = clamp(state.latitude + step, -89, 89);
      if (event.key === 'ArrowDown') state.latitude = clamp(state.latitude - step, -89, 89);
      dirty = true;
    } else if (['+', '=', '-', '0', ' ', 'd', 'D'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '+' || event.key === '=') zoomBy(0.75);
      if (event.key === '-') zoomBy(1 / 0.75);
      if (event.key === '0') reset();
      if (event.key === ' ') setRotation(!state.autoRotate);
      if (event.key.toLowerCase() === 'd') toggleDebug();
    }
  });
  $('zoom-in').addEventListener('click', () => zoomBy(0.72));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / 0.72));
  $('reset-view').addEventListener('click', reset);
  $('rotate-toggle').addEventListener('click', () => setRotation(!state.autoRotate));
  $('zoom-slider').addEventListener('input', event => zoomTo(zoomToDistance(Number(event.target.value) / 100)));
  for (const button of document.querySelectorAll('[data-level]')) button.addEventListener('click', () => zoomTo(LEVELS[Number(button.dataset.level)].targetDistance));
  $('labels-toggle').addEventListener('change', event => { state.labels = event.target.checked; dirty = true; });
  $('grid-toggle').addEventListener('change', event => { state.grid = event.target.checked; dirty = true; });
  $('serif-toggle').addEventListener('change', event => {
    state.serif = event.target.checked;
    event.target.setAttribute('aria-busy', 'false');
    if (state.serif) {
      $('live-status').textContent = 'Preparing measured glyphs…';
      prepareSerif();
    }
    dirty = true;
  });
  $('source-earth').addEventListener('click', () => setSource('earth'));
  $('source-synthetic').addEventListener('click', () => setSource('synthetic'));
  $('debug-toggle').addEventListener('click', () => toggleDebug());
  $('debug-close').addEventListener('click', () => { toggleDebug(false); $('debug-toggle').focus(); });
  for (const name of ['about', 'help']) {
    const dialog = $(`${name}-dialog`);
    $(`${name}-open`).addEventListener('click', () => dialog.showModal());
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
  }
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) setRotation(false); dirty = true; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(frameId); frameId = 0; }
    else { lastTime = 0; metricTime = performance.now(); renderedFrames = 0; projectionSum = 0; renderSum = 0; labelSum = 0; dirty = true; if (!frameId) frameId = requestAnimationFrame(frame); }
  });
}
async function main() {
  const roles = readFontRoles(document, ['globe-label', 'map-label', 'hover-card', 'native-name', 'hover-name', 'hover-loc', 'hover-cta']);
  if (!roles['globe-label']) throw new Error('The globe-label font role is missing.');
  renderer = new TextRenderer($('globe'), $('country-labels'), {
    label: roles['globe-label'], mono: readFontFamily(document, '--font-mono'), serif: readMapStoryFamily(document)
  });
  placeLayer = new PlaceLayer($('globe-stage'), $('globe-markers'), places, roles,
    readCategoryColors(document, window.ATLAS_DATA.categories), {
      standalone: document.documentElement.hasAttribute('data-standalone'), onInspect: () => setRotation(false)
    });
  renderer.places = placeLayer;
  setupControls();
  const resize = (width, height) => {
    if (width <= 0 || height <= 0) return;
    renderer.resize(width, height, devicePixelRatio);
    prepareSerif();
    placeLayer.resize(width, height);
    dirty = true;
  };
  const observer = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    resize(width, height);
  });
  observer.observe($('globe-stage'));
  try { geography = await loadGeography(); }
  catch (error) {
    setSource('synthetic');
    $('source-earth').disabled = true;
    $('data-error').textContent = `${error.message} Showing synthetic geography. Reload to retry loading Earth.`;
    $('data-error').hidden = false;
  }
  renderer.prepareLabels(geography ? geography.labels() : syntheticGeography.labels());
  const stageSize = $('globe-stage').getBoundingClientRect();
  resize(stageSize.width, stageSize.height);
  $('loading').hidden = true;
  setRotation(state.autoRotate);
  zoomTo(state.distance);
  updateLOD(level);
  metricTime = performance.now();
  // Read-only instrumentation for manual profiling and end-to-end verification.
  window.EARTHXT_DEBUG = Object.freeze({ snapshot: ({ includeGeometry = false } = {}) => ({ ...state, lod: level.index, lodId: level.id,
    serifPalette: renderer.paletteSnapshot(level),
    ...renderer.metrics, ...placeLayer.snapshot(), fps, averageProjection, averageRender, averageLabels, frameNumber, loadedBytes: geography?.loadedBytes ?? 0,
    ...(includeGeometry ? renderer.labelSnapshot() : {}),
    countryCount: geography?.countries.length ?? 0, viewport: { ...renderer.viewport },
    reducedMotion: reducedMotion.matches, activePointers: pointers.size, ready: true }) });
  const openHash = () => {
    const id = parsePlaceHash(location.hash);
    const place = places.find(item => item.id === id);
    if (!place || !geography) return;
    setRotation(false);
    setSource('earth');
    state.latitude = place.latitude;
    state.longitude = place.longitude;
    state.distance = LEVELS[2].targetDistance;
    zoomTo(state.distance);
    updateLOD(LEVELS[2]);
    renderer.draw(state, level, geography, { labels: state.labels, places: true, grid: state.grid, serif: state.serif });
    placeLayer.show(id);
    dirty = true;
  };
  window.addEventListener('hashchange', openHash);
  openHash();
  updateMetrics();
  if (!frameId) frameId = requestAnimationFrame(frame);
}
main().catch(error => {
  $('loading').textContent = `Earthxt could not start: ${error.message} Please reload in a browser with Canvas 2D support.`;
});
