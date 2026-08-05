# Manitoba Open Data Parcel Search

A firm-facing web tool for researching Manitoba properties (excluding Winnipeg, which has its [own portal](https://winnipeg-opendata-parcelsearch.vercel.app/)) by **municipality + civic address + roll # + legal description**, with each result enriched from provincial open-data sources and rendered on an interactive map. Pulls together what would otherwise be a multi-tab workflow — Manitoba Assessment Online, the provincial Zoning By-Laws layer, the Development Plan Designations layer, the MHTIS traffic-flow layer, MASC soil ratings, Water Rights Licensing (tile drainage + irrigation), and the Contaminated Sites Registry — into one search window with a single CSV export.

## Live site

Source: <https://github.com/jayschellenberg/manitoba-opendata-parcelsearch>. Deployed on Vercel from `main`.

## What's in this folder

| Path | Purpose | Audience |
|---|---|---|
| `web/` | Vite + vanilla JS static site. Queries Manitoba Open Data's ArcGIS REST API live on every search. Deployed to Vercel. | Firm colleagues |
| `r/download_parcels.R` | Snapshots the three primary FeatureServer layers to dated GeoPackages. | Local archive |
| `r/parcel_search_app.R` | Shiny app that searches the **local** snapshot for offline / historical lookups. | Personal use |
| `r/build_legal_index.R` | Converts `../mao-scrape/results/parcels.parquet` into the static browser legal-search index at `web/public/data/legal-index.json`. | Web deploy prep |
| `r/build_masc_shards.R` | Splits the MASC quarter-section rating CSV into per-municipality static shards for the MASC Rating map layer. | Web deploy prep |
| `r/build_parcel_masc.R` | Pre-bakes the dominant MASC soil rating per Roll Entry parcel for the Soil table column and writes the rated river-lot MASC overlay when river-lot inputs are present. | Web deploy prep |
| `r/build_mli_ortho.ps1` | Downloads and builds the full southern-Manitoba MLI historical aerial mosaic as local PMTiles. | Basemap build |
| `vercel.json` | Build config + production CORS rewrite for the contaminated-sites CSV. | — |
| [`HANDOFF-WATER-INFLUENCE.md`](HANDOFF-WATER-INFLUENCE.md) | Water-influence feature notes: repo map, algorithm history, UI decisions, verification steps, and open follow-ups. | Maintainers |
| [`REPLICATION_GUIDE.md`](REPLICATION_GUIDE.md) | Step-by-step guide for adapting this tool to another jurisdiction. Originally written for the Winnipeg sister site (Socrata); §14 captures every Manitoba-specific decision and lesson. | Anyone replicating |

## Data sources

Most parcel, zoning, dev-plan, traffic, and environmental data is queried live. Search results are always against the current state of the province's published data; auxiliary overlay datasets are cached in the browser for 7 days (clearable from the **Clear** button) so repeat work in the same area stays snappy.

Legal-description search is backed by a generated static index from the companion MAO scrape. Run this after `../mao-scrape/results/parcels.parquet` is assembled or refreshed:

```bash
cd web
npm run legal:index
```

The browser searches that index for legal description text, Lot/Block/Plan, and certificate-of-title text. Matching `(muni_no, roll_no_txt)` keys are used only as a lookup bridge; the app still fetches the current parcel geometry and assessment fields live from Roll Entry.

MASC soil data is also shipped as generated static artifacts rather than queried live. The quarter-section layer uses per-municipality JSON shards under `web/public/data/masc/`, rated long/narrow river-lot polygons are in `web/public/data/masc-riverlots.json`, and the table's dominant parcel-level soil rating uses `web/public/data/parcel-masc/`. Risk-area numbers come from the official Manitoba Maps / Open Canada `MASC_Risk_Areas` polygon layer and are joined to parcel results at search time. Refresh the generated soil artifacts after a new MASC CSV, river-lot scrape, river-lot KMZ, or Roll Entry snapshot:

```bash
Rscript r/build_masc_shards.R
Rscript r/build_parcel_masc.R
```

| Dataset | FeatureServer | Used for |
|---|---|---|
| [ROLL ENTRY](https://geoportal.gov.mb.ca/datasets/manitoba::roll-entry/about) | `…/ROLL_ENTRY/FeatureServer/0` | Parcel polygons, roll #, civic address, municipality, dwelling units, total assessed value, link to MAO report |
| [Manitoba Zoning By-Laws](https://geoportal.gov.mb.ca/datasets/manitoba::manitoba-zoning-by-laws/about) | `…/Manitoba_Zoning_By_Laws/FeatureServer/0` | Zone code, zone name, category, governing zoning bylaw (`ZBL`), amendment bylaw (`ZBL_A`), amendment description |
| [Development Plan Designations](https://geoportal.gov.mb.ca/datasets/manitoba::manitoba-development-plan-designations/about) | `…/Manitoba_Development_Plan_Designations/FeatureServer/0` | Designation name, category, dev-plan bylaw (`DP_BYLAW`), amendment bylaw (`DPA_BYLAW`), planning district |
| [MHTIS Traffic Flow 2019](https://www.gov.mb.ca/mti/traffic/counts.html) | `…/MHTIS_Traffic_Flow_2019/FeatureServer/0` | AADT polylines for the colour-coded Traffic overlay |
| Manitoba Road Network 2023 | `…/Manitoba_Road_Network_2023/FeatureServer/0` | Province-wide PTH, PR, access, service, ramp, and winter-road overlay |
| [Manitoba Contaminated Sites Registry](https://www.gov.mb.ca/sd/waste_management/contaminated_sites/registry/index.html) | CSV at `manitoba.ca/.../cs-data.csv` (proxied via `vercel.json` because the upstream lacks `Access-Control-Allow-Origin`) | Designated Contaminated, Designated Impacted, and Not Designated sites for the Enviro overlay |
| MAO scrape legal index | `web/public/data/legal-index.json` generated from `../mao-scrape/results/parcels.parquet` | Legal description text, Lot, Block, Plan, certificates of title, and `(muni_no, roll_no_txt)` lookup keys |
| MASC soil ratings | `masc_soil_ratings_with_latlon.csv` + river-lot scrape/KMZ → `web/public/data/masc/`, `web/public/data/masc-riverlots.json`, and `web/public/data/parcel-masc/` | Quarter-section and river-lot MASC layer, A-J rating colours, visible rating-letter labels, parcel-level Soil table field, and split-boundary river lots such as De Salaberry / St-Pierre-Jolys |
| [MASC Risk Areas / Risk Regions](https://open.canada.ca/data/en/dataset/739cb8ed-b661-5a60-7a26-eb60cd06541f) | `…/MASC_Risk_Areas/FeatureServer/0` | Official crop-insurance risk-area polygons, Risk Areas overlay labels, and parcel-level Risk Area table field |
| [Manitoba Water Rights Licensing (WALLAS)](https://web43.gov.mb.ca/Html5Viewer/Index.html?viewer=wallasExt.wallas&locale=en-US) | `web43.gov.mb.ca/arcgis/rest/services/WALLAS/wallas_op_external/MapServer` layers `7` (tile-drainage areas), `6` / `5` (tile lines + outlets), `2` / `3` (irrigation points of diversion / use) | Licensed tile-drainage footprints for the Tile Drainage overlay, column, and search filter; tile pipe runs and outlets; irrigation licences. CORS-enabled (origin-reflected), so it is queried directly with no proxy |

## Layout (sidebar + main pane)

The page splits into a fixed-width left sidebar holding all controls and a fluid main pane holding the map and table. On viewports below 900 px the layout collapses to a single column.

**Sidebar — Search section:**
- Municipality dropdown (preloaded with every distinct `Muni_Name_With_Typ` value; narrows the Zoning Category dropdown to the codes actually present in the muni)
- Civic Address (case-insensitive `LIKE`)
- Roll # — single value or a list. One roll runs as before; pasting many runs them all in one query and the count badge calls out any rolls that didn't match (e.g. `23 of 25 rolls matched · 2 of 25 not found: 1234, 5678`). Accepts both `3600` and `3600.000`. Cross-muni bulk via LINC is documented as future work in REPLICATION_GUIDE §15.5.

  Two punctuation rules, meaning opposite things:

  | | Characters | Meaning | Example |
  |---|---|---|---|
  | **Separate** | `,` space newline `;` | different properties | `83100, 85200` → 2 chips, 2 snapshots |
  | **Join** | `+` `&` `|` | one property, several rolls | `83100+83200` → 1 chip, 1 snapshot |

  A joined set stays a **single chip**, so the grouping is visible before the search runs. Its members shade together on the map, highlight as siblings on hover, share one badge number, and land in one combined Parcel Snapshot named for the first three rolls plus a parcel count (`610-83100_83200_85200-6p.jpg`). Each roll still gets its own grid row and assessment — joining is a statement about the subject, not the data. `|` is also the multi-parcel-comp joiner in the parcel-list import, so a roll list pasted out of that data groups the same way here.

  > `&` **joins** — it used to separate. If you have saved links or notes using `&` between unrelated rolls, they now produce one combined image instead of one per roll; swap those to commas.
- Legal Description (contains), Lot / Block / Plan (exact), and Certificate of Title (contains) from the generated MAO scrape index
- Zoning Category dropdown (per-muni narrowed)
- Status dropdown — `Any` / `Zoning Changed` / `Dev Plan Changed` / `Both Changed`
- DU mode + Min # input — `Any DU` / `0 DU only` (vacant) / `Min DU N` (≥ N units)
- Search · Clear · Export CSV
- Result count badge

**Sidebar — Map overlays section**. Each category is a collapsible
`<details>` group, with the toggles laid out two-up inside an inner
`.overlay-group-body` grid. The grid has to live on that wrapper: a
`<details>` renders its non-summary content inside an anonymous box, so a
grid declared on the `<details>` itself would treat that whole block as a
single grid item and stack the buttons in one column.

Six groups: Parcel layers, Historical, Planning, Reference, Agricultural
and Quick links. **Reference, Agricultural and Historical ship collapsed**;
the rest open. Open/closed state is *not* persisted — what you expand
stays expanded for the life of the page (the panel is never re-rendered,
so it survives tab switches and searches on its own) and a reload returns
to those defaults. Persisting it was worse in practice: opening
Agricultural once to reach a layer meant it stayed open on every future
visit, so "collapsed by default" quietly stopped being true.

A collapsed group with active settings shows an "N on" badge tinted to
that group's colour — counting ticked search filters as well as pressed
layer toggles, since a filter silently narrowing every search is exactly
what must not go invisible. Collapsed contents are `display: none`, so
they're out of layout and out of the tab order.

The **Historical** group pairs its Show button with the As of date picker
on one line, so the date reads as belonging to the toggle. The two
water-rights search filters sit at the foot of **Agricultural**, beside
the overlays they filter on. Because the Map layers panel renders under
whichever tab is active, that single pair of checkboxes serves both
Property Search and Sales Analysis with no duplicated control to keep in
sync — and they work on an imported sales CSV too, narrowing the comps to
tiled or irrigated parcels, with the count line naming how many it hid
(e.g. *5 of 5 sales plotted · 2 hidden by the licensed tile drainage
filter*).

Their two grid columns read as a scannable yes/no — Tile Drainage as
`Yes · 88%` or `No record`, Irrigation as `Yes` or `No record` — with the
licence number, licensee, status, legal location and specs on hover.

The Irrigation column, its CSV columns, and its search filter all key on
licensed **points of use** only. A point of diversion is an intake or a
well: water is taken from there, not applied to it, so it says nothing
about whether a parcel is irrigated. Diversions still draw on the map
overlay (blue, against violet for points of use); they are simply not
reported per parcel. Excluding them also halves the filter's work — about
2,500 points of use province-wide rather than 5,300 footprints across
both kinds — which is why an irrigation-filtered RM of Portage la Prairie
search now returns a complete 691 parcels instead of truncating at the
1,000-row cap.

**Only Tile Drainage carries a percentage, and that is deliberate.** The
two layers are different kinds of geometry:

- **Tile** polygons are drawn works footprints — median 99 acres but
  spanning 8 to 309, median 10 vertices, only 32% simple quadrilaterals.
  So "88% of this parcel lies inside the licensed tiled area" is a real
  measurement. It is not usually 100% because applications cover the wet
  ground rather than a whole quarter, and one licence often spans several
  parcels.
- **Irrigation** Point of Use / Point of Diversion polygons are **DLS
  quarter sections** — 92% are four-corner quadrilaterals with a median
  footprint of 803 × 804 m and 158 acres, against a quarter section's
  805 × 805 m and 160 acres. A coverage share there would describe where
  survey lines happen to fall relative to the parcel, not where water
  goes: on RM of Portage la Prairie, 64% of matched parcels sit ≥90%
  inside their licensed quarter and the rest straddle a boundary (median
  27 acres), and a parcel 40% inside a licensed quarter could be fully
  irrigated or not at all. Nothing in the geometry distinguishes those,
  so the column answers the only question the data supports — is this
  parcel within a licensed irrigation location, yes or no.

The CSV carries `Irrigation Location` (the survey quarter the licence
names) for evidence work. **`No record` is not `No`**: WALLAS holds
licensed works only and its tile polygons lag, so the honest claim is
"Manitoba has no licensed record here", not "this land is undrained".
Blank means the overlay hasn't been switched on yet, which is a third
state again. Both columns are `.water-only`, so they reveal themselves
whenever a WALLAS overlay or search filter is active and hide again when
it isn't — the same mode-class pattern the Dev-Plan columns use.
That applies in **sales-analysis mode and parcel-list imports too**: both
run the same enrichment, so an imported sales CSV gets tiled/irrigated
status per comp, and the CSV export leads each group with a filterable
`Tiled` / `Irrigated` column.

- **Tile Drainage** — licensed tiled-area footprints from Manitoba Water Rights Licensing (WALLAS). ~1,580 polygons province-wide, lazy-loaded and cached for 7 days, labelled with the licence number from zoom 11. Also populates the **Tile Drainage** table column (coverage % of parcel area + licence number, via the same area-weighted clip the Zoning and Dev-Plan columns use) and the four `Tile *` CSV columns. Every query filters `APPLICATION_STATUS` to the four licensed values, so rejected and abandoned applications never render.
- **Tile Lines & Outlets** — the lateral/header pipe runs and outlet structures inside a licensed tile area. 85,000 lines exist province-wide, so this layer holds the current viewport only: it refetches on map idle and stays empty below zoom 11 (mirroring the upstream service's own scale thresholds).
- **Irrigation Licences** — licensed water-use points of diversion (blue, where water is taken) and points of use (violet, where it is applied), filtered to `USAGE_CATEGORY = 'Irrigation'`. Popups carry licensee, groundwater-vs-surface source, works type, and aquifer or water-source name. Also populates the **Irrigation** table column — a plain `Yes` / `No record` — plus the five `Irrigation *` CSV columns (led by a filterable `Irrigated` yes/no). Only licensed points of **use** are reported per parcel; points of diversion are intakes and wells, so they draw on the map but say nothing about whether land is irrigated.
- **Sec-Twp Grid** — section-township grid plus river lots. With a municipality selected, it fetches the Manitoba Original Survey Legal Descriptions layer scoped to the muni boundary; without a muni, it uses the prebuilt province-wide static grid.
- **RM Website** — opens the selected muni's official site in a new tab. Auto-detects from a comprehensive lookup of every published municipal website in the province (`MUNI_WEBSITES` in [main.js](web/src/main.js)). Reads "RM N/A" when the muni's directory entry has no website.
- **PD Website** — data-driven. After every search, the dominant `PLANNINGDISTRICT` value across the dev-plan enrichment FC picks the active PD; `PD_WEBSITES` looks up its URL. Reads "PD N/A" when the PD has no website on file. Stays disabled until a search resolves the PD.

**Basemap menu** sits in the map's top-right gutter and offers CARTO Streets,
Esri Satellite, the Natural Resources Canada transportation map, and the NRCan
elevation hillshade. A fifth
**MLI aerial 2007-2013** row appears when the locally built historical PMTiles
archive is hosted and `VITE_MLI_ORTHO_PMTILES_URL` is set. While it is active,
the trigger reports the acquisition year at the map centre. See
[`docs/MLI-IMAGERY-BASEMAP.md`](docs/MLI-IMAGERY-BASEMAP.md).

## Results table

| Roll # | Address | Legal | Title | Zoning | % | Zoning 2 | ZBL | Dev-Plan Designation | DP By-law | Soil | Risk Area | Changes | DU | Acres | SF | Assess-{year} | Walkscore | Flood |

- **Legal** and **Title** populate for searches that match the generated MAO scrape index. Legal displays the brief legal description, with detailed legal text and parsed Lot / Block / Plan available in the cell tooltip and CSV export.
- **Zoning 2** hidden when its coverage is < 1% (digitization slivers).
- **Zoning** and **Zoning 2** show the short ZONE code only; the full ZONE_NAME is in the parcel hover popup and the zoning legend.
- **Soil** is the dominant MASC crop-insurance soil rating for the parcel, pre-baked per municipality from the MASC quarter-section and river-lot sources. The river-lot build handles numeric, lettered, and suffix lot IDs such as `RR-RL-F` and `MA-RL-94B`; the cell tooltip identifies the source quarter or river lot. **Risk Area** is stamped from the official `MASC_Risk_Areas` polygon containing the parcel's representative point. Parcels outside the relevant coverage render blank.
- **Changes** column shows `Z: AG-5 → RR1` or `DP: 03/10 → 23-05` when an amendment is recorded for the row's primary overlay match. Whitespace and Esri `<Null>` sentinels in the source data are filtered out so spurious "Z: " entries no longer appear.
- **Assess-{year}** — header is dynamically year-stamped (e.g. *Assess-2024*) using the most-common assessment year parsed from `Asmt_Roll` across the result set. The dollar value itself is the link to the parcel's MAO report.
- **Walkscore** — opens `walkscore.com/score/<address>`; no API key needed (the Walk Score page renders Walk / Transit / Bike on arrival).
- **Flood** — deep-links into the sister [Manitoba flood-mapping tool](https://mb-flood-mapping.vercel.app/) with `?lat=<centroid>&lon=<centroid>&label=<address>`. Falls back to `?address=…` when geometry is missing.

All columns sortable; CSV export carries the same column order plus legal detail, parsed Lot / Block / Plan, certificate-of-title text, raw coverage ratios, and the URLs for Walkscore / Flood / MAO Report.

## MASC coverage limits

The MASC Rating layer only paints ratings that exist in the generated quarter-section shards or the rated river-lot overlay. A 2026-05-07 coverage audit found zero MASC source centroids inside the largest blank polygons for `WEST INTERLAKE (RM)`, `PINEY (RM)`, `TACHE (RM)`, `RIDING MOUNTAIN WEST (RM)`, `DAUPHIN (RM)`, `ALONSA (RM)`, `GILBERT PLAINS (MUNICIPALITY)`, `PORTAGE LA PRAIRIE (RM)`, `TWO BORDERS (MUNICIPALITY)`, and `ARMSTRONG (RM)`, even when checking for ratings filed under another municipality. Treat those blanks as source coverage gaps or non-rated areas unless a newer MASC source file adds ratings there; do not fill them by nearest-neighbour interpolation for the map overlay.

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
6. Fetch the official MASC risk-area polygons and stamp each result with `_soilRiskArea` from the containing `Risk_Area` polygon.
7. If a municipality is selected, fetch the precomputed parcel-MASC shard and stamp each result with `_soilRating` plus quarter-section or river-lot metadata for the Soil table cell.
8. Results enrich the table, the map fits to bounds, and the zoning legend rebuilds against the actual codes present.

**Caching.** Data classes use distinct strategies:

- **Search results** — never cached. Every Search fetches current ROLL_ENTRY rows live, even when a generated legal-index match supplies the lookup keys.
- **Generated legal index** — static deployment artifact, regenerated from the MAO scrape with `npm run legal:index` whenever `../mao-scrape/results/parcels.parquet` is refreshed.
- **Generated MASC artifacts** — static deployment artifacts regenerated with `r/build_masc_shards.R` and `r/build_parcel_masc.R` whenever MASC ratings, the river-lot scrape/KMZ, or Roll Entry snapshots are refreshed.
- **Dropdown lists + auxiliary overlays** — cached in `localStorage` under the `mbpsCache.` namespace. Most lists and live overlays use a 7-day TTL; stable generated/reference overlays such as MASC, MASC Risk Areas, municipal boundaries, river lots, and the section grid use a 30-day TTL. Quota recovery evicts older namespaced entries before failing. Clear button wipes the namespace.
- **Per-muni overlay fetches** — cached per-muni so switching back to a recently-visited muni is instant.

**Dependencies** (`web/package.json`):

- `maplibre-gl` — map (CARTO Streets, Esri Satellite, NRCan Transportation, and NRCan Elevation)
- `pmtiles` — reads the optional MLI historical aerial archive (inert until `VITE_MLI_ORTHO_PMTILES_URL` is set)
- `@turf/area`, `@turf/bbox`, `@turf/intersect`, `@turf/boolean-point-in-polygon`, `@turf/length` — spatial primitives for the area-weighted join + route distances
- `@mapbox/mapbox-gl-draw` — measurement / draw tool on the map
- `tailwindcss` + `@tailwindcss/vite` — utility-first styles (dev)

No application database. Two **Vercel Edge Functions** under `api/` stream the legal-index and assessment-index from GitHub Releases (CORS proxy — the indexes are ~130 MB / ~17 MB, past Vercel's static rewrite ceiling). A **Mapbox API token** drives the optional Route Planner; without it the planner cleanly disables. Generated bulk data (RollEntry fallback shards, parcel-MASC, MASC, landcover shards/tiles, river-lots) lives in the sister **[mb-parcel-data](https://github.com/jayschellenberg/mb-parcel-data)** repo and serves via jsDelivr pinned to an immutable commit, not from this repo. The monthly data refresh runs `monthly-refresh.bat` (wrapped by `monthly-refresh-wrapper.ps1` for email alerts on failure) and is the only scheduled job; see [MAINTENANCE.md](MAINTENANCE.md) for the runbook.

## Running the web app locally

Prerequisites: Node.js 18+ and npm.

```bash
cd web
npm install
npm run legal:index   # refresh after the MAO scrape output changes
npm run dev
```

**Optional — Mapbox token for the Route Planner.** The planner uses Mapbox's Matrix/Directions/Static APIs (free tier ~100k requests/month). Without a token the feature stays disabled and everything else works. To enable it:

```bash
cp web/.env.example web/.env.local
# Edit web/.env.local — set VITE_MAPBOX_TOKEN to your pk.* token.
```

`web/.env.local` is gitignored. For production, set `VITE_MAPBOX_TOKEN` in Vercel → Project Settings → Environment Variables. Always **URL-restrict** the token in the Mapbox dashboard so it can't be used from foreign origins (see [MAINTENANCE.md](MAINTENANCE.md) → Mapbox token).

When MASC inputs change, rebuild the static shards from the repo root before starting or deploying:

```powershell
$env:MASC_SQUARE_CSV = 'D:\path\to\masc_soil_ratings_square_with_latlon_v2.csv'
$env:MASC_RIVERLOT_CSV = 'D:\path\to\masc_soil_ratings_riverlots_v2.csv'
Rscript r/test_masc_utils.R
Rscript r/build_masc_shards.R
Rscript r/build_parcel_masc.R
```

The square builder keeps special text ranges such as `29A`, collapses
exact duplicates, and retains multiple official ratings as a slash-separated
label such as `C/H`. The conservative/worst code supplies the map colour;
the complete label appears in the map and parcel table.

Open <http://localhost:5173>. The contaminated-sites CSV proxies through Vite's dev server so Show Enviro works in dev too.

If the project is running from a synced folder and Vite reports `Outdated Optimize Dep` or an `EBUSY` rename under `node_modules/.vite`, start dev with a temp cache:

```powershell
$env:VITE_CACHE_DIR = Join-Path $env:TEMP 'mbopendata-mb-parcelsearch-vite'
npm run dev -- --host 127.0.0.1 --force
```

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

The Shiny app reads the most recent `RollEntry_YYYYMMDD.gpkg` in the project directory. Shared paths resolve through [`r/config.R`](r/config.R) — the repo root is detected from the running script's location, and the external roots (snapshot archive, sister projects) can be overridden on another machine via the environment variables documented there (`MB_PARCELSEARCH_ROOT`, `MAO_SNAPSHOTS_ROOT`, `MAO_ASSEMBLY_ROOT`, `MASC_SCRAPE_ROOT`, `MB_PARCEL_HISTORY_ROOT`) instead of editing scripts.

## Known caveats

- `.gpkg`, `.tif`, and `.parquet` snapshots are gitignored — too large for GitHub and trivially regenerable.
- Roll # digits are not unique province-wide — always pair Roll # with a Municipality.
- **The assessment roll is the primary size source, and it is not always an area.** `Frontage_or_Area` from ROLL_ENTRY states an area on ~63% of parcels (`160.00 ACRES`) and a *frontage* on the other ~37% (`110.00 FEET`) — a width, which carries no area information and cannot be converted. The **Roll Frontage/Area** column reproduces whatever the roll says, verbatim, and the map popup shows it as *Roll States*. **Acres**/**SF** repeat that figure when it is an area and are computed from the polygon otherwise, with **Acres Src** recording which. On a frontage parcel the acreage is an estimate the roll does not support — and the two can look deceptively alike (roll 26325 in the RM of Ste Anne states `80.07 FEET` on a parcel whose polygon measures 79.9 acres). A nominal placeholder area on a large polygon (e.g. `0.01 ACRES` on crown/reserve land) is detected and overridden with the geometry figure.
- **The roll's recorded area and its own polygon can disagree.** Province-wide only ~63% of parcels carry a parsable assessor area, and of those roughly 15% differ from their polygon by more than 2% (see `logs/verify_areas_full.txt`). Past that threshold the app flags the row (⚠ on Acres, plus an **Area Check** column in the CSV) — a subdivision or consolidation that has reached one half of the record but not the other looks exactly like this.
- **The provincial extract trails Manitoba Assessment Online.** ROLL_ENTRY's publish date says when the province posted the extract, not that any individual roll is current. Observed 2026-08-05: RM of Ste Anne roll 126910 was served at its pre-subdivision 17.22 ac *with a matching pre-subdivision polygon* — attribute and geometry agreeing with each other, so no cross-check could catch it — a day after the layer's own `dataLastEditDate`, while MAO's map already showed the ±2.3 ac child parcel. The footer surfaces the publish date with this caveat; recently-changed parcels must be confirmed on MAO.
- Manitoba does **not** have a province-wide civic-addresses dataset, so multi-address parcels are only findable by their primary `Property_Address`. Rural parcels often store a quarter-section description here in lieu of a street address.
- The MHTIS Traffic Flow layer doesn't carry every road segment in the province — gaps are normal in less-trafficked corridors.
- ROLL_ENTRY's `AsmtYr` column referenced in the offline pipeline does **not** exist on the live FeatureServer. The assessment year is parsed from the `Asmt_Roll` text field (e.g. *"2024 Final"* → 2024).
- Some service configurations stringify null as the literal text `<Null>`; the client treats `null`, empty, single-space, and `<Null>` as equivalent.
- MASC quarter-section polygons are visual approximations: the source CSV supplies centroids, so the app draws ~800 m squares centred on each quarter. This is suitable for appraisal-research triage, but it is not a cadastral survey boundary.
- MASC coverage is farmland-oriented. Urban-only municipalities and parcels outside rated quarter sections can legitimately have no MASC soil rating. Risk-area coverage comes from the separate official MASC Risk Areas polygon source.
- **Tile drainage is licensed works only, and the polygon layer lags.** WALLAS layer 7's newest `APPLICATION_DATE` is 2024-08-29 while its own application tracker (layer 8) runs to the present, so recently-licensed tile may have no polygon yet. Unlicensed and older installations never appear at all. A blank Tile Drainage column is therefore **not** evidence that land is undrained — the CSV export carries this caveat on its face whenever water-rights data is included.
- The `TILE_*` detail fields (area, depth, lateral spacing, outlet type) are populated on well under 10% of records — 129 of 1,633 tile polygons carry `TILE_AREA`. The overlay popup and column tooltip show whichever fields exist rather than a fixed layout.
- WALLAS tile polygons describe the area *applied for*. `LEGACY_LABEL` distinguishes "Area of Proposed Tile Drainage Network" from "Area of Tile Drainage Network", but it is frequently null, so treat every footprint as approximate.
- ArcGIS's `esriSpatialRelIntersects` counts edge contact as an intersection, and neighbouring survey polygons share edges by construction, so the server-side filters return parcels a licensed area merely grazes. A match covering under 1% of a parcel (`MIN_WATER_COVERAGE` in [main.js](web/src/main.js)) is discarded rather than reported — a clipped rim says nothing true about whether land is drained or watered. The filters then drop those parcels outright once the exact clip has run, and the count line says how many went (e.g. *26 parcels found · 10 dropped (edge overlap only)*), so a filtered result never contains a row the column can't vouch for.
- Both water-rights filters (**Licensed tile drainage only**, **Licensed irrigation only**) resolve server-side to a parcel OBJECTID set, so the 1,000-row result cap applies to the already-filtered set rather than hiding matches behind it. Ticking both ANDs them. The irrigation filter matches licensed points of **use** only, matching what the Irrigation column reports, so the filter and the column can never disagree. Both live at the foot of the Agricultural group in Map layers and apply to an imported sales CSV as well as a Property Search.
- Footprints are sent to Roll_Entry in batches of 25 as a single multi-ring polygon rather than one request per footprint (`WALLAS_FILTER_BATCH_SIZE` in [arcgis.js](web/src/arcgis.js)). Ring winding is normalized first — Esri reads clockwise rings as outer and counter-clockwise as holes, so a naive merge would punch footprints out of their neighbours. Verified against the live service and unit-tested in [wallasFilterGeometry.test.js](web/test/wallasFilterGeometry.test.js).
- Expect the water-rights columns to take a while on a large, irrigation-dense result set: the exact area clip is the cost, not the queries. RM of Portage la Prairie with **Licensed irrigation only** returns a complete 691 parcels in ~26 s, of which the exact clip is the bulk and the spatial queries ~2 s; a plain muni search there is ~10 s. The clip runs in a Web Worker so the UI stays responsive, and the status line reads "Checking water-rights licences…" while it works. Ordinary searches are a few seconds.
- Irrigation is licensed works only, with the same "blank is not proof" caveat as tile drainage. `WATER_SOURCE_NAME` and `ACQUIFER_NAME` are frequently null even on current licences, so the Irrigation Source CSV column is often empty — `Irrigation Supply` (Groundwater Use / Surface Water Use) is the reliable field.
- WALLAS's "Point of Diversion" and "Point of Use" layers are **polygons**, not points, despite the naming — the geometry is the legal-location footprint the licence attaches to, at survey-quarter granularity. That is why the Irrigation column carries no coverage percentage: see the Map overlays section above. The Tile Drainage percentage is the share of the *parcel* covered by the licensed footprint, the same basis as the Zoning and Dev-Plan columns.
- WALLAS layer 7 carries no `LOCAL_GOVERNMENT` column (layer 8 does), so municipal narrowing is spatial. The tile-only filter fetches the muni's extent via one `returnExtentOnly` request and clips the polygon set before running per-polygon parcel queries; without a municipality selected it has to test every licensed footprint in the province, which is slow but correct.
- `MUNI_WEBSITES` and `PD_WEBSITES` (in [main.js](web/src/main.js)) are hand-curated from the province's official Municipal and Planning District contact directories. Munis whose only published contact is a generic email render as "RM N/A" — adding an entry to the constant promotes them to a working button.

## Replicating this for another jurisdiction

See [REPLICATION_GUIDE.md](REPLICATION_GUIDE.md). Originally written for the Winnipeg Socrata source; §14 covers this ArcGIS REST variant including every operational detail an adaptation would need: SQL92 dialect quirks (no `TRIM()`, `<Null>` sentinel), bulk-fetch vs per-parcel envelope decision, true polygon-geometry filter resolution, paginated OBJECTID collection, localStorage TTL caching, the Web Worker / rbush optimization deferred to a follow-up perf pass, and the comprehensive muni/PD lookup pattern.
