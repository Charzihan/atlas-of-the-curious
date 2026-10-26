/* Crowded dots: a touch hit area is wider than the ring it serves, so near
   neighbours' areas overlap and the topmost one would answer a tap meant for
   the ring beside it. Both projections route a pointer click to the enabled
   marker whose centre is nearest the tap instead. Keyboard activation
   (detail 0) is left alone. */
export function routeToNearest(container, selector) {
  container.addEventListener("click", (event) => {
    const hit = event.target.closest(selector);
    if (!hit || event.detail === 0) return;
    let best = hit, bestDistance = Infinity;
    for (const el of container.querySelectorAll(selector)) {
      if (el.hidden || el.classList.contains("is-dimmed")) continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const d = Math.hypot(r.left + r.width / 2 - event.clientX, r.top + r.height / 2 - event.clientY);
      if (d < bestDistance) { bestDistance = d; best = el; }
    }
    if (best === hit) return;
    event.preventDefault();
    event.stopPropagation();
    best.click();
  }, true);
}
