# Data architecture & annual-snapshot plan (DRAFT)

Status: draft for Jason's review. Nothing here is implemented yet except
Phase 0 (land-cover tiles → WebP, already shipped).

## Goals

1. **Live app stays current and fast** — the deploy carries only the
   newest version of each dataset.
2. **Retain annual historical snapshots** of parcel size/shape + roll
   info, so a parcel's pre-subdivision geometry can be recovered. Needed
   only **periodically** — cold pull is fine, no live in-app viewer
   required.
3. **Stop the git repo growing without bound** from monthly-regenerated
   large files.
4. **Use Dropbox** for the archive (the repo already lives under
   `D:\Dropbox\…`, so this is essentially free).

## Three data classes

| Class | Examples (current size) | Policy |
|---|---|---|
| **Latest-only HOT** (served to users) | `legal-index.json` 129 MB, current `rollentry-snapshot/` 284 MB, `section-grid.json` 40 MB, `assessment-index.json` 28 MB, land-cover tiles 84 MB + shards 13 MB | Must be in the Vercel deploy at its **newest** version. Should **not** pile up every regenerated version in git history. |
| **ANNUAL ARCHIVE** (new) | dated full parcel snapshot (`RollEntry_<year>.gpkg`) | Retained forever, **out of git and out of the deploy**, in a dated Dropbox folder. Consulted on demand. |
| **Code / config** | scripts, web/src, small JSON | Normal git. |

## The annual archive — the part you asked for

The snapshot you need is **already produced** as a provincial source
download. `mao-assembly/inputs/MBRollGeoPackage.gpkg` (~225 MB) contains
parcel **geometry (size + shape)** plus the roll attributes. It's
git-ignored and never deploys. The only thing missing was **deliberate
dated retention** — the working copy gets overwritten on each download,
so prior versions are lost.

**Implemented (`r/archive_snapshot.R`):**

- **Source:** the provincial downloads in
  `…/mao-assembly/inputs/` — `MBRollGeoPackage.gpkg` (geometry, active
  now); `Manitoba_Zoning_By_Laws.geojson` and
  `Manitoba_Development_Plan_Designations.geojson` (zoning + dev-plan,
  wired but **off** — enable with `--all` or by flipping `active`).
- **Archive root:** `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\`,
  *outside* the git repo and *outside* `web/public` (never bloats
  history or the Vercel deploy).
- **Naming:** `<sourcename><YYYYMMDD>.<ext>`, dated by the source file's
  download (mtime) — e.g. `MBRollGeoPackage20260605.gpkg`.
- **Append-only + idempotent:** never overwrites a prior capture; safe to
  re-run.
- **Trigger:** run `Rscript r/archive_snapshot.R` by hand after pulling a
  fresh provincial download (they're manual + infrequent).
- **Access (cold):** open the year's `.gpkg`/`.geojson` in QGIS or R to
  read a parcel's pre-subdivision size/shape. No app changes.

Status: **2026 geometry captured** (`MAOSnapshots\2026\MBRollGeoPackage20260605.gpkg`).
That's the whole feature for the stated need; everything below is
optional polish.

## Repo-size cleanup — separate, optional follow-up

The repo grows because **regenerated HOT data is committed** (the
129 MB `legal-index.json` and the 284 MB current snapshot dominate, not
the tiles). The annual archive above does **not** add to this — it lives
in Dropbox, not git.

To actually cap repo growth (your "no more, ideally"):

- **Option A — Git LFS** for the big `web/public/data/**` files. Keeps
  your current workflow (files committed in place), but history stops
  storing a full inline copy of every regenerated version. Vercel
  supports LFS on deploy. Lowest friction. **Recommended.**
- **Option B — externalize**: serve the big assets from Vercel Blob / a
  CDN / object storage; the app fetches them from there; they leave the
  repo entirely. Cleanest, more setup.
- **Option C — periodic `git filter-repo` purge** of old blobs. Band-aid.

**Sequencing safeguard:** before any history purge, first extract any
past snapshots already sitting in git history that are worth keeping into
the Dropbox archive — so the cleanup never costs you historical data.

## Phased plan

- **Phase 0 — DONE:** land-cover tiles → lossless WebP (220 → 84 MB).
- **Phase 1 — DONE (geometry):** `r/archive_snapshot.R` archives the
  provincial source(s) to `MAOSnapshots\<year>\`, append-only; 2026
  geometry captured. Zoning + dev-plan capture is wired and one flag
  away (`--all`).
- **Phase 1b — when you're ready:** start retaining zoning + dev-plan
  too (just `--all`, or set their `active` flags). No further planning
  needed to *capture* them — same mechanism. (The 2026 zoning/dev-plan
  already sit in the archive folder.)
- **Phase 2 — optional:** repo slim — Git LFS for the big
  `web/public/data` files + a one-time history purge (after extracting
  any wanted history first).
- **Phase 3 — optional, later, NEEDS planning:** *using* historical
  zoning/dev-plan (and geometry) inside the app — a "view parcels /
  zoning as of `<year>`" overlay that loads a chosen year on demand.
  This is the part that needs design (the live zoning/dev-plan is a
  current ArcGIS overlay; a historical path is a parallel data flow).
  Not needed for cold pull.

## Decisions (resolved)

1. **Archive path** — `D:\Dropbox\Appraisal\Web\MAOSnapshots\<year>\`. ✓
2. **Contents** — geometry now; zoning + dev-plan to follow (wired). ✓
3. **Cadence** — manual annual run of `archive_snapshot.R` after a fresh
   provincial download. ✓
4. **Phase 2 (repo slim)** — deferred; revisit when repo size bites.
5. **Phase 3 (in-app historical view)** — later; cold pull for now.
