# Handoff - Manitoba Open Data Parcel Search

Last updated: 2026-05-06

## Current verified state

- Local app is running at `http://127.0.0.1:5173/`.
- Production build passed with `npm run build -- --emptyOutDir=false` from `web/`. The only output note was Vite's existing large-chunk warning.
- Browser smoke test passed for the reported failure case: select `RITCHOT (RM)`, toggle `MASC Soil`, and the app no longer reports `No MASC soil ratings on file for RITCHOT (RM)`.
- RITCHOT parcel smoke test passed for roll `100.000`: table renders Soil `D` from the generated MASC soil shard and Risk Area `12` from the official MASC Risk Areas polygon layer.
- MASC quarter labels now render only the A-J soil rating letter. Risk-area labels live on the separate `Risk Areas` overlay sourced from Manitoba Maps / Open Canada.

## MASC implementation notes

- `web/src/arcgis.js` loads MASC map shards from `web/public/data/masc/` through `fetchMascRatingsForMuni()`. The selected dropdown value includes the type suffix, e.g. `RITCHOT (RM)`, while MASC shard keys are bare names, e.g. `RITCHOT`; `lookupMuniManifestEntry(..., { stripType: true })` handles that mismatch.
- `web/src/arcgis.js` loads parcel-level dominant MASC soil ratings from `web/public/data/parcel-masc/` through `fetchParcelMascForMuni()`. Those shards are keyed by original `Muni_Name_With_Typ`, so they use `stripType: false`.
- `web/src/arcgis.js` also loads official risk-area polygons from `MASC_Risk_Areas/FeatureServer/0` via `fetchMascRiskAreas()`. Source package: <https://open.canada.ca/data/en/dataset/739cb8ed-b661-5a60-7a26-eb60cd06541f>.
- `web/src/masc.js` converts each MASC centroid row into an approximate 800 m quarter-section polygon and preserves `rating` plus the legacy `ra` field, but the UI no longer displays `ra` as a risk label.
- `web/src/map.js` paints `masc-fill` by rating and renders `masc-label` as the MASC letter only. It also exposes `masc-risk-area-*` fill/line/label layers for official risk areas.
- `web/src/main.js` toggles MASC visibility, lazy-loads the active municipality shard, shows the MASC legend while active, and stamps `_soilRiskArea` from the official risk-area polygon containing each parcel's bbox-centre point.

## Generated artifacts

- `web/public/data/masc/` is built by `Rscript r/build_masc_shards.R` from `masc_soil_ratings_with_latlon.csv`. Current workspace includes a `RITCHOT.json` shard with 240 rows and a `_index.json` manifest entry for `RITCHOT`.
- `web/public/data/parcel-masc/` is built by `Rscript r/build_parcel_masc.R` from the latest `RollEntry_YYYYMMDD.gpkg` plus the MASC CSV. It supplies the table's dominant Soil column only; Risk Area is now official live/reference data.
- `masc_soil_ratings_with_latlon.csv`, dated GeoPackages, and other large inputs are local/generated inputs and are ignored by git.
- `web/public/data/masc/` currently appears as untracked in this workspace. If deploying MASC Soil from a clean clone/Vercel build, commit the generated MASC shards or make sure deployment injects them another way.

## Verification checklist

1. From `web/`, run `npm run build -- --emptyOutDir=false`.
2. Start local dev with `npm run dev -- --host 127.0.0.1 --port 5173`.
3. Open `http://127.0.0.1:5173/`.
4. Select `RITCHOT (RM)`.
5. Toggle `MASC Soil`; confirm the button becomes active and no "No MASC soil ratings..." message appears.
6. Zoom to at least level 13 near the RITCHOT/St. Adolphe area; confirm quarter sections show colour plus rating-letter labels only.
7. Toggle `Risk Areas`; confirm official risk boundaries/labels appear separately.
8. Search `RITCHOT (RM)` + roll `100.000`; confirm the row shows Soil `D` and Risk Area `12`.
9. If stale results appear, use the app's Clear button or remove `mbpsCache.*` entries from browser `localStorage`.

## Open notes

- MASC quarter polygons are visual approximations from centroids, not legal survey boundaries.
- Some municipalities and parcels legitimately have no MASC soil coverage, especially urban-only areas or parcels outside rated farmland.
- MASC cache keys are versioned. Bump the relevant version in `arcgis.js` after changing shard lookup semantics or generated shard shapes.
- If Vite reports `Outdated Optimize Dep` / `EBUSY` in this Dropbox workspace after adding a dependency, use `VITE_CACHE_DIR` to move the optimize cache to `%TEMP%` before `npm run dev -- --force`.
