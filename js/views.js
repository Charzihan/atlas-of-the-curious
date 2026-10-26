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

  if (isGlobeHash(location.hash)) setView("globe");
}
