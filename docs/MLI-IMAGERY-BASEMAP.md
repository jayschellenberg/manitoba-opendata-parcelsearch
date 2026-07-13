# MLI Historical Aerial Basemap

## Status

The full southern Manitoba historical aerial basemap is built locally from the
Manitoba Land Initiative (MLI) Ortho Refresh collection and uploaded to the
existing Cloudflare R2 `wpg-ortho` bucket. It is not enabled in production until
the Manitoba Vercel origin is added to that bucket's CORS policy.

- Local archive: `D:\MBOrtho\mb-mli-ortho-2007-2013.pmtiles`
- Public archive: <https://pub-f351b204f73e4b2287acad946d79681c.r2.dev/mb-mli-ortho-2007-2013.pmtiles>
- Web configuration: `VITE_MLI_ORTHO_PMTILES_URL`
- Acquisition-year coverage: `web/public/mli-imagery-years.geojson`
- Build scripts: `r/build_mli_ortho.ps1` and `r/build_mli_imagery_years.R`

Completed build (2026-07-13):

| Item | Result |
|---|---|
| Source rasters | 1,639 files, 26.42 GB |
| MBTiles intermediate | 17,169,485,824 bytes (15.990 GiB) |
| PMTiles archive | 16,172,106,521 bytes (15.061 GiB) |
| PMTiles format | Specification v3, JPEG, clustered |
| Zoom range | 8-16 |
| Addressed tiles | 1,304,983 |
| Bounds | -101.717160, 48.912275 to -94.817617, 52.395243 |
| SHA-256 | `1947A4963B3E3F0015F325DF5DB17E804B25F50BC86A989C3FA6FFE57B7CA480` |

`pmtiles verify` completed successfully. A zoom-16 tile over Brandon was also
decoded and inspected to confirm that the archive contains valid aerial JPEG
pixels. The archive is excluded from Git. After upload, the R2 object reported
the same 16,172,106,521-byte length, returned HTTP 206 for a seven-byte range,
and returned the expected `PMTiles` magic header.

The MLI catalogue calls this the **2007-2014** collection. Its published flight
records contain actual acquisition years **2007 through 2013**; 2014 is the
catalogue/completion period, not a flight year in the supplied metadata. The app
therefore labels the layer `MLI aerial 2007-2013` and reports the local capture
year at the map centre.

## Authoritative sources

- Digital imagery catalogue: <https://mli.gov.mb.ca/ortho/index.html>
- Ortho Refresh downloads and coverage map:
  <https://mli.gov.mb.ca/ortho/index_ortho_refresh_all.html>
- Coverage grid:
  <https://mli.gov.mb.ca/grids/shp_zip_files/loc_mb_ortho_keymap_py_shp.zip>
- Flight records:
  <https://mli.gov.mb.ca/ortho_refresh/OrthoRefresh2007_2014_Flight_Lines.zip>
- MLI terms of use:
  <https://mli.gov.mb.ca/about_us/Terms_and_Conditions_of_Use.pdf>

The raster build uses, oldest to newest:

1. Years 1-2: 20 published MrSID mosaic blocks.
2. Years 3-4: 1,608 published 1 m MrSID tiles.
3. Year 5: seven 1 m MrSID block mosaics (blocks 130-190).
4. The published 2012 Shilo 1 m patch.
5. Year 7: three eastern 1 m mosaic packages.

GDAL receives sources in that order. Later files replace earlier pixels where
coverage overlaps, matching the year metadata rule that the newest acquisition
wins.

## Acquisition-year data

`r/build_mli_imagery_years.R` combines the MLI 5 km ortho grid with the flight
records. For each refresh grid cell it takes the newest flight year whose flight
point falls inside that cell. If a cell contains no flight point, it uses the
nearest published flight point and records that assignment as inferred before
merging cells into one multipolygon per year.

| Year | Grid cells | Point in cell | Nearest-point inference |
|---:|---:|---:|---:|
| 2007 | 1,114 | 1,006 | 108 |
| 2008 | 738 | 696 | 42 |
| 2009 | 2,542 | 2,298 | 244 |
| 2010 | 536 | 494 | 42 |
| 2011 | 644 | 644 | 0 |
| 2012 | 91 | 91 | 0 |
| 2013 | 444 | 444 | 0 |

The GeoJSON is a compact provenance/lookup layer, not a claim that every pixel
inside a 5 km cell was exposed on the same instant. It is appropriate for
surfacing the acquisition **year** in the parcel app; use the original flight
point timestamps for finer-grained forensic work.

Rebuild it from the repo root:

```powershell
Rscript r\build_mli_imagery_years.R
```

## Raster build

Prerequisites are OSGeo4W GDAL with the ECW/MrSID driver and the PMTiles CLI at
`D:\Dropbox\ClaudeCode\WpgOpenData\tools\pmtiles.exe`.

```powershell
# Download, mosaic, reproject to the exact EPSG:3857 zoom-16 grid, and build PMTiles.
.\r\build_mli_ortho.ps1

# Download only, or reuse a completed source directory.
.\r\build_mli_ortho.ps1 -DownloadOnly
.\r\build_mli_ortho.ps1 -SkipDownload
```

Transient downloads, VRT, MBTiles, and the final PMTiles file stay under
`D:\MBOrtho`, outside Dropbox and Git. The script validates the expected 1,639
source rasters before mosaicking. The output uses the exact EPSG:3857 zoom-16
resolution (2.388657133911758 map metres/pixel, approximately 1.54 ground
metres/pixel in southern Manitoba). This stays close to the nominal 1 m source
while keeping both the intermediate MBTiles and PMTiles conversion copy within
practical local storage.

## Production activation

The archive is hosted on R2. Add
`https://manitoba-opendata-parcelsearch.vercel.app` to the `wpg-ortho`
bucket's existing CORS allowed origins, preserving the Winnipeg origin and the
current exposed range headers. Then set this build-time variable locally and
in Vercel:

```text
VITE_MLI_ORTHO_PMTILES_URL=https://pub-f351b204f73e4b2287acad946d79681c.r2.dev/mb-mli-ortho-2007-2013.pmtiles
```

The R2 origin is allowed in `connect-src` in `vercel.json`. The basemap menu
detects the variable and adds the MLI row; no source edit is needed.

## Licence and attribution

The MLI terms permit creating new representations and derived/value-added
products, with required source attribution. The app and archive use the terms'
specified wording:

> (c) 2001 Her Majesty the Queen in Right of Manitoba, as represented by the
> Minister of Conservation. All rights reserved.

Review the current MLI terms again before public upload because the agreement
states that its terms may change.

## Other government imagery reviewed

No newer open, province-wide Manitoba optical orthophoto collection was found
in the Manitoba Geoportal, MLI catalogue, or federal Open Maps catalogue as of
2026-07-12.

- NRCan's **Canada Basemap Elevation** is useful as a separate hillshade
  basemap and is included in the app, but it is terrain shading rather than
  aerial photography:
  <https://open.canada.ca/data/en/dataset/974944d2-14cb-41c8-ba57-936282d5a227>
- NRCan's **RADARSAT Constellation Mission National Land Mosaic** uses imagery
  acquired in 2023-2024, but it is 30 m synthetic-aperture radar. It is useful
  for regional land interpretation, not parcel-level visual inspection, so it
  was not added as a parcel basemap:
  <https://open.canada.ca/data/en/dataset/f316c469-c068-46f9-a650-95a75f461106>
- Legacy federal Landsat/SPOT products are substantially coarser than both the
  1 m MLI historical orthos and the app's existing Esri World Imagery layer.
- Small academic or event-specific Manitoba orthomosaics exist for isolated
  sites, but they do not provide broad government basemap coverage.

The practical set is therefore: Esri Satellite for current general context,
MLI 2007-2013 for a dated historical comparison, and NRCan elevation for
terrain context.
