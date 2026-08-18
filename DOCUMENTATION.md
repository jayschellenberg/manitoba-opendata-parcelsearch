# Manitoba Parcel Search — Data, Land-Cover, Archive & Historical Systems

Complete reference for the data pipelines and features built around the
webapp: the **land-cover** layer, the **snapshot archive** (with provenance
sidecars), the **historical (as-of-date) compare** view, the **parcel
lineage index**, and the **evidence-export provenance** that stamps every
CSV / parcel-snapshot export — plus the maintenance, freshness, and hosting
model that ties them together.

This complements `README.md` (which covers the core search UI). For the
short operator checklist, see `MAINTENANCE.md` — it's a subset of §8 here.

> **Appraisal-defensibility model (read first).** Everything historical is
> keyed by **snapshot date** (`YYYY-MM-DD`), not by year. The unsimplified
> archived source files are the **source-of-record**; the CDN display shards
> are **simplified (~2-3 m) for visualization only** — resolve any
> acreage/boundary measurement back to the archived file named in the
> provenance. Historical zoning/dev-plan are **pointers to verify** against
> by-law / planning-district / title records, never legal determinations.
> **Public provincial data only** ever enters the `mb-parcel-history` repo —
> no client, sales, or private data.

---

## 1. Big picture

The webapp is a static Vite site on **Vercel**. Most of it runs off **live
ArcGIS** REST services. On top of that, several datasets are **generated**
by R scripts and served either from the deploy or from a CDN:

```
  Province of Manitoba Open Data  ─┐
  (MBRollGeoPackage, Zoning,       │  manual download
   Dev-Plan, LCR_RCT_2020 raster)  ▼
        ┌──────────────────────────────────┐
        │ mao-assembly (sister R project)   │ land-cover extraction, etc.
        └──────────────┬───────────────────┘
                       │ Parquet
        ┌──────────────▼───────────────────┐      ┌────────────────────────────┐
        │ THIS repo: r/build_*.R pipelines  │      │ MAOSnapshots\<year>\       │
        │  - build_landcover.R              │      │ (Dropbox cold archive)     │
        │  - build_landcover_tiles.R        │      │  dated provincial src      │
        │  - build_historical_shards.R      │◄─────┤  + <file>.meta.json        │
        │  - build_lineage.R                │      │    provenance sidecars     │
        └───────┬───────────────────┬───────┘      │  (archive_snapshot.R)      │
                │ in-deploy shards   │ historical   └────────────────────────────┘
                ▼                    ▼ shards + lineage
   web/public/data/**         mb-parcel-history repo ──► raw.githubusercontent
   (Vercel deploy)            (separate, data-only)      (free, pinned commit)
                \                   /
                 ▼                 ▼
              ┌───────────────────────┐
              │   the webapp (Vercel) │
              └───────────────────────┘
```

**Two repos:**
- **`manitoba-opendata-parcelsearch`** (this one) — the app + all generator
  scripts + the in-deploy generated data.
- **`mb-parcel-history`** — data-only; per-muni historical shards served via
  raw.githubusercontent (pinned commit; moved off jsDelivr 2026-08-17 — the
  repo is over jsDelivr's 50 MB package limit, see MAINTENANCE.md §1b). Kept
  separate so ~300 MB/year of history never bloats the main repo or the
  Vercel deploy.

**Automated snapshot publish (2026-07):** the historical-snapshot path
(download → archive → shards → lineage → push `mb-parcel-history` → repin the
app CDN SHA → Vercel) now runs **end-to-end, unattended**, twice a year via
`semiannual-publish-wrapper.ps1` (Windows task `mb-parcelsearch-semiannual-archive`,
Jan 1 / Jul 1). It fetches the three provincial layers itself
(`r/download_provincial_snapshot.R`), so the snapshot path no longer needs the
manual MB Open Data download shown in the diagram — that manual download now
feeds only **mao-assembly's** land-cover inputs. A daily dead-man watchdog
(`mb-parcelsearch-history-staleness`) alerts if a publish is ever missed. See §8.

---

## 2. Data classes (and how each is handled)

| Class | Examples | Where served | Cadence |
|---|---|---|---|
| **Live** | parcels, zoning, dev-plan | ArcGIS (live) | always current |
| **Latest-only generated** | legal-index (129 MB), assessment-index (28 MB), land-cover shards, land-cover tiles, RollEntry snapshot fallback | `web/public/data/**` (in deploy) | monthly / on rebuild |
| **Cold archive + provenance** | dated provincial source downloads + `<file>.meta.json` sidecars (sha256, source date, retrieved_at, source_crs, source_url, license) | `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\` (Dropbox, outside git) | semi-annual / annual |
| **Historical shards** | per-muni parcels/zoning/dev-plan **per snapshot date** (`YYYY-MM-DD`) + per-snapshot provenance manifest | `mb-parcel-history` → raw.githubusercontent | when a snapshot is archived |
| **Lineage index** | inferred predecessor/successor per parcel, per muni | `mb-parcel-history/lineage/**` → raw.githubusercontent | when ≥ 2 snapshots exist |

### 2.1 Soil-productivity geometry and scale

The **Soil Productivity / Soil Name** overlay reads Manitoba's live
`Soil_Survey_MB` FeatureServer. Both soil fetch paths request the original
source geometry (no ArcGIS `maxAllowableOffset`), and their MapLibre GeoJSON
sources use `tolerance: 0`, so the app does not simplify the survey vertices.
Municipality-scoped results remain cached for 30 days.

This preserves the best geometry published by Manitoba, but it does not make
the survey more precise than its source mapping. The Hanover records identify
the underlying survey as **1:50,000**. Approximately 20-acre soil patterns are
therefore retained when present in the source, but parcel-level decisions and
area measurements should still be verified against the authoritative survey
and field evidence.

---

## 3. Land-cover layer

Shows, per parcel, the 2020 land-cover composition (Cultivated / Pasture-
Grass / Bush-Treed / Wetland-Water / Other) — in the tooltip, the results
grid, and as a map overlay. **Farmland-focused: only parcels over the
acreage threshold get data.**

### 3.1 Where the numbers come from
The heavy raster work (zonal extraction of `LCR_RCT_2020_MB.tif` against
every parcel) is done by the sister **mao-assembly** pipeline, which writes
`MAOParcelOutputAg<YYYYMMDD>.parquet` with a percentage per parcel for each
of 12 land-cover classes. **This repo does not touch the raster** — it
bridges that Parquet.

### 3.2 `r/build_landcover.R`
- Reads the newest **complete** assembly Parquet. *(Robustness: it picks the
  Parquet with ≥ 80 % of the max row count and prints a NOTE skipping any
  newer-but-partial/aborted run — a partial run had once collapsed coverage
  to 18 munis.)*
- Filters to parcels over the acreage threshold; collapses the 12 classes
  into 5 buckets; writes per-muni shards `web/public/data/landcover/<MUNI>.json`
  + `_index.json`.
- **Key:** the shard roll key (`Roll_No_Txt`) is **reconstructed** from the
  Parquet roll as `sprintf("%.3f", TaxID)` (verified to equal the live
  `Roll_No_Txt` for 100 % of parcels), then attached to the muni via a
  stable `MuniCode → Muni_Name_With_Typ` map. This deliberately does **not**
  inner-join a parcel snapshot, so a parcel present in the Parquet but absent
  from a slightly-stale snapshot still gets land cover (this is what fixed
  the Rockwood parcels showing no cover).
- Runs as a **non-fatal** step inside `monthly-refresh.bat`.

### 3.3 Acreage threshold (a tunable constant — keep in sync)
Two places, **currently 10 acres**, that MUST match:
- `ACRES_THRESHOLD` in `r/build_landcover.R` (drops smaller parcels from the
  shards)
- `LAND_COVER_MIN_ACRES` in `web/src/lib/landcover.js` (the webapp display/
  overlay gate)

Bucket mapping (12 raster classes → 5 buckets):
`cult` = 2 · `past` = 7, 9 · `bush` = 4, 5, 6 · `wet` = 3, 8 ·
`other` = 0, 1, 10, 11. The same mapping lives in
`build_landcover_tiles.R`'s colour table and `web/src/lib/landcover.js`.

### 3.4 Frontend (in-app)
`web/src/lib/landcover.js` is the single source of truth for bucket order/
labels/colours. The tooltip box (`map.js`), the grid columns **Land Cover**
+ **Cult %** (`main.js`, `index.html`, `columns.js` "Agricultural" preset),
and the map overlay all read from it.

### 3.5 Land-cover **Detailed** tiles — `r/build_landcover_tiles.R`
A z6–z12 XYZ raster pyramid of the 2020 raster for the overlay's "Detailed"
pixel view. **Lossless WebP** (`--tiledriver WEBP --webp-lossless`), ~84 MB
(down from 220 MB PNG), committed under `web/public/data/landcover-tiles/`.
Needs GDAL on PATH. **Rebuild only when a new `LCR_RCT_*.tif` lands** (years
apart) — it's static, so it's not part of any refresh.

---

## 4. Snapshot archive + provenance

Retains a dated, point-in-time copy of the provincial source data so a
parcel's pre-subdivision size/shape (and later its zoning/dev-plan) can be
recovered — each archived file paired with a **provenance sidecar** that
makes it citable as appraisal evidence.

### 4.1 `r/archive_snapshot.R`
- Copies the current provincial downloads from `mao-assembly/inputs/` into
  `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\`, **append-only** (never
  overwrites a prior capture), named `<sourcename><YYYYMMDD>.<ext>` by the
  source file's download date.
- **Geometry (`MBRollGeoPackage.gpkg`) is active**; zoning + dev-plan are
  wired but off — run with `--all` to capture them too.
- Writes/refreshes a **`<file>.meta.json` provenance sidecar** beside every
  archived file (see §4.3). Idempotent: re-running back-fills missing
  sidecars and refreshes config (e.g. a new `source_url`) without
  re-hashing an unchanged file or downgrading an authoritative timestamp.
- Prints a **STALE warning** if a source it archives is > 12 months old.
- Lives in **Dropbox, outside git and the deploy** — never bloats either.
  ~225 MB/geometry snapshot. Consult cold in QGIS/R.

### 4.2 Layout
```
D:\Dropbox\Appraisal\Web\MAOSnapshots\
  2025\  MBRollGeoPackage20250212.gpkg  + .meta.json,  Manitoba_Zoning_*20250222.geojson + .meta.json, ...
  2026\  MBRollGeoPackage20260605.gpkg  + .meta.json,  Manitoba_Zoning_By_Laws20260603.geojson + .meta.json, ...
```

### 4.3 Provenance sidecar (`<file>.meta.json`) — the defensible record
One JSON sidecar per archived file. Fields:

| Field | Meaning |
|---|---|
| `source_date` | the as-of date, read from the **explicit filename date** (operator-set), not mtime |
| `retrieved_at` + `retrieved_at_inferred` | when the file was archived; `inferred:true` means it fell back to mtime (untrustworthy on its own) for a pre-existing/back-filled capture |
| `source_crs` | **CRS as shipped** — e.g. the 2025 Roll Entry GeoPackage ships in `EPSG:3857` (Web Mercator, native areas ~2.4× inflated at MB latitudes) while 2026 ships in `EPSG:26914` (UTM-14N). Always treat a reprojected **metric** CRS as the area-of-record, never the native one |
| `sha256` | content hash of the archived file (immutable identity for citation) |
| `bytes`, `schema_fields` | size + the attribute columns present |
| `source`, `source_dataset`, `source_url`, `license` | where it came from + licence terms to verify |
| `note` | reminder that display shards are simplified — resolve evidence back to this file |

`build_historical_shards.R` lifts these straight into each snapshot's
manifest (`layers[]`), so the same hash/date/CRS/URL travel to the CDN and
into the app.

---

## 5. Historical (as-of-date) compare view

Overlays an earlier **snapshot's** parcels/zoning/dev-plan for a selected
muni so you can compare against today (e.g. a parcel before it was
subdivided). Keyed by **snapshot date** (`YYYY-MM-DD`), not year — two
captures in the same calendar year are two distinct snapshots.

### 5.1 Pipeline — `r/build_historical_shards.R`
- One snapshot = **one dated parcel file**; its date is the `snapshot_id`
  (`YYYY-MM-DD`). For each, shards the three layers (parcels + zoning +
  dev-plan), simplified ~2-3 m, EPSG:4326, **keyed by muni number**. Zoning /
  dev-plan are paired to the parcel snapshot by picking the archived layer
  **on-or-before** the parcel date.
- Writes a per-snapshot **`manifest.json` (schema 2)** carrying each layer's
  source date **and full provenance** (`source_file`, `sha256`,
  `retrieved_at`, `source_url`, `source_crs`, `license`, lifted from the §4.3
  sidecars), the generator `commit`, the `simplify_tolerance_deg`, a
  geometry-accuracy note, and a verify **disclaimer**.
- Writes a root **`index.json` (schema 2)** whose `snapshots` map lists each
  `snapshot_id` with its per-layer source dates + muni count (discovery). Since
  the app pins an immutable CDN commit (§5.2), surfacing a new snapshot means
  bumping that pinned SHA — a one-line app change on republish.
- **Loud field validation:** missing critical **parcel** fields (roll / muni)
  **hard-fail** the snapshot; missing zoning/dev-plan fields warn (§5.8).
- Output → `mb-parcel-history` repo (`OUTPUT_ROOT`).
- Prints a **STALE warning** if the newest snapshot is > 12 months old.
- Usage: `Rscript r/build_historical_shards.R [--year <yyyy>] [--muni <code>] [--index-only] [--require zoning,devplan]`
  (`--year` filters snapshots by calendar year; `--muni` is the fast-test
  path; `--index-only` just rewrites the discovery index; **`--require`**
  hard-fails any processed snapshot missing the named layer(s) — the publish
  wrapper passes `zoning,devplan` so an automated snapshot can never silently
  ship parcels-only).

### 5.2 The data repo + CDN
`mb-parcel-history` layout (served read-only via raw.githubusercontent, **free**):
```
index.json                              # discovery: snapshots + per-layer dates (schema 2)
<snapshot_id>/manifest.json             # provenance + munis { "<muni_no>": { name, parcels } }
<snapshot_id>/parcels/<muni_no>.json    # GeoJSON FC (simplified, 4326)
<snapshot_id>/zoning/<muni_no>.json
<snapshot_id>/devplan/<muni_no>.json
lineage/<muni_no>.json                  # inferred predecessor/successor (§5.6)
lineage/_index.json
```
`<snapshot_id>` is the full date, e.g. `2026-06-05/parcels/168.json`.
The app fetches same-origin `/gh-data/mb-parcel-history/<commit-sha>/<path>`,
which the `api/gh-data.js` edge proxy upstreams to
`https://raw.githubusercontent.com/jayschellenberg/mb-parcel-history/<commit-sha>`
with Vercel's edge cache in front — the app **pins an immutable commit**, not
a branch ref, so every client sees one coherent tree. (Until 2026-08-17 this
was jsDelivr, where `@main` served stale geometry for some munis even after
purging; the repo then outgrew jsDelivr's 50 MB package limit entirely — see
MAINTENANCE.md §1b.) On every republish, bump the pinned SHA in
`web/src/arcgis.js` (`HISTORICAL_CDN`) — see MAINTENANCE.md §3. The shard
cache key is stamped with the manifest's build timestamp, so clients
auto-invalidate on the next load.

### 5.3 Frontend
- **arcgis.js**: `fetchHistoricalIndex` / `fetchHistoricalManifest` /
  `fetchHistoricalShard` / `fetchHistoricalLineage` (cache keys bumped to
  `v2`; 1 day for index/manifest, 30 days for the immutable shards/lineage).
  The fetchers' `year` parameter now carries a **snapshot_id** value.
- **map.js**: `historical-parcels` / `-zoning` / `-devplan` sources;
  parcels render as **dashed amber** lines over today's lots, zoning/dev-plan
  as translucent clickable fills **coloured per category** (§5.3.3).
  `setHistoricalData`, `HISTORICAL_LAYER_IDS`
  + `setHistoricalLayerVisible` (one layer), `setHistoricalVisible` (master
  off) + per-layer click tooltips. Parcel tooltips show **lineage** (`← from` /
  `→ became`, with confidence) and a "verify" note; zoning/dev-plan tooltips
  carry a "pointer only — verify" line.
- **main.js**: the **Historical** toggle + **"As of"** snapshot-date picker
  (under Parcel layers, dates grouped by year via `<optgroup>`),
  muni→muni_no resolution from the snapshot manifest, the
  `HISTORICAL as of <date> · Roll <date> · Zoning <date> · Dev Plan <date> ·
  verify vs by-law / title` banner, and a `> 12 mo old` flag.
- **Self-contained:** reads only shard fields — no coupling to the live
  enrichment pipeline (legal/assessment/MASC/land-cover).

#### 5.3.2 The three context layers are opt-in, one toggle each
Each historical layer blankets the WHOLE municipality, so switching all three
on together buried whatever the user had searched for. Measured on Brandon
2025-02-12, the composite wash was **0.256**, of which `historical-zoning-fill`
(0.12) was 49% and `historical-devplan-fill` (0.10) 41% — the parcel fill was
10%, and lightening it alone (0.06 → 0.025) moved the total by 11%, which is
invisible. Every parcel in the muni was also outlined in dashed amber on top.

- A **Layers** row under the As-of picker carries three sub-toggles —
  **Parcels / Zoning / Dev Plan** — driving `setHistoricalLayerVisible`.
  State lives in `historicalLayersOn`; `applyHistoricalLayers()` pushes it to
  the map and to the buttons' pressed state in one place.
- **All three default OFF.** An as-of date on its own draws only the searched
  parcel's as-of boundary (§5.3.1). The status line says so and names the
  control, so an intentionally sparse map can't be mistaken for a failed load.
- State **persists** across toggling Historical off/on and across an As-of date
  change — walking the snapshot dates shouldn't make you re-tick zoning at
  every step. It is not persisted across a reload.
- `historicalGeomByKey` is built whether or not the Parcels layer is on: it
  drives the search highlight, which is independent of these toggles.
- The size-change colour key only prints in the status line when Parcels is
  actually drawing; the counts print either way.
- The sub-toggle ids deliberately do **not** end in `-toggle`, which is the
  selector the URL-state writer uses (`button.overlay-btn[id$="-toggle"]`), so
  they stay out of shared links. The group's "N on" badge does count them —
  it selects on `aria-pressed`.

#### 5.3.3 Historical zoning / dev-plan are coloured per category
Both fills were originally ONE flat colour for every polygon — `#7c3aed` across
all 1,554 of Brandon's zoning polygons, `#0d9488` across all 92 dev-plan ones.
A single colour over a whole city asserts "this is all one zone", and was read
that way: the subject clicked as RHD, the map showed no variation, so the city
looked RHD. The data was never at fault — 409 sampled Brandon parcel centroids
at 2025-02-12 gave 99% zoning / 100% dev-plan coverage and a distribution of
**RSD 47%, RLD 27%, RMD 11%, RHD 1.2%**.

- `setHistoricalCategoryPaint` (map.js, called from `setHistoricalData`) builds
  a `match` expression over `ZONE` / `DES_NAME` and returns legend rows;
  `getHistoricalLegend('zoning'|'devplan')` exposes them.
- Colours come from **`colorForZoneCode`, the same palette the live Zoning
  Layer uses**, so a code is the identical colour in the as-of and current-day
  views. Comparing eras means comparing colours; a per-layer palette would have
  made RSD-then and RSD-now look like different zones.
- **Known collision:** the palette is a hash, so codes can share a colour —
  Brandon 2025-02-12 has `CN` and `OS` both at `#df90d1`. Pre-existing and
  shared with the live layer, but more visible now there is a 24-row legend.
- `#historical-zoning-legend` / `#historical-devplan-legend` are separate boxes
  from `#zoning-legend`, so the as-of and current-day keys can be read side by
  side. Each shows only while its own layer draws, is titled with the
  snapshot_id, and is picked up by the static-map export (`readMapLegends`).
- Opacity 0.35 / 0.30 (was 0.12 / 0.10) — justified because §5.3.2 made these
  opt-in, and switching a zoning overlay on deliberately is a reason to see it.

> **Designation vocabularies are NOT stable across snapshots.** Brandon
> replaced its development plan between 2025-02-12 (92 polygons, 8 designations
> — Residential / The Hub / Commercial …, by-law `95/01/12`) and 2026-06-05
> (7 polygons, 4 designations — General Urban / Employment / Floodway /
> Development Reserve, by-law `7392`). Across such a boundary the designations
> are not comparable and neither are their colours. Read the by-law number in
> the popup before comparing two dates.

#### 5.3.1 The search highlight follows the as-of date
While a snapshot is active, a **Property Search highlights the parcel as it
stood at that date** — the yellow outline and the camera fit both come from the
snapshot shard, not from today's Roll Entry. Without this the two disagreed:
Brandon roll **562264** (1501 BRAECREST DR) was 12.23 ac on 2025-02-12 and is
3.78 ac today after roll 562314 was carved off it, so a search under the
2025-02-12 banner used to highlight (and zoom to) the small modern remnant.

- `lib/historicalHighlight.js` — `indexHistoricalGeometry(shardFc)` keys the
  loaded shard by **(muni, roll)**; `applyHistoricalGeometry(resultFc, index)`
  returns a copy of the result set with as-of geometry swapped in. Pure, unit-
  tested (`test/historicalHighlight.test.js`). Keyed by muni **and** roll
  because roll numbers are unique only within a municipality — a multi-muni
  result set must never borrow another muni's parcel.
- Applied in `setMapData` (so both of a search's pushes get it) and on the
  soil-composition re-push; `refreshAsOfHighlight()` re-draws the current
  result set when the date is toggled or changed, so no re-search is needed.
  It re-fits the camera only when geometry actually moved.
- **Scope: the map highlight only.** The results table, CSV / evidence exports
  and Parcel Snapshot images stay on today's record — those are live-enriched
  (legal, assessment, MASC, land cover) and the shards carry none of it. The
  popup says which boundary it is drawing (`Boundary as of <date>`, from the
  `_asOfGeom` / `_asOfDate` stamps) and repeats the simplified-geometry caveat.
- A roll with **no parcel at that date** (created since) keeps today's boundary
  and is named in the status line — `1 had no parcel at that date (roll 562314)
  — still showing today's boundary` — rather than silently falling back.
  Lineage (§5.6) is not yet consulted here: showing such a roll's *predecessor*
  outline as-of would need a reverse lineage lookup.

### 5.4 Sync — how the two projects stay aligned
- **Generator in the main repo** = one source of truth for the format.
- **Discovery:** the app reads `index.json`; adding a snapshot needs only the
  **pinned CDN SHA bumped** in `arcgis.js` (§5.2) — no other app changes.
- **Self-describing manifests** map muni_no ↔ name per snapshot.
- **Field contract:** `PARCEL_FIELDS` / `ZONING_FIELDS` / `DEVPLAN_FIELDS`
  in `build_historical_shards.R` are what the historical renderer reads;
  the generator uses tolerant field selection so a provincial rename won't
  crash it.

### 5.5 Municipal change over time (amalgamation / annexation)
The app navigates by **today's** municipalities. Handled in two halves:
1. **Historical truth is preserved** — every feature keeps its own
   `Municipality` / `Muni_Name_With_Typ` / `Roll_No_Txt` as of its snapshot,
   shown in the historical tooltip. *(done)*
2. **Navigation by current geography** — for a snapshot that spans a
   reorganization, re-bin each feature to the **current** muni boundary it
   falls within (a spatial join to the live MUNICIPALITY layer) and key the
   shard by that current muni. *(documented TODO in the script — activates
   when the first pre-2015 / post-amalgamation snapshot is archived; it's a
   no-op for all post-2015 snapshots, so the current 2025/2026 shards are
   correct as-is.)*

### 5.6 Parcel lineage index — `r/build_lineage.R`
Infers parcel **predecessor / successor** relationships between consecutive
snapshots so the app can answer "this lot **← came from** … / **→ became** …".
- **Roll-identity model:** the same `Roll_No_Txt` across snapshots = the same
  parcel. Events arise only from **new** rolls (appear) and **removed** rolls
  (disappear) — re-survey geometry noise on a stable roll is **not** a change.
- **Geometry link:** new/removed parcels are intersected (reprojected to
  `EPSG:26914`, UTM-14N — a **metric** CRS, never the inflated Web-Mercator
  native one) against the full other-snapshot set; an overlap counts when it
  covers ≥ `EDGE_COVER` (50%) of the parcel. Connected components (union-find)
  group a subdivision/consolidation cluster.
- **Classified** as subdivision / consolidation / replacement /
  reconfiguration; each event carries a **confidence** = min overlap coverage.
- Output: `lineage/<muni_no>.json` (an `events` list + a `by_roll` lookup the
  app reads) and `lineage/_index.json`. Every record carries a **verify
  disclaimer** — lineage is *inferred from public geometry*, to be confirmed
  against registered plans / titles, not treated as proof.
- **CRS lesson baked in:** the first build returned 0 events because the 2025
  source was `EPSG:3857` and 2026 was `EPSG:26914`, so the intersection
  silently errored to empty. This is exactly why `source_crs` is now recorded
  in provenance (§4.3) and everything reprojects to a common metric CRS.

### 5.7 What lands in the snapshot manifest (provenance summary)
Each `<snapshot_id>/manifest.json` (schema 2) carries, per layer:
`source_file`, `source_date`, `retrieved_at` (+`_inferred`), `source_crs`,
`sha256`, `bytes`, `source_url`, `license`, `munis`, `features` — plus a
top-level generator `commit`, `crs`, `simplify_tolerance_deg`, geometry note,
and a verify `disclaimer`. This is the chain that lets a figure in an
appraisal be traced from the app → the CDN shard → the manifest hash → the
archived source-of-record file.

### 5.8 Loud field validation
`require_fields()` in the shard builder fails **loudly** rather than shipping
silently-degraded data: a **parcel** snapshot missing a critical field
(roll / muni) **hard-stops** the build (without those the app can't key or
render); a zoning/dev-plan layer missing a field prints a warning and
continues (those overlays degrade gracefully) — **unless `--require` (§5.1)
names that layer**, in which case a missing layer, a missing critical field,
or a 0-feature result also hard-fails. The semiannual publish wrapper passes
`--require zoning,devplan`, so an automated snapshot is all-or-nothing.

---

## 6. Evidence-export provenance (CSV + parcel snapshots)

Every export the app produces can end up pasted into an appraisal report, so
each one carries a **self-describing provenance record** answering: *when* it
was pulled, by *which build*, from *what sources*, with *what caveats*.

- **`web/src/lib/provenance.js`** builds the record and renders it two ways
  (pure, unit-tested — `web/test/provenance.test.js`):
  - **`provenanceCsvLines()`** — a `#`-prefixed comment preamble prepended to
    the CSV (single column, blank-row separated from the table, trivial to
    delete in a spreadsheet / skip on re-import).
  - **`provenanceText()`** — a plain-text block written as **`PROVENANCE.txt`**
    inside the parcel-snapshot ZIP.
- **What it records:** export timestamp (UTC), **app commit + build time**,
  row count (+ sales / starred-only flags), the **live provincial source
  URLs** queried at export time (`SERVICE_SOURCES` from `arcgis.js`), the
  **local enrichment data refresh date** + per-dataset schema/rows (from the
  data manifest), an Esri imagery credit (snapshots), and the standing
  **disclaimer** (areas are app-computed approximations; zoning/dev-plan are
  pointers to verify; land-cover is a 2020-raster estimate).
- **App build identity** is baked in at build time by a Vite `define`
  (`vite.config.js`): `__APP_COMMIT__` (from `VERCEL_GIT_COMMIT_SHA`, or
  `git rev-parse` locally) and `__APP_BUILD_TIME__`. `provenance.js` reads
  them through a `typeof` guard so dev/test runs fall back to `dev`.
- **Historical caveat:** if the Historical overlay is active during an export,
  the preamble notes the snapshot date **and** flags that the **exported rows
  are still current/live data**, not the snapshot — the historical layer is a
  simplified visualization; resolve measurements to the source-of-record.
- Wired in `main.js`: `exportCsv()` (the parcels/sales CSV) and
  `handleSnapshotExport()` (the snapshot ZIP). The unmatched-sales CSV is a QA
  diagnostic and intentionally excluded.

---

## 7. Hosting & cost

- Main app: **Vercel** (deploys from `main`).
- Historical shards: **raw.githubusercontent** off a public GitHub repo —
  **$0**, isolates ~300 MB/snapshot from the main repo + deploy.
- Cold archive: **Dropbox** (already in use), outside git/deploy.

---

## 8. Maintenance / recurring tasks

**The snapshot publish is automated** (task `mb-parcelsearch-semiannual-archive` →
`semiannual-publish-wrapper.ps1`, Jan 1 / Jul 1 04:30): download → archive →
shards → lineage → push `mb-parcel-history` → repin the app CDN SHA → push app
→ Vercel. Any failed step emails + ntfy-alerts and stops; the daily
`mb-parcelsearch-history-staleness` watchdog covers a run that never fires at all.
Rows 4-6 below are the **manual fallback** (backfill / off-cycle).

| # | Task | Cadence | Command |
|---|---|---|---|
| 1 | Monthly refresh (legal/assessment/land-cover shards) | monthly | `monthly-refresh.bat` → review `git status`, commit, push |
| 2 | **Snapshot publish (end-to-end)** | **semi-annual, scheduled** | `mb-parcelsearch-semiannual-archive` → `semiannual-publish-wrapper.ps1`; by hand: run that script, or `-TestAlert` to check the alert path |
| 3 | **Staleness watchdog** | **daily, scheduled** | `mb-parcelsearch-history-staleness` → `history-staleness-check.ps1`; register via `schedule_history_check.ps1`; `-DryRun` / `-TestAlert` |
| 4 | Snapshot archive only (no publish) | as needed | `Rscript r/archive_snapshot.R` (or `--all`) |
| 5 | Build a snapshot's shards by hand | backfill | `Rscript r/build_historical_shards.R --year <yyyy> --require zoning,devplan` → commit/push `<snapshot_id>/` + `index.json` in `mb-parcel-history` |
| 6 | Rebuild parcel lineage by hand | backfill (≥ 2 snapshots) | `Rscript r/build_lineage.R` → commit/push `lineage/` |
| 7 | Land-cover shards / Detailed tiles | mao-assembly rerun / new raster | inside `monthly-refresh.bat` / `Rscript r/build_landcover_tiles.R` |
| 8 | Provincial land-cover inputs (mao-assembly) | ≥ annual | manual MB Open Data download into `mao-assembly/inputs/`, rerun mao-assembly (the snapshot path auto-downloads separately) |

The automated wrapper repins an **immutable commit SHA**, and
raw.githubusercontent serves any pushed commit immediately — no purge step
exists or is needed on either the automated or the manual path. (The old
jsDelivr purge instruction died with the jsDelivr hosting, 2026-08-17.)

---

## 9. Freshness / staleness (the 12-month rule)

| Signal | Where | Threshold |
|---|---|---|
| Current data banner | app (top of search) | hidden ≤ 180 d · amber 181-365 d · red > 365 d (MAO scrape is semiannual) |
| Historical archive | app historical banner | `> 12 mo old` tag |
| Provincial source | `archive_snapshot.R` console | `!! STALE` > 12 mo |
| Newest snapshot | `build_historical_shards.R` console | `!! STALE` > 12 mo |
| **Snapshot overdue (watchdog)** | `mb-parcelsearch-history-staleness` (daily) → email + ntfy | newest **built OR app-pinned** snapshot > **215 d** (~1 mo past cadence) |
| **Layer shrank on download** | `download_provincial_snapshot.R` (in the publish) | **aborts** the publish if a layer is > 2% smaller than the newest published manifest (`PROVINCIAL_ACCEPT_SHRINK=1` to override) |

If any fires, run the matching task in §8. The watchdog is the backstop for a
publish that never ran; the shrink guard is the backstop for a truncated
provincial download becoming the archived source-of-record.

---

## 10. Script & file reference

| Path | Purpose | Output |
|---|---|---|
| `r/build_landcover.R` | bridge mao-assembly Parquet → land-cover shards | `web/public/data/landcover/**` |
| `r/build_landcover_tiles.R` | 2020 raster → WebP tile pyramid | `web/public/data/landcover-tiles/**` |
| `r/archive_snapshot.R` | archive provincial downloads (dated, append-only) + provenance sidecars | `…\MAOSnapshots\<year>\` + `<file>.meta.json` |
| `r/build_historical_shards.R` | archive → per-snapshot per-muni shards + provenance manifests | `mb-parcel-history\<snapshot_id>\**` |
| `r/build_lineage.R` | infer predecessor/successor across snapshots | `mb-parcel-history\lineage\**` |
| `r/download_provincial_snapshot.R` | fetch the 3 provincial layers from ArcGIS (count-verified pagination + shrink guard) into staging for the automated publish | staging `inputs/` |
| `semiannual-publish-wrapper.ps1` | end-to-end automated publish (download → archive → shards → lineage → push → repin app); task `mb-parcelsearch-semiannual-archive` | data repo + app repin |
| `history-staleness-check.ps1` / `schedule_history_check.ps1` | dead-man watchdog: alert if the newest built/pinned snapshot is overdue / register the daily `mb-parcelsearch-history-staleness` task | email + ntfy |
| `r/build_ortho_tiles.ps1` | tile a downloaded aerial ortho mosaic (ECW/GeoTIFF) → raster PMTiles for the optional "Aerial" basemap (§10.1) | `<name>.pmtiles` (→ R2) |
| `r/build_mli_ortho.ps1` | acquire and mosaic the complete MLI southern-Manitoba Ortho Refresh source set | `D:\MBOrtho\mb-mli-ortho-2007-2013.pmtiles` |
| `r/build_mli_imagery_years.R` | combine the MLI ortho grid + flight records into local acquisition-year polygons | `web/public/mli-imagery-years.geojson` |
| `web/scripts/build-places.js` | NRCan CGNDB bulk CSV → Manitoba populated places, each resolved to its containing municipality (point-in-polygon, build time) | `web/public/mb-places.json` |
| `web/src/lib/placeSearch.js` | map-corner place search: name folding, match ranking, the control itself | — |
| `web/src/lib/landcover.js` | shared bucket defs + display gate (`LAND_COVER_MIN_ACRES`) | — |
| `web/src/lib/provenance.js` | evidence-export provenance record + CSV/text renderers | — |
| `web/src/arcgis.js` | `fetchLandCover*`, `fetchHistorical*` / `fetchHistoricalLineage` (CDN) fetchers, `SERVICE_SOURCES` | — |
| `web/src/map.js` | land-cover + historical map layers, setters, tooltips (+ lineage) | — |
| `web/src/main.js` | toggles, handlers, banners, CSV export, snapshot export, wiring | — |
| `web/src/snapshotExport.js` | parcel satellite-snapshot ZIP (+ `PROVENANCE.txt`) | — |
| `web/vite.config.js` | bakes `__APP_COMMIT__` / `__APP_BUILD_TIME__` for export provenance | — |
| `MAINTENANCE.md` | operator quick-runbook (subset of §8) | — |
| `DATA-ARCHIVE-PLAN.md` | original design/decision record — **superseded 2026-07, design rationale only**. What shipped differs (semi-annual not annual; all three layers active). Never audit cadence from it: `MAINTENANCE.md` §2-4 is authoritative | — |

### 10.0.1 Place search (map top-left)

A search box in the map's only free corner answers "which RM is this town
in?" — the question that otherwise costs a pan-and-squint across the
municipal boundary layer. Type `Souris`, and the hit reads
**Souris · Town · SOURIS-GLENWOOD (MUNICIPALITY)** before you click it.

Picking a hit does three things, in order: sets the Property Search
municipality dropdown to that RM (so Search is one click away, no retyping),
flies to the place, and pins it with a popup repeating the three facts. The
muni-change handler's own fly-to-the-whole-RM is deliberately superseded a
macrotask later by the fly to the town — both start within a frame, so the
wider framing never visibly begins.

Backing data is `web/public/mb-places.json` (~1,969 places, 138 KB), built by
`scripts/build-places.js` from NRCan's Canadian Geographical Names Database.
It covers far more than the 183-row municipal boundary file: unincorporated
localities (Ninette, Kelwood, Elphinstone), local urban districts, northern
communities, railway points and reserves — reserves carrying the
"Indian Reserve" label so they never read as ordinary towns.

Three design points worth keeping:
- **The RM is precomputed.** Point-in-polygon runs in the build script, not
  the browser. No geometry work, no second lookup, no wait.
- **The file is bundled, not fetched from an API.** The production CSP pins
  `connect-src` to a fixed allowlist that includes neither NRCan nor any
  geocoder, and a static asset needs no key, can't be rate-limited, and works
  offline. (The existing Mapbox token is URL-restricted and scoped to the
  route planner; geocoding through it was considered and rejected.)
- **The pin is a DOM Marker, not a style layer.** Generate Map reads the WebGL
  canvas, so the pin guides the eye on screen without printing itself into an
  exported report image.

Name matching folds accents and punctuation both ways, so `ile des chenes`
finds *Île-des-Chênes* and `ste rose` finds *Ste. Rose du Lac*. Results rank
by match tier (exact → prefix → word-start → substring), then by place type,
so `Gimli` puts the town above Gimli Industrial Park.

**Trap — a map control that clips its own dropdown.** The control class is
`maplibregl-ctrl` and deliberately NOT `maplibregl-ctrl-group`. The group
class carries `overflow: hidden`, and the results list is absolutely
positioned *below* the container's own box, so with that class the entire
dropdown is clipped away: it stays in the DOM, `textContent` reads back
perfectly, every script-driven test passes, and nothing is ever painted.
This shipped once and reached production, because DOM presence had been
used as a stand-in for visibility. `.place-search { overflow: visible }`
now defends the same ground from the CSS side.

The lesson generalises to anything overlaying the map: **verify paint, not
presence.** `document.elementFromPoint()` over each row, asserting the hit
lands inside the list, is the check that catches this class of bug — the
map pane is `overflow: hidden` too, so a dropdown can also be cut off by
running past the pane's bottom edge. `_fitToMap()` caps the list per render
to the room actually left below the input, which is why the cap is computed
rather than a CSS constant: the workspace splitter resizes the map at
runtime.

### 10.1 Basemaps
`map.js` `BASEMAP_STYLE` stacks the basemaps; the top-right menu selects them:
- **Streets** — CARTO Positron (default; carries its own labels).
- **Satellite** — **Esri World Imagery** (`server.arcgisonline.com/.../World_Imagery`,
  keyless, ~30–60 cm, current, province-wide) + transparent Esri
  transportation/reference label overlays. This is the standing aerial layer.
- **NRCan elevation** — the federal Canada Basemap Elevation light hillshade.
  MapLibre requests Web Mercator tile bounding boxes through the same-origin
  `/proxy/nrcan-elevation` rewrite; the ArcGIS service reprojects its native
  EPSG:3978 output to EPSG:3857. Esri reference labels remain above it.
- **MLI aerial 2007-2013** — the complete historical southern-Manitoba MLI
  Ortho Refresh mosaic, built at Web Mercator zoom 16 as raster PMTiles. The catalogue
  calls it 2007-2014, while its flight metadata records acquisition years
  2007-2013. The menu trigger reports the local year at map centre from
  `mli-imagery-years.geojson`. This row remains absent until
  `VITE_MLI_ORTHO_PMTILES_URL` is configured after hosting.

Build and provenance details, including the per-year grid-cell summary and MLI
licence attribution, are in `docs/MLI-IMAGERY-BASEMAP.md`.

---

## 11. Gotchas / troubleshooting

- **Land-cover coverage collapsed to a few munis** → a partial/aborted
  mao-assembly Parquet; check the `build_landcover.R` "NOTE … PARTIAL"
  line. It auto-skips partials, so this means re-run a complete assembly.
- **A live parcel shows no land cover** → it's newer than the last assembly
  Parquet; rerun mao-assembly, then `build_landcover.R`.
- **New snapshot not showing, or stale/triangle geometry after a republish** →
  the app pins a `mb-parcel-history` **commit SHA** (not `@main`, which lags and
  serves stale per-file even after a purge). Bump `HISTORICAL_CDN` in
  `arcgis.js` to the new commit and redeploy (MAINTENANCE.md §3). The shard
  cache key auto-invalidates off the manifest build timestamp.
- **Local `npm run build` fails with `EPERM … dist\data`** → Dropbox is
  holding the build copy; harmless. Build with `--emptyOutDir false`, or
  just push (Vercel builds in a clean environment).
- **Preview sandbox** can't load the basemap or fetch the shard CDN
  (raw.githubusercontent — no external network) — verify those on the live
  deploy. (This is also why an in-app browser can't fully load the map to
  exercise the basemap toggle live.)
- **A scheduled `.ps1` fails to parse under Windows PowerShell 5.1** (the Task
  Scheduler runtime) → an em-dash or other non-ASCII char inside a
  **double-quoted** string in a BOM-less UTF-8 file mojibakes and terminates
  the string, failing the whole file before it runs — so no alert fires. Keep
  the wrapper `.ps1` files **ASCII-only**; verify with
  `[System.Management.Automation.Language.Parser]::ParseFile` under BOTH `pwsh`
  and `powershell.exe`.

---

## 12. Optional future work

- **Repo slim:** the main repo carries large regenerated data (legal-index
  129 MB, RollEntry snapshot 284 MB, tiles 84 MB). If `.git` growth bites,
  move those to **Git LFS** or external hosting + a one-time history purge
  (extract any wanted history first). The historical archive already avoids
  this (separate repo / Dropbox).
- **Historical zoning/dev-plan re-bin** for reorg snapshots (§5.5) — build +
  test when the first cross-reorganization snapshot is archived.
- **Newer open aerial imagery** — the MLI historical layer is complete, but a
  newer province-wide government orthophoto source has not been identified.
  Add a separately dated menu row if one becomes available; do not replace the
  historical MLI layer because its value is temporal comparison.
