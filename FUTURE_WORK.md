# Future work — assessment-index follow-ups

Notes captured during the rollout of the per-roll assessment shard +
"Vacant land only" filter. The shard already powers the boolean filter;
these are the next leverage points off the same data once we have a
need + headspace.

## Shard CDN: Vercel proxy in front of raw.githubusercontent — SHIPPED

2026-08-17: mb-parcel-data (~175 MB) and mb-parcel-history (~177 MB)
turned out to be over jsDelivr's 50 MB *package* limit — cached files
kept serving but every cold file failed, and new commit pins could
never ingest. The first replacement (direct
`raw.githubusercontent.com/<repo>/<sha>/<path>` fetches) worked but
tripped raw's per-client-IP rate limit on the very first live check.

Shipped the same day: `api/gh-data.js` + a `vercel.json` rewrite serve
`/gh-data/<repo>/<sha>/<path>` same-origin, proxying to raw with
`s-maxage=31536000, immutable` so Vercel's edge cache absorbs repeat
traffic (the SHA in the URL makes every response immutable; a repin
changes every URL, no purging). Both CDN constants in
`web/src/arcgis.js` point at the same-origin path; `npm run dev`
proxies the identical path shape straight to raw via vite.config.js.
Nothing further to do here unless GitHub throttles Vercel's egress
IPs — the escalation then is authenticated GitHub fetches from the
edge function (a token in a Vercel env var raises the rate limit).

## Table + popup + CSV columns

The filter alone hides parcels — but the assessment values themselves
(`_asmtLand`, `_asmtBuildings`, `_asmtTotal`, `_asmtYear`, `_asmtPctBldg`)
are stamped on every CSV-uploaded parcel and currently never surface
to the user. Worth adding:

- **Land Value** — sales-only column, formatted as currency
- **Building Value** — sales-only column, formatted as currency
- **Building %** — sales-only column, percentage with 1 decimal
- **Assessment Year** — header annotation (single year covers most
  of the shard since MAO aligns assessments cycle-wide); per-row
  display only when the row's year differs from the dominant year

Hover tooltip should also call out land/building/year values for any
parcel where `_asmtTotal` is set, so the appraiser can sanity-check
the vacancy classification at-a-glance without opening MAO.

CSV export needs to include the same columns to match the table.

## Replace the boolean with a "Max building %" slider

Today: `Vacant land only` checkbox, hard-coded 2% threshold.

Better: a small numeric input or slider — "Max building % of total"
defaulting to 2 — that lets the user tune the predicate to their
own definition of "nominally vacant". Edge cases:

- 0% — strict ("zero buildings only")
- 5–10% — captures fences/sheds on otherwise empty land
- 20–30% — captures small old houses on large agricultural lots that
  appraise as land deals despite a token improvement

The `VACANT_BUILDING_PCT` constant in `web/src/assessmentIndex.js`
becomes a runtime value read off the input.

## Class + status filters

Tax_history.parquet carries `class` (RESIDENTIAL 1 / FARM PROPERTY /
OTHER PROPERTY / FARM USE VALUE / etc.) and `tax_status`
(TAXABLE / EXEMPT / FARM ASSESSMENT / etc.) per parcel-year-class.
The current shard collapses across classes for the bottom-line total
but DROPS the class/status dimensions. To filter on them we'd need
to either:

1. **Expand the shard** to keep one row per parcel per dominant class,
   carrying class + status alongside the value triplet. Roughly 2–3x
   the row count (most parcels are single-class), still well under
   any size limit.

2. **Build a parallel class-index shard** keyed by parcel, listing
   all classes/statuses for the latest year. Smaller but adds a
   second fetch + Map.

Then the sidebar gets two new selects under the vacant-land row:
`Class ▾` (multi-select) and `Status ▾` (multi-select). Filter combines
with the existing Vacant + Size + DU filters via `AND`.

Useful for separating:

- Farm land (FARM PROPERTY / FARM USE VALUE) from residential vacant lots
- Exempt institutional land (churches, parks, government) from market
  vacant land
- Pipeline / utility easement parcels (typically OTHER PROPERTY +
  building-only) from genuine land deals

## Threshold review hint on the page

Hard-coded 2% should not stay invisible forever. Add a small footnote
or tooltip on the panel: "Vacancy threshold is 2% of total assessed
value; review this rule annually as the building-cost and land-value
mix shifts."

## Maintenance friction

- The R script needs to run after each `mao-scrape` refresh. Easiest
  path forward: chain `assessment:index` into whatever cron / batch
  script already runs `legal:index` in the Winnipeg-pattern setup.
- Production refresh today is a 3-step manual dance: rebuild → upload
  to a GitHub Release → bump RELEASE_URL in `api/assessment-index.js`.
  Same as legal-index. Could be wrapped in a single shell script with
  the date in one place if it gets annoying.

## Maybe-later ideas not yet committed to

- Per-roll **assessment delta** (year-over-year value change) as an
  additional column / filter — would need multi-year shard, not just
  the latest. ~2–3x file size again.
- "Sale price / assessed land value" ratio — directly useful for
  identifying possible mispriced land deals. Would compute on-the-fly
  in the filter pipeline once `_asmtLand` is available, no shard
  change needed.
- Export the `parcels` portion of MAO scrape (frontage_or_area,
  property_type, dwelling_units) into the legal-index shard so the
  web app stops needing to call the slow ROLL_ENTRY endpoint for
  fields that don't change between scrapes. Larger scope; touches
  the existing search path.

## Civic-number RANGE searches are still capped at 1000 rows

The From #/To # boxes are client-side post-filters over whatever the
muni query returned, and `MAX_RESULTS` caps that fetch at 1000. 122 of
Manitoba's 186 munis hold more parcels than that (Macdonald ~6200,
Rosser 1802), so a number search could silently miss most of a muni —
the parcel simply never reached the browser.

Three of the four modes no longer have this problem — `civicNumberClause`
in `arcgis.js` narrows server-side, so the cap never binds:

- **contains** (one box filled) → `LIKE '%1106%'`
- **exact** (From == To) → anchored `LIKE '1106%'`
- both across either spacing, see `lib/civicRange.js`

That covers the common paths, since To auto-fills from From.

Still open: a genuine **range** (From=100, To=200) with no street name
typed. A LIKE can't express a range, so it post-filters the capped 1000
rows and the "server cap reached" warning is the only hint. Options if
it ever bites:

- Expand a narrow range (say ≤50 numbers) into per-number prefix LIKEs
  and keep the post-filter for wider ones.
- Raise `MAX_RESULTS` for the address path only — the parcel query
  returns geometry, so this costs wire size and browser memory.
- Push a real civic-number column into the legal-index shard and range
  on it there (fits the "export parcels into the shard" idea above).

## Traffic counts: annual-report PDFs are the real history (phase 2)

2026-09-10. Phase 1 shipped the live-service fixes (read `AADT_2024`,
date every count from `DateOfEsti`, put AADT on the Manitoba Highways
popup, replace the hardcoded "AADT (2019)" legend). What it could not
fix is that the ArcGIS service only carries three vintages, and only
two of them have a trustworthy year.

MHTIS publishes *Traffic on Manitoba Highways* as a PDF per year at
`gov.mb.ca/mti/traffic/mhtis_traffic_reports.html` — 2008-2019, 2023,
2024, 2025. The 2025 edition is NEWER than anything in the ArcGIS
service. A prototype parse of it (530 pages, 40 MB, PyMuPDF
`get_text('words')` grouped into rows by y) pulled **7,435 station-year
rows across 2,097 stations, 2016-2025**, and every value reconciled
against the live service.

Three things only the PDF has:

1. **Real per-station series.** Section III (PTH/PR). Continuous (ATR)
   stations carry 8-10 annual values; short-duration (SDC) ones carry
   only the years they were counted — 1,226 of 1,753 stations (70%)
   have exactly 2, so a uniform "last 5 years" does not exist. Show
   whatever the station has.

2. **Town count stations.** Section IV — the 291 stations (StationNum
   >= 5000) that have no flow segment and therefore no number in the
   app today. For an in-town commercial property these are the counts
   that matter: Arborg's are ~3x the rural segments on the same
   highways (stn 5023, N. of PTH 68: 3,480 in 2018 -> 3,620 in 2024;
   stn 5025, W. of PR 326: 3,100 -> 3,240, against PTH 68's 1,230).

3. **Honest staleness.** Measured across all 2,067 segments, the year
   of each segment's CURRENT count is 2024: 805, 2023: 663, 2019: 448,
   2016: 100, plus ~47 reaching back to 1995. Station 77 on PTH 101 is
   still serving a **2004** count of 16,650 as current.

### The station layer is not wired up at all

Worth knowing before starting: `fetchTrafficStations`, `setTrafficData`,
`setTrafficVisible` and `buildAadtIndex` are all exported and none is
imported by `main.js`. There is no station toggle in `index.html`, so
the `traffic-circle` layer never receives data and `trafficHtml`'s
"Toggle Show Flow for AADT" branch is unreachable dead code. Giving town
stations "their own icon + real counts" therefore means building the
station overlay, not adjusting one.

### Shape of the work

- Build-time parser (R or Python) over the report PDFs -> a per-station
  JSON shard in `mb-parcel-data`, keyed on StationNum, holding
  `{year: aadt}` plus Dir (keep `C`, the combined direction; ATR
  stations also publish EB/WB/NB/SB rows that must not be summed in).
- Older editions (2008-2019) will need per-year layout handling; the
  2025 one alone already covers 2016-2025.
- Then: station overlay + toggle, town stations on their own icon, and
  a popup showing the station's full published series.

### Field semantics, verified

`DateOfEsti` ("Estimation Year") is the year of the NEWEST published
count and pairs with the newest `AADT_<year>` column — verified at
1,649/1,655 stations (99.6%) against the 2025 report. `EYear` is the
year of the older count and pairs with `AADT`. The MIDDLE column has no
reliable year: `AADT_2023` means "the number printed in the 2023
report", which for a short-duration station is an older physical count
carried forward (stn 1193, PTH 68 at Arborg: AADT_2023 = 1,130, which
the report shows as a 2018 count). Never label it with a year.
