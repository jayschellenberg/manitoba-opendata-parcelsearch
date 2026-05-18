# Parcel Search Tool — Replication Guide

This document explains how to build the same parcel-search tool for a different jurisdiction. It covers the full architecture, every non-obvious decision, every bug already solved, and the exact checklist of files and lines to change.

> **Two reference implementations** — this guide was originally written from the Winnipeg Open Data (Socrata) site. The same architecture has since been adapted to Manitoba Open Data (ArcGIS REST), and §14 below captures every Manitoba-specific decision, gotcha, and feature that wasn't present in the Winnipeg original.

---

## Table of Contents

1. [What the tool does](#1-what-the-tool-does)
2. [Architecture overview](#2-architecture-overview)
3. [Repository structure](#3-repository-structure)
4. [Step 0 — Probe the new data source](#4-step-0--probe-the-new-data-source)
5. [Step 1 — Adapt `soda.js` (the data layer)](#5-step-1--adapt-sodajs-the-data-layer)
6. [Step 2 — Adapt `index.html` (search inputs + table columns)](#6-step-2--adapt-indexhtml-search-inputs--table-columns)
7. [Step 3 — Adapt `main.js` (UI wiring + table render)](#7-step-3--adapt-mainjs-ui-wiring--table-render)
8. [Step 4 — Adapt `map.js` (popup labels + colour palette)](#8-step-4--adapt-mapjs-popup-labels--colour-palette)
9. [Step 5 — Deploy to Vercel](#9-step-5--deploy-to-vercel)
10. [Bugs and gotchas already solved](#10-bugs-and-gotchas-already-solved)
11. [SoQL quick reference](#11-soql-quick-reference)
12. [Non-Socrata portals](#12-non-socrata-portals)
13. [Local dev workflow](#13-local-dev-workflow)
14. [Manitoba (ArcGIS REST) implementation notes](#14-manitoba-arcgis-rest-implementation-notes)
15. [Bulk roll-number search](#15-bulk-roll-number-search)

---

## 1. What the tool does

- **Legal-description search** (Lot / Block / Plan / Description): queries a **Survey Parcels** dataset, then back-fills Roll # / Address / Zoning by spatially joining an **Assessment Parcels** dataset.
- **Assessment-first search** (Roll # / Address / Zoning): queries the Assessment Parcels dataset *and* (optionally) cross-references a **Civic Addresses** dataset so that searching by any of a parcel's official addresses surfaces the parcel even if it's not the primary assessment address. Survey Parcels are then back-filled to populate the legal-description columns.
- Every search renders **two map layers simultaneously**: blue = survey lots, red = assessment parcels. The two often differ — one assessment can span many survey lots, and one survey lot can be split between rolls.
- The Address column on each row is enriched with **every civic address** falling inside the parcel polygon (so a parcel with primary "400 Hargrave" but an additional civic address "440 Hargrave" displays both, and is searchable from either direction).
- Optional **zoning overlay** (toggle button) draws zoning-by-law polygons under the parcel layers, coloured by category, with click-popups showing zoning code + description.
- Results table includes: Lot, Block, Plan, Description, Roll #, Full Address, Zoning, Lot Size (sf), Lat, Lon. Sortable by any column. **CSV export**, **map-click → row scroll**, **row click → map fly-to-parcel**, **combined hover popup** for overlapping layers, **layer toggles**, and a top-of-page **explainer** describing the difference between survey and assessment parcels.

---

## 2. Architecture overview

```
Browser
  │
  ├─ index.html          Static shell: inputs, map div, results table, explainer
  ├─ src/main.js         UI wiring — reads inputs, calls soda.js, renders table+map
  ├─ src/soda.js         API client — every SODA/SoQL query lives here
  ├─ src/map.js          MapLibre GL setup, two parcel layers, zoning overlay,
  │                      hover/click popups, fly-to-feature
  └─ src/style.css       All CSS
        │
        │   fetch (GeoJSON, CORS open)
        ▼
  data.winnipeg.ca  ←── swap this for the new jurisdiction's endpoint
  Socrata SODA API
  sjjm-nj47   Survey Parcels   (legal lots — Lot/Block/Plan)
  d4mq-wa44   Assessment Parcels (rolls — civic address, zoning, area)
  cam2-ii3u   Addresses          (every civic-address point — for multi-address xref)
  dxrp-w6re   Zoning By-law      (optional overlay layer)
```

**No server, no database, no auth.** Vercel just serves the Vite bundle. All data is queried by the browser on every search.

A typical search fires multiple SODA calls in parallel and merges them client-side:

1. **Attribute query** — Survey Parcels by Lot/Block/Plan, or Assessment Parcels by Roll/Address/Zoning.
2. **Address cross-reference** (when the address field is filled) — Civic Addresses dataset, find parcels containing each matching address point.
3. **Spatial enrichment** — per-feature `within_box` queries against the *other* parcel dataset (assessment-side for legal flow, survey-side for assessment flow). Batched 50 clauses per request, run in parallel.
4. **Civic-address enrichment** — per-parcel `within_box` against the Addresses dataset, attaching the full civic-address list to each result.
5. **Partial-lot detection** (assessment flow) — counts how many assessments overlap each survey lot; lots overlapping >1 are flagged "(partial)".
6. **Zoning overlay** (when toggled on) — per-parcel `within_box` against the Zoning By-law dataset.

All spatial filters use `within_box` with a 150 m bbox pad (because Socrata's `within_box` requires *containment*, not intersection — see [Bug 10.2](#102-within_box-uses-containment-not-intersection)). Client-side `booleanPointInPolygon` then re-checks every match to eliminate false positives. The bidirectional `parcelsOverlap` check (assessment-centroid-in-survey OR survey-bbox-center-in-assessment) handles both 1:N and N:1 alignment cases.

**Dependencies** (`web/package.json`):

- `maplibre-gl` — the map (no API key, CartoDB Positron raster basemap)
- `@turf/bbox` — bounding boxes
- `@turf/boolean-intersects` — defensive fallback when centroid coords are missing
- `@turf/boolean-point-in-polygon` — the primary client-side join primitive

---

## 3. Repository structure

```
repo-root/
├── vercel.json            Build config: points Vercel at web/
├── README.md              User-facing summary + live URL
├── REPLICATION_GUIDE.md   This document
├── r/                     R scripts for local historical archive (not part of web tool)
└── web/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.js
        ├── map.js
        ├── soda.js
        └── style.css
```

`vercel.json`:
```json
{
  "buildCommand": "cd web && npm install && npm run build",
  "outputDirectory": "web/dist",
  "framework": "vite"
}
```

---

## 4. Step 0 — Probe the new data source

### 4.1 Does the portal use Socrata?

Look for a Socrata logo or `/resource/` in dataset URLs. Socrata powers most Canadian municipal open-data portals (Winnipeg, Calgary, Edmonton, etc.). If you see URLs like:

```
https://data.example.ca/resource/xxxx-xxxx.geojson
```

you have Socrata and everything in this guide applies directly. Manitoba Open Data (`opendata.gov.mb.ca`) is **not** Socrata — see [Section 12](#12-non-socrata-portals).

### 4.2 Find the four datasets (or whatever subset exists)

| Winnipeg dataset | Required? | What it provides |
|---|---|---|
| Survey Parcels (`sjjm-nj47`) | yes | Lot / Block / Plan / Description + polygon geometry |
| Assessment Parcels (`d4mq-wa44`) | yes | Roll #, civic address, zoning, area, centroid + polygon geometry |
| Addresses (`cam2-ii3u`) | optional | Every official civic address with point geometry. Without it, multi-address parcels are only findable by their primary address. |
| Zoning By-law Parcels (`dxrp-w6re`) | optional | Coloured zoning overlay. The tool still works without it; just delete the toggle button and the related code. |

If the new jurisdiction collapses Survey + Assessment into one dataset, the two-flow architecture simplifies to one flow and you can delete the cross-side enrichment.

### 4.3 Confirm the field names

Fetch one row with all columns:

```
https://data.example.ca/resource/DATASET-ID.json?$limit=1
```

For Winnipeg's Assessment Parcels the relevant columns are:
`roll_number, full_address, zoning, centroid_lat, centroid_lon, assessed_land_area, geometry, ...`

### 4.4 Confirm geometry column names (they vary across datasets!)

Socrata GeoJSON endpoints embed geometry, but the **column name used in `within_box(...)`** can differ per dataset. In Winnipeg:

- `location` — Survey Parcels (multipolygon), Civic Addresses (point)
- `geometry` — Assessment Parcels (multipolygon), Zoning By-law (polygon)
- `point` — Civic Addresses also has a Point-typed `point` column (we use this one for the address xref because it's unambiguous)

To find the right name, hit the dataset metadata:

```
https://data.example.ca/api/views/DATASET-ID.json
```

and look for fields with `renderTypeName: "multipolygon"` / `"point"`. The `fieldName` is what goes in `within_box(fieldName, ...)`.

### 4.5 Test a SoQL query in your browser

```
https://data.example.ca/resource/DATASET-ID.geojson
  ?$where=upper(lot) like '%50%' AND upper(block) like '%RL%'
  &$limit=5
```

Confirm you get a GeoJSON FeatureCollection with polygon geometry. If you get a 200 with `{"error":true}`, the column names are wrong.

### 4.6 Check CORS

Open DevTools → Network and look for `Access-Control-Allow-Origin: *` on a response. Socrata always sets this. Non-Socrata portals sometimes don't — if missing, you'll need a Vercel Edge Function as a proxy (~10 lines).

---

## 5. Step 1 — Adapt `soda.js` (the data layer)

This is the only file that knows about the data source. Everything downstream is generic.

### 5.1 Swap the base URLs and dataset IDs

```js
const SURVEY_URL    = 'https://data.example.ca/resource/AAAA-AAAA.geojson';
const ASSESS_URL    = 'https://data.example.ca/resource/BBBB-BBBB.geojson';
const ADDRESSES_URL = 'https://data.example.ca/resource/CCCC-CCCC.json';   // optional
const ZONING_URL    = 'https://data.example.ca/resource/DDDD-DDDD.geojson'; // optional
```

The Addresses URL uses `.json` (not `.geojson`) because the dataset typically has multiple geometry columns and we want to be explicit about which one to interpret as the point. `searchAddresses` builds GeoJSON features manually from the `point` column.

### 5.2 Update `searchSurveyParcels` field names

```js
export async function searchSurveyParcels({ plan, lot, block, desc }) {
  const clauses = [];
  if (plan)  clauses.push(likeClause('plan', plan));    // ← the column name in the new dataset
  if (lot)   clauses.push(likeClause('lot', lot));
  if (block) clauses.push(likeClause('block', block));
  if (desc)  clauses.push(likeClause('description', desc));
  // ...
}
```

If the new dataset uses different column names (e.g. `lot_number` instead of `lot`), just change the string in `likeClause('lot_number', lot)`.

### 5.3 Update `searchAssessmentParcels` field names + `$select`

```js
export async function searchAssessmentParcels({ roll, address, zoning }) {
  const clauses = [];
  if (roll)    clauses.push(likeClause('roll_number', roll));
  if (address) clauses.push(likeClause('full_address', address));
  if (zoning)  clauses.push(likeClause('zoning', zoning));
  // ...
  const params = new URLSearchParams({
    $where: clauses.join(' AND '),
    $select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,geometry',
    $order: 'full_address',
    $limit: '1000',
  });
}
```

### 5.4 Update `fetchAssessmentOverlap` and `fetchSurveyOverlap`

```js
export async function fetchAssessmentOverlap(surveyFc) {
  return fetchPerFeatureBboxUnion({
    baseUrl: ASSESS_URL,
    geomColumn: 'geometry',   // ← the SoQL column name for the assessment polygon
    select: 'roll_number,full_address,zoning,centroid_lat,centroid_lon,assessed_land_area,geometry',
    dedupeKey: 'roll_number',
    fc: surveyFc,
  });
}

export async function fetchSurveyOverlap(assessFc) {
  return fetchPerFeatureBboxUnion({
    baseUrl: SURVEY_URL,
    geomColumn: 'location',   // ← Winnipeg calls survey geometry 'location'
    select: null,             // null = all columns
    dedupeKey: 'id',
    fc: assessFc,
  });
}
```

### 5.5 Update the address cross-reference (if the new portal has an addresses dataset)

```js
export async function searchAddresses({ address }) {
  if (!address) return { type: 'FeatureCollection', features: [] };
  const params = new URLSearchParams({
    $where: likeClause('full_address', address),  // ← address column
    $select: 'full_address,point',                // ← geometry column = 'point'
    $order: 'full_address',
    $limit: '1000',
  });
  // ... fetches .json, builds GeoJSON Point features manually
}
```

`searchAddressesAndFindParcels` and `fetchAssessmentByAddressPoints` then chain the points through a per-point `within_box` to find the containing assessment. **Skip this entirely if no addresses dataset is available** — `searchAssessmentParcelsExpanded` falls back to the direct query alone when `address` is empty, so the assessment-first flow still works without the xref.

### 5.6 Update the civic-address enrichment

`enrichAssessmentAddresses` mutates each parcel's `full_address` to a comma-joined list of every civic address inside its polygon (primary first, others alphabetical). Wrapping every external call in try/catch is critical — civic enrichment is non-essential and must never block the primary search results from rendering. Failures degrade gracefully to "primary address only".

### 5.7 Update `fetchZoningOverlap` (if zoning is wanted)

```js
export async function fetchZoningOverlap(parcelFc) {
  return fetchPerFeatureBboxUnion({
    baseUrl: ZONING_URL,
    geomColumn: 'location',   // ← Winnipeg's zoning geometry column
    select: 'id,zoning,short_description,long_description,map_colour,location',
    dedupeKey: 'id',
    fc: parcelFc,
  });
}
```

The categorical fill colour in `map.js` is driven by the `map_colour` field — if your dataset has different category names, update the `ZONING_PALETTE` array there to match.

### 5.8 Keep these unchanged

- `fetchPerFeatureBboxUnion` — generic batching/parallel/dedupe helper, takes `{ baseUrl, geomColumn, select, dedupeKey, fc, extraWhere }`. **Don't modify** unless the new portal has a different spatial-query syntax (see [Section 12](#12-non-socrata-portals)).
- `parcelsOverlap`, `assessCentroidInSurvey`, `surveyCenterInAssess` — bidirectional client-side overlap check. The bidirectional logic correctly handles both 1-survey-many-assessments (duplexes) and 1-assessment-many-surveys (downtown buildings) cases.
- `mergeSurveyFeatures`, `mergeAssessFeatures` — collapse multiple matching features per row into a single synthetic feature with grouped lots, range-collapsed numbers (`21-25, 68-75`), plan-grouped breakdowns when more than one plan is involved (`21-25 (Pl 129); 39-46 (Pl 24208)`), and `(partial)` suffixes for split lots.
- `computePartialSurveyIds`, `filterMatchedSurveys`, `filterMatchedAssessments` — used by main.js to drive the dual-layer map render and partial detection.
- `likeClause` — the case-insensitive wrap (`upper(col) LIKE '%VAL%'`). Critical (see [Bug 10.1](#101-like-is-case-sensitive)).
- `escapeSoql` — doubles single quotes per SoQL spec.

---

## 6. Step 2 — Adapt `index.html` (search inputs + table columns)

### 6.1 Search inputs

Each input has:

- An `id` that `main.js` reads
- A `size` attribute controlling visual width (in characters)
- A `placeholder` shown when empty
- A `<span class="tip">` sibling shown on focus as a tooltip

```html
<span class="field">
  <input id="lot" type="text" size="12" placeholder="Lot" />
  <span class="tip">Lot (or River Lot or Section)</span>
</span>
```

Change the `id`, `placeholder`, and `.tip` text to match the new jurisdiction's terminology (e.g. "Concession" / "Range" for Ontario surveys).

### 6.2 Table columns

```html
<thead>
  <tr>
    <th data-col="lot">Lot</th>
    <th data-col="block">Block</th>
    <th data-col="plan">Plan</th>
    <th data-col="desc">Description</th>
    <th data-col="roll">Roll Number</th>
    <th data-col="address">Full Address</th>
    <th data-col="zoning">Zoning</th>
    <th data-col="area">Lot Size (sf)</th>
    <th data-col="lat">Lat</th>
    <th data-col="lon">Lon</th>
  </tr>
</thead>
```

Each `data-col` attribute drives the click-to-sort behaviour in `main.js`. The column order must match `renderTable`'s cell-append order; if you add or remove columns, update both files plus the `SORT_KEYS` map and the `exportCsv` header list.

### 6.3 Top-of-page explainer

```html
<details class="explainer" open>
  <summary>What's the difference between Survey and Assessment parcels?</summary>
  <div class="explainer-body">...</div>
</details>
```

Tailor the wording to the new jurisdiction's parcel types. The legend pills inside use `.legend-pill.survey` / `.legend-pill.assess` colour classes from `style.css`.

### 6.4 Layer-toggle and zoning buttons

```html
<button id="survey-toggle" type="button" class="secondary active" aria-pressed="true">Hide Survey</button>
<button id="assess-toggle" type="button" class="secondary active" aria-pressed="true">Hide Assessment</button>
<button id="zoning-toggle" type="button" class="secondary" aria-pressed="false">Show Zoning</button>
```

Drop the zoning button if the new jurisdiction doesn't have a zoning dataset.

### 6.5 Map legend

```html
<div id="map">
  <div id="map-legend" class="map-legend" hidden>
    <strong>Legend</strong>
    <ul>
      <li><span class="swatch survey"></span>Survey parcel (legal lot)</li>
      <li><span class="swatch assess"></span>Assessment parcel (roll/building)</li>
    </ul>
  </div>
</div>
```

Positioned in the bottom-right of the map by `style.css`. Toggled hidden/visible by `main.js` based on whether there are any results.

---

## 7. Step 3 — Adapt `main.js` (UI wiring + table render)

### 7.1 Input element bindings

```js
const $lot     = document.getElementById('lot');
const $block   = document.getElementById('block');
const $plan    = document.getElementById('plan');
const $desc    = document.getElementById('desc');
const $roll    = document.getElementById('roll');
const $address = document.getElementById('address');
const $zoning  = document.getElementById('zoning');
```

Add/remove variables here if the new form has different fields.

### 7.2 Which flow runs

```js
const anyLegal  = inputs.lot || inputs.block || inputs.plan || inputs.desc;
const anyAssess = inputs.roll || inputs.address || inputs.zoning;

if (anyAssess) {
  await runAssessmentSearch(inputs);
} else {
  await runLegalSearch(inputs);
}
```

If the new jurisdiction has only one combined dataset, delete one flow and always call the other.

### 7.3 `setParcels(surveyFc, assessFc)` — both layers always

```js
function setParcels(surveyFc, assessFc = EMPTY_FC) {
  // Pushes both FeatureCollections into the map (blue + red layers),
  // fits to the union of both, and toggles the floating legend.
}
```

Both flows now call `setParcels` with both FCs:

- Legal flow: `setParcels(surveyFc, filterMatchedAssessments(assessFc, surveyFc))`
- Assessment flow: `setParcels(filterMatchedSurveys(surveyFc, assessFc), assessFc)`

The `filterMatched*` helpers also stamp `_rowKey` on the secondary layer so a click on either colour scrolls to the matching table row.

### 7.4 `renderTable` — cell order

```js
tr.appendChild(td(s.lot));
tr.appendChild(td(s.block));
tr.appendChild(td(s.plan));
tr.appendChild(td(s.description));
tr.appendChild(td(a.roll_number));
tr.appendChild(td(a.full_address));
tr.appendChild(td(a.zoning));
tr.appendChild(td(formatArea(a.assessed_land_area), 'num'));
tr.appendChild(td(formatCoord(a.centroid_lat), 'num'));
tr.appendChild(td(formatCoord(a.centroid_lon), 'num'));
```

`s` = survey-side properties (possibly merged via `mergeSurveyFeatures`), `a` = assessment-side. Change the property names to match the new dataset's column names.

### 7.5 `SORT_KEYS` — sortable columns

```js
const SORT_KEYS = {
  lot:     (r) => numOrStr(r.survey?.properties?.lot),
  block:   (r) => strKey(r.survey?.properties?.block),
  plan:    (r) => numOrStr(r.survey?.properties?.plan),
  desc:    (r) => strKey(r.survey?.properties?.description),
  roll:    (r) => strKey(r.assess?.properties?.roll_number),
  address: (r) => strKey(r.assess?.properties?.full_address),
  zoning:  (r) => strKey(r.assess?.properties?.zoning),
  area:    (r) => finiteOrNeg(r.assess?.properties?.assessed_land_area),
  lat:     (r) => finiteOrNeg(r.assess?.properties?.centroid_lat),
  lon:     (r) => finiteOrNeg(r.assess?.properties?.centroid_lon),
};
```

Each key matches a `data-col` attribute in `index.html`. Update both files together when you change columns.

### 7.6 `exportCsv` — column list

```js
const header = [
  'Lot', 'Block', 'Plan', 'Description',
  'Roll Number', 'Full Address', 'Zoning',
  'Lot Size (sf)', 'Lat', 'Lon',
];
// ...
lines.push([
  s.lot, s.block, s.plan, s.description,
  a.roll_number, a.full_address, a.zoning,
  a.assessed_land_area ?? '',
  a.centroid_lat ?? '',
  a.centroid_lon ?? '',
].map(csvCell).join(','));
```

Update both lists in lockstep with `renderTable` and `SORT_KEYS`.

### 7.7 `tagFeatures` — row-key scheme

```js
function tagFeatures(fc, side) {
  for (const f of fc.features) {
    const p = f.properties || (f.properties = {});
    if (side === 'survey') {
      p._rowKey = p.id != null ? `s:${p.id}` : null;
    } else {
      p._rowKey = p.roll_number != null ? `a:${p.roll_number}` : null;
    }
  }
}
```

Change `p.id` and `p.roll_number` to the unique-identifier columns of the new datasets. These must be stable string or numeric values — they correlate map clicks with table rows. The `filterMatched*` helpers in `soda.js` then propagate these keys to the cross-side layer so clicks on either colour land on the same row.

### 7.8 `formatArea`

```js
function formatArea(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n).toLocaleString('en-US');
}
```

Winnipeg's `assessed_land_area` is in **square feet** as a plain integer string. If the new jurisdiction stores area in square metres, either convert (`n * 10.764`) or change the column header to `Lot Size (m²)`.

### 7.9 `clearAll = window.location.reload()`

The Clear button does a full page reload. Earlier versions tried soft resets (clearing inputs, table, map, sort state, in-flight requests one by one) and accumulated subtle drift bugs. A reload is the bulletproof reset.

---

## 8. Step 4 — Adapt `map.js` (popup labels + colour palette)

### 8.1 Layer order (bottom to top)

```
zoning-fill, zoning-line, zoning-label   (optional zoning overlay)
assess-context-fill, assess-context-line  (red — assessment parcels)
parcel-fill, parcel-line                  (blue — survey parcels)
```

Smaller polygons (surveys) on top so they don't get obscured by the bigger assessment fills below.

### 8.2 Combined hover popup

A single `mousemove` handler queries both `parcel-fill` and `assess-context-fill` at the cursor point. If both are under the cursor (the common case in the legal flow), the popup shows both blocks of info side-by-side under coloured headers. `combinedPopupHtml` detects which schema the primary feature carries by looking for `roll_number` or `full_address`.

Update the property names in `popupHtml` to match your new datasets' columns.

### 8.3 Click handlers

Both `parcel-fill` and `assess-context-fill` have a click handler that scrolls the table to `feature.properties._rowKey`. Both layers carry `_rowKey` after `filterMatched*` stamps them.

### 8.4 Zoning overlay

If the new portal has a zoning dataset, update `ZONING_PALETTE` to match the dataset's `map_colour` (or equivalent) categories:

```js
const ZONING_PALETTE = [
  'Single Family Residential',  '#fff4a3',
  'Two Family Residential',     '#ffd9a0',
  // ...
];
```

The MapLibre `match` expression in `zoning-fill`'s paint uses these. Adjust the labels list (`zoning-label` symbol layer) by changing the `text-field` filter — currently codes ≤5 chars are shown; tweak per how long zoning codes typically are in the new jurisdiction.

If the dataset uses a different "category" attribute name (not `map_colour`), update the `['get', 'map_colour']` reference in the layer paint and the `popupHtml` for zoning popups.

### 8.5 Colour theme

```
survey  fill: #4682b4  (steel blue)   line: #0b2566 (deep navy)   2px solid
assess  fill: #b22222  (firebrick)    line: #690000 (very dark red) 3px solid
```

Pick high-contrast complementary colours. Keep one cool and one warm so they read as obviously different. Update the `.swatch.survey`, `.swatch.assess`, `.legend-pill.survey`, `.legend-pill.assess` rules in `style.css` to match.

---

## 9. Step 5 — Deploy to Vercel

1. Push the repo to GitHub (public or private — both work on the free Hobby tier).
2. Go to `vercel.com/new`, import the repo.
3. Vercel reads `vercel.json` at the root and auto-configures the build.
4. Every `git push` to `main` triggers an automatic redeploy.

**Optional Socrata app token** (raises the anonymous rate limit from 1,000 to 100,000 requests/hour):

1. Register free at `https://data.example.ca/profile/edit/developer_settings`
2. Add `VITE_SODA_APP_TOKEN=<token>` in Vercel Project Settings → Environment Variables
3. Redeploy

`soda.js` already reads `import.meta.env.VITE_SODA_APP_TOKEN` — no code change.

---

## 10. Bugs and gotchas already solved

These are real bugs hit during development. They will likely recur with any Socrata-based parcel dataset.

### 10.1 `LIKE` is case-sensitive

**Symptom:** Searching `monarch` returns no results even though `10 MONARCH MEWS` exists.

**Root cause:** SoQL `LIKE` is case-sensitive. Data is often stored uppercase.

**Fix (`likeClause`):**
```js
function likeClause(column, value) {
  return `upper(${column}) like '%${escapeSoql(String(value).toUpperCase())}%'`;
}
```

### 10.2 `within_box` uses containment, not intersection

**Symptom:** A search for a small lot inside a much larger assessment parcel finds the lot but not the assessment, even though the lot clearly sits inside it.

**Root cause:** Socrata's `within_box(geom, ...)` returns only rows whose geometry is **fully contained** in the query box. A 100m-wide assessment parcel containing a 30m lot will *not* fit inside a tight bounding box around the lot.

**Fix:** Pad each per-feature bbox by 0.002° (~150m) on every side before the `within_box` call. The client-side `parcelsOverlap` then re-checks every match to eliminate false positives.

```js
const PAD_DEG = 0.002;
return `within_box(${geomColumn},${round(maxLat + PAD_DEG)},${round(minLon - PAD_DEG)},${round(minLat - PAD_DEG)},${round(maxLon + PAD_DEG)})`;
```

If the new jurisdiction has bigger parcels (e.g. industrial or rural), bump the pad. Wider pad = more candidates fetched but no false matches because of the client-side filter.

### 10.3 Spatially-spread searches hit the `$limit` before reaching the targets

**Symptom:** Searching for an address that matches two distant neighbourhoods (e.g. "Woodstock" *and* "Stockdale") returns results from both, but legal descriptions are blank for both.

**Root cause:** A single union bbox across spread results covers a huge area; `within_box` returns parcels in between and `$limit` runs out before the relevant ones.

**Fix:** One small `within_box` per feature, OR'd together, batched 50 per request, run in parallel via `Promise.all`. Each clause's bbox is tiny (just that one parcel ± 150m).

### 10.4 `booleanIntersects` triggers on shared edges

**Symptom:** A search for a single lot returns 5+ neighbouring addresses because adjacent parcels share boundary edges.

**Root cause:** `@turf/boolean-intersects` returns true for any shared point — including edge touches. Two parcels sharing a property line both register as "intersecting".

**Fix:** Check **centroid-in-polygon** instead. Specifically, `parcelsOverlap` is bidirectional:

```js
function parcelsOverlap(s, a) {
  return assessCentroidInSurvey(a, s)         // assessment centroid inside survey
      || surveyCenterInAssess(s, a);          // survey bbox center inside assessment
}
```

Both directions covered because:
- "Many surveys per assessment" (a downtown building over 20 lots): each survey's center is inside the assessment polygon → all 20 match.
- "Many assessments per survey" (a duplex split into 2 rolls): each assessment centroid is inside the same survey → both match.
- Adjacent parcels (no real overlap) fail both checks because neither centroid sits inside the *other* polygon.

### 10.5 Topology errors in turf.js

**Symptom:** Console shows `parcelsOverlap error; falling back to unmatched row`. Some rows have no enrichment.

**Root cause:** Some parcel geometries in the wild have self-intersections or other topology problems that crash turf.js.

**Fix:** Wrap the join in try/catch. The row still appears in the table; it just shows `—` in the unmatched columns.

### 10.6 Multi-address parcels look like missing data when reverse-searched

**Symptom:** Searching by Plan number that the user knows is part of "440 Hargrave" — the result row shows "400 HARGRAVE STREET" only, and the user can't tell it's the same parcel they previously found via "440 Hargrave".

**Root cause:** Assessment dataset stores only one primary address per parcel. The Addresses dataset (cam2-ii3u in Winnipeg) has every official address. Without enrichment, secondary addresses are invisible to the user.

**Fix:** `enrichAssessmentAddresses` does a per-parcel `within_box` against the Addresses dataset and rewrites `parcel.full_address` to a comma-joined list (primary first, others alphabetical). So the row now reads "400 HARGRAVE STREET, 440 HARGRAVE ST" — recognizable from any search direction.

### 10.7 Address enrichment failure must not block table render

**Symptom:** A search appears to succeed (correct count, table briefly shows survey-only rows) but the assess columns stay empty forever.

**Root cause:** An exception inside the address-enrichment helper unwound the async chain before `renderTable(joinSurveyWithAssessment(...))` could run.

**Fix:** Wrap the enrichment call site in try/catch *and* wrap each per-parcel iteration inside the helper. The user always gets at least the primary address; enrichment failures degrade gracefully.

### 10.8 Multi-lot parcels need plan-grouped lot lists

**Symptom:** A roll covering 20 lots across two plans displays one row per lot, repeating the same roll/address 20 times.

**Fix:** Both join functions collapse to one row per parcel with `mergeSurveyFeatures` / `mergeAssessFeatures`. The Lot column groups lots by plan and range-collapses sequential numbers:

```
"21-25, 68-75, 120-121 (Pl 129); 39, 41, 44-46 (Pl 24208)"
```

Single-plan merges drop the plan annotation. Non-numeric lots (RL10, fractional, etc.) fall back to a sorted comma-list since ranges aren't meaningful.

### 10.9 Partial-lot detection needs an extra fetch in the assessment flow

**Symptom:** A survey lot split between two assessment rolls (a duplex with two rolls) doesn't get flagged "(partial)" when searched by Roll #.

**Root cause:** In the assessment-first flow, `surveyFc` is the back-fill set — only surveys near the result parcels. To know whether a survey *also* extends into another assessment outside the search results, we need a separate query against the *full* assessment dataset.

**Fix:** After the join renders, fire an extra `fetchAssessmentOverlap(surveyFc)` and run `computePartialSurveyIds` on the result. Re-render the table with the partial flags applied. Non-fatal — failure leaves the table unmarked but otherwise fine.

### 10.10 Document visibility blocks MapLibre tile loading

**Symptom:** Map appears empty when loaded in headless / hidden-tab contexts.

**Root cause:** MapLibre defers tile loading when `document.visibilityState === 'hidden'`. The `map.on('load')` event never fires, so any code waiting on `mapReady` queues forever.

**Fix:** This is a benign quirk of how the map behaves in non-visible tabs. Real users don't hit it. For Chrome MCP / automated testing, override `document.visibilityState` before search.

---

## 11. SoQL quick reference

| Operation | SoQL syntax |
|---|---|
| Partial text match (case-sensitive) | `column like '%value%'` |
| Partial text match (case-insensitive) | `upper(column) like '%VALUE%'` |
| Exact match | `column = 'value'` |
| Multiple AND conditions | `clause1 AND clause2` |
| Multiple OR conditions | `clause1 OR clause2` |
| Spatial containment | `within_box(geom_col, nwLat, nwLon, seLat, seLon)` |
| Spatial intersection (where supported) | `intersects(geom_col, 'POINT(lon lat)')` |
| Select specific columns | `$select=col1,col2,col3` |
| Order by column | `$order=col_name` (use this to make `$limit`-truncated results deterministic) |
| Row limit | `$limit=1000` (Socrata's anonymous max is 1,000 unless using `$offset`/paging) |
| GeoJSON output | Replace `.json` with `.geojson` in the resource URL |
| Escape a single quote | Double it: `O''Brien` |

`within_box` argument order: **NW corner first** (max lat, min lon), then **SE corner** (min lat, max lon).

Socrata also supports `intersects(geom, wkt)` for true geometry intersection — useful as a fallback when the bbox-pad approach doesn't fit a particular query. The Winnipeg datasets accept it; not all Socrata instances do, so test before relying on it.

---

## 12. Non-Socrata portals

If the new jurisdiction does not use Socrata, the architecture stays the same but `soda.js` needs to be rewritten for the new API.

### ArcGIS Open Data / ArcGIS REST

Many provincial and federal portals use Esri's ArcGIS REST API. The equivalent of `within_box` is a spatial query:

```
/query?geometry={"xmin":-97.19,"ymin":49.88,"xmax":-97.18,"ymax":49.89,"spatialReference":{"wkid":4326}}
      &geometryType=esriGeometryEnvelope
      &spatialRel=esriSpatialRelIntersects
      &outFields=*
      &f=geojson
```

Key differences from Socrata:

- `esriSpatialRelIntersects` tests intersection, not containment — **no padding needed** ([Bug 10.2](#102-within_box-uses-containment-not-intersection) doesn't apply).
- Attribute queries use SQL-ish syntax: `where=UPPER(LOT) LIKE '%50%'`
- CORS varies; some ArcGIS services need a proxy.
- Pagination uses `resultOffset` + `resultRecordCount` instead of `$offset` + `$limit`.

### CKAN (e.g. Manitoba Open Data)

CKAN is a data catalogue, not a query engine. Datasets are usually downloadable files (GeoJSON, CSV, Shapefile). If the data is only available as a file download, the live-query approach doesn't work — you'd need to:

- Pre-process and host the data yourself (PMTiles is a good static-hostable option for vector tiles), **or**
- Run spatial queries against your own PostGIS instance via a serverless function.

For Manitoba specifically, check whether each dataset offers a Datastore API endpoint (gives SQL-ish querying via CKAN's Datastore extension) — if so, the architecture can stay live-query.

---

## 13. Local dev workflow

```bash
cd web
npm install
npm run dev    # http://localhost:5173 — queries live data on every search
```

Vite's hot-module reload means CSS and JS changes appear instantly. The map requires internet to load basemap tiles.

To inspect SODA responses directly in the browser:

```
https://data.example.ca/resource/DATASET-ID.geojson
  ?$where=upper(lot) like '%50%' AND upper(block) like '%RL%'
  &$limit=5
```

To see all fields on a dataset:

```
https://data.example.ca/resource/DATASET-ID.json?$limit=1
```

To read dataset metadata (find geometry column names, data types):

```
https://data.example.ca/api/views/DATASET-ID.json
```

To test a `within_box` query:

```
https://data.example.ca/resource/DATASET-ID.json
  ?$where=within_box(geometry,49.900,-97.150,49.895,-97.145)
  &$limit=10
```

The deployed app exposes `window._map` for runtime inspection — handy for confirming layer state, source contents, and zoom level when troubleshooting on the live site.

---

## 14. Manitoba (ArcGIS REST) implementation notes

This section captures every operational decision, gotcha, and pattern that emerged adapting the Winnipeg site to Manitoba Open Data. Use it alongside §12 ("Non-Socrata portals → ArcGIS") for the high-level pattern; the items below are the operational details. Every section reflects the **current state of `main`** (not a chronology); a handoff developer reading top-to-bottom should arrive at the architecture as it exists today.

### 14.1 Datasets used

| Layer | FeatureServer | Notes |
|---|---|---|
| ROLL_ENTRY | `services.arcgis.com/mMUesHYPkXjaFGfS/.../ROLL_ENTRY/FeatureServer/0` | Single parcel layer — no separate survey/legal-lots dataset, so the dual-flow architecture collapses to one direction. |
| Manitoba_Zoning_By_Laws | same org | Carries `ZBL`, `ZBL_A`, `AMENDMENT_DESCRIPTION` for change-history filters. |
| Manitoba_Development_Plan_Designations | same org | Carries `DP_BYLAW`, `DPA_BYLAW` for change-history. `PLANNINGDISTRICT` is the key for the data-driven PD-website lookup. |
| MHTIS_Traffic_Flow_2019 | `services6.arcgis.com/HQUud09zgy3Asw9X/.../FeatureServer/0` | AADT polylines. Used directly for the Traffic overlay (the older station-locations layer was tried first but dropped — it carried no AADT, so the user had to click out to MHTIS for the data; the flow layer renders AADT directly on the road). |
| Manitoba Contaminated Sites | CSV at `manitoba.ca/.../cs-data.csv` | Not a FeatureServer; CSV file behind the official ArcGIS web map. Proxied via `vercel.json` because the upstream lacks `Access-Control-Allow-Origin`. |
| Generated MAO legal index | `web/public/data/legal-index.json` | Static browser artifact generated from `../mao-scrape/results/parcels.parquet`; supplies Legal Description, Lot, Block, Plan, certificates of title, and `(muni_no, roll_no_txt)` lookup keys. |
| MASC soil ratings | `masc_soil_ratings_with_latlon.csv` + river-lot scrape/KMZ -> `web/public/data/masc/` and `web/public/data/masc-riverlots.json` | Static per-municipality quarter-section shards plus rated river-lot polygons. The MASC Rating map layer draws approximate quarter polygons from centroid lat/lon and actual river-lot polygons, colours by A-J rating, and labels each feature with the rating letter only. |
| Parcel-level MASC ratings | `RollEntry_YYYYMMDD.gpkg` + MASC CSV + optional river-lot inputs -> `web/public/data/parcel-masc/` | Static per-municipality dictionaries keyed by `Roll_No_Txt`; table enrichment for the dominant Soil column. |
| MASC_Risk_Areas | `services.arcgis.com/mMUesHYPkXjaFGfS/.../MASC_Risk_Areas/FeatureServer/0` | Official MASC crop-insurance risk-area polygons published through Open Canada package `739cb8ed-b661-5a60-7a26-eb60cd06541f`; drives the Risk Areas overlay and parcel-level Risk Area column. |

### 14.2 Single-flow architecture

ROLL_ENTRY contains the parcel polygons AND the assessment attributes (Roll #, address, total value, dwelling units, MAO link). It does **not** carry Lot / Block / Plan or certificate-of-title fields. There's no Land-Titles "survey" layer to separately query, so:

- Drop the `searchSurveyParcels` / `searchAssessmentParcels` split — collapse to a single `searchParcels` that ANDs every filter against ROLL_ENTRY.
- Drop `mergeSurveyFeatures`, `joinSurveyWithAssessment`, `joinAssessmentWithSurvey`, `parcelsOverlap`, partial-lot detection, and the dual-layer map. Just one parcel layer.
- The Winnipeg multi-address civic-xref pattern (cam2-ii3u) doesn't apply — Manitoba has no province-wide civic-address dataset. `Property_Address` on ROLL_ENTRY is the only address field, and rural parcels often store a quarter-section description there (e.g. `SE 08-08-20 W`).
- Legal-description search is the exception: it starts from the generated MAO scrape index, finds matching `(muni_no, roll_no_txt)` keys, then uses those keys to fetch current Roll Entry geometries and assessment attributes live.

### 14.3 Two enrichment overlays instead of one

The Manitoba site enriches each result with **top-2 zoning** AND **primary dev-plan designation**, run as parallel spatial queries:

- When the user has selected a Municipality, fire one bulk query per overlay (`UPPER(MUNI_NAME) = '<bare>'`) — gets every overlay polygon in the muni in a single paginated response. The client then runs `joinTopNByArea(parcelFc, overlayFc)` locally.
- When the user hasn't selected a Muni (province-wide search), fall back to per-parcel envelope queries with a concurrency cap.

The bulk path is ~30× faster for muni-scoped searches and eliminated a class of transient-failure bugs where 1000 per-parcel queries overlapped with concurrency limits and silently dropped some rows' enrichment.

### 14.4 ArcGIS SQL92 dialect quirks

- **Use POST with form-encoded body** for queries, not GET — geometry envelopes plus long `OBJECTID IN (...)` clauses easily push GET URLs past 8 KB.
- `f=geojson` returns standard GeoJSON; `f=json` returns Esri JSON with `attributes`/`geometry`. We use `geojson` everywhere for consistency with turf.js.
- `spatialRel=esriSpatialRelIntersects` is a true intersection — **no bbox padding needed** (Bug 10.2 from the Winnipeg side does not apply).
- **`TRIM()` is not supported** in `where` clauses on hosted Feature Services — returns `400 "'where' parameter is invalid"`. Use explicit comparisons (`x <> '' AND x <> ' '`) instead. The dialect is a stripped subset of SQL92.
- **`LIKE` is case-sensitive**; wrap fields in `UPPER(...)` for case-insensitive partial matching, same as Socrata.
- **Hosted Feature Services cap `resultRecordCount` at 2000.** Walk through pages with `resultOffset` until `exceededTransferLimit` is false or fewer rows come back than requested. Treat *both* signals as truncation — some hosted configs don't set `exceededTransferLimit` consistently, so a full page at the app cap should also flag truncation in the UI.
- **Watch for `<Null>` as stringified-null.** Some hosted-service configurations serialize a true SQL `NULL` as the literal text `<Null>` in JSON responses (and require it in `where`-clause comparisons too). Rejecting `IS NULL` alone is not enough — also exclude `<> '<Null>'` and `<> ''` and `<> ' '`. The client-side `realStr()` helper in `main.js` does the matching normalization on the read side.
- **Field names are case-sensitive in `outFields`.** Asking for an unknown field returns 400 with no helpful message. Always probe the layer's `?f=json` metadata before trusting a field name from offline pipeline docs (Manitoba's offline `mao-assembly` pipeline references `AsmtYr` which does **not** exist on the live ROLL_ENTRY — the year is parsed from `Asmt_Roll`, e.g. `"2024 Final"` → 2024).

### 14.5 Roll # exact-match with decimal padding

ROLL_ENTRY stores roll numbers with a `.000` decimal suffix (e.g. `3600.000`), but users type the integer (`3600`). Build the where clause to accept both forms with a single OR:

```sql
(Roll_No_Txt = '<input>' OR Roll_No_Txt = '<input>.000')
```

Roll # digits are NOT unique province-wide — the same digits exist in many municipalities — so the UI should pair Roll # with a Municipality dropdown.

### 14.5.1 Generated legal-description index

ROLL_ENTRY has no direct fields for legal description, Lot / Block / Plan, or certificates of title. The Manitoba implementation fills that gap with a static JSON index generated from the companion MAO scrape:

```bash
cd web
npm run legal:index
```

The command runs `r/build_legal_index.R`, reads `../mao-scrape/results/parcels.parquet`, and writes `web/public/data/legal-index.json`. The JSON is intentionally a lookup artifact, not the parcel source of truth: the browser searches the index for legal text, exact parsed Lot / Block / Plan, and title text; matching `(muni_no, roll_no_txt)` keys are then grouped into ArcGIS Roll Entry `where` clauses:

```sql
(Municipality LIKE '<muni_no> - %' AND Roll_No_Txt IN (...))
```

Those live Roll Entry features drive the map/table, while the legal fields from the index are stamped onto the feature properties for display, tooltips, popups, and CSV export. This preserves current geometry/value data while allowing searches on fields that only MAO exposes.

### 14.6 Amendment-status filter

Both overlay layers carry change-history fields:

- **Zoning**: `ZBL` (original by-law), `ZBL_A` (amendment by-law), `AMENDMENT_DESCRIPTION` (sometimes the from→to text, e.g. `"RG8 to RG5"`).
- **Dev Plan**: `DP_BYLAW`, `DPA_BYLAW`.

A "changed" predicate ORs the two signals on the zoning side and a single comparison on the dev-plan side. Both sides need the full null-sentinel exclusion list because the dataset uses several non-equivalent representations of "this is really null":

```sql
-- zoning changed: ZBL was amended, OR AMENDMENT_DESCRIPTION carries text
((ZBL_A IS NOT NULL
   AND ZBL_A <> '' AND ZBL_A <> ' ' AND ZBL_A <> '<Null>'
   AND ZBL_A <> ZBL)
 OR (AMENDMENT_DESCRIPTION IS NOT NULL
   AND AMENDMENT_DESCRIPTION <> ''
   AND AMENDMENT_DESCRIPTION <> ' '
   AND AMENDMENT_DESCRIPTION <> '<Null>'))
-- dev-plan changed: DPA_BYLAW differs from DP_BYLAW
(DPA_BYLAW IS NOT NULL
   AND DPA_BYLAW <> '' AND DPA_BYLAW <> ' ' AND DPA_BYLAW <> '<Null>'
   AND DPA_BYLAW <> DP_BYLAW)
```

The UI exposes a single "Status" dropdown (`Any` / `Zoning Changed` / `Dev Plan Changed` / `Both Changed`) that maps to two booleans, then `resolveOverlayFilter` pulls the matching overlay polygons and resolves them to a parcel OBJECTID list (see §14.14). The OBJECTID list ANDs into the parcel query alongside any text filters.

The client-side `formatChanges()` renderer mirrors the same null-sentinel exclusions when deciding whether to print `Z: …` / `DP: …` in the Changes table column — see `realStr()` in `main.js`.

### 14.7 Top-N area-weighted join

`joinTopNByArea(parcelFc, overlayFc, n=2)` mirrors `mao-assembly/scripts/pipeline_utils.R::get_multiple_by_area()`:

1. For each parcel, bbox-overlap reject overlays that can't possibly intersect.
2. `intersect({ type: 'FeatureCollection', features: [parcel, overlay] })` (turf 7.x signature — the v6 `intersect(a, b)` API is gone).
3. Wrap in try/catch — topology errors on real-world data are common.
4. `area(intersection)` gives geodesic m²; divide by parcel area for ratio.
5. Sort desc, take top N.

Hide the secondary entry when its ratio < 1% — those are GIS digitization slivers, not real multi-zone parcels.

### 14.8 Auxiliary overlays beyond the core search

The Manitoba site exposes the following map overlays not present in the Winnipeg original. All are organized into a 2-column grid in the left sidebar, lazy-loaded on first activation, cached in `localStorage` (§14.16), and routed through a generic `AUX_META` lookup in `main.js` so adding a new overlay is a single entry plus the matching button in `index.html`.

- **Muni Parcels** — every parcel in the selected muni rendered as a light-blue fabric (`#cfeefb` @ 22% alpha) with royal-blue (`#1d4ed8`) outline. Disabled until a muni is selected; cached per-muni. Roll-number labels render at each parcel's centroid at zoom ≥ 14 with a thin white halo (0.8 px) so they don't dominate the parcels themselves. Hover popup shows roll #, address, DU, land size (ac · sf), total value, and — when Show Zoning is also active — the zone code, name, and ZBL pulled live from the zoning layer at the cursor (see §14.10).
- **Traffic** — MHTIS Traffic Flow 2019 polylines coloured by AADT in 6 step-function bins. AADT value labelled along each segment at zoom ≥ 8 (symbol-on-line placement). A floating colour-bin legend pops in the bottom-right whenever the layer is visible.
- **Zoning** — coloured per-search by `ZONE` code (not `ZONE_CATEGORY`) using a stable hash-derived HSL palette so the same code always renders the same colour, with golden-ratio hue spacing to avoid adjacent-code collisions. Zoning *codes* labelled at each polygon centroid with a `text-anchor: bottom` + `text-offset: [0, -1.2]` so they sit cleanly above the muni-parcels roll-number when both layers are on. `text-allow-overlap` and `text-ignore-placement` are both `true` on the zoning label so it never gets suppressed by collision detection.
- **Dev Plan** — coloured by `DES_CATEGORY`. No labels (the long designation names don't fit in a polygon at typical zooms; the table carries the text).
- **Enviro** — Manitoba Contaminated Sites Registry as red / orange / grey points by designation, with a registry-page link in each popup. Sourced from a CSV proxied through `vercel.json` (§14.9).
- **MASC Rating** — per-municipality MASC crop-insurance soil ratings. Disabled until a municipality is selected. On first activation, `fetchMascRatingsForMuni()` loads `web/public/data/masc/_index.json`, resolves the selected `Muni_Name_With_Typ` to a shard using tolerant name normalization, fetches `web/public/data/masc/<file>.json`, and caches it for 30 days. `fetchMascRiverlots()` also loads the rated river-lot overlay. `quartersToFc()` converts centroid rows into approximate 800 m quarter-section polygons; `masc-fill`/`masc-riverlots-fill` colour by `rating` with the A-J ramp, and `masc-label`/`masc-riverlots-label` render the rating letter only. The label layers are deliberately added above the parcel/roll-fabric layers so they remain visible after parcel searches or when Roll Layer is active.
- **MASC Risk Areas** — official MASC crop-insurance risk-area polygons from the Manitoba Maps `MASC_Risk_Areas` FeatureServer. The app fetches `Risk_Area` polygons with `f=geojson`, filters blank values (`Risk_Area IS NOT NULL AND Risk_Area <> '' AND Risk_Area <> ' '`), labels the separate overlay as `Risk <Risk_Area>`, and stamps the table's Risk Area column from the containing polygon.
- **Sec-Twp Grid** — section-township grid plus river lots. With a municipality selected, it fetches the Manitoba Original Survey Legal Descriptions point layer scoped to the muni boundary; without a municipality, it uses the prebuilt province-wide static grid. The grid shares the MASC helper's DLS section-shape logic but is a separate overlay.
- **RM Website / PD Website** — not overlays in the spatial sense; they sit at the bottom of the overlay grid as link-out buttons (§14.19).
- **Streets / Satellite** basemap toggle in the map's top-right (Esri World Imagery alongside CARTO Positron). Custom `BasemapToggleControl` registered via `map.addControl(..., 'top-right')`; flips both raster sources' `visibility`.

### 14.9 CORS proxy for the contaminated-sites CSV

`manitoba.ca` returns 200 OK for the CSV but does **not** send `Access-Control-Allow-Origin` — the browser fetch fails silently CORS-blocked. Fix in two places:

```jsonc
// vercel.json — production
{
  "rewrites": [
    { "source": "/proxy/contam-sites.csv",
      "destination": "https://manitoba.ca/sd/waste_management/contaminated_sites/registry/cs-data.csv" }
  ]
}
```

```js
// vite.config.js — local dev
server: {
  proxy: {
    '/proxy/contam-sites.csv': {
      target: 'https://manitoba.ca',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/proxy\/contam-sites\.csv$/,
        '/sd/waste_management/contaminated_sites/registry/cs-data.csv'),
    },
  },
},
```

Then the browser fetches `'/proxy/contam-sites.csv'` (relative path, works in both environments). Same pattern works for any other open-data file whose origin server forgot CORS.

### 14.10 Cross-layer popup enrichment

A muni-parcels hover or click is the cheapest workflow for "what's this parcel" triage, but the Roll Entry attributes alone don't include zoning. Rather than fetch zoning per-hover, the popup builder reads whatever overlay layers are *currently visible* at the cursor:

```js
function readOverlaysAt(map, point) {
  const out = { zoning: null, devplan: null };
  if (map.getLayoutProperty('zoning-fill', 'visibility') === 'visible') {
    out.zoning = map.queryRenderedFeatures(point, { layers: ['zoning-fill'] })[0]?.properties || null;
  }
  if (map.getLayoutProperty('devplan-fill', 'visibility') === 'visible') {
    out.devplan = map.queryRenderedFeatures(point, { layers: ['devplan-fill'] })[0]?.properties || null;
  }
  return out;
}
```

The same pattern works for any future overlay where the parcel hover should opportunistically include underlying-layer info — no new fetches, no extra spatial joins, just a `queryRenderedFeatures` call against whatever's already painted.

### 14.11 Walkscore (deferred to walkscore.com)

Earlier prototypes called the Walk Score professional API per row but ran into rate-limit, key-management, and rural-coverage friction (most non-Winnipeg Manitoba addresses return null). Final design is a single per-row link cell pointing at `walkscore.com/score/<encoded address>` — the Walk Score page does its own lookup of Walk + Transit + Bike on arrival. No API key, no rate limit, no quota tracking. Same pattern as the Asmt Report column.

### 14.12 Per-search legend rebuilt from data

The zoning legend is **rebuilt after every search** from the actual `ZONE` codes present in the search's enrichment FC (not a static category list). `buildZoneCodePaint(zoningFc)` does both jobs:

1. Walks the FC's features once to collect the unique `ZONE` codes and their most-frequent `ZONE_NAME`.
2. Generates a stable HSL colour per code via a hash-with-golden-ratio-hue function, so the same code always paints the same colour across sessions and adjacent codes don't visually collide.
3. Returns `{ matchPairs, legend }` — `matchPairs` is the flat `[code, color, ...]` array MapLibre's `match` expression consumes, fed back via `setZoningPaint(map, pairs)`; `legend` is the `[{ code, name, label, color }]` list `main.js` renders into the legend `<ul>`.

Result: the legend lists exactly the zone codes the user is looking at (with their `ZONE_NAME` for context — e.g. `AL – Agricultural Limited`), and the swatch colours are guaranteed to match what the map paints because both come from the same call. The AADT colour-bin legend is static (the bins are policy choices), but renders only while the layer is visible.

The zoning legend's max-height is `calc(0.85 * (100vw - 280px) * 9 / 16)` — i.e. 85% of the rendered map height — so a muni with 30+ codes only scrolls when there's truly no room. Below the 900-px collapse breakpoint the calc drops the sidebar offset.

### 14.13 R archive scripts

`r/download_parcels.R` snapshots all three primary FeatureServer layers via paginated GeoJSON to dated GeoPackages, and `r/parcel_search_app.R` is a Shiny app that runs the same search workflow against the local snapshot — useful for searching against an older snapshot when a parcel has been split or consolidated since. Both files hardcode `data_dir <- "D:/Dropbox/ClaudeCode/MBOpenData/WebSearch"`; edit at the top of each file to run elsewhere.

### 14.14 Polygon-geometry filter resolution (not bbox envelopes)

When the user picks a Zoning Category or an Amendment Status, the parcel result set is restricted to parcels that intersect at least one matching overlay polygon. The naive implementation sends each overlay polygon's *envelope* to ROLL_ENTRY's spatial query; that returns a superset (any parcel whose bbox overlaps the overlay's bbox), so unrelated parcels leak in.

The current implementation (`resolveOverlayFilter` in `arcgis.js`) sends each overlay's **actual polygon geometry** via `geometry={rings:[...],spatialReference:{wkid:4326}}`, `geometryType=esriGeometryPolygon`, `spatialRel=esriSpatialRelIntersects`. ArcGIS does the true geometric intersection server-side; no false positives. The OBJECTID list per overlay is collected via `fetchAllPages` (cap 100,000) so a large overlay can match well past the 2,000-row page limit without silently truncating. Multiple overlay-side queries (e.g. *zoning category = R + zoning changed*) AND together by intersecting their OBJECTID sets before the final parcel query.

### 14.15 Bulk-per-muni vs per-parcel envelope enrichment

Two paths through `fetchZoningOverlap(parcelFc, { municipality })` and `fetchDevPlanOverlap(parcelFc, { municipality })`:

- **Muni selected**: one bulk query per overlay layer scoped to `UPPER(MUNI_NAME) = '<bare>'`. Returns every overlay polygon in the muni in a single paginated response, then `joinTopNByArea(parcelFc, overlayFc)` runs locally.
- **Province-wide search**: per-parcel envelope queries against the overlay layer, with a concurrency cap of 16.

The bulk path is ~30× faster on muni-scoped searches and eliminates a transient-failure mode where 1,000 simultaneous per-parcel envelope queries occasionally lost one or two responses, leaving rows with empty zoning. Province-wide searches stay on the per-parcel path because the overlay set across the entire province is too large to fetch eagerly. The decision happens in `arcgis.js` via a simple `if (municipality) return fetchOverlayByMunicipality(...)` branch.

### 14.16 localStorage cache with TTL and namespace

Data classes use distinct strategies:

| Data | Strategy |
|---|---|
| Search results | Never cached. Every Search hits ROLL_ENTRY live, even when a generated legal-index match supplies the lookup keys. |
| Generated legal index | Static deployment artifact, regenerated from the MAO scrape with `npm run legal:index` whenever `../mao-scrape/results/parcels.parquet` is refreshed. |
| Generated MASC artifacts | Static deployment artifacts. `r/build_masc_shards.R` writes quarter-section map shards to `web/public/data/masc/`; `r/build_parcel_masc.R` writes the rated river-lot overlay to `web/public/data/masc-riverlots.json` and parcel-level dominant soil-rating shards to `web/public/data/parcel-masc/`. |
| Dropdown lists, auxiliary overlay datasets, per-muni overlay enrichments | `localStorage` under `mbpsCache.` namespace. Most live data uses a 7-day TTL; stable generated/reference layers such as MASC, MASC Risk Areas, municipal boundaries, section grid, and river lots use a 30-day TTL. |
| In-memory MapLibre source data | Mutated in place during a session; thrown away on reload |

The `readCache` / `writeCache` helpers in `arcgis.js` wrap every value in `{ v, t: Date.now() }` and reject reads where `Date.now() - t > CACHE_TTL_MS`. Quota recovery on `setItem` failure walks the namespace and evicts older entries before falling back silently. The Clear button does `sessionStorage.clear()` *and* iterates `localStorage` evicting `mbpsCache.*` entries, then full-reloads to a clean URL — the bulletproof reset Winnipeg's site already had, extended to cover the new cache.

Earlier builds used `sessionStorage`; promoting to `localStorage` made the muni-working-set workflow snappy across tabs and sessions. The TTL is set conservatively (7 days) because the province typically publishes overnight at most.

### 14.17 Sidebar layout with sticky controls

Above 900 px viewport, the page is a CSS Grid with a 280-px left sidebar and a fluid main pane. The sidebar is `position: sticky; top: 0; max-height: 100vh; overflow-y: auto` so the controls remain visible while the table scrolls. Below 900 px the grid collapses to a single column.

The map uses `aspect-ratio: 16 / 9` with `min-height: 420px` so its height tracks the main-pane width. A typical 1512-px viewport renders the map at ~1232 × 693; wider viewports get proportionally taller maps. The layout was chosen over a fixed-height map because the main-pane width varies dramatically with the user's monitor.

### 14.18 Static-map capture with attribution composited

The **Generate Static Map** button below the table reads MapLibre's WebGL canvas and saves it as a PNG the user can right-click → Save Image As. Two implementation details that aren't obvious:

1. **`preserveDrawingBuffer: true`** is set on `new maplibregl.Map(...)`. Without it, the WebGL framebuffer is cleared after each frame and `canvas.toDataURL()` returns blank bytes. There's a small per-frame perf cost on continuous interaction; acceptable for our workload.
2. **Attribution is composited into the saved image.** The MapLibre `AttributionControl` is a DOM overlay, not part of the canvas, so a naive `toDataURL()` drops the basemap credit. The capture function reads `.maplibregl-ctrl-attrib-inner.innerText` directly (so whatever's on screen — CARTO + OSM, or Esri Imagery, plus any source-specific credits — lands verbatim), draws the WebGL canvas onto a 2D canvas, then renders the attribution as wrapped text in a white-pill bottom-right corner before exporting.

The button waits on `map.once('idle')` after `triggerRepaint()` so mid-animation frames or still-loading tiles don't end up in the snapshot.

### 14.19 Muni and PD website lookup with tolerant matching

Two static maps in `main.js` cover every published Manitoba municipality (~110 entries) and planning district (~28 entries) with their websites. Compiled from the province's official Municipal Contact Directory and PD Contact Directory.

`MUNI_WEBSITES` is keyed on the exact `Muni_Name_With_Typ` form ROLL_ENTRY returns (e.g. `BRANDON (CITY)`, `STONEWALL (TOWN)`, `ROCKWOOD (RM)`). Same-name CITY/RM pairs (Dauphin, Lac du Bonnet, Morris, Portage la Prairie, Ste. Anne, Thompson) get distinct entries. Munis whose only published contact is a generic email render as "RM N/A".

`PD_WEBSITES` is keyed on the planning district name *without* the trailing " PLANNING DISTRICT" suffix (e.g. `RED RIVER`, `BROKENHEAD RIVER`). After every search, the dominant `PLANNINGDISTRICT` value across the dev-plan enrichment FC picks the active PD; the lookup helper normalizes case, strips the suffix, and tries common abbreviations.

`normalizeMuniKey()` and `normalizePdKey()` both: uppercase, strip diacritics via `String.prototype.normalize('NFD')` + diacritic-strip regex, normalize en-/em-/figure-dashes to hyphen-minus, collapse whitespace. This means source-side drift (`é` vs `e`, en-dash vs hyphen) doesn't break the lookup.

The shared `setExternalLinkButton(btn, url, activeLabel, inactiveTitle)` helper handles the active / disabled / "X N/A" UI state for both buttons, including stripping any prior click handler when the URL changes (no listener stacking across muni-change events). `safeExternalUrl()` (an http/https-only allowlist) gates every href.

### 14.20 Year-stamped Assessment column

The Assessment column header reads e.g. `Assess-2024`, year-stamped from the most-common assessment year across the result set. The year is *parsed* from `Asmt_Roll` (a string like `"2024 Final"`, `"2025 Preliminary"`, or `"2024 Tax"`) — the field name `AsmtYr` from the offline `mao-assembly` pipeline does not exist on the live FeatureServer. Same parser drives the CSV header, so exports stay in sync with the on-screen label.

The column doubles as the link to MAO. The dollar value itself is the `<a>` text; clicking opens the parcel's `Asmt_Rpt_Url` in a new tab. `safeExternalUrl()` validates the URL.

### 14.21 Walkscore and Flood-map deep-links

Walkscore is a per-row link to `walkscore.com/score/<encoded address>` — the destination page renders Walk / Transit / Bike on arrival. No API key, no rate limit, no quota. (Earlier prototypes called the Walk Score Pro API per row but ran into key management, daily-call limits, and rural-coverage friction since most non-Winnipeg Manitoba addresses come back null.)

Flood is a per-row deep-link to the sister [mb-flood-mapping](https://github.com/jayschellenberg/mb-flood-mapping) site, which accepts `?lat=&lon=&label=…` (preferred — uses the parcel's polygon centroid via `bboxOfFeature`) or `?address=…` (fallback when geometry is missing — the sister tool geocodes via Mapbox/Nominatim).

Both columns and the MAO link share a uniform pattern in the table:

```js
function externalLinkCell({ url, text, title }) {
  const td = document.createElement('td');
  const safe = safeExternalUrl(url);
  if (!safe) { td.textContent = '—'; td.classList.add('empty'); return td; }
  const a = Object.assign(document.createElement('a'), {
    href: safe, target: '_blank', rel: 'noreferrer', textContent: text, title
  });
  a.addEventListener('click', (e) => e.stopPropagation()); // don't trigger row fly-to
  td.appendChild(a);
  return td;
}
```

CSV export keeps each URL as a separate column so spreadsheet workflows can copy them out cleanly.

### 14.22 MASC soil-rating artifacts, river lots, and official risk areas

The MASC workflow has three generated artifacts. Quarter sections come from `masc_soil_ratings_with_latlon.csv`; river lots also use `MB-RIVER-LOTS.kmz` plus `D:/Dropbox/ClaudeCode/MASC-SCRAPE/masc_soil_ratings_riverlots.csv` when those optional inputs are present:

1. `r/build_masc_shards.R` writes `web/public/data/masc/<MUNI>.json` plus `_index.json`. Each row is a compact quarter-section record:

```json
{ "q": "NE", "s": 1, "t": 7, "r": 3, "d": "E", "rating": "D", "ra": 32, "lat": 49.543106, "lon": -97.054278 }
```

2. `r/build_parcel_masc.R` writes `web/public/data/masc-riverlots.json` from the rated river-lot scrape joined to the KMZ polygons. These are actual long/narrow river-lot polygons, not centroid squares, and they share the A-J rating palette with the quarter-section overlay.

3. `r/build_parcel_masc.R` intersects the most recent `RollEntry_YYYYMMDD.gpkg` against approximate MASC quarter polygons plus rated river-lot polygons and writes `web/public/data/parcel-masc/<MUNI_KEY>.json` dictionaries keyed by `Roll_No_Txt`:

```json
{ "3600.000": { "rating": "C", "ra": 32, "q": "NE", "s": 1, "t": 12, "r": 5, "d": "E", "source": "quarter", "label": null } }
```

Regenerated parcel-MASC shards carry `source` and `label`; the frontend still infers river-lot sources from `q` values ending in `RL`/`OT`/`WL`/`SL` or null section/township fields when reading older deployed shards. River-lot IDs are text during the KMZ join so numeric, lettered, and suffix lots all survive (`RR-RL-F`, `MA-RL-94B`, `AD-RL-3`).

The map overlay and Soil table column intentionally use separate artifacts. The map needs every quarter/river lot in the selected municipality; the table only needs the dominant rating by parcel. Keeping them separate avoids browser-side parcel x soil-source spatial joins during search. The Risk Area table column no longer uses the MASC CSV's compact `ra` value; it is derived from the official MASC Risk Areas polygon layer.

Coverage-gap triage is source-first. When a blank area appears in the MASC Rating overlay, first test whether any MASC source centroids fall inside that blank under the selected municipality or another municipality. If no source centroids exist there, do not fill the map overlay by interpolation or nearest-neighbour inference; record it as a MASC source coverage gap or non-rated area. The parcel-MASC table can still show ratings for parcels whose geometry touches a nearby rated quarter/river lot or whose dominant rating was resolved by the parcel build, but that is parcel attribution rather than proof that the blank map area has published MASC coverage.

The 2026-05-07 review checked the largest current blanks in the reported target municipalities against the MASC CSV, generated river-lot overlay, Roll Entry parcels, municipal boundaries, zoning, and development-plan polygons. Every target had zero MASC source centroids inside the blank, including zero centroids filed under another municipality:

| Municipality | Largest blank | Source centroids in blank | Dominant land-use read |
| --- | ---: | ---: | --- |
| `WEST INTERLAKE (RM)` | 185.8 km2 | 0 | Mixed WMA/agricultural fringe. |
| `PINEY (RM)` | 158.8 km2 | 0 | Provincial forest/rural/agricultural fringe. |
| `TACHE (RM)` | 44.3 km2 | 0 | Mostly agriculture/escarpment/rural living. |
| `RIDING MOUNTAIN WEST (RM)` | 236.3 km2 | 0 | Agricultural policy area. |
| `DAUPHIN (RM)` | 224.2 km2 | 0 | Agriculture/rural area. |
| `ALONSA (RM)` | 193.5 km2 | 0 | Mostly agriculture with limited agriculture/WMA edges. |
| `GILBERT PLAINS (MUNICIPALITY)` | 176.7 km2 | 0 | Rural agricultural area. |
| `PORTAGE LA PRAIRIE (RM)` | 186.9 km2 | 0 | Mostly agriculture with small settlement/residential edges. |
| `TWO BORDERS (MUNICIPALITY)` | 131.2 km2 | 0 | Agricultural policy area. |
| `ARMSTRONG (RM)` | 112.9 km2 | 0 | Mostly agricultural. |

Important implementation details:

- The MASC CSV carries bare municipality names (`RITCHOT`), while the app dropdown carries `Muni_Name_With_Typ` (`RITCHOT (RM)`). `lookupMuniManifestEntry()` therefore tries the direct key, a normalized key with type stripped for the MASC map shards, and a compact normalized comparison. This is what prevents the false "No MASC soil ratings on file for RITCHOT (RM)" failure.
- Parcel-MASC shards are keyed by the original `Muni_Name_With_Typ`, so `fetchParcelMascForMuni()` uses the same manifest helper with `stripType: false`. Its compact lookup preserves the muni type while tolerating dotted `ST.`/`STE.` spellings and `RM OF ...` word order.
- `r/build_parcel_masc.R` normalizes `DESALABERRY` to `DE SALABERRY` before joining the MASC river-lot scrape to the KMZ. It also adds a constrained prefix+lot fallback: if a KMZ lot has no same-muni MASC hit but its prefix+lot ID has exactly one MASC source municipality province-wide, keep that rating. This covers split-boundary Rat River lots 27-31, which are polygon-majority tagged to `ST PIERRE-JOLYS (VILLAGE)` but published by MASC under De Salaberry.
- Rated river-lot overlay matching uses `main.js::filterMascRiverlotsForMuni()`: first check exact typed matches against both `properties.muni` and `properties.rating_muni`, then, only if no exact typed river-lot features exist, fall back to the shared bare name. This surfaces same-name enclave cases such as `STE ANNE (RM)` and split-boundary cases such as De Salaberry / St-Pierre-Jolys.
- Official risk areas are fetched by `fetchMascRiskAreas()` from `MASC_Risk_Areas/FeatureServer/0`, source package <https://open.canada.ca/data/en/dataset/739cb8ed-b661-5a60-7a26-eb60cd06541f>. The API returns valid risk-area numbers `1` through `12`, plus `14`, `15`, and `16`; blank polygons are filtered out in the `where` clause.
- MASC cache keys are versioned (`mb_masc_*_v3`, `mb_parcel_masc_*_v4`, `mb_masc_riverlots_v3`). If a shard exists and the app still claims no ratings, check browser `localStorage` first or bump the cache version after changing lookup semantics or generated artifact shapes.
- `masc.js::quarterPolygon()` draws approximate 800 m squares around centroids. This is a research/visual overlay, not a cadastral boundary layer.
- `map.js` renders quarter-section MASC soil layers from the `masc` source (`masc-fill`, `masc-label`) and river-lot MASC soil layers from the `masc-riverlots` source (`masc-riverlots-fill`, `masc-riverlots-label`). Both use the same A-J colour ramp. The label expression is intentionally only the soil rating:

```js
['coalesce', ['get', 'rating'], '']
```

- Layer order matters. MASC labels are added after `parcel-line`, above the parcel and muni-parcel fabric layers, so labels remain legible when the user searches parcels and then toggles MASC. `setMascVisible()` must toggle all four soil-rating layers: `masc-fill`, `masc-label`, `masc-riverlots-fill`, and `masc-riverlots-label`.
- `map.js` renders official risk areas as separate `masc-risk-area-fill`, `masc-risk-area-line`, and `masc-risk-area-label` layers. `setMascRiskAreasVisible()` toggles all three.
- `main.js::stampOfficialRiskAreas()` computes each parcel's bbox-centre point and finds the containing official risk polygon with `@turf/boolean-point-in-polygon`. Risk areas are broad enough that this representative point keeps search-time cost low without mixing the legacy MASC CSV `ra` into official labels.
- Smoke tests: select `RITCHOT (RM)`, toggle `MASC Rating`, zoom to >= 13 near the southeast side of Winnipeg/St. Adolphe, and confirm coloured quarter sections label as letters only with no "No MASC soil ratings..." status message. Then toggle `MASC Risk Areas` and confirm risk boundaries/labels appear separately. For river-lot coverage, search `ST ANDREWS (RM)` + roll `100.000` (Soil `C`, tooltip `Source: River lot ADRL-3Q`), `ST CLEMENTS (RM)` + roll `100.000` (Soil `C`, tooltip `Source: River lot ADRL-199Q`), `STE ANNE (RM)` + roll `100000.000` (Soil `D`, tooltip `Source: River lot ANRL-83T`), `DE SALABERRY (RM)` + roll `158550.000` (Soil `C`, tooltip `Source: River lot RR-RL-31`), and `MORRIS (RM)` + roll `254000.000` (Soil `C`, tooltip `Source: River lot AG-RL-299`).

### 14.23 Performance follow-ups deferred

Two follow-up items remain on the books from a code review and were deferred from the initial build:

- **Web Worker + rbush spatial index for `joinTopNByArea`**. Currently O(parcels × overlays) on the UI thread; on a 1,000-parcel Niverville-Both-Changed sweep this can briefly freeze the table render. A worker import of just `@turf/intersect` + `@turf/area`, plus an rbush bbox index built once per call, would lift the join off the main thread and skip per-parcel bbox checks via the index.
- **Precomputed per-muni JSON artifact**. Generated by the existing `r/download_parcels.R` pipeline as `web/public/muni-cache/<muni>.json` carrying `{ parcelOid → { z1, z1ratio, z2, z2ratio, dp1 } }`. Frontend would opportunistically fetch and skip the live spatial join when the artifact is fresh (< 14 days). Only worth adding if the worker pass alone doesn't deliver enough headroom.

A scheduled remote-agent has been queued to revisit both items two weeks after launch and benchmark before / after on a stress-test query (Stonewall and a large rural RM). See git history for the relevant `RemoteTrigger` routine.

---

## 15. Bulk roll-number search

A common appraisal-research workflow is "I have a list of 25 rolls from a client engagement — show me all of them on one map." This section documents how the Manitoba site implements that, and what changes for the Winnipeg sister site (Socrata) when porting the pattern over.

### 15.1 User-facing behaviour

The existing single Roll # input transparently accepts a list. One roll continues to work as before; pasting a comma- (or whitespace- or newline-) separated list of rolls runs them all in one query.

- **Within a single municipality** is the supported scope. The Roll # field's hint text says so explicitly. Cross-muni bulk lookups via roll number aren't supported because Roll # digits aren't unique across munis (`3600` exists in dozens of RMs, all referring to different parcels).
- **Result count is bulk-aware.** When a list of more than one roll is detected, the count badge reads e.g. `23 of 25 rolls matched` and any rolls that didn't match are listed inline (capped at 10, with `and N others` for longer typo-runs).
- **Same enrichment as a single search.** Top-2 zoning, dev-plan, Changes column, Assess-{year}, all the link cells. The bulk path is just a different `where` clause; everything downstream (overlay enrichment, table render, map fit-to-bounds, CSV export) is unchanged.

### 15.2 Implementation — `arcgis.js`

Two helpers are exported alongside `searchParcels`:

```js
export function parseRollList(input) {
  // Splits on /[\s,;]+/, trims, dedupes preserving first-seen order.
  // Empty array for empty input.
}

export function missingRollsFromResults(input, parcelFc) {
  // Diff parseRollList(input) against the Roll_No_Txt values in
  // parcelFc.features. Compares both the bare input form and the
  // ".000"-suffixed form, so e.g. user typing "3600" matches a
  // returned "3600.000". Returns the list of input rolls that
  // didn't match anything, in user-input order.
}
```

A third helper canonicalizes user input to the source's stored form before the SQL clause is built:

```js
export function canonicalRoll(input) {
  // <digits>(.<digits>)? → <digits>.<3 digits>
  // pads (or defensively truncates) the fractional part to 3 digits;
  // appends ".000" when no dot is present. Pure-junk inputs pass
  // through unchanged so the missing-rolls diagnostic can flag them.
}
```

ROLL_ENTRY always stores `Roll_No_Txt` as `<digits>.<3 digits>` (e.g. `"3600.000"`, `"3600.001"`, `"3600.500"`), so the input forms a user is likely to type — `3600`, `3600.0`, `3600.01`, `3600.1` — all need to fold to that canonical form before equality comparison. Canonicalize **once**, on both sides of any comparison: the SQL IN-list, and the diff in `missingRollsFromResults`.

`searchParcels()`'s Roll # branch:

```js
const rollList = parseRollList(roll);
if (rollList.length > 0) {
  const expanded = new Set();
  for (const r of rollList) expanded.add(canonicalRoll(r));
  const inList = [...expanded].map((v) => `'${escapeSql(v)}'`).join(',');
  clauses.push(`Roll_No_Txt IN (${inList})`);
}
```

For the Winnipeg sister site, the same shape works with SoQL syntax — but **double-check the storage format first**. Probe the `d4mq-wa44` Assessment Parcels dataset with `?$select=roll_number&$limit=10` to see whether Winnipeg's roll numbers also carry a fractional suffix or are clean integers. If they're clean integers, drop `canonicalRoll()` from the Winnipeg port; otherwise port the helper with the suffix-width that Winnipeg actually uses (Manitoba's is 3 digits — Winnipeg may differ). The where-clause shape stays the same:

```js
const inList = [...expanded].map((v) => `'${escapeSoql(v)}'`).join(',');
clauses.push(`upper(roll_number) IN (${inList})`);
```

Note `upper()` wrapping for case-insensitive match (Bug 10.1 in §10) and that Winnipeg's Assessment Parcels dataset uses `roll_number`, not `Roll_No_Txt`.

### 15.3 Implementation — `main.js`

`runSearch()` after the parcel fetch:

```js
const rollList = parseRollList(inputs.roll);
const isBulkRollSearch = rollList.length > 1;
let missingRolls = [];
if (isBulkRollSearch) {
  missingRolls = missingRollsFromResults(inputs.roll, parcelFc);
}
```

The count-message branch then stitches in a `${n} of ${rollList.length} rolls matched` label and, when missing rolls exist, appends `${missingRolls.length} of ${rollList.length} not found: 1234, 5678 and 3 others` to the cap-notes parens. Single-roll searches keep the old `${n} parcels found` phrasing untouched, so the change is invisible to the existing single-roll workflow.

### 15.4 SQL92 caveats for bulk IN-lists

Practical limits on the `where` clause length:

- ArcGIS Online feature services accept reasonably long `IN (...)` lists in practice — we run the parcel query as POST with a form-encoded body (§14.4), so the query string isn't limited by URL length. A list of 200+ rolls (~5 KB) fits comfortably; beyond that, batch the list client-side and union the result FCs.
- Socrata accepts `IN (...)` of similar length over POST. Switch the search call to POST if it isn't already.
- ArcGIS REST has a quirk where extremely long lists can occasionally trigger a 400 with no helpful body. If a user reports that a 500-roll paste fails, batch into chunks of 200 and `Promise.all` the responses — the existing pagination helper (`fetchAllPages`) gives you the pattern.

### 15.5 Future: cross-muni bulk via LINC

Manitoba's offline `mao-assembly` pipeline computes a synthetic LINC per parcel as `<3-digit muni code>R<roll number>` (see `mao-assembly/scripts/1CombineMBFiles.R`). LINC is unique province-wide by construction, so a LINC-based bulk search would let users paste cross-muni roll lists.

The live ROLL_ENTRY layer doesn't carry LINC as a field today — adding cross-muni bulk would require either:

1. **A precomputed LINC → (Muni, Roll) lookup** generated by the offline pipeline and shipped as a static JSON in `web/public/data/`. Frontend resolves each pasted LINC to a `(Muni_Name_With_Typ, Roll_No_Txt)` pair, groups by muni, fires one `searchParcels` call per muni, unions the results. Same JSON-ship approach as the legal-search index. Complexity is moderate; staleness only matters when amalgamations happen (multi-year cadence).
2. **A LINC-equivalent computed at query time** — `Municipality + Roll_No_Txt` concatenated server-side. Doable but pushes parsing logic into both client and SQL, and ROLL_ENTRY's `Municipality` field is human-readable text (`"193 - MUNICIPALITY OF SWAN VALLEY WEST"`) not the bare 3-digit code, so it's awkward.

The first approach is cleaner; deferred until users actually hit the cross-muni-via-roll pattern often enough to justify the build pipeline. For now, the UI's Roll # hint text explicitly scopes bulk searches to a selected muni.

### 15.6 Tests / validation

Smoke tests for the bulk path:

| Input | Expected |
|---|---|
| `3600` | Canonicalized to `3600.000`. Count: `1 parcels found`. |
| `3600.000` | Same canonical form; same result. |
| `3600.0` | Padded to `3600.000`; same result. |
| `3600.01` | Padded to `3600.010` and matched against the canonical-form result set. |
| `3600.1` | Padded to `3600.100` and matched. |
| `3600.500` | Used verbatim; matches a real `3600.500` parcel. |
| `3600,3700,3800` (in muni) | Bulk: `3 of 3 rolls matched`. Three parcels on map + table. |
| `3600,9999999,3700` (one bogus) | `2 of 3 rolls matched (1 of 3 not found: 9999999)`. |
| 25 rolls, 3 typos | `22 of 25 rolls matched (3 of 25 not found: 9999999, 8888, 7777)`. |
| 12 rolls, 11 typos | `1 of 12 rolls matched (11 of 12 not found: a, b, c, d, e, f, g, h, i, j and 1 others)`. |
| 25 typos, 0 valid | `No parcels found — none of the 25 rolls matched in this municipality.` |
| Same roll twice (`3600,3600`) | `parseRollList` dedupes — single-roll behaviour. |
| Same roll two forms (`3600,3600.000,3600.0`) | All canonicalize to `3600.000`; the Set in `searchParcels` dedupes; missing-rolls diagnostic returns nothing because all three input forms match. |
| Mixed separators (`3600 , 3700; 3800\n3900`) | All four parsed; bulk path runs.
