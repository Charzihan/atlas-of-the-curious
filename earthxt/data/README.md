# Local Earth geography

`world.bin` contains three consecutive, north-to-south, equirectangular ownership rasters. Each unsigned byte is a country ID (1–177); 0 is ocean. `world.json` describes each raster's dimensions and offset, and supplies country names and label positions.

| LOD | Resolution | Cell size | Raw bytes |
| --- | --- | --- | --- |
| Planet | 240 × 120 | 1.5° | 28,800 |
| Coastlines | 720 × 360 | 0.5° | 259,200 |
| Countries | 1440 × 720 | 0.25° | 1,036,800 |

The complete binary and metadata total about 38 KB with gzip, well below the 10 MB compressed geographic budget. The files are served uncompressed unless the host enables HTTP gzip/Brotli. The diagnostics panel reports the actual decoded resident payload, not an estimated compressed transfer size.

Source: [Natural Earth, Admin 0 countries, 1:110m](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/). Natural Earth data are [public domain](https://www.naturalearthdata.com/about/terms-of-use/). Rasterized from the repository's existing `data/world-110m-countries.geojson`. No geography is fetched from a third party at runtime.

Regenerate with `npm run build:earthxt-data`, or pass a compatible GeoJSON file to `node scripts/earthxt/build-data.mjs /path/to/countries.geojson`. The source GeoJSON is intentionally ignored by the original repository; obtain it separately for regeneration. The checked-in binary and metadata are sufficient to develop, build, and deploy Earthxt.

Country polygons are rasterized using even-odd scanlines across exterior rings and holes. All levels use the same source; finer raster spacing reveals more of its existing detail, not new source information. Small islands and inland waters may be omitted at this scale. Country borders are derived from neighboring nonzero ownership cells; coastline marks from adjacent ocean cells. Boundaries follow the source dataset and are illustrative.
