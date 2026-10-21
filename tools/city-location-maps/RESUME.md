# Resume point — 2026-10-21

## Done
- **City maps (Brandon, Steinbach, Thompson)**: PR #218
  (jayschellenberg/manitoba-opendata-parcelsearch), branch
  `feat/city-location-maps`, CI clean and mergeable. **Not merged**; Jason
  has to say "merge 218". The pack adds `2-city-location-map.png` when the
  subject's municipality is the city. Verified with real headless packs:
  Brandon, Steinbach and Thompson correct, and RM of Cornwallis gets no city
  map.

## In progress: branch `feat/rm-town-location-maps` (from the city branch, nothing committed yet)
Jason's decisions (2026-10-21): add the RM maps
(`D:\Dropbox\Appraisal\Maps\$MunicipalMaps-2017`, 101 PDFs + rm_maps_meta.pdf)
and the town/village plans (`$Town and Village Maps`, ~495 communities: 426
GIF scans + 96 text-less PDFs, some multi-sheet like brandon_01..12)
**automatically** to the Addenda Pack, **in this session**. The rule offered:
RM map when the subject is in that RM, community plan when the subject is
within or next to the community (on its sheet).

Uncommitted new files here: `rmfit.py`, `townfit.py`, `parcelref.py`,
`overlay2.py` (town overlay check), `rmov.py` (RM overlay check: RM
boundary + CGN places), plus the `.gitignore` entry for `work/`. Fit outputs
are saved in `work/` (rm = first full batch, old method; rm-try = new method
on hard cases; town = Anola/Arborg/Alonsa).

### RM maps (rmfit.py): status
- Method: seed from the margin "Tp. N" / "Rge. NE." labels (largest label
  size only; the key-plan inset repeats them small) against township/range
  centres from `web/public/data/section-grid.json`. Fall back to a bbox seed
  plus a corner-label (1/6/31/36) lock. Then ICP of the grey section lines
  (color 0.7) to the section edges, with the radius annealed 600→300→150→80→40 m,
  similarity then affine. Text-less PDFs are OCR'd at 300 dpi.
- First batch (old bbox seed): ~60 good (median 3–10 m, about 88 m/pt =
  1:250k), ~37 locked off. Virden_S2 has no grey lines (it is a town page).
- New method, hard cases: Alexander 6.3 m (13/14 labels OK) good;
  Grahamdale 5.2 m **good by eye** (boundary + places match; its 0/23 label
  score is an OCR artefact, so labels_ok cannot be the only validator).
  Still failing: Ritchot (river lots, 150 m), East St Paul and Headingley
  (only 1 Rge label → bbox seed), Kelsey (170 m).
- Next: rerun the full batch with the new method, then review every map with
  `rmov.py` (red RM boundary + magenta CGN places on the page). Ideas for the
  failures: a seed from OCR'd place names vs mb-places.json (like
  namefit.py), and an ICP against OSM/highway lines instead of section lines
  in river-lot RMs.

### Town plans (townfit.py): status
- Method: OCR (Tesseract at `C:/Program Files/Tesseract-OCR`) for the title
  SEC-TWP-RGE list, the scale bar ("0 100 200 300" + METRES/FEET) and the
  corner labels ("7 / 21-11W"). Seed from the sections, else the
  mb-places.json point. Reference = **assessment-parcel edges**
  (parcelref.py caches `Parcels/data/mb-assessment-parcels-*.parquet`, 437k
  parcels; OSM roads were much worse). FFT chamfer search over translation ×
  rot ±2° × scale 0.9–1.1, **masked so every corner label lands in its
  allowed section(s)** (this fixed a wrong Alonsa lock), then a
  similarity-only ICP.
- Verified by overlay: Anola, Arborg, Alonsa good (5–7 m).
- altona_01.pdf: "no scale bar read". Check the PDF pages' OCR (rendered at
  150 dpi; maybe a higher dpi is needed).
- Next: batch all ~520 sheets, review with overlay2.py contact sheets, and
  handle the failures.

### Still to build after the fits
- Host the pages on R2 (`pub-0910...r2.dev`, the bucket the app already
  uses), NOT in `web/public`: ~90 MB of images plus the RM SVGs would bloat
  every Vercel deployment (memory: vercel-deployment-storage). Load them via
  fetch → blob URL so the canvas is not tainted (`loadBaseMap` in the shared
  `locationMap.js` sets no `crossOrigin`).
- Raster base maps: `renderLocationMap` draws any image, but scans are in
  pixel units, so normalise to UNIT_WIDTH like `cityMaps.js` does.
- Addenda Pack wiring: RM map by subject municipality; community plan by
  page containment plus distance to the CGN point; multi-sheet = the sheet
  containing the subject.
- Tests, README update, PR, then ask Jason before merging.

Run the scripts with plain `python` (not `-I`: pyarrow lives in the user
site-packages) from a scratch work dir, e.g.
`python rmfit.py <workdir> Ritchot` or `python townfit.py <workdir> anola.gif`.
