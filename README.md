# Manitoba Open Data Parcel Search

A firm-facing web tool for searching Manitoba properties (excluding Winnipeg, which has its [own portal](https://winnipeg-opendata-parcelsearch.vercel.app/)) — by civic address, municipality, or roll number — with each result enriched by its top-2 zoning districts and top-2 development-plan designations from live provincial data, drawn on an interactive MapLibre map. Plus the R scripts used to build a local snapshot for offline / historical lookups.

## Live site

_Deploy URL goes here once Vercel is set up._

## What's in this folder

| Path | Purpose | Audience |
|---|---|---|
| `web/` | Vite + vanilla JS static site. Queries Manitoba Open Data's ArcGIS REST API live on every search. Deployed to Vercel. | Firm colleagues |
| `r/download_parcels.R` | Snapshots the three FeatureServer layers to local GeoPackages (~5-10 min). | Local archive |
| `r/parcel_search_app.R` | R Shiny app that searches the **local** snapshot for offline / historical lookups. | Personal use |
| `mao-assembly/` | Companion offline pipeline that joins ROLL_ENTRY with zoning, dev-plans, soils, MASC, and land cover to produce a full provincial parquet. Untouched by this tool. | Personal use |
| `vercel.json` | Build config — points Vercel at `web/`. | — |
| [`REPLICATION_GUIDE.md`](REPLICATION_GUIDE.md) | Step-by-step guide for adapting this tool to another jurisdiction. Originally written for the Winnipeg sister tool, now demonstrably covers both jurisdictions. | Anyone replicating |

## Data sources

All three datasets are hosted on the same provincial ArcGIS Online org and queried live from the browser — no copies are shipped with the site, so search results are always current.

| Dataset | FeatureServer | Used for |
|---|---|---|
| [ROLL ENTRY](https://geoportal.gov.mb.ca/datasets/manitoba::roll-entry/about) | `…/ROLL_ENTRY/FeatureServer/0` | Parcel polygons, roll number, civic address, municipality, total assessed value, link to Manitoba Assessment Online report |
| [Manitoba Zoning By-Laws](https://geoportal.gov.mb.ca/datasets/manitoba::manitoba-zoning-by-laws/about) | `…/Manitoba_Zoning_By_Laws/FeatureServer/0` | Zone code (`ZONE`), zone name, category, governing zoning by-law (`ZBL`) |
| [Manitoba Development Plan Designations](https://geoportal.gov.mb.ca/datasets/manitoba::manitoba-development-plan-designations/about) | `…/Manitoba_Development_Plan_Designations/FeatureServer/0` | Designation name, category, dev-plan by-law, planning district |

## What the web app does

**Single search flow** — Manitoba's `ROLL_ENTRY` IS the parcel layer (no separate survey/legal-lots dataset like Winnipeg has), so the dual-flow architecture from the Winnipeg site collapses to one direction:

1. **Attribute query** against ROLL_ENTRY — fill any of *Civic Address* / *Municipality* / *Roll #*. The muni dropdown is preloaded once at page open with every distinct `Muni_Name_With_Typ` value (~190 munis); free-text fields use case-insensitive `UPPER(...) LIKE '%X%'`.
2. **Optional categorical filters** — *Zoning Category* and *Dev-Plan Category* dropdowns resolve to a list of parcel OBJECTIDs spatially (intersect query against the matching overlay layer), then add `OBJECTID IN (...)` to the parcel query so all filters compose with AND semantics in one paginated response.
3. **Spatial enrichment** — for each result parcel, run two parallel envelope queries against Zoning + Dev-Plan layers (`spatialRel=esriSpatialRelIntersects` is true intersection, no bbox padding needed), collect overlapping polygons, then client-side compute `intersect(parcel, overlay) → area`, sort descending, and keep top-2 with coverage ratios. Mirrors the area-weighted top-N join in `mao-assembly`'s offline pipeline.

The map shows three layers:

- **Red parcels** — your search results (always on)
- **Zoning overlay** — coloured by `ZONE_CATEGORY` (toggleable, default off)
- **Dev-Plan overlay** — coloured by `DES_CATEGORY` (toggleable, default off)

Hover anywhere to see whatever's under the cursor in a single combined popup.

## UX features

- **Sortable columns** — click any header to sort. Default is by Roll # ascending.
- **CSV export** of the current results, including raw coverage ratios.
- **Map ↔ Table linkage** — click any parcel to scroll to its row; click any row to fly the map to that parcel.
- **Direct link to MAO** — every row has a "view" link to that parcel's page in Manitoba Assessment Online (`Asmt_Rpt_Url`).
- **Top-2 zoning + top-2 dev-plan** with coverage % per match — accurately represents rural and large parcels that span multiple designations. Single-zone parcels show one row in the *Zoning 2* / *Dev-Plan 2* columns as `—`.
- **Lot area in acres**, computed from the polygon geometry with `@turf/area` rather than read from `Frontage_or_Area` (which is sometimes acres, sometimes frontage-feet depending on the muni).
- **Clear button = full page reload** — bulletproof reset of every piece of state.

## Web app architecture

The site is pure static — Vercel serves the Vite-built bundle. The browser makes its own ArcGIS REST queries directly to `services.arcgis.com` (CORS is open on hosted feature services).

A typical search fires several requests in parallel:

1. **Attribute query** — `POST` to `ROLL_ENTRY/FeatureServer/0/query` with the user's `where` clause, paginated via `resultOffset` + `resultRecordCount` (max 2000 per page, capped at 1000 results total).
2. **Optional category resolution** (when zoning/dev-plan category filter is set) — fetch all overlay polygons matching the chosen category, then per-overlay envelope query against ROLL_ENTRY to collect intersecting parcel OBJECTIDs.
3. **Spatial enrichment** — per-parcel envelope query against Zoning + Dev-Plan layers, batched with a concurrency cap of 16, deduped by OBJECTID.
4. **Top-2 area-weighted join** — client-side `@turf/intersect` + `@turf/area`, exactly as in `mao-assembly/scripts/pipeline_utils.R::get_multiple_by_area()`.

**Dependencies** (`web/package.json`):

- `maplibre-gl` — the map (no API key required, uses CartoDB Positron raster tiles)
- `@turf/area` — geodesic m² for the top-N area-weighted join and acreage display
- `@turf/bbox` — bounding boxes for envelope queries and fit-to-features
- `@turf/intersect` — primary client-side overlap primitive
- `@turf/boolean-point-in-polygon` — defensive fallback (currently unused; kept for future expansion)

No backend, no database, no precomputed data.

## Running the web app locally

Prerequisites: Node.js 18+ and npm.

```bash
cd web
npm install
npm run dev
```

Open <http://localhost:5173>. No local data needed — the dev server queries live Manitoba Open Data on every search.

To build for production:

```bash
npm run build
```

The build output goes to `web/dist/` (`.gitignored`). Vercel runs the same command on every push to `main`.

## Running the R tools locally

Prerequisites: R 4.5+ and the packages `sf`, `httr2`, `shiny`, `leaflet`, `DT`.

```r
# From the repo root in R or RStudio:
source("r/download_parcels.R")          # snapshots ROLL_ENTRY + zoning + dev plan
shiny::runApp("r/parcel_search_app.R")  # interactive search on the local snapshot
```

The Shiny app reads the most recent `RollEntry_YYYYMMDD.gpkg` in the project directory, so it lets you search against whichever snapshot you have locally — including older ones when the live data has moved on.

## Known caveats

- The R scripts hardcode an absolute path (`D:/Dropbox/ClaudeCode/MBOpenData/WebSearch`). To run elsewhere, update the `data_dir` variable at the top of each script.
- `.gpkg` snapshot files are gitignored — too large for GitHub and trivially regenerable.
- The web app requires internet access and shows current data only. For historical snapshots, use the R Shiny app against a saved local archive.
- Roll number digits are not unique province-wide — the same `Roll_No_Txt` value exists in many municipalities. Always pair Roll # with a Municipality for a precise lookup.
- `Frontage_or_Area` from ROLL_ENTRY is sometimes acres, sometimes frontage-feet — the table computes acreage from polygon geometry instead.
- Manitoba does **not** have a province-wide civic-addresses dataset (only Winnipeg's), so multi-address parcels are only findable by their primary `Property_Address`. Rural parcels often store a quarter-section description here in lieu of a street address.

## Replicating this for another jurisdiction

See [REPLICATION_GUIDE.md](REPLICATION_GUIDE.md) for a step-by-step adaptation guide. It was originally written for the Winnipeg Socrata source and now also covers this ArcGIS REST variant — between the two, the relevant patterns for adapting to most Canadian municipal portals are documented.
