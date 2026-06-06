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
> are **simplified (~10 m) for visualization only** — resolve any
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
   web/public/data/**         mb-parcel-history repo ──► jsDelivr CDN
   (Vercel deploy)            (separate, data-only)      (free)
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
  jsDelivr. Kept separate so ~300 MB/year of history never bloats the main
  repo or the Vercel deploy.

---

## 2. Data classes (and how each is handled)

| Class | Examples | Where served | Cadence |
|---|---|---|---|
| **Live** | parcels, zoning, dev-plan | ArcGIS (live) | always current |
| **Latest-only generated** | legal-index (129 MB), assessment-index (28 MB), land-cover shards, land-cover tiles, RollEntry snapshot fallback | `web/public/data/**` (in deploy) | monthly / on rebuild |
| **Cold archive + provenance** | dated provincial source downloads + `<file>.meta.json` sidecars (sha256, source date, retrieved_at, source_crs, source_url, license) | `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\` (Dropbox, outside git) | semi-annual / annual |
| **Historical shards** | per-muni parcels/zoning/dev-plan **per snapshot date** (`YYYY-MM-DD`) + per-snapshot provenance manifest | `mb-parcel-history` → jsDelivr | when a snapshot is archived |
| **Lineage index** | inferred predecessor/successor per parcel, per muni | `mb-parcel-history/lineage/**` → jsDelivr | when ≥ 2 snapshots exist |

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
  dev-plan), simplified ~10 m, EPSG:4326, **keyed by muni number**. Zoning /
  dev-plan are paired to the parcel snapshot by picking the archived layer
  **on-or-before** the parcel date.
- Writes a per-snapshot **`manifest.json` (schema 2)** carrying each layer's
  source date **and full provenance** (`source_file`, `sha256`,
  `retrieved_at`, `source_url`, `source_crs`, `license`, lifted from the §4.3
  sidecars), the generator `commit`, the `simplify_tolerance_deg`, a
  geometry-accuracy note, and a verify **disclaimer**.
- Writes a root **`index.json` (schema 2)** whose `snapshots` map lists each
  `snapshot_id` with its per-layer source dates + muni count (discovery —
  **adding a snapshot needs no app code change**).
- **Loud field validation:** missing critical **parcel** fields (roll / muni)
  **hard-fail** the snapshot; missing zoning/dev-plan fields warn (§5.8).
- Output → `mb-parcel-history` repo (`OUTPUT_ROOT`).
- Prints a **STALE warning** if the newest snapshot is > 12 months old.
- Usage: `Rscript r/build_historical_shards.R [--year <yyyy>] [--muni <code>] [--index-only]`
  (`--year` filters snapshots by calendar year; `--muni` is the fast-test
  path; `--index-only` just rewrites the discovery index).

### 5.2 The data repo + CDN
`mb-parcel-history` layout (served read-only via jsDelivr, **free**):
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
URL base: `https://cdn.jsdelivr.net/gh/jayschellenberg/mb-parcel-history@main`.
Past snapshots are immutable → always fresh; only `index.json` / a new
snapshot lags ≤ ~12 h (pin to a commit or purge for instant). For citation,
prefer an **immutable `@<commit>` / `@<tag>` ref** over `@main`.

### 5.3 Frontend
- **arcgis.js**: `fetchHistoricalIndex` / `fetchHistoricalManifest` /
  `fetchHistoricalShard` / `fetchHistoricalLineage` (cache keys bumped to
  `v2`; 1 day for index/manifest, 30 days for the immutable shards/lineage).
  The fetchers' `year` parameter now carries a **snapshot_id** value.
- **map.js**: `historical-parcels` / `-zoning` / `-devplan` sources;
  parcels render as **dashed amber** lines over today's lots, zoning/dev-plan
  as translucent clickable fills. `setHistoricalData` / `setHistoricalVisible`
  + per-layer click tooltips. Parcel tooltips show **lineage** (`← from` /
  `→ became`, with confidence) and a "verify" note; zoning/dev-plan tooltips
  carry a "pointer only — verify" line.
- **main.js**: the **Historical** toggle + **"As of"** snapshot-date picker
  (under Parcel layers, dates grouped by year via `<optgroup>`),
  muni→muni_no resolution from the snapshot manifest, the
  `HISTORICAL as of <date> · Roll <date> · Zoning <date> · Dev Plan <date> ·
  verify vs by-law / title` banner, and a `> 12 mo old` flag.
- **Self-contained:** reads only shard fields — no coupling to the live
  enrichment pipeline (legal/assessment/MASC/land-cover).

### 5.4 Sync — how the two projects stay aligned
- **Generator in the main repo** = one source of truth for the format.
- **Auto-discovery:** the app reads `index.json`, so **adding a snapshot
  needs no app code change**.
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
continues (those overlays degrade gracefully).

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
- Historical shards: **jsDelivr CDN** off a public GitHub repo — **$0**,
  isolates ~300 MB/snapshot from the main repo + deploy.
- Cold archive: **Dropbox** (already in use), outside git/deploy.

---

## 8. Maintenance / recurring tasks

| # | Task | Cadence | Command |
|---|---|---|---|
| 1 | Monthly refresh (legal/assessment/land-cover shards) | monthly | `monthly-refresh.bat` → review `git status`, commit, push |
| 2 | Snapshot archive + provenance sidecars | semi-annual / annual (after a fresh provincial download) | `Rscript r/archive_snapshot.R` (or `--all`) |
| 3 | Publish a historical snapshot | when #2 adds a snapshot | `Rscript r/build_historical_shards.R --year <yyyy>` → commit/push `<snapshot_id>/` + `index.json` in `mb-parcel-history` |
| 4 | Rebuild parcel lineage | after #3 (≥ 2 snapshots exist) | `Rscript r/build_lineage.R` → commit/push `lineage/` in `mb-parcel-history` |
| 5 | Land-cover shards | when mao-assembly reruns | runs inside `monthly-refresh.bat` (non-fatal) |
| 6 | Land-cover Detailed tiles | rare — new raster only | `Rscript r/build_landcover_tiles.R` (needs GDAL) |
| 7 | Provincial downloads | ≥ annual | download fresh MB Open Data into `mao-assembly/inputs/`, then #2/#3/#4 + rerun mao-assembly |

After republishing to `mb-parcel-history`, **purge jsDelivr** for the changed
`index.json` / `lineage/_index.json` (`https://purge.jsdelivr.net/gh/...`) so
the app sees the new snapshot without the ≤ ~12 h `@main` cache lag.

---

## 9. Freshness / staleness (the 12-month rule)

| Signal | Where | Threshold |
|---|---|---|
| Current data banner | app (top of search) | amber 30 d / red 60 d |
| Historical archive | app historical banner | `> 12 mo old` tag |
| Provincial source | `archive_snapshot.R` console | `!! STALE` > 12 mo |
| Newest snapshot | `build_historical_shards.R` console | `!! STALE` > 12 mo |

If any fires, run the matching task in §8.

---

## 10. Script & file reference

| Path | Purpose | Output |
|---|---|---|
| `r/build_landcover.R` | bridge mao-assembly Parquet → land-cover shards | `web/public/data/landcover/**` |
| `r/build_landcover_tiles.R` | 2020 raster → WebP tile pyramid | `web/public/data/landcover-tiles/**` |
| `r/archive_snapshot.R` | archive provincial downloads (dated, append-only) + provenance sidecars | `…\MAOSnapshots\<year>\` + `<file>.meta.json` |
| `r/build_historical_shards.R` | archive → per-snapshot per-muni shards + provenance manifests | `mb-parcel-history\<snapshot_id>\**` |
| `r/build_lineage.R` | infer predecessor/successor across snapshots | `mb-parcel-history\lineage\**` |
| `web/src/lib/landcover.js` | shared bucket defs + display gate (`LAND_COVER_MIN_ACRES`) | — |
| `web/src/lib/provenance.js` | evidence-export provenance record + CSV/text renderers | — |
| `web/src/arcgis.js` | `fetchLandCover*`, `fetchHistorical*` / `fetchHistoricalLineage` (CDN) fetchers, `SERVICE_SOURCES` | — |
| `web/src/map.js` | land-cover + historical map layers, setters, tooltips (+ lineage) | — |
| `web/src/main.js` | toggles, handlers, banners, CSV export, snapshot export, wiring | — |
| `web/src/snapshotExport.js` | parcel satellite-snapshot ZIP (+ `PROVENANCE.txt`) | — |
| `web/vite.config.js` | bakes `__APP_COMMIT__` / `__APP_BUILD_TIME__` for export provenance | — |
| `MAINTENANCE.md` | operator quick-runbook (subset of §8) | — |
| `DATA-ARCHIVE-PLAN.md` | original design/decision record (now realized) | — |

---

## 11. Gotchas / troubleshooting

- **Land-cover coverage collapsed to a few munis** → a partial/aborted
  mao-assembly Parquet; check the `build_landcover.R` "NOTE … PARTIAL"
  line. It auto-skips partials, so this means re-run a complete assembly.
- **A live parcel shows no land cover** → it's newer than the last assembly
  Parquet; rerun mao-assembly, then `build_landcover.R`.
- **New snapshot not showing in-app** → jsDelivr `@main` cache lag
  (≤ ~12 h); pin to a commit or purge `index.json` to force. Also bump the
  app's browser cache keys if the `index.json`/manifest schema changed.
- **Local `npm run build` fails with `EPERM … dist\data`** → Dropbox is
  holding the build copy; harmless. Build with `--emptyOutDir false`, or
  just push (Vercel builds in a clean environment).
- **Preview sandbox** can't load the basemap or fetch jsDelivr (no external
  network) — verify those on the live deploy.

---

## 12. Optional future work

- **Repo slim:** the main repo carries large regenerated data (legal-index
  129 MB, RollEntry snapshot 284 MB, tiles 84 MB). If `.git` growth bites,
  move those to **Git LFS** or external hosting + a one-time history purge
  (extract any wanted history first). The historical archive already avoids
  this (separate repo / Dropbox).
- **Historical zoning/dev-plan re-bin** for reorg snapshots (§5.5) — build +
  test when the first cross-reorganization snapshot is archived.
