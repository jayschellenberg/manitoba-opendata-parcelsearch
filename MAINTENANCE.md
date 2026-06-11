# MAINTENANCE — manual & recurring steps

What has to be done by hand to keep the Manitoba parcel search webapp and
its historical archive current. Most of the app runs off live ArcGIS, but
several datasets are generated/refreshed manually. **Freshness rule of
thumb: nothing should go more than ~12 months stale.**

## Where the data lives (quick map)

| Dataset | Source of truth | Served from | Cadence |
|---|---|---|---|
| Live parcels / zoning / dev-plan | ArcGIS (live) | ArcGIS, live | always current |
| Legal index, assessment index | mao-scrape `parcels.parquet` | GitHub Release → `api/legal-index.js` / `api/assessment-index.js` edge fns | monthly |
| Section grid | MB_LegalDesc service | GitHub Release → `api/section-grid.js` edge fn | annual (geometry doesn't change) |
| RollEntry snapshot (fallback), parcel-masc, assessment shards, masc shards, landcover shards, landcover tiles, river-lots, masc-riverlots | various R build scripts | `mb-parcel-data` repo → jsDelivr (pinned commit) | monthly-ish |
| **Cold archive** (provincial source + provenance sidecars) | MB Open Data downloads | `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\` | semi-annual / annual |
| **Historical shards** (as-of-date view, keyed `YYYY-MM-DD`) | the cold archive | `mb-parcel-history` repo → jsDelivr | when a new snapshot is archived |
| **Lineage index** (inferred predecessor/successor) | the historical shards | `mb-parcel-history/lineage/` → jsDelivr | when ≥ 2 snapshots exist |

## Recurring tasks

### 1. Monthly refresh — current data  (cadence: monthly)
Rebuilds the legal/assessment/land-cover shards from the latest scrape.
```
monthly-refresh.bat
```
Then review `git status`, commit the changed `web/public/data/**`, and push
(Vercel auto-deploys). The app's **staleness banner** turns amber at 30 days
and red at 60 — that's your nudge.

The two big indexes (`legal-index.json` / `assessment-index.json`) ship via
GitHub **Releases**, not git. Publish them in one command — rebuild → release
→ bump the edge-function URLs (`-SkipBuild` right after a refresh already
rebuilt them; `-DryRun` to preview):
```
powershell -ExecutionPolicy Bypass -File release-indexes.ps1 -SkipBuild
```
Then commit + push the `api/` URL bumps it makes.

### 1c. Section grid (cadence: annual or after a build_section_grid.R change)
The 41 MB province-wide grid ships through `api/section-grid.js` (same Release
+ edge-fn pattern as the indexes above — over jsDelivr's per-file cap, so it
can't ride the mb-parcel-data CDN). To roll a new build:
```
Rscript r/build_section_grid.R
gh release create data-section-grid-YYYY-MM-DD web/public/data/section-grid.json --title "Section grid YYYY-MM-DD"
```
Then bump `RELEASE_URL` in `api/section-grid.js`, commit + push. Geometry
doesn't change, so this is a rare operation.

### 1b. mb-parcel-data CDN refresh  (cadence: whenever any CDN-hosted dataset rebuilds)
Most of the app's generated data — RollEntry fallback shards,
parcel-masc, assessment shards, MASC shards, landcover shards, landcover
tiles, river-lots, masc-riverlots — lives in the **`mb-parcel-data`**
repo and reaches the app via jsDelivr pinned to an immutable commit
(never `@main` — branch HEADs lag and serve inconsistent files). The R
build scripts already write straight into the local `mb-parcel-data`
clone (`mb_parcel_data_root` in `r/config.R`). After any rebuild:
```
cd ..\mb-parcel-data
git add -A && git commit -m "<what changed>" && git push
```
**Then update the pinned commit** (REQUIRED): copy the new SHA into
`MB_PARCEL_DATA_CDN` in `web/src/arcgis.js`, commit + push the app
(Vercel redeploys). That repo's history exists only to mint immutable
SHAs — squash it whenever it gets heavy, then repoint the app first.
`section-grid.json` does NOT live here (41 MB single file → over
jsDelivr's per-file cap); it stays in `web/public/data/`.

### 2. Snapshot archive + provenance — historical geometry  (cadence: semi-annual / annual)
After downloading a fresh provincial **MBRollGeoPackage** (and zoning /
dev-plan) into `mao-assembly/inputs/`, archive a dated, retained copy:
```
Rscript r/archive_snapshot.R          # geometry only (parcels)
Rscript r/archive_snapshot.R --all    # also zoning + dev-plan
```
Append-only → `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\`, and writes a
`<file>.meta.json` **provenance sidecar** (sha256, source date, retrieved_at,
**source_crs**, source_url, license) beside each archived file. Never deletes
prior captures. Lives in Dropbox, outside git/deploy.

### 3. Publish a new historical snapshot — as-of-date view  (cadence: when #2 adds a snapshot)
Turn the new dated snapshot into per-muni shards and publish to the CDN
(output is keyed by **snapshot date**, e.g. `2026-06-05/`):
```
Rscript r/build_historical_shards.R --year <yyyy>
cd ..\mb-parcel-history
git add <snapshot_id> index.json && git commit -m "Add <snapshot_id>" && git push
```
**Then update the pinned commit in the app** (REQUIRED): the app fetches
history from a pinned `mb-parcel-history` commit, not `@main` — jsDelivr's view
of a branch HEAD lags and is inconsistent per-file, so `@main` served stale
geometry even after purging. Copy the new commit SHA and set `HISTORICAL_CDN`
in `web/src/arcgis.js` to `…/mb-parcel-history@<new-sha>`, then commit + push
the app (Vercel redeploys). The pinned SHA is immutable on jsDelivr → served
immediately, no lag, no purge. (The shard cache key auto-invalidates off the
manifest's build timestamp, so clients pick it up on next load.)

### 4. Rebuild parcel lineage  (cadence: after #3, once ≥ 2 snapshots exist)
Infer predecessor/successor (subdivision / consolidation / …) across
snapshots and publish:
```
Rscript r/build_lineage.R
cd ..\mb-parcel-history
git add lineage && git commit -m "Rebuild lineage" && git push
```
Each record is **inferred from public geometry** and carries a verify
disclaimer — confirm against registered plans / titles before relying on it.

### 5. Land-cover shards  (cadence: when mao-assembly reruns)
`build_landcover.R` runs as a non-fatal step inside `monthly-refresh.bat`;
it re-shards from whatever complete mao-assembly Parquet is current.

### 6. Land-cover Detailed tiles  (cadence: rare — only a new raster)
Only when a new provincial `LCR_RCT_*.tif` lands (years apart):
```
Rscript r/build_landcover_tiles.R     # needs GDAL on PATH; ~15-45 min
```
Commit the regenerated `web/public/data/landcover-tiles/`.

## One-time setup & security settings

### Refresh-failure alerts (email + push)
The scheduled refresh runs through `monthly-refresh-wrapper.ps1`, which
alerts on any failed step. Push notifications (ntfy.sh topic
`mbps-monthly-refresh-jks`) work out of the box if you subscribe in the
ntfy app; **email needs one 5-minute step**: create an app password
(M365: Security info → App passwords; Gmail: myaccount.google.com/apppasswords)
and paste it into `smtp_pass=` in `alert-email.local.txt` (gitignored).
Then verify end-to-end:
```
powershell -ExecutionPolicy Bypass -File monthly-refresh-wrapper.ps1 -TestAlert
```
If the Task Scheduler entry predates the wrapper, re-run
`schedule_monthly.ps1` once so the task targets the wrapper instead of
the .bat.

### Mapbox token (route planner)
The `pk.` token in `web/.env.local` / Vercel env vars is publishable by
design — anyone can read it out of the deployed bundle. What protects
the monthly free tier is a **URL restriction**: at
<https://account.mapbox.com/access-tokens/> edit the token and allow
only the production domain and `http://localhost:5173`. To rotate:
create a new token with the same scopes + restrictions, update
`web/.env.local` and Vercel → Settings → Environment Variables, redeploy,
then delete the old token.

## Freshness / staleness policy (the 12-month rule)

- **Current data:** the in-app staleness banner (amber 30 d / red 60 d) is
  the live signal. If it's red, run the monthly refresh.
- **Cold archive:** `archive_snapshot.R` prints a **WARNING** when the
  provincial source it's archiving is already > 12 months old — i.e. you
  haven't pulled fresh MB Open Data in over a year.
- **Historical archive:** `build_historical_shards.R` prints a **WARNING**
  (and the in-app historical view flags it) when the newest archived
  snapshot is > 12 months old.

If you see any of these, the fix is the matching task above.

## Provincial downloads (the upstream manual step)

The cold archive and mao-assembly both start from MB Open Data downloads:
`MBRollGeoPackage.gpkg`, `Manitoba_Zoning_By_Laws.geojson`,
`Manitoba_Development_Plan_Designations.geojson` (and the assembly's other
inputs). Download fresh copies into `mao-assembly/inputs/` at least once a
year, then run tasks #2/#3/#4 (and rerun mao-assembly for land cover).
