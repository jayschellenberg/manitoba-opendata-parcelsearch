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
| RollEntry snapshot (fallback), parcel-masc, assessment shards, masc shards, landcover shards, landcover tiles, river-lots, masc-riverlots | various R build scripts | `mb-parcel-data` repo → raw.githubusercontent (pinned commit) | monthly-ish |
| **Cold archive** (provincial source + provenance sidecars: roll / zoning / dev-plan) | MB Open Data downloads | `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\` | semi-annual (scheduled Jan 1 / Jul 1) |
| **Historical shards** (as-of-date view, keyed `YYYY-MM-DD`) | the cold archive | `mb-parcel-history` repo → raw.githubusercontent | when a new snapshot is archived |
| **Lineage index** (inferred predecessor/successor) | the historical shards | `mb-parcel-history/lineage/` → raw.githubusercontent | when ≥ 2 snapshots exist |
| **Place names** (map search box) | Canadian Geographical Names Database (NRCan) | `web/public/mb-places.json`, bundled | ~annual / never (stable reference data) |

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
  for its municipality's cadence re-scrape (6 months everywhere but the North,
  which is 12 — see mao-scrape's README) unless it SOLD, in which case the
  daily sales-change bridge corrects its title and legal within ~3 days.

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
The 40 MB province-wide grid ships through `api/section-grid.js` (same Release
+ edge-fn pattern as the indexes above — a split that predates the
raw.githubusercontent switch and stays, see §1b). To roll a new build:
```
Rscript r/build_section_grid.R
gh release create data-section-grid-YYYY-MM-DD web/public/data/section-grid.json --title "Section grid YYYY-MM-DD"
```
Then bump `RELEASE_URL` in `api/section-grid.js`, commit + push. Geometry
doesn't change, so this is a rare operation.

Size, everywhere this repo quotes it: **40 MB** — 42,358,712 bytes /
215,441 features, measured 2026-08-12 against
`mb-parcel-data/section-grid.json` and unchanged since the 2026-06-11 build
(`27173b26`). Both the `41 MB` this file used to carry and the `42 MB` briefly
introduced on 2026-08-12 described this same single artifact; 41 MB was stale
and 42 MB was the decimal-MB reading of it. Everything else in these repos
sizes files the way Explorer does (MiB labelled `MB`), so 40 MB is the
consistent figure. Re-measure before changing it.

The Release asset is minted from `web/public/data/section-grid.json` (gitignored,
regenerated by the command above) — **not** from the unreferenced 40 MB copy
tracked in `mb-parcel-data` (see §1b). Deleting that copy is safe: it is in no
code path, and removing it in a new commit cannot affect the currently pinned
SHA. Note the 40 MB blob stays in `mb-parcel-data`'s history (~212 MB `.git`)
until that history is squashed, which the repo's contract already allows —
repoint the app first.

### 1b. mb-parcel-data CDN refresh  (cadence: whenever any CDN-hosted dataset rebuilds)
Most of the app's generated data — RollEntry fallback shards,
parcel-masc, assessment shards, MASC shards, landcover shards, landcover
tiles, river-lots, masc-riverlots — lives in the **`mb-parcel-data`**
repo and reaches the app via **raw.githubusercontent.com** pinned to an
immutable commit (never a branch ref — every client must see one
coherent tree). The R build scripts already write straight into the
local `mb-parcel-data` clone (`mb_parcel_data_root` in `r/config.R`).
After any rebuild:
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
(GitHub Release + edge function — see §1c below); that split predates the
raw.githubusercontent switch (it was over jsDelivr's per-file cap) and stays
because the edge function's 7-day edge cache suits a 40 MB file better than a
raw fetch would.

> **Host switched 2026-08-17: jsDelivr → raw.githubusercontent, behind the
> `/gh-data` edge proxy.** jsDelivr enforces a 50 MB *package* (whole-repo)
> limit and `mb-parcel-data` is ~175 MB. The failure mode was silent and
> partial: files already in jsDelivr's cache kept serving while every cold
> file returned an error the app swallowed as "no data for this muni", and
> no new commit pin could ever ingest. **Do not point these repos back at
> cdn.jsdelivr.net.** raw.githubusercontent serves per-file with no
> repo-size limit and no ingestion lag, but rate-limits per client IP (a
> 429 surfaced on the first live check), so the app fetches same-origin
> `/gh-data/<repo>/<sha>/<path>` instead: a `vercel.json` rewrite routes it
> to `api/gh-data.js`, which proxies to raw and lets Vercel's edge cache
> hold each immutable URL — GitHub only sees Vercel egress traffic, and a
> repin changes every URL so nothing needs purging. `npm run dev` proxies
> the same path shape straight to raw (vite.config.js). Nothing about the
> *publish* flow changed: rebuild → commit/push `mb-parcel-data` → repin
> via `update-cdn-pin.ps1`, exactly as below.

> **Corrected 2026-08-12.** This paragraph used to say the file "does NOT live
> in mb-parcel-data". It does: a 40 MB copy is git-tracked at
> `mb-parcel-data/section-grid.json`, added by the 2026-06-11 bulk shard commit
> (`27173b26`) and never touched since. Nothing reads it — no
> `MB_PARCEL_DATA_CDN` URL references it, and `r/build_section_grid.R` writes to
> `web/public/data/section-grid.json`, not into the data clone. The *serving*
> claim above was always right; only the residency claim was wrong. The copy is
> dead weight carried by every pinned SHA and can be removed (see §1c).

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

### 1e. Assessment Parcels vector tiles  (cadence: **with 1d** — same gpkg, same staleness)
The province-wide PMTiles archive behind the **Assessment Parcels** overlay.
Built from the same `RollEntry_YYYYMMDD.gpkg` as the fallback snapshot in §1d,
so the two go stale together and should be rebuilt together.
```
Rscript r/export_rollentry_geojson.R
cd web && node scripts/build-parcel-tiles.js --run
```
Step 1 is GDAL `vectortranslate` (~12s for 438k features). Step 2 streams that,
derives `_rollDisplay` / `_civicAddress` / `_acres` **using the app's own
modules**, writes both tile layers, and runs `tippecanoe` via WSL. Total ~1
hour, nearly all of it tippecanoe.

The archive is **not** in git and **not** in `web/public/` on a deploy — Vite
copies `public/` into `dist/`, so a stray archive there ships on every Vercel
build. It lives in object storage.

**Publishing a rebuild** (credentials are in rclone's config, not this repo;
the `r2-mb` remote is scoped to the `mb-ortho` bucket):
```
rclone copyto "web/public/parcels.pmtiles" "r2-mb:mb-ortho/mb-assessment-parcels.pmtiles" --s3-no-check-bucket --progress
```
Live at
<https://pub-091058079bf6458da1681945177e1682.r2.dev/mb-assessment-parcels.pmtiles>,
which is what `VITE_PARCEL_TILES_URL` points at in Vercel. Leave that variable
BLANK locally so dev serves the archive from `web/public/` — offline and no
egress.

It shares the `mb-ortho` bucket with the MLI ortho archive. The name is a
mismatch (this is not orthoimagery) and it is worth moving to its own bucket
one day, but the reuse means the bucket's CORS policy and the `connect-src`
entry in `vercel.json` already cover it — no CSP change was needed.

**CORS lives on the R2 bucket, not on Vercel.** The headers come from whoever
serves the file, so nothing in Vercel's settings can grant the app permission
to read the archive — it is set in the Cloudflare dashboard under R2 →
`mb-ortho` → Settings → CORS Policy. `AllowedOrigins` covers:

- `https://manitoba-opendata-parcelsearch.vercel.app` — production
- `https://*-jks-consulting-inc.vercel.app` — **every** preview deploy. Added
  2026-08-23 after a branch preview failed with *"Failed to fetch"*: the policy
  named only production and localhost, so the browser blocked the request
  before any response. The wildcard is verified to match arbitrary future
  branch hostnames, so a new branch needs no CORS change.
- `http://localhost:5173` — dev. **`http://127.0.0.1:5173` is NOT allowed, and
  is a different origin as far as CORS is concerned**, so start dev on
  `localhost` or the archive fetch fails with the same misleading message.

`ExposeHeaders` MUST keep `content-range`. Without it the browser hides that
header from JavaScript and PMTiles cannot locate itself in the archive — which
fails as subtly wrong tiles rather than a clean error.

**Verify a publish** the same way the ortho was verified: a range request must
return `206` with the full size in `Content-Range`, the first seven bytes must
read `PMTiles`, and with an `Origin` header the response must carry
`Access-Control-Allow-Origin` plus `content-range` in
`Access-Control-Expose-Headers` (PMTiles cannot work without that last one).
```
curl -s -D - -o - -H "Origin: https://manitoba-opendata-parcelsearch.vercel.app"      -H "Range: bytes=0-6"      https://pub-091058079bf6458da1681945177e1682.r2.dev/mb-assessment-parcels.pmtiles
```
That line is Git Bash. In PowerShell use `curl.exe`, `-o NUL` rather than
`-o /dev/null`, and `| Select-String access-control` rather than `| grep`.

**Scheduled** monthly, task `mb-parcelsearch-parcel-tiles`, 16th at 03:00 --
a clear day behind `mb-parcelsearch-monthly-refresh` (15th, 04:00) so a slow
refresh cannot overlap an hour-long tippecanoe run. Registered by
`schedule_parcel_tiles.ps1` (idempotent; re-run after changing the script).

The task runs `rebuild-parcel-tiles.ps1 -IfStale -Publish`:

- **`-IfStale`** compares the newest `RollEntry_*.gpkg` against the
  `source_file` recorded in `web/public/parcels-pmtiles-meta.json` and exits in
  about a second when they match. That is what makes a monthly schedule cheap:
  the gpkg only really changes when `r/download_parcels.R` drops a new one, and
  re-tiling identical data costs an hour of CPU for no change. Checking monthly
  means a fresh gpkg is never more than a month from production.
- **`-Publish`** uploads to R2 and verifies the remote object's size against
  the local build. Without it a rebuild would sit on disk while production kept
  serving the previous archive -- the exact staleness the schedule exists to
  prevent. The sanity band and reconcile guard in `build-parcel-tiles.js` stand
  in for a human look; a size mismatch fails loudly rather than leaving a
  truncated archive serving everyone.

Run it by hand any time (`-IfStale` alone is a safe no-op dry run):
```
powershell -ExecutionPolicy Bypass -File rebuild-parcel-tiles.ps1 -IfStale
```

**The registrar must be run ELEVATED**, or the task is left `LogonType=Interactive`
and will not fire at 03:00 while logged off -- see the 2026-08-12 incident in
`schedule_monthly.ps1`. The registrar reads the principal back and says loudly
which one it got.

**Prerequisites:** WSL with tippecanoe (`wsl --install`, then
`sudo apt install tippecanoe`; Ubuntu here has v2.80.0). Note that invoking it
from Git Bash rather than the Node script fails with *"unable to open database
file"* — MSYS rewrites the `/mnt/...` paths into Windows ones. Prefix with
`MSYS_NO_PATHCONV=1` if you run it by hand.

**What to check after a build:** the script refuses to promote an archive
outside its 40–700 MB sanity band, so a truncated tile run cannot silently
become the province's parcel fabric. It also reconciles its own read against
the export's feature count and aborts on a short read. Both guards exist
because the first full build came out at **1.07 GB** — the tiles were carrying
all fourteen source fields, and properties were 66% of the payload multiplied
across six zoom levels. They now carry three; everything else the popup shows
is resolved **on the roll number** on click — `Roll_No_Txt` + municipality,
**never OBJECTID**.

That last clause used to read "resolved by OBJECTID on click", which was the
one thing it must not say. OBJECTID is an ArcGIS row id the province reissues
on every republish, so ids baked into an archive built from one extract do not
correspond to what the live FeatureServer serves from another. Measured on
GREY (RM): **62 of 62 rolls matched, 0 of 62 OBJECTIDs did** — every lookup
returned null and no popup could enrich. That was found and fixed before the
tiles shipped; only this line went on recommending it, in the operational doc
someone actually has open while working. `web/src/lib/muniParcelRecords.js`
keys on `canonicalRoll(props.Roll_No_Txt)` and says so in its header;
DOCUMENTATION.md §3.6.1 and `arcgis.js` carry the same warning. If you are
changing the join key, those are the three places that have to agree.

**The zoom floor is measured, not guessed.** The overlay is
municipality-scoped and the app fits the map to the whole municipality, so the
floor has to reach whatever zoom that fit lands on. Across 154 municipalities,
**93 fit below z11**, down to z8.5 for ST CLEMENTS (RM). An earlier build used
z11 on the assumption that a rural RM fits around z10–11; it did not, and the
layer would have been blank at exactly the extent most municipalities open at.
The floor is now z8. Do not raise it without re-measuring — and note that the
four `INDIGENOUS&NORTHERN RELATIONS` entries fit at z5.6–6.5 and are
deliberately *not* covered: they are province-spanning administrative
aggregates, and three more zoom levels of the whole province is a steep price
for four pseudo-municipalities whose parcels are a grey smear at that scale.

**Cross-checked by the Winnipeg audit, 2026-08-24.** ParcelSearch had the
identical bug from the identical assumption — z13 floor against a map that
opens at z11, so its overlay drew nothing at the default view (0 tiles, 0
features, toggle reading "Hide All Assessment Parcels"). It is on z8 now,
measured over street searches rather than municipalities, which makes z8 a
figure two independent measurements arrived at.

That audit sends back one thing this section does not cover: **dropping the
floor is what makes the low zooms render, and flat line styling may not
survive them.** Winnipeg's flat 1.5 px / 0.8 grey turned into a citywide dark
slab at z11 the moment the tiles existed to draw; it now interpolates width and
opacity by zoom. **Checked here 2026-08-24 and the flat values hold.** On
production, BRANDON (CITY) — the densest municipality in the roll — fits at
z11.36 and renders 17,444 parcel lines at 0.75 px / 0.6 `#d1d5db`: legible
texture, place labels readable through it. Winnipeg's blackout was 37,248
features at 1.5 px / 0.8 `#6b7280`, roughly 5.7x the line-ink.

One municipality settles it because the app fits the map to whichever one you
pick, so features-in-view is that municipality's whole parcel count almost
regardless of the zoom the fit lands on — ink-per-pixel tracks COUNT, not
extent, and the densest-by-count muni is therefore the worst case. Re-run this
only if an amalgamation puts one meaningfully above Brandon's ~17k. If ramps
ever are needed, graft them from
`ParcelSearch/web/src/lib/citywideParcelsStyle.js`, whose colours are already
identical to `web/src/lib/muniParcelsStyle.js` here.

**Measuring what a floor change costs.** Walk the PMTiles v3 directory for
bytes-per-zoom rather than reasoning about it. Winnipeg's z13→z8 move cost
+17.5 MB (z8 1.8, z9 2.9, z10 2.6, z11 3.8, z12 6.4) taking 99.4 → 116.5 MB,
and the same walk proved z13–z18 came out within 0.2 MB per zoom of the
previous build — the evidence that `--drop-densest-as-needed` had not started
quietly thinning tiles where parcels are still clickable. Worth running here
whenever the tippecanoe flags change.


**The ceiling is not a size budget.** The archive is range-requested, so a
viewer pulls a few hundred KB of tiles whether it is 100 MB or 700 MB, and R2
storage at this scale is pennies a month with no egress fee. The band exists to
catch a build having gone wrong, and it is calibrated against real numbers:
1.07 GB carrying all fourteen source fields, 509 MB after thinning to three.

**Do not add fields to the tiles casually.** A field costs its size × every
parcel × every zoom level. `Asmt_Rpt_Url` alone was 15% of the payload — and it
holds MAO's `extrct_prop_id`, which is reissued on the Spring/Fall rollover, so
a baked copy is wrong within months regardless. Resolve on click instead.

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
history from a pinned `mb-parcel-history` commit, not a branch ref — the pin
guarantees every client sees one coherent tree (back on jsDelivr, `@main`
served stale geometry even after purging; raw.githubusercontent serves branch
refs live but the coherence argument still holds). Copy the new commit SHA
into `HISTORICAL_CDN` in `web/src/arcgis.js`
(`…/mb-parcel-history/<new-sha>`), then commit + push the app (Vercel
redeploys). Any pushed commit serves immediately — no ingestion lag, no
purge. (The shard cache key auto-invalidates off the manifest's build
timestamp, so clients pick it up on next load. This repo rides the same
`/gh-data` edge proxy as mb-parcel-data — it is ~177 MB, over jsDelivr's
50 MB package limit; see §1b.)

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

### 4b. Retire a snapshot  (cadence: rare — when two captures sit too close)

Withdraws a snapshot from the app's "As of" picker. Nothing here implies the
data was wrong; the usual reason is two captures close enough that the second
adds nothing while splitting the lineage chain.

**Move the archived files OUT of `MAO_SNAPSHOTS_ROOT` — not into a subfolder.**
`build_historical_shards.R` and `build_lineage.R` both scan that root with
`recursive = TRUE`, so a `retired/` folder inside it is still found and the
snapshot is rebuilt on the next run. A sibling directory is what retires it.

**All three files travel together.** Zoning/dev-plan are paired to a parcel
file by an **on-or-before** date rule, so moving only the paired layers while
leaving the GeoPackage silently re-pairs that snapshot to an *older* year's
zoning — a wrong snapshot that looks entirely normal.

```
:: 1. move parcels + paired zoning + dev-plan, each WITH its .meta.json,
::    to a sibling of MAOSnapshots (or straight to deletion — see below)
move "D:\Dropbox\Appraisal\Web\MAOSnapshots\<yr>\MBRollGeoPackage<YYYYMMDD>.gpkg*" ...
:: 2. drop the published shards
rmdir /s /q ..\mb-parcel-history\<snapshot_id>
:: 3. rewrite the discovery index from what is on disk
Rscript r/build_historical_shards.R --index-only
:: 4. REQUIRED — lineage names its snapshots; see below
Rscript r/build_lineage.R
:: 5. publish, then repin the app
cd ..\mb-parcel-history && git add -A && git commit && git push
```
Then repoint `HISTORICAL_CDN` in `web/src/arcgis.js` to the new commit SHA
(§3) **and bump the index cache key** beside it (`mb_historical_index_v<n>`).
The bump is load-bearing on a removal specifically: the 1-day index TTL is
sized for snapshots being *added*, where lag costs nothing, but a cached index
keeps offering a date whose shards now 404 — the picker lists an option that
fails when chosen and reads as a broken feature.

Step 4 is not optional. Lineage is inferred between **consecutive** pairs and
every record names its snapshot, so removing one without rebuilding leaves
records pointing at a snapshot the picker no longer offers.

#### Deleting a retired archive — provenance of record

Retiring is reversible; **deleting is not.** The province's FeatureServer
serves current data only, so a dated capture cannot be re-pulled after the
fact. The archived downloads are the **source-of-record**: display shards are
simplified (~2-3 m) for visualization, measurements resolve back to the
archived file named in an export's provenance, and exports stamp
`as-of <snapshot>` into their preamble.

So before deleting, **transcribe the `.meta.json` sidecars here** — they are
deleted with the files, and this becomes the only record of what a cited
snapshot actually was.

##### `2026-06-05` — retired and deleted 2026-08-13

Sat only **26 days** before `2026-07-01`. Two captures that close add nothing
comparatively, and having both split the meaningful 2025-02-12 → 2026-07-01
lineage into two hops — the 26-day hop carrying almost no real events, while
the 16-month comparison never existed as a direct pair. Jan 1 / Jul 1 is the
intended cadence. **Nothing was wrong with the data.**

All three: Province of Manitoba (Manitoba geoPortal — public open data),
licence *Open Government Licence – Manitoba* (verify current terms).
`retrieved_at` was flagged `inferred` on all three (dated by file mtime).

| Archived file | Layer | Source date | Retrieved | CRS | Bytes | SHA-256 |
|---|---|---|---|---|---|---|
| `MBRollGeoPackage20260605.gpkg` | parcels | 2026-06-05 | 2026-06-05T15:19:37-0500 | EPSG:26914 | 235,020,288 | `44fd3250864553fa7a0dcc224f87b1736f6e0b431a8646efccf9bcfa6da87526` |
| `Manitoba_Zoning_By_Laws20260603.geojson` | zoning | 2026-06-03 | 2026-06-03T12:06:39-0500 | EPSG:4326 | 63,435,541 | `33386333dbedbf95d840be76d6a0a890c2fb7e1a4c82cf14d02ccd37d076f036` |
| `Manitoba_Development_Plan_Designations20260603.geojson` | devplan | 2026-06-03 | 2026-06-03T12:06:52-0500 | EPSG:4326 | 29,834,364 | `59e78ab012568cd6c87da59a4a2e18f9dfa5051dead5806fec3a305bf82ceaa9` |

Source datasets:
[Roll Entry](https://geoportal.gov.mb.ca/datasets/manitoba::roll-entry/explore) ·
[Manitoba Zoning By-Laws](https://geoportal.gov.mb.ca/datasets/manitoba-zoning-by-laws/) ·
[Development Plan Designations](https://geoportal.gov.mb.ca/datasets/manitoba::manitoba-development-plan-designations/about)

Verified after the retirement: 467 shard files removed; `index.json` lists
`2026-07-01` + `2025-02-12`; lineage rebuilt as one 2025-02-12 → 2026-07-01
pair (142 munis, 1,403 events, **zero** remaining references); pin moved to
`mb-parcel-history@7e73681`; cache key `mb_historical_index_v2` → `v3`. Links
improved rather than merely surviving — Brandon 562264 → 562314 now resolves
directly at confidence 1.00, where routing through 2026-06-05 had it at 0.99.

### 5. Land-cover shards  (cadence: when mao-assembly reruns)
`build_landcover.R` runs as a non-fatal step inside `monthly-refresh.bat`;
it re-shards from whatever complete mao-assembly Parquet is current.

### 6. Land-cover Detailed tiles  (cadence: rare — only a new raster)
Only when a new provincial `LCR_RCT_*.tif` lands (years apart):
```
Rscript r/build_landcover_tiles.R     # needs GDAL on PATH; ~15-45 min
```
Commit the regenerated `web/public/data/landcover-tiles/`.

### 6b. Place names for the map search box  (cadence: ~annual, or never)
Feeds the "Find a town…" box in the map's top-left corner — type `Souris`,
get the town pinned and told it sits in SOURIS-GLENWOOD. Rebuild from `web/`:
```
npm run places
```
Downloads NRCan's Manitoba CGNDB bulk CSV (~24K names), keeps the ~2,000
populated places (city / town / village / hamlet / unincorporated / reserve),
resolves each one's containing municipality by point-in-polygon against
`web/public/mb-municipalities.geojson`, and writes `web/public/mb-places.json`
(~138 KB). Commit the regenerated file.

The municipality is resolved **at build time**, which is the point: the client
never does geometry, so the RM appears the instant a result renders. Places
whose CGNDB reference point falls just outside their own boundary — the narrow
Lake Winnipeg village strips, Dunnottar being the worked case — are matched to
the nearest municipality within 2 km and flagged `near`, which the UI shows as
"near DUNNOTTAR (VILLAGE)". Genuinely unorganized places (most of the north,
most reserves) resolve to null and read as "Unorganized territory".

Worth rerunning only if the boundary file is replaced or NRCan revises the
gazetteer; place names and municipal boundaries both change on a scale of
years. `test/placeSearch.test.js` asserts the file's schema, that every
coordinate lands inside Manitoba, and that a handful of known places still
resolve to the right RM — so a bad regeneration fails the suite rather than
silently flying the map into Ontario.

### 6c. Flood zones — overlay + column  (cadence: when MBFloodMapping refreshes, ~annual)

Two artefacts, two different geometries, and the difference is the point.

| Artefact | Built by | Geometry | Where it lives |
|---|---|---|---|
| Map overlay (5 toggles under **Flood**) | `npm run flood:overlay` | MBFloodMapping's **web-simplified** layers (3–30% of vertices) | `web/public/data/flood/*.geojson`, ~490 KB, committed here |
| **Flood** grid column + CSV | `npm run flood:shards` (`r/build_flood.R`) | MBFloodMapping's **full-resolution** cache | `mb-parcel-data/flood/`, served via the CDN pin |

The overlay draws a simplification and the column decides membership from the
full geometry, so a boundary parcel can look outside the DFA on screen and
read `RRV DFA 12%` in its cell. That is deliberate. If they ever have to
agree, raise the overlay's fidelity — never lower the column's.

Both read the sister project at `D:\Dropbox\ClaudeCode\MBOpenData\MBFloodMapping`
(override with `MBFLOODMAPPING_ROOT`). Refresh the source there first:

```
Rscript R/refresh_flood_data.R      # in MBFloodMapping — pulls the layers
Rscript R/simplify_for_web.R        # in MBFloodMapping — rebuilds web/data/
```

Then, from this repo:

```
cd web && npm run flood:overlay     # seconds; commit web/public/data/flood/
npm run flood:shards                # 10-25 min; then publish per §1b
```

`build_flood.R` needs the current `RollEntry_<date>.gpkg`, joins all nine
zones at full resolution, and ships only parcels intersecting at least one —
most of the province is outside every layer. Publishing the shards is the
normal CDN dance in §1b (commit `mb-parcel-data`, bump the pin with
`update-cdn-pin.ps1`). Until that runs, the column stays blank rather than
saying "None", which is the correct rendering of not knowing.

`web/test/flood.test.js` asserts that `src/lib/flood.js` and the built overlay
geometry still agree — a zone renamed in one and not the other fails the suite
instead of quietly rendering every feature in the fallback grey.

**The source vintage is not the boundary vintage.** `RRVDFA`, `LRDFA` and
`SMA` come from the Manitoba Land Initiative, which stopped publishing updates
on **2022-02-09**. MBFloodMapping's refresh still succeeds against it — it
re-fetches 2022 bytes and stamps them with today's date. DataMB carries a
newer Designated Flood Areas layer (last edited 2025-04-02) that has **not**
been repointed to; that is Jason's call, recorded in the header of
`MBFloodMapping/R/refresh_flood_data.R`, and the repoint is a schema change
rather than a URL swap (DataMB merges both DFAs into one 2-feature layer keyed
on `Designated_Flood_Area_Zone`). The Data Status dialog's "Flood zone shards"
row says so on the face of it.

### 6d. Land facts — crop history, relief, wetland, water  (cadence: annual, after AAFC releases the new crop-inventory year)

One artefact, four federal rasters, one number per parcel per layer — the
open-data land record for every farmland parcel, pre-baked so the grid and
popup never touch a raster.

| Artefact | Built by | Sources | Where it lives |
|---|---|---|---|
| **Land Facts** grid column + popup box + 12 CSV columns + the **Crop History** map overlay (Years Cropped / Land Use views) | `npm run landfacts:shards` (`r/build_landfacts.R`) | AAFC Annual Crop Inventory 2009–2025 (30 m; 56 m in 2009–10), NRCan MRDEM-30, Canadian Wetland Inventory v3A (10 m), JRC Global Surface Water 1984–2021 | `mb-parcel-data/landfacts/`, served via the CDN pin |

**Which parcels.** `CalcAcres >= 20` with a MASC rating, read from the newest
complete `mao-assembly` Parquet (173,697 parcels, 147 municipalities on the
2026-08-20 run). The rating is what says "agricultural land"; the acreage
trims hobby blocks. Both are recorded in the index's `_meta` and asserted by
`web/test/landfacts.test.js` against `LANDFACTS_MIN_ACRES` in
`web/src/lib/landfacts.js` — change one and the suite fails until the other
matches.

**Prerequisites.** The crop-inventory GeoTIFFs must be cached in the sister
project first — a remote read of those zips costs up to 161 s per year and is
not viable in bulk:

```
bash ../rural-report/fetch_aci.sh      # ~660 MB, once per year when AAFC publishes
```

MRDEM, the wetland inventory and surface water are plain cloud-optimised
GeoTIFFs and are read remotely. `exactextractr` must be installed in R; the
script falls back to `terra` but that is roughly 100x slower.

Then, from this repo:

```
cd web && npm run landfacts:shards     # ~2 h for the province; resumable
npm run landfacts:shards -- --muni 610 # one municipality, by MAO code or name
```

A municipality whose shard already exists is skipped, so an interrupted run
picks up where it stopped; `--force` rebuilds. Publishing is the normal CDN
dance in §1b. Until that runs the column stays blank rather than saying
"None", which is the correct rendering of not knowing.

**What a record means.** Per year, the dominant crop-inventory class and the
share of the parcel under annual crop; `null` is a year the inventory did not
observe (raster background or cloud over more than half the parcel) and is
never written as 0 — zero would read as "nothing grew". Forest codes 200–230
sit numerically above the crop range 130–199 and are not crop. Wetland and
water shares are of the whole parcel, not of the cells that carried a value.
Both of those were bugs caught before the family shipped, by
`rural-report/tests/crosscheck_shards.py`, which compares the shards against
rural-report's slower per-parcel path for a fixed set of rolls — run it after
touching the extraction.

**On the map.** The Crop History button (Agricultural layers) cycles
Off → **Years Cropped** → **Land Use** → Off over the muni-wide parcel
fabric. Both views are derived in the browser from the same `cp` / `dom`
series, so nothing here needs a rebuild:

- *Years Cropped* — gold ramp on the share of observed years with crop
  ≥ 50% (`CROP_RAMP` and `CROP_YEAR_MIN_PCT` in `web/src/lib/landfacts.js`;
  legend labels live on the ramp entries, bin edges follow them literally).
- *Land Use* — cover group of the last observed year (`COVER_GROUPS` /
  `coverGroup` in the same file; the annual-crop range is 130–199).

Changing a colour, label, bin or group is a lib edit plus
`web/test/landfacts.test.js`; the legend, grid dot and popups read from the
lib. A new inventory year is the one change that touches both sides:
extend `LANDFACTS_YEARS` and the builder's year range together, rebuild
and republish, and the views follow. The overlay switches Assessment
Parcels on and scopes the tile fabric itself — see DOCUMENTATION.md
§3.7.1 before touching that path; the failure mode (colours but no click)
is silent.

**Not a cropping record.** The crop inventory is a satellite classifier; AAFC
targets 85% overall accuracy nationally and publishes none per parcel. The
grid cell says so in its tooltip, the popup shows the whole series, and the
overlay legend carries the same footnote, so the pattern, not one year, is
what gets read.

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

### 7b. Streets basemap — Protomaps  (cadence: semi-annual, **scheduled**)
The Streets basemap is a Manitoba cut of the Protomaps daily OpenStreetMap
build, self-hosted as `basemap-manitoba.pmtiles` on the `mb-ortho` R2 bucket
(same bucket, CORS and `connect-src` as the MLI ortho and Assessment Parcels
archives, so nothing else needs configuring). `web/src/map.js` hard-codes the
public URL as the default; `VITE_BASEMAP_PMTILES_URL` overrides it for local
work. Style comes from the `@protomaps/basemaps` npm package (light flavor);
sprites are checked in under `web/public/basemap-sprites/`. The Winnipeg app
serves the **identical file from its own bucket** (`r2:wpg-ortho/`); one
script publishes to both.

**Rebuild is `rebuild-basemap.ps1`**, scheduled as `mb-parcelsearch-basemap-refresh`
(Jan 2 / Jul 2, 03:00 — a clear day behind the semiannual publish) with
`-IfStale -Publish`. 5–30 minutes end to end (the extract is ~4 min; the
Winnipeg bucket's server-side swap took 20 min on the first run where the
Manitoba one took 4 s — rclone handles the two remotes' providers differently). By hand:
```
powershell -ExecutionPolicy Bypass -File rebuild-basemap.ps1 -Publish            # newest daily build, both buckets
powershell -ExecutionPolicy Bypass -File rebuild-basemap.ps1                     # extract + verify only, leave on disk
powershell -ExecutionPolicy Bypass -File rebuild-basemap.ps1 -Build 20260831 -Publish
```
What it does, in the order that matters for running it unattended:
1. Finds the newest build by probing `build.protomaps.com/<YYYYMMDD>.pmtiles`
   back up to 14 days (there is no machine-readable index), and reads its
   metadata remotely — header only, not the 137 GB planet.
2. **Schema gate.** Refuses (alert, nothing uploaded) any build whose tileset
   major version is not the one the deployed `@protomaps/basemaps` targets
   (`$ExpectedTilesetMajor`, v4 today), or that lacks any of the nine source
   layers the style reads. Bump the constant only together with the npm
   package in **both** web trees.
3. Extracts bbox `-102.5,48.5,-88.5,60.5` to z15 into `%LOCALAPPDATA%\Temp\mb-basemap`
   (never Dropbox), then `pmtiles verify`, an 800 MB–3 GB size band, and a
   header read-back of zoom/bounds. First build (2026-08-31 planet): 1.09 GB.
4. **Staged publish** per bucket: upload as `.staging`, size-verify,
   server-side rename over the live object, size-verify again, then a public
   ranged GET on the r2.dev host. Production never has a moment with no file.
5. Publishes `basemap-manitoba.meta.json` next to the archive (build date,
   OSM data time, tileset version, bbox, size, sha256). That sidecar is what
   `-IfStale` and the watchdog read — i.e. what production actually serves.

The pmtiles CLI is pinned by version **and zip SHA-256** and self-installs to
`%LOCALAPPDATA%\Programs\pmtiles` when missing, so a wiped temp dir or a
fresh machine cannot turn the job into a silent no-op.

**Dead-man watchdog:** `basemap-staleness-check.ps1`, scheduled daily as
`mb-parcelsearch-basemap-staleness` (09:15). Reads both public sidecars and
nags (once a month) when the OSM data is > 400 days old, a sidecar is
unreadable, or the two buckets serve different builds. Both jobs share the
ntfy topic `mbps-basemap-jks`; `task-health-check.ps1` picks the two tasks
up automatically from their registrars.

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
powershell -ExecutionPolicy Bypass -File schedule_task_health_check.ps1     # mb-parcelsearch-task-health         — daily 09:40 (reads every task's LastTaskResult)
powershell -ExecutionPolicy Bypass -File schedule_post_refresh_report.ps1   # mb-parcelsearch-post-refresh-report — 15th monthly 08:00 (did the refresh actually publish?)
powershell -ExecutionPolicy Bypass -File schedule_basemap.ps1        # mb-parcelsearch-basemap-refresh   — Jan 2 / Jul 2 03:00 (Protomaps streets basemap re-cut + publish, both buckets)
powershell -ExecutionPolicy Bypass -File schedule_basemap_check.ps1  # mb-parcelsearch-basemap-staleness — daily 09:15 (basemap dead-man watchdog, reads the public sidecars)
```

#### Run these from an ELEVATED prompt (2026-08-12: tasks are now S4U)

**Re-run any registrar as administrator, or it silently downgrades its task.**
Every task on this machine used to be `LogonType=Interactive`, which means *does
not run unless Jason is logged on*. On **2026-08-12 at 01:31** a Windows Update
reboot left the machine sitting at a logon screen and **nothing ran for 9.3
hours** — including every watchdog, so no local component could even report the
outage. `MAOSalesSearch` alone missed 7 firings.

All **14** affected tasks were converted that day to **S4U** — "run whether the
user is logged on or not", with *no stored password* — and verified working
(five were run under the new principal and returned 0, exercising Dropbox file
reads, cross-repo dot-sourcing and outbound HTTPS).

> **The drift trap this closes.** The registrars build their tasks with
> `schtasks.exe`, which can *only* produce Interactive. So before this change,
> re-running any `schedule_*.ps1` for an unrelated reason — a changed path, a new
> flag — silently handed that task back to Interactive and re-opened the gap.
> Each registrar now sets the principal itself, immediately after its
> `Set-ScheduledTask -Settings` call.

**Setting a task principal is an administrative operation.** From an ordinary
prompt `Set-ScheduledTask -Principal` throws `Access is denied.` The registrars
catch that so the task still registers and stays usable, then **read the
principal back and print the actual `LogonType`** rather than asserting it. If
the result is not S4U they end with an unmissable `!!` banner, and they
distinguish the two cases: *never was S4U* versus **this run just downgraded a
working S4U task** — the second being the urgent one. Verify any time with:

```
Get-ScheduledTask | Where-Object TaskName -match 'mb-parcelsearch|mao-|mbflood' |
  Select-Object TaskName, @{n='LogonType';e={$_.Principal.LogonType}}
```

> **Exception — the two mao-scrape sales tasks stay Interactive on purpose.**
> `MAOSalesSearch` (`mao-scrape\schedule_sales_search.ps1`) and
> `MAOSalesStaleness` (`mao-scrape\schedule_staleness_check.ps1`) must **not** be
> converted. `scripts/sales_search.R` decrypts the MAO credential blob
> (`checkpoints\.mao_credentials.xml`) with **DPAPI**, and the staleness check
> *tests* that the blob still decrypts. DPAPI unwraps with the user's master key,
> which only an interactive logon unlocks; an S4U token is a logon-less identity
> and never unlocks it. Under S4U the sweep would fail at login and the watchdog
> would false-alarm **every day** — trading an occasional gap for a permanent
> one. The working alternative, which **only Jason can set up by hand**, is the
> *other* form of "run whether user is logged on or not": the one **with the
> Windows account password stored** ("Do not store password" unchecked). That
> establishes a real logon session, so DPAPI still works *and* the task survives
> a logon screen. It cannot be scripted — Task Scheduler requires the password to
> be typed into `taskschd.msc` — so nothing in these repos attempts it. Until
> then these two are the last logged-off hole on this machine, and the
> healthchecks.io heartbeat (`checkpoints\heartbeat-url.txt`) is the only layer
> that notices during an outage.

**Post-refresh report (monthly, 15th at 08:00).** `post-refresh-report.ps1`
runs four hours after the 04:00 refresh and 04:30 publish and sends one
summary **either way** — which is the point: the standing alerts are
failure-only, so a silent morning is ambiguous between "worked perfectly" and
"never started". It summarises task results, how far each log got, and — the
one that matters — whether the app's CDN pin actually moved to match
`mb-parcel-data` HEAD, since a green refresh with an unchanged pin is exactly
how 187 rebuilt shards hid behind a stale SHA until 2026-08-05. Preview it any
time with `-Console`.

> **2026-08-12 — was a one-shot, now monthly.** It was originally registered
> `-Once` for 2026-08-15 08:00 as a first-run confidence check (the three
> heavyweight tasks had never fired; every refresh and publish in this
> project's history was manual). That was wrong to leave standing: its
> PUBLISHED STATE block is the *only* automated pin-vs-HEAD check anywhere, so
> after 08-15 the 2026-08-05 failure mode would have gone back to being
> unwatched forever. `-At` still overrides, and now sets the day-of-month and
> time of the **recurrence** (`-At '2026-09-20 07:30'` → the 20th of every
> month at 07:30); days 29-31 are refused because they do not exist in every
> month.

**Every scheduled task now has a result reader.** `task-health-check.ps1`
(daily 09:40, after the other morning watchdogs) walks **all** MBOpenData
tasks across `mb-parcelsearch`, `mao-assembly`, `mao-scrape` and
`MBFloodMapping` and flags any whose `LastTaskResult` is not healthy (healthy =
`0`, `267011` never-run, `267009` running), plus any that is Disabled, has an
empty `NextRunTime`, is missing from Task Scheduler entirely, or has not run in
2× its own trigger interval. Codes are translated to words. It gets its task
list by **reading the `schedule_*.ps1` registrars**, not from a hardcoded
roster, so tasks added later are covered automatically.

> **Why:** until 2026-08-12 only four of fifteen tasks had anything reading
> their result — two hardcoded pairs, in `mao-assembly\input-staleness-check.ps1`
> and `post-refresh-report.ps1`. That morning `MAOSalesStaleness` had been
> killed at its execution time limit (`267014`) and `MAOChunkedDelta` had exited
> `2` (file not found) the night before, and **neither sent anything** — the
> sales watchdog was itself down, silently. Nobody was watching the watchdogs.
> Push topic: `mbps-task-health-jks`. Check by hand any time with
> `powershell -File task-health-check.ps1 -NoAlert` (sends nothing, leaves the
> quiet-period stamp alone).

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
notifications work out of the box if you subscribe to the ntfy.sh topics in
the ntfy app — `mbps-monthly-refresh-jks`, `mbps-semiannual-archive-jks`
(the publish wrapper and the watchdog share this one) and
`mbps-task-health-jks` (the all-tasks result reader). **Email needs one
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
