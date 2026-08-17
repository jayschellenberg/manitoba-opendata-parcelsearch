# SPEC — Data Status tab + sales coverage document

Written 2026-08-16. Decisions are Jason's; the surrounding facts were verified
against the working tree the same day. **BUILT 2026-08-16 (evening)** — see
"As built" at the end for what shipped and where it deviates.

---

## What is being asked for

1. A new tab on https://manitoba-opendata-parcelsearch.vercel.app/ showing the
   status of every data source — when each was last refreshed/scraped, by
   municipality where that concept exists.
2. **Sales must NOT appear in that tab.** Sales status belongs only inside
   Sales Analysis → the MAO sales database option, as a **link to a document**
   listing last-scraped-for-sales by municipality.

---

## Decisions (2026-08-16)

| Question | Decision |
|---|---|
| Where the sales coverage doc lives | **Local folder**, `D:\Dropbox\Appraisal\Web\MAOSales\`, beside the shards — never Vercel |
| Granularity | **Mixed**: per-municipality where it genuinely exists, one dataset-level vintage otherwise |
| Scope | **All four**: MAO parcels+assessment (per muni), Zoning + DevPlan + RollEntry, HPI/derived series, live ArcGIS services |

### Why the sales doc is local, not published

The privacy model is explicit and deliberate (see `mao-scrape/HANDOFF-SALES-SEARCH.md`,
"Privacy model — do not break this"): the sales archive is paid MAO subscriber
data and is **never** published — not to the repo, not to the GitHub Release /
shard-CDN path the parcel shards use (raw.githubusercontent), not to Vercel.
The browser reads a folder on
the user's own disk via the File System Access API; access control is *absence*,
not a password.

A municipality+date list is metadata rather than sale records, but it is still
derived from the subscriber scrape and would publicly advertise that the archive
exists and exactly what it covers. Keeping it in the same local folder costs
nothing — **the app already holds a directory handle for that folder** — and
keeps the model intact.

---

## What already exists (verified 2026-08-16)

**Published manifest** — `web/public/data/manifest.json`, built by
`web/scripts/build-manifest.js`, read by `web/src/manifest.js`. Carries ONE
vintage per dataset:

```
datasets/legal_index      generated_at 2026-08-15T09:30:43Z  row_count 437778
datasets/assessment_index generated_at 2026-08-15T09:32:45Z  row_count 437981
```

That is the whole of what the site knows about freshness today, and it is what
the footer's "Data refreshed …" reads.

**Per-municipality vintage exists ONLY in mao-scrape, and is gitignored:**

| Source | File | Shape |
|---|---|---|
| assessment / parcels | `mao-scrape/checkpoints/muni_refresh_ledger.csv` | `muni_no, last_refreshed` — 186 rows, month precision (`2026-07`) |
| sales | `mao-scrape/checkpoints/sales_search_ledger.json` | per-muni `scraped_at` (full timestamp), plus `status`, `rows`, `capped_groups`, `cap_backfilled_at` |

Neither reaches Vercel today. **The assessment one will need publishing** (a new
small file in the build); the sales one must NOT be.

**Tabs** are `data-tab="property"` and `data-tab="sales"`, with
`#tab-btn-*` / `#tab-panel-*` ids — a third tab follows the same pattern.

**Sales panel** — `web/src/lib/salesStore.js` + `salesDbPanel.js`.
`showDirectoryPicker({ id: 'mao-sales', mode: 'read' })`, handle persisted, data
cached in IndexedDB. The coverage doc should be read through that same handle.

**Province-wide layers have no per-municipality concept at all** — zoning,
devplan and RollEntry are single provincial gpkg snapshots
(`ManitobaZoning_20260811.gpkg` etc., date in the filename). One vintage each.

**Live ArcGIS services** (`web/src/arcgis.js`): Parcels (Roll Entry), Zoning
By-Laws, Development Plan Designations. Fetched live, so their "vintage" is the
upstream service's own published date, not ours — `upstream-vintage-check.ps1`
already tracks this and is the natural source.

---

## Build plan

1. **Publish per-muni assessment vintage.** Extend `build-manifest.js` (or add a
   sibling step) to emit `web/public/data/muni-vintage.json` from
   `mao-scrape/checkpoints/muni_refresh_ledger.csv`. Small — 186 rows. Note the
   ledger is month-precision, so the UI should say "July 2026", not a false day.
2. **New "Data Status" tab.** Two sections, because the granularities are
   genuinely different and pretending otherwise misleads:
   - *By municipality* — 186 rows, assessment/parcels last-refreshed.
   - *Province-wide sources* — one row each: zoning, devplan, RollEntry, HPI,
     and the live ArcGIS services with their upstream dates.
   Explicitly **no sales column**.
3. **Sales coverage document.** Have `mao-scrape/scripts/export_sales_for_web.R`
   write `SALES-COVERAGE.csv` (and/or `.md`) into
   `D:\Dropbox\Appraisal\Web\MAOSales\` on every publish: muni_no, municipality,
   last scraped, rows, whether any slice is still truncated. It already writes
   `manifest.json` there, so this is the same path and cadence.
4. **Link it from the sales panel**, read through the existing directory handle.

## Traps worth knowing before starting

- **Do not add sales to the manifest or any published file.** That is the one
  hard constraint here.
- `muni_refresh_ledger.csv` is the ASSESSMENT cadence ledger, written by
  `$2run_delta.R` via `scripts/cadence.R`. It is unrelated to the sales sweep,
  which tracks its own state in `sales_search_ledger.json`. The two look
  interchangeable and are not.
- A municipality's assessment vintage is a **cohort month**, not a scrape
  timestamp: `cadence.R` splits munis into 6 or 12 monthly cohorts, so
  `2026-07` means "refreshed in the July cohort".
- The sweep is still filling in — 115/186 captured as of 2026-08-16 — so the
  sales coverage doc will legitimately show many municipalities as never
  scraped for a while yet.

---

## As built (2026-08-16 evening)

Everything above shipped, with two scope corrections found during the build:

1. **Soils and MASC added** (Jason, same day): the tab's live-services table
   covers the Soil Survey (CLI) layer and MASC Risk Areas alongside Roll
   Entry / Zoning / DevPlan and the three WALLAS layers, each showing its own
   `editingInfo.dataLastEditDate` fetched on tab open. The CDN-shipped MASC /
   land cover / water shards carry no timestamp at all (their `_index.json` is
   bare `{file, count}`), so they appear as one row pinned at the
   `mb-parcel-data` revision — adding `generated_at` to those manifests in
   `r/build_masc_shards.R` etc. is possible follow-up work.
2. **HPI dropped**: there is no HPI in this app. The CREA MLS HPI pipeline
   (`hpi-download.ps1`) feeds `ResChartsV2.5.qmd` in appraisal-templates, a
   different project; the in-app trend line (`salesCharts.js marketConditions`)
   is computed from the user's own loaded sales and has no vintage of its own.

What landed where:

**Round 2, same evening (Jason's follow-ups):** the tab became a **top-bar
dialog** ("Data Status" between Winnipeg Portal and Data Sources — the third
sidebar tab is gone); the ledger now records the **exact refresh day**
(`last_refreshed_date`, cadence.R 2026-08, backfilled from delta logs for the
21 munis actually deep-refreshed since logging began — the rest carry seeded
cohort months and gain dates as their cohorts come due); **MASC soil ratings**
got a real vintage (`_meta` in `masc/_index.json`, mb-parcel-data `fcbaa29`,
scrape run date beats rebuild date); and the **WALLAS** rows show
`newest record YYYY-MM-DD` via a MAX(APPLICATION_DATE) statistics query —
the provincial ArcGIS 10.51 MapServer publishes no editingInfo, so the newest
record in the data is the best available currency signal.

| Piece | Location |
|---|---|
| Per-muni assessment vintage | `buildMuniVintage()` in `web/scripts/build-manifest.js` → `web/public/data/muni-vintage.json` (186 rows; exact day where recorded, cohort month otherwise; listed in the manifest + covered by the `--validate` gate) |
| Data Status dialog | top-bar button `#data-status-open` → `#data-status-modal`; driver `web/src/dataStatusDialog.js`, pure logic `web/src/lib/dataStatus.js` (tested), lazy-loads on first open |
| Sales coverage data | `export_sales_for_web.R` joins the sweep ledger: per-muni `scraped_at`/`scrape_status` on `munis`, plus a full 186-row `coverage` array in the LOCAL manifest.json |
| Sales coverage documents | `SALES-COVERAGE.csv` + `.md` written beside the shards on every publish (change-skipped) |
| Panel view | "Coverage" button in the MAO Sales Database panel → dialog table from `web/src/lib/salesCoverage.js` (tested); pending municipalities dimmed, capped slices flagged |

The privacy line held: nothing sales-derived is in the published manifest, the
tab, or any Vercel-served file — coverage renders only from the local folder
the user already nominated. In passing, the published manifest's `source`
fields were trimmed to basenames (they leaked absolute `D:/...` paths).
