# Primary Property Filter — Plan

## Status

✅ **Built and verified, 2026-08-16.** `npm test` green (57 files), `npm run
build` clean, no console errors. Taxonomy measured against the real archive
rather than asserted — see Verification.

One step remains, and only you can do it: **hit Refresh on the Sales
Analysis tab's MAO database panel** to re-import. The export now carries the
column (117 shards rewritten), but the browser holds the old copy until it
re-reads the folder. Picking the folder needs a user gesture, so it cannot
be automated. Until then the database path shows only "(no primary
structure)"; the CSV and paste paths already work.

Figures below were measured from `mao-scrape/results/sales_search/by_muni`
on 2026-08-16, when the archive held 545,146 sales across 111 shards. The
export run that evening published 117 shards / 557,585 sales, so the
percentages will drift slightly as the sweep grows — the coverage test
(below) is what keeps them honest.

## What it does

A two-layer filter on the Sales Analysis tab, working identically for all three
sales sources (MAO database, uploaded CSV, pasted block):

- **Layer 1 — family:** Residential / ICI / Farm (plus Uncategorized).
- **Layer 2 — subcategory:** the kind of structure within that family — One
  storey, Bi-level, Cottage, Warehouse, Grain storage, Livestock barn, and so on.

Multi-select at both levels. Ticking a family takes all of its subcategories;
individual subcategories can be ticked across families. Nothing ticked = no
filter, the same convention every other sales filter uses.

## Where each layer's data comes from

**These are two different columns, and that is the point.**

| Layer | Source column | Populated | Authority |
|---|---|---|---|
| Family | `Sale Type Group` | 100% | MAO's own classification |
| Subcategory | `Primary Property` | 43.6% | MAO's primary-structure descriptor |

Layer 1 is **not** derived by parsing the descriptor string. MAO already
classifies every sale as `RESIDENTIAL … / ICI … / FARM …`, that column is
already in the export, and the app already filters on it at load time
(`#sales-db-type`). The family is its first token.

Layer 2 is the `Primary Property` descriptor — a free-text structure label
("1 STY RES AVG QUALITY", "AVERAGE FRAME WAREHOUSE", "STEEL QUONSET MACH.
SHED"), 565 distinct values province-wide.

### Why not derive the family from the descriptor

Because MAO's own answer disagrees with the obvious reading, and MAO's answer is
the one the rest of the app already uses. Apartment blocks — the single largest
ICI descriptor group at 34.7% — read "residential" to the eye but are **ICI** in
MAO's classification. Conversely, `GARAGE AVG QUAL DOUBL DET` and
`WOOD FRAME STORAGE SHED` sit under **Residential**. A string heuristic would
contradict the Sale Type filter sitting a few rows away in the same sidebar.

## The data

Measured across all 111 shards, 545,146 sales:

| Family | Sales | Blank Primary Property | Distinct non-blank |
|---|---|---|---|
| Residential | 388,798 | 173,580 (45%) | 266 |
| ICI | 64,988 | 46,189 (71%) | 245 |
| Farm | 91,360 | 87,948 (96%) | 55 |
| **All** | **545,146** | **307,717 (56.4%)** | **565** |

Two numbers drive the whole design:

1. **56.4% of sales have no Primary Property at all.** Blank is *meaningful* —
   it means no primary structure, i.e. bare land — not missing data. The app's
   usual "missing = exclude" rule would silently drop more than half the
   archive, and would give no way to select *for* bare land.

2. **Per-municipality cardinality is high.** Median 100 distinct non-blank
   values per municipality, max 215 (Brandon). A flat checkbox list is
   unusable at that length, which is exactly what the subcategory layer fixes.

Note how differently the blank share behaves per family: 45% Residential vs
**96% Farm**. Farm sales essentially never carry a structure descriptor. This
is why blank is modelled as a subcategory *within each family* rather than one
global bucket — "Farm, no structure" and "Residential, no structure" are
completely different populations.

## The taxonomy

Ordered rules, **first match wins**, applied case-insensitively to the
descriptor. Order matters: `1 STY AVG Q 2X6 ROW HSG` must land in Row housing,
not One storey, so the row-housing rule runs first.

Coverage figures below are measured against every non-blank descriptor in the
archive.

### Residential — 215,218 non-blank, 0.02% unmatched

| Subcategory | Share | Match on |
|---|---|---|
| One storey | 59.6% | `^1 ?STY`, `^1 STOREY` |
| Storey and a half / 1¾ | 11.8% | `^1 ?1/2 STY`, `^1 3/4 STY` |
| Bi-level | 8.7% | `BI LEVEL`, `BI-LEVEL`, `BI LEV` |
| Two storey | 5.9% | `^2 STY`, `^1 ?STY/2 ?STY`, `^2 STOREY` |
| Cottage / seasonal | 5.2% | `COTTAGE`, `COT AVG/LOW/GOOD`, `GUEST HOUSE`, `SEASONAL` |
| Mobile / manufactured | 3.0% | `MOBILE HOME`, `MOBILE HM`, `TRAILER` |
| Row housing / townhouse | 2.7% | `ROW HSG`, `ROW HOUSING`, `ROW HS`, `RO HS`, `RH$` |
| Split level (3/4 level) | 2.5% | `\d LEVEL RES` |
| Garage / outbuilding | 0.6% | `GARAGE`, `STORAGE SHED`, `SHED`, `CARPORT`, `GAZEBO` |
| Other | 0.02% | — |

Residual (52 rows) is genuine miscellany: lean-tos, boathouses, verandahs,
shipping containers.

### ICI — 18,799 non-blank, 2.8% unmatched

| Subcategory | Share | Match on |
|---|---|---|
| Apartment / multi-res | 34.7% | `APT`, `APARTMENT` |
| Store / retail | 24.5% | `STORE`, `STRIP MALL`, `RETAIL`, `GROCERY`, `DEALERSHIP`, `S/O`, `STR/OFF` |
| Warehouse / storage | 23.2% | `WAREHOUSE`, `WHSE`, `WHS`, `HANGAR` |
| Shop / industrial | 3.7% | `MACHINE SHOP`, `MACH SHOP`, `RIGID STEEL`, `LIGHT STEEL`, `ARCH RIB`, `QUONSET`, `SHOP`, `TOWER` |
| Hotel / motel | 2.9% | `HOTEL`, `MOTEL` |
| Office / bank | 2.7% | `OFFICE`, `BANK` |
| Restaurant / food | 2.4% | `RESTAURA?N?T`, `LOUNGE`, `FAST FOOD` |
| Institutional / community | 1.8% | `CHURCH`, `COMMUNITY HALL`, `GOLF`, `SCHOOL`, `ARENA` |
| Service / automotive | 1.1% | `SERVICE STATION`, `CAR WASH`, `CONV/GAS`, `GAS` |
| Mobile home park | 0.3% | `MOBILE HOME PARK` |
| Other | 2.8% | — |

The `RESTAURA?N?T` pattern is deliberate: MAO ships the typo `1 STY C/BLK
RESTAURNT` (45 sales), which a strict `RESTAURANT` match drops.

ICI's 2.8% residual is honest rather than a gap — it includes MAO's literal
`OTHER` (29) and `CODE/TYPE NO LONGER USED` (26), plus one-off types like
`UNIQUE RESIDENTIAL STRUCT` and `HIGHWAY SERVICE CENTRE`. Chasing it below ~2%
means encoding singletons.

### Farm — 3,412 non-blank, 0% unmatched

| Subcategory | Share | Match on |
|---|---|---|
| Livestock barn | 34.8% | `BARN`, `HOG`, `POULTRY`, `DAIRY`, `HORSE`, `PIGGERY`, `LOOSE HOUSING`, `MILKHOUSE` |
| Machine shed / shop | 34.2% | `MACH`, `WORKSHOP`, `SHED`, `SHELTER` |
| Grain storage | 29.2% | `GRAIN`, `GRANARY`, `GRNARY`, `FEED TANK`, `SILO` |
| Other farm structure | 1.8% | `POTATO`, `SLURRY`, `GREENHOUSE`, `POLYDOME`, `FERTILIZER`, `TANK` |

Every Farm descriptor classifies. But remember: this covers only the 4% of farm
sales that carry a descriptor at all.

### The blank subcategory

Each family additionally offers **`(no primary structure)`**, holding that
family's blank rows. Sorted last within its family, mirroring how
`zoneCategory.js` sorts `(no category)` behind the real types
([zoneCategory.js:119](src/lib/zoneCategory.js:119)).

## ~~Blocker~~ (resolved): the database export dropped the column

`KEEP` at
[export_sales_for_web.R:52](../../mao-scrape/scripts/export_sales_for_web.R:52)
omits `primary_property`, and the live shard headers in
`D:\Dropbox\Appraisal\Web\MAOSales` confirm it is absent. All 111 `by_muni`
source files *do* carry the column — verified, one header shape across all of
them — so this is purely an export-side drop.

Two lines fix it, but **re-running the export rewrites all 111 shards**. The
browser decides what to re-import by comparing each file's `lastModified`
against what it last read
([salesStore.js:230](src/lib/salesStore.js:230)), so every municipality will
look updated and the whole ~150 MB archive re-imports once. One-off, and
unavoidable for this feature.

**Guard needed.** `select(any_of(KEEP))` silently drops an absent column, and
`buildCsvFor` **throws** on a shard header mismatch
([salesStore.js:410](src/lib/salesStore.js:410)). If any future shard lacks
`primary_property`, a multi-muni load fails outright with "Sales shards have
different columns". Force the column into existence before `select()` rather
than trusting all 111 files to stay in step.

## Work items

### 1. `mao-scrape/scripts/export_sales_for_web.R`

- Add `"primary_property"` to `KEEP` (line 52).
- Add `primary_property = "Primary Property"` to `RENAME` (line 65).
- Before `select(any_of(KEEP))`, force the column:
  `if (!"primary_property" %in% names(d)) d$primary_property <- NA_character_`.
- Re-run the export, then Refresh in the browser to re-import.

### 2. `web/src/lib/primaryProperty.js` — new module

Pure, no DOM, no network — same shape as `zoneCategory.js`, so the taxonomy is
unit-testable without a browser.

- `FAMILY_ORDER` — `['Residential', 'ICI', 'Farm', 'Uncategorized']`.
- `NO_STRUCTURE` — the `(no primary structure)` sentinel.
- `familyOf(saleTypeGroup, primaryProperty)` — first token of the Sale Type
  Group; falls back to descriptor inference when the column is absent (see
  Gotchas).
- `subcategoryOf(family, primaryProperty)` — the ordered rule tables above.
- `primaryPropertyTree(rows)` — `[{family, count, subcategories:[{name, count}]}]`
  built from the **full** row set, not the filtered one, so ticking boxes never
  strands you with no way back (same rule as
  [main.js:5264](src/main.js:5264)). Families and subcategories with zero rows
  are omitted, so every offered option returns at least one sale.
- `rowMatchesPrimaryProperty(row, selected)` — the predicate, group semantics
  (see Decisions).

### 3. `web/src/lib/multiSelect.js` — two additions

- **Grouped options.** Accept a tree, not a flat list: render each family as a
  `<details>` with a tri-state parent checkbox over its subcategory rows. This
  pattern already exists in
  [salesDbPanel.js:291](src/lib/salesDbPanel.js:291) (`renderMuniList`) — lift
  it rather than reinventing it.
- **Counts.** Render `Bi-level (18,780)` beside each option. Given how wildly
  the blank share swings by family (45% → 96%), a bare list would hide that a
  Farm subcategory filter addresses 4% of farm sales.

A search box is **not** required once options are grouped — the tree is ~30
rows, not 565. Deferred unless it proves needed in use.

### 4. `web/index.html`

A fourth `<span class="field">` inside `.class-row.sales-only`
([index.html:565](index.html:565)), id `primaryprop-filter`, with a `.tip`
written in the same voice as its three neighbours. The tip must state the blank
share and that Farm sales rarely carry a descriptor — otherwise the filter looks
broken on a farm comp set.

### 5. `web/src/main.js` — six edits, each mirroring the zoning-type filter

| What | Where |
|---|---|
| Stamp `p._saleTypeGroup = sale.saleTypeGroup ?? null` | beside `_primaryProperty`, [main.js:3910](src/main.js:3910) |
| `initMultiSelect` for the new control | beside the other three, ~[main.js:378](src/main.js:378) |
| Add element to the refilter listener array | [main.js:2708](src/main.js:2708) |
| Clear it in the reset path | [main.js:3344](src/main.js:3344) |
| Populate the tree from `csvFullRows` | alongside `syncZoningFilterOptions`, [main.js:5281](src/main.js:5281) |
| Read the Set + apply the predicate | [main.js:5444](src/main.js:5444) and ~[main.js:5671](src/main.js:5671) |

The `_saleTypeGroup` stamp is the only non-mechanical one. `salesCsvParse.js`
already parses `saleTypeGroup`, `parcelSize`, `parcelSizeUnit` and
`parcelChange` into records ([salesCsvParse.js:71](src/lib/salesCsvParse.js:71)),
but `handleSalesUpload` stamps **none of them** onto the feature — they are
parsed and discarded today. Layer 1 needs `_saleTypeGroup` on the feature.

### 6. Grid column

`data-col="primaryprop"`, `.sales-only`, **off** by default. Without it a
filtered row cannot explain itself — precisely the failure
[zoneCategory.js:130](src/lib/zoneCategory.js:130) documents ("rows that flatly
contradicted the filter"). New column key, so no `STORAGE_KEY` bump.

The map popup already renders Primary Property
([map.js:3958](src/map.js:3958)), so no work there.

## What already works — no changes needed

- `salesCsvParse.js:61` already aliases `primary property` → `primaryProperty`,
  including positional handling of newline-stacked cells on multi-parcel sales.
- `handleSalesUpload` already stamps `p._primaryProperty`
  ([main.js:3910](src/main.js:3910)).
- The map popup already displays it.

So **CSV and pasted sales need no parsing work at all** — only the control, the
taxonomy module and the predicate.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Placement | Sidebar display filter only | One control, identical behaviour across database / CSV / paste. A load-time twin on the DB panel would speed big loads but serve only one source. |
| Blank rows | `(no primary structure)` per family | 56.4% of the archive. "Missing = exclude" would silently drop it with no way to select for bare land. |
| Multi-parcel sales | Whole sale passes if any parcel matches | Group semantics, matching the far-flung, size and price filters. Per-parcel filtering would leave group $/acre describing parcels no longer on screen. |
| Exact descriptor (3rd level) | Out of scope for v1 | 565 values; the subcategory is the appraisal-meaningful unit. Easy to add later as a third tier under each subcategory. |

## Gotchas

**Pasted comp sets have no Sale Type Group.** A hand-pasted MAO block is the
7-column grid shape — Sale Date … Primary Property — with no type column, and
`salesCsvParse.js` spreads that field conditionally so the key is simply absent
([salesCsvParse.js:254](src/lib/salesCsvParse.js:254)). Layer 1 therefore has no
source data on the paste path. `familyOf()` falls back to inferring the family
from the descriptor's subcategory, following MAO's own convention as measured
here (apartments → ICI, garages/sheds → Residential). Sale Type Group **always
wins when present**; inference is the fallback only.

**Two filters can contradict each other.** `#sales-db-type` narrows at load
time and is DB-only; this one narrows in memory across all sources. Loading
with Sale type = ICI and then ticking Residential yields zero rows — correct,
but needs to read as an explicable empty result rather than a bug. Worth a line
in the count message when a family filter eliminates everything.

**Rule order is load-bearing.** `1 STY AVG Q 2X6 ROW HSG` matches both the
row-housing and one-storey rules; row housing must run first. Same for
`MOBILE HOME PARK` (ICI) against `MOBILE HOME` (Residential) — different
families, so they cannot collide, but the ICI table still lists the park rule
explicitly.

**The taxonomy will drift.** MAO adds descriptors. Unmatched values land in
`Other` rather than vanishing, so drift degrades to a growing Other bucket, not
to lost sales. Re-running the coverage measurement after a sweep is the check.

## Testing

- **`web/test/primaryProperty.test.js`** (new) — family derivation from Sale
  Type Group; descriptor fallback when the column is absent; rule ordering
  (`ROW HSG` beats `1 STY`); the `RESTAURNT` typo; blank → `(no primary
  structure)` within the right family; tree built from full rows omits
  zero-count entries; empty selection = no filter; multi-parcel any-match.
- **`web/test/multiSelect.test.js`** — extend for grouped rendering, tri-state
  parent behaviour and counts.
- **Coverage regression** — assert the taxonomy still classifies ≥97% of
  non-blank descriptors, using a fixture sampled from the archive. Catches
  drift without needing the private data in the repo.
- `web/test/salesCsvParse.test.js` already covers blank-cell parsing
  ([line 148](test/salesCsvParse.test.js:148)) — no change.

## Verification

**Unit tests.** `test/primaryProperty.test.js`, 33 cases, all real MAO
strings. The ones that matter are the collisions where only rule ORDER gives
the right answer: `ROW HSG` beating `1 STY`, `STORE(?!Y)` keeping "1 STOREY
FRAME WORKSHOP" out of retail, apartments claimed as ICI ahead of the
storey rules, `MOBILE HOME PARK` (ICI) against `MOBILE HOME` (Residential).

**Coverage against the real archive.** `test/primaryPropertyCoverage.test.js`,
opt-in via `RUN_ARCHIVE_TESTS=1` because it reads the private archive and
there is no fixture to commit. Measured over 15 shards / 55,274 parcel rows:

| Family | Blank | Descriptors classified |
|---|---|---|
| Residential | 53% | 100.0% |
| Farm | 96% | 100.0% |
| ICI | 85% | 95.8% |

Family inference (the paste path) agreed with MAO on **99.792%** of 16,336
graded rows. The test also prints the largest `Other` descriptors each run —
that list is the drift report, i.e. what an updated archive is asking to
have a rule written for.

**In the browser.** Eleven real Brandon sales pasted through the modal — the
riskiest path, since a pasted set has no Sale Type Group and must fall back
to inference. The tree came back exactly as predicted:

```
Residential (5)   Bi-level (2), One storey (3)
ICI (3)           Apartment / multi-res (1), Store / retail (1), Warehouse / storage (1)
Uncategorized (3) (no primary structure) (3)
```

Confirmed live: ticking One storey left exactly the three one-storey houses;
adding Warehouse across a different family gave four; the family parent
checkbox ticked all children and went indeterminate when one was unticked;
Clear restored all 11; `th` and `td` counts matched at 50, so the positional
grid column is in step; the count line read "2 of 11 sales shown (filtered)".

**Group semantics, the load-bearing decision.** A second paste built one sale
from two parcels — a house plus a bare continuation lot. Ticking **One
storey** kept BOTH rows, and ticking **(no primary structure)** also kept
both, while the unrelated warehouse sale dropped in each case. That is the
behaviour the design requires: a sale passes or fails whole, so its group
$/Acre never describes land that has left the screen.

**The database path.** Verified without the folder picker by feeding the app
a nine-sale slice of the freshly-exported `muni_500.csv` — the real
18-column export shape, including two multi-parcel sales whose cells are
newline-stacked inside quotes. It expanded to 13 parcel rows correctly, and
because `Sale Type Group` is present the authoritative family wins:

```
Residential (6)   One storey (2), (no primary structure) (4)
ICI (3)           Apartment / multi-res (1), Warehouse / storage (1), (no primary structure) (1)
Farm (4)          (no primary structure) (4)
```

Note what is absent: **no Uncategorized group at all**. That bucket only
appears on pasted sets, which carry no type column.

**CSV export alignment.** The export gained two columns (Primary Property,
Sale Type Group) and its cells are positional, so a miscount would shift
every column after them in a file that ends up as appraisal evidence.
Captured a real export from the running app and parsed it: **151 header
columns, 151 in every body row**, the new pair sitting immediately after
Sale Price, values correct per row including blanks for bare land.

**Per-family blank, proven.** On that same set, ticking **Farm → (no primary
structure)** returned exactly the four farm parcels; ticking **Residential →
(no primary structure)** returned exactly the four residential ones and
neither the farm parcels nor the ICI bare-land sale. A single global blank
bucket — the design this rejected — would have returned all nine blank
parcels for both ticks. Both selections also kept their multi-parcel sales
whole.

## What is left

1. **Refresh the browser's copy of the archive.** Sales Analysis → MAO sales
   database → Refresh. One full re-import (~126 MB), because every shard was
   rewritten. Needs your click.
2. **Smoke test at the worst case.** A Brandon load holds 215 distinct
   descriptors; it should collapse to a tree of roughly 15 rows, and ticking
   **Residential → One storey** should agree with the Primary Property grid
   column (gear menu → it is off by default) on every visible row.
3. **One cosmetic call, now a small one.** Bare land on a *pasted* set reads
   as "Uncategorized", because with no Sale Type Group and no descriptor
   there is nothing to place it by — guessing "Residential" would be wrong
   for farm comps. Verifying the database path showed this is narrower than
   it first looked: on the archive path, which is the main one, the family
   is always known and the group never appears. So it affects hand-pasted
   comp sets only. Left as-is; say the word if you would rather it read
   "(sale type unknown)".
