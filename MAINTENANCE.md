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

### 2. Snapshot archive + publish — roll / zoning / dev-plan  (cadence: semi-annual, **scheduled end-to-end**)
Permanent dated snapshots of all three provincial layers (roll info, zoning,
development plan), published through to the app. **Scheduled** twice a year
(January 1 / July 1, 04:30) via `schedule_semiannual.ps1` →
**`semiannual-publish-wrapper.ps1`**, which does the whole flow unattended:

1. **Download** the three layers fresh from the ArcGIS FeatureServer into a
   throwaway staging dir (`r/download_provincial_snapshot.R`) — no manual MB
   geoPortal download needed. The download is **count-verified** (server row
   count first, hard error on any mismatch) and **shrink-guarded** (a layer
   >2% smaller than the newest published snapshot aborts;
   `PROVINCIAL_ACCEPT_SHRINK=1` to override), so a truncated layer can never
   become the archived source-of-record.
2. **Archive** as a dated capture + `<file>.meta.json` **provenance sidecar**
   (sha256, source date, retrieved_at, **source_crs**, source_url, license).
   Append-only → `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\`; never
   deletes prior captures. Lives in Dropbox, outside git/deploy.
3. **Shards + lineage + publish**: builds the per-muni historical shards with
   `--require zoning,devplan` (a snapshot missing either layer hard-fails
   instead of publishing parcels-only), asserts the new snapshot dir exists,
   rebuilds lineage, pushes `mb-parcel-history`, repins `HISTORICAL_CDN` in
   the app, pushes → Vercel redeploys.

Any failed step sends a push/email alert and stops. Register the schedule once:
```
powershell -ExecutionPolicy Bypass -File schedule_semiannual.ps1
```
**Dead-man's switch**: the wrapper only alerts when it *runs*, so the daily
**`mb-parcelsearch-history-staleness`** task (`history-staleness-check.ps1`, registered
via `schedule_history_check.ps1`) alerts when the newest built or app-pinned
snapshot goes > 215 days old (~1 month past cadence) — catching "the task
never fired at all" (schedule rot, machine reimaged, wrapper moved).

Archive-only by hand (no download/publish — captures whatever sits in
`mao-assembly/inputs/`): `Rscript r/archive_snapshot.R` (all three sources are
`active`; `--all` remains a synonym), or `semiannual-archive-wrapper.ps1` for
the alert-wrapped version.

### 3. Publish a historical snapshot manually — as-of-date view  (normally automated by #2)
The scheduled publish wrapper does all of this; use these steps only for a
manual/backfill publish. Turn a dated snapshot into per-muni shards keyed by
**snapshot date** (e.g. `2026-06-05/`):
```
Rscript r/build_historical_shards.R --year <yyyy> --require zoning,devplan
cd ..\mb-parcel-history
git add <snapshot_id> index.json && git commit -m "Add <snapshot_id>" && git push
```
(`--require` hard-fails if zoning/dev-plan is missing for a snapshot — drop it
only when deliberately processing an old archive that predates a layer.)
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

### 7. MLI historical aerial basemap  (cadence: on-demand)
The complete MLI Ortho Refresh source is built locally and deliberately not
uploaded. Full provenance and year-coverage notes are in
`docs/MLI-IMAGERY-BASEMAP.md`. Rebuild from the repo root with:
```
.\r\build_mli_ortho.ps1
Rscript r\build_mli_imagery_years.R
```
After a future upload, set `VITE_MLI_ORTHO_PMTILES_URL` locally and in Vercel.
Add a new archive host to `vercel.json` `connect-src` if it is not already
allowed. Review the current MLI terms before publishing.

## Continuous integration

GitHub Actions is enabled for the account (the earlier account-level
block was lifted 2026-06-21), so `ci.yml` now runs the web test suite +
build on every push/PR. Two complementary gates remain as
defence-in-depth:

- **Remote gate (automatic):** `vercel.json`'s build command runs
  `npm test` before `npm run build`, so a failing test fails the Vercel
  deploy — nothing broken reaches production.
- **Local gate (opt-in, once per clone):** enable the pre-push hook with
  `git config core.hooksPath .githooks`. It runs the suite before every
  push (`git push --no-verify` to bypass in an emergency).

## One-time setup & security settings

### Register the scheduled tasks
All schedules are idempotent — run each once (re-run after editing a
wrapper/.bat to repoint the task):
```
powershell -ExecutionPolicy Bypass -File schedule_monthly.ps1        # mb-parcelsearch-monthly-refresh        — 15th monthly 04:00 (live shards)
powershell -ExecutionPolicy Bypass -File schedule_semiannual.ps1     # mb-parcelsearch-semiannual-archive     — Jan 1 / Jul 1 04:30 (snapshot publish)
powershell -ExecutionPolicy Bypass -File schedule_history_check.ps1  # mb-parcelsearch-history-staleness — daily 09:10 (snapshot dead-man watchdog)
```
Verify: `Get-ScheduledTask -TaskName mb-parcelsearch-monthly-refresh,mb-parcelsearch-semiannual-archive,mb-parcelsearch-history-staleness | Format-List *`.

### Failure / staleness alerts (email + push)
The scheduled tasks run through wrappers that share one alert path
(`alert-lib.ps1`): `monthly-refresh-wrapper.ps1` alerts on any failed refresh
step; `semiannual-publish-wrapper.ps1` alerts on any failed publish step
(download / archive / shards / lineage / push / repin); and
`history-staleness-check.ps1` is the dead-man's switch that alerts when the
newest snapshot is overdue even if the publish task never started. Push
notifications work out of the box if you subscribe to both ntfy.sh topics in
the ntfy app — `mbps-monthly-refresh-jks` and `mbps-semiannual-archive-jks`
(the publish wrapper and the watchdog share the latter). **Email needs one
5-minute step**: create an app password (M365: Security info → App passwords;
Gmail: myaccount.google.com/apppasswords) and paste it into `smtp_pass=` in
`alert-email.local.txt` (gitignored — one file serves all wrappers). Then
verify each end-to-end:
```
powershell -ExecutionPolicy Bypass -File monthly-refresh-wrapper.ps1 -TestAlert
powershell -ExecutionPolicy Bypass -File semiannual-publish-wrapper.ps1 -TestAlert
powershell -ExecutionPolicy Bypass -File history-staleness-check.ps1 -TestAlert
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
