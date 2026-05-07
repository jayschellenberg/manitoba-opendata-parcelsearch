# Handoff - Manitoba Open Data Parcel Search

Last updated: 2026-05-07

## Current verified state

- Local app is running at `http://127.0.0.1:5173/`.
- Production build passed with `npm run build -- --emptyOutDir=false` from `web/`. The only output note was Vite's existing large-chunk warning.
- MASC river-lot data exists and is surfaced for the reported target munis. The scripted Karpathy loop passed 20/20 cases across `ST ANDREWS (RM)`, `ST CLEMENTS (RM)`, `STE ANNE (RM)`, dotted spellings, `RM OF ...` spellings, and layer/search order variations.
- Target parcel smoke checks passed from the generated shards:
  - `ST ANDREWS (RM)` roll `100.000` -> Soil `C`, source `River lot ADRL-3Q`.
  - `ST CLEMENTS (RM)` roll `100.000` -> Soil `C`, source `River lot ADRL-199Q`.
  - `STE ANNE (RM)` roll `100000.000` -> Soil `D`, source `River lot ANRL-83T`.
  - `DE SALABERRY (RM)` roll `158550.000` -> Soil `C`, source `River lot RR-RL-31`.
  - `MORRIS (RM)` roll `254000.000` -> Soil `C`, source `River lot AG-RL-299`.
- De Salaberry/Morris Red River review passed after regeneration: Morris has 405/405 river-lot-touching parcels with Soil ratings; De Salaberry has 629/630, with the single residual being a 0.355 m2 boundary sliver against `RR-RL-M`, not a real parcel coverage gap.
- In-app browser check confirmed `ST ANDREWS (RM)` roll `100.000` rendered Soil `C` with tooltip `Source: River lot ADRL-3Q`. The Browser plugin then failed to restart its app-server after a reset, so the remaining browser clicks were verified by build/static loops rather than screenshots.
- Earlier RITCHOT smoke state remains valid: select `RITCHOT (RM)`, toggle `MASC Rating`, and the app should not report `No MASC soil ratings on file for RITCHOT (RM)`.
- MASC quarter and river-lot labels now render only the A-J soil rating letter. Risk-area labels live on the separate `MASC Risk Areas` overlay sourced from Manitoba Maps / Open Canada.
- 2026-05-07 MASC coverage-gap review found no hidden ratings to reassign for West Interlake, Piney, Tache, Riding Mountain West, Dauphin, Alonsa, Gilbert Plains, Portage la Prairie, Two Borders, or Armstrong. Each target's largest blank polygon had zero source MASC quarter centroids inside it, including zero centroids filed under another municipality.

## MASC implementation notes

- `web/src/arcgis.js` loads MASC map shards from `web/public/data/masc/` through `fetchMascRatingsForMuni()`. The selected dropdown value includes the type suffix, e.g. `RITCHOT (RM)`, while MASC shard keys are bare names, e.g. `RITCHOT`; `lookupMuniManifestEntry(..., { stripType: true })` handles that mismatch.
- `web/src/arcgis.js` loads parcel-level dominant MASC soil ratings from `web/public/data/parcel-masc/` through `fetchParcelMascForMuni()`. Those shards are keyed by original `Muni_Name_With_Typ`, so they use `stripType: false`. The compact lookup preserves type while tolerating `RM OF ST ANDREWS` / dotted `ST.` spelling variants.
- `web/src/arcgis.js` loads rated river-lot polygons from `web/public/data/masc-riverlots.json` through `fetchMascRiverlots()`. Cache keys are currently `mb_parcel_masc_*_v4` and `mb_masc_riverlots_v3` to invalidate stale browser data after the De Salaberry river-lot artifact refresh.
- `web/src/arcgis.js` also loads official risk-area polygons from `MASC_Risk_Areas/FeatureServer/0` via `fetchMascRiskAreas()`. Source package: <https://open.canada.ca/data/en/dataset/739cb8ed-b661-5a60-7a26-eb60cd06541f>.
- `web/src/masc.js` converts each MASC centroid row into an approximate 800 m quarter-section polygon and preserves `rating` plus the legacy `ra` field, but the UI no longer displays `ra` as a risk label.
- `web/src/map.js` paints `masc-fill` by rating and renders `masc-label` as the MASC letter only. It also exposes `masc-risk-area-*` fill/line/label layers for official risk areas.
- `web/src/main.js` toggles MASC visibility, lazy-loads the active municipality shard plus rated river lots, shows the MASC legend while active, and stamps `_soilRiskArea` from the official risk-area polygon containing each parcel's bbox-centre point. River-lot overlay matching checks both `properties.muni` (polygon-majority municipality) and `properties.rating_muni` (MASC source municipality), then falls back to shared bare names only when no exact match exists; this handles same-name enclave cases such as `STE ANNE (RM)` and split-boundary cases such as De Salaberry lots 27-31 majority-tagged to `ST PIERRE-JOLYS (VILLAGE)`.
- Overlay click handlers now bind together in the same early overlay-control block, matching the working `MASC Risk Areas` button and avoiding split listener setup for MASC/Grid/CLI.

## MASC coverage-gap review

The 2026-05-07 gap review tested the current generated MASC quarter shards, rated river-lot overlay, Roll Entry parcels, municipal boundaries, zoning, and development-plan polygons. The fix path that worked for De Salaberry was tested first: look inside each blank for MASC source centroids that exist but are filed under another municipality. All target blanks returned zero source centroids, so there is nothing safe to reassign into the MASC map overlay from the current source data.

| Municipality | Largest current MASC blank | Source centroids in blank | Parcel centroids in blank | Parcel-MASC ratings already available in blank | Read |
| --- | ---: | ---: | ---: | ---: | --- |
| `WEST INTERLAKE (RM)` | 185.8 km2 | 0 | 170 | 97 | Mixed natural/ag fringe: mostly WMA plus agricultural designations; source gap/non-rated area. |
| `PINEY (RM)` | 158.8 km2 | 0 | 100 | 99 | Mixed provincial forest/rural/ag fringe; source gap/non-rated area. |
| `TACHE (RM)` | 44.3 km2 | 0 | 173 | 57 | Mostly agricultural/escarpment/rural living; true MASC source gap or non-rated ag/rural area. |
| `RIDING MOUNTAIN WEST (RM)` | 236.3 km2 | 0 | 115 | 31 | Agricultural policy area; true MASC source gap/non-rated ag/rural area. |
| `DAUPHIN (RM)` | 224.2 km2 | 0 | 25 | 16 | Agricultural/rural area; true MASC source gap/non-rated ag/rural area. |
| `ALONSA (RM)` | 193.5 km2 | 0 | 322 | 179 | Mostly agriculture; true MASC source gap/non-rated ag/rural area. |
| `GILBERT PLAINS (MUNICIPALITY)` | 176.7 km2 | 0 | 34 | 7 | Rural agricultural area; true MASC source gap/non-rated ag/rural area. |
| `PORTAGE LA PRAIRIE (RM)` | 186.9 km2 | 0 | 492 | 128 | Mostly agricultural; true MASC source gap/non-rated ag/rural area. |
| `TWO BORDERS (MUNICIPALITY)` | 131.2 km2 | 0 | 53 | 36 | Agricultural policy area; true MASC source gap/non-rated ag/rural area. |
| `ARMSTRONG (RM)` | 112.9 km2 | 0 | 18 | 15 | Mostly agricultural; true MASC source gap/non-rated ag/rural area. |

Some parcel-MASC table ratings appear inside these blank polygons because parcel geometries touch nearby rated quarters/river lots or because the parcel build can use an area/nearest fallback for parcel attribution. That does not justify painting the MASC map overlay across a blank polygon; the overlay should remain source-faithful until a newer MASC file supplies explicit ratings.

## Generated artifacts

- `web/public/data/masc/` is built by `Rscript r/build_masc_shards.R` from `masc_soil_ratings_with_latlon.csv`. Current workspace includes a `RITCHOT.json` shard with 240 rows and a `_index.json` manifest entry for `RITCHOT`.
- `web/public/data/parcel-masc/` is built by `Rscript r/build_parcel_masc.R` from the latest `RollEntry_YYYYMMDD.gpkg` plus the MASC quarter CSV and optional river-lot scrape/KMZ. It supplies the table's dominant Soil column only; Risk Area is now official live/reference data. Current regenerated shards include `source` and `label` fields so river-lot tooltips can use explicit labels.
- `web/public/data/masc-riverlots.json` is also built by `r/build_parcel_masc.R`; it paints the MASC layer for long/narrow rated river-lot polygons that the quarter-section CSV does not cover. Features carry `muni` and `rating_muni` where those differ.
- `masc_soil_ratings_with_latlon.csv`, dated GeoPackages, and other large inputs are local/generated inputs and are ignored by git.
- `ST_PIERRE-JOLYS_VILLAGE.json` is an expected generated parcel-MASC shard after the De Salaberry split-boundary regeneration.

## Verification checklist

1. From `web/`, run `npm run build -- --emptyOutDir=false`.
2. Start local dev with `npm run dev -- --host 127.0.0.1 --port 5173`.
3. Open `http://127.0.0.1:5173/`.
4. Select `RITCHOT (RM)`.
5. Toggle `MASC Rating`; confirm the button becomes active and no "No MASC soil ratings..." message appears.
6. Zoom to at least level 13 near the RITCHOT/St. Adolphe area; confirm quarter sections show colour plus rating-letter labels only.
7. Toggle `MASC Risk Areas`; confirm official risk boundaries/labels appear separately.
8. Search `ST ANDREWS (RM)` + roll `100.000`; confirm the row shows Soil `C` and the Soil tooltip says `Source: River lot ADRL-3Q`.
9. Search `ST CLEMENTS (RM)` + roll `100.000`; confirm the row shows Soil `C` and the Soil tooltip says `Source: River lot ADRL-199Q`.
10. Search `STE ANNE (RM)` + roll `100000.000`; confirm the row shows Soil `D` and the Soil tooltip says `Source: River lot ANRL-83T`.
11. Search `DE SALABERRY (RM)` + roll `158550.000`; confirm the row shows Soil `C` and the Soil tooltip says `Source: River lot RR-RL-31`.
12. Search `MORRIS (RM)` + roll `254000.000`; confirm the row shows Soil `C` and the Soil tooltip says `Source: River lot AG-RL-299`.
13. If stale results appear, use the app's Clear button or remove `mbpsCache.*` entries from browser `localStorage`.

## Open notes

- MASC quarter polygons are visual approximations from centroids, not legal survey boundaries.
- Some municipalities and parcels legitimately have no MASC soil coverage, especially urban-only areas or parcels outside rated farmland.
- MASC cache keys are versioned. Bump the relevant version in `arcgis.js` after changing shard lookup semantics or generated shard shapes.
- The De Salaberry audit has one residual missing river-lot-touching parcel, roll `52000.000`, because it overlaps rated `RR-RL-M` by only about 0.355 m2. Treat that as a boundary sliver unless the source parcel geometry changes.
- If Vite reports `Outdated Optimize Dep` / `EBUSY` in this Dropbox workspace after adding a dependency, use `VITE_CACHE_DIR` to move the optimize cache to `%TEMP%` before `npm run dev -- --force`.
