# download_provincial_snapshot.R
#
# Pull the three provincial MAO layers fresh from the authoritative ArcGIS
# FeatureServer into a STAGING inputs/ folder, named + projected to match what
# archive_snapshot.R expects — so the semiannual publish pipeline can produce a
# new dated MAOSnapshots capture WITHOUT the manual MB geoPortal download and
# WITHOUT touching mao-assembly's working inputs.
#
#   Roll -> MBRollGeoPackage.gpkg                            (reprojected to EPSG:26914, the archive CRS-of-record)
#   Zone -> Manitoba_Zoning_By_Laws.geojson                 (EPSG:4326, as archived)
#   Dev  -> Manitoba_Development_Plan_Designations.geojson  (EPSG:4326, as archived)
#
# Output dir: $PROVINCIAL_STAGING_DIR (default: <websearch_root>/.staging/inputs).
# A layer that fails mid-stream writes NOTHING, so a partial file never looks
# complete to the archiver.
#
# COMPLETENESS GUARDS (these files become the permanent source-of-record, so a
# silent truncation here would be archived forever with a sha256 attesting to it):
#   1. Count-verified pagination — ask the server for the exact row count first
#      (returnCountOnly), advance the offset by rows RECEIVED (a server may trim
#      a page below the requested size for transfer limits), and HARD-ERROR if
#      the pages stop before — or run past — that count. Same pattern as
#      mao-scrape's fetch_roll_entry.R (its audit finding F4): a "short page"
#      is never trusted as end-of-data.
#   2. Cross-snapshot shrink guard — compare each layer's downloaded feature
#      count to the newest published snapshot's manifest (mb-parcel-history).
#      A shrink > SHRINK_TOLERANCE aborts (nothing written / nothing archived)
#      unless PROVINCIAL_ACCEPT_SHRINK=1, so a catastrophically truncated or
#      half-published provincial layer can't quietly replace real history.
#      Growth is never blocked. Prior counts are the manifest's post-filter
#      shard totals (slightly <= raw), so the comparison is conservative in
#      the safe direction and exists to catch gross loss, not row-level drift.
#
# Reprojection to 26914 for the roll layer keeps as-of-date area measurements
# defensible (GeoJSON output from ArcGIS is 4326).
#
#   Rscript r/download_provincial_snapshot.R
#
# Testing: set PROVINCIAL_SNAPSHOT_SOURCE_ONLY=1 and source() this file to get
# the functions without triggering downloads; download_layer() takes injectable
# count_fn / page_fn so the pagination + guard logic runs offline against stubs
# (see tests in the session scratch — mirrors mao-scrape's injectable page_fn).
#
# Requires: sf, httr2, jsonlite.

suppressPackageStartupMessages({ library(sf); library(httr2); library(jsonlite) })

# Shared roots (env-overridable) — see r/config.R.
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

OUT <- Sys.getenv("PROVINCIAL_STAGING_DIR")
if (!nzchar(OUT)) OUT <- file.path(websearch_root, ".staging", "inputs")
dir.create(OUT, showWarnings = FALSE, recursive = TRUE)
options(timeout = 3600)

PAGE_SIZE        <- 2000
SHRINK_TOLERANCE <- 0.02   # abort if a layer shrinks >2% vs the newest published snapshot
BASE <- "https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services"

datasets <- list(
  list(name = "RollEntry",       url = paste0(BASE, "/ROLL_ENTRY/FeatureServer/0"),
       out = file.path(OUT, "MBRollGeoPackage.gpkg"), layer = "parcels", target_crs = 26914),
  list(name = "ManitobaZoning",  url = paste0(BASE, "/Manitoba_Zoning_By_Laws/FeatureServer/0"),
       out = file.path(OUT, "Manitoba_Zoning_By_Laws.geojson"), layer = "zoning", target_crs = NA),
  list(name = "ManitobaDevPlan", url = paste0(BASE, "/Manitoba_Development_Plan_Designations/FeatureServer/0"),
       out = file.path(OUT, "Manitoba_Development_Plan_Designations.geojson"), layer = "devplan", target_crs = NA)
)

# Exact server-side row count (returnCountOnly). Hard-errors when the server
# won't say — without it a truncated download is indistinguishable from a
# complete one.
fetch_count <- function(url) {
  req <- request(paste0(url, "/query")) |>
    req_url_query(where = "1=1", returnCountOnly = "true", f = "json") |>
    req_retry(max_tries = 5)
  body <- tryCatch(jsonlite::fromJSON(resp_body_string(req_perform(req))),
                   error = function(e) NULL)
  n <- suppressWarnings(as.integer(body$count))
  if (is.null(body) || length(n) != 1 || is.na(n)) {
    stop("count query failed for ", url, " — refusing to page without a verifiable total")
  }
  n
}

fetch_page <- function(url, offset) {
  req <- request(paste0(url, "/query")) |>
    req_url_query(where = "1=1", outFields = "*", returnGeometry = "true",
                  outSR = "4326", f = "geojson",
                  resultOffset = offset, resultRecordCount = PAGE_SIZE) |>
    req_retry(max_tries = 5)
  body <- resp_body_string(req_perform(req))
  if (grepl('"features"\\s*:\\s*\\[\\s*\\]', body)) return(NULL)
  fc <- sf::st_read(body, quiet = TRUE)
  if (nrow(fc) == 0) return(NULL)
  fc
}

# Feature count for `layer` in the NEWEST published snapshot's manifest, or NA
# when there is no prior snapshot / manifest (first run, moved repo — guard
# just skips). Reads the local mb-parcel-history clone (config.R root).
prior_layer_features <- function(layer, history_root = mb_parcel_history_root) {
  snaps <- tryCatch(sort(basename(list.dirs(history_root, recursive = FALSE)), decreasing = TRUE),
                    error = function(e) character(0))
  snaps <- snaps[grepl("^\\d{4}-\\d{2}-\\d{2}$", snaps)]
  for (s in snaps) {
    mf <- file.path(history_root, s, "manifest.json")
    if (!file.exists(mf)) next
    m <- tryCatch(jsonlite::read_json(mf), error = function(e) NULL)
    n <- suppressWarnings(as.integer(m$layers[[layer]]$features))
    if (length(n) == 1 && !is.na(n)) return(list(snapshot = s, features = n))
    return(NULL)   # newest manifest exists but lacks this layer — nothing comparable
  }
  NULL
}

# Abort (or warn, under PROVINCIAL_ACCEPT_SHRINK=1) when the fresh download is
# substantially smaller than the newest published snapshot. Pure decision
# helper so the logic is testable offline.
check_shrink <- function(name, n_new, prior, tolerance = SHRINK_TOLERANCE) {
  if (is.null(prior)) {
    cat(sprintf("  shrink guard: no prior snapshot manifest for %s — skipping\n", name))
    return(invisible(TRUE))
  }
  floor_n <- ceiling(prior$features * (1 - tolerance))
  cat(sprintf("  shrink guard: %d now vs %d in %s (floor %d)\n",
              n_new, prior$features, prior$snapshot, floor_n))
  if (n_new >= floor_n) return(invisible(TRUE))
  msg <- sprintf(paste0("%s shrank vs published history: %d features now vs %d in snapshot %s ",
                        "(>%.0f%% loss). Truncated/half-published source? Set PROVINCIAL_ACCEPT_SHRINK=1 ",
                        "to archive it anyway."),
                 name, n_new, prior$features, prior$snapshot, tolerance * 100)
  if (nzchar(Sys.getenv("PROVINCIAL_ACCEPT_SHRINK"))) {
    cat("  !! ACCEPTED SHRINK (PROVINCIAL_ACCEPT_SHRINK set):", msg, "\n")
    return(invisible(TRUE))
  }
  stop(msg)
}

# count_fn / page_fn injectable for offline tests.
download_layer <- function(ds, count_fn = fetch_count, page_fn = fetch_page) {
  cat(sprintf("\n== %s ==\n", ds$name)); flush.console()
  expected <- count_fn(ds$url)
  cat(sprintf("  server count: %d\n", expected))
  if (expected <= 0) stop("server reports 0 features for ", ds$name, " — aborting (nothing written)")

  pages <- list(); got <- 0L; offset <- 0L
  while (got < expected) {
    cat(sprintf("  offset %d ...", offset)); flush.console()
    page <- page_fn(ds$url, offset)
    if (is.null(page)) {
      stop(sprintf("premature end of data for %s: got %d of %d expected — refusing to write a truncated layer",
                   ds$name, got, expected))
    }
    n <- nrow(page); cat(sprintf(" %d\n", n))
    pages[[length(pages) + 1]] <- page
    # Advance by rows RECEIVED, not by PAGE_SIZE — a transfer-limited server may
    # trim a page, and assuming the full stride would silently skip rows.
    got    <- got + n
    offset <- offset + n
  }
  if (got != expected) {
    stop(sprintf("count mismatch for %s: received %d, server said %d — refusing to write",
                 ds$name, got, expected))
  }
  combined <- do.call(rbind, pages)
  if (nrow(combined) != expected) {
    stop(sprintf("assembled rows (%d) != verified count (%d) for %s", nrow(combined), expected, ds$name))
  }
  cat(sprintf("  total %d features (count-verified)\n", nrow(combined)))

  check_shrink(ds$name, nrow(combined), prior_layer_features(ds$layer))

  if (!is.na(ds$target_crs)) {
    combined <- sf::st_transform(combined, ds$target_crs)
    cat(sprintf("  reprojected -> EPSG:%d\n", ds$target_crs))
  }
  # Write to a temp name with a real extension (GDAL guesses the driver from
  # it), then swap into place so the final file never exists half-written.
  if (grepl("\\.gpkg$", ds$out)) {
    tmp <- paste0(ds$out, ".tmp.gpkg")
    sf::st_write(combined, tmp, layer = ds$layer, driver = "GPKG", delete_dsn = TRUE, quiet = TRUE)
  } else {
    tmp <- paste0(ds$out, ".tmp.geojson")
    sf::st_write(combined, tmp, driver = "GeoJSON", delete_dsn = TRUE, quiet = TRUE)
  }
  if (file.exists(ds$out)) unlink(ds$out)
  if (!file.rename(tmp, ds$out)) {
    if (!file.copy(tmp, ds$out, overwrite = TRUE)) { unlink(tmp); stop("could not move ", basename(tmp), " into place") }
    unlink(tmp)
  }
  cat(sprintf("  wrote %s (%.1f MB)\n", basename(ds$out), file.info(ds$out)$size / 1024^2))
}

# Gated so tests can source() the functions above without kicking off a ~300 MB
# provincial download.
if (!nzchar(Sys.getenv("PROVINCIAL_SNAPSHOT_SOURCE_ONLY"))) {
  cat("=== fresh provincial download ->", OUT, "===\n")
  for (ds in datasets) download_layer(ds)
  cat("\nAll three layers downloaded.\n")
}
