# build_section_grid.R
#
# Pre-bakes the province-wide Sec-Twp grid as a single static GeoJSON file
# served from web/public/data/section-grid.json. Manitoba's DLS sections
# never change, so this runs once and the output is committed to source
# control alongside the MASC shards.
#
# Source : MB_LegalDesc FeatureServer (point centroids, one per quarter
#          section, ~970k rows)
# Output : web/public/data/section-grid.json
#
# Pipeline:
#   1. Page MB_LegalDesc with TYPE='Quarter' (the only type carrying
#      SECTION + TOWNSHIP + RANGE values).
#   2. Group by (section, township, range, meridian) — ~242k unique
#      sections.
#   3. Compute each section's bounding box in lat/lon, padded by half a
#      quarter on each side so a section with one or two known quarters
#      still encloses the full square mile.
#   4. Write a FeatureCollection of polygon rings keyed by the standard
#      Manitoba short-form label (e.g. "7-5-6E").
#
# Runtime: ~3-5 minutes depending on network. Re-run only when the source
# layer's schema changes — section geometry is fixed by federal survey.

suppressPackageStartupMessages({
  library(dplyr)
  library(jsonlite)
  library(httr2)
})

output_path <- "web/public/data/section-grid.json"
service_url <- "https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/MB_LegalDesc/FeatureServer/0/query"

dir.create(dirname(output_path), showWarnings = FALSE, recursive = TRUE)

# Page through the layer in chunks of 2000 (the service's maxRecordCount).
# Pulling lat/lon as plain attributes instead of geometry keeps the response
# small and skips the SR=3857 → 4326 reprojection client-side.
fetch_quarters <- function() {
  rows <- list()
  offset <- 0
  page_size <- 2000
  repeat {
    cat(sprintf("  page offset=%d ...\n", offset))
    resp <- httr2::request(service_url) |>
      httr2::req_body_form(
        where             = "TYPE = 'Quarter'",
        outFields         = "SECTION,TOWNSHIP,RANGE,MERIDIAN",
        returnGeometry    = "true",
        outSR             = "4326",
        f                 = "json",
        resultOffset      = as.character(offset),
        resultRecordCount = as.character(page_size)
      ) |>
      httr2::req_retry(max_tries = 5) |>
      httr2::req_perform()
    j <- httr2::resp_body_json(resp, simplifyVector = FALSE)
    feats <- j$features %||% list()
    if (length(feats) == 0L) break
    rows[[length(rows) + 1L]] <- feats
    if (isTRUE(j$exceededTransferLimit) || length(feats) == page_size) {
      offset <- offset + page_size
    } else {
      break
    }
  }
  unlist(rows, recursive = FALSE)
}

`%||%` <- function(a, b) if (is.null(a)) b else a

cat("Fetching MB_LegalDesc Quarter rows ...\n")
feats <- fetch_quarters()
cat(sprintf("  fetched %d quarter rows\n", length(feats)))

# Flatten to a tibble. Each feature contributes one row with the section
# key plus the centroid lat/lon. Drops anything missing the SECTION /
# TOWNSHIP / RANGE values that key the grouping.
rows <- tibble::tibble(
  s   = vapply(feats, function(f) as.integer(f$attributes$SECTION %||% NA), integer(1)),
  t   = vapply(feats, function(f) as.integer(f$attributes$TOWNSHIP %||% NA), integer(1)),
  r   = vapply(feats, function(f) as.integer(f$attributes$RANGE %||% NA), integer(1)),
  m   = vapply(feats, function(f) as.character(f$attributes$MERIDIAN %||% ""), character(1)),
  lon = vapply(feats, function(f) as.numeric(f$geometry$x %||% NA), numeric(1)),
  lat = vapply(feats, function(f) as.numeric(f$geometry$y %||% NA), numeric(1))
) |>
  filter(!is.na(s), !is.na(t), !is.na(r), !is.na(lat), !is.na(lon))
cat(sprintf("  retained %d rows after dropping incomplete records\n", nrow(rows)))

# Strip meridian to its W/E letter only (source stores "E1"/"W1").
rows <- rows |> mutate(dir = toupper(gsub("[^EW]", "", m)))

# Group by section and compute bbox. Pad by half a quarter (~400 m) on
# each side so partial sections still enclose the full sq mi. This
# matches the JS sectionLinesFromRows() padding so the static grid
# visually matches the on-the-fly per-muni grid.
M_PER_DEG_LAT <- 111320
QUARTER_HALF_M <- 400

sections <- rows |>
  group_by(s, t, r, dir) |>
  summarise(
    min_lat = min(lat),
    max_lat = max(lat),
    min_lon = min(lon),
    max_lon = max(lon),
    lat0    = first(lat),
    .groups = "drop"
  )

cat(sprintf("  derived %d unique sections\n", nrow(sections)))

# Build polygon ring for each section, padded.
build_ring <- function(min_lon, max_lon, min_lat, max_lat, lat0) {
  d_lat <- QUARTER_HALF_M / M_PER_DEG_LAT
  d_lon <- QUARTER_HALF_M / (M_PER_DEG_LAT * cos(lat0 * pi / 180))
  w <- min_lon - d_lon; e <- max_lon + d_lon
  s <- min_lat - d_lat; n <- max_lat + d_lat
  list(c(w, s), c(e, s), c(e, n), c(w, n), c(w, s))
}

# Round coordinates to 4 decimals (~10 m) — a section is ~1.6 km on a
# side, so 10 m precision is invisible at any zoom the grid layer
# renders at, and shaves ~30% off the GeoJSON. Drop the individual
# section/township/range/direction properties since `label` already
# encodes them — knocks another ~20% off. Result: ~25 MB instead of
# ~53 MB, comfortably under GitHub's 50 MB warning threshold.
features <- vector("list", nrow(sections))
for (i in seq_len(nrow(sections))) {
  ring <- build_ring(
    sections$min_lon[i], sections$max_lon[i],
    sections$min_lat[i], sections$max_lat[i],
    sections$lat0[i]
  )
  ring_rounded <- lapply(ring, function(p) round(p, 4))
  features[[i]] <- list(
    type = "Feature",
    geometry = list(
      type = "Polygon",
      coordinates = list(ring_rounded)
    ),
    properties = list(
      label = sprintf("%d-%d-%d%s", sections$s[i], sections$t[i],
                      sections$r[i], sections$dir[i])
    )
  )
}

fc <- list(type = "FeatureCollection", features = features)

cat("Writing", output_path, "...\n")
jsonlite::write_json(fc, output_path, auto_unbox = TRUE, digits = 5, na = "null")

size_mb <- file.info(output_path)$size / 1024 / 1024
cat(sprintf("Done. Output: %s (%.2f MB)\n", output_path, size_mb))
