# pack_landcover_pmtiles.R
#
# Packs the Land Cover "Detailed" XYZ pyramid (lossless WebP tiles written by
# r/build_landcover_tiles.R) into ONE PMTiles archive for R2, and writes the
# committed sidecar web/public/landcover-pmtiles-meta.json the app reads.
#
# WHY: the pyramid used to be ~27k WebP files in the mb-parcel-data repo,
# served one request per tile through the /gh-data edge proxy. The tile URLs
# carry that repo's pinned commit, so every monthly repin made every tile a
# cold cache miss and re-fetched it from GitHub although the raster had not
# changed; and the files were about half of that repo. One archive on R2 has
# a stable URL, needs no proxy, and leaves the data repo alone.
#
# The tiles are copied byte-for-byte (no re-encode), so the archive is
# pixel-identical to the pyramid it replaces.
#
# Pipeline:
#   1. Read <tiles>/{z}/{x}/{y}.webp into an MBTiles SQLite file (MBTiles
#      rows are TMS: y is flipped, 2^z - 1 - y).
#   2. `pmtiles convert` MBTiles -> PMTiles, then `pmtiles verify`.
#   3. Reconcile the archive's tile count with the file count.
#   4. Sidecar: built/source/palette from the pyramid's manifest.json plus
#      file/bytes/sha256/tiles.
#   5. --publish: staged rclone upload to r2-mb:mb-ortho, size-verified
#      before the rename over the live object (same shape as
#      rebuild-soil-tiles.ps1).
#
# Usage:
#   Rscript r/pack_landcover_pmtiles.R --tiles <dir>             # pack only
#   Rscript r/pack_landcover_pmtiles.R --tiles <dir> --publish   # pack + upload
#   Rscript r/pack_landcover_pmtiles.R --publish-only            # upload the packed archive
#
# Needs: RSQLite, jsonlite, digest; the pmtiles CLI (pinned install from
# rebuild-basemap.ps1, %LOCALAPPDATA%\Programs\pmtiles); rclone remote r2-mb.

suppressPackageStartupMessages({
  library(DBI)
  library(RSQLite)
  library(jsonlite)
})

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

args         <- commandArgs(trailingOnly = TRUE)
arg_val      <- function(flag) { i <- match(flag, args); if (is.na(i) || i == length(args)) NA_character_ else args[i + 1] }
tiles_dir    <- arg_val("--tiles")
publish      <- "--publish" %in% args || "--publish-only" %in% args
publish_only <- "--publish-only" %in% args

OUT_DIR   <- file.path(mb_parcelsearch_root, "build-cache", "landcover-tiles")
MBTILES   <- file.path(OUT_DIR, "mb-landcover.mbtiles")
OUT_FILE  <- file.path(OUT_DIR, "mb-landcover.pmtiles")
META_PATH <- file.path(mb_parcelsearch_root, "web", "public", "landcover-pmtiles-meta.json")
R2_LIVE    <- "r2-mb:mb-ortho/mb-landcover.pmtiles"
R2_STAGING <- "r2-mb:mb-ortho/mb-landcover.pmtiles.staging"
PUBLIC_URL <- "https://pub-091058079bf6458da1681945177e1682.r2.dev/mb-landcover.pmtiles"

# 138 MB of tiles on 2026-09-29; PMTiles adds a small directory and dedupes
# identical tiles, so it lands a little under. The band catches a truncated
# pack, not growth.
PMTILES_MIN_MB <- 60
PMTILES_MAX_MB <- 300

log <- function(...) cat(format(Sys.time(), "%H:%M:%S"), " ", ..., "\n", sep = "")

pmtiles_exe <- function() {
  exe <- unname(Sys.which("pmtiles"))
  if (nzchar(exe)) return(exe)
  exe <- file.path(Sys.getenv("LOCALAPPDATA"), "Programs", "pmtiles", "pmtiles.exe")
  if (file.exists(exe)) return(exe)
  stop("pmtiles CLI not found; run rebuild-basemap.ps1 once (it installs the pinned build) or put pmtiles on PATH")
}

pack <- function() {
  if (is.na(tiles_dir) || !dir.exists(tiles_dir)) stop("--tiles <dir> is required and must exist")
  manifest_path <- file.path(tiles_dir, "manifest.json")
  if (!file.exists(manifest_path)) stop("no manifest.json in ", tiles_dir)
  man <- fromJSON(manifest_path)

  files <- list.files(tiles_dir, pattern = "\\.webp$", recursive = TRUE)
  parts <- do.call(rbind, strsplit(sub("\\.webp$", "", files), "/", fixed = TRUE))
  if (ncol(parts) != 3) stop("unexpected tile layout under ", tiles_dir)
  z <- as.integer(parts[, 1]); x <- as.integer(parts[, 2]); y <- as.integer(parts[, 3])
  if (anyNA(c(z, x, y))) stop("non-numeric tile path under ", tiles_dir)
  log(sprintf("%d tiles, z%d-z%d", length(files), min(z), max(z)))

  dir.create(OUT_DIR, showWarnings = FALSE, recursive = TRUE)
  if (file.exists(MBTILES)) file.remove(MBTILES)
  con <- dbConnect(SQLite(), MBTILES)
  on.exit(if (dbIsValid(con)) dbDisconnect(con), add = TRUE)
  dbExecute(con, "CREATE TABLE metadata (name TEXT, value TEXT)")
  dbExecute(con, "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
  # Bounds of the lowest zoom's tiles, in lon/lat.
  zmin <- min(z); sel <- z == zmin
  tile_lon <- function(tx, zz) tx / 2^zz * 360 - 180
  tile_lat <- function(ty, zz) { n <- pi - 2 * pi * ty / 2^zz; 180 / pi * atan(0.5 * (exp(n) - exp(-n))) }
  bounds <- c(tile_lon(min(x[sel]), zmin), tile_lat(max(y[sel]) + 1, zmin),
              tile_lon(max(x[sel]) + 1, zmin), tile_lat(min(y[sel]), zmin))
  meta_rows <- data.frame(
    name = c("name", "format", "type", "minzoom", "maxzoom", "bounds", "attribution", "description"),
    value = c("mb-landcover", "webp", "overlay", min(z), max(z),
              paste(round(bounds, 6), collapse = ","),
              "Land cover (c) Province of Manitoba (LCR_RCT_2020)",
              paste0("Land Cover Detailed pyramid from ", man$source, ", built ", man$built)),
    stringsAsFactors = FALSE)
  dbWriteTable(con, "metadata", meta_rows, append = TRUE)

  dbBegin(con)
  batch <- 2000L
  for (start in seq(1L, length(files), by = batch)) {
    idx <- start:min(start + batch - 1L, length(files))
    blobs <- lapply(file.path(tiles_dir, files[idx]), function(p) readBin(p, "raw", file.size(p)))
    dbExecute(con, "INSERT INTO tiles VALUES (?, ?, ?, ?)", params = list(
      z[idx], x[idx], (2L^z[idx]) - 1L - y[idx], blob::as_blob(blobs)))
  }
  dbCommit(con)
  dbExecute(con, "CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)")
  n_db <- dbGetQuery(con, "SELECT COUNT(*) AS n FROM tiles")$n
  dbDisconnect(con)
  if (n_db != length(files)) stop("MBTiles holds ", n_db, " tiles, expected ", length(files))

  exe <- pmtiles_exe()
  if (file.exists(OUT_FILE)) file.remove(OUT_FILE)
  status <- system2(exe, c("convert", MBTILES, OUT_FILE))
  if (status != 0 || !file.exists(OUT_FILE)) stop("pmtiles convert failed (exit ", status, ")")
  status <- system2(exe, c("verify", OUT_FILE))
  if (status != 0) stop("pmtiles verify failed (exit ", status, ")")
  show <- system2(exe, c("show", OUT_FILE), stdout = TRUE)
  addressed <- suppressWarnings(as.integer(sub(".*: *", "", grep("^addressed tiles count", show, value = TRUE))))
  if (!identical(addressed, length(files))) stop("archive addresses ", addressed, " tiles, expected ", length(files))
  file.remove(MBTILES)

  size_mb <- file.size(OUT_FILE) / 1e6
  if (size_mb < PMTILES_MIN_MB || size_mb > PMTILES_MAX_MB) {
    stop(sprintf("archive is %.1f MB, outside the %d-%d MB sanity band", size_mb, PMTILES_MIN_MB, PMTILES_MAX_MB))
  }
  log(sprintf("Packed %s: %.1f MB, %d tiles", basename(OUT_FILE), size_mb, addressed))

  meta <- list(
    built = man$built, source = man$source, format = "webp",
    minzoom = min(z), maxzoom = max(z), palette = man$palette,
    file = basename(OUT_FILE), url = PUBLIC_URL,
    bytes = file.size(OUT_FILE),
    sha256 = digest::digest(OUT_FILE, algo = "sha256", file = TRUE),
    tiles = addressed,
    packed = format(Sys.Date(), "%Y-%m-%d")
  )
  writeLines(toJSON(meta, auto_unbox = TRUE, pretty = TRUE, digits = NA), META_PATH)
  log("Wrote ", META_PATH)
}

remote_size <- function(obj) {
  out <- suppressWarnings(tryCatch(system2("rclone", c("lsjson", obj), stdout = TRUE, stderr = FALSE),
                                   error = function(e) NULL))
  ls <- tryCatch(fromJSON(paste(out, collapse = "")), error = function(e) NULL)
  if (is.data.frame(ls) && nrow(ls)) as.numeric(ls$Size[1]) else NA_real_
}

publish_archive <- function() {
  if (!file.exists(OUT_FILE)) stop("nothing to publish: ", OUT_FILE, " not packed")
  bytes <- as.numeric(file.size(OUT_FILE))
  # --s3-no-check-bucket: the token is bucket-scoped, so rclone's bucket
  # probe would 403 before the upload starts.
  log("rclone copyto ", R2_STAGING)
  status <- system2("rclone", c("copyto", OUT_FILE, R2_STAGING, "--s3-no-check-bucket",
                                "--stats-one-line", "--stats", "60s"))
  if (status != 0) stop("rclone upload failed (exit ", status, "); live object untouched")
  if (!identical(remote_size(R2_STAGING), bytes)) stop("staging size mismatch; live object untouched")
  status <- system2("rclone", c("moveto", R2_STAGING, R2_LIVE, "--s3-no-check-bucket"))
  if (status != 0) stop("server-side rename failed (exit ", status, ")")
  if (!identical(remote_size(R2_LIVE), bytes)) stop("live size does not match the build; re-run --publish-only")
  log("Published ", bytes, " bytes: ", PUBLIC_URL)
}

if (!publish_only) pack()
if (publish) publish_archive()
log("Done.")
