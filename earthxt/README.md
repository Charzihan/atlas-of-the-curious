# Earthxt MVP

A client-side, text-native globe with mathematical 3D projection, real offline geography, mouse/touch rotation, smooth zoom, three geographic detail levels, and live performance instrumentation.

Run from the repository root:

```sh
npm start
# Open http://localhost:8000/earthxt/
```

The existing Atlas of the Curious remains available at `/`. Its header links to Earthxt. Earthxt itself uses no runtime dependencies, external fonts, map services, API keys, or backend. The development server is only a static file server.

## Interaction

- Drag with a mouse or one finger to rotate. A drag pauses automatic rotation.
- Scroll, pinch, use +/−, or move the orbit/surface slider to zoom.
- Choose Planet, Coastlines, or Countries to move to a representative distance. Detail also changes automatically as the camera moves.
- Focus the globe and use arrow keys to rotate, +/− to zoom, 0 to reset, Space to toggle rotation, and D for diagnostics.
- Country labels appear at country detail and can be disabled. The optional coordinate grid is also made of glyphs.
- Earth/Synthetic switches between real and invented geography using the same projection and display path.
- Reduced-motion preferences disable automatic rotation, ocean animation, and zoom interpolation by default. Rotation can still be explicitly enabled. Hidden tabs suspend the frame loop.

## Architecture

| Module | Responsibility |
| --- | --- |
| `geometry.js` | Unit sphere, lat/lon conversion, camera basis, perspective projection, visibility, near ray/sphere intersection, logarithmic zoom |
| `geography.js` | Load and validate local country grids; classify land/ocean, coasts, and borders; provide label anchors; synthetic provider |
| `lod.js` | Extensible ordered detail registry, thresholds, glyph choices, and hysteresis |
| `renderer.js` | Screen-space geographic sampling, glyph selection, Canvas 2D text, DOM country-label projection and collision checks |
| `app.js` | Pointer/pinch/wheel/keyboard input, camera interpolation, lifecycle, controls, accessible status, diagnostics |

No conventional sphere, texture, raster map, or WebGL scene is drawn. The globe surface consists exclusively of `CanvasRenderingContext2D.fillText` glyphs. Country labels are DOM text. Canvas is a display adapter; the sphere mathematics and geography do not depend on it or on Three.js.

For the surface, the renderer casts one ray per screen character cell into the sphere and uses the **near intersection** to recover geographic coordinates. This inverse projection keeps cost proportional to viewport size, capped at 24,000 candidate glyph cells, and cannot include hidden far-side points. Geographic label anchors follow the forward pipeline: lat/lon → sphere coordinates → camera basis → perspective projection → horizon test → screen text. The horizon test is `cameraDistance × cameraSpaceZ > 1`, not simply a positive Z test.

A logarithmic slider maps to camera distances of 4.6–1.16 Earth radii. Wheel and pinch input change the same target distance; exponential interpolation approaches it independently of frame rate. LOD thresholds follow camera distance, with a small dead band when zooming out to prevent flicker. Camera motion is smooth; raster detail changes at the thresholds, without a crossfade. The closest view remains at geographic/country scale (about 1,019 km altitude).

## Local data and budget

The checked-in [data files](data/README.md) include 177 Natural Earth country features rasterized at 1.5°, 0.5°, and 0.25° spacing, with names and label anchors. Coasts and borders are derived from neighboring ownership cells. Data are public domain. All three grids and metadata total approximately **38 KB with gzip**, or **1.29 MiB decoded**. Production transfer sizes depend on host compression. There are no runtime data downloads beyond these same-origin static files.

The budget is **10 MB compressed for initial geography**; `build:earthxt-data` enforces it. `npm run build:earthxt-data` regenerates the checked-in files from the original GeoJSON when that optional source file is available. Normal builds use the checked-in results.

All levels derive from the same simplified 1:110m source: higher detail improves raster resolution, not the source's geographic accuracy. Small islands and inland waters can be absent. Borders follow the source dataset. These data are deliberately unsuitable for street-level navigation.

To extend the hierarchy, add a detail entry in `lod.js` and corresponding provider data, then expose any desired preset in the controls. Geographic providers implement `sample(latitude, longitude, level, result)` and `labels()`. A future static chunk loader can populate provider caches and invalidate rendering as chunks arrive; this MVP loads the small global payload once. Streets, buildings, search, routing, POIs, accounts, and live services are not implemented.

## Performance and failure handling

The footer shows rendered FPS, visible glyphs, altitude, and resident geographic bytes. Diagnostics add candidate screen cells, current LOD, camera distance, projection plus geographic lookup time, text plus label submission time, visible labels, and JS heap usage when the browser exposes it. Timings are CPU submission measurements; they do not measure compositor/GPU completion. FPS counts actual rendered frames, so a paused view can correctly show 0–2 FPS while it redraws only for occasional ocean changes. Metrics update every 600 ms.

The renderer uses fixed typed buffers, caps pixel ratio at 2, batches text by color, and hides the far side by construction. Country labels are culled at the horizon and viewport edges, then filtered for overlap. The label layer is decorative to assistive technology; an accessible globe description reports the current position and detail, with keyboard controls and native buttons as alternatives to pointer gestures.

If geography fails to load, a visible explanation appears and the globe remains usable in synthetic mode. Reload retries Earth data. The app does not need an internet connection after its local files have loaded, but it does not install a dedicated service worker or promise reloads without a reachable static host.

## Build and static deployment

```sh
npm run build:earthxt
```

This copies the nine runtime files plus data attribution and `.nojekyll` into `dist/earthxt/`. Serve **the contents of that directory** from any static HTTP host, either at `/` or beneath a project path such as `/earthxt/`. All module, stylesheet, and data URLs are relative, including data URLs resolved against `import.meta.url`. No special routes, runtime install, environment variables, or server code are required. The complete runtime payload is approximately **54 KiB with gzip** (1.33 MiB raw).

For GitHub Pages from a branch, the repository's existing static root exposes `/earthxt/` directly. For a standalone static deployment, use `dist/earthxt/` as the publish directory. Enable gzip/Brotli if available. No public deployment is automatically triggered by building.

## Validation

```sh
npm run test:earthxt        # Geometry, real data, renderer, and packaging checks
npm run build:earthxt
npm run smoke:earthxt       # Real Chromium; requires Playwright + installed browser
```

The unit checks cover spherical projection round trips, perspective occlusion, pole/dateline handling, zoom endpoints, LOD hysteresis, known geographic locations, dataset integrity and budget, progressively finer coasts, synthetic data, glyph silhouettes, rotation, draw-count bounds, country-label culling/collisions, and static build paths.

The browser suite exercises the **built output under `/dist/earthxt/`**, drag and wheel input, all LODs, country labels, source modes, zoom limits, keyboard controls, dialog focus restoration, reduced motion, mobile width, actual touch drag/pinch/cancellation, and data-loading failure. It rejects unexpected external requests and browser errors and saves captures to `test-results/earthxt/`. It fails rather than silently skipping if Chromium or local sockets cannot run. A full browser performance evaluation still needs representative desktop and mobile devices.
