# Resume point — 2026-10-21 (second pause)

## Live already
PRs #218 (Brandon/Steinbach/Thompson), #219 (wide aerial), #220 (83 RM
maps + 270 old-scan town plans on R2 `r2-mb:mb-ortho/location-maps/`) are
merged and deployed. Today's index refresh is on main.

## In progress: branch `feat/more-location-maps` (pushed)
Checkout: `D:\Dropbox\ClaudeCode\MBOpenData\mbps-loc` (a git worktree).
The main `mb-parcelsearch` folder stays on **main**; never commit
feature work there (the auto-publish-indexes job commits to whatever
branch it has checked out).

Committed (f59f1f9):
- All 13 highway-map cities (10 new: Dauphin, Flin Flon, Morden, Neepawa,
  Niverville, Portage, Selkirk, Stonewall, The Pas, Winkler), fits 1.2–4.1 m,
  crossings checked, `cityMaps.test.js` passes. Ready to ship.
- `rmdxf.py`: every RM map refit to MLI's DXF of the same drawing —
  100/100 RMs at ~2 m (fits in `fits/rm-dxf/`). Not yet built/uploaded.
- `townfit.py` reads MLI plans via `TOWNFIT_SRC`.

Work files (gitignored, in the MAIN tree):
`D:\Dropbox\ClaudeCode\MBOpenData\mb-parcelsearch\tools\city-location-maps\work\`
- `mli/dxf/` 100 RM DXFs, `mli/towns/` 546 MLI town plan PDFs
  (https://mli.gov.mb.ca/towns/, 2009–2020 vector redraws).
- `mlitown/`: 546 fits (482 ok). `triage.json`: 209 auto-accepted (every
  printed section label lands in its section; 8 spot-checked by eye, all
  good) + 273 to check by eye (`check.txt`, sheets in `work/rvc/`).
- `mlitown/verdicts.json`: auto + eye verdicts so far — **160 of 273
  checked** (next: index 160 = `work/rvc/sheet_040.png`), 340 ok / 29
  reject. Record more with `python -I ../rec.py <from> <to> <rejected
  stems...>` run in `work/mlitown`.

## Remaining steps
1. Finish eye review: `work/rvc/sheet_040.png` … `sheet_068.png`.
2. Build: RM maps from `fits/rm-dxf` (all 100) + town plans = MLI
   accepted sheets, falling back to the old accepted scan
   (`fits/review.json`) only for communities with no accepted MLI sheet.
   `build_area.py` needs a small change to take two town sources (each fit
   carries its `src`). The old scan RM/plan entries are replaced.
3. Ask Jason before re-uploading to R2 (replaces location-maps/), then
   `rclone sync` the new output, run a real Addenda Pack (Anola, a
   Ritchot river-lot parcel), copy `work/mlitown/town_*.json` +
   verdicts into `fits/`, README update, open PR from
   feat/more-location-maps, ask before merging.
