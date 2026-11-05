# Local Earth geography

`world.bin` holds, for each of three levels of detail (LODs), three consecutive north-to-south equirectangular rasters of one byte per cell:

1. **Ownership.** A country ID (1–242), or 0 for ocean.
2. **Relief.** Read against that level's ownership:
   - On land, bit 7 marks rugged ground. Bits 0–6 hold the cell's mean height in 50 m steps, from 0 to 6,350 m.
   - At sea, the byte holds the mean depth in 100 m steps, from 0 to 12,700 m.
3. **Rivers.** 0 where no river crosses the cell (always 0 at sea). Otherwise:
   - Bits 0–3 hold the most important river's Natural Earth `scalerank` (1 is the largest).
   - Bits 4–5 hold its direction there: 0 east–west, 1 north–south, 2 rising (`/`), 3 falling (`\`). The direction follows the river's course two cells either side, so the drawn line stays straight through small wiggles.

`world.json` (version 3) gives each level's size and its `offset`, `reliefOffset` and `riverOffset` in the binary. It also records the relief steps and the ruggedness threshold, and supplies country names and label positions.

Older files still load:
- A version 2 file has no rivers.
- A version 1 file has ownership only, so its relief also reads as flat land and a uniform sea.

| LOD | Resolution | Cell size | Raw bytes (ownership + relief + rivers) | Rivers drawn |
| --- | --- | --- | --- | --- |
| Planet | 240 × 120 | 1.5° | 86,400 | scalerank 1 |
| Coastlines | 720 × 360 | 0.5° | 777,600 | scalerank ≤ 3 |
| Countries | 1440 × 720 | 0.25° | 3,110,400 | scalerank ≤ 5 |

`riverRank` in `earthxt/lod.js` sets which rivers each level draws. The raster keeps every rank up to 6.

The build enforces a 10 MB compressed budget for the geography payload. The files are served uncompressed unless the host enables HTTP gzip or Brotli. The diagnostics panel reports the decoded payload actually held in memory, not an estimate of the compressed transfer.

No geography is fetched from a third party at runtime.

## Sources

**Countries:** [Natural Earth, Admin 0 countries, 1:50m](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/). Natural Earth data are [public domain](https://www.naturalearthdata.com/about/terms-of-use/).

The 1:50m set is used rather than 1:10m for two reasons:

- 1:10m has 258 features, more than the one-byte ownership encoding can hold.
- Its extra detail is far smaller than a 0.25° cell, about 28 km.

Compared with the 1:110m set this replaced, 1:50m adds many islands and small states, and its coastlines are traced more closely.

**Rivers:** [Natural Earth, rivers and lake centerlines, 1:50m](https://www.naturalearthdata.com/downloads/50m-physical-vectors/50m-rivers-lake-centerlines/), public domain. Each line is walked in quarter-cell steps, and every cell it crosses records the largest river through it.

**Land heights and sea depths:** [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on the AWS Open Data registry, at zoom 5 (32 × 32 Terrarium tiles). The build pools about 30 tiles' pixels into each finest-level cell. Land and sea pixels are averaged separately, so a coastal cell's height is not pulled down by its own shelf.

Two edge cases:

- **Poles.** The tiles stop at ±85.05° latitude (Web Mercator), so the rows beyond take the values of the nearest sampled row.
- **Ice sheets.** The tiles hold the bedrock under the Greenland and Antarctic ice, so for cells owned by Greenland or Antarctica the build uses the ice surface instead. That comes from the coarsest overview of the [Copernicus GLO-90 DEM](https://registry.opendata.aws/copernicus-dem/) tiles.

**Ruggedness:** a cell is rugged when its land heights vary by at least 250 m (standard deviation inside a finest-level cell). A coarser cell averages the variation of its finer cells. The globe draws rugged land above 1,000 m as mountains (`^`).

### Required attribution

Terrain Tiles combine several datasets. Their [attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) reads:

- ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;
- Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
- Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;
- Canada terrain data contains information licensed under the Open Government Licence – Canada;
- Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;
- Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration;
- Mexico terrain data source: INEGI, Continental relief, 2016;
- New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);
- Norway terrain data © Kartverket;
- United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.

Ice-sheet surface: produced using Copernicus WorldDEM-30 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; all rights reserved.

## Regenerating

```sh
pnpm fetch:earthxt-sources   # downloads the sources below into data/ (git-ignored)
pnpm build:earthxt-data      # rasterizes them into earthxt/data/
```

The first command downloads:

- `data/ne_50m_admin_0_countries.geojson`
- `data/ne_50m_rivers_lake_centerlines.geojson`
- 1,024 Terrain Tiles into `data/terrarium/`
- the coarsest overview of about 8,100 Copernicus tiles, sampled into `data/ice-surface.bin`

It keeps any file already present. The Copernicus step decodes tiles on worker threads and takes several minutes. The checked-in binary and metadata are all that's needed to develop, build and deploy the globe.

`node scripts/earthxt/build-data.mjs [countries.geojson] [terrain-dir] [ice-surface.bin] [rivers.geojson]` accepts other inputs in the same formats.

## How the rasters are made

Country polygons are rasterized with even-odd scanlines across exterior rings and holes. All three levels use the same source, so finer spacing reveals more of the source's existing detail, not new information. The smallest islands can still fall between cell centres.

Country borders are derived from neighbouring cells with a different nonzero owner, and are one cell wide: only the cell west or north of a border marks it (its east, south or south-east neighbour belongs to another country). Coastline marks come from neighbouring ocean cells. Boundaries follow the source dataset and are illustrative.
