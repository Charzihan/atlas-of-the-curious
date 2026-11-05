# Atlas of the Curious

**Live site: [charzihan.github.io/atlas-of-the-curious](https://charzihan.github.io/atlas-of-the-curious/)**

A hand-curated atlas of 40 extraordinary places on Earth: salt mirrors, sunken island seas, singing dunes, blue ice caves and carved cities. The world is drawn entirely in text characters.

It is a static site with no build step and no runtime network requests. The one runtime library, [`@chenglou/pretext`](https://github.com/chenglou/pretext), is vendored for reflow-free text measurement.

## What's in it

- **Two views of the world.** Switch between them at the top right of the map.
  - **Flat:** a character map with real coastlines, drifting ASCII clouds and a living sea. Place names are routed through open water.
  - **Globe:** a turning text globe (`#/globe`) with countries, relief, shelf seas and rivers. On wide screens it fills the window.
- **40 places in 7 categories.** Each has a story, a field note, the best time to visit, the nearest city, and its name in the local script.
- **Typeset reading.**
  - A detail dialog laid out as an editorial spread, with justified columns.
  - A paginated field guide ("Read as a book") that prints exactly as shown on screen.
  - A private notebook for each place, stored only in your browser.
- **Search and filters.** Live search, category chips and sorting, all kept in the URL. A daily pick, "Surprise me", and "Locate me".
- **Works offline.** A service worker caches the site, and it can be installed as an app.

## Run it locally

Needs Node (version pinned in `.node-version`) and pnpm:

```sh
pnpm install   # also vendors pretext into vendor/
pnpm start     # http://localhost:8000
```

Any static server works, and so does opening `index.html` from disk.

## Rebuilding generated assets

Generated files are committed. Rebuild them only when their inputs change:

| Command | What it does |
| --- | --- |
| `pnpm build` | Validate the dataset and generate the `places/<id>/` share pages. Run it after editing `js/data.js`. |
| `pnpm validate` | Dataset checks, plus headless text-overflow and line-break checks. |
| `pnpm build-map` | Rasterize the flat map from Natural Earth 1:110m (`data/*.geojson`). |
| `pnpm fetch:earthxt-sources` then `pnpm build:earthxt-data` | Download and rebuild the globe's countries, relief and rivers. See [`earthxt/data/README.md`](earthxt/data/README.md). |
| `pnpm vendor` | Re-vendor pretext after an upgrade. |

## Tests

| Command | What it checks |
| --- | --- |
| `pnpm test:earthxt` | Globe unit tests (Node's test runner). |
| `pnpm smoke` | The page in headless Chromium (Playwright): no console errors, no label overlaps, card layout, the dialog, the reader and the notebook. Run it after layout, font or map changes. |
| `pnpm smoke:earthxt` | The globe in headless Chromium: all detail levels, input, Serif mode, the standalone file. |

## Deploying

The site is fully static, so any host works: GitHub Pages (the live site), Netlify, or plain nginx.

Run `pnpm build` first and commit `places/`. Skip `data/`, `node_modules/`, `scripts/` and `test/`; they are development-only.

## Project layout

```
index.html, css/, js/   the atlas: data (js/data.js), flat map, grid, dialog, reader
earthxt/                the globe engine (see earthxt/README.md)
places/<id>/            generated share pages
vendor/pretext/         vendored text-measurement library
scripts/, test/         build, validation and smoke tests (not deployed)
sw.js                   offline cache
```

## Security and privacy

- A strict Content-Security-Policy: same-origin scripts and styles only, no inline code, no `eval`.
- All data is rendered with DOM APIs, never HTML strings.
- No cookies, analytics or third-party requests.
- Notes never leave the visitor's browser.

## Data and credits

- **Countries, coastlines and rivers:** [Natural Earth](https://www.naturalearthdata.com/), public domain.
- **Relief:** [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) and the [Copernicus GLO-90 DEM](https://registry.opendata.aws/copernicus-dem/). The full required attribution is in [`earthxt/data/README.md`](earthxt/data/README.md).
- **Text measurement:** [`@chenglou/pretext`](https://github.com/chenglou/pretext), MIT licence.

More background: [`earthxt/README.md`](earthxt/README.md) covers the globe, and [`docs/`](docs/) holds the development roadmap and handoff notes.
