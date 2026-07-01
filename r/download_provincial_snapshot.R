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
# Same source + paging as download_parcels.R (2000/page, retry, partial-safe):
# a layer that fails mid-stream writes NOTHING, so a partial file never looks
# complete to the archiver. Reprojection to 26914 for the roll layer keeps
# as-of-date area measurements defensible (GeoJSON output from ArcGIS is 4326).
#
#   Rscript r/download_provincial_snapshot.R
#
# Requires: sf, httr2.

suppressPackageStartupMessages({ library(sf); library(httr2) })

# Shared roots (env-overridable) — see r/config.R.
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

OUT <- Sys.getenv("PROVINCIAL_STAGING_DIR")
if (!nzchar(OUT)) OUT <- file.path(websearch_root, ".staging", "inputs")
dir.create(OUT, showWarnings = FALSE, recursive = TRUE)
options(timeout = 3600)

PAGE_SIZE <- 2000
BASE <- "https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services"

datasets <- list(
  list(name = "RollEntry",       url = paste0(BASE, "/ROLL_ENTRY/FeatureServer/0"),
       out = file.path(OUT, "MBRollGeoPackage.gpkg"), layer = "parcels", target_crs = 26914),
  list(name = "ManitobaZoning",  url = paste0(BASE, "/Manitoba_Zoning_By_Laws/FeatureServer/0"),
       out = file.path(OUT, "Manitoba_Zoning_By_Laws.geojson"), layer = "zoning", target_crs = NA),
  list(name = "ManitobaDevPlan", url = paste0(BASE, "/Manitoba_Development_Plan_Designations/FeatureServer/0"),
       out = file.path(OUT, "Manitoba_Development_Plan_Designations.geojson"), layer = "devplan", target_crs = NA)
)

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

download_layer <- function(ds) {
  cat(sprintf("\n== %s ==\n", ds$name)); flush.console()
  pages <- list(); offset <- 0
  repeat {
    cat(sprintf("  offset %d ...", offset)); flush.console()
    page <- fetch_page(ds$url, offset)
    if (is.null(page)) { cat(" end\n"); break }
    n <- nrow(page); cat(sprintf(" %d\n", n))
    pages[[length(pages) + 1]] <- page
    if (n < PAGE_SIZE) break
    offset <- offset + PAGE_SIZE
  }
  if (!length(pages)) stop("no features returned for ", ds$name, " — aborting (nothing written)")
  combined <- do.call(rbind, pages)
  cat(sprintf("  total %d features\n", nrow(combined)))
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

cat("=== fresh provincial download ->", OUT, "===\n")
for (ds in datasets) download_layer(ds)
cat("\nAll three layers downloaded.\n")
