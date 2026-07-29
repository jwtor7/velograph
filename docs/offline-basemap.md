# Offline route maps and local basemaps

Velograph's ride-detail view uses a real interactive geographic viewport while preserving the
project's offline boundary. Route geometry, markers, scale, pan, zoom, fit-to-route, and the
synchronized chart cursor work without a basemap. When no package is installed, the viewport
shows the recorded route over Velograph's neutral local surface rather than contacting an online
tile service.

## Install an optional raster MBTiles package

Velograph supports one local [MBTiles 1.3](https://github.com/mapbox/mbtiles-spec) raster package.
Place it at:

```text
$VELO_DATA_DIR/basemap.mbtiles
```

If `VELO_DATA_DIR` is unset, use the same OS application-data directory documented in the
[README](../README.md#import-your-own-data). The package must be a regular file, must not be a
symlink alias, and must resolve outside every Git checkout.

To keep the package elsewhere, set an absolute override before restarting the managed server:

```bash
export VELO_BASEMAP_PATH=/absolute/path/to/local-basemap.mbtiles
pnpm app:restart
```

The server validates the package at startup. Replacing or changing the file requires another
`pnpm app:restart`.

## Supported package contract

The package must contain real `metadata` and `tiles` tables using the standard MBTiles columns.
Velograph accepts only 256-pixel raster tiles:

- `format`: `png`, `jpg`, `jpeg`, or `webp`
- `minzoom` and `maxzoom`: whole numbers from 0 through 22
- `scheme`: omitted or `tms`
- `name`: required plain text
- `attribution`: optional plain text, displayed beneath the map
- `bounds`: optional `west,south,east,north` geographic bounds

Vector tiles, remote URLs, styles, glyphs, sprites, HTML attribution, and executable package
content are unsupported. XYZ requests from the browser are converted to MBTiles' TMS row order
inside the loopback API.

## Privacy and safety

- The browser receives only sanitized metadata and same-origin tile bytes. It never receives the
  filesystem path.
- Map labels and attribution are inserted as plain text; package HTML is stripped and is never
  passed to Leaflet as markup.
- The API opens the package read-only, validates its canonical path and schema, bounds zoom and
  tile reads, and keeps a byte-limited in-memory cache.
- Tile responses are same-origin and `no-store`; the byte-limited server cache is memory-only.
  Velograph does not request remote tiles, fonts, geocoding, telemetry, glyphs, sprites, or CDN
  assets.
- Missing, invalid, oversized, or unsupported packages fail closed to the route-only viewport.
  Errors use stable codes and do not include local paths, tile coordinates, or ride coordinates.
- Installing a basemap does not migrate or mutate ride data.

## Map-data licensing

Leaflet is bundled under the BSD 2-Clause License; see
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). A basemap package is separate data. You are
responsible for obtaining it lawfully and preserving the provider's required attribution in the
MBTiles `attribution` metadata. Velograph does not download or redistribute map data.
