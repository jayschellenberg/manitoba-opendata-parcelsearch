# build_landcover_tiles.R
#
# Builds a static XYZ raster-tile pyramid of the 2020 Manitoba land-cover
# raster (LCR_RCT_2020_MB.tif) for the webapp's Land Cover overlay's
# "Detailed" mode. The result is a directory of lossless WebP tiles served
# from web/public/data/landcover-tiles/{z}/{x}/{y}.webp — MapLibre reads
# them as a plain raster source, no tile server needed.
#
# Pipeline (3 GDAL steps via system()):
#   1. gdaldem color-relief     — recolour the 12 source classes into the
#                                 5 webapp buckets (cult/past/bush/wet/other)
#                                 with the LAND_COVER_BUCKETS palette,
#                                 emitting an RGBA byte raster.
#   2. gdalwarp                 — reproject 4-band RGBA → EPSG:3857 (Web
#                                 Mercator, what XYZ tiles use).
#   3. gdal2tiles.py            — slice the warped raster into {z}/{x}/{y}.webp
#                                 lossless XYZ tiles for the chosen zoom range.
#
# Why a separate "Detailed" pyramid in addition to the per-parcel JSON
# shards (build_landcover.R): the shards give the dominant bucket + per-
# bucket acres per parcel — fast headlines. This pyramid shows the actual
# pixel-level mosaic inside each parcel, the way satellite imagery does
# for the basemap. Same source raster, complementary views.
#
# Bucket mapping (12 raster classes -> 5 webapp buckets), per Jason and
# matching the LAND_COVER_BUCKETS palette in
# web/src/lib/landcover.js — KEEP THIS IN SYNC:
#   cult  Cultivated     #d8a93b = 2  Cropland
#   past  Pasture/Grass  #9ab95a = 7  Grassland & shrubland, 9 Sparsely vegetated
#   bush  Bush/Treed     #3f7d3f = 4  Treed (non-wetland), 5 Treed wetland,
#                                     6  Treed area disturbance
#   wet   Wetland/Water  #4a90c2 = 3  Inland water, 8 Wetland (non-treed)
#   other Other          #b0b0b0 = 0  Too small, 1 Built-up, 10 Barren,
#                                     11 Permanent snow & ice
# nodata transparent — pixels outside MB get alpha 0 so the basemap shows
# through.
#
# Zoom range: 6-12.
#   - z6  province-wide overview (all of MB in ~4 tiles)
#   - z12 ~38 m/pixel — appropriate for a 30 m source raster (slight
#         upscale already; z13+ doesn't add real detail and triples disk
#         usage). Appraisers browsing rural munis live in z10-z12.
#
# Output size (estimate): ~70-110 MB total for MB as lossless WebP
# (roughly half the PNG-8 pyramid; the 6-colour source compresses well).
# Output dir: web/public/data/landcover-tiles/{z}/{x}/{y}.webp
# Manifest:   web/public/data/landcover-tiles/manifest.json
#             { built: "<ISO date>", minzoom, maxzoom, palette }
#             — the webapp probes this on init to know whether the
#             Detailed tri-state branch is available; if missing the
#             button silently falls back to dominant↔off.
#
# Prerequisites: GDAL CLI tools must be on PATH:
#   - gdaldem, gdalwarp, gdal2tiles.py (or gdal2tiles on Windows)
#   - Confirmed by running `gdal_translate --version` before steps run.
# On Windows install via OSGeo4W or `conda install -c conda-forge gdal`.
#
# Runtime: 15-45 minutes depending on CPU. Re-run only when a new
# LCR_RCT_*.tif lands (the 2020 raster is the latest provincial release;
# years between updates).

suppressPackageStartupMessages({
  library(jsonlite)
})

source_dir   <- "D:/Dropbox/ClaudeCode/MBOpenData/WebSearch"
assembly_in  <- "D:/Dropbox/Appraisal/RProjects/appraisal-templates/mao-assembly/inputs"
tiles_dir    <- file.path(source_dir, "web/public/data/landcover-tiles")
manifest     <- file.path(tiles_dir, "manifest.json")

MIN_ZOOM <- 6L
MAX_ZOOM <- 12L

# Bucket palette — KEEP IN SYNC with web/src/lib/landcover.js
# (LAND_COVER_BUCKETS). The first three columns are R/G/B (0-255), fourth
# is alpha. Source-class IDs (col 1) come from the 12-class scheme in the
# LCR_RCT_2020_MB raster documentation; bucket assignment matches
# build_landcover.R.
COLOR_TABLE <- rbind(
  # Cultivated #d8a93b
  c(2,  216, 169,  59, 255),
  # Pasture/Grass #9ab95a
  c(7,  154, 185,  90, 255),
  c(9,  154, 185,  90, 255),
  # Bush/Treed #3f7d3f
  c(4,   63, 125,  63, 255),
  c(5,   63, 125,  63, 255),
  c(6,   63, 125,  63, 255),
  # Wetland/Water #4a90c2
  c(3,   74, 144, 194, 255),
  c(8,   74, 144, 194, 255),
  # Other #b0b0b0
  c(0,  176, 176, 176, 255),
  c(1,  176, 176, 176, 255),
  c(10, 176, 176, 176, 255),
  c(11, 176, 176, 176, 255)
)
colnames(COLOR_TABLE) <- c("value", "r", "g", "b", "a")

# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
# Probe for an executable on PATH. Uses Sys.which because system(... intern=TRUE)
# on Windows THROWS an R error on "not found" (caller can't fall through to
# the next candidate); Sys.which just returns "" when nothing matches.
# Returns the absolute path when found, "" when not.
which_tool <- function(name) {
  path <- unname(Sys.which(name))
  if (is.na(path)) "" else path
}
have_tool <- function(name) nzchar(which_tool(name))

# Auto-configure the OSGeo4W (Windows) environment if it's installed but
# its tools aren't on the inherited PATH — the typical case when Rscript is
# launched from a plain cmd / PowerShell / RStudio rather than the OSGeo4W
# Shell. Replicates what `C:\OSGeo4W\OSGeo4W.bat` does: prepends OSGeo4W's
# bin + python Scripts to PATH, points PYTHONHOME/PYTHONPATH at the bundled
# python (so `C:\OSGeo4W\bin\python.exe` doesn't bomb with "No module named
# 'encodings'"), and sets GDAL_DATA / PROJ_LIB so the warp step finds its
# CRS dictionaries. No-op on Linux / macOS / conda installs and when GDAL
# already resolves via PATH; safe to call unconditionally.
configure_osgeo4w_if_present <- function() {
  # No early-return on `have_tool("gdalinfo")`: a common partial setup is
  # only C:\OSGeo4W\bin on PATH (gdalinfo/gdaldem/gdalwarp work) WITHOUT
  # the bundled Python's Scripts dir (where gdal2tiles.bat lives). We
  # always want to add the Python Scripts dir + PYTHONHOME when OSGeo4W
  # is on disk; the Sys.setenv prepends are idempotent for dirs that
  # were already on PATH.
  root <- Sys.getenv("OSGEO4W_ROOT", unset = "")
  if (!nzchar(root) || !dir.exists(root)) {
    for (cand in c("C:/OSGeo4W", "C:/OSGeo4W64")) {
      if (dir.exists(cand)) { root <- cand; break }
    }
  }
  if (!nzchar(root) || !dir.exists(root)) return(invisible(NULL))

  # OSGeo4W ships its own Python under apps/PythonXYZ — pick whichever
  # version is installed (varies as GDAL upgrades).
  py_prefix <- ""
  for (d in list.dirs(file.path(root, "apps"), recursive = FALSE)) {
    if (grepl("/Python[0-9]+$", gsub("\\\\", "/", d))) { py_prefix <- d; break }
  }

  # PATH: OSGeo4W's bin first so gdaldem/gdalwarp/gdal_translate resolve;
  # the python Scripts dir holds gdal2tiles.bat / gdal2tiles.py.
  path_extras <- c(
    file.path(root, "bin"),
    if (nzchar(py_prefix)) file.path(py_prefix, "Scripts")
  )
  path_extras <- path_extras[dir.exists(path_extras)]
  if (length(path_extras) > 0) {
    Sys.setenv(PATH = paste(c(path_extras, Sys.getenv("PATH")), collapse = .Platform$path.sep))
  }

  # CRS / driver data — gdalwarp's reprojection needs these.
  for (gd in c(file.path(root, "apps/gdal/share/gdal"),
               file.path(root, "share/gdal"))) {
    if (dir.exists(gd)) { Sys.setenv(GDAL_DATA = gd); break }
  }
  # PROJ database lookup, in priority order:
  #   1. The R sf or terra package's bundled proj.db (sf vendors PROJ 9.x
  #      and ships a current proj.db; refreshed with each CRAN release).
  #      Preferred unconditionally because:
  #      - OSGeo4W users frequently have a stale PROJ-7-era database at
  #        C:/OSGeo4W/share/proj/ left over from an older install while
  #        the gdal package is current; GDAL 3.13 then errors with
  #        "proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 1 whereas
  #         a number >= 4 is expected".
  #      - When the user runs Rscript from the OSGeo4W Shell, that shell
  #        sets PROJ_LIB=%OSGEO4W_ROOT%\share\proj (the stale path) via
  #        OSGeo4W\etc\ini\proj.bat — so checking the existing env var
  #        first would lock in the broken setting.
  #      sf's bundled copy is always current and matches recent GDAL.
  #   2. Existing PROJ_DATA / PROJ_LIB the user has set (only when sf/
  #      terra aren't installed — explicit user setup deserves respect
  #      if they've gone out of their way to configure it).
  #   3. OSGeo4W's own share/proj as a last resort.
  proj_data <- ""
  for (pkg in c("sf", "terra")) {
    d <- tryCatch(system.file("proj", package = pkg), error = function(e) "")
    if (nzchar(d) && file.exists(file.path(d, "proj.db"))) {
      proj_data <- d; break
    }
  }
  if (!nzchar(proj_data)) {
    for (v in c("PROJ_DATA", "PROJ_LIB")) {
      candidate <- Sys.getenv(v, unset = "")
      if (nzchar(candidate) && file.exists(file.path(candidate, "proj.db"))) {
        proj_data <- candidate; break
      }
    }
  }
  if (!nzchar(proj_data)) {
    for (pl in c(file.path(root, "share/proj"),
                 file.path(root, "apps/proj/share"))) {
      if (dir.exists(pl) && file.exists(file.path(pl, "proj.db"))) {
        proj_data <- pl; break
      }
    }
  }
  if (nzchar(proj_data)) {
    Sys.setenv(PROJ_DATA = proj_data)  # PROJ 7.1+ preferred name
    Sys.setenv(PROJ_LIB  = proj_data)  # legacy name, still checked
    cat("Using PROJ data from", proj_data, "\n")
  }

  # Bootstrap OSGeo4W's bundled python so gdal2tiles.bat (which delegates
  # to `python -m osgeo_utils.gdal2tiles`) can import osgeo.
  if (nzchar(py_prefix)) {
    Sys.setenv(PYTHONHOME = py_prefix)
    Sys.setenv(PYTHONPATH = file.path(py_prefix, "Lib", "site-packages"))
  }

  cat("Configured OSGeo4W environment from", root, "\n")
}
configure_osgeo4w_if_present()

run <- function(cmd, args) {
  cat("$", cmd, paste(args, collapse = " "), "\n")
  status <- system2(cmd, args = args)
  if (status != 0L) {
    stop(sprintf("%s exited with status %d", cmd, status))
  }
}

# Locate a usable gdal2tiles invocation. Returns a list(cmd, prefix_args)
# the caller prepends to its own args, so a "python -m osgeo_utils.gdal2tiles"
# fallback composes the same way as a bare "gdal2tiles".
#
# Order of attempts (first hit wins):
#   1. `gdal2tiles`         — modern conda / Linux / macOS console-script
#   2. `gdal2tiles.bat`     — OSGeo4W on Windows ships this wrapper
#   3. `gdal2tiles.py`      — direct script invocation (needs .PY in PATHEXT)
#   4. `python  -m osgeo_utils.gdal2tiles`   — GDAL 3.3+ Python module
#   5. `python3 -m osgeo_utils.gdal2tiles`
#   6. `py      -m osgeo_utils.gdal2tiles`   — Windows py launcher
#
# Step 4-6 are validated by `python -m osgeo_utils.gdal2tiles --version` so a
# stray python without GDAL bindings doesn't false-positive.
find_gdal2tiles <- function() {
  for (cmd in c("gdal2tiles", "gdal2tiles.bat", "gdal2tiles.py")) {
    if (have_tool(cmd)) {
      return(list(cmd = cmd, prefix_args = character(0)))
    }
  }
  for (py in c("python", "python3", "py")) {
    if (!have_tool(py)) next
    res <- tryCatch(
      suppressWarnings(system2(py, c("-m", "osgeo_utils.gdal2tiles", "--version"),
                               stdout = TRUE, stderr = TRUE)),
      error = function(e) NULL
    )
    if (length(res) > 0 && !any(grepl("No module|ModuleNotFoundError|Error", res))) {
      return(list(cmd = py, prefix_args = c("-m", "osgeo_utils.gdal2tiles")))
    }
  }
  stop(
    "Couldn't find a usable gdal2tiles invocation. Tried: ",
    "gdal2tiles / gdal2tiles.bat / gdal2tiles.py on PATH, ",
    "and `python -m osgeo_utils.gdal2tiles` via python/python3/py.\n",
    "Install GDAL with its Python bindings:\n",
    "  - Windows: OSGeo4W (https://trac.osgeo.org/osgeo4w/) — choose 'gdal' + 'python3-gdal'\n",
    "  - conda:   `conda install -c conda-forge gdal`\n",
    "  - then either run this script from a shell where `gdal2tiles --version` works,\n",
    "    or ensure the python on PATH has the osgeo bindings."
  )
}

# ----------------------------------------------------------------------
# 1. Locate the source raster + validate tooling
# ----------------------------------------------------------------------
src_tif_candidates <- list.files(assembly_in,
                                 pattern = "^LCR_RCT_\\d{4}_MB\\.tif$",
                                 full.names = TRUE)
if (length(src_tif_candidates) == 0L) {
  stop("No LCR_RCT_YYYY_MB.tif found in ", assembly_in,
       ". Drop the latest provincial land-cover raster there first.")
}
src_tif <- tail(sort(src_tif_candidates), 1L)
cat("Source raster:", basename(src_tif), "\n")

missing <- character(0)
for (tool in c("gdaldem", "gdalwarp", "gdal_translate")) {
  if (!have_tool(tool)) missing <- c(missing, tool)
}
if (length(missing) > 0L) {
  stop(
    "GDAL CLI tool(s) not found on PATH: ", paste(missing, collapse = ", "), ".\n",
    "Install via OSGeo4W (Windows) or `conda install -c conda-forge gdal`, ",
    "then re-run this script from a shell where the gdal commands are on PATH."
  )
}
gdal2tiles_call <- find_gdal2tiles()
cat("Using gdal2tiles:", gdal2tiles_call$cmd,
    if (length(gdal2tiles_call$prefix_args)) paste(gdal2tiles_call$prefix_args, collapse = " ") else "",
    "\n")

dir.create(tiles_dir, showWarnings = FALSE, recursive = TRUE)

# Clear any existing tile pyramid first. gdal2tiles writes <z>/<x>/<y>.<ext>
# but never deletes tiles from a previous run, so a format switch
# (PNG -> WebP) or a narrower zoom range would otherwise leave orphaned
# old-format tiles behind that the frontend would still try (and fail) to
# fetch. Only the numeric {z} subdirs are removed; the manifest is
# rewritten at the end.
old_z <- list.dirs(tiles_dir, recursive = FALSE)
old_z <- old_z[grepl("/[0-9]+$", gsub("\\\\", "/", old_z))]
if (length(old_z) > 0) {
  unlink(old_z, recursive = TRUE)
  cat("Cleared", length(old_z), "existing zoom dir(s) before re-tiling\n")
}

tmp_dir <- tempfile("landcover_tiles_")
dir.create(tmp_dir, recursive = TRUE)
on.exit(unlink(tmp_dir, recursive = TRUE), add = TRUE)

# ----------------------------------------------------------------------
# 2. gdaldem color-relief — recolour 12 classes -> 5-bucket RGBA
# ----------------------------------------------------------------------
# Use the `-exact_color_entry` mode so values map literally (not
# interpolated); critical for categorical rasters. nv = nodata (out of MB)
# resolves to fully transparent.
color_file <- file.path(tmp_dir, "color_table.txt")
color_lines <- c(
  apply(COLOR_TABLE, 1L, function(row) {
    paste(row["value"], row["r"], row["g"], row["b"], row["a"])
  }),
  "nv 0 0 0 0"
)
writeLines(color_lines, color_file)

rgba_tif <- file.path(tmp_dir, "rgba.tif")
run("gdaldem", c(
  "color-relief",
  "-exact_color_entry",
  "-alpha",
  src_tif,
  color_file,
  rgba_tif,
  "-of", "GTiff",
  "-co", "COMPRESS=DEFLATE",
  "-co", "TILED=YES"
))

# ----------------------------------------------------------------------
# 3. gdalwarp — reproject to EPSG:3857 (Web Mercator) for XYZ tiling
# ----------------------------------------------------------------------
warped_tif <- file.path(tmp_dir, "rgba_3857.tif")
# No -srcnodata / -dstnodata: the step-2 output is a proper RGBA raster
# (4 bands, the 4th carrying alpha set to 0 for nodata via the
# `nv 0 0 0 0` color-table entry + gdaldem's `-alpha` flag). Modern
# gdalwarp auto-detects the alpha channel as the validity mask on read
# and preserves it on write, so the nodata flags are redundant — and
# their multi-value form (`-srcnodata "0 0 0 0"`) requires shell
# quoting that R's system2 doesn't add, leading to gdalwarp parsing
# each "0" as an extra positional source file.
run("gdalwarp", c(
  "-overwrite",
  "-t_srs", "EPSG:3857",
  # Nearest-neighbour keeps the 5 bucket colours discrete; any other
  # resampler would blend pixels and pollute the palette.
  "-r", "near",
  "-of", "GTiff",
  "-co", "COMPRESS=DEFLATE",
  "-co", "TILED=YES",
  rgba_tif,
  warped_tif
))

# ----------------------------------------------------------------------
# 4. gdal2tiles — slice into {z}/{x}/{y}.png XYZ tiles
# ----------------------------------------------------------------------
# --xyz emits Slippy-Map (Google/OSM) tile coordinates rather than TMS
# (Y-flipped). MapLibre defaults to XYZ, so this saves a `scheme: 'tms'`
# on the source declaration.
run(gdal2tiles_call$cmd, c(
  gdal2tiles_call$prefix_args,
  "--xyz",
  "--processes", "4",
  # WebP-LOSSLESS tiles instead of PNG. The source is only 6 colours (5
  # buckets + transparent), so lossless WebP crushes far smaller than
  # PNG while keeping the bucket colours pixel-exact. Lossy WebP is the
  # wrong call here — it would ring/bleed colours across the hard
  # categorical boundaries and mislabel edge pixels.
  "--tiledriver", "WEBP",
  "--webp-lossless",
  paste0("-z", MIN_ZOOM, "-", MAX_ZOOM),
  "-r", "near",            # match gdalwarp — preserve bucket colours
  "-w", "none",            # no leaflet/openlayers viewer HTML
  warped_tif,
  tiles_dir
))

# ----------------------------------------------------------------------
# 5. Manifest — webapp probes this on init to learn the pyramid exists
# ----------------------------------------------------------------------
# Webapp reads only `built`, `minzoom`, `maxzoom`; palette echoed so a
# downstream consumer can verify the colour mapping without re-reading
# this script.
palette <- list(
  cult  = "#d8a93b",
  past  = "#9ab95a",
  bush  = "#3f7d3f",
  wet   = "#4a90c2",
  other = "#b0b0b0"
)
jsonlite::write_json(list(
  built   = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
  source  = basename(src_tif),
  format  = "webp",                 # tile extension the frontend requests
  minzoom = MIN_ZOOM,
  maxzoom = MAX_ZOOM,
  palette = palette
), manifest, auto_unbox = TRUE, pretty = TRUE)

# ----------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------
total_bytes <- sum(file.info(list.files(tiles_dir, recursive = TRUE,
                                        full.names = TRUE))$size,
                   na.rm = TRUE)
n_tiles <- length(list.files(tiles_dir, pattern = "\\.webp$",
                             recursive = TRUE))
cat("Done.\n")
cat("  Tiles dir :", tiles_dir, "\n")
cat("  Manifest  :", manifest, "\n")
cat(sprintf("  %d WebP tiles, %.1f MB total (z%d-z%d)\n",
            n_tiles, total_bytes / 1024 / 1024, MIN_ZOOM, MAX_ZOOM))
