# Port guide — Zoning-code legend + dimensions over address labels

Written 2026-09-21 for evaluating two Winnipeg changes against
mb-parcelsearch. Self-contained by design: drop this file into a fresh
session opened in this repo, per the porting convention in
`docs/archive/WINNIPEG_HISTORICAL_PORT.md`.

Source repo: `D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`
(github.com/jayschellenberg/winnipeg-opendata-parcelsearch), commit
`0ef1149`, PR #13. Paths below are relative to THIS repo
(`D:\Dropbox\ClaudeCode\MBOpenData\mb-parcelsearch`) unless marked
`[WPG]`.

**Nothing here has been implemented in this repo. This is an
assessment plus a recipe, not a changelog.**

## The short version

| Change | Port cost | Verdict |
|---|---|---|
| **A. Zone codes in the zoning legend** | Zero | **Don't port.** MB already does this, better. One small dead-code cleanup is the only real gap. |
| **B. Dimensions drawn over address labels** | High, and not really a port | **Don't port as-is.** MB has no dimensions feature to reorder. Building one first runs into a data-premise problem. |

Neither change is urgent. A is already satisfied; B is a new feature
wearing a bug-fix's clothes.

---

# Part A — Zone codes in the zoning legend

## A.1 What Winnipeg changed

Winnipeg's zoning fill is coloured by **category** (`map_colour`), from
a 13-entry static palette. The legend listed only the category names,
so a parcel labelled `C2` on the map had no stated connection to the
"Commercial" swatch. The change adds the codes as a muted second line:

```
▮ Commercial
  C1, C2, C3, C4, CMU
▮ Single Family Residential
  R1-E, R1-L, R1-M, R1-S, RMH
```

Codes are derived at runtime from the loaded citywide zoning FC
(`zoningCodesByCategory()` in `[WPG] web/src/main.js`), not hard-coded,
so the list can't go stale as the by-law adds or retires districts.

## A.2 Why MB does not need it

**MB's zoning legend is already code-first, and is rebuilt per search.**

`web/src/main.js:692` — `rebuildZoningLegend(zoningFc)` sets the legend
title to "Zoning code" and renders one row per code found in the
current result set, via `buildZoneCodePaint()` (`web/src/map.js:166`).
Each row reads:

```
▮ C2 – Commercial General
```

— the code AND the most-frequent `ZONE_NAME` seen alongside it, with
the swatch colour coming from `colorForZoneCode()`'s stable hash so the
map paint and the legend swatch can never drift.

That is strictly more informative than what Winnipeg now has:

| | Winnipeg (after PR #13) | Manitoba (today) |
|---|---|---|
| Coloured by | category band | individual zone code |
| Legend scope | all 13 citywide bands, always | only codes in the current search |
| Row content | band name + its codes | code + its by-law name |

Porting the Winnipeg treatment would be a **downgrade** — it would
group MB's codes back into bands that MB's map doesn't actually paint.

## A.3 The one real gap

`paletteLegendEntries()` (`web/src/map.js:122`) is exported and has a
thoughtful doc comment about de-duplicating alias keys by colour, but
**nothing imports it.** A repo-wide grep finds the definition and no
call sites. `ZONING_PALETTE` itself is still used for the category
fill, but its legend helper is dead.

Two honest options:

1. **Delete `paletteLegendEntries`.** It is dead weight, and a reader
   encountering it reasonably assumes a category legend exists.
2. **Keep it and note why**, if a category-band legend is expected back
   (e.g. for the dev-plan overlay, which has its own
   `DES_CATEGORY` palette).

Pick one deliberately. This is a five-minute change either way and is
the only part of Part A worth doing.

## A.4 If a category-band legend ever does return

Should MB need a band legend later (dev-plan overlay is the likely
candidate), apply the Winnipeg pattern — but mind three MB-specific
traps:

**Trap 1 — alias keys.** MB's `ZONING_PALETTE` deliberately maps
several source spellings to one colour (`'Residential'` and
`'Residental'`, `' Rural Residential'` with its leading space,
`'Settlement Centre'`/`'Settlement Center'`). Winnipeg's
`buildZoningLegend()` walks the palette two entries at a time and emits
a row per pair — in MB that produces duplicate rows and visible typos.
Group by **colour** first; `paletteLegendEntries()` already does
exactly this, which is the reason to keep it rather than reinvent it.

**Trap 2 — the PNG export scrape.** `lib/mapLegend.js:82` builds each
exported row from `li.textContent`, identical to Winnipeg's. A
two-line row flattens to one line there, so a name and its codes
collide into `CommercialC1, C2, ...` unless a real separator character
sits between them in the DOM. Winnipeg's fix: a visually-hidden
`<span class="zl-sep"> — </span>`, hidden with `clip-path: inset(50%)`
rather than `display: none` (which would drop it from `textContent`
too, defeating the purpose).

Also check the export arithmetic before shipping — `layoutMapLegends()`
clamps box WIDTH to `LEGEND_MAX_WIDTH_RATIO` but does not truncate row
text, so an over-long row overflows the box rather than clipping. On
Winnipeg the widest row measured 687px against a 935px cap; MB's
category names plus codes could run longer, and MB's legend has to
share the corner with the other overlays' boxes stacked below it.

**Trap 3 — height, already solved here.** Adding a second line grows
the panel by roughly half. MB already guards this:
`style.css:3432` gives `.map-legend.zoning-legend` a `max-height`
tied to the viewport plus `overflow-y: auto` and `pointer-events:
auto`. Winnipeg deliberately does NOT do this — `pointer-events: auto`
makes the legend swallow map clicks and drags underneath it, which
Winnipeg was not willing to trade for a legend that fits. MB accepted
that trade because its per-search legend can run to dozens of codes.

**This is a deliberate divergence, not drift.** Don't "fix" either app
to match the other.

---

# Part B — Dimensions drawn over address labels

## B.1 What Winnipeg changed

One line of layer ordering. `dimensions-label` was added to the style
BEFORE `civic-addresses-label`, so address labels painted on top and
their white halos ate the edge footage where the two overlapped.
Moving the dimensions block after the civic-address block puts
dimensions on top. `text-allow-overlap` / `text-ignore-placement` were
already `true`, so dimensions never *suppressed* an address before and
still don't — they just win the overlap now.

## B.2 Why it does not port

**MB has no dimensions feature at all.** A repo-wide grep for
`length_label`, `dimensions-toggle` and `Dimensions` across
`web/src` and `web/index.html` returns nothing. There is no layer to
reorder.

MB's address labels are `muni-parcels-civic-label`
(`web/src/map.js:2516`), and note `web/src/map.js:3283` explicitly
calls `map.moveLayer('muni-parcels-civic-label')` to force them to the
top of the stack. **Any dimensions layer added later would land
underneath them regardless of where it is added** — which is exactly
the bug Winnipeg just fixed, reintroduced by a `moveLayer` Winnipeg
doesn't have. See B.4.

## B.3 The premise problem — read this before building it

Winnipeg ties dimensions to `lastSurveyFc`, the **survey/legal-lot**
layer, and the code comments are explicit about why: assessment
polygons describe building footprints and aggregations, so their edges
are not meaningful as lot dimensions.

**MB has no equivalent layer.** `web/src/main.js:105` states it
plainly: Roll_Entry IS the parcel layer; there is no separate
survey/legal-lots dataset like Winnipeg has. So MB edge labels would
be measuring assessment-ish parcel geometry — the exact thing Winnipeg
excluded on purpose.

Compounding it: much of MB's parcel base is quarter-sections and rural
acreage, where "33 ft × 120 ft" is not a question anyone asks. The
feature earns its keep on Winnipeg's urban survey lots; its value on
an RM quarter-section is close to nil.

**Recommendation: build it only for a muni/townsite context where lots
are urban-scaled, or not at all.** If Jason wants it, ask which
parcels he pictures it on before writing code — that answer determines
whether the feature is worth building at all.

## B.4 Recipe, if built anyway

Porting the generator is mechanical; the wiring is where the traps are.

1. **Copy the builder.** `buildDimensionLabels()` from
   `[WPG] web/src/main.js` (~line 2318). Pure geometry, no Winnipeg
   dependencies. It emits one LineString per outer-ring edge with a
   pre-formatted `length_label` ("98 ft"), skips edges under 5 ft, and
   — importantly — de-duplicates shared edges by canonicalising
   endpoint pairs so `[a,b]` and `[b,a]` key the same. Without that,
   adjacent lots stamp two labels on one shared edge and MapLibre
   smears them. Keep the dedupe.

2. **Add source + layer.** `[WPG] web/src/map.js`, the `dimensions`
   GeoJSON source and `dimensions-label` symbol layer. Key settings:
   `symbol-placement: 'line-center'` (one auto-rotated label per edge,
   survey-plat look), `minzoom: 17`, `text-allow-overlap: true`,
   `text-ignore-placement: true`, blue `#1d4ed8` with a 2.8px white
   halo.

3. **Order it above the address labels** — the actual subject of this
   port. Add the block AFTER `muni-parcels-civic-label`, **and then
   deal with `map.js:3283`**: that `moveLayer('muni-parcels-civic-label')`
   will undo your ordering. Either move `dimensions-label` immediately
   after it in the same reordering pass, or add it to whatever
   top-layers list that call belongs to. Verify with
   `map.getStyle().layers.map(l => l.id)` and compare indices — do not
   trust source order alone in this repo.

4. **Toggle + refresh.** `toggleDimensions()` / `refreshDimensions()`
   from `[WPG] web/src/main.js:2288`. Note Winnipeg recomputes labels
   whenever the parcel set changes, not only when the toggle flips —
   wire the equivalent into MB's search-complete path or the labels go
   stale after the next search.

5. **Decide the source FC.** Per B.3 this is the real decision, not an
   implementation detail. Winnipeg passes survey lots; MB has only
   Roll_Entry parcels.

## B.5 Font stack warning

`dimensions-label` uses `Open Sans Semibold`. Confirm it exists in
whatever glyph stack MB's basemap style points at before assuming the
labels will render — a missing fontstack fails silently as "no labels
at all", which reads as a broken toggle. There is a branch in this repo
named `fix/route-stop-rank-fontstack`, so this has bitten before.

---

# Verification checklist

Whatever subset gets built:

- **Layer order, programmatically.** In the console:
  `const ids = _map.getStyle().layers.map(l => l.id);`
  `[ids.indexOf('dimensions-label'), ids.indexOf('muni-parcels-civic-label')]`
  — dimensions must be the HIGHER index. Confirm after the map's
  `load` handler has fully run, since `moveLayer` calls fire late.
- **PNG export.** Click "Map w/Legend" and read the legend in the
  actual PNG, not just on screen. The two render through different
  code paths (`lib/mapLegend.js` re-draws from scraped text).
- **Legend height** at a short viewport, with the longest plausible
  result set.
- `npm test` in `web/`.

# A note on the Winnipeg side

Winnipeg's reorder also placed `dimensions-label` above the
dwelling-unit labels, since those are added after the civic addresses
there. That was flagged in PR #13 as an open question and has not been
revisited. If MB grows dwelling-unit labels and dimensions in the same
view, decide the intended stacking deliberately rather than inheriting
Winnipeg's accident.
