# Scheduled tasks — mb-parcelsearch

Fifteen Windows Task Scheduler tasks refresh, publish and watch the Manitoba parcel-search
site's data. This file records what each one is, what it needs on a new PC, and how to
recreate it. Live settings verified against Task Scheduler on 2026-09-20.

Fast path for a rebuilt PC: `D:\Dropbox\ClaudeCode\_scheduled-tasks\restore-all.ps1`
re-imports the exact XML of every task. The registrars below are the maintained source of
intent and the way to change a task. Master index: `D:\Dropbox\ClaudeCode\SCHEDULED-TASKS.md`.
Operational detail beyond scheduling is in `MAINTENANCE.md`.

## Prerequisites on a new PC

- **Folder at the same path:** `D:\Dropbox\ClaudeCode\MBOpenData\mb-parcelsearch`. Several scripts hard-code `D:\Dropbox\ClaudeCode\MBOpenData\...` defaults (`task-health-check.ps1 -Root`, `post-refresh-report.ps1`, the HPI scripts' `-HpiDir` of `D:\Dropbox\Appraisal\RProjects\appraisal-templates\residential`). Env overrides: `MB_PARCEL_HISTORY_ROOT`, `MB_PARCEL_DATA_ROOT`, `MB_PARCELSEARCH_ROOT`.
- **Sibling folders under `MBOpenData\`:** `mao-scrape` (`run_delta.bat`, `results\*.parquet`), `mao-assembly` (Parquet and `RollEntry_*.gpkg` producer), `rural-report\fetch_aci.sh`, `mb-parcel-data` and `mb-parcel-history` (git clones with push access), `MBFloodMapping`.
- **Interpreters and tools:** Windows PowerShell 5.1; PowerShell 7 at `C:\Program Files\PowerShell\7\pwsh.exe` (the MSI install, not a Store alias; required by `auto-publish-indexes.ps1`); R (newest under `C:\Program Files\R`, with `sf` and friends); Node.js with `npm install` done in `web\`; Git for Windows including `C:\Program Files\Git\bin\bash.exe`; `cmd.exe`.
- **rclone** on PATH with two remotes in its own config: `r2-mb` (bucket `mb-ortho`) and `r2` (bucket `wpg-ortho`).
- **gh CLI** authenticated (`gh auth login`); `release-indexes.ps1` runs `gh auth status` as a preflight.
- **WSL** with `tippecanoe` installed inside the distro. `pmtiles` is self-installed by `rebuild-basemap.ps1` into `%LOCALAPPDATA%\Programs\pmtiles`.
- **Git push credentials** (Git Credential Manager) for three remotes: this app repo, `mb-parcel-data`, `mb-parcel-history`. Three tasks push to `main` unattended.
- **Alert config:** `alert-email.local.txt` in this folder (gitignored; keys `to`, `smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, optional `from`). This one file also serves mao-scrape, mao-assembly, MBFloodMapping and RentalDashboard. rclone config holds the R2 keys; gh holds the GitHub token.
- **ntfy topics** to subscribe: `mbps-monthly-refresh-jks`, `mbps-publish-indexes-jks`, `mbps-semiannual-archive-jks`, `mbps-hpi-staleness-jks`, `mbps-upstream-vintage-jks`, `mbps-task-health-jks`, `mbps-basemap-jks`, `mbps-parcel-tiles-jks`, `mbps-traffic-refresh-jks`.
- Mark `logs\` as Dropbox-ignored (see `MAINTENANCE.md`); a Dropbox lock on a log file killed a run on 2026-09-16.

## The tasks

| Task | Schedule | Registrar | Script it runs |
|---|---|---|---|
| mb-parcelsearch-hpi-download | daily 08:45 | `schedule_hpi_download.ps1` | `hpi-download.ps1` |
| mb-parcelsearch-hpi-staleness | daily 09:00 | `schedule_hpi_check.ps1` | `hpi-staleness-check.ps1` |
| mb-parcelsearch-history-staleness | daily 09:10 | `schedule_history_check.ps1` | `history-staleness-check.ps1` |
| mb-parcelsearch-basemap-staleness | daily 09:15 | `schedule_basemap_check.ps1` | `basemap-staleness-check.ps1` |
| mb-parcelsearch-upstream-vintage | Mon 09:30 | `schedule_vintage_check.ps1` | `upstream-vintage-check.ps1` |
| mb-parcelsearch-task-health | daily 09:40 | `schedule_task_health_check.ps1` | `task-health-check.ps1` |
| mb-parcelsearch-du-snapshot | 14th 03:40 | `schedule_du_snapshot.ps1` | `du-snapshot-wrapper.ps1` |
| mb-parcelsearch-landfacts-refresh | 14th 22:00 | `schedule_landfacts.ps1` | `landfacts-refresh-wrapper.ps1` |
| mb-parcelsearch-monthly-refresh | 15th 04:00 | `schedule_monthly.ps1` | `monthly-refresh-wrapper.ps1` |
| mb-parcelsearch-publish-indexes | 15th 04:30 | `schedule_publish.ps1` | `auto-publish-indexes.ps1` (pwsh 7) |
| mb-parcelsearch-post-refresh-report | 15th 08:00 | `schedule_post_refresh_report.ps1` | `post-refresh-report.ps1` |
| mb-parcelsearch-parcel-tiles | 16th 03:00 | `schedule_parcel_tiles.ps1` | `rebuild-parcel-tiles.ps1 -IfStale -Publish` |
| mb-parcelsearch-traffic-refresh | 16th 05:30 | `schedule_traffic_check.ps1` | `traffic-refresh-check.ps1` |
| mb-parcelsearch-semiannual-archive | 1 Jan and 1 Jul 04:30 | `schedule_semiannual.ps1` | `semiannual-publish-wrapper.ps1` |
| mb-parcelsearch-basemap-refresh | 2 Jan and 2 Jul 03:00 | `schedule_basemap.ps1` | `rebuild-basemap.ps1 -IfStale -Publish` |

All fifteen: LogonType S4U, RunLevel Limited, `powershell.exe` 5.1 (except publish-indexes,
which runs pwsh 7), StartWhenAvailable, allowed on battery, MultipleInstances IgnoreNew, no
working directory (each script locates itself).

**Deliberately NOT scheduled:** `rebuild-soil-tiles.ps1` (added 2026-09-22), which rebuilds
the province-wide soil PMTiles archive. Its two neighbours are on schedules —
`rebuild-parcel-tiles.ps1` on the 16th and `rebuild-basemap.ps1` twice a year — so the
absence is worth stating rather than leaving as an oversight to rediscover. The Manitoba
Soil Survey is static between revisions, and revisions are rare and announced; re-cutting
it on a timer would spend ~25 minutes and a 150 MB upload to reproduce the same archive.
Run it by hand when the survey is revised. It needs the same WSL/tippecanoe and rclone
prerequisites listed above.

## Recreate from the registrars

All registrars are independent and idempotent (they delete and recreate the task). Run
every one from an **elevated** Windows PowerShell prompt; the S4U principal needs admin,
and an unelevated run registers the task as Interactive and prints a `!!` banner.

```powershell
cd D:\Dropbox\ClaudeCode\MBOpenData\mb-parcelsearch
Get-ChildItem schedule_*.ps1 | ForEach-Object { powershell -ExecutionPolicy Bypass -File $_.FullName }
```

Verify every task reads S4U:

```powershell
Get-ScheduledTask -TaskName 'mb-parcelsearch-*' | Select TaskName, @{n='Logon';e={$_.Principal.LogonType}}
```

Then prove the alert channels: `.\monthly-refresh-wrapper.ps1 -TestAlert` (other wrappers
accept the same switch).

Monthly-on-day-N and "January and July only" triggers are created with `schtasks.exe`
inside the registrars because `New-ScheduledTaskTrigger` cannot express them. This is why
most live actions show the `-File` path without quotes (schtasks strips them; the paths
have no spaces so it is harmless).

## Per-task notes

**hpi-download / hpi-staleness.** Mirror CREA's newest MLS HPI zip into the residential
dashboard data folder, then a watchdog that alerts from day 25 of the month if the release
is behind. Download runs 15 minutes before the check on purpose.

**history-staleness.** Dead-man for the semiannual publish: alerts when the newest built or
app-pinned `mb-parcel-history` snapshot is older than 215 days. Needs git and the
`mb-parcel-history` clone.

**basemap-staleness.** Reads the basemap meta sidecar from both public r2.dev hosts; alerts
if OSM data is older than 400 days or the buckets disagree. No credentials needed.

**upstream-vintage.** Weekly reachability and vintage check of every provincial ArcGIS
service referenced in `web\src\*.js`.

**task-health.** The cross-project watchdog. Scans `schedule_*.ps1` in `mb-parcelsearch`,
`mao-assembly`, `mao-scrape` and `MBFloodMapping` for `$TaskName = 'literal'`, then reads
each task's state and last result. Alerts on failures, Disabled, missing registration, or a
task overdue by twice its interval. Falls back to a hard-coded snapshot if it discovers
fewer than 10 names. Cannot report on itself. Whitelists exit 2 for MAOChunkedDelta and
exit 3 for monthly-refresh. Runs last in the morning so the other checks' results exist.

**du-snapshot.** Monthly dwelling-unit delta into `mb-parcel-history`. Refuses (exit 2) if
more than 5 % of rolls lose units at once. **No alerting of its own**; task-health is the
only thing that notices a failure.

**landfacts-refresh.** Monthly AAFC crop-inventory fetch (via Git bash) plus land-facts
shard rebuild into `mb-parcel-data`. About 2 h. Timed the night before publish-indexes so
the shards get committed. **No alerting of its own.**

**monthly-refresh.** Runs `monthly-refresh.bat`: mao-scrape delta, index and shard
rebuilds, manifest validation. No commit or push. Exit 3 means a soft shard failure.

**publish-indexes.** Unattended publish: rebuild indexes from mao-scrape parquets, GitHub
release, `mb-parcel-data` publish and CDN repin, commit and push the app (Vercel deploys).
Must run under pwsh 7 (5.1 turns R's stderr into a fatal error).

**post-refresh-report.** Read-only summary of what the 04:00 and 04:30 jobs did and whether
the app's CDN pin advanced. Always sends.

**parcel-tiles.** Rebuilds the province-wide parcel PMTiles from the newest
`RollEntry_*.gpkg` (dropped by mao-assembly), tiles via WSL tippecanoe, uploads to
`r2-mb:mb-ortho`. About 1 h. `-IfStale` makes it a 1-second no-op when nothing changed.

**traffic-refresh.** Monthly check for a new MHTIS traffic report PDF; rebuilds
`traffic-history.json` and pushes when found. Refuses to publish off `main`.

**semiannual-archive.** Full snapshot publish twice a year: FeatureServer downloads,
archive, historical shards, push `mb-parcel-history`, repoint `HISTORICAL_CDN`, push app.
First scheduled fire is 2027-01-01. Watched by history-staleness.

**basemap-refresh.** Re-cuts the Protomaps streets basemap twice a year and publishes to
both R2 buckets. Sits one day behind the semiannual archive so they never overlap. First
scheduled fire is 2027-01-02. Watched by basemap-staleness.

## Timing rules (do not break these when editing)

- Monthly chain: 14th 03:40 du-snapshot, 14th 22:00 landfacts (must finish before the publish), 15th 04:00 monthly-refresh, 15th 04:30 publish-indexes, 15th 08:00 post-refresh-report, 16th 03:00 parcel-tiles, 16th 05:30 traffic-refresh. The 16th jobs avoid the 15th's git activity.
- Semiannual chain: 1 Jan / 1 Jul 04:30 archive, then 2 Jan / 2 Jul 03:00 basemap.
- Morning watchdog order: 08:45 hpi-download, 09:00 hpi-staleness, 09:10 history, 09:15 basemap, 09:20 mbfloodmapping-staleness, 09:30 (Mon) upstream-vintage, 09:40 task-health.
- Cross-project inputs: `mao-assembly-monthly-refresh` (Sun 03:00) produces the Parquet and gpkg that landfacts, monthly-refresh and parcel-tiles read; MAOChunkedDelta keeps `mao-scrape\results\*.parquet` fresh for du-snapshot and publish-indexes.

## Alerting

Every wrapper and check dot-sources `alert-lib.ps1`: email via SMTP (config in
`alert-email.local.txt`) plus an anonymous POST to `https://ntfy.sh/<topic>`. Dedupe stamps
in `logs\*-stamp.txt` are written only on verified delivery. Two tasks have no alert stack
of their own (du-snapshot, landfacts-refresh) and are covered only by task-health.

## Known drift between registrars and live tasks

None in the task definitions; every live task matches its registrar. Housekeeping notes:

- Several registrars were edited after the live task was registered (hpi-download 2026-09-04, traffic-check 2026-09-13, du-snapshot 2026-09-07). The content is equivalent, but re-running them is harmless and resets the "registered" date to match.
- `schedule_history_check.ps1`'s header used to say "no admin needed"; corrected 2026-09-20 to say elevate.
