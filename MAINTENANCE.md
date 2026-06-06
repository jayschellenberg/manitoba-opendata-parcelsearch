# MAINTENANCE — manual & recurring steps

What has to be done by hand to keep the Manitoba parcel search webapp and
its historical archive current. Most of the app runs off live ArcGIS, but
several datasets are generated/refreshed manually. **Freshness rule of
thumb: nothing should go more than ~12 months stale.**

## Where the data lives (quick map)

| Dataset | Source of truth | Served from | Cadence |
|---|---|---|---|
| Live parcels / zoning / dev-plan | ArcGIS (live) | ArcGIS, live | always current |
| Legal + assessment index | mao-scrape `parcels.parquet` | `web/public/data/` (in deploy) | monthly |
| RollEntry snapshot (fallback) | `download_parcels.R` | `web/public/data/rollentry-snapshot/` | monthly-ish |
| Land-cover shards | mao-assembly Parquet | `web/public/data/landcover/` | when assembly reruns |
| Land-cover **tiles** (Detailed) | `LCR_RCT_2020_MB.tif` (static) | `web/public/data/landcover-tiles/` | only on a new raster (years) |
| **Annual archive** (provincial source) | MB Open Data downloads | `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\` | annual |
| **Historical shards** (as-of-year view) | the annual archive | `mb-parcel-history` repo → jsDelivr | when a new year is archived |

## Recurring tasks

### 1. Monthly refresh — current data  (cadence: monthly)
Rebuilds the legal/assessment/land-cover shards from the latest scrape.
```
monthly-refresh.bat
```
Then review `git status`, commit the changed `web/public/data/**`, and push
(Vercel auto-deploys). The app's **staleness banner** turns amber at 30 days
and red at 60 — that's your nudge.

### 2. Annual snapshot archive — historical geometry  (cadence: annual)
After downloading a fresh provincial **MBRollGeoPackage** (and zoning /
dev-plan) into `mao-assembly/inputs/`, archive a dated, retained copy:
```
Rscript r/archive_snapshot.R          # geometry only (parcels)
Rscript r/archive_snapshot.R --all    # also zoning + dev-plan
```
Append-only → `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\`. Never deletes
prior years. Lives in Dropbox, outside git/deploy.

### 3. Publish a new historical year — as-of-year view  (cadence: when #2 adds a year)
Turn the new archive year into per-muni shards and publish to the CDN:
```
Rscript r/build_historical_shards.R --year <year>
cd ..\mb-parcel-history
git add <year> index.json && git commit -m "Add <year>" && git push
```
The app auto-discovers the new year from `index.json` (no app code change).
jsDelivr serves it within ~12 h (old years are immutable, always fresh).

### 4. Land-cover shards  (cadence: when mao-assembly reruns)
`build_landcover.R` runs as a non-fatal step inside `monthly-refresh.bat`;
it re-shards from whatever complete mao-assembly Parquet is current.

### 5. Land-cover Detailed tiles  (cadence: rare — only a new raster)
Only when a new provincial `LCR_RCT_*.tif` lands (years apart):
```
Rscript r/build_landcover_tiles.R     # needs GDAL on PATH; ~15-45 min
```
Commit the regenerated `web/public/data/landcover-tiles/`.

## Freshness / staleness policy (the 12-month rule)

- **Current data:** the in-app staleness banner (amber 30 d / red 60 d) is
  the live signal. If it's red, run the monthly refresh.
- **Annual archive:** `archive_snapshot.R` prints a **WARNING** when the
  provincial source it's archiving is already > 12 months old — i.e. you
  haven't pulled fresh MB Open Data in over a year.
- **Historical archive:** `build_historical_shards.R` prints a **WARNING**
  (and the in-app historical view flags it) when the newest archived year
  is > 12 months old.

If you see any of these, the fix is the matching task above.

## Provincial downloads (the upstream manual step)

The annual archive and mao-assembly both start from MB Open Data downloads:
`MBRollGeoPackage.gpkg`, `Manitoba_Zoning_By_Laws.geojson`,
`Manitoba_Development_Plan_Designations.geojson` (and the assembly's other
inputs). Download fresh copies into `mao-assembly/inputs/` at least once a
year, then run tasks #2/#3 (and rerun mao-assembly for land cover).
