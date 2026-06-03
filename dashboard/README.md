# Data Refresh Control Panel

A small local dashboard for maintaining the Winnipeg and Manitoba parcel-search
data artifacts. It shows when each generated/downloaded dataset was last
refreshed and exposes buttons for the controlled refresh chains.

## Quick Start

From `D:\Dropbox\ClaudeCode\MBOpenData\WebSearch`:

```cmd
start-dashboard.bat
```

The launcher opens:

```text
http://localhost:5180
```

You can also run it manually:

```cmd
set DASHBOARD_PORT=5180
node dashboard\server.js
```

No npm install is needed for the dashboard itself; it uses Node built-ins.

## What It Tracks

- Winnipeg quarterly parcel artifacts:
  - `SurveyParcels_YYYYMMDD.gpkg`
  - `AssessmentParcels_YYYYMMDD.gpkg`
  - `ParcelCrossRef_YYYYMMDD.csv`
  - `web/public/parcels.pmtiles`
- Winnipeg transit overlays:
  - `web/public/transit-routes.geojson`
  - `web/public/transit-stops.geojson`
- Winnipeg neighbourhood overlays, refreshed only when source boundaries change.
- Manitoba quarterly snapshots:
  - `RollEntry_YYYYMMDD.gpkg`
  - `ManitobaZoning_YYYYMMDD.gpkg`
  - `ManitobaDevPlan_YYYYMMDD.gpkg`
- Manitoba MAO legal/assessment artifacts:
  - `web/public/data/legal-index.json`
  - `web/public/data/assessment-index.json`
  - `web/public/data/assessment/*.json`
  - `web/public/data/manifest.json`
- Manitoba MASC/soil artifacts:
  - `web/public/data/masc/*.json`
  - `web/public/data/parcel-masc/*.json`
  - `web/public/data/masc-riverlots.json`
- Manitoba static reference overlays:
  - `web/public/data/section-grid.json`
  - `web/public/data/river-lots.json`

## Buttons

- **Winnipeg quarterly parcel refresh** runs Winnipeg parcel download,
  cross-reference build, PMTiles GeoJSON export, Docker/tippecanoe PMTiles
  build, tests, and production build.
- **Winnipeg transit refresh** runs `npm run refresh:transit`, tests, and build.
- **Winnipeg neighbourhood refresh** runs `npm run refresh:neighbourhoods`.
- **Manitoba quarterly Open Data snapshots** runs `r/download_parcels.R`.
- **MAO full scrape + rebuild** runs `..\mao-scrape\run_full.bat`, rebuilds
  legal/assessment artifacts, rebuilds the manifest, then tests/builds.
- **MAO delta scrape + rebuild** runs the same chain using
  `..\mao-scrape\run_delta.bat`.
- **Manitoba MASC/soil refresh** rebuilds MASC overlay shards, parcel-level
  soil shards, `masc-riverlots.json`, the manifest, tests, and build.
- **Manitoba reference overlay refresh** rebuilds section grid and river lots.

All runs stream stdout/stderr into the page and write a log file under
`dashboard/logs/`.

## Configuration

- Port: `DASHBOARD_PORT`, default `5180`.
- Winnipeg repo: `WPG_ROOT`, default
  `D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`.
- MAO scrape repo: `MAO_SCRAPE_ROOT`, default sibling `..\mao-scrape`.
- Rscript: `RSCRIPT`, default
  `C:\Program Files\R\R-4.5.3\bin\Rscript.exe` when present, otherwise
  `Rscript` from PATH.

## Notes

The dashboard does not auto-delete old snapshots and does not auto-commit or
push. Review `git status`, tests, and generated logs before committing data
refreshes.
