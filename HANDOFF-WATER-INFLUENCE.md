# Handoff — Water Influence (waterfront / near-water)

Last updated: 2026-08-04

The old HANDOFF.md (a frozen 2026-05-07 MASC snapshot) has been deleted;
it remains in git history if the MASC notes are ever needed. Operator
procedures live in [MAINTENANCE.md](MAINTENANCE.md).

This covers one feature that spans **three repos**, so read the map first.

---

## 1. What this feature is

Per-parcel waterfront classification, surfaced in the app as a **Water** column,
two search filters, and a **Water Influence** map overlay.

Four fields per parcel, plus a distance:

| Field | Values |
|---|---|
| `WaterInfluence` | `Yes` / `No` |
| `WaterInfluenceClass` | Direct · Waterfront · Reserve Separated · Road Separated · Corridor Blocked · No Corroboration · None |
| `WaterBodyType` | Lake · Watercourse · Reservoir · **Retention Pond** · Water · Pond · Canal · Unknown |
| `WaterBody` | e.g. "Red River", "Lake Manitoba", "Retention Pond" |
| `WaterDistanceFt` | parcel boundary → nearest water, **in feet** |

**The class is not decoration.** Frontage (Direct / Waterfront / Reserve
Separated) and near-water-without-frontage (Road Separated / Corridor Blocked)
are different markets. A lot fronting the Red River and a lot across the road
from it are both "near water" and are not comparable. Do not collapse them into
a Yes/No.

---

## 2. Repo map

| Repo | Role |
|---|---|
| `D:\Dropbox\ClaudeCode\MBOpenData\mao-assembly` | **Detection.** Builds the water layer and classifies every parcel. (Moved 2026-08-04 from `D:\Dropbox\Appraisal\RProjects\appraisal-templates\mao-assembly`.) |
| `D:\Dropbox\ClaudeCode\MBOpenData\mb-parcel-data` | **Published shards.** Data only, served via jsDelivr pinned to a commit SHA. |
| `D:\Dropbox\ClaudeCode\MBOpenData\mb-parcelsearch` | **The app** + the bridge script that turns the parquet into shards. |

Data flow:

```
mao-assembly  prepare_water_data.R   -> inputs/MB_Water_Features.gpkg
              1CombineMBFiles.R      -> results/MAOParcelOutput<date>.parquet
mb-parcelsearch  r/build_water.R     -> mb-parcel-data/water/<MUNI>.json + _index.json
                 (commit + push mb-parcel-data, bump MB_PARCEL_DATA_REVISION)
              web/src/arcgis.js      -> fetchWaterForMuni()
              web/src/main.js        -> stampWaterInfluence() -> _water on each parcel
              web/src/lib/water.js   -> palette, labels, cell text (single source of truth)
              web/src/map.js         -> water-fill + water-outline layers
```

---

## 3. Current state (2026-08-04)

**Published and live:**
- `mb-parcel-data` @ `c390d65e` — 180 water shards rebuilt from
  `MAOParcelOutput20260804.parquet` (**V6.2**, per-parcel `d` distances), on
  the CDN and verified fetched by the app.
- `mb-parcelsearch` — app pinned to that revision. Water cache keys now
  include `MB_PARCEL_DATA_REVISION` (they previously did not, so a revision
  bump would NOT have invalidated cached shards for up to the 30-day TTL).

**Committed and pushed** (mb-parcelsearch main): water column, both filters,
roll pre-filter, map overlay, blue ramp, sidebar regrouping, `water.test.js`,
and the `WaterDistanceFt` surfacing (cell text "body · N ft", tooltip line,
distance tie-break in sorting).

**Committed and pushed** (mao-assembly main): `2df49c6` V6.1 retention ponds,
`191daf1` V6.2 containing-parcel fallback + WaterDistanceFt, `8e3a4bb`
scheduled input refresh + staleness watchdog + OSM cache TTL.

---

## 4. Algorithm history

| Version | Change |
|---|---|
| V6 | Baseline, validated 100% on a 46-parcel set. Boundary distance + multi-point corridor. |
| **V6.1** | **Residential retention ponds.** Was producing ZERO. Details in `mao-assembly/docs/waterfront_detection_methodology.md`. |
| **V6.2** | **Containing-parcel fallback** (§5) + `WaterDistanceFt` + water body recorded for near-water parcels too. |

### V6.1 — retention ponds, in one paragraph
The "ProvWaterways Retention Ponds are trusted" exemption was keyed to a source
holding **2 polygons province-wide** (that layer is flood-control infrastructure,
not municipal stormwater), so it never fired. Fixed by rescuing small unnamed
NHN polygons inside StatCan population centres (Step 4d), adding an OSM Overpass
pond layer (Step 4e), and keying the trust exemption on `water_type` rather than
`source`. Result: **0 → 699** Retention Pond parcels.

The OSM filter is an **allowlist, not a blocklist** — a blocklist leaked
`water=river` and would have written "Seine River" into the output tagged
Retention Pond. Guards: name exclusions, Polsby-Popper compactness ≥ 0.15 (which
catches *unnamed* river reaches no regex can), and a 1,000 m² floor.

---

## 5. V6.2 — the containing-parcel fallback (READ THIS BEFORE TOUCHING IT)

**The bug:** at Kingsley Gate, Niverville, 14 (closer to the pond) came out
"Corridor Blocked" while 15 (further) came out waterfront. Exactly inverted.

**The cause:** the pond sits *inside* Hampton Lakes, a 15.63-acre common amenity
parcel that every lot abuts. The corridor check cannot resolve that — the common
parcel blocks *every* corridor by construction, so the verdict fell to whether a
side neighbour also happened to graze a 2 m-wide line. Lot-shape noise deciding
a valuation question.

Two hypotheses tested and **disproved** — do not retry them:
- Giving each corridor origin its own nearest water point: no change.
- Per-parcel gap-finding (split at the largest gap among lots ringing the pond):
  at Kingsley the largest gap is 20.5 → 33.6 m, which makes 15 waterfront. Worse.

**The fix:** when the nearest water sits inside a parcel the subject abuts, skip
the corridor and decide on boundary distance. Treats the common parcel like the
Crown road allowance the algorithm already tolerates.

### The threshold and its calibration

```r
AMENITY_FRONTAGE_FT   <- 64          # 1CombineMBFiles.R
AMENITY_FRONTAGE_DIST <- AMENITY_FRONTAGE_FT / FT_PER_M
```

Ground truth, all ten Kingsley Gate lots (a **cul-de-sac running into the pond
area** — NOT a street with one waterfront side; that inference was wrong):

```
waterfront  16:38ft  18:39  20:45  14:51  21:53  19:55  17:60
near water  15:67ft  12:110  11:114
```

The cut must lie in **(60, 67) ft**. 64 ft sits near the middle. **10 of 10
correct.**

**This is one subdivision.** Amenity-strip widths and pond setbacks are
developer choices, not a standard, so this will not be right everywhere. That is
why `WaterDistanceFt` ships — a borderline parcel shows its measurement so an
appraiser can adjudicate rather than trust a verdict. Recalibrating against a
second community means sorting by distance and reading the separation.

**Margin matters more than precision.** The 2026-08-04 fabric refresh moved the
same lots by up to 4 ft. An earlier 16 m (52 ft) cut left a confirmed lot passing
by 0.4 m — one refresh from flipping.

**Units:** geometry stays metric (CRS is UTM 14N, `st_distance` returns metres).
The conversion to feet happens once, on the way out. Do not scatter it.

---

## 6. Scheduling (new, 2026-08-04)

mao-assembly had **no refresh path** for its provincial inputs. They were found
two months stale while the pipeline was being run as though current. Now:

| Task | Cadence | Script |
|---|---|---|
| `mao-assembly-monthly-refresh` | 4-weekly, Sun 03:00 | `refresh-monthly-wrapper.ps1` |
| `mao-assembly-annual-refresh` | 52-weekly, Sun 04:30 | `refresh-annual-wrapper.ps1` |
| `mao-assembly-input-staleness` | daily 07:15 | `input-staleness-check.ps1` |

Registered by `schedule_refresh.ps1`. The watchdog reuses mb-parcelsearch's
`alert-lib.ps1` + `alert-email.local.txt` rather than duplicating SMTP creds.

It checks input ages against cadence **and** whether the parquet is older than
the inputs feeding it — the case where the refresh worked and the rebuild never
happened, which looks current from either end alone.

**Gotcha:** scheduled `.ps1` files must be **ASCII-only**. A non-ASCII byte in a
BOM-less UTF-8 file mojibakes under PowerShell 5.1 and fails the whole file
before anything runs, so the task "succeeds" having done nothing. Verify with
`[Parser]::ParseFile` under **both** pwsh and powershell.exe.

**Caches expire, or refreshes are theatre.** `prepare_water_data.R` and
`prepare_road_data.R` both reuse cached downloads indefinitely. OSM now has a
30-day TTL (`OSM_CACHE_MAX_AGE_DAYS`); NHN / StatCan / NRN caches are cleared by
the annual task. Without that a scheduled run serves stale data and reports
success.

---

## 7. TODO

### Immediate — finish the current cycle
1. ~~Validate against Kingsley Gate.~~ **DONE 2026-08-04 — 10 of 10 correct.**
   `MAOParcelOutput20260804.parquet` (69.3 min run, 438,041 parcels).
   Waterfront: 14, 16, 17, 18, 19, 20, 21. Near water: 11, 12, 15. Matches the
   ground truth in §5 exactly. Province-wide effect:

   | | V6.1 (08-03) | V6.2 (08-04) |
   |---|---|---|
   | WaterInfluence = Yes | 54,216 | **54,427** |
   | Retention Pond parcels | 699 | **1,224** |
   | Changed verdict | — | 457 (311 No→Yes, 146 Yes→No) of 437,671 matched |

   Flips concentrate in subdivision municipalities — Tache 34, West St Paul 32,
   Niverville 29, Macdonald 22, Steinbach 16 — which is where the
   pond-in-a-common-parcel layout occurs. Nothing anomalous.

   **Watch the Retention Pond jump.** 699 → 772 at a 52 ft threshold →
   **1,224** at 64 ft. That is +452 for 12 ft of widening, far from linear:
   ponds sit in dense subdivisions, so each extra foot picks up whole
   additional rings of lots. It is the expected shape, but it means the
   threshold is a high-leverage number and a second community's calibration
   could move the province-wide count a lot. Re-check the total after any
   retune.
2. ~~Rebuild shards.~~ **DONE 2026-08-04** — 180 shards, 5.41 MB, 54,427
   Yes, every shipped row carries `d` (whole feet).
3. ~~Publish.~~ **DONE 2026-08-04** — `mb-parcel-data` @ `c390d65e`, revision
   bumped, CDN fetch verified in-app. The ~187 modified `assessment/*.json`
   (an unrelated rebuild predating this work) remain uncommitted there.
4. ~~Commit the mao-assembly V6.2 + scheduling changes.~~ **DONE 2026-08-04**
   — `191daf1` (V6.2) and `8e3a4bb` (scheduling), pushed.

### Known gaps
- ~~Ag parquet not regenerated.~~ **DONE 2026-08-04** —
  `MAOParcelOutputAg20260804.parquet` (steps 1–2 in 40.5 min, step 3 in
  12.4 min after installing the missing `FNN` package, lost in the
  R 4.6.1 upgrade). Landcover shards rebuilt and published @ `627ac00a`.
  The water shards rebuilt byte-identical from the rerun parquet —
  pipeline confirmed deterministic.
- **Duplicate pond geometry.** Kingsley's pond appears twice — NHN "Unnamed
  Lake" (6.83 ac) and OSM "Retention Pond" (6.23 ac). Centroid dedupe missed it
  because the outlines are offset. Consider an overlap-area dedupe.
- **NHN ponds are typed "Lake", not "Retention Pond".** Where NHN already
  carried a pond above the 10,000 m² floor, the Step 4d rescue never touched it,
  so the column reads "Unnamed Lake" for what is really stormwater.
- **Population centres are the 2021 census file.** A subdivision built since
  then may fall outside the urban gate and have its pond filtered out entirely.
  Worth checking Niverville and Steinbach.
- **mao-assembly independence.** `build_water.R` still reads mao-assembly's
  parquet. `MB_WATER_PARQUET_DIR` makes repointing one line, but porting the
  ~500-line detection is its own task.
- **Winnipeg** — deliberately excluded, documented in
  `mao-assembly/docs/WINNIPEG-WATERFRONT-PORT.md`. 200 Winnipeg ponds are
  already in the layer awaiting a parcel fabric. Do not "optimize" them out.

---

## 8. UI decisions, so they are not silently reversed

- **The Water Influence overlay is OFF by default and stays off.** An earlier
  version auto-armed it whenever a filter was ticked, because the button was
  then buried in the collapsed Agricultural group. That was solved properly by
  moving the button into **Parcel layers** with both filters directly beneath
  it. If "I filtered but the map is still yellow" ever returns, fix
  discoverability — do not re-arm. (`setMapData` re-asserts visibility from
  `waterOverlayOn`, so a one-line flag flip would bring it back, and take the
  user's choice away again.)
- **Waterfront only / Near water share one row** — `.overlay-check-half` in
  `style.css`. They are two halves of one question.
- **Palette is one blue ramp, dark = strongest influence.** Frontage takes the
  dark half, near-water the light half. Rejected: amber (read as a warning for
  a desirable second-row lot), teal (split by hue, carried no sense of degree),
  pale blue-grey (vanished under the yellow fill — since fixed, see below).
- **The yellow `parcel-fill` is suppressed to opacity 0 while the overlay is
  on.** `water-fill` paints at 0.7 over `#ffea00`, so the yellow tinted every
  water colour. Opacity, **not** visibility: `parcel-fill` is the hit-test layer
  for parcel hover/click, and `visibility: none` kills the popups.
- **Three cell states, kept distinct:** blank = shard not loaded; "No water" =
  checked, nothing within 164 ft; name + dot = classified. The `_waterLoaded`
  flag exists for exactly this, and the filters gate on it so an unreachable CDN
  cannot silently empty the grid.
- **The filters re-run the search, they do not view-filter.** The roll
  pre-filter constrains the query, so the rows in hand belong to the previous
  filter state; a view filter can only narrow what was fetched. Debounced 250 ms
  because switching filters fires two change events.

---

## 9. Verification checklist

1. `cd web && node test/run.js` — 45 files, includes `water.test.js`
2. `npx vite build` — exit 0
3. Search `WINNIPEG BEACH (TOWN)` + **Waterfront only** → 69 rolls, all blues
4. Switch to **Near water** → 82 rolls, all pale blues
5. Tick both → 151
6. `NIVERVILLE (TOWN)` + Waterfront only → 378 (this is the pre-filter working;
   as a post-filter it returned 1 of 378)
7. Kingsley Gate: 14 → Yes, 15 → No, and the other eight per §5
8. Import a sales CSV → water values match the shard; filters narrow correctly
9. Toggle **Water Influence** → parcels paint blue, not yellow

**Preview caveat:** the Browser-pane map is intermittently unable to finish
loading its style (`layerCount: 0`). When that happens verify via the JS console
(`window._map`, layer visibility, `getSource('parcels')._data`) and the grid DOM
rather than pixels. It does often work — try a screenshot first.
