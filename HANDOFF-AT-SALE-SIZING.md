# HANDOFF — at-sale sizing, geometry withholding, provenance

Written 2026-08-19 to hand this back for local verification. Two branches, both
pushed, both open as PRs, **neither merged**. Nothing here has run against real
data — see [What was never verified](#what-was-never-verified) before trusting
any of it.

---

## What this is

Every unit rate on the Sales tab divided a price fixed at the sale date by
acreage read from **today's** assessment roll, and drew today's polygon beside
it. On a parcel subdivided since the sale those describe different land: a
160-acre parcel split four ways measures 40 acres today, so `$/acre` came out
four times too high and looked entirely ordinary on screen.

The fix was mostly already built. `flag_parcel_changes.R` resolves, per sale,
the size that is safe to analyse from; `export_sales_for_web.R` ships it; and
`salesCsvParse.js` already parsed it into every record, per parcel, correctly
aligned. Nothing downstream read it — the three columns appeared in the parser
and its test file and nowhere else in the codebase.

So this is mostly a wiring job, plus one new behaviour (the geometry pin) and
one new upstream field (`size_basis`).

---

## Current state

| | |
|---|---|
| **parcelsearch #3** | 4 commits, head `8d26816`. CI + Vercel green. Open, ready for review, **not merged**. |
| **mao-scrape #1** | 2 commits, head `0862858`. No CI configured (suite runs on the nightly wrapper). Open, ready for review, **not merged**. |
| Branch (both repos) | `claude/mb-parcel-video-prep-ewk8d8` |

Merge order matters: **mao-scrape first**. It adds the `Size Source` column
that parcelsearch reads. Not a hard block — the web app falls back to vaguer
wording without it — but merging the other way round means testing the fallback
path rather than the real one.

---

## Restart here

Do not merge first. Test the branches directly.

### Step 1 — the merge gate

```powershell
cd D:\Dropbox\ClaudeCode\MBOpenData\mao-scrape
git fetch origin
git checkout claude/mb-parcel-video-prep-ewk8d8
Rscript tests/run_tests.R
```

Expect **fully green**. This is the gate because the nightly wrapper runs the
same suite as a pre-flight and aborts the run on failure — a red suite here is
a stopped scrape, not just a failed check.

> `test-lock.R` failed in the review environment. It asserts that a lock held by
> a *live process* refuses a second holder, which does not hold under container
> PID semantics. **On real hardware it should pass.** If it fails for you, that
> is a genuine signal, not the known artifact.

### Step 2 — regenerate the flags and the export

```powershell
Rscript scripts\flag_parcel_changes.R
```

Two things to check:

1. **`size_basis` now appears** in `results/sales_search/parcel_change_flags.csv`.
   That is the change working — `restack_per_sale` was silently dropping it on
   the way to one-row-per-sale, so it never reached the CSV or the browser.
2. **The summary block it prints** — legal / size / unit / any-change rates.
   That is the number for the training-video footnote, and this is the first
   time it will have been measured against the complete 667,082-sale archive.

> **Do not quote the old figures.** The repo contains three, all from the same
> 2026-08-10 commit and all measured against 498,891 sales:
> `flag_parcel_changes.R:10` says legal changed **13.0%**;
> `parcel_change_lib.R:26` says strict matching flagged **10.13%** and
> normalising cosmetic differences dropped it to **5.63%**. The live calculation
> normalises, so what the script prints today should be in the 5.63% family —
> the 13.0% in the header reads like a pre-normalisation figure left behind.
> Whatever step 2 prints supersedes all three.

Then:

```powershell
Rscript scripts\export_sales_for_web.R
```

Confirm a shard under `D:\Dropbox\Appraisal\Web\MAOSales\` carries a
**`Size Source`** column header.

### Step 3 — the web app (needs step 2 done first)

```powershell
cd D:\Dropbox\ClaudeCode\MBOpenData\manitoba-opendata-parcelsearch
git fetch origin
git checkout claude/mb-parcel-video-prep-ewk8d8
cd web
npm install
npm test
npm run dev
```

Without step 2 the browser sees no `Size Source` column and you exercise only
the fallback path.

Load a municipality where you know a comp was subdivided after its sale, and
check four things:

- `$/Acre` divides by the **at-sale** size, not today's
- that parcel draws as an **amber pin**, not a polygon
- the popup reads **Land Size (as sold)** with a source line naming the
  property-sales report vs. verified-current
- the soil / land-cover column carries the "describes the current parcel"
  heading

---

## The rules the code enforces

Worth knowing before changing any of it — each of these is load-bearing and
easy to undo by accident.

**If `Parcel Size` has a value, use it and never recompute. If it is blank,
report nothing.** The pipeline already decided, against sources the browser
cannot see. Substituting today's acreage into that blank is precisely the error
the upstream exists to prevent, and it produces a plausible wrong number rather
than a visible gap.

**Absent is not blank.** A hand-pasted MAO comp set is the seven-column grid and
carries none of these columns; `salesCsvParse.js` omits the keys entirely rather
than emitting empty strings. That path keeps the legacy behaviour (today's
acreage). Blanking every rate on a workflow that never claimed to be verified
would be a regression, not a correction. `_saleSizeKnown` separates the two.

**A frontage is not an area.** `Parcel Size Unit` carries the roll's A/F
distinction through. A FEET row yields a frontage and no acreage; hectares are
refused rather than converted. Same refusal `parseRollFrontageFeet` already
makes.

**Withheld geometry means removed, not hidden.** A polygon left in the source and
styled invisible still answers `queryRenderedFeatures`, so hover and click keep
resolving against land that didn't sell. Only the *map* collection is rewritten
— the table, CSV and overlays still read the current parcel, which is the right
answer to "what is there now".

**An unrecognised change signal fails safe to `withheld`.** A verdict a future
pipeline emits and this build doesn't know is not evidence the parcel is
unchanged.

**Size feeds a rate; shape-derived figures do not.** The acreage was *withheld*
because it is the denominator of an asserted rate. Soil, land cover, cult %,
slope, CLI and MASC are *named* instead — there is no at-sale soil survey to
substitute, and the figures stay true of the land that is there now.

---

## What was never verified

Stated plainly so none of it gets mistaken for tested.

- **No real data, anywhere.** Every data directory is gitignored; the archive
  and shards live on your machine. Nothing in either branch has seen a real
  sales CSV, a real shard, or a real parcel.
- **The Arrow-backed R tests could not run.** No Arrow build exists for R 4.3
  (the newest Ubuntu offers), `cloud.r-project.org` is blocked by the review
  environment's proxy, and building Arrow from source was not viable. The
  affected files: `test-archive`, `test-assemble_guard`, `test-cache_delete`,
  `test-deadline`, `test-delta_runner`, `test-full_runner`, `test-refresh`,
  `test-restore_rolls`. Nothing in the diff touches parquet I/O — but that is
  reasoning, not a test result. **This is what step 1 is for.**
- **The map was never driven.** The pin was verified against real maplibre-gl
  4.7.1 in headless Chromium (layer spec accepted; a Point hits `parcel-pin`, a
  Polygon still hits `parcel-fill`; an all-withheld upload yields a zero-area
  bbox that `fitBounds` handles). But that is a synthetic two-feature fixture,
  not the app with a sales CSV loaded.
- **`SETUP.md`'s Windows steps are transcribed, not executed.** The R-side steps
  were run; the scheduled tasks, DPAPI credential setup and `.bat`/`.ps1`
  wrappers were read out of the scripts. The file says so itself.

---

## Open decisions

Two judgement calls left deliberately open, because both are yours.

**1. Provisional boundaries currently draw as normal polygons.** The three-state
model is confirmed / provisional / withheld, but only `withheld` changes the
rendering. `provisional` (legal matches, no at-sale size to check it against)
keeps its polygon with the caveat stated in the popup text. No visual cue was
added because `parcel-line` already uses dashes as the selection idiom and its
paint expressions carry starred / group / hover state tuned against two
basemaps that could not be seen from the review environment. Adding one is a
small change to `parcel-pin`'s neighbourhood in `map.js`.

Worth knowing for the decision: a matching legal description is real but partial
evidence — measured over 148,874 comparable sales, only **57.2%** of size changes
came with a legal change, so a matching legal misses roughly 43% of them.

**2. Shape-derived figures are named, not suppressed.** Soil, land cover, cult %,
slope, CLI and MASC on a withheld parcel describe today's remnant. They carry a
heading saying so rather than being blanked. Suppressing them instead is a
two-line change in `shapeDerivedNote()`'s callers. Decide on real data whether
the label is enough.

---

## What changed, by file

### parcelsearch (`8d26816`, 4 commits, +1335 / −36)

| File | |
|---|---|
| `web/src/lib/saleSize.js` | **new.** The whole verdict layer: `resolveSaleSize`, `geometryTrust`, `saleSizeStamp`, `saleAcres`, `saleFrontageFeet`, `saleSizeState`, `sizeSourceLabel`, `showsCurrentRollSize`, `shapeDerivedNote`. |
| `web/src/lib/withheldGeometry.js` | **new.** Swaps a withheld parcel's polygon for its centroid. Shaped like `historicalHighlight.js` — swap, stamp, count, never mutate. |
| `web/src/lib/saleGroups.js` | `computeSaleGroups` sums at-sale acres/frontage. The existing `acresIncomplete` guard does the suppression; no new rule was needed. |
| `web/src/lib/salesCsvParse.js` | Parses the new `Size Source` column. |
| `web/src/main.js` | Stamps the verdict onto features; `rowSizeAcres()` splits size-column acreage from polygon-sampled acreage; grid, sort keys and CSV follow; `markAreaCheck` gated. |
| `web/src/map.js` | `parcel-pin` layer; `parcelHitLayers()` across all six hit-test sites; click registered on both layers; popup states size, source and boundary trust. |
| `web/test/*` | `saleSize` (38), `withheldGeometry` (12), `csvColumns` (3), plus 6 added to `saleGroups`. Suite is 64 files, green. |

### mao-scrape (`0862858`, 2 commits, +248 / −4)

| File | |
|---|---|
| `scripts/parcel_change_lib.R` | `restack_per_sale()` stacks `size_basis` — it was being dropped here. |
| `scripts/flag_parcel_changes.R` | Writes it to `parcel_change_flags.csv`. |
| `scripts/export_sales_for_web.R` | Ships it to the browser as `Size Source`. |
| `tests/testthat/test-flag_parcel_changes.R` | Restack fixture + assertions. 110 → 112, green. |
| `SETUP.md` | **new.** Cold clone → running scrape. |
| `README.md` | Pointer to SETUP.md. |

---

## One correction to carry forward

An earlier review note said the DPAPI credential binding is what stops the
sweep moving off the workstation. **That was overstated.** `mao_login()` in
`scripts/sales_search.R` reads `MAO_USER` / `MAO_PASS` from the environment and
nowhere else — DPAPI is the Windows *delivery* mechanism, not an architectural
requirement, so another host just needs a different secret store.

It does explain why `MAOSalesSearch` and `MAOSalesStaleness` must stay
`Interactive` (an S4U token cannot unlock the blob), which is a narrower claim.
The real porting cost is hardcoded `D:/Dropbox` paths in five scripts (there is
no `config.R` path layer in mao-scrape, unlike the parcel-search repo),
`C:\Program Files\R` in the PowerShell wrappers, and the scheduling / alerting
/ watchdog layer being Windows Task Scheduler end to end. Paths and wrappers are
an afternoon; the scheduling layer is the real number. `SETUP.md` §6 has the
detail.

---

## Still outstanding

- **The item-3 footnote number** — comes out of step 2. Nothing to quote until
  then.
- **The two open decisions** above.
- **PDF backfill.** `scripts/sales_pdf_gap_report.R` ranks 13 recoverable
  periods (~5,985 sales, 2.6%). That is the only lever that raises how many
  sales can carry a true at-sale size: coverage is 76.7% against a hard ceiling
  of 79.3%, because 20.7% of sales predate any obtainable PDF. Half the
  remaining work is just downloading each new bi-monthly report as it publishes
  — worth automating so coverage holds rather than decays.
