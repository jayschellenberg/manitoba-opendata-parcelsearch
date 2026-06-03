# Parcel Satellite Snapshots — Implementation Plan / Resume Doc

## ▶ RESUME FROM ANOTHER PC (read this first)

**Where the work lives:** commit `feat/parcel-snapshots` (see commit hash in the
git log). On the other PC:
```
git fetch origin
git checkout feat/parcel-snapshots   # or: git pull, if it was merged to main
cd web
npm install                          # node_modules is gitignored
cp .env.example .env.local           # then paste your Mapbox token (routing only;
                                     # the snapshot feature itself needs NO token —
                                     # it uses keyless Esri World Imagery)
npm test                             # expect "zipStore.test.js: 3 passed" + suite green
npm run build                        # confirms imports/syntax
npm run dev                          # manual check (see Verification checklist)
```

**What's DONE:** the whole feature is implemented and wired (files list below).
**What REMAINS:** only verification — `npm test`, `npm run build`, and the manual
in-browser smoke test in the "Verification checklist" section. I could not run
node in the authoring shell (not on PATH), so none of those have been executed
yet. No code work is believed outstanding; if a test/build surfaces an issue,
fix it then.

**Note on unrelated changes:** the working tree also had pre-existing, unrelated
edits to `dashboard/*`, `.gitignore`, and `start-dashboard.bat` (a dashboard
control-panel refactor) that are NOT part of this feature. They were handled
separately from the `feat/parcel-snapshots` commit — confirm their state with
`git log`/`git status` if you care about them.

---

**Status:** ✅ IMPLEMENTED (2026-06-02). Pending: `npm test` + `npm run build`
+ manual in-browser verification (node was not on PATH in the build shell, so
the suite/build could not be run here — see "Verification checklist" below).

### Files added / changed
- **NEW** `src/lib/zipStore.js` — store-only ZIP writer + CRC32 (no new deps).
- **NEW** `src/snapshotExport.js` — offscreen 1920×1080 map + capture loop;
  exports `generateParcelSnapshotsZip(parcelFc, { onProgress, signal, fetchMuniFabric })`.
- **NEW** `test/zipStore.test.js` — CRC32 check value + ZIP round-trip + empty-list.
- `src/map.js` — added exported `setBasemapSatellite(map, on)`.
- `index.html` — added `#snapshot-zip-btn` in the export-row.
- `src/main.js` — import; `lastResultFc` state captured in `setMapData`;
  `updateSnapshotButton()` / `handleSnapshotExport()` / `downloadBlob()` wiring
  (~line 1285). Second click on the button cancels the in-flight batch.
- `package.json` — added `test/zipStore.test.js` to the `test` script.

### Verification checklist (run in user's environment)
1. `cd web && npm test` — expect `zipStore.test.js: 3 passed` plus the existing suite green.
2. `npm run build` — expect a clean Vite build (catches import/syntax errors).
3. `npm run dev`, then: import a parcel list (or run any search) → the
   **Parcel Snapshots (ZIP)** button enables → click → watch the
   `Capturing N/total…` label → a `parcel-snapshots-YYYY-MM-DD.zip` downloads
   with one `muniCode-roll.png` (1920×1080, satellite, yellow-highlighted
   subject, surrounding parcel lines + roll labels, small margin) per parcel.
4. Multi-muni list → confirm each muni's fabric loads and filenames carry the
   right muni code prefix. Click the button again mid-run → confirms Cancel.

### Original plan follows (for reference)


**Goal:** From an imported parcel list (or from Sales Analysis after importing a
list), generate a satellite PNG of each parcel with the subject parcel
highlighted, zoomed to the maximum extent that fits a 16:9 frame. Each file
named `{muniCode}-{roll}.png`, all delivered as a **single ZIP download**.

## Confirmed requirements (from user)

- **Delivery:** one ZIP download (fully client-side; works on deployed Vercel site too).
- **Batch size:** ~25–150 parcels typical → live sequential capture is fine; needs progress UI + Cancel.
- **Frame content:** reuse the *existing* search-result highlight look (red fill+outline, same opacity), PLUS surrounding parcel lines, PLUS roll-number label, PLUS a small padding margin (not tightest-possible fit).
- **Dimensions:** 1920×1080 (16:9).

## Decision: integrate into `web/` (do NOT build separate app)

The app already has every primitive. Reuse, don't rebuild.

## Architecture

A **dedicated hidden 1920×1080 MapLibre export map** (detached container at
`left:-99999px`, `width:1920px; height:1080px`, `preserveDrawingBuffer:true`),
separate from the visible interactive map. Why a second map:
- Forces exact 16:9 / 1920×1080 output regardless of the user's window size.
- Leaves the on-screen view untouched during a multi-minute batch.
- Loads the same style → Esri satellite basemap + existing highlight/muni-parcel/roll-label layers all available → snapshots look identical to an on-screen search result.

Must call `map.resize()` after attaching; wait for `load` then per-muni `idle`.

### Capture loop (grouped by muni for efficiency)

1. Group resolved parcels by `muni_no`.
2. For each muni → fetch its parcel fabric **once** (reuse `searchParcels` /
   `fetchAllParcelsInMunicipality`) → set on export map's `muni-parcels` source
   via `setMuniParcelsData`. This yields **surrounding parcel lines + roll-number
   labels** for free (existing `muni-parcels-fill/line/label` layers).
3. For each subject parcel in that muni:
   - Set the red highlight source (`'parcels'` source, via `showResults` path).
   - `fitBounds(parcelBbox, { padding, duration: 0 })`. On a 16:9 canvas this
     already gives "max extent that fits in 16:9"; `padding` = the small margin.
   - Wait for `map.on('idle')` (mirror `generateStaticMap`).
   - `composeWithAttribution(exportMap.getCanvas())` → PNG blob.
   - Add to ZIP as `{muni}-{roll}.png` (sanitize; trim trailing `.000` like `humanRoll`; strip path-illegal chars).
   - Update progress ("Capturing 37 / 142…"); honor Cancel.
4. Build ZIP → trigger single download.

### ZIP writer

Default: ~50-line **store-only** (no deflate) ZIP writer — PNGs are already
compressed; keeps the project's zero-runtime-dep convention (they hand-rolled
polyline/haversine). Needs local file headers + central directory + CRC32 (~15
lines). Alternative if preferred: add JSZip.

## Integration points (two entry points, one shared function)

Add `generateParcelSnapshotsZip(parcelKeysOrFc)` and wire a **"Generate parcel
snapshots (ZIP)"** button to:
- (a) the imported-list results view, and
- (b) the Sales Analysis post-import view.
Both already converge on a resolved `parcelFc` (FeatureCollection w/ geometry).

## New code footprint

- New `src/snapshotExport.js` (offscreen map + capture loop + orchestration).
- New tiny `src/lib/zipStore.js` (store-only ZIP + CRC32).
- Button(s) in `index.html` (mirror existing static-map section markup).
- ~15 lines wiring in `src/main.js`.

Everything heavy is reused: capture, highlight, satellite basemap, polygon
fetch, bbox/fit, attribution compositing.

## Key reuse points discovered (file:line)

- **Map lib:** MapLibre GL JS (`maplibre-gl`), NOT Mapbox GL JS. Mapbox APIs only used for routing.
- **Satellite basemap:** Esri World Imagery raster — `src/map.js:232-235` (source), layers `esri-imagery` / `esri-transportation` / `esri-reference` at `src/map.js:270-273` (start hidden, basemap toggle swaps). `carto-positron` is the default street basemap (`src/map.js:220`).
- **Canvas capture proven path:** `generateStaticMap()` `src/main.js:1375-1417` — `triggerRepaint()` → `map.on('idle')` → `map.getCanvas()` → `composeWithAttribution(canvas)` → dataURL. `preserveDrawingBuffer:true` at `src/map.js:356`.
- **Highlight + fit:** `showResults(map, parcelFc)` `src/map.js:1968-1985` (sets `'parcels'` source + fitBounds w/ turf `bbox`, padding 60, maxZoom 18). `flyToFeature` at `src/map.js:1987`. Red highlight layer `src/map.js:1237`.
- **Muni fabric:** `muni-parcels` source `src/map.js:1031`; layers `muni-parcels-fill` (1049), `muni-parcels-line` (1056), `muni-parcels-label` = roll labels (1080), `muni-parcels-civic-label` (1202). Exported setters `setMuniParcelsData`, `setMuniParcelsVisible` (imported in main.js:98-99).
- **Parcel polygon fetch:** `searchParcels(args)` `src/arcgis.js:98` (ROLL_ENTRY FeatureServer, returns polygon FC). Also `fetchAllParcelsInMunicipality` (imported main.js:61).
- **List import → parcelKeys:** `src/parcelListResolver.js` `resolveParcelList(rows)` → `{ resolved, unresolved, parcelKeys:[{muni_no, roll_no_txt}], stats }`. UI init `initParcelListImport` from `src/lib/parcelListImport.js` (imported main.js:12). Resolver result stashed in main.js around line ~897 ("resolver returns parcelKeys ready for searchParcels").
- **Roll display rule:** `humanRoll()` trims trailing `.000` (see `parcelListResolver.js:250`).
- **Sales upload flow:** `handleSalesUpload` region begins ~`src/main.js:2036`; merges per-muni FCs into one `parcelFc` (~2111).

## STILL TO VERIFY on resume (was mid-lookup when interrupted)

Run (cwd = `web/`):
```
grep -nE "staticMap|composeWithAttribution|initParcelListImport|mapReady|setMapData|EMPTY_FC|generateStaticMap" src/main.js
```
1. Exact `composeWithAttribution(canvas)` signature/impl (returns dataURL; need blob — use `canvas.toBlob` or convert dataURL).
2. Exact `initParcelListImport` callback signature + where resolved `parcelKeys`/`parcelFc` is held in `main.js` (the stash near line ~897) — that's where button (a) hooks in.
3. `index.html` static-map section markup (`$staticMapBtn`, `$staticMapSection`, `$staticMapOutput`) to mirror for the new button(s).
4. `setMuniParcelsData` signature + how the live app fetches the muni fabric (to reuse for surrounding lines).
5. Sales Analysis post-import view DOM hook for button (b).

## Caveats (noted to user, not blockers)

- Esri World Imagery details out ~zoom 19 → very small urban parcels fill the
  frame but look soft (upscaled). Rural/ag parcels crisp.
- `composeWithAttribution` burns Esri credit into each PNG → keeps saved-image
  use compliant with Esri terms.

## Build/test

- Dev server: `npm run dev` (Vite) in `web/`.
- Tests: `npm test` (node test/*.js). Add a unit test for the ZIP writer + the
  16:9 bbox-padding math if extracted as pure functions.
