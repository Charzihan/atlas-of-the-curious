/* Cooperative gestures for the hero map. The map sits in the page's scroll
   path, so a plain wheel turn always scrolls the page and zooming takes
   Ctrl/⌘ (or the + and − buttons and keys). A blocked attempt shows a brief
   hint over whichever projection is showing. */
const hint = typeof document !== "undefined" ? document.getElementById("gesture-hint") : null;
let timer = 0;

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

/** True when this wheel event should zoom the map. */
export function wheelZooms(event) {
  if (!hint) return true; // pages without the hint (the globe bench) keep plain wheel zoom
  if (event.ctrlKey || event.metaKey) return true;
  show(`Hold ${mac ? "⌘" : "Ctrl"} while scrolling to zoom — or use + and −`);
  return false;
}

export function show(text) {
  if (!hint) return;
  hint.textContent = text;
  hint.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { hint.hidden = true; }, 1600);
}
