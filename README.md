# Manitoba Open Data Parcel Search

A firm-facing web tool for researching Manitoba properties (excluding Winnipeg, which has its [own portal](https://winnipeg-opendata-parcelsearch.vercel.app/)) by **municipality + civic address + roll # + legal description**, with each result enriched live from five provincial open-data sources and rendered on an interactive map. Pulls together what would otherwise be a five-tab workflow — Manitoba Assessment Online, the provincial Zoning By-Laws layer, the Development Plan Designations layer, the MHTIS traffic-flow layer, and the Contaminated Sites Registry — into one search window with a single CSV export.

## Live site

Source: <https://github.com/jayschellenberg/manitoba-opendata-parcelsearch>. Deployed on Vercel from `main`.

## What's in this folder

| Path | Purpose | Audience |
|---|---|---|
| `web/` | Vite + vanilla JS static site. Queries Manitoba Open Data's ArcGIS REST API live on every search. Deployed to Vercel. | Firm colleagues |
| `r/download_parcels.R` | Snapshots the three primary FeatureServer layers to dated GeoPackages. | Local archive |
| `r/parcel_search_app.R` | Shiny app that searches the **local** snapshot for offline / historical lookups. | Personal use |
| `r/build_legal_index.R` | Converts `ParcelSearch/mao-scrape/results/parcels.parquet` into the static browser legal-search index at `web/public/data/legal-index.json`. | Web deploy prep |
| `vercel.json` | Build config + production CORS rewrite for the contaminated-sites CSV. | — |
| [`REPLICATION_GUIDE.md`](REPLICATION_GUIDE.md) | Step-by-step guide for adapting this tool to another jurisdiction. Originally written for the Winnipeg sister site (Socrata); §14 captures every Manitoba-specific decision and lesson. | Anyone replicating |

## Data sources

Most parcel, zoning, dev-plan, traffic, and environmental data is queried live. Search results are always against the current state of the province's published data; auxiliary overlay datasets are cached in the browser for 7 days (clearable from the **Clear** button) so repeat work in the same area stays snappy.

Legal-description search is backed by a generated static index from the companion MAO scrape. Run this after `ParcelSearch/mao-scrape/results/parcels.parquet` is assembled or refreshed:

```bash
cd web
npm run legal:index
```

The browser searches that index for legal description text, Lot/Block/Plan, and certificate-of-title text. Matching `(muni_no, roll_no_txt)` keys are used only as a lookup bridge; the app still fetches the current parcel geometry and assessment fields live from Roll Entry.

| Dataset | FeatureServer | Used for |
|---|---|---|
| [ROLL ENTRY](https://geoportal.gov.mb.ca/datasets/manitoba::roll-entry/about) | `…/ROLL_ENTRY/FeatureServer/0` | Parcel polygons, roll #, civic address, municipality, dwelling units, total assessed value, link to MAO report |
| [Manitoba Zoning By-Laws](https://geoportal.gov.mb.ca/datasets/manitoba::manitoba-zoning-by-laws/about) | `…/Manitoba_Zoning_By_Laws/FeatureServer/0` | Zone code, zone name, category, governing zoning bylaw (`ZBL`), amendment bylaw (`ZBL_A`), amendment description |
| [Development Plan Designations](https://geoportal.gov.mb.ca/datasets/manitoba::manitoba-development-plan-designations/about) | `…/Manitoba_Development_Plan_Designations/FeatureServer/0` | Designation name, category, dev-plan bylaw (`DP_BYLAW`), amendment bylaw (`DPA_BYLAW`), planning district |
| [MHTIS Traffic Flow 2019](https://www.gov.mb.ca/mti/traffic/counts.html) | `…/MHTIS_Traffic_Flow_2019/FeatureServer/0` | AADT polylines for the colour-coded Traffic overlay |
| [Manitoba Contaminated Sites Registry](https://www.gov.mb.ca/sd/waste_management/contaminated_sites/registry/index.html) | CSV at `manitoba.ca/.../cs-data.csv` (proxied via `vercel.json` because the upstream lacks `Access-Control-Allow-Origin`) | Designated Contaminated, Designated Impacted, and Not Designated sites for the Enviro overlay |
| MAO scrape legal index | `web/public/data/legal-index.json` generated from `ParcelSearch/mao-scrape/results/parcels.parquet` | Legal description text, Lot, Block, Plan, certificates of title, and `(muni_no, roll_no_txt)` lookup keys |

## Layout (sidebar + main pane)

The page splits into a fixed-width left sidebar holding all controls and a fluid main pane holding the map and table. On viewports below 900 px the layout collapses to a single column.

**Sidebar — Search section:**
- Municipality dropdown (preloaded with every distinct `Muni_Name_With_Typ` value; narrows the Zoning Category dropdown to the codes actually present in the muni)
- Civic Address (case-insensitive `LIKE`)
- Roll # (exact match; accepts both `3600` and `3600.000`)
- Legal Description (contains), Lot / Block / Plan (exact), and Certificate of Title (contains) from the generated MAO scrape index
- Zoning Category dropdown (per-muni narrowed)
- Status dropdown — `Any` / `Zoning Changed` / `Dev Plan Changed` / `Both Changed`
- DU mode + Min # input — `Any DU` / `0 DU only` (vacant) / `Min DU N` (≥ N units)
- Search · Clear · Export CSV
- Result count badge

**Sidebar — Map overlays section** (2-column grid):
- **Muni Parcels** — every parcel in the selected muni rendered as a light-blue grey fabric beneath the search results. Roll numbers render at each parcel's centroid at zoom ≥ 14. Hover/click popups show roll #, address, DU, land size (ac/sf), total value; if Show Zoning is also active, the underlying zone code, name, and ZBL are appended to the popup. Click adds the assessment-report link.
- **Traffic** — MHTIS Traffic Flow 2019 polylines coloured by AADT in 6 step-function bins. AADT label rendered along each segment at zoom ≥ 8. Click a segment for full attributes. Floating colour legend appears bottom-right while active.
- **Zoning** — coloured per-search by `ZONE` code with a stable hash-derived HSL palette. Floating legend in the bottom-right lists every code on screen with its `ZONE_NAME`. Zoning code labels render above each polygon centroid (offset to clear the muni-parcels roll number when both layers are on).
- **Dev Plan** — coloured by `DES_CATEGORY`.
- **Enviro** — Manitoba Contaminated Sites Registry as red / orange / grey points by designation, with a registry-page link in each popup.
- **RM Website** — opens the selected muni's official site in a new tab. Auto-detects from a comprehensive lookup of every published municipal website in the province (`MUNI_WEBSITES` in [main.js](web/src/main.js)). Reads "RM N/A" when the muni's directory entry has no website.
- **PD Website** — data-driven. After every search, the dominant `PLANNINGDISTRICT` value across the dev-plan enrichment FC picks the active PD; `PD_WEBSITES` looks up its URL. Reads "PD N/A" when the PD has no website on file. Stays disabled until a search resolves the PD.

**Sidebar — Streets / Satellite basemap toggle** sits in the map's top-right gutter; flips between CARTO Positron and Esri World Imagery without rebuilding the map.

## Results table

| Roll # | Address | Legal | Title | Zoning | % | Zoning 2 | ZBL | Dev-Plan Designation | DP By-law | Changes | DU | Acres | SF | Assess-{year} | Walkscore | Flood |

- **Legal** and **Title** populate for searches that match the generated MAO scrape index. Legal displays the brief legal description, with detailed legal text and parsed Lot / Block / Plan available in the cell tooltip and CSV export.
- **Zoning 2** hidden when its coverage is < 1% (digitization slivers).
- **Zoning** and **Zoning 2** show the short ZONE code only; the full ZONE_NAME is in the parcel hover popup and the zoning legend.
- **Changes** column shows `Z: AG-5 → RR1` or `DP: 03/10 → 23-05` when an amendment is recorded for the row's primary overlay match. Whitespace and Esri `<Null>` sentinels in the source data are filtered out so spurious "Z: " entries no longer appear.
- **Assess-{year}** — header is dynamically year-stamped (e.g. *Assess-2024*) using the most-common assessment year parsed from `Asmt_Roll` across the result set. The dollar value itself is the link to the parcel's MAO report.
- **Walkscore** — opens `walkscore.com/score/<address>`; no API key needed (the Walk Score page renders Walk / Transit / Bike on arrival).
- **Flood** — deep-links into the sister [Manitoba flood-mapping tool](https://mb-flood-mapping.vercel.app/) with `?lat=<centroid>&lon=<centroid>&label=<address>`. Falls back to `?address=…` when geometry is missing.

All columns sortable; CSV export carries the same column order plus legal detail, parsed Lot / Block / Plan, certificate-of-title text, raw coverage ratios, and the URLs for Walkscore / Flood / MAO Report.

## Static map capture

A **Generate Static Map** button between the table and the About section captures the current MapLibre view (extent, zoom, basemap, every active overlay) as a PNG. The captured image has the basemap attribution composited into the bottom-right corner so it travels with the file when right-click → Save Image As is used to drop it into a Word/PDF report.

## Architecture summary

Pure static. Vercel serves the Vite-built bundle plus the generated legal-search JSON. The browser makes its own ArcGIS REST queries directly to `services.arcgis.com` (CORS open). The contaminated-sites CSV at `manitoba.ca` is proxied through `vercel.json` `rewrites` (and a matching Vite dev-server proxy in `vite.config.js`) because the upstream doesn't send `Access-Control-Allow-Origin`.

**Per-search flow** (single direction, one parcel layer):

1. If legal-description, Lot, Block, Plan, or certificate-of-title fields are filled, search `legal-index.json` first. The matching `(muni_no, roll_no_txt)` keys become a lookup filter for the live Roll Entry query.
2. Build the parcel `where` clause from the sidebar inputs. Categorical and amendment-status filters resolve through a separate spatial query against the matching overlay layer (using actual polygon geometry, not bbox envelopes — paginated to handle large overlays); the resulting parcel OBJECTID list is ANDed into the parcel query.
3. Paginated parcel fetch from ROLL_ENTRY with a 1,000-row cap and a `_truncated` flag set whenever the cap or `exceededTransferLimit` triggers.
4. Spatial enrichment — when a muni is selected, **one bulk fetch** of every overlay polygon in that muni replaces the per-parcel envelope queries (~30× faster, eliminates transient-failure mode). Province-wide searches fall back to per-parcel envelope queries with a concurrency cap of 16.
5. Top-N area-weighted join in the browser via `@turf/intersect` + `@turf/area`, mirroring `mao-assembly/scripts/pipeline_utils.R::get_multiple_by_area()`. Top-2 zonings per parcel (with coverage % per match), top-1 dev-plan designation.
6. Results enrich the table, the map fits to bounds, and the zoning legend rebuilds against the actual codes present.

**Caching.** Four classes of data, distinct strategies:

- **Search results** — never cached. Every Search fetches current ROLL_ENTRY rows live, even when a generated legal-index match supplies the lookup keys.
- **Generated legal index** — static deployment artifact, regenerated from the MAO scrape with `npm run legal:index` whenever `ParcelSearch/mao-scrape/results/parcels.parquet` is refreshed.
- **Dropdown lists + auxiliary overlays** — cached in `localStorage` under the `mbpsCache.` namespace with a 7-day TTL. Survives across tabs and sessions. Quota recovery evicts older namespaced entries before failing. Clear button wipes the namespace.
- **Per-muni overlay fetches** — cached per-muni so switching back to a recently-visited muni is instant.

**Dependencies** (`web/package.json`):

- `maplibre-gl` — map (no API key; CARTO Positron + Esri World Imagery raster tiles)
- `@turf/area`, `@turf/bbox`, `@turf/intersect`, `@turf/boolean-point-in-polygon` — spatial primitives for the area-weighted join

No backend, no database, no scheduled jobs. The only precomputed browser artifact is `web/public/data/legal-index.json`, derived from the companion MAO scrape.

## Running the web app locally

Prerequisites: Node.js 18+ and npm.

```bash
cd web
npm install
npm run legal:index   # refresh after the MAO scrape output changes
npm run dev
```

Open <http://localhost:5173>. The contaminated-sites CSV proxies through Vite's dev server so Show Enviro works in dev too.

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

The Shiny app reads the most recent `RollEntry_YYYYMMDD.gpkg` in the project directory. The R scripts hardcode `data_dir <- "D:/Dropbox/ClaudeCode/MBOpenData/WebSearch"`; edit the constant at the top of each file to run elsewhere.

## Known caveats

- `.gpkg`, `.tif`, and `.parquet` snapshots are gitignored — too large for GitHub and trivially regenerable.
- Roll # digits are not unique province-wide — always pair Roll # with a Municipality.
- `Frontage_or_Area` from ROLL_ENTRY is sometimes acres, sometimes frontage-feet; the table computes acreage from polygon geometry instead.
- Manitoba does **not** have a province-wide civic-addresses dataset, so multi-address parcels are only findable by their primary `Property_Address`. Rural parcels often store a quarter-section description here in lieu of a street address.
- The MHTIS Traffic Flow layer doesn't carry every road segment in the province — gaps are normal in less-trafficked corridors.
- ROLL_ENTRY's `AsmtYr` column referenced in the offline pipeline does **not** exist on the live FeatureServer. The assessment year is parsed from the `Asmt_Roll` text field (e.g. *"2024 Final"* → 2024).
- Some service configurations stringify null as the literal text `<Null>`; the client treats `null`, empty, single-space, and `<Null>` as equivalent.
- `MUNI_WEBSITES` and `PD_WEBSITES` (in [main.js](web/src/main.js)) are hand-curated from the province's official Municipal and Planning District contact directories. Munis whose only published contact is a generic email render as "RM N/A" — adding an entry to the constant promotes them to a working button.

## Replicating this for another jurisdiction

See [REPLICATION_GUIDE.md](REPLICATION_GUIDE.md). Originally written for the Winnipeg Socrata source; §14 covers this ArcGIS REST variant including every operational detail an adaptation would need: SQL92 dialect quirks (no `TRIM()`, `<Null>` sentinel), bulk-fetch vs per-parcel envelope decision, true polygon-geometry filter resolution, paginated OBJECTID collection, localStorage TTL caching, the Web Worker / rbush optimization deferred to a follow-up perf pass, and the comprehensive muni/PD lookup pattern.
