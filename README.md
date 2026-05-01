# Manitoba Open Data Parcel Search

A firm-facing web tool for searching Manitoba properties (excluding Winnipeg, which has its [own portal](https://winnipeg-opendata-parcelsearch.vercel.app/)) by **municipality + civic address + roll #**, with each result enriched live by its top-2 zoning districts (with coverage %) and primary development-plan designation, drawn on an interactive MapLibre map. Optional toggleable overlays for zoning, dev-plan, environmental contamination, traffic-count stations, AADT traffic-flow polylines, and the entire muni's parcel fabric. Plus the R scripts used to build a local snapshot for offline / historical lookups.

## Live site

_Deploy URL goes here once Vercel imports the repo._ Source: <https://github.com/jayschellenberg/manitoba-opendata-parcelsearch>.

## What's in this folder

| Path | Purpose | Audience |
|---|---|---|
| `web/` | Vite + vanilla JS static site. Queries Manitoba Open Data's ArcGIS REST API live on every search. Deployed to Vercel. | Firm colleagues |
| `r/download_parcels.R` | Snapshots the three FeatureServer layers to local GeoPackages (~5-10 min). | Local archive |
| `r/parcel_search_app.R` | R Shiny app that searches the **local** snapshot for offline / historical lookups. | Personal use |
| `vercel.json` | Build config + CORS rewrites (proxies the manitoba.ca contaminated-sites CSV). | — |
| [`REPLICATION_GUIDE.md`](REPLICATION_GUIDE.md) | Step-by-step guide for adapting this tool to another jurisdiction. Originally written for the Winnipeg sister site, now demonstrably covers both jurisdictions. | Anyone replicating |

## Data sources

All data is queried live; no copies are shipped with the site, so search results always reflect what the province published this morning.

| Dataset | FeatureServer | Used for |
|---|---|---|
| [ROLL ENTRY](https://geoportal.gov.mb.ca/datasets/manitoba::roll-entry/about) | `…/ROLL_ENTRY/FeatureServer/0` | Parcel polygons, roll #, civic address, municipality, dwelling units, total assessed value, link to Manitoba Assessment Online report |
| [Manitoba Zoning By-Laws](https://geoportal.gov.mb.ca/datasets/manitoba::manitoba-zoning-by-laws/about) | `…/Manitoba_Zoning_By_Laws/FeatureServer/0` | Zone code, zone name, category, governing zoning by-law (`ZBL`), amendment by-law (`ZBL_A`), amendment description |
| [Development Plan Designations](https://geoportal.gov.mb.ca/datasets/manitoba::manitoba-development-plan-designations/about) | `…/Manitoba_Development_Plan_Designations/FeatureServer/0` | Designation name, category, dev-plan by-law (`DP_BYLAW`), amendment by-law (`DPA_BYLAW`), planning district |
| [MHTIS Traffic Counting Sites](https://www.gov.mb.ca/mti/traffic/counts.html) | `…/All_Stations_C_Only/FeatureServer/0` | Count-station locations for the toggleable traffic overlay |
| [MHTIS Traffic Flow 2019](https://www.gov.mb.ca/mti/traffic/counts.html) | `…/MHTIS_Traffic_Flow_2019/FeatureServer/0` | AADT polylines used for the colour-coded traffic-flow overlay |
| [Manitoba Contaminated Sites Registry](https://www.gov.mb.ca/sd/waste_management/contaminated_sites/registry/index.html) | CSV at `manitoba.ca/.../cs-data.csv` (proxied via `vercel.json` because the upstream lacks `Access-Control-Allow-Origin`) | Designated Contaminated, Designated Impacted, and Not Designated sites |

## What the web app does

**Single primary search flow.** Manitoba's `ROLL_ENTRY` IS the parcel layer (no separate survey/legal-lots dataset like Winnipeg has), so the dual-flow architecture from the Winnipeg site collapses to one direction:

1. **Attribute query** against ROLL_ENTRY — Municipality (preloaded dropdown of every distinct `Muni_Name_With_Typ` value, narrows the Zoning-Category dropdown to that muni's actual zones) + Civic Address (case-insensitive `LIKE`) + Roll # (exact match, accepts both `3600` and `3600.000`).
2. **Optional categorical / change / DU filters**:
   - **Zoning category** — resolved spatially: pulls every zoning polygon in the chosen category (and muni, if set), unions the parcel OBJECTIDs that intersect, ANDs that into the parcel `where` clause.
   - **Amendment status** dropdown (`Any` / `Zoning Changed` / `Dev Plan Changed` / `Both Changed`) — uses `ZBL_A <> ZBL` or trimmed `AMENDMENT_DESCRIPTION` for zoning, `DPA_BYLAW <> DP_BYLAW` for dev-plan; the SQL excludes the 385 source rows where `AMENDMENT_DESCRIPTION` is a literal whitespace string.
   - **Dwelling Units** dropdown — `Any DU`, `0 DU only` (vacant land), or `Min DU` with a minimum-count number input.
3. **Spatial enrichment.** When a muni is selected, a single bulk fetch of every zoning + dev-plan polygon in that muni replaces the per-parcel envelope queries — about 30× faster and removes the transient-failure mode that was dropping zoning rows on big result sets.
4. **Top-N area-weighted join** in the browser via `@turf/intersect` + `@turf/area`, mirroring `mao-assembly/scripts/pipeline_utils.R` `get_multiple_by_area()`. Top-2 zonings per parcel (with coverage % per match), top-1 dev-plan designation.

### Map overlays (all toggleable)

- **Zoning** — coloured by `ZONE_CATEGORY`. Includes a colour-coded legend that appears with the layer.
- **Dev Plan** — coloured by `DES_CATEGORY`.
- **Show Enviro** — Manitoba Contaminated Sites Registry as red / orange / grey points by designation, with a registry-page link in each popup.
- **Show Stations** — MHTIS traffic-count station locations.
- **Show Flow** — MHTIS Traffic Flow 2019 polylines coloured by AADT in 6 bins (legend renders alongside, AADT label drawn along each segment at zoom ≥ 8). Loading both Stations and Flow auto-joins so the station popup includes the matching AADT.
- **Show Muni Parcels** — every parcel in the selected municipality rendered as a muted grey fabric beneath search results. Hover popup shows roll #, address, DU, land size (ac · sf), total value; click adds the assessment-report link.
- **Streets / Satellite** toggle in the top-right of the map (Esri World Imagery).

### Results table

| Roll # | Address | Zoning | % | Zoning 2 | % | Zoning By-law | Dev-Plan Designation | DP By-law | Changes | DU | Acres | SF | Walkscore | Total Value | Asmt Report |

- **Zoning 2** is hidden when its coverage is < 1% (sliver-of-noise polygons).
- **Zoning** and **Zoning 2** show the short ZONE code only; the full ZONE_NAME is in the parcel hover popup.
- **Changes** column shows "Z: RG8 → RG5" or "DP: 03/10 → 23-05" when an amendment is recorded for the row's primary overlay.
- **Walkscore** and **Asmt Report** are simple `view` links to the external pages — no API key required.
- All columns sortable; every search exports to CSV including the raw coverage ratios.

## Web app architecture

Pure static. Vercel serves the Vite-built bundle. The browser makes its own ArcGIS REST queries directly to `services.arcgis.com` (CORS open). The contaminated-sites CSV at `manitoba.ca` is proxied through `vercel.json` `rewrites` (and a matching Vite dev-server proxy in `vite.config.js`) because the upstream doesn't send `Access-Control-Allow-Origin`.

**Dependencies** (`web/package.json`):

- `maplibre-gl` — map (no API key; CartoDB Positron raster tiles + Esri World Imagery)
- `@turf/area`, `@turf/bbox`, `@turf/intersect`, `@turf/boolean-point-in-polygon` — spatial primitives for the area-weighted join

No backend, no database, no precomputed data, no scheduled jobs.

## Running the web app locally

Prerequisites: Node.js 18+ and npm.

```bash
cd web
npm install
npm run dev
```

Open <http://localhost:5173>. The contaminated-sites CSV proxies through Vite's dev server so it works in dev too.

To build for production:

```bash
npm run build
```

Output goes to `web/dist/` (gitignored). Vercel runs the same command on every push to `main`.

## Running the R tools locally

Prerequisites: R 4.5+ and the packages `sf`, `httr2`, `shiny`, `leaflet`, `DT`, `dplyr`.

```r
source("r/download_parcels.R")          # snapshots ROLL_ENTRY + zoning + dev plan
shiny::runApp("r/parcel_search_app.R")  # interactive search on the local snapshot
```

The Shiny app reads the most recent `RollEntry_YYYYMMDD.gpkg` in the project directory.

## Known caveats

- The R scripts hardcode `D:/Dropbox/ClaudeCode/MBOpenData/WebSearch`. Edit `data_dir` at the top of each file to run elsewhere.
- `.gpkg`, `.tif`, and `.parquet` snapshots are gitignored — too large for GitHub and trivially regenerable.
- Roll # digits are not unique province-wide — always pair Roll # with a Municipality.
- `Frontage_or_Area` from ROLL_ENTRY is sometimes acres, sometimes frontage-feet; the table computes acreage from polygon geometry instead.
- Manitoba does **not** have a province-wide civic-addresses dataset, so multi-address parcels are only findable by their primary `Property_Address`. Rural parcels often store a quarter-section description here in lieu of a street address.
- The MHTIS traffic-count station-locations FeatureServer doesn't carry AADT values; the AADT is joined client-side from `MHTIS_Traffic_Flow_2019` on `StationNum` (max AADT across all matching directional segments).

## Replicating this for another jurisdiction

See [REPLICATION_GUIDE.md](REPLICATION_GUIDE.md). Originally written for the Winnipeg Socrata source; now also covers this ArcGIS REST variant — between the two, the relevant patterns for adapting to most Canadian municipal portals are documented.
