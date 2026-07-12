# Winnipeg Historical (As-Of-Date) Compare — Port Guide

Self-contained guide to add the **historical parcel compare** system (the one
live on `manitoba-opendata-parcelsearch.vercel.app`) to the Winnipeg parcel
search app at `D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch\`.

Drop this whole file into a fresh Claude Code session opened in the Winnipeg
repo. It is written so the agent does **not** need to read the Manitoba repo —
but the authoritative reference implementations live there if you want them:

```
D:\Dropbox\ClaudeCode\MBOpenData\mb-parcelsearch\
  r\archive_snapshot.R          # snapshot archive + provenance sidecars
  r\build_historical_shards.R   # per-area shards + manifest (THE area-gate fix)
  r\build_lineage.R             # inferred predecessor/successor
  web\src\arcgis.js             # CDN fetchers (pinned-commit + self-invalidating cache)
  web\src\map.js                # historical layers, popups, size-change, lineage
  web\src\main.js               # loadHistorical, size-change stamping, current-link harvest
  web\src\lib\sizeChange.js     # pure size-change classifier (+ test)
  web\src\lib\acres.js          # assessor-vs-geometry area resolver (+ test)
  DOCUMENTATION.md §4–§6        # the full system reference
  MAINTENANCE.md                # operator runbook
```

> **Read the "Operational lessons" section (near the end) BEFORE writing any
> code.** Three of those (the simplification triangle bug, the jsDelivr `@main`
> staleness, and the self-invalidating cache) cost a full debugging session on
> the Manitoba app. They are baked into the steps below so Winnipeg avoids them.

---

## 0. What you're building

When the user turns on **Historical** for a Winnipeg neighbourhood and picks an
"as-of" date, the app overlays that snapshot's parcels (dashed amber) over
today's parcels, so you can see a lot before it was subdivided/reconfigured.
Each historical parcel popup shows the as-of roll/address/area/value, a link to
the **current** winnipegassessment.com page for that roll, an inferred
**lineage** ("← from / → became", with the successor rolls as live links), and
a **size-change** highlight (red/orange) when the parcel's area differs from
today's. All data is public open data, served free from a second GitHub repo
via the jsDelivr CDN. Nothing here touches the live search path.

It is an **investigative aid**, not legal proof: simplified display geometry,
inferred lineage, and pointer-only zoning all carry "verify against the
registered plan / title / by-law" disclaimers.

---

## 1. Manitoba → Winnipeg mapping (the crux)

| Concept | Manitoba | Winnipeg |
|---|---|---|
| Data API | ArcGIS REST (`arcgis.js`) | **Socrata SODA** (`soda.js`), `data.winnipeg.ca` |
| Parcels dataset | provincial `ROLL_ENTRY` | **`d4mq-wa44`** Assessment Parcels (`…/resource/d4mq-wa44.geojson`) |
| Parcel id | `Roll_No_Txt` (unique **per muni**) | **`roll_number`** (11-digit, **city-wide unique** — simpler!) |
| Shard key | `muni_no` (integer) | **`neighbourhood_area`** (name string, ~236 areas) → slugify for filenames |
| Assessment link | `Asmt_Rpt_Url` (harvested) | **`detail_url`** (winnipegassessment.com — already per-parcel in the data) |
| Area field | `Frontage_or_Area` ("5.0 Acres") | **`assessed_land_area`** (sq ft, e.g. `57888`) |
| Zoning layer | `Manitoba_Zoning_By_Laws` | **`dxrp-w6re`** Zoning (`…/resource/dxrp-w6re.geojson`) |
| "Dev-plan" layer | `Development_Plan_Designations` | **OurWinnipeg secondary plans** (`xh28-4smq`, `piz6-n3at`, …) — *optional*, see §6 |
| Source snapshots | `MBRollGeoPackage<YYYYMMDD>.gpkg` | **`AssessmentParcels_<YYYYMMDD>.gpkg`** (you already keep these!) |
| Native CRS | mixed (3857 in 2025, 26914 in 2026) | **WGS 84 / EPSG:4326** (consistent — but still record it, and compute area geodesically) |
| Lineage metric CRS | EPSG:26914 (UTM-14N) | **EPSG:26914** (Winnipeg is in UTM zone 14N — same) |

**Three Winnipeg simplifications fall out of this:**
1. `roll_number` is city-wide unique, so lineage/size-change match **by roll
   alone** — no `(muni, roll)` composite key.
2. `detail_url` is already on every parcel record, so the "open current
   assessment page" link needs **no URL construction or harvesting** for the
   parcel's own roll (you still harvest current `detail_url` by roll for the
   lineage "became" links — see §7).
3. The CRS is already WGS84, so you won't hit Manitoba's 2.4× area-inflation
   trap — **but** you must still (a) record `source_crs` in provenance and
   (b) compute areas **geodesically** (never planar-on-lon/lat). See lessons.

**One Winnipeg complication:** every parcel is a **small urban lot**. The
simplification triangle bug (Lesson B) would be *rampant* here. The fix —
**area-gate / don't simplify small lots** — is therefore non-negotiable for
Winnipeg, and in practice means almost all Winnipeg parcels ship **unsimplified
and exact** (which is fine: 108k small lots are cheap).

---

## 2. Architecture (identical to Manitoba — $0 hosting)

```
City of Winnipeg Open Data (data.winnipeg.ca / dated gpkg downloads)
        │
        ▼
  THIS repo (winnipeg-opendata-parcelsearch): the app + R generators
        │  archive (Dropbox, cold)            │ historical shards + lineage
        ▼                                      ▼
  WpgSnapshots\<year>\ + .meta.json     wpg-parcel-history repo  ──► jsDelivr CDN
  (dated source + provenance)           (NEW data-only repo)         (pinned @commit)
                                                   │
                                                   ▼
                                          the webapp (Vercel)
```

**Two repos:**
- `winnipeg-opendata-parcelsearch` (this one) — app + generator scripts.
- **`wpg-parcel-history`** (NEW, create it) — data-only; per-neighbourhood
  historical shards + lineage, served via jsDelivr. Keeps ~MBs of history out
  of the app repo and Vercel deploy.

**Public data only** ever enters `wpg-parcel-history`. No private/client data.

---

## 3. The snapshot archive + provenance  (port `archive_snapshot.R`)

You already download dated `AssessmentParcels_<YYYYMMDD>.gpkg`. Standardise on
keeping each one, append-only, in a cold archive outside git:

```
D:\Dropbox\Appraisal\Web\WpgSnapshots\<year>\
  AssessmentParcels20231113.gpkg   + .meta.json
  AssessmentParcels20260407.gpkg   + .meta.json
  (+ Zoning<YYYYMMDD>.geojson + .meta.json if you snapshot zoning too)
```

Port `r/archive_snapshot.R` with these changes:
- `SRC_DIR` → wherever you download Winnipeg gpkgs; `ARCHIVE_ROOT` → `WpgSnapshots`.
- `sources` list → one entry for `AssessmentParcels*.gpkg` (layer
  `assessment_parcels`), optionally `Zoning*.geojson`.
- Keep the **`.meta.json` provenance sidecar** verbatim in spirit. Per file it
  records: `source_date` (from the filename date), `retrieved_at` (+`_inferred`),
  **`source_crs`** (here `EPSG:4326`), `sha256`, `bytes`, `schema_fields`,
  `source` ("City of Winnipeg Open Data"), `source_url`
  (`https://data.winnipeg.ca/…/d4mq-wa44`), `license` ("City of Winnipeg Open
  Data — verify current terms"), and the "display shards are simplified — resolve
  to this file" note.

The `file_crs()`, `file_sha256()`, reuse-when-unchanged, and back-fill logic
port unchanged.

---

## 4. Historical shards  (port `build_historical_shards.R` — THE important one)

For each dated snapshot, write per-neighbourhood GeoJSON shards + a provenance
manifest. Output → the `wpg-parcel-history` repo.

```
wpg-parcel-history/
  index.json                                 # discovery: snapshots + per-layer dates (schema 2)
  <snapshot_id>/manifest.json                # provenance + neighbourhoods { "<slug>": { name, parcels } }
  <snapshot_id>/parcels/<slug>.json          # GeoJSON FC (4326)
  <snapshot_id>/zoning/<slug>.json           # optional
  lineage/<slug>.json                        # §5
  lineage/_index.json
```

`<snapshot_id>` = the parcel file's date `YYYY-MM-DD` (e.g. `2026-04-07`).

**Adaptations from the Manitoba script:**

1. **Shard key = neighbourhood slug, not muni number.** `neighbourhood_area` is
   a name with spaces/slashes (`"EAST KILDONAN / NORTH KILDONAN"`). Slugify for
   the filename and keep the display name in the manifest:
   ```r
   slugify <- function(x) {
     s <- toupper(trimws(as.character(x)))
     s <- gsub("[/ ]+", "-", s); s <- gsub("[^A-Z0-9-]", "", s); gsub("-+", "-", s)
   }
   ```
   Parcels with a missing/blank `neighbourhood_area` → bucket into a
   `"UNASSIGNED"` slug (don't drop them).

2. **Fields kept** (`PARCEL_FIELDS`): `roll_number, full_address,
   neighbourhood_area, market_region, zoning, assessed_land_area,
   total_assessed_value, property_use_code, detail_url`. (Carry `detail_url`
   so the popup can link the as-of roll even when offline-from-live.)

3. **CRS:** the gpkg is already 4326. Keep `to_wgs84_simplify()`'s transform
   (it's a no-op when already 4326) and the manifest `crs: "EPSG:4326"`.

4. **SIMPLIFICATION — use the area-gate (Lesson B).** Copy the Manitoba
   `to_wgs84_simplify()` *exactly*, including:
   ```r
   SIMPLIFY_TOLERANCE_DEG <- 0.00003     # ~2-3 m, only applied to large parcels
   SIMPLIFY_MIN_AREA_M2   <- 10000       # parcels < 1 ha are kept EXACT (never simplified)
   to_wgs84_simplify <- function(g) {
     if (is.na(sf::st_crs(g))) sf::st_crs(g) <- 4326
     # real-m² area for the gate, computed in a metric CRS (UTM-14N) — s2 OFF,
     # so do NOT area on lon/lat:
     area_m2 <- as.numeric(sf::st_area(sf::st_transform(sf::st_geometry(g), 26914)))
     if (sf::st_crs(g)$epsg %||% 0 != 4326) g <- sf::st_transform(g, 4326)
     geom <- sf::st_geometry(g)
     big  <- is.finite(area_m2) & area_m2 >= SIMPLIFY_MIN_AREA_M2
     if (any(big)) geom[big] <- sf::st_make_valid(suppressWarnings(sf::st_simplify(
       geom[big], dTolerance = SIMPLIFY_TOLERANCE_DEG, preserveTopology = TRUE)))
     sf::st_geometry(g) <- geom
     g[!sf::st_is_empty(g), ]
   }
   ```
   For Winnipeg, **almost every parcel is < 1 ha → kept exact → zero triangle
   risk.** (You could even skip simplification entirely; the area-gate is the
   safe default that still trims the rare large park/industrial parcel.)
   Record both constants in the manifest: `simplify_tolerance_deg`,
   `simplify_min_area_m2`.

5. **Loud field validation** (`require_fields`): hard-fail a parcel snapshot
   missing `roll_number` or `neighbourhood_area`; warn for zoning.

6. **Manifest (schema 2)** per snapshot: per-layer `source_file`, `source_date`,
   `retrieved_at`, **`source_crs`**, `sha256`, `bytes`, `source_url`, `license`,
   plus generator `commit`, `simplify_tolerance_deg`, `simplify_min_area_m2`, a
   geometry-accuracy note, and the verify `disclaimer`. `index.json` lists each
   `snapshot_id` with per-layer dates (discovery).

`--year` / `--neighbourhood` (was `--muni`) / `--index-only` flags port directly.

---

## 5. Lineage  (port `build_lineage.R`)

Infers predecessor/successor between consecutive snapshots. **Roll-identity
model** ports almost verbatim and is *simpler* for Winnipeg (roll is city-wide
unique):
- Same roll across snapshots = same parcel. Events arise only from **new** rolls
  (appear) and **removed** rolls (disappear) — not from re-survey geometry noise.
- New/removed parcels are reprojected to **`EPSG:26914`** (Winnipeg is UTM-14N)
  and intersected against the full other-snapshot set; an overlap counts when it
  covers ≥ `EDGE_COVER` (0.50) of the parcel. Connected components (union-find)
  cluster a subdivision/consolidation.
- Output `lineage/<slug>.json` (`events` + `by_roll` lookup) + `lineage/_index.json`,
  each with the verify disclaimer.
- **CRS lesson:** the Manitoba lineage first returned 0 events because two
  snapshots were in different CRSs and the intersection silently errored to
  empty. Winnipeg's are both 4326, but **still `st_transform` everything to a
  common metric CRS (26914) before any `st_intersection`/area** — and this is
  why `source_crs` is recorded.

Since you already have `20231113` and `20260407`, lineage produces real results
immediately.

---

## 6. Zoning + "dev-plan" layers (optional, do parcels first)

- **Zoning** (`dxrp-w6re`): shard like parcels (key by the neighbourhood the
  polygon falls in, or just ship a zoning shard per neighbourhood by spatial
  bin). Historical zoning is a **pointer to verify** against the by-law — same
  disclaimer as Manitoba.
- **"Dev-plan" equivalent:** Winnipeg has no provincial dev-plan; the closest is
  **OurWinnipeg secondary plans / precincts** (`xh28-4smq` precincts,
  `piz6-n3at` major-redevelopment, etc.). These are optional and low-priority —
  ship parcels (+ zoning) first; add a "secondary plan" historical layer later
  only if you snapshot those datasets too.

Recommendation: **Phase 1 = parcels only.** Zoning and secondary plans are
additive and can lag.

---

## 7. Frontend

Port the Manitoba frontend pieces into the Winnipeg `soda.js` / `map.js` /
`main.js`. Treat the Manitoba `arcgis.js` historical block as **shape, not
text** — re-home the fetchers in `soda.js`.

### 7a. CDN fetchers (`soda.js`) — bake in Lessons C + D

```js
// PIN to an immutable commit, NOT @main (Lesson C). Bump this SHA on every
// republish of wpg-parcel-history (see §8 / MAINTENANCE).
const HISTORICAL_CDN =
  'https://cdn.jsdelivr.net/gh/<you>/wpg-parcel-history@<commit-sha>';
const HISTORICAL_INDEX_TTL_MS    = 24 * 60 * 60 * 1000;   // 1 day
const HISTORICAL_MANIFEST_TTL_MS = 6  * 60 * 60 * 1000;   // 6 h — gates the shard version
const HISTORICAL_SHARD_TTL_MS    = 30 * 24 * 60 * 60 * 1000;

export async function fetchHistoricalIndex() { /* GET index.json, cache 'wpg_hist_index_v1' */ }
export async function fetchHistoricalManifest(snap) { /* GET <snap>/manifest.json, key 'wpg_hist_manifest_<snap>_v1' */ }

// Self-invalidating shard cache (Lesson D): key on the manifest's build
// timestamp, so any republish auto-busts the client cache — no manual bumps.
function manifestVersionToken(m) {
  const g = m?.generated; return g ? String(g).replace(/\D/g, '').slice(0, 14) : 'v1';
}
export async function fetchHistoricalShard(snap, layer, slug) {
  const m = await fetchHistoricalManifest(snap);
  const ver = manifestVersionToken(m);
  const cacheKey = `wpg_hist_${snap}_${layer}_${slug}_${ver}`;
  const cached = await readCache(cacheKey, HISTORICAL_SHARD_TTL_MS);
  if (cached) return cached;
  const res = await fetch(`${HISTORICAL_CDN}/${snap}/${layer}/${slug}.json`);
  if (!res.ok) return null;
  const fc = await res.json(); await writeCache(cacheKey, fc); return fc;
}
export async function fetchHistoricalLineage(slug) { /* GET lineage/<slug>.json, key 'wpg_lineage_<slug>_v1' */ }
```

(Reuse the Winnipeg app's existing IndexedDB `readCache/writeCache`. If it has
none, port `web/src/cache.js` from Manitoba.)

### 7b. Map layers + popups (`map.js`)

Port the Manitoba historical layers verbatim, renaming sources to
`historical-parcels` / `-zoning`. Key points:
- Parcels render as **dashed amber** line + faint fill over today's lots.
- **Size-change colouring** via a `match` on a stamped `_sizeBand`:
  `major` (|Δ|>25%) red, `minor` (>5%) orange, `gone` grey, else amber.
- **Click priority** (Lesson E): a parcel click must take priority over the
  zoning fill that blankets it. Each layer defers to higher-priority layers
  under the same point (parcel > zoning). Copy the Manitoba `wireHist(..., deferTo)`.
- **Popup** (`historicalParcelHtml`): show as-of `roll_number`, `full_address`,
  `assessed_land_area`, `total_assessed_value`; make the **Roll # a link** to the
  current assessment page (`p._curDetailUrl || p.detail_url`); append the
  **size-change block** (`old→new sq ft (Δ%)` + "verify" note) and the **lineage
  block** with successor rolls as **live links** to current assessment pages.
  Winnipeg's `detail_url` *is* the assessment link — no construction needed.

### 7c. `main.js` — `loadHistorical` + enrichment

Port `loadHistorical(snap, neighbourhood)`:
1. Resolve the neighbourhood → slug; `Promise.all` fetch parcels/zoning/lineage.
2. **Enrich from current data** (one helper, ports the Manitoba
   `stampHistoricalSizeChanges`): fetch today's parcels for the neighbourhood
   from SODA (`d4mq-wa44`, filtered by `neighbourhood_area`), build
   `roll → area` and `roll → detail_url` maps, then for each historical feature
   stamp `_sizeBand` / `_histArea` / `_curArea` / `_deltaPct` and `_curDetailUrl`.
   Pass `currentUrls` into `setHistoricalData` for the lineage links.
3. **Diagnostic** (Lesson F): if the current fetch returns nothing for the
   neighbourhood, or zero roll overlap despite both sides having data,
   `console.warn` the neighbourhood + sample rolls — so a name/key mismatch is
   visible instead of silently no-op'ing.
4. Banner: `HISTORICAL as of <snap> · verify vs by-law / title` + a `> 12 mo old`
   stale flag.

Reuse the **pure, unit-tested** helpers as-is (they're framework-free):
`web/src/lib/sizeChange.js` (`computeSizeChanges`, `sizeBand`) and the size-band
constants. Port their tests (`test/sizeChange.test.js`). The Manitoba
`lib/acres.js` nominal-roll guard is optional for Winnipeg (its
`assessed_land_area` is reliable), but the geometry-vs-assessor cross-check is
still worth keeping.

### 7d. HTML

Add a **Historical** toggle + an **"As of"** snapshot-date `<select>` (grouped
by year) in the Map-layers group, and a `#historical-banner`. Mirror the
Manitoba `index.html` block.

---

## 8. Publish workflow (the two-repo + CDN dance)

1. `Rscript r/build_historical_shards.R` → writes shards into `wpg-parcel-history`.
2. `Rscript r/build_lineage.R` → writes `lineage/`.
3. `cd ..\wpg-parcel-history && git add -A && git commit -m "…" && git push`.
4. **Copy the new commit SHA** and set `HISTORICAL_CDN` in `soda.js` to
   `…/wpg-parcel-history@<new-sha>` (Lesson C). Commit + push the app; Vercel
   redeploys. **Do not rely on `@main` or jsDelivr purging** — see Lesson C.

That's it: the pinned SHA is served immediately by jsDelivr, and the
self-invalidating cache key means clients pick it up on next load.

---

## 9. OPERATIONAL LESSONS — read these or repeat the pain

These are the bugs the Manitoba build hit. Each has a one-line fix that's
already in the steps above; this section explains *why* so you don't undo them.

**A. CRS / area.** Always record `source_crs` in provenance. Compute parcel
area **geodesically** (turf `@turf/area` in JS; `st_area` with `sf_use_s2(TRUE)`,
or in a projected metric CRS, in R) — **never** planar area on lon/lat
(squared-degrees garbage) and **never** trust a Web-Mercator file's native area
(inflated ~2.4× at these latitudes). Winnipeg ships 4326 today, but a future
download could differ — the provenance field is your tripwire.

**B. Simplification collapses small lots into TRIANGLES.** Douglas-Peucker drops
a rectangle's corner when the tolerance exceeds the corner-to-diagonal distance.
For small urban lots (all of Winnipeg) this turns rectangles into triangles /
"WWW" bowties. A rectangle is already a minimal 5-point ring, so simplifying it
can only hurt. **Fix: area-gate — never simplify parcels below `SIMPLIFY_MIN_AREA_M2`
(1 ha).** For Winnipeg that means virtually all parcels ship exact. Verify after
every build: scan shards for `<=4`-coord outer rings; expect only a fraction of
a percent (genuinely triangular lots).

**C. jsDelivr `@main` is stale and inconsistent — pin a commit SHA.** jsDelivr
caches its view of a branch HEAD with a lag, *and it differs per file*: after a
republish, some neighbourhoods served fresh geometry while others served weeks-old
geometry — **and purging all the files did not fix it** (purge re-fetches from
jsDelivr's stale HEAD view). Fetching the same file by its **commit SHA**
returned the correct version instantly. **Fix: `HISTORICAL_CDN` points at
`@<commit-sha>`, bumped on every republish.** Immutable, instant, no purge. The
cost is one extra line per republish (documented in §8) — worth it.

**D. A hard refresh does NOT clear IndexedDB — make the cache self-invalidating.**
The app caches shards in IndexedDB (30-day TTL). A user hard-refresh clears the
HTTP cache but not IndexedDB, so a stale shard persists for weeks; a manual
"bump `_v2`→`_v3`" only helps users who reload the new build. **Fix: key the
shard cache on the manifest's build timestamp** (`manifestVersionToken`). Any
republish changes the manifest's `generated` → new key → automatic re-fetch.
No manual bumps, no stale geometry, ever.

**E. Click priority.** Zoning fills blanket the map, so a parcel click also lands
on the zoning fill; without priority the last-wired handler wins and you get the
wrong popup. Each historical layer defers to higher-priority layers under the
same point (parcel > zoning).

**F. Loud diagnostics + validation.** Hard-fail shards missing the id/shard-key
field; `console.warn` (with sample keys) when the historical↔current match finds
zero overlap. Silent degradation wasted hours — make mismatches scream.

---

## 10. Phase plan (one commit each; stop for review between)

1. **Archive + provenance** — port `archive_snapshot.R`; archive your two
   existing dated gpkgs with `.meta.json` sidecars.
2. **Parcel shards** — port `build_historical_shards.R` with the **area-gate**;
   create the `wpg-parcel-history` repo; publish parcels + `index.json` +
   manifests. **Verify the triangle scan (<1%) before publishing.**
3. **Lineage** — port `build_lineage.R`; publish `lineage/`.
4. **Frontend read path** — `soda.js` fetchers (**pinned commit + self-invalidating
   cache**), `map.js` historical layers + popups (assessment link, size-change,
   lineage, click priority), `main.js` `loadHistorical` + current-data
   enrichment + diagnostics, HTML toggle/picker/banner. Port `lib/sizeChange.js`
   (+ test).
5. **Zoning (optional)** — add the historical zoning layer.
6. **Docs** — a Winnipeg `DOCUMENTATION.md` + `MAINTENANCE.md` section, including
   the **§8 republish + SHA-bump** step.

---

## 11. Verification checklist (per build / before each publish)

- [ ] Every archived gpkg has a `.meta.json` with `source_crs` + `sha256`.
- [ ] Shard manifest records `simplify_min_area_m2` + `simplify_tolerance_deg`.
- [ ] **Triangle scan:** `<=4`-coord outer rings are a fraction of a percent in
      every neighbourhood shard (script: load each `<snap>/parcels/<slug>.json`,
      count rings with ≤4 points). A grid subdivision showing many triangles =
      simplification leaked; check the area-gate.
- [ ] Lineage `_index.json` has non-zero events (proves the CRS reprojection
      worked — 0 events usually means a CRS/intersection failure).
- [ ] After publish: fetch a shard **by the pinned commit SHA** and confirm it's
      the new geometry (not `@main`).
- [ ] `soda.js` `HISTORICAL_CDN` points at the **new** commit SHA.
- [ ] App: `npm run build` clean, `npm test` green; toggle Historical for a
      neighbourhood and confirm parcels render as rectangles, the roll links to
      winnipegassessment.com, and size-change colours appear.

---

## 12. Quick reference — Winnipeg data endpoints

```
Assessment Parcels   d4mq-wa44   https://data.winnipeg.ca/resource/d4mq-wa44.geojson
Survey Parcels       sjjm-nj47   https://data.winnipeg.ca/resource/sjjm-nj47.geojson
Addresses            cam2-ii3u   https://data.winnipeg.ca/resource/cam2-ii3u.json
Zoning               dxrp-w6re   https://data.winnipeg.ca/resource/dxrp-w6re.geojson
Assessment detail    detail_url field → http://www.winnipegassessment.com/asmtpub/…?RollNumber=<roll>
```
Parcel fields (SODA, lowercase_underscore): `roll_number, full_address,
neighbourhood_area, market_region, zoning, assessed_land_area,
total_assessed_value, property_use_code, detail_url, geometry`.
App token: `import.meta.env.VITE_SODA_APP_TOKEN` (already wired in `soda.js`).
