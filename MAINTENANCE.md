# MAINTENANCE — manual & recurring steps

What has to be done by hand to keep the Manitoba parcel search webapp and
its historical archive current. Most of the app runs off live ArcGIS, but
several datasets are generated/refreshed manually. **Freshness rule of
thumb: nothing should go more than ~12 months stale.**

## Where the data lives (quick map)

| Dataset | Source of truth | Served from | Cadence |
|---|---|---|---|
| Live parcels / zoning / dev-plan | ArcGIS (live) | ArcGIS, live | always current *to the provincial extract* — see below |
| Legal index, assessment index | mao-scrape `parcels.parquet` | GitHub Release → `api/legal-index.js` / `api/assessment-index.js` edge fns | monthly |
| Section grid | MB_LegalDesc service | GitHub Release → `api/section-grid.js` edge fn | annual (geometry doesn't change) |
| RollEntry snapshot (fallback), parcel-masc, assessment shards, masc shards, landcover shards, landcover tiles, river-lots, masc-riverlots | various R build scripts | `mb-parcel-data` repo → jsDelivr (pinned commit) | monthly-ish |
| **Cold archive** (provincial source + provenance sidecars: roll / zoning / dev-plan) | MB Open Data downloads | `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\` | semi-annual (scheduled Jan 1 / Jul 1) |
| **Historical shards** (as-of-date view, keyed `YYYY-MM-DD`) | the cold archive | `mb-parcel-history` repo → jsDelivr | when a new snapshot is archived |
| **Lineage index** (inferred predecessor/successor) | the historical shards | `mb-parcel-history/lineage/` → jsDelivr | when ≥ 2 snapshots exist |

### The live layers are not as live as "live" suggests

The provincial ROLL_ENTRY FeatureServer is queried at search time, so the app is
always current *with the extract the province has published*. That extract trails
Manitoba Assessment Online by an unknown margin, and **nothing in this repo can
close that gap.**

Worked example (2026-08-05): RM of Ste Anne roll 126910 had been subdivided and
MAO's assessment map showed the ±2.3 ac child parcel. ROLL_ENTRY returned
`17.22 ACRES` — the parent figure — against a 16.97 ac polygon, i.e. the
attribute and the geometry were *both* pre-subdivision and agreed with each
other to 1.5%. The layer's own `dataLastEditDate` was the previous day. So:

- a recent publish date is **not** evidence that a given roll is current;
- the app's roll-vs-shape cross-check (see below) **cannot** catch this class of
  staleness, because there is no internal disagreement to detect;
- the nightly mao-scrape delta also can't catch it, because that delta triggers
  on ROLL_ENTRY attribute changes and ROLL_ENTRY never changed. The roll waits
  for its municipality's 6- or 12-month cadence re-scrape.

The mitigation is disclosure, not detection: the "Data refreshed" footer shows
the provincial publish date with that caveat in its tooltip, and the export
disclaimer says it in words. Recently-changed parcels have to be confirmed on
MAO. Don't let a future refactor quietly re-label the publish date as a
freshness date.

### Live layers can also be superseded outright

Several provincial services carry their vintage in the SERVICE NAME, so they
never roll forward. When the province publishes the next one the app keeps
querying the old URL forever, returning well-formed, current-looking, years-old
numbers. The app sat on `MHTIS_Traffic_Flow_2019` until 2026-08-05 while a 2023
layer had been published beside it.

`upstream-vintage-check.ps1` (weekly, task `mb-parcelsearch-upstream-vintage`)
now watches for this. It reads the service URLs **out of `web/src/*.js`** rather
than keeping its own copy — a hardcoded list would rot exactly the way the
traffic URL did — and reports, per service: reachable, last upstream edit, and
whether a later year-stamped sibling exists. See the table any time with:
```
powershell -ExecutionPolicy Bypass -File upstream-vintage-check.ps1 -Report
```
**Repointing is never just a URL change.** The 2023 traffic layer kept a stale
carried-forward `AADT` column and put the current count in `AADT_2023`, so
swapping the URL alone would have changed nothing on screen. Diff the field
list, then bump the fetch cache key so browsers don't keep serving the old
shape.

## Recurring tasks

### 1. Shard rebuild — current data  (cadence: as-needed, after a scrape delta)
Rebuilds the legal/assessment/land-cover/**water** shards from the latest scrape.
```
monthly-refresh.bat
```
(Seven steps: scrape delta → legal index → assessment index + shards →
land-cover shards → water shards → **RollEntry fallback snapshot** → manifest
validate. The water step was added 2026-08-05 and the RollEntry step
2026-08-12; before those, each was in no script or task at all and only
refreshed when someone ran it by hand.)

**Exit codes:** `0` clean, `1` aborted at a fatal step (1-3, 7), `3` finished
but a non-fatal shard build (4-6) failed and that dataset is now serving its
previous shards. Code 3 is new as of 2026-08-12 — before it, a failed shard
build was logged and otherwise invisible: the run reported COMPLETED, Task
Scheduler recorded success, and the wrapper sent no alert.
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
**MASC inputs: v2 runs, not the CSVs in the repo root.** `build_masc_shards.R`
and `build_parcel_masc.R` resolve their source in this order: the
`MASC_SQUARE_CSV` / `MASC_RIVERLOT_CSV` env override, then the newest
MASC-SCRAPE **v2** run directory carrying a `COMPLETE` marker, then — with a
loud warning — the legacy flat CSVs. Those legacy files (`masc_soil_ratings_*`
in this repo's root and the scrape project root) are frozen at 2026-04-01 and
hold 153,809 square-section rows with no Range 29A coverage, against v2's
158,455. Until 2026-08-05 they were the silent default, so a plain
`Rscript r/build_masc_shards.R` would have quietly republished four-month-old,
less complete ratings over the good ones with nothing erroring. Don't restore
that default, and don't "tidy up" the legacy CSVs into the resolver's path.

When publishing only MASC data from a worktree that also contains other
generated changes, scope the publication so unrelated shards stay unstaged:
```
powershell -ExecutionPolicy Bypass -File update-cdn-pin.ps1 `
  -IncludePaths masc,parcel-masc,masc-riverlots.json `
  -Message "Refresh MASC ratings"
```
**Then update the pinned commit** (REQUIRED): one command commits +
pushes the data repo and rewrites the SHA in `web/src/arcgis.js`:
```
powershell -ExecutionPolicy Bypass -File update-cdn-pin.ps1
```
Use `-DryRun` to preview, `-Message "..."` to override the commit
message, and `-IncludePaths` to stage only named generated products.
Review `git diff web/src/arcgis.js` and commit + push the app
(Vercel redeploys; clients pick up the new shards on next load). The
data revision is part of each MASC cache key, so changing the pin
automatically invalidates stale 30-day browser entries. That
data repo's history exists only to mint immutable SHAs — squash it
whenever it gets heavy, then repoint the app first.
`section-grid.json` is published separately via `api/section-grid.js`
(GitHub Release + edge function — see §1c below). It does NOT live in
mb-parcel-data because at 41 MB it's over jsDelivr's per-file cap.

**This repin now also happens automatically.** `auto-publish-indexes.ps1`
(scheduled monthly by `schedule_publish.ps1`) calls `update-cdn-pin.ps1` as its
step 4, then commits `web/src/arcgis.js` alongside the edge-fn URL bumps. That
closes a hole found 2026-08-05: `build_assessment_index.R` writes its per-muni
shards straight into the mb-parcel-data clone as a side effect, but nothing in
the chain committed that repo — so 187 rebuilt shards sat uncommitted while the
app stayed pinned to a SHA whose assessment data was generated 2026-05-14. The
rebuild "succeeded" every time; the result just never reached anyone. If you add
another build script that writes into mb-parcel-data, make sure something
publishes it, or it will fail the same silent way.

### 1d. RollEntry fallback snapshot  (cadence: **monthly**, via `monthly-refresh.bat` step 6)
The degraded-mode shards the app serves when live ROLL_ENTRY is mid-republish.
Now rebuilt automatically as step 6 of the monthly refresh. Run it by hand as
well after any off-cycle `r/download_parcels.R` (or semiannual download) that
drops a new gpkg mid-month:
```
Rscript r/build_rollentry_snapshot.R
```
It auto-selects the newest `RollEntry_YYYYMMDD.gpkg` in the repo root and takes
~2 minutes. Then publish with `update-cdn-pin.ps1` as above.

Until 2026-08-12 this was event-driven and manual ("rebuild whenever a fresh
gpkg lands"), which is precisely the instruction that does not survive contact
with a busy week: on 2026-08-12 all 187 shards were still built from
`RollEntry_20260804` while `_20260811` sat in the repo root, so the fallback
would have served week-old geometry during exactly the upstream outage it
exists to cover. Monthly is the floor, not the ideal — the fallback can still
be up to a month behind the newest gpkg, and it is worth rebuilding by hand
whenever you notice a fresh one land.

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
The MLI archive is hosted in the Cloudflare R2 `mb-ortho` bucket. Its CORS
policy allows the Manitoba Vercel origin, and production's
`VITE_MLI_ORTHO_PMTILES_URL` points to the public archive. See
`docs/MLI-IMAGERY-BASEMAP.md` for the URL and verification details.
Add a new archive host to `vercel.json` `connect-src` if it is not already
allowed. Review the current MLI terms before publishing.

### 8. Winnipeg MLS HPI — residential dashboard  (cadence: monthly, **scheduled**)
`ResChartsV2.5.qmd` (in `D:\Dropbox\Appraisal\RProjects\appraisal-templates\residential`)
reads CREA MLS HPI from `MLS_HPI_<Month>_<Year>` folders next to it; its loader
auto-picks the newest. Since 2026-08-12 the download is automated:
`hpi-download.ps1` (task `mb-parcelsearch-hpi-download`, daily 08:45) scrapes
the CREA HPI tool page for the newest `MLS_HPI-<Month>-<Year>_EN.zip`
(published ~the 10th), downloads it, and extracts ONLY the two monthly `.xlsx`
the dashboard reads (`Not Seasonally Adjusted (M)` + `Seasonally Adjusted (M)`;
the zip's quarterly/annual variants are unused and stay inside the provenance
zip kept in the folder) — no-op when the newest month is already present. `hpi-staleness-check.ps1` (daily 09:00) stays as the day-25 backstop
nag; both alert on `mbps-hpi-staleness-jks` + email.

**Naming gotcha (the July 2026 incident):** CREA's raw zip/folder name
(`MLS_HPI-July-2026_EN`, hyphens + `_EN`) matches NEITHER the dashboard's
`MLS_HPI_*` glob NOR the watchdog regex `^MLS_HPI_<Month>_<Year>$`. A manual
"Extract All" therefore produces an invisible drop — exactly what happened
2026-07-25, leaving the dashboard on June while July sat extracted under the
wrong name. The downloader normalizes the name; if you ever do it by hand,
rename to `MLS_HPI_<Month>_<Year>`.

Manual fallback: download via the "Accept and download data" button at
<https://www.crea.ca/housing-market-stats/mls-home-price-index/hpi-tool/>,
extract into a correctly named folder, re-render ResChartsV2.5.

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
powershell -ExecutionPolicy Bypass -File schedule_vintage_check.ps1  # mb-parcelsearch-upstream-vintage — weekly Mon 09:30 (superseded-service watchdog)
powershell -ExecutionPolicy Bypass -File ..\MBFloodMapping\schedule_flood_check.ps1  # mbfloodmapping-staleness — daily 09:20 (flood-layer watchdog)
powershell -ExecutionPolicy Bypass -File schedule_hpi_download.ps1   # mb-parcelsearch-hpi-download  — daily 08:45 (CREA HPI auto-download)
powershell -ExecutionPolicy Bypass -File schedule_hpi_check.ps1      # mb-parcelsearch-hpi-staleness — daily 09:00 (HPI backstop watchdog)
```

**First-run confidence check (one-shot, 2026-08-15 08:00).** The three
heavyweight tasks above had never once fired as of 2026-08-12 — every refresh
and publish in this project's history was manual — so `post-refresh-report.ps1`
is registered one-shot for the morning after the first real run:
```
powershell -ExecutionPolicy Bypass -File schedule_post_refresh_report.ps1
```
It is read-only and reports **either way**, which is the point: the standing
alerts are failure-only, so on a first run a silent morning is ambiguous
between "worked perfectly" and "never started". It summarises task results,
how far each log got, and — the one that matters — whether the app's CDN pin
actually moved to match `mb-parcel-data` HEAD, since a green refresh with an
unchanged pin is exactly how 187 rebuilt shards hid behind a stale SHA until
2026-08-05. Preview it any time with `-Console`; unregister once it has fired.
Verify: `Get-ScheduledTask -TaskName mb-parcelsearch-monthly-refresh,mb-parcelsearch-semiannual-archive,mb-parcelsearch-history-staleness,mbfloodmapping-staleness | Format-List *`.

**Check that they are actually registered, not just documented.** On 2026-08-05
`mb-parcelsearch-monthly-refresh` was described in this file as a live schedule
while being absent from Task Scheduler entirely — the `schedule_monthly.ps1`
line above had never been run on this machine. A task documented here is not
evidence that it exists; `Get-ScheduledTask` is.

**Sibling project — MBFloodMapping.** Its 11 flood layers had no schedule, no
watchdog and no documented cadence: every one was fetched by hand on 2026-04-21.
`mbfloodmapping-staleness` (daily, one reminder per month, 365-day threshold)
now nags when they age out. The re-pull itself stays manual on purpose — the
Designated Flood Area and RRV Special Management Area layers are statutory
boundaries and the rendered report prints their refresh date into client-facing
text, so replacing them unattended is the wrong trade. See
`MBFloodMapping/flood-staleness-check.ps1`.

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

## Scheduled tasks: logs live inside Dropbox

Every scheduled wrapper in this repo and in `mao-assembly` writes its log to a
`logs\` directory under `D:\Dropbox`. Dropbox opens files it has just seen in
order to hash and upload them, and that briefly locks them.

**This has already cost a cycle.** On 2026-08-09 `mao-assembly`'s
`refresh-monthly-wrapper.ps1` died on its *second* log line with "the process
cannot access the file ... because it is being used by another process". The
scheduled task reported only a numeric failure code, nobody was watching it, and
the refresh silently did nothing for two days until it was found on 2026-08-11.

Mitigations in place:

- `Write-Log` / `Log` retries with backoff (10 attempts, ~5.5 s total) in
  `auto-publish-indexes.ps1` and in both `mao-assembly` refresh wrappers. The
  dangerous moment is right after file *creation*, so those scripts create the
  log and write their first line inside the retry.
- `mao-assembly/input-staleness-check.ps1` checks `LastTaskResult` on the
  refresh tasks, so a silently-failing task is reported the next morning rather
  than waiting for its inputs to age past a 45-day limit.

**Not covered:** the `*>> $log` append redirections in
`auto-publish-indexes.ps1` (nine of them) cannot be individually retried without
rewriting call sites in a script that git-pushes unattended. They run well after
creation, so the race has passed by then. `semiannual-publish-wrapper.ps1` uses
several unprotected `Add-Content` calls but runs under
`$ErrorActionPreference = 'Continue'`, so a lock there costs a log line, not the
run.

**Done 2026-08-11 — the log directories are now Dropbox-ignored**, which removes
the cause rather than retrying around it:

```powershell
Set-Content -Path '<repo>\logs' -Stream com.dropbox.ignored -Value 1
Get-Content  -Path '<repo>\logs' -Stream com.dropbox.ignored   # verify: 1
```

Current state across the four repos (check with the `Get-Content` line above):

| Path | Dropbox-ignored |
|---|---|
| `mao-assembly\logs`, `mb-parcelsearch\logs` | yes — set 2026-08-11 |
| `mao-scrape\logs`, `mao-scrape\checkpoints` | yes — already was |
| `mao-scrape\.git`, `mb-parcelsearch\.git` | yes — already was |
| `mao-assembly\.git`, `mb-parcel-data\.git` | **no** — inconsistent with the other two |

Trade-off: ignored paths stop syncing to your other machines. For scheduled-task
logs that is what you want. The flag is an NTFS alternate data stream, so it is
**per-machine and invisible to git** — a fresh clone, a new machine or a Dropbox
reinstall silently loses it.

**That is why the `Write-Log` retries stay.** They are not redundant with the
ignore flag; they are the only protection that travels with the code. Belt and
braces, cheap, and the belt is invisible.

**Not everything is Dropbox — check before assuming.** `mb-parcelsearch\.git`
was already ignored, and `git add` there still failed on 2026-08-11 with
"unable to write new index file" (178 GB free, succeeded on retry). Since
Dropbox was not watching that directory, the likelier culprit is antivirus.
Do not extend the ignore flag to `.git` on the strength of that incident — it
would be cargo-culting a fix for a cause that has not been established.

**Large generated directories are NOT ignored**, and that is a separate decision
about backup posture rather than about locks — nothing has ever failed in them:

| Path | Size |
|---|---|
| `mao-assembly\cache` | 3.22 GB (re-downloadable; the annual task clears it anyway) |
| `mao-assembly\inputs` | 3.08 GB (re-downloadable, slowly) |
| `mao-assembly\results` | 933 MB (regenerable in ~80 min) |
| `mao-scrape\results` | 670 MB |
| `mao-scrape\cache` | 176 MB |

Ignoring those would stop ~8 GB of sync churn at the cost of their offsite copy.
Everything in them is reproducible from a pipeline run, so it is defensible —
but it has not been done, deliberately.

**Housekeeping**: 19 orphaned `*.tmp.<pid>.<hex>` files were cleared from
`mao-scrape` on 2026-08-11 — editor atomic-save leftovers from three dead PIDs
dating to 2026-06-11/15, all with their real file intact and all matched by
`.gitignore`'s `*.tmp.*`. Not related to the log-lock incident, despite looking
like it.

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
