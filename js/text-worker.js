/* Atlas of the Curious — the map's text layout, off the main thread.

   A same-origin ES module worker (`new Worker("js/text-worker.js", { type:
   "module" })`, allowed by the page's `default-src 'self'` CSP without a
   `worker-src` of its own). It owns three things:

     - the label placement engine (js/labels.js): the Phase 1 coastline routing,
       the occupancy mask and the ocean names;
     - the sea-text engine (js/sea.js): the tagline that spills into the water on
       hover, and the sentences that drift along the ocean rows when the page has
       been left alone;
     - the prepared pretext handles behind both. They are prepared here, once, and
       never leave: only cells, widths and text come back.

   pretext runs unchanged in here. vendor/pretext/measurement.js reaches for
   `OffscreenCanvas` before it reaches for `document`, and `Intl.Segmenter` — the
   other thing it needs — exists in workers too, so the same module that measures
   in the page measures in the worker, with the same font strings.

   The protocol is deliberately dumb. Every request carries a sequence number and
   every reply carries it back, so js/map.js can drop a reply that a newer request
   has already overtaken; nothing here is ever awaited on the main thread. The
   idle frames — the one hot path — come back as a Float32Array that is
   transferred rather than copied: four numbers per drifting sentence (its key,
   its column, its alpha and whether it is held still). The strings are sent once,
   when a sentence is first routed, and referred to by key ever after. */
import { createLabelEngine } from "./labels.js";
import { createSeaEngine } from "./sea.js";
import { prepareWithSegments, measureNaturalWidth } from "../vendor/pretext/layout.js";

import { createMapArtEngine } from "./map-art.js";
const art = createMapArtEngine();
const labels = createLabelEngine();
const sea = createSeaEngine();
let ready = false;

function reply(msg, transfer) {
  if (transfer && transfer.length) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

self.onmessage = function (e) {
  const m = e.data;
  if (!m || typeof m.type !== "string") return;

  switch (m.type) {
    case "art": {
      const result = art[m.action](m.request);
      reply({ type: "art", action: m.action, seq: m.seq, build: m.build, result });
      break;
    }
    case "init": {
      // The land grid arrives once, transferred, and never changes.
      labels.setGrid({ cols: m.cols, rows: m.rows, land: new Uint8Array(m.land) });
      labels.setRoles(m.roles);
      if (m.oceans) labels.setOceans(m.oceans);
      labels.setPlaces(m.places);
      sea.setGrid({
        cols: m.cols, rows: m.rows,
        land: labels.land(), occupancy: labels.occupancy()
      });
      sea.setStories(m.stories || []);
      ready = true;
      reply({ type: "ready", sentences: sea.sentencePool() });
      break;
    }

    // The map was (re)built at a new cell size: the grid font and the marker
    // cells move, the land does not.
    case "geom": {
      sea.setFont({ font: m.font, charW: m.charW });
      if (m.markers) labels.setMarkerCells(m.markers);
      /* And the one thing that could silently differ between the two hosts:
         which face the font string actually resolved to. There is no @font-face
         anywhere in the site — every role is a stack of local faces — so the
         worker and the page are looking at the same installed fonts and there is
         nothing to load in here. But "should resolve the same" is an assumption,
         and a worker that fell through to a different fallback would measure a
         different advance, put the character grid and its own measurements out
         of step, and land glyphs on the coast. So the advance the worker gets for
         the grid's own reference string goes back with every geometry change and
         js/map.js compares it with the width it measured in the page. */
      try {
        reply({
          type: "metrics", build: m.build, font: m.font,
          charW: measureNaturalWidth(prepareWithSegments(m.ref, m.font)) / m.ref.length
        });
      } catch (e) {
        reply({ type: "metrics", build: m.build, font: m.font, charW: 0 });
      }
      break;
    }

    case "place": {
      if (!ready) return;
      const t0 = performance.now();
      const out = labels.place({
        tier: m.tier, zoom: m.zoom, cellW: m.cellW, dotCells: m.dotCells,
        oceanOn: m.oceanOn, nativeNames: m.nativeNames, visible: m.visible
      });
      reply({
        type: "placed", seq: m.seq, build: m.build, tier: out.tier, zoom: out.zoom,
        // The pass's own cost, not the round trip: js/map.js reports this as
        // the placement time, so the number means the same thing on both hosts.
        ms: performance.now() - t0,
        labels: out.labels, oceans: out.oceans
      });
      break;
    }

    case "sea-hover": {
      if (!ready) return;
      reply({
        type: "sea-text", seq: m.seq, build: m.build, id: m.id,
        text: sea.hover({ id: m.id, col: m.col, row: m.row, extend: m.extend })
      });
      break;
    }

    // The cells the page's own floating chrome covers. They are not water:
    // text behind an opaque panel cannot be read, and a drifting word behind
    // a link in one would answer a click with a navigation.
    case "sea-obstacles": { sea.setObstacles(m.rects); break; }

    case "idle-start": { sea.startIdle(m.now); break; }
    case "idle-stop": { sea.stopIdle(); break; }
    case "idle-pause": { sea.setPaused(m.key); break; }

    case "idle-frame": {
      if (!ready) return;
      const out = sea.idleFrame(m.now);
      // [n, (key, col, alpha, paused) × n] — everything else about a sentence
      // (its text, its rows, its words and their offsets) is static and was
      // sent with `fresh` the frame it was routed.
      const frame = new Float32Array(1 + out.sentences.length * 4);
      frame[0] = out.sentences.length;
      let at = 1;
      for (const s of out.sentences) {
        frame[at++] = s.key;
        frame[at++] = s.col;
        frame[at++] = s.alpha;
        frame[at++] = s.paused;
      }
      reply({
        type: "idle", seq: m.seq, build: m.build, frame: frame,
        fresh: out.fresh, retired: out.retired, active: out.active
      }, [frame.buffer]);
      break;
    }
  }
};
