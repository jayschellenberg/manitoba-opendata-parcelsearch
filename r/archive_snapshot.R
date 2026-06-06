# archive_snapshot.R
#
# Append-only archive of the provincial MAO source layers, so a parcel's
# size/shape (and its zoning / dev-plan designation) at a point in time can
# be recovered after subdivisions and rezonings — with a PROVENANCE sidecar
# beside each archived file for appraisal defensibility.
#
# What it does: copies the CURRENT provincial source file(s) out of
# mao-assembly/inputs into a dated Dropbox archive, NEVER overwriting a
# prior capture, and writes <archived-file>.meta.json next to each one.
# Idempotent — re-running adds only new files and backfills any missing
# sidecars.
#
#   source : D:/Dropbox/Appraisal/RProjects/appraisal-templates/mao-assembly/inputs
#   archive: D:/Dropbox/Appraisal/Web/MAOSnapshots/<year>/
#
# Naming: <sourcebasename><YYYYMMDD>.<ext>. The YYYYMMDD is the source
# file's modification date as a convenience for the FILE NAME only.
#
# Provenance sidecar (<file>.meta.json) — the defensible record. Critically,
# `source_date` is read from the explicit filename date (operator-set, not
# mtime), and `retrieved_at` is RECORDED at archive time (authoritative for
# files copied now; for pre-existing/back-filled files it falls back to the
# file mtime and is flagged `retrieved_at_inferred:true`, since mtime can be
# altered by copies/Dropbox sync and isn't trustworthy on its own).
#
#   Rscript r/archive_snapshot.R          # geometry only (the `active` set)
#   Rscript r/archive_snapshot.R --all    # also capture zoning + dev-plan
#
# Storage: archives live in Dropbox, OUTSIDE git and web/public. The
# unsimplified originals here are the source-of-record; the CDN display
# shards (build_historical_shards.R) are simplified for visualization only.

suppressPackageStartupMessages({
  library(sf)
  library(jsonlite)
})

ARCHIVE_ROOT <- "D:/Dropbox/Appraisal/Web/MAOSnapshots"
SRC_DIR <- "D:/Dropbox/Appraisal/RProjects/appraisal-templates/mao-assembly/inputs"

# Provenance constants — VERIFY/record the exact dataset URLs + license
# terms for your downloads; these are sensible defaults.
SOURCE_AGENCY  <- "Province of Manitoba (Manitoba geoPortal — public open data)"
SOURCE_LICENSE <- "Open Government Licence – Manitoba (verify current terms)"

# Source layers. `active` gates a plain run; layer/dataset/source_url feed
# the provenance sidecar. Fill the zoning/dev-plan source_url with their
# exact geoPortal dataset pages when known.
sources <- list(
  list(active = TRUE,  file = "MBRollGeoPackage.gpkg", layer = "parcels",
       dataset    = "Manitoba Roll Entry (parcels + assessment roll)",
       source_url = "https://geoportal.gov.mb.ca/datasets/manitoba::roll-entry/explore"),
  list(active = FALSE, file = "Manitoba_Zoning_By_Laws.geojson", layer = "zoning",
       dataset    = "Manitoba Zoning By-Laws",
       source_url = "https://geoportal.gov.mb.ca/datasets/manitoba-zoning-by-laws/"),
  list(active = FALSE, file = "Manitoba_Development_Plan_Designations.geojson", layer = "devplan",
       dataset    = "Manitoba Development Plan Designations",
       source_url = "https://geoportal.gov.mb.ca/datasets/manitoba::manitoba-development-plan-designations/about")
)

args        <- commandArgs(trailingOnly = TRUE)
capture_all <- "--all" %in% args

# ---- provenance helpers ----------------------------------------------
file_sha256 <- function(path) {
  if (requireNamespace("digest", quietly = TRUE)) {
    return(tryCatch(digest::digest(file = path, algo = "sha256"), error = function(e) NA_character_))
  }
  # Windows fallback — certutil ships with the OS.
  out <- tryCatch(suppressWarnings(system2("certutil", c("-hashfile", path, "SHA256"),
                                           stdout = TRUE, stderr = TRUE)),
                  error = function(e) NULL)
  if (length(out) >= 2) {
    h <- gsub("[^0-9a-fA-F]", "", paste(out[-c(1, length(out))], collapse = ""))
    if (nchar(h) == 64) return(tolower(h))
  }
  NA_character_
}

read_schema_fields <- function(path) {
  tryCatch({
    lyr <- sf::st_layers(path)$name[1]
    d <- sf::st_read(path, layer = lyr, quiet = TRUE,
                     query = sprintf('SELECT * FROM "%s" LIMIT 0', lyr))
    setdiff(names(d), attr(d, "sf_column"))
  }, error = function(e) character(0))
}

`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

# Source CRS as shipped — matters for defensibility: e.g. the 2025 Roll Entry
# GeoPackage ships in EPSG:3857 (Web Mercator), whose NATIVE areas are ~2.4x
# inflated at MB latitudes, while 2026 ships in EPSG:26914 (UTM-14N). Always
# treat a reprojected metric CRS as the area-of-record, not the native one.
file_crs <- function(path) {
  tryCatch({
    s <- sf::st_crs(sf::st_layers(path)$crs[[1]])
    if (!is.null(s$epsg) && !is.na(s$epsg))
      sprintf("EPSG:%d (%s)", s$epsg, s$Name %||% s$input %||% "")
    else (s$input %||% NA_character_)
  }, error = function(e) NA_character_)
}

# Match an archived filename to its source config (for the backfill path).
layer_for <- function(fname) {
  lyr <- if (grepl("^MBRollGeoPackage", fname)) "parcels"
    else if (grepl("^Manitoba_Zoning_By", fname)) "zoning"
    else if (grepl("^Manitoba_Development_Plan_Designations", fname)) "devplan"
    else return(list(layer = "unknown", dataset = NA_character_, source_url = NA_character_))
  for (s in sources) if (s$layer == lyr) return(s)
  list(layer = lyr, dataset = NA_character_, source_url = NA_character_)
}

write_meta <- function(dest, layer, dataset, source_url, retrieved_at, inferred) {
  meta_path <- paste0(dest, ".meta.json")
  prior <- if (file.exists(meta_path)) tryCatch(jsonlite::read_json(meta_path), error = function(e) NULL) else NULL
  ymd <- regmatches(basename(dest), regexpr("\\d{8}", basename(dest)))
  source_date <- if (length(ymd)) paste0(substr(ymd, 1, 4), "-", substr(ymd, 5, 6), "-", substr(ymd, 7, 8)) else NA_character_
  info  <- file.info(dest)
  bytes <- as.numeric(info$size)
  # When the file is unchanged (same byte size), reuse the prior hash +
  # schema (skip re-reading/re-hashing) and KEEP the prior retrieved_at so a
  # config-only refresh never downgrades an authoritative timestamp to an
  # mtime-inferred one.
  unchanged <- !is.null(prior) && isTRUE(prior$bytes == bytes) && !is.null(prior$sha256)
  sha    <- if (unchanged) prior$sha256 else file_sha256(dest)
  fields <- if (unchanged && length(prior$schema_fields)) unlist(prior$schema_fields) else read_schema_fields(dest)
  # Source CRS as shipped (e.g. EPSG:3857 vs 26914) — reuse prior when the
  # file is byte-identical so a config-only refresh skips re-opening the layer.
  src_crs <- if (unchanged && !is.null(prior$source_crs)) prior$source_crs else file_crs(dest)
  if (unchanged && !is.null(prior$retrieved_at)) {
    ra_str   <- prior$retrieved_at
    inferred <- if (is.null(prior$retrieved_at_inferred)) inferred else prior$retrieved_at_inferred
  } else {
    ra_str <- format(retrieved_at, "%Y-%m-%dT%H:%M:%S%z")
  }
  meta <- list(
    schema                = 1,
    archived_file         = basename(dest),
    layer                 = layer,
    source                = SOURCE_AGENCY,
    source_dataset        = dataset,
    source_url            = source_url,
    license               = SOURCE_LICENSE,
    source_date           = source_date,                 # explicit (filename), not mtime
    retrieved_at          = ra_str,
    retrieved_at_inferred = inferred,
    source_crs            = src_crs,                      # CRS as shipped (area-of-record note below)
    bytes                 = bytes,
    sha256                = sha,
    schema_fields         = fields,
    note                  = paste("Authoritative source-of-record for as-of-date measurements.",
                                  "Display shards derived from this are simplified (~10 m) for visualization",
                                  "only — resolve acreage/boundary evidence back to this file.")
  )
  jsonlite::write_json(meta, meta_path, auto_unbox = TRUE, pretty = TRUE, null = "null")
  invisible(meta)
}

# ---- archive ---------------------------------------------------------
archive_one <- function(s) {
  src <- file.path(SRC_DIR, s$file)
  if (!file.exists(src)) {
    cat(sprintf("  SKIP  %-45s (not found in inputs)\n", s$file))
    return(invisible(FALSE))
  }
  info <- file.info(src)
  d    <- as.Date(info$mtime)
  age_days <- as.integer(Sys.Date() - d)
  if (!is.na(age_days) && age_days > 365) {
    cat(sprintf("  !! STALE: %s is %d days old (> 12 months) — pull a fresh MB Open Data download.\n",
                s$file, age_days))
  }
  ymd  <- format(d, "%Y%m%d")
  year <- format(d, "%Y")
  ext  <- tools::file_ext(s$file)
  base <- tools::file_path_sans_ext(s$file)
  ddir <- file.path(ARCHIVE_ROOT, year)
  dest <- file.path(ddir, paste0(base, ymd, ".", ext))

  if (file.exists(dest)) {
    cat(sprintf("  HAVE  %-45s -> %s/%s\n", s$file, year, basename(dest)))
    write_meta(dest, s$layer, s$dataset, s$source_url, retrieved_at = file.info(dest)$mtime, inferred = TRUE)
    return(invisible(FALSE))
  }
  dir.create(ddir, showWarnings = FALSE, recursive = TRUE)
  cat(sprintf("  COPY  %-45s -> %s/%s  (%.1f MB) ...\n",
              s$file, year, basename(dest), info$size / 1024^2))
  ok <- file.copy(src, dest, overwrite = FALSE, copy.date = TRUE)
  if (!ok || !file.exists(dest)) stop("copy failed: ", src, " -> ", dest)
  if (file.info(dest)$size != info$size) {
    file.remove(dest)
    stop("size mismatch after copy (removed partial): ", dest)
  }
  # Retrieved-at is authoritative here: archiving runs right after the
  # operator downloads, so "now" is the genuine retrieval time.
  write_meta(dest, s$layer, s$dataset, s$source_url, retrieved_at = Sys.time(), inferred = FALSE)
  cat("        done (+ provenance sidecar).\n")
  invisible(TRUE)
}

# Ensure every already-archived source file has a sidecar (e.g. prior-year
# captures made before provenance existed). retrieved_at falls back to mtime
# and is flagged inferred.
# Ensure/refresh a provenance sidecar for every archived source file
# (back-fills missing ones, refreshes config like source_url on existing
# ones). write_meta reuses the prior hash + keeps an authoritative
# retrieved_at when the file is unchanged, so this is cheap and never
# downgrades provenance.
backfill_meta <- function() {
  files <- list.files(ARCHIVE_ROOT, pattern = "\\.(gpkg|geojson)$",
                      recursive = TRUE, full.names = TRUE)
  for (f in files) {
    lf <- layer_for(basename(f))
    write_meta(f, lf$layer, lf$dataset, lf$source_url, retrieved_at = file.info(f)$mtime, inferred = TRUE)
  }
  if (length(files)) cat(sprintf("  ensured %d provenance sidecar(s)\n", length(files)))
}

cat("MAO snapshot archive\n")
cat("  source :", SRC_DIR, "\n")
cat("  archive:", ARCHIVE_ROOT, "\n\n")
for (s in sources) {
  if (s$active || capture_all) archive_one(s)
  else cat(sprintf("  OFF   %-45s (inactive — run with --all to capture)\n", s$file))
}
cat("\nBackfilling provenance for any unarchived-meta files ...\n")
backfill_meta()
cat("\nArchive run complete.\n")
