# How "new multi-family" and "new condos" are determined

Written 2026-09-15, for porting the two layers into the Winnipeg project
(`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`). Self-contained by
design: drop this file into a fresh session opened in the target repo,
per the porting convention in `docs/archive/WINNIPEG_HISTORICAL_PORT.md`.

Source repo: `D:\Dropbox\ClaudeCode\MBOpenData\mb-parcelsearch`. Paths
below are relative to it unless marked otherwise.

There are **three** layers, built by **two** scripts:

| Layer | Button | Built by | Shard |
|---|---|---|---|
| Standing multi-family inventory | **Multi-Family** | `r/build_mf_newbuild.R` | `mf-inventory/<MUNI>.json` |
| New multi-family construction | **New Multi-Family** | `r/build_mf_newbuild.R` | `mf-newbuild/<MUNI>.json` |
| New condo developments | **New Condos** | `r/build_condo_dev.R` | `condo-dev/<MUNI>.json` |

The inventory and the new-build layer ship from one script on purpose:
they are the same population at different times, and two scripts would
be two places for the unit threshold and the farm exclusion to drift.

**Read §4 before porting.** Most of what follows is a workaround for
things MAO does not publish and Winnipeg does. The method is worth
understanding; roughly half of it should not be copied.

---

## 1. The problem both layers solve

MAO publishes **no building permits and no construction dates**. There
is no field anywhere in the scrape that says "this was built in 2021".
What there *is*:

- `tax_history` — per roll, per tax year (2008-2027): land, buildings,
  total, property class, and the **assessment reference date** the
  values were struck at.
- `parcels` — one current row per roll: `dwelling_units` (a **current
  scalar**, no history), civic address, legal description, class.
- the sales PDF archive — `dwelling_units` **at the date of sale**, back
  to 1996, for rolls that sold.
- the authenticated sales search — MAO's own **Primary Property**
  structure descriptor ("ROW HSG", "APT"), for rolls that sold.

So construction has to be inferred from the value series, and the unit
count that filters it is only ever today's count.

---

## 2. New multi-family — `r/build_mf_newbuild.R`

### 2.1 The biennium trick

Manitoba reassesses on a two-year cycle, and within a biennium the
assessed value is **frozen by statute**. Measured on this dataset
(Residential 2 rolls, 2008-2027):

| year-over-year pair | building value changed |
|---|---|
| across a reassessment boundary | **99.8%** |
| within a biennium (same reference date) | **7.9%** |

A within-biennium jump in building value is therefore a near-pure
**physical**-change signal: new construction, a major addition, or a
demolition. Across a boundary every roll moves, so a raw jump means
nothing there until it is normalised.

The biennium map is derived from the data
(`tax_year` → `assessment_reference_date`), never hardcoded — 2020-2022
is a three-year cycle because the reassessment was deferred, and the
province will shift the cycle again.

### 2.2 The revaluation factor

For boundary years, the general revaluation factor is the **median**
`b[y] / b[y-1]` over improved rolls — median so the few that genuinely
changed cannot drag it. Keyed on **municipality × dominant class**,
because the classes do not move together: in 2025 Residential 1 revalued
at 1.142 province-wide while Residential 2 revalued at 1.036. A blended
factor sets the apartment bar ten points too high and silently drops
real expansions.

Computed on the **full** parcel set, not the multi-family subset (a
municipality can have too few blocks for a stable median), with the
fallback chain muni×class → province×class → province blended → 1.0, and
a minimum of 30 rolls before a factor is trusted over the next one up.

### 2.3 The three event shapes

Detection runs at the **roll** level across **all** property classes,
never within Residential 2. Requiring R2 in both years finds two events
province-wide, because new blocks arrive as new rolls or reclassify into
R2 in the same year the building appears. (Selkirk's 1027 Manitoba Ave:
OTHER PROPERTY at $163,900 through 2016, then $16.9M as RESIDENTIAL 2 in
2017.)

| Shape | Test |
|---|---|
| `appeared` | prior year ≤ $10,000 **or** ≤ 5% of what landed, and the new value ≥ `MIN_BUILDING` ($150,000) |
| `expanded` | `(b / b_prev) / factor ≥ 1.5`, the gain ≥ $100,000, and `b ≥ MIN_BUILDING` |
| `new_roll` | the roll's first year in the archive is after the archive starts (2008) and it is already improved |

**Every** qualifying event on a roll is emitted, not just one — a roll
with a 2017 build and a 2024 phase two has two real buildings, and
collapsing to one year discards one. The **primary** event (largest
value gain) is what the map colours and ranks by.

### 2.4 Confidence, which is published per event

| | when |
|---|---|
| `high` | within a biennium (values frozen), **or** a building landing on a roll that held nothing — no revaluation factor multiplies $0 into $17.8M |
| `med` | a new roll already improved, or a near-empty roll improved across a boundary |
| `low` | expansion of an already-improved roll across a boundary — an excess over a *modelled* factor, not a certainty |

### 2.5 What counts as multi-family

`dwelling_units >= 3` (`MIN_DU`), **excluding any roll carrying a farm
class in its latest year**. Not cosmetic: of the 1,841 rolls with DU ≥ 5,
**1,222 are Hutterite colonies** (FARM alongside INSTITUTIONAL / OTHER /
RESIDENTIAL), routinely 20-35 units and $20-38M of buildings. Left in,
they outrank every real apartment block in the province.

The shard ships the floor (3) and the **UI narrows it** — the "DU ≥" box
governs both multi-family layers, and the same clamp means the same
thing on either side.

### 2.6 The dwelling-unit caveat

- `du` is **today's** count, not the count at the event. On a two-phase
  roll it is the total of both phases.
- `sdu` is genuine at-a-date DU from the sales PDF archive — only for
  rolls that sold, but real evidence where it exists.
- `r/snapshot_dwelling_units.R` stamps DU each cycle so true DU deltas
  accumulate **from now on**. Nothing retroactive is possible.

A roll converted to residential without a value jump is missed. The
value series is the trigger; DU is only the filter.

### 2.7 Assessment lag

`y` is the first tax year the building is **assessed**, which trails
physical completion, typically by about a year, and a partly built
structure can be assessed at part value first. It reads as "on the roll
by", never as a construction date. The legend says so.

### 2.8 Building type is hand-labelled, on purpose

`mf-type-overrides.csv` (`muni_no, roll_no_txt, type` where type is
`row|apt|mixed`) is the **only** source of the type field. Four signals
were measured against MAO's own descriptor and all four failed:

| signal | result |
|---|---|
| civic address "Unit N -" vs a street address | 36.5% row-housing precision |
| the same, by whole-development majority vote | 61.7% |
| civic address that is a number range ("147 - 153 CHAMPAGNE ST") | 20.0% at DU ≥ 3 |
| dwelling units per acre | below always-guessing-apartment |

The assessment class cannot help either, and the reason is worth not
re-testing: **Residential 1 vs 2 tracks unit count (1-4 vs 5+), not
building form.** The 58-91 unit rental row housing is RESIDENTIAL 2,
exactly like an apartment block of the same size.

A roll with no override is drawn as "not typed" rather than guessed.

---

## 3. New condos — `r/build_condo_dev.R`

### 3.1 Why it is a separate layer

The multi-family layer gates on `dwelling_units >= 3`, which is the
right gate for rental blocks and the wrong one for everything else: of
the 4,311 rolls MAO labels row housing, **3,975 (92%) carry
`dwelling_units = 1`**, because row housing is condo-titled — one roll
per unit. Row housing is not under-represented in the multi-family
layer, it is **absent** from it, and that layer is in practice "new
apartments".

### 3.2 The plan number is the handle

MAO writes a condo roll's legal description as `<unit>-<plan>`
(`1-63538`, `2-63538`, …) — multi-unit rolls as `21&30-27691` — and its
legal detail reverses that to `<plan>-<unit>`. The plan is the only
handle that turns N single-unit rolls back into one development, and
**98.7% of plans are internally consistent** in MAO's own structure
labelling, which is what a single architectural project should look
like.

Rolls qualify on: class contains RESIDENTIAL 3, a parseable plan, and
building value now. A development is kept when it has ≥ 3 rolls and its
first year (the earliest tax year any of its rolls appears) is in the
window.

### 3.3 Typing, and the same refusal

MAO's **Primary Property** descriptor from the authenticated sales
search distinguishes "ROW HSG" from "APT". Where a development has at
least one labelled roll that label speaks for the development (plan-level
uniformity is what earns that); where it has none the development is
`unknown`. A roll labelled both ways is dropped rather than letting an
arbitrary pick decide a whole development.

The address heuristic reaches 76% per-roll accuracy but 36.5%
row-housing precision, 61.7% even by development majority vote — nearly
four in ten "row housing" labels would be wrong. In an appraisal tool a
confidently wrong label costs more than a blank one.

### 3.4 Counts are drawn per development

Because every unit roll carries `dwelling_units = 1`, labelling parcels
the way the multi-family layers are labelled prints "1" forty times
across one project. The condo layer draws **one** count, the plan total,
at the average of its parcels' centroids, from its own point source
(`condo-du-labels` in `web/src/map.js`, fed by `refreshCondoDuLabels()`
in `main.js`).

---

## 4. Porting to Winnipeg — what to keep and what to throw away

Winnipeg's open data is **better** at exactly the thing this method works
around, and worse at one thing it takes for granted.

### 4.1 Throw away the biennium trick

Winnipeg publishes **building permits since 2010** (`it4w-cpf4`), work
type "Construct New", with dwelling units — already used in
`WpgOpenData/Permits`. That is a direct, dated, permit-level construction
signal. Inferring construction from a value series when a permit file
exists would be a worse answer arrived at more expensively.

It could not be ported anyway: the value-series method needs a per-roll
per-year assessment history, and Winnipeg's Assessment Parcels
(`d4mq-wa44`) is a **current snapshot**. The dated archive in
`WpgOpenData/wpg-parcel-history` starts 2023-11-13, so a Winnipeg value
series is three years long against Manitoba's twenty, with no published
reference date to establish a frozen window.

**What is worth keeping from §2:** the vocabulary and the honesty. Event
shapes (appeared / expanded / new roll), publishing a **confidence** per
event, the "on the roll by, not built in" caveat, and the rule that
every event on a parcel is kept rather than collapsed. A permit-driven
Winnipeg layer still has to say what it is unsure of.

### 4.2 Throw away the hand-labelled type table

Winnipeg publishes a property-use code (**PUCS**) that names the form
directly, and `ParcelSearch/r/lib_dwelling_units.R` already maintains
the classification: `RESAP`, `RESRH`, `RESMB`, `RESRM`, the `CN*` condo
codes, and an explicit reviewed-exclusions list so a code the City adds
later surfaces as UNREVIEWED instead of being silently dropped. Use it.
There is no reason to hand-label anything.

Keep only the **colours** — `MFNB_TYPES` imports `CONDO_TYPES` colours
rather than restating them, so "row housing" looks the same in both
layers. A map that teaches two vocabularies for one idea is worse than
either.

### 4.3 The condo grouping needs a different key

Winnipeg has no equivalent of MAO's `<unit>-<plan>` legal description.
`ParcelSearch/r/lib_dwelling_units.R` already groups condo units by
**normalized civic address** (`normalize_civic_address`, which strips
`UNIT-`/`SUITE`/`#` prefixes and refuses to group missing or `0`
addresses). That is the Winnipeg handle, and the per-development label
layer (`dwelling-condo-labels`) is already built on it.

So §3.4 ports as-is conceptually — one count per development, never "1"
on every unit — and it is already how the Winnipeg tiles are built.

### 4.4 The farm exclusion does not apply

There are no Hutterite colonies in Winnipeg. Do not copy the farm-class
filter; do check what Winnipeg's equivalent distortion is (group care,
rooming houses, and student residences are the candidates — `RESGC` is
already a reviewed exclusion there).

### 4.5 What ports cleanly, and is worth porting

The **web layer**, which is deliberately thin and data-shaped:

| File | What it holds |
|---|---|
| `web/src/lib/mfNewbuild.js` | ramps, modes (Year/Units/Type), `mfnbPasses`, cell/tooltip/CSV formatting |
| `web/src/lib/mfInventory.js` | the standing-inventory reading, `clampMinDu` |
| `web/src/lib/condoDev.js` | condo types, ramps, `condoDuLabelPoints` (the per-plan grouping) |
| `web/src/lib/overlayHighlight.js` | the rule that the yellow selection highlight yields under a themed overlay, and that unit-count labels follow the overlays that are ON |
| `web/src/map.js` | the badge images + `duLabelLayer` / `condoDuLabelLayer`, the context outline |

Three UI decisions that took several rounds to get right and should be
copied rather than rediscovered:

1. **One "DU ≥" control governs both multi-family layers.** "Where are
   the 20-plus unit buildings" is a question about buildings, not about
   which layer happens to be switched on. Two thresholds that could
   disagree are a trap.
2. **A parcel wears one highlight, the most specific one.** An overlay
   that paints a parcel owns it; the yellow selection kit drops to zero
   opacity there (zero, not hidden — the fill is the hit-test layer for
   the popup). Unit-count labels key on which overlays are **on**, not on
   which stamps exist, because the stamps outlive their overlay so a
   re-toggle is a repaint rather than a refetch.
3. **An overlay that fills the results grid hands it back when it is
   switched off** (`regrantResultsGrid` in `main.js`), to whichever
   themed overlay is still painting — or to nobody, if a search owns the
   rows. Without this, the rolls of a layer that is off stay in the
   results wearing the selection highlight.

### 4.6 Suggested Winnipeg shape

1. **New Multi-Family (Winnipeg)** — permits `it4w-cpf4`, work type
   "Construct New", dwelling units > 2, joined to the assessment parcel.
   Colour by permit year (the real construction date, so the "assessment
   year" caveat disappears), by unit count, or by PUCS-derived type.
2. **Multi-Family inventory (Winnipeg)** — already exists in
   `WpgOpenData/MFInventory`, PUCS-classified, condos deliberately
   excluded. It is the direct analogue of `mf-inventory`; wire it to the
   same "DU ≥" control and the same ramp.
3. **New Condos (Winnipeg)** — `CN*` parcels grouped by normalized
   address, first-seen from `wpg-parcel-history` or from the permit that
   created them, one badge per development.

The heavy part of this repo's pipeline is not the part worth porting.
The part worth porting is what the three layers agree to say — one
threshold, one highlight, one count per thing, and a confidence for
anything inferred.
