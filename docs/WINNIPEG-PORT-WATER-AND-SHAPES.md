# Port guide — Water Influence + Map Area-Selection Tools

Written 2026-08-04 for porting two mb-parcelsearch features into the
Winnipeg project (`D:\Dropbox\ClaudeCode\WpgOpenData\ParcelSearch`).
Self-contained by design: drop this file into a fresh session opened in
the target repo, per the porting convention in
`docs/archive/WINNIPEG_HISTORICAL_PORT.md`.

Source repo: `D:\Dropbox\ClaudeCode\MBOpenData\mb-parcelsearch`
(github.com/jayschellenberg/manitoba-opendata-parcelsearch). All file
paths below are relative to it unless marked otherwise.

Two features, very different port costs:

| Feature | Port cost | Why |
|---|---|---|
| **B. Area-selection shape tools** | Low — mostly copy files | Pure geometry + one map module; no data pipeline |
| **A. Water influence** | High — the detection must be rebuilt | The app side is a thin bridge; the classification lives in an R pipeline whose rural assumptions don't transfer to Winnipeg |

Do B first. It works on day one against any result set that has parcel
geometry.

---

# Part A — Water Influence (waterfront / near-water)

## A.1 What the user sees

- A **Water** grid column: colour dot + "Red River · 60 ft" per parcel,
  tooltip with class, body, type, distance, and a screening-aid caveat.
- Two **search filters** on one row: "Waterfront only" and "Near water
  (no frontage)" — tick either or both.
- A **Water Influence map overlay**: result parcels painted on a blue
  ramp, dark = frontage, pale = near-water.
- Five CSV export columns: Water / Water Class / Water Body / Water
  Type / Water Distance (ft) — bare values for pivoting.

## A.2 The one rule that is not negotiable

**Frontage and near-water-without-frontage are different markets.**
The class column exists because a lot fronting the Red River and a lot
across the road from it are both "near water" and are NOT comparable.
Never collapse the classes into a Yes/No. The seven classes:

| Class | frontage? | meaning |
|---|---|---|
| Direct | yes | boundary touches water |
| Waterfront | yes | within frontage distance, corridor open |
| Reserve Separated | yes | water behind a reserve/amenity strip (still frontage value) |
| Road Separated | no | a road between lot and water |
| Corridor Blocked | no | another private parcel between |
| No Corroboration | no | near an unnamed feature that couldn't be confirmed |
| None | — | nothing within 164 ft (not shipped, see A.4) |

## A.3 Architecture — three repos, one data flow

```
DETECTION   mao-assembly (R)      prepare_water_data.R -> inputs/MB_Water_Features.gpkg
            (D:\Dropbox\ClaudeCode\MBOpenData\mao-assembly)
                                  1CombineMBFiles.R    -> results/MAOParcelOutput<date>.parquet
                                     5 columns: WaterInfluence, WaterInfluenceClass,
                                     WaterBodyType, WaterBody, WaterDistanceFt
BRIDGE      mb-parcelsearch       r/build_water.R      -> per-muni JSON shards + _index.json
PUBLISH     mb-parcel-data        committed, served via raw.githubusercontent pinned to a COMMIT SHA
APP         mb-parcelsearch/web   arcgis.js fetch -> main.js stamp -> lib/water.js render
```

The app never computes anything about water. It joins pre-baked
verdicts by roll number. That separation is the whole reason the app
side is portable: Winnipeg needs its own detection, but the shard
contract, the lib, and the UI move over nearly unchanged.

## A.4 The shard contract (this is the port surface)

Per-municipality JSON (for Winnipeg: probably per-neighbourhood or one
city file — anything that keys off your fabric's lookup unit), plus a
manifest:

```
water/_index.json      { "<MUNI NAME>": { "file": "X.json", "count": n, "yes": n }, ... }
water/X.json           { "<roll>": { "i": "Yes"|"No", "c": "<class>", "t": "<type>",
                                     "b": "<body name>", "d": <whole feet, optional> }, ... }
```

Decisions baked into that shape, all deliberate:

- **Only non-"None" parcels ship.** 370k of Manitoba's 438k parcels
  have no water within 164 ft; shipping them would inflate the payload
  sixfold to say nothing. Consequence: absence-from-shard is a MEANING,
  which forces the three-state rule below.
- **Three cell states, kept distinct.** `_water` stamped → classified;
  shard loaded but roll absent → "No water" (checked, clean); shard
  never loaded (`_waterLoaded` falsy) → blank. Rendering "No water"
  when the shard simply failed to load would be a confident lie, and
  the filters gate on `_waterLoaded` so an unreachable CDN cannot
  silently empty the grid.
- **`d` is whole feet, converted once.** Geometry is metric (UTM);
  the conversion to feet happens once on the way out of the bridge.
  Whole feet because the parcel fabric itself moves lots by ~4 ft
  between refreshes — decimals would imply precision the sources lack.
  Frontage is argued in feet, hence the unit.
- **Distance ships at all** because no frontage threshold is right in
  every community (amenity-strip widths are developer choices, not a
  standard). A borderline parcel shows its measurement so an appraiser
  can adjudicate instead of trusting a verdict.
- **Cache keys include the data revision**
  (`mb_water_<file>_v1_<REVISION>`). We shipped the bug where they
  didn't: a revision bump did NOT invalidate cached shards, so browsers
  served stale verdicts for up to the 30-day TTL. Include your data
  version in the key from day one.

## A.5 Files to port (app side)

| File | Portability |
|---|---|
| `web/src/lib/water.js` | **Verbatim.** Single source of truth: WATER_CLASSES (keys, labels, colours, `frontage` flag), `waterClass/waterColor/waterCellText/waterTooltip/waterSortRank/waterDistance/formatWaterDistance/waterCsvCells/isWaterfront/isNearWater`. Pure, no map/DOM. |
| `web/test/water.test.js` | **Verbatim.** Locks the frontage-vs-near split, the three states, cell text with distance, sort rank (class dominates, distance tie-breaks within class), CSV cells. |
| `web/src/arcgis.js` (`fetchWaterIndex/fetchWaterForMuni`) | Pattern copy — ~60 lines. Swap the CDN base + manifest lookup for your hosting. |
| `web/src/main.js` (`stampWaterInfluence`, `waterCell`, filter wiring) | Pattern copy. Stamp `_water` + `_waterLoaded` on rows after search; `waterCell` renders dot+text+tooltip; filters below. |
| `web/src/map.js` (`water-fill`/`water-outline` + `setWaterInfluenceVisible`) | Pattern copy — standard overlay layers painted by `_waterColor`. |
| `r/build_water.R` | Pattern copy for your bridge. Note its completeness guard: it refuses a newest-but-partial input (< 80% of max row count) so an aborted pipeline run can't silently collapse the shards. |

## A.6 UI decisions that will silently regress if you don't know them

(Condensed from `HANDOFF-WATER-INFLUENCE.md` §8 — read that file for
the full reasoning.)

1. **The overlay is OFF by default and never auto-arms.** An early
   version armed it when a filter was ticked; the actual problem was
   button discoverability. Fix discoverability, don't take control.
2. **The filters re-run the search; they do not view-filter.** The
   rows in hand belong to the previous filter state; a view filter can
   only narrow what was already fetched. Debounce ~250 ms (switching
   filters fires two change events). There is also a roll pre-filter:
   in muni-wide searches, the shard's roll list constrains the ArcGIS
   query so "Waterfront only" returns ALL waterfront rolls, not
   the-first-N-then-filter (as a post-filter it returned 1 of 378 in
   Niverville).
3. **Palette is ONE blue ramp, dark = strongest influence.** Frontage
   takes the dark half, near-water the light half. Rejected: amber
   (reads as a warning on a desirable lot), teal (hue split carried no
   degree), pale blue-grey (vanished under the yellow parcel fill).
4. **While the overlay is on, the yellow `parcel-fill` drops to
   opacity 0 — NOT visibility none.** The fill is the hit-test layer
   for hover/click popups; hiding it kills them. Opacity keeps the
   events alive while the water colours paint unpolluted (0.7 over
   yellow tinted every colour).
5. **Column cell leads with the water body name** ("Red River"),
   because that is what an appraiser reads; class + caveats live in
   the tooltip. Distance rides along: "Red River · 60 ft".

## A.7 The detection side (what Winnipeg actually has to build)

The classification algorithm is ~500 lines of R inside
`mao-assembly/scripts/1CombineMBFiles.R` (V6.2 as of 2026-08-04) plus
the water-layer assembly in `prepare_water_data.R`. A dedicated
Winnipeg port analysis already exists — **read
`D:\Dropbox\ClaudeCode\MBOpenData\mao-assembly\docs\WINNIPEG-WATERFRONT-PORT.md`
before writing any code.** Highlights:

- **Winnipeg is not in the MAO fabric** — your parcel source is the
  Winnipeg repo's own. The detection needs: parcel polygons, a water
  layer, a road layer, all in one metric CRS (UTM 14N).
- **200 Winnipeg retention ponds are already fetched** and sitting in
  `MB_Water_Features.gpkg` (102 NHN rescue + 98 OSM). Do not refetch.
- **Three rural assumptions do NOT transfer:** the 66-ft Crown road
  allowance (drives the boundary-distance bands), the public-reserve
  bypass (keys on rural zoning vocabulary), the 40-acre large-parcel
  filter.
- **Loosen the OSM allowlist for Winnipeg:** the Manitoba build
  rejects `water=lake`, but Winnipeg stormwater ponds are routinely
  named "lakes" (Linden Lake, Muir Lake…). KEEP the Polsby-Popper
  compactness ≥ 0.15 guard — it is what stops river reaches being
  mislabelled ponds, and it needs no name regex.
- **Check Winnipeg Open Data first** for an authoritative municipal
  stormwater layer before leaning on OSM at all.
- Algorithm history worth knowing: V6.1 fixed retention ponds
  (0 → 699 parcels; the trust exemption was keyed to a source with 2
  polygons province-wide). V6.2 added the containing-parcel fallback —
  when the pond sits inside a common amenity parcel every lot abuts,
  the corridor check fails BY CONSTRUCTION and the verdict falls to
  boundary distance with a 64-ft threshold calibrated on ten
  ground-truthed lots (Kingsley Gate, Niverville, 10/10). That
  threshold is one subdivision's calibration — Winnipeg will need its
  own, and `WaterDistanceFt` shipping to the UI is the safety valve
  for wherever the threshold is wrong.

---

# Part B — Area-Selection Shape Tools (radius / rectangle / polygon)

## B.1 What the user sees

Matrix-MLS conventions. A topbar toolbar (next to Hide/Expand Map):
◯ radius, ▭ rectangle, ⬠ polygon, ⌫ clear-all.

- **Radius**: click centre → live dashed preview + a pill riding the
  cursor showing the radius ("650 m" / "2.35 km") → click to commit.
- **Rectangle**: click corner → preview → click opposite corner.
- **Polygon**: click vertices → double-click, or click the first
  vertex (12 px snap), to close; needs 3+. Esc cancels any tool.
- A committed shape renders as fill + outline + a **centre dot** with
  a badge: "Include · 2.35 km" (circles carry their radius) or just
  the mode word. Green = include, red = exclude. **Clicking the dot or
  anywhere in the fill flips Include ↔ Exclude.**
- Results narrow live: table, map highlight, count line ("X of Y
  parcels shown (area filter)"), and export all together.

## B.2 Filter semantics (the pure contract)

Membership is tested against the **parcel centroid** (bbox midpoint),
not polygon overlap — consistent with the app's other distance
measures, cheap at any size, unambiguous for a parcel straddling an
edge. Rules, in order:

1. No shapes → filter off, everything passes.
2. Inside ANY exclude shape → dropped. **Exclude always wins** (an
   exclude hole cut into an include area behaves as expected).
3. If at least one include shape exists, the point must be inside one;
   with only exclude shapes, everything outside them passes.
4. A row with **no placeable centroid fails** once any shape exists —
   silently passing unplaceable rows would leak them into an
   area-narrowed comp set.

Circles are tested by **great-circle distance to the centre**; the
rendered 64-segment ring is display-only, so the test and the picture
can never disagree by more than the ring's segment error.

## B.3 Files to port

| File | Portability |
|---|---|
| `web/src/lib/shapeFilter.js` | **Verbatim** (only import: `haversineKm` — inline it if you have no routeSolver). `pointInRing` (ray cast), `pointInShape`, `passesShapeFilter`, `circleRing`, `rectRing`, `formatKm`, `shapesToFc`. |
| `web/test/shapeFilter.test.js` | **Verbatim.** Covers concave rings, the full include/exclude matrix, closed/open rings, degenerate inputs, ring builders, the FC shape. |
| `web/src/drawShapes.js` | Near-verbatim (MapLibre or Mapbox GL both fine). State machine, preview, radius readout, layers, toolbar wiring, click routing. |
| Topbar markup (index.html `#shape-tools`) + CSS (`.shape-tools`, `.shape-tool-btn`, `.shape-radius-readout`, `body.shape-drawing` cursor rule) | Copy and restyle. |

Integration points in the target app (the only real work):

1. `addShapeLayers(map)` at the END of your layer init, so shapes draw
   on top of parcel fills.
2. `initShapeDraw(map)` right after map construction.
3. `onShapesChanged(cb)` → your re-filter path. Predicate:
   `if (shapes.length > 0 && !passesShapeFilter(centroid(row), shapes)) drop`.
4. Your parcel-click popup handler: first line
   `if (shapeClickHandled(map, e)) return;`.
5. Your hover handler: stand down while `isShapeDrawing()`.
6. Clear shapes (`clearShapes()`) on fresh search; if you narrow an
   already-rendered set, snapshot the full rows on first shape use and
   restore on erase (see `refilterBasicByShapes` in main.js — the
   snapshot means erasing needs no re-search).

## B.4 Hard-won gotchas (each of these was a real bug or rejected design)

1. **Don't share a mapbox-gl-draw instance with another feature.** Our
   measure tool owns the page's MapboxDraw (its modes, styles,
   deleteAll lifecycle); the shape tools are hand-rolled on plain map
   events precisely to avoid coupling two features' lifecycles. If
   your app has no draw library at all, hand-rolling is ~150 lines and
   this file is it.
2. **The toggle-over-empty-map bug.** First version toggled
   include/exclude only from inside the parcel-fill click handler — so
   a shape drawn over empty map could never be flipped. The module's
   own general `map.on('click')` must own the toggle, and it marks the
   DOM event consumed (by object identity) so parcel handlers firing
   after it skip their popups without double-toggling. Handler
   registration order matters: register the shape module's handler
   BEFORE the layer popup handlers.
3. **Badges/dots must be Point features, not symbols on the polygon.**
   MapLibre's GeoJSON tiler treats each tile-clipped polygon fragment
   as its own symbol-placement candidate — an RM-sized shape grows one
   badge per tile it spans. Emit a Point per shape in the FC alongside
   the Polygon (`shapesToFc` does this) and filter the layers by
   `$type`.
4. **Disable doubleClickZoom while the polygon tool is armed**, or
   closing a polygon zooms the map. Re-enable on disarm. Also: the
   dblclick is preceded by two click events that each pushed the same
   end vertex — drop the duplicate before closing.
5. **Suppress hover popups + set a crosshair cursor while armed**
   (body class, same pattern as a measuring mode), or the tooltip
   sits on top of the exact point being aimed at.
6. **Zero-result no-refit.** When a filter narrows to zero rows, do
   NOT re-fit the map to the empty FC — keep the viewport so the user
   sees "0 of N shown" with geographic anchor intact.
7. **The count line must always name the narrowing** ("X of Y parcels
   shown (area filter)") — a filter the user can forget they drew, on
   a map they may have panned away from, must never silently empty
   the grid.
8. A **stale include shape from a previous area** filters everything
   out. We clear shapes on every fresh Search; if you choose
   persistence instead, the count line is your only defence.

## B.5 Suggested port order

1. Copy `lib/shapeFilter.js` + test; run the test. (Pure — no app.)
2. Copy `drawShapes.js`; wire `initShapeDraw` + `addShapeLayers`;
   confirm you can draw and toggle shapes on the map with no filter.
3. Wire `onShapesChanged` into your result filtering + count line.
4. Add the popup/hover guards.
5. Steal the UX affordances last: radius readout, centre dot, Esc,
   crosshair.
