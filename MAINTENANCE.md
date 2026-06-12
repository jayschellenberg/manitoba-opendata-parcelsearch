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
| **Cold archive** (provincial source + provenance sidecars: roll / zoning / dev-plan) | MB Open Data downloads | `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\` | semi-annual (scheduled Jan 1 / Jul 1) |
| **Historical shards** (as-of-date view, keyed `YYYY-MM-DD`) | the cold archive | `mb-parcel-history` repo → jsDelivr | when a new snapshot is archived |
| **Lineage index** (inferred predecessor/successor) | the historical shards | `mb-parcel-history/lineage/` → jsDelivr | when ≥ 2 snapshots exist |

## Recurring tasks

### 1. Shard rebuild — current data  (cadence: as-needed, after a scrape delta)
Rebuilds the legal/assessment/land-cover shards from the latest scrape.
```
monthly-refresh.bat
```
Then review `git status`, commit the changed `web/public/data/**`, and push
(Vercel auto-deploys). **Note:** the underlying MAO scrape is a multi-week,
deliberately throttled run refreshed roughly **semiannually** — not monthly
(`monthly-refresh.bat` is named for how often you *may* re-emit shards from a
scrape delta, not how often the scrape itself runs). The app's **staleness
banner** reflects the scrape age: hidden up to 180 days, amber past the
semiannual mark, red past the 12-month rule — that's your nudge.

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
**Then update the pinned commit** (REQUIRED): one command commits +
pushes the data repo and rewrites the SHA in `web/src/arcgis.js`:
```
powershell -ExecutionPolicy Bypass -File update-cdn-pin.ps1
```
Use `-DryRun` to preview, `-Message "..."` to override the commit
message. Review `git diff web/src/arcgis.js` and commit + push the app
(Vercel redeploys; clients pick up the new shards on next load). That
data repo's history exists only to mint immutable SHAs — squash it
whenever it gets heavy, then repoint the app first.
`section-grid.json` is published separately via `api/section-grid.js`
(GitHub Release + edge function — see §1c below). It does NOT live in
mb-parcel-data because at 41 MB it's over jsDelivr's per-file cap.

### 2. Snapshot archive + provenance — roll / zoning / dev-plan  (cadence: semi-annual, **scheduled**)
Permanent dated snapshots of all three provincial layers (roll info, zoning,
development plan). **Scheduled** twice a year (January 1 / July 1, 04:30) via
`schedule_semiannual.ps1` → `semiannual-archive-wrapper.ps1`. To run by hand:
```
Rscript r/archive_snapshot.R          # all three (roll + zoning + dev-plan)
```
All three sources are `active` now, so a plain run captures everything (`--all`
remains a synonym). Append-only → `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\`,
and writes a `<file>.meta.json` **provenance sidecar** (sha256, source date,
retrieved_at, **source_crs**, source_url, license) beside each archived file.
Never deletes prior captures. Lives in Dropbox, outside git/deploy.

The catch automation can't close: the scheduled run only archives whatever
currently sits in `mao-assembly/inputs/`, and the upstream **MB Open Data
download is manual** (no stable API). So the wrapper scans the run and sends a
**push/email reminder** when a source is missing or > 12 months stale — that's
your cue to pull fresh `MBRollGeoPackage.gpkg` / `Manitoba_Zoning_By_Laws.geojson`
/ `Manitoba_Development_Plan_Designations.geojson` into `inputs/` and let the
next scheduled run (or a manual run) capture them. Register the schedule once:
```
powershell -ExecutionPolicy Bypass -File schedule_semiannual.ps1
```

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

### Register the two scheduled tasks
Both schedules are idempotent — run each once (re-run after editing a
wrapper/.bat to repoint the task):
```
powershell -ExecutionPolicy Bypass -File schedule_monthly.ps1      # MAOMonthlyRefresh   — 15th monthly 04:00 (live shards)
powershell -ExecutionPolicy Bypass -File schedule_semiannual.ps1   # MAOSemiannualArchive — Jan 1 / Jul 1 04:30 (permanent snapshots)
```
Verify either: `Get-ScheduledTask -TaskName MAOMonthlyRefresh,MAOSemiannualArchive | Format-List *`.

### Failure / staleness alerts (email + push)
Both scheduled tasks run through a wrapper that shares one alert path
(`alert-lib.ps1`): `monthly-refresh-wrapper.ps1` alerts on any failed refresh
step; `semiannual-archive-wrapper.ps1` alerts on a hard failure **and** when
the provincial source is missing or > 12 months stale (your nudge to pull a
fresh MB Open Data download). Push notifications work out of the box if you
subscribe to both ntfy.sh topics in the ntfy app — `mbps-monthly-refresh-jks`
and `mbps-semiannual-archive-jks`. **Email needs one 5-minute step**: create an
app password (M365: Security info → App passwords; Gmail:
myaccount.google.com/apppasswords) and paste it into `smtp_pass=` in
`alert-email.local.txt` (gitignored — one file serves both wrappers). Then
verify each end-to-end:
```
powershell -ExecutionPolicy Bypass -File monthly-refresh-wrapper.ps1 -TestAlert
powershell -ExecutionPolicy Bypass -File semiannual-archive-wrapper.ps1 -TestAlert
```
If a Task Scheduler entry predates its wrapper, re-run the matching
`schedule_*.ps1` once so the task targets the wrapper.

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

- **Current data:** the in-app staleness banner (hidden ≤ 180 d, amber
  181-365 d, red > 365 d — the MAO scrape is semiannual, not monthly) is the
  live signal. If it's red, run a fresh scrape + shard rebuild.
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
inputs). This is the one step that stays manual (no stable API). The
semiannual task (#2) archives whatever is in `mao-assembly/inputs/` and
**reminds you by push/email** when those inputs are missing or stale — so the
routine is: when that reminder lands (≈ twice a year), download fresh copies
into `mao-assembly/inputs/`, then let the next scheduled run capture them (or
run task #2 by hand) and run tasks #3/#4 (and rerun mao-assembly for land
cover).
