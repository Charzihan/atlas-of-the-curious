/* One atlas, two projections. The hero map is either the flat character map
   (js/map.js, always built) or the character globe (earthxt/app.js, imported
   the first time the globe opens). Both share the viewport, the intro panel,
   the control bar, the legend and the place dialog; only one draws at a time.

   The view follows the URL: #/globe and #/globe/place/<id> open the globe,
   the switch buttons push those hashes, and Back from a globe hash returns to
   the flat map. #/place/<id> (the field-note dialog) keeps whichever view is
   showing, so a globe marker opens its note over the globe. */

const section = document.getElementById("text-atlas");
const globeView = document.getElementById("globe-view");

if (section && globeView) {
  const buttons = [...section.querySelectorAll("[data-view-target]")];
  const panels = [...section.querySelectorAll("[data-for]")];
  let view = "flat";
  let globe = null;

  const isGlobeHash = (hash) => /^#\/globe(?:\/|$)/.test(hash || "");

  function mountGlobe() {
    if (!globe) {
      globe = import("../earthxt/app.js")
        .then((module) => module.mountGlobe({ embedded: true }))
        .catch((error) => {
          console.warn("The globe could not start:", error);
          return null;
        });
    }
    return globe;
  }

  function setView(next) {
    if (next === view) return;
    view = next;
    section.dataset.view = next;
    globeView.hidden = next !== "globe";
    for (const panel of panels) panel.hidden = panel.dataset.for !== next;
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.viewTarget === next));
    }
    // js/map.js pauses its sea and clouds while the globe is up.
    window.dispatchEvent(new CustomEvent("atlas:view", { detail: next }));
    if (next === "globe") mountGlobe().then((controller) => { if (view === "globe") controller?.setActive(true); });
    else globe?.then((controller) => controller?.setActive(false));
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const target = button.dataset.viewTarget;
      if (target === view) return;
      // A globe hash change switches the view itself (see below).
      if (target === "globe") location.hash = "#/globe";
      else if (isGlobeHash(location.hash)) location.hash = "#/";
      else setView("flat");
    });
  }

  window.addEventListener("hashchange", (event) => {
    if (isGlobeHash(location.hash)) {
      setView("globe");
      if (location.hash.startsWith("#/globe/place/")) {
        section.scrollIntoView({ behavior: "instant", block: "start" });
      }
      return;
    }
    // Leaving a globe hash for the bare page (Back, or the flat switch).
    const from = new URL(event.oldURL || location.href).hash;
    if (isGlobeHash(from) && (!location.hash || location.hash === "#/")) setView("flat");
  });

  // Reading a country or a route happens on the flat map.
  for (const name of ["atlas:map-country", "atlas:map-route"]) {
    window.addEventListener(name, () => setView("flat"));
  }

  // One "Pause motion" for both projections: map.js stops its sea and
  // clouds, the globe its rotation and ocean shimmer. Remembered per visitor.
  const motion = document.getElementById("motion-toggle");
  function setMotion(paused) {
    document.documentElement.dataset.motion = paused ? "paused" : "running";
    motion?.setAttribute("aria-pressed", String(paused));
    const label = motion?.querySelector(".motion-label");
    if (label) label.textContent = paused ? "Resume all motion" : "Pause all motion";
    const glyph = motion?.querySelector(".motion-glyph");
    if (glyph) glyph.textContent = paused ? "▷" : "❚❚";
    try { localStorage.setItem("atlas-motion", paused ? "paused" : "running"); } catch (error) { /* private mode */ }
    window.dispatchEvent(new CustomEvent("atlas:motion", { detail: paused }));
  }
  motion?.addEventListener("click", () => setMotion(motion.getAttribute("aria-pressed") !== "true"));
  let savedMotion = null;
  try { savedMotion = localStorage.getItem("atlas-motion"); } catch (error) { /* private mode */ }
  if (savedMotion === "paused") setMotion(true);

  // Search and category feedback where the map shows it, with one way out.
  const filter = document.getElementById("atlas-filter");
  const filterText = document.getElementById("atlas-filter-text");
  window.addEventListener("atlas:filter", (event) => {
    const { shown, total, query, category } = event.detail;
    const active = shown !== total || query || category;
    if (!filter || !filterText) return;
    filter.hidden = !active;
    if (!active) { filterText.textContent = ""; return; }
    const scope = [query && `“${query}”`, category].filter(Boolean).join(" in ");
    filterText.textContent = `${shown} of ${total} places${scope ? ` match ${scope}` : ""}`;
  });
  document.getElementById("atlas-filter-clear")?.addEventListener("click", () => window.ATLAS_CLEAR_FILTER?.());

  // On a phone the map is a short band, so its switch, filter readout and
  // control bars leave it for toolbar rows above and below rather than
  // covering the geography; wider screens float them over the map again.
  const viewport = section.querySelector(".map-viewport");
  const phone = matchMedia("(max-width: 640px)");
  const topBar = document.createElement("div");
  topBar.className = "map-toolbar map-toolbar-top";
  const bottomBar = document.createElement("div");
  bottomBar.className = "map-toolbar map-toolbar-bottom";
  viewport.before(topBar);
  viewport.after(bottomBar);
  const floating = {
    top: [document.getElementById("atlas-filter"), section.querySelector(".view-tools")].filter(Boolean),
    bottom: [...section.querySelectorAll(".map-controls")]
  };
  function placeTools() {
    if (phone.matches) {
      topBar.append(...floating.top);
      bottomBar.append(...floating.bottom);
    } else {
      viewport.prepend(...floating.top);
      viewport.append(...floating.bottom);
    }
  }
  phone.addEventListener("change", placeTools);
  placeTools();

  // The map below takes the room the intro band leaves (css/globe.css).
  const intro = section.querySelector(":scope > .atlas-overlay");
  if (intro && typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      section.style.setProperty("--intro-h", Math.ceil(intro.getBoundingClientRect().height) + "px");
    }).observe(intro);
  }

  if (isGlobeHash(location.hash)) setView("globe");
}
