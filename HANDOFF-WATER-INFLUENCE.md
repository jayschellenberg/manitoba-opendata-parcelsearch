# Water Influence (waterfront / near-water)

Trimmed 2026-08-19. This was a running handoff that accumulated the full
build narrative for V6.1–V6.3 — publish logs, A/B diff tables, bug
post-mortems, and TODO lists that were struck through as they completed. All
of that is in git history (`HANDOFF-WATER-INFLUENCE.md` before 2026-08-19).

What remains is only what still governs the code or is still outstanding.

The feature spans **three repos**, so read the map first. Operator procedures
live in [MAINTENANCE.md](MAINTENANCE.md).

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
| `D:\Dropbox\ClaudeCode\MBOpenData\mao-assembly` | **Detection.** Builds the water layer and classifies every parcel. |
| `D:\Dropbox\ClaudeCode\MBOpenData\mb-parcel-data` | **Published shards.** Data only, served via raw.githubusercontent pinned to a commit SHA (see MAINTENANCE.md §1b). |
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

**Read the published revision from the code, never from this file.**
`MB_PARCEL_DATA_REVISION` in `web/src/arcgis.js` is the truth. The last water
publish recorded here was V6.3 at `mb-parcel-data@3385466f` (2026-08-11), but
later publishes of other shard types have moved the pin since, which is exactly
why a SHA written into prose goes stale.

Publish with `update-cdn-pin.ps1` — it commits and pushes the data repo, reads
back the new HEAD, and rewrites the pin in one shot. Water AND landcover cache
keys include `MB_PARCEL_DATA_REVISION`; they once did not, so a revision bump
would not invalidate cached shards for up to the 30-day TTL. Keep it that way.

---

## 3. Rules the detector enforces — do not reverse these

### The amenity-frontage threshold

```r
AMENITY_FRONTAGE_FT   <- 64          # 1CombineMBFiles.R
AMENITY_FRONTAGE_DIST <- AMENITY_FRONTAGE_FT / FT_PER_M
```

When the nearest water sits inside a parcel the subject abuts, skip the corridor
check and decide on boundary distance. This treats a common amenity parcel like
the Crown road allowance the algorithm already tolerates — without it, a pond
inside a common parcel blocks *every* corridor by construction, and the verdict
falls to whether a side neighbour happens to graze a 2 m-wide line.

Calibrated on all ten Kingsley Gate lots, Niverville (a **cul-de-sac running
into the pond area** — NOT a street with one waterfront side; that inference was
wrong):

```
waterfront  16:38ft  18:39  20:45  14:51  21:53  19:55  17:60
near water  15:67ft  12:110  11:114
```

The cut must lie in **(60, 67) ft**. 64 ft sits near the middle, 10 of 10
correct.

**This is one subdivision.** Amenity-strip widths and pond setbacks are
developer choices, not a standard, so this will not be right everywhere. That is
why `WaterDistanceFt` ships — a borderline parcel shows its measurement so an
appraiser can adjudicate rather than trust a verdict. Recalibrating against a
second community means sorting by distance and reading the separation. V6.3 made
the threshold **binding in more places** (where the water has a holder the
subject abuts, a clear corridor can no longer rescue a parcel beyond 64 ft), so
retuning it against a second community matters more than it used to.

**Margin matters more than precision.** A fabric refresh moved the same lots by
up to 4 ft. An earlier 16 m (52 ft) cut left a confirmed lot passing by 0.4 m —
one refresh from flipping.

**Units:** geometry stays metric (CRS is UTM 14N, `st_distance` returns metres).
The conversion to feet happens once, on the way out. Do not scatter it.

### The phantom-polygon drop rule

A polygon that lies on platted house lots is not evidence of water; the roll is
the more current source. Drop rule: **≥70% on parcels ≤0.5 ac, spread over ≥3 of
them, no parcel holding ≥90% of it, ≤20 acres.**

Only 11 polygons province-wide reach 25% on house lots — a small, fully
enumerable population, not a sampled estimate. `results/water_phantom_review.csv`
lists the drops plus anything kept for review, for a human rather than a guess.

Shoreline erosion risk was measured, not assumed: of 5,479 **named** polygons
exactly one reaches 25% on small lots (a 194 m² Boyne River fragment); of 4,208
polygons over 20 acres, one. Nothing named or large is near the rule.

**Do not scope any future water-quality rule to `water_type == "Retention Pond"`.**
Where NHN already carried a pond above the 10,000 m² floor, the rescue step never
touched it, so the column reads "Unnamed Lake" for what is really stormwater.
This is the same mistake as the original `source == "ProvWaterways"` exemption,
which was keyed to a layer holding 2 polygons province-wide and therefore never
fired at all.

### Approaches tested and rejected — do not retry

- **Giving each corridor origin its own nearest water point.** No change.
- **Per-parcel gap-finding** (split at the largest gap among lots ringing the
  pond). At Kingsley the largest gap is 20.5 → 33.6 m, which makes lot 15
  waterfront. Worse.
- **Clipping the polygon by the lots it overlaps.** Tried and reverted: at
  Balgownie Dr the lot lines are digitized *into* a real pond, and the clip
  carved a strip of open water out along a lot boundary. Eroding real water is
  worse than leaving an ambiguous polygon alone.
- **The adjacency heuristic** ("flanked by two waterfront parcels ⇒ probably
  waterfront"). At Kingsley Gate it would promote lots 15 (67 ft) and 12
  (110 ft), both ground-truth **No**, breaking the 10-of-10 on the only fully
  ground-truthed set available. What it still flags clusters at 65–81 ft, just
  past the threshold — it is detecting threshold sensitivity, not an absent
  mechanism. Keep it as a **diagnostic** for finding neighbourhoods worth
  reviewing, and as the right instrument for deciding whether 64 ft should be
  retuned. Do not wire it into the classifier.

### Measurement traps

- **Measure on the parcel's NEAREST feature.** Measuring distance to any
  newly-held polygon over-counts by ~9x, because it catches parcels whose real
  nearest water is a different, closer polygon.
- **Read parcel geometry from `inputs/MBRollGeoPackage.gpkg`, not from the
  parquet's `geometry_wkt`.** The WGS84 WKT round-trip shifts boundaries by a
  few decimetres — enough to move a parcel across the 10 m cliff and make a
  replay disagree with production (827 Turnberry: 9.6 m via WKT vs 10.06 m real).

---

## 4. Refreshing the inputs

| Task | Cadence | Script |
|---|---|---|
| `mao-assembly-monthly-refresh` | 4-weekly, Sun 03:00 | `refresh-monthly-wrapper.ps1` |
| `mao-assembly-annual-refresh` | 52-weekly, Sun 04:30 | `refresh-annual-wrapper.ps1` |
| `mao-assembly-input-staleness` | daily 07:15 | `input-staleness-check.ps1` |

Registered by `schedule_refresh.ps1`. The watchdog reuses mb-parcelsearch's
`alert-lib.ps1` + `alert-email.local.txt` rather than duplicating SMTP creds. It
checks input ages against cadence **and** whether the parquet is older than the
inputs feeding it — the case where the refresh worked and the rebuild never
happened, which looks current from either end alone. It also checks
`LastTaskResult`, because it previously checked file *ages* only and reported
"all inputs current" while both refresh tasks were failing every time.

**Start refreshes via the SCHEDULER, not by running the .ps1 directly:**

```
powershell -NoProfile -Command "Start-ScheduledTask -TaskName 'mao-assembly-monthly-refresh'"
```

Running the wrapper by hand refreshes the inputs but leaves `LastTaskResult` at
its old value, so the watchdog keeps alerting until the task next fires on its
own. Starting the task updates the result code and exercises the actual Task
Scheduler context — which is the context that broke.

Standing hazards, each of which produced a task that "succeeded" having done
nothing:

- **Do not rename `$ScriptArgs` back to `$Args` in the wrappers.** `$Args` is a
  PowerShell automatic variable; the binder silently discards the caller's value
  and the function sees an empty array, so Rscript launches with no script at
  all.
- **Scheduled `.ps1` files must be ASCII-only.** A non-ASCII byte in a BOM-less
  UTF-8 file mojibakes under PowerShell 5.1 and fails the whole file before
  anything runs. Verify with `[Parser]::ParseFile` under **both** pwsh and
  powershell.exe.
- **R's `message()` goes to stderr.** Under `$ErrorActionPreference = 'Stop'`
  PowerShell turns native-command stderr into a *terminating* error, so the
  first ordinary progress line kills the step. The wrappers drop to `'Continue'`
  for the native call only and gate on `$LASTEXITCODE`;
  `$PSNativeCommandUseErrorActionPreference = $false` covers PS7's separate
  route to the same failure.
- **Assert the artifact, not the exit code.** An exit code says what the script
  *believed*; `Assert-Snapshot` requires `<Layer>_<today>.gpkg` to exist, and
  cannot be fooled by a script that exits 0 wrongly.
- **Caches expire, or refreshes are theatre.** `prepare_water_data.R` and
  `prepare_road_data.R` both reuse cached downloads indefinitely. OSM has a
  30-day TTL (`OSM_CACHE_MAX_AGE_DAYS`); NHN / StatCan / NRN caches are cleared
  by the annual task.
- **R upgrades can silently break the pipeline.** An ag run once died at
  `library(FNN)` — the package was lost in an R upgrade. After upgrading R,
  check the pipeline's packages load before the next scheduled window (FNN,
  arrow, dplyr, sf, stringr, terra, tidyr for step 3 alone).
- **Dropbox locks logs.** Logs live under `D:\Dropbox` and Dropbox opens files
  it has just seen. `Write-Log` retries with backoff. See MAINTENANCE.md for the
  Dropbox-ignore option if a wrapper ever trips on it.

### Outstanding

- **Neither refresh task has ever completed a scheduled run.** Both
  `mao-assembly-monthly-refresh` and `mao-assembly-annual-refresh` still report
  `LastTaskResult = 267011` (never run) as of 2026-08-19. The 2026-08-11 fixes
  were integration-tested against the real wrapper files with a stub Rscript,
  but no real scheduled fire has yet proven them. Monthly next fires
  **2026-09-06**; annual not until **2027-08-08**. Watch the September run.
- **The annual inputs did not refresh in 2026** — soil / MASC / NHN / NRN. They
  were inside the 400-day limit as of August 2026, so nothing was stale yet, but
  this needs one manual start rather than waiting for 2027-08-08.

---

## 5. Known gaps

- **Duplicate pond geometry.** Kingsley's pond appears twice — NHN "Unnamed
  Lake" (6.83 ac) and OSM "Retention Pond" (6.23 ac). Centroid dedupe missed it
  because the outlines are offset. Consider an overlap-area dedupe.
- **The OSM compactness guard is too loose.** Polsby-Popper ≥ 0.15 was meant to
  catch unnamed river reaches. Long thin rear-yard drainage swales score ≈ 0.28
  and sail through. Worth revisiting in `prepare_water_data.R` Step 4e — the
  fabric check catches them downstream, but keeping them out of the layer would
  be cleaner.
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

## 6. UI decisions, so they are not silently reversed

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
  pale blue-grey (vanished under the yellow fill).
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

## 7. Verification checklist

1. `cd web && node test/run.js` — includes `water.test.js`
2. `npx vite build` — exit 0
3. Search `WINNIPEG BEACH (TOWN)` + **Waterfront only** → all blues
4. Switch to **Near water** → all pale blues
5. Tick both
6. `NIVERVILLE (TOWN)` + Waterfront only (this exercises the pre-filter; as a
   post-filter it returned 1 of 378)
7. Kingsley Gate: 14 → Yes, 15 → No, and the other eight per §3
8. Import a sales CSV → water values match the shard; filters narrow correctly
9. Toggle **Water Influence** → parcels paint blue, not yellow

**The counts are deliberately not written here.** The previous version recorded
378 for Niverville where the parquet said 401 under V6.2, and V6.3 moved
Niverville to 328 — the app and the parquet do not count the same population
(shards ship only non-`None` parcels and are keyed on `Roll_No_Txt`). Re-measure
in the app after publishing and record the numbers in the PR, not in this file.
Working out where the app/parquet gap comes from is still open.

**Preview caveat:** the Browser-pane map is intermittently unable to finish
loading its style (`layerCount: 0`, "Style is not done loading"). When that
happens verify via the JS console (`window._map`, layer visibility,
`getSource('parcels')._data`) and the grid DOM rather than pixels. Note that
map-dependent passes stay inert in that state, so grid columns fed by them can
read empty without anything being wrong. It does often work — try a screenshot
first.
