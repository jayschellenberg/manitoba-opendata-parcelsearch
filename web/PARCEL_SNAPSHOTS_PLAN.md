# Parcel Satellite Snapshots — Feature Notes

## Status

✅ Implemented and on `origin/main`. Feature commit `edfdb2c` ("Add parcel
satellite-snapshot export …"), with follow-up tuning on top (section grid on,
2× roll-number labels, wider frame margin). `npm test` is green (including
`zipStore.test.js: 3 passed`) and `npm run build` transforms every module
cleanly. The only thing that can't be checked headless is the manual
in-browser smoke test (needs a live browser/WebGL session — see Verification).

> Resume on another PC: `git pull origin main` → `cd web` → `npm install`
> (node_modules is gitignored) → `npm test` → `npm run build` → `npm run dev`.
> A Mapbox token (`.env.local`) is only needed for routing; the snapshot
> feature itself uses keyless Esri World Imagery.

## What it does

From any non-empty result set — an imported parcel list, or Sales Analysis
after importing a list (both flow through `setMapData`, which stashes
`lastResultFc`) — the **Parcel Snapshots (ZIP)** button renders one
1600×900 (16:9) satellite **JPEG** per parcel (~250–400 KB each, well under
1 MB — PNG of the same satellite frame ran ~3 MB) and downloads them as a
single `parcel-snapshots-YYYY-MM-DD.zip`. Each frame:

- the subject parcel in the same **yellow** highlight a normal search produces;
- surrounding parcel lines + roll-number labels from the muni fabric, with the
  roll labels rendered at **2×** (these snapshots are mostly larger rural
  parcels viewed at a further-out zoom, where the base label ramp is too small);
- the **section/township (DLS) grid** turned on;
- zoomed to the tightest extent that fits 16:9 with a **96 px** margin.

Files are named `{muniCode}-{roll}.jpg` (roll trims the canonical trailing
`.000`; duplicates get `-2`, `-3`, … suffixes). A second click on the button
cancels the in-flight batch. Everything is client-side, so it works on the
deployed Vercel site too.

## Architecture

A dedicated hidden 1920×1080 MapLibre **export map** (detached container at
`left:-10000px`, `preserveDrawingBuffer:true`), separate from the visible
interactive map, so output is exactly 16:9 regardless of window size and the
on-screen view is left untouched during a multi-minute batch. `initMap()`
builds the full style (Esri satellite basemap + highlight / muni-parcel /
roll-label / survey-grid layers), so snapshots look identical to an on-screen
search result with zero re-styling.

Capture loop, grouped by muni for efficiency:

1. Group resolved parcels by `Muni_Name_With_Typ`.
2. Per muni → fetch its parcel fabric once (`fetchAllParcelsInMunicipality`,
   cached) → `setMuniParcelsData` (yields surrounding lines + roll labels), and
   fetch its section grid once → `setSurveyGridData`.
3. Per subject parcel:
   - `showResults(map, {…single feature…}, { fit: false })` — the yellow
     highlight a normal search produces.
   - `fitParcelTo16by9` (`fitBounds`, `FRAME_PADDING` margin, `EXPORT_MAX_ZOOM`).
   - wait for `idle` (with an `IDLE_TIMEOUT_MS` safety net).
   - read the WebGL canvas, downscale to exactly 1600×900, burn in the live
     Esri attribution → JPEG blob → add to ZIP.
4. Build the ZIP → single download.

The section-grid fetch lives in **main.js** (`buildSurveyGridForSnapshot`,
injected as the `fetchSurveyGrid` option) because it needs the loaded
municipal-boundaries FC to scope the survey-grid query. It resolves the muni's
boundary polygon (exact match on `MUNI_LIST_NAME_WITH_TYPE`, then a tolerant
`normalizeMuniKey` match — the parcel FC carries Roll-Entry's
`Muni_Name_With_Typ`, which can differ in punctuation/accents), fetches the
grid, and converts it via `surveyFcToRows` → `sectionLinesFromRows` — the same
per-muni pipeline `toggleSurveyGridOverlay()` uses. If a muni can't be matched,
that muni's snapshots simply omit the grid (the rest still render). The
province-wide grid file is far too large (≈41 MB / 215k features) to load into
the export map, so per-muni scoping is deliberate.

### ZIP writer

`src/lib/zipStore.js` — ~50-line **store-only** (no deflate) writer + CRC32,
no new deps (PNGs are already DEFLATE-compressed internally). Emits a standard
PKZIP archive (local headers + central directory + EOCD) that Explorer, macOS
Archive Utility, 7-Zip and `unzip` all open. No ZIP64 / folders / timestamps
(deterministic output).

## Files added / changed

- **NEW** `src/lib/zipStore.js` — store-only ZIP writer + CRC32.
- **NEW** `src/lib/imageOutput.js` — shared raster-output settings (JPEG,
  quality, dimensions) used by both the snapshots and Generate Map, so the
  two stay in sync.
- **NEW** `src/snapshotExport.js` — offscreen 1600×900 map + capture loop.
  Exports `generateParcelSnapshotsZip(parcelFc, { onProgress, signal,
  fetchMuniFabric, fetchSurveyGrid })`, plus `fitParcelTo16by9` / `fileNameFor`
  (exported for unit testing).
- **NEW** `test/zipStore.test.js` — CRC32 check value + ZIP round-trip + empty list.
- `src/map.js` — added `setBasemapSatellite(map, on)`.
- `index.html` — added `#snapshot-zip-btn` in the export-row.
- `src/main.js` — import; `lastResultFc` captured in `setMapData`;
  `updateSnapshotButton()` / `handleSnapshotExport()` / `buildSurveyGridForSnapshot()`
  wiring (~line 1285). One button serves both entry points. `composeWithAttribution`
  (the **Generate Map** static image) now downscales to `MAX_OUTPUT_DIM` and
  encodes JPEG via the same `imageOutput.js` settings.
- `package.json` — added `test/zipStore.test.js` to the `test` script.

Output settings (`src/lib/imageOutput.js`): `OUTPUT_MIME = image/jpeg`,
`OUTPUT_QUALITY = 0.85`, `SNAPSHOT_W/H = 1600×900`, `MAX_OUTPUT_DIM = 1600`.
Snapshot framing constants (`snapshotExport.js`): `FRAME_PADDING = 96` (CSS
px), `ROLL_LABEL_SCALE = 2`, `EXPORT_MAX_ZOOM = 20`, `IDLE_TIMEOUT_MS = 9000`.

## Key reuse points (file:line)

- **Map lib:** MapLibre GL JS (`maplibre-gl`); Mapbox APIs only used for routing.
- **Satellite basemap:** Esri World Imagery raster source/layers in `src/map.js`
  (`esri-imagery` / `esri-transportation` / `esri-reference`), swapped by the
  exported `setBasemapSatellite`.
- **Highlight + fit:** `showResults(map, fc, { fit })` `src/map.js:1968` sets the
  `'parcels'` source; yellow fill/line `#ffea00` at `src/map.js:1268`+.
- **Muni fabric:** `muni-parcels-*` layers `src/map.js:1049`+; roll-label
  text-size ramp (zoom × acreage) at `src/map.js:1111`. Setters
  `setMuniParcelsData` / `setMuniParcelsVisible`.
- **Section grid:** `survey-grid*` layers `src/map.js:958`+; setters
  `setSurveyGridData` / `setSurveyGridVisible`. Data pipeline
  `fetchSurveyGridForMuni` (`src/arcgis.js:1289`) → `surveyFcToRows` →
  `sectionLinesFromRows` (`src/masc.js`).
- **Canvas capture:** `preserveDrawingBuffer:true` (`src/map.js`); `idle` event;
  attribution composited into the corner (mirrors the on-screen "Generate Map").

## Verification checklist

1. `cd web && npm test` — `zipStore.test.js: 3 passed` plus the existing suite
   green. ✅ run, passing.
2. `npm run build` — all modules transform (catches import/syntax errors). ✅
   transforms clean. (The build's final output-dir cleanup can `EPERM` if
   Dropbox holds a lock on `dist/data`; that's environmental, not the feature.)
3. `npm run dev`, then import a parcel list (or run a search) → the **Parcel
   Snapshots (ZIP)** button enables → click → watch the `Capturing N/total…`
   label → a `parcel-snapshots-YYYY-MM-DD.zip` downloads with one
   `muniCode-roll.jpg` per parcel (1600×900 JPEG ≤1 MB, satellite, yellow-
   highlighted subject, surrounding parcel lines + 2× roll labels,
   section/township grid on, 96 px margin). ← **manual, pending** (needs a
   browser/WebGL session).
4. Multi-muni list → confirm each muni's fabric **and grid** load and filenames
   carry the right muni-code prefix. Click the button again mid-run → confirms
   Cancel.

## Caveats

- Esri World Imagery details out around z20 → very small urban parcels fill the
  frame but look soft (upscaled); rural/ag parcels stay crisp. This feature is
  aimed at the rural/farmland case.
- `composeWithAttribution`-style credit is burned into each PNG → keeps saved
  images compliant with Esri terms.
