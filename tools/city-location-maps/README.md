# City location maps

The city pages of the 2026 Manitoba highway map
(`D:\Dropbox\Appraisal\Maps\Manitoba\Highways-2026\<city>.pdf`) as base maps
for the location-map figure: "Subject Property Location within Brandon" with
the usual SUBJECT callout. The Addenda Pack adds one after the Manitoba map
whenever the subject is inside that city's limits (`web/src/lib/cityMaps.js`).

Live: Brandon, Steinbach, Thompson (2026-10-21). Still to do: Dauphin,
Flin Flon, Morden, Neepawa, Niverville, Portage la Prairie, Selkirk,
Stonewall, The Pas, Winkler. `portagelaprairie.pdf` is a byte-identical
copy of `portage_la_prairie.pdf`. `winnipeg.pdf` is not needed: the
Winnipeg map with its downtown inset is already a base map.

## Adding a city

Run everything from a scratch work directory (the scripts write their
intermediate files into the current directory), with `python -I`.

1. **OSM roads**: `python -I osm.py <city> "<MUNI (TYPE)>"` writes
   `osm_<city>.json`. Overpass sometimes answers 502; run it again.
2. **Seed from street names**: `python -I namefit.py <city>` matches the
   page's street labels to OSM ways of the same name. The scale is held at
   the page's scale bar (47 pt = 1 km on every page), so only rotation and
   offset are searched. Writes `init_<city>.json`. Expect a median of
   ~20 m and rotation within a couple of degrees of north-up.
3. **Fit to the drawn roads**: `python -I roadfit.py <city>` runs a
   trimmed ICP of the page's road strokes against the OSM roads, first as a
   similarity and then as a full affine. Writes `fit_<city>.json`. Good
   fits so far: median 2.0-4.8 m, anisotropy within 1.5%.
4. **Build**: `python -I build.py <workdir> brandon steinbach thompson <city>`.
   List every city, because the data file is rewritten whole. This crops
   each page to its ink plus a white title band, writes
   `web/public/city-<city>.svg` and regenerates `web/src/lib/cityMapData.js`.
5. **Check by eye**: project two or three OSM street intersections and
   render the page zoomed around them. The mark must sit on the drawn
   crossing. Add those points (source-PDF page coordinates) to `CROSSINGS`
   in `web/test/cityMaps.test.js`; the test fails for a city without them.
6. Add the city's id to `CITY_MAP_IDS` in `web/src/lib/cityMaps.js`, and its
   name to the Addenda Pack button's tooltip in `web/index.html`. If the
   municipality is not `<NAME> (CITY)`, check its `MUNI_LIST_NAME_WITH_TYPE`
   in `web/public/mb-municipalities.geojson` against `CITIES` in `build.py`.

## Traps

- **The yellow city fill is not the city limits.** On Brandon it is
  clipped at the map frame, and Thompson's page shows only the core. A fit
  to the municipal boundary converged on garbage (shear 0.79). Fit to roads.
- **A blind translation/rotation search fails on small towns.** OSM has many
  residential streets and tracks that the page leaves out, so the chamfer
  minimum lands somewhere wrong (Thompson: 16 m/pt at -103 degrees). The
  street-name seed fixes that. Without a fixed scale, the name seed also
  drifts (Steinbach 53 m/pt), so keep it pinned to the scale bar.
- **Drawings run far past the page** under clip paths, so their own rects
  are useless for cropping. `build.py` crops from a render's ink instead.
- **The pages differ in size** (Brandon 518 pt wide, Steinbach 272), while
  the callout and title are sized in map units. `cityMaps.js` measures every
  page as 380 units wide so the SUBJECT box reads the same in every figure.
- The PDFs embed their fonts, so unlike the NRCan Manitoba overview no
  Ghostscript font pass is needed.
