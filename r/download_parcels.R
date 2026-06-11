# download_parcels.R
# Snapshots Manitoba Open Data parcel + zoning + development-plan layers
# to local GeoPackage files. Run periodically to maintain a historical
# archive that the Shiny app can search offline.
#
# Three FeatureServer layers, all hosted at the same provincial ArcGIS Online org:
#   ROLL_ENTRY                              ~437k parcels
#   Manitoba_Zoning_By_Laws                 ~few-thousand zoning polygons
#   Manitoba_Development_Plan_Designations  ~few-hundred dev-plan polygons
#
# Pagination is required — each FeatureServer caps any one page at 2000.
# We page via resultOffset until the response stops including more rows.
#
# Requires: sf, httr2

suppressPackageStartupMessages({
  library(sf)
  library(httr2)
})

# Save files in the same folder as this script.
output_dir <- "D:/Dropbox/ClaudeCode/MBOpenData/WebSearch"

# Date stamp for filenames.
date_stamp <- format(Sys.Date(), "%Y%m%d")

# Allow long downloads — ROLL_ENTRY is 437k parcels and even paginated
# can take a few minutes total.
options(timeout = 1800)

# Re-download even when today's snapshot already exists: pass --force on
# the command line or set FORCE_DOWNLOAD=1. (The dated file only ever
# appears complete — see the temp+rename in download_layer — so the
# same-day skip is safe; --force covers "I want a fresher pull today".)
# DOWNLOAD_ONLY=<dataset name> limits the run to one dataset (smoke tests).
cli_args <- commandArgs(trailingOnly = TRUE)
FORCE_REFRESH <- ("--force" %in% cli_args) || nzchar(Sys.getenv("FORCE_DOWNLOAD"))
DOWNLOAD_ONLY <- Sys.getenv("DOWNLOAD_ONLY")

PAGE_SIZE <- 2000
BASE <- "https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services"

datasets <- list(
  list(
    name  = "RollEntry",
    layer = "roll_entry",
    url   = paste0(BASE, "/ROLL_ENTRY/FeatureServer/0")
  ),
  list(
    name  = "ManitobaZoning",
    layer = "zoning",
    url   = paste0(BASE, "/Manitoba_Zoning_By_Laws/FeatureServer/0")
  ),
  list(
    name  = "ManitobaDevPlan",
    layer = "dev_plan",
    url   = paste0(BASE, "/Manitoba_Development_Plan_Designations/FeatureServer/0")
  )
)

# Fetch one page of GeoJSON features and parse to an sf data frame.
# Returns NULL on the page that runs past the end of the dataset.
fetch_page <- function(url, offset, page_size = PAGE_SIZE) {
  req <- request(paste0(url, "/query")) |>
    req_url_query(
      where = "1=1",
      outFields = "*",
      returnGeometry = "true",
      outSR = "4326",
      f = "geojson",
      resultOffset = offset,
      resultRecordCount = page_size
    ) |>
    req_retry(max_tries = 4)
  resp <- req_perform(req)
  body <- resp_body_string(resp)
  # The page just past the end of the dataset comes back with an empty
  # features array; some sf versions error on that instead of returning
  # zero rows, so detect it cheaply on the raw body first.
  if (grepl('"features"\\s*:\\s*\\[\\s*\\]', body)) return(NULL)
  # Parse via sf so we get geometry handling for free. A body that fails
  # to parse here is NOT a clean end-of-data — it's an error payload or a
  # truncated response — so let the error propagate to download_layer,
  # which aborts the layer instead of silently writing a partial file.
  fc <- sf::st_read(body, quiet = TRUE)
  if (nrow(fc) == 0) return(NULL)
  fc
}

# Walk through every page until we run out. The service signals "no more"
# either by returning fewer rows than asked, or by an empty features array.
download_layer <- function(ds) {
  cat(sprintf("\n== %s ==\n", ds$name))
  gpkg_path <- file.path(output_dir, sprintf("%s_%s.gpkg", ds$name, date_stamp))
  if (file.exists(gpkg_path)) {
    if (FORCE_REFRESH) {
      cat("Already downloaded today:", basename(gpkg_path), "- re-downloading (--force)\n")
    } else {
      cat("Already downloaded today:", basename(gpkg_path), "- skipping (--force to re-download)\n")
      return(invisible(gpkg_path))
    }
  }

  pages <- list()
  offset <- 0
  failed <- FALSE
  repeat {
    cat(sprintf("  fetching offset %d...", offset))
    page <- tryCatch(
      fetch_page(ds$url, offset),
      error = function(e) {
        cat(" FAILED:", conditionMessage(e), "\n")
        failed <<- TRUE
        NULL
      }
    )
    if (is.null(page)) break
    n <- nrow(page)
    cat(sprintf(" %d features\n", n))
    pages[[length(pages) + 1]] <- page
    if (n < PAGE_SIZE) break
    offset <- offset + PAGE_SIZE
  }

  # A mid-stream failure means `pages` holds only part of the dataset.
  # Write nothing: a partial dated .gpkg would look complete to the
  # same-day skip above (and to every downstream consumer of the file).
  if (failed) {
    cat(sprintf("  download FAILED after %d page(s) — not writing a partial snapshot; re-run to retry\n",
                length(pages)))
    return(invisible(NULL))
  }

  if (length(pages) == 0) {
    cat("  no features returned; nothing to write\n")
    return(invisible(NULL))
  }

  combined <- do.call(rbind, pages)
  cat(sprintf("  total features: %d\n", nrow(combined)))
  cat(sprintf("  writing %s ...\n", basename(gpkg_path)))
  # Write to a temp name, rename into place once complete — the dated
  # filename never exists half-written, so "file exists" above really
  # does mean "today's snapshot is complete".
  tmp_path <- file.path(output_dir, sprintf(".tmp_%s_%s.gpkg", ds$name, date_stamp))
  sf::st_write(combined, tmp_path, layer = ds$layer, delete_dsn = TRUE, quiet = TRUE)
  if (file.exists(gpkg_path)) unlink(gpkg_path)  # --force re-download path
  if (!file.rename(tmp_path, gpkg_path)) {
    # file.rename can fail under Dropbox/AV file locks — copy + delete.
    if (!file.copy(tmp_path, gpkg_path, overwrite = TRUE)) {
      unlink(tmp_path)
      stop("could not move ", basename(tmp_path), " into place")
    }
    unlink(tmp_path)
  }
  size_mb <- round(file.info(gpkg_path)$size / 1024^2, 1)
  cat(sprintf("  done — %s MB\n", size_mb))
  invisible(gpkg_path)
}

cat("=== Manitoba Open Data Parcel Snapshot ===\n")
cat("Date:", format(Sys.Date(), "%Y-%m-%d"), "\n")
cat("Output:", output_dir, "\n")

for (ds in datasets) {
  if (nzchar(DOWNLOAD_ONLY) && !identical(ds$name, DOWNLOAD_ONLY)) next
  download_layer(ds)
}

cat("\nDone.\n")
