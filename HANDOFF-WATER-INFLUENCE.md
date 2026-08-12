# Handoff — Water Influence (waterfront / near-water)

Last updated: 2026-08-11

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

## 3. Published state (as at 2026-08-04)

> **This is still what the app serves.** V6.3 (§5A) is implemented, run and
> verified locally as of 2026-08-11 but **not published** — no new shards, no
> `mb-parcel-data` commit, no revision bump. §5B covers the scheduled input
> refreshes, which were found to have been failing silently.

**Published and live:**
- `mb-parcel-data` @ `627ac00a` — 180 water shards (V6.2, per-parcel `d`
  distances, from `MAOParcelOutput20260804.parquet`) **and** 182 landcover
  shards (from the regenerated `MAOParcelOutputAg20260804.parquet`). Both
  verified fetched from that revision in-app.
- `mb-parcelsearch` — app pinned to that revision. Water AND landcover cache
  keys now include `MB_PARCEL_DATA_REVISION` (they previously did not, so a
  revision bump would NOT have invalidated cached shards for up to the
  30-day TTL).

**Repo move COMPLETE (2026-08-04).** mao-assembly physically moved from
`D:\Dropbox\Appraisal\RProjects\appraisal-templates\mao-assembly` to
`D:\Dropbox\ClaudeCode\MBOpenData\mao-assembly`; the old location is deleted.
Same git repo throughout (github.com/jayschellenberg/mao-assembly). Done with
the move:
- `cache/` (3.3 GB of NHN/StatCan/OSM downloads) deliberately discarded —
  the scheduled refreshes re-download it. First post-move
  `prepare_water_data.R` run will be slow; that is expected, not a bug.
- The three scheduled tasks re-registered against the new wrappers
  (verified via their task actions), see §6.
- Path references updated everywhere: `r/config.R` `mao_assembly_root`
  (mb-parcelsearch `fa9f4e5`), the four mao-assembly `.ps1` wrappers
  (`3ec52a3`), and the two live consumers in the appraisal-templates repo —
  `base-files/build-civic-addresses.R`, `mao-land/MAOLandV2_1.R` (`348445c`).

**Committed and pushed** (mb-parcelsearch main): water column, both filters,
roll pre-filter, map overlay, blue ramp, sidebar regrouping, `water.test.js`,
the `WaterDistanceFt` surfacing (cell text "body · N ft", tooltip line,
distance tie-break in sorting), the Water columns in the CSV export
(`468040f`), and Route Starred (`68c23b5` — one-click driving route through
starred comps, auto-started at the most outlying one).

**Committed and pushed** (mao-assembly main): `2df49c6` V6.1 retention ponds,
`191daf1` V6.2 containing-parcel fallback + WaterDistanceFt, `8e3a4bb`
scheduled input refresh + staleness watchdog + OSM cache TTL, `3ec52a3`
new-location paths.

---

## 4. Algorithm history

| Version | Change |
|---|---|
| V6 | Baseline, validated 100% on a 46-parcel set. Boundary distance + multi-point corridor. |
| **V6.1** | **Residential retention ponds.** Was producing ZERO. Details in `mao-assembly/docs/waterfront_detection_methodology.md`. |
| **V6.2** | **Containing-parcel fallback** (§5) + `WaterDistanceFt` + water body recorded for near-water parcels too. |
| **V6.3** | **Reconcile the water layer against the parcel fabric** (§5A). Fixes both reported error directions. **Code changed, not yet run.** |

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

## 5A. V6.3 — the water layer is not self-evidently right (2026-08-11)

**Status: implemented, run, and verified against the V6.2 baseline.**
`results/MAOParcelOutput20260811.parquet` (82.2 min, exit 0) — and a copy kept
as `MAOParcelOutput20260811-v63-aug4inputs.parquet`, because that run used the
**same Aug 4 inputs** as the baseline, so it is the controlled A/B and a later
same-day rebuild would otherwise overwrite it. The suffixed name is invisible to
`build_water.R`, whose glob is anchored `^MAOParcelOutput\d{8}\.parquet$`.

**Rebuilt again on fully refreshed inputs** (2026-08-11 18:37, 77.6 min) —
`MAOParcelOutput20260811.parquet` is now the current build, from parcels/zoning/
dev-plan refreshed at 16:26, a water layer rebuilt from freshly-downloaded NHN at
16:40, and NRN roads at 17:18. **This is the one to shard and publish.**

Diffed against the Aug-4-inputs build, where V6.3 is constant so every
difference is the input refresh alone:

| | V6.3 / Aug 4 inputs | V6.3 / Aug 11 inputs |
|---|---|---|
| parcels | 438,041 | 438,061 (33 added, 13 removed) |
| **class changes among the 438,028 common parcels** | — | **0** |
| Yes/No flips among common parcels | — | **0** |
| WaterInfluence Yes | 54,356 | 54,358 (+2, both new parcels) |
| in-play polygons / with a holder | 12,657 / 4,668 | **12,657 / 4,668** |
| phantom review | 5 DROPPED / 3 review | **identical** |
| Kingsley Gate | 10/10 | **10/10** |
| boundary distance unchanged | — | 67,548 of 67,554 (99.99%) |

Both new waterfront parcels are rural `Direct` on named water (Ditch Lake,
Spring Brook). Six parcels' boundary distances moved (max 32 ft, all rural,
none changed class). A week of registrations is ~20 parcels of which ~2 touch
water — so the 4-weekly refresh cadence has plenty of headroom.

Notable stability results, both worth keeping in mind before anyone retunes:
NHN was re-downloaded from source rather than served from cache and produced the
**same 12,657 in-play polygons**; and StatCan's NRN is still edition
`NRN_MB_6_0`, byte-identical to the April download, so "roads are 4 months old"
was release cadence, not staleness.

**NOT YET PUBLISHED** — no new shards, no `mb-parcel-data` commit, no revision
bump. Everything the app serves is still V6.2.

Verified vs prediction:

| | predicted | actual |
|---|---|---|
| WaterInfluence Yes | 54,427 → 54,356 | **54,356** |
| No → Yes | 77 | 76 |
| Yes → No | 148 | 147 |
| Kingsley Gate | 10/10 | **10/10** |
| phantom report | 5 DROPPED / 3 review | **5 / 3** |
| in-play polygons with a holder | 2,458 → ~4,664 | 2,458 → **4,668** |

Net matched exactly; each direction is one parcel off, which is the residual
error in a pre-run estimate built from independent geometry rather than from the
classifier. Municipality splits matched: No→Yes Niverville 19, East St Paul 14,
Tache 9, Selkirk 7; Yes→No Niverville 92, Springfield 28, Stonewall 18,
Ritchot 6, Selkirk 3.

Two rolls were reported, one wrong in each direction. They look like opposite
problems and are the same root cause: **V6.2 took the water layer at face value
and asked the parcel fabric only a yes/no `st_within()` question.**

| Roll | Address | V6.2 | Truth | V6.3 |
|---|---|---|---|---|
| 44820.488 | 829 Turnberry Cove, Niverville | No · Corridor Blocked · 35 ft | waterfront | **Yes · Reserve Separated · 35 ft** |
| 44832.220 | 42 Gullane St, Niverville | **Yes** · Waterfront · 114 ft | not near water | **None** |

### The miss: `st_within` is all-or-nothing

At Turnberry the pond is **93.3% inside** the 11.05-acre common amenity parcel
every lot abuts, spilling 1,337 m² onto the lots next door. `st_within()` says
FALSE, so `water_holder` is NA, so the V6.2 amenity fallback — the thing built
for exactly this layout — **never fires**. The corridor check then blocks every
lot by construction, because the common parcel wraps the water.

The tell is that the cliff is in the wrong place. Same street, same pond, same
amenity strip:

```
823 Turnberry  32 ft  Yes      827 Turnberry  33 ft  No
825 Turnberry  30 ft  Yes      829 Turnberry  35 ft  No
```

The break is at 33 ft — the 10 m `CORRIDOR_SKIP_DIST` — **not** the calibrated
64 ft `AMENITY_FRONTAGE_FT`. Under 10 m the corridor is skipped; over it the
fallback is silently unavailable. Sub-metre digitizing noise, deciding frontage.

Containment is now an area share, `HOLDER_MIN_FRAC = 0.90`. Province-wide
**2,211 in-play polygons are ≥90% inside one parcel yet fail `st_within()`**,
most of them over 99%. **77 Corridor-Blocked parcels become Reserve Separated**
— Niverville 19, East St Paul 14, Tache 9, Selkirk 7, then a long tail.

### The false positive: polygons lying on top of houses

42 Gullane St was called Waterfront off a 0.65-acre NHN "Retention Pond" with
**nine houses on it** — 86.9% of the polygon sits on 0.09-acre lots, eating
33–86% of each. Retention Ponds skip corroboration *and* the large-parcel
filter, so nothing else was ever going to catch it.

A polygon that lies on platted house lots is not evidence of water; the roll is
the more current source. Drop rule: **≥70% on parcels ≤0.5 ac, spread over ≥3 of
them, no parcel holding ≥90% of it, ≤20 acres.**

Only **11 polygons province-wide** reach 25% on house lots — this is a small,
fully enumerable population, not a sampled estimate. All five at ≥70% were
checked against imagery and none is water: two Springfield/Oakbank rear-yard
drainage swales tagged as ponds in OSM, a Stonewall slough with houses and a
street on it, and the two Niverville cases. **132 parcels lose false frontage**
(Niverville 88, Springfield 28, Stonewall 16). `results/water_phantom_review.csv`
gets 8 rows on the current inputs — the 5 `DROPPED` plus 3 `kept - review` — for
a human rather than a guess.

**DO NOT re-introduce clipping.** Clipping the polygon by the lots it overlaps
was tried and reverted: at Balgownie Dr the lot lines are digitized *into* a real
pond, and the clip carved a strip of open water out along a lot boundary.
Eroding real water is worse than leaving an ambiguous polygon alone.

Shoreline erosion risk was measured, not assumed: of 5,479 **named** polygons
exactly one reaches 25% on small lots (a 194 m² Boyne River fragment); of 4,208
polygons over 20 acres, one. Nothing named or large is near the rule.

### Validation

Confirmed in the real pipeline output (see the table above). Before the run, the
same four windows were checked with a local replay harness:

| Window | Result |
|---|---|
| **Kingsley Gate** | **10/10 still correct** — the V6.2 calibration set is intact |
| Niverville (Highlands) | 19 parcels recover frontage, 88 lose false frontage; both reported rolls now right |
| Oakbank (Springfield) | 28 parcels lose frontage off two OSM swales; window goes 28 Yes → 0 Yes |
| La Salle (Macdonald) | 1 parcel improves, nothing degrades |

The replay harness reproduces published V6.2 verdicts to the foot. One trap
worth knowing: **read parcel geometry from `inputs/MBRollGeoPackage.gpkg`, not
from the parquet's `geometry_wkt`.** The WGS84 WKT round-trip shifts boundaries
by a few decimetres — enough to move a parcel across the 10 m cliff and make a
replay disagree with production (827 Turnberry: 9.6 m via WKT vs 10.06 m real).

### Side effect to watch

Enabling the holder in more places makes `AMENITY_FRONTAGE_FT` **binding** in
more places: where the water has a holder the subject abuts, 64 ft now decides,
and a clear corridor can no longer rescue a parcel beyond it. **16 parcels go
Yes → No** on that account (Ritchot 6, Niverville 4, Selkirk 3, Stonewall 3),
including four Breckenridge Dr lots at 69–74 ft. Consistent with the Kingsley
calibration (the cut must lie in 60–67 ft) — but a threshold derived from **one
subdivision** now governs more parcels. Retuning it against a second community
matters more than it did.

**Measure this on the parcel's NEAREST feature.** Measuring distance to any
newly-held polygon over-counts by ~9x (145 vs 16) because it catches parcels
whose real nearest water is a different, closer polygon. That looser measure
wrongly implicated ground-truth-waterfront Kingsley Gate lots — all of whose
nearest ponds already pass `st_within` and are untouched here.

### The adjacency heuristic — tested, not adopted

"Flanked by two waterfront parcels ⇒ probably waterfront" was proposed as
corroborating evidence. Measured:

- It flags 37 parcels in the Niverville window. **The containment fix resolves 17
  of them** — they were the mechanism failing, not a missing signal.
- At Kingsley Gate it would promote **15 (67 ft) and 12 (110 ft)**, both
  ground-truth **No**. On the only fully ground-truthed set available it
  introduces errors and breaks the 10-of-10.
- What it still flags clusters at **65–81 ft**, just past the 64 ft threshold —
  it is detecting threshold sensitivity, not an absent mechanism.

Keep it as a **diagnostic** for finding neighbourhoods worth reviewing, and as
the right instrument for deciding whether 64 ft should be retuned. Do not wire
it into the classifier.

### What has to happen next

1. ~~Run `$1run_basic.R` and diff.~~ **DONE 2026-08-11** — see the table at the
   top of this section. The two new blocks cost ~8 min on a ~65 min run (phantom
   drop 1.5 min over 36,608 cropped polygons; fractional holder 6.3 min
   re-checking the 10,207 polygons `st_within` rejects). Detection 11.8 → 13.2 min.
2. ~~Check `results/water_phantom_review.csv`.~~ **DONE** — 5 DROPPED, 3
   "kept - review".
3. ~~Re-verify Kingsley Gate and the two reported rolls.~~ **DONE** — 10/10;
   829 Turnberry → Yes/Reserve Separated/35 ft, 42 Gullane → No/None.
4. **Rebuild on refreshed inputs before publishing.** The verified run used the
   Aug 4 inputs deliberately, so V6.3 was the only variable. Refresh the fabric
   (§6) and rebuild, so the app ships current parcels rather than a week-old
   fabric. Movement in that second rebuild is attributable to new parcels, not
   to V6.3.
5. Then rebuild shards (`mb-parcelsearch/r/build_water.R`), publish
   `mb-parcel-data`, bump `MB_PARCEL_DATA_REVISION`, redeploy — §9 checklist.

**Re-baseline the §9 counts from the APP, not from the parquet.** Parquet counts
for the V6.3 run: Winnipeg Beach **unchanged** at 69 waterfront / 82 near water /
151 both — a useful negative result, since that is the lakefront case and V6.3
leaves real shoreline alone. Niverville moves 401 → **328** waterfront and
113 → **87** near water. But §9 records **378** for Niverville where the parquet
says **401** under V6.2, so the app and the parquet are not counting the same
population (shards ship only non-`None` parcels and are keyed on `Roll_No_Txt`).
Do not paste parquet numbers into §9 — re-measure in the app after publishing,
and work out where the 378/401 gap comes from while you are there.

## 5B. The refresh tasks were silently doing nothing (found 2026-08-11)

**Both scheduled input refreshes had never done any work since being registered
on 2026-08-04.** They fired on 2026-08-09 and both exited 1. Three bugs — the
third is the one that made them permanently non-functional rather than just
unlucky:

1. **`$Args` is a PowerShell automatic variable.** `Invoke-Step` in both
   wrappers declared `param([string[]]$Args)`. That does not error — the binder
   silently discards the caller's `-Args` value and the function sees an EMPTY
   array, so `& $Rscript @Args` launched Rscript with **no script at all**. It
   printed its usage banner and exited non-zero. Renamed to `$ScriptArgs` in
   both wrappers, with a comment saying not to rename it back.
2. **Dropbox locks the log.** The monthly wrapper died on its *second* log line
   with "the process cannot access the file ... because it is being used by
   another process" — the logs live under `D:\Dropbox` and Dropbox opens files
   it has just seen in order to sync them. `Write-Log` now retries with backoff
   rather than relocating, since the operator, the watchdog stamp and this
   runbook all expect logs in that directory.
3. **R's `message()` goes to stderr, and stderr was fatal.** Under
   `$ErrorActionPreference = 'Stop'`, PowerShell turns native-command stderr into
   a **terminating** error, so the first ordinary progress line from any R script
   killed the step. Reproduced exactly: a two-line R script that `cat()`s, then
   `message()`s, then exits 0, throws with the message text as the exception.
   That is how the 2026-08-11 re-run "failed" — `refresh_provincial_inputs.R`
   printed `message("Parcels source: ", basename(src))` and the wrapper logged
   `FAILED: Parcels source: RollEntry_20260804.gpkg`, an informational line
   dressed up as a crash.

   Since essentially every script in the pipeline uses `message()` —
   `prepare_water_data.R` heavily — **these wrappers could never have completed,
   on any input, ever.** Fixed by dropping to `'Continue'` for the native call
   only; the explicit `$LASTEXITCODE` gate is what decides success, and it is
   stricter than stderr-sniffing. `$PSNativeCommandUseErrorActionPreference =
   $false` covers PS7's separate route to the same failure (no-op on 5.1) —
   `auto-publish-indexes.ps1` already had that guard; these did not.

**The watchdog could not see any of it.** It checked file *ages* — 45 days for
parcels — not exit codes, so with inputs 7 days old it reported "all inputs
current" every morning and would have stayed silent until roughly **Sep 18**.
`input-staleness-check.ps1` now also checks `LastTaskResult` on both tasks
(ignoring 267011 = never-run). Verified: it reports both failures and delivers
the alert.

**Start refreshes via the SCHEDULER, not by running the .ps1 directly:**

```
powershell -NoProfile -Command "Start-ScheduledTask -TaskName 'mao-assembly-monthly-refresh'"
```

Running the wrapper by hand refreshes the inputs but leaves `LastTaskResult` at
its old value, so the watchdog keeps alerting until the task next fires on its
own. Starting the task updates the result code and exercises the actual Task
Scheduler context — which is the context that broke.

**The annual task's next scheduled fire is 2027-08-08.** Its 2026 run failed, so
soil / MASC / NHN / NRN did not refresh this year. They are inside the 400-day
limit (Apr 2026), so nothing is stale yet, but it needs one manual start.

### A fourth silent failure, and the hardening (all fixed 2026-08-11)

On the 2026-08-11 run the RollEntry download died after 175 pages (~350k
features) on an HTTP/2 `PROTOCOL_ERROR` from services.arcgis.com. The script did
the right thing — refused to write a partial snapshot, said "re-run to retry" —
and then **exited 0**. With the stderr bug fixed, that run would have reported
COMPLETE while RollEntry silently stayed a week old, because
`refresh_provincial_inputs.R` takes the newest source it can find and has no
notion of "must be from today". Four changes:

1. **`download_parcels.R` exits non-zero on real failure.** Tracks failed layer
   names and `quit(status = 1)`. Only genuine failures count — `download_layer()`
   returns the path for both success and the benign same-day skip, and NULL only
   when it wrote nothing it meant to write, so a second same-day run or a
   `DOWNLOAD_ONLY` single-layer run still exits 0. Verified across all five paths.
2. **Page-level retry** in `download_parcels.R`. `req_retry(max_tries = 4)` is
   httr2's *per-request* retry and covers HTTP transients (429/503); the HTTP/2
   transport error came out of `curl::curl_fetch_memory()` and escaped it
   entirely. `fetch_page_resilient()` wraps the page in a coarser retry (3
   attempts, 2s/5s backoff) that re-issues the request from scratch. **NULL is
   end-of-data and is deliberately NOT retried** — retrying it would triple every
   layer's tail. Cost when the service is truly down is bounded: the page loop
   breaks on the first hard failure, so at most one page per layer exhausts its
   attempts (~7 s), not 7 s per page.
3. **The wrapper asserts the ARTIFACT, not the exit code.** `Assert-Snapshot`
   requires `<Layer>_<today>.gpkg` to exist for all three layers. An exit code
   says what the script *believed*; the file says what actually happened, and it
   cannot be fooled by a script that exits 0 wrongly.
4. **`-ContinueOnError` on download_parcels: continue but remember.** A flaky
   layer must not also cancel the adaptation and the water rebuild — on 2026-08-11
   zoning and dev-plan downloaded perfectly well while RollEntry failed. Failures
   are recorded in `$script:Failures`, the remaining steps still run, and the
   drain at the end decides the exit code. Loud without being destructive.

Integration-tested against the real wrapper file with a stub Rscript (only the
Rscript path and log dir substituted):

| Scenario | Result |
|---|---|
| all steps OK, stderr emitted throughout | COMPLETE, exit 0 — stderr no longer fatal |
| download fails, snapshots present | failure recorded, later steps still run, exit 1 |
| **download reports OK but wrote nothing** | **assertions catch it, exit 1** |

The third row is the one that matters: it is the 2026-08-11 failure mode, and
the exit code alone would have missed it.

**Watch out when testing `Assert-Snapshot`-style helpers.** The first version
returned `$true`/`$false` and was called as `[void](Assert-Snapshot ...)`.
`Write-Log` writes to the pipeline, so `[void]` discarded the function's own log
lines along with the boolean — the failure was recorded but said nothing. Same
class of defect as everything else in this section. Fixed by dropping the return
value; recording the failure *is* the output.

`mb-parcelsearch/auto-publish-indexes.ps1` (fires 2026-08-15) **has been fixed**
for the log-lock — `Log()` retries with backoff and the file is created and first
written inside that retry. It never had the `$Args` bug and already carried the
`$PSNativeCommandUseErrorActionPreference` guard. Its nine `*>> $log` append
redirections are still unprotected; they run well after creation, so the race has
passed by then. `semiannual-publish-wrapper.ps1` has the same `Add-Content`
pattern but runs under `'Continue'`, so a lock costs a log line rather than the
run — and it does not fire until 2027. See MAINTENANCE.md for the
Dropbox-ignore option if either ever trips.

## 6. Scheduling (new, 2026-08-04)

mao-assembly had **no refresh path** for its provincial inputs. They were found
two months stale while the pipeline was being run as though current. Now:

| Task | Cadence | Script |
|---|---|---|
| `mao-assembly-monthly-refresh` | 4-weekly, Sun 03:00 | `refresh-monthly-wrapper.ps1` |
| `mao-assembly-annual-refresh` | 52-weekly, Sun 04:30 | `refresh-annual-wrapper.ps1` |
| `mao-assembly-input-staleness` | daily 07:15 | `input-staleness-check.ps1` |

Registered by `schedule_refresh.ps1`. Re-registered 2026-08-04 after the repo
move — all three task actions verified pointing at the wrappers in
`D:\Dropbox\ClaudeCode\MBOpenData\mao-assembly`. The watchdog reuses
mb-parcelsearch's `alert-lib.ps1` + `alert-email.local.txt` rather than
duplicating SMTP creds.

**R upgrades can silently break the pipeline.** The 2026-08-04 ag run died at
step 3's `library(FNN)` — the package was lost in the R 4.6.1 upgrade. A
scheduled run would have failed the same way. After upgrading R, check the
pipeline's packages load before the next scheduled window (FNN, arrow, dplyr,
sf, stringr, terra, tidyr for step 3 alone).

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
  so the column reads "Unnamed Lake" for what is really stormwater. Two of the
  five V6.3 drops are typed Lake for this reason — so **do not scope any future
  water-quality rule to `water_type == "Retention Pond"`.** That is the same
  mistake as the V6.1 `source == "ProvWaterways"` exemption that never fired.
- **The OSM compactness guard is too loose.** Polsby-Popper ≥ 0.15 was meant to
  catch unnamed river reaches. Both Oakbank drops are long thin rear-yard
  drainage swales that score ≈ 0.28 and sail through. Worth revisiting in
  `prepare_water_data.R` Step 4e — the fabric check now catches them downstream,
  but keeping them out of the layer would be cleaner.
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
