# build_river_lots.R
#
# Converts MB-RIVER-LOTS.kmz (Google Earth-style KML zipped, supplied by
# the Manitoba historic survey) into a static GeoJSON file the frontend
# can load alongside the pre-baked section-township grid. River lots
# are non-DLS parcels — long, narrow, perpendicular to a riverbank —
# legacy of Métis and parish settlement patterns. Showing them in the
# same Sec-Twp Grid toggle gives a complete legal-survey reference
# layer over the parts of Manitoba where the DLS section system doesn't
# apply.
#
# Input  : MB-RIVER-LOTS.kmz (project root)
# Output : web/public/data/river-lots.json
#
# The KMZ packs a single doc.kml with one Placemark per river lot,
# each carrying a polygon geometry and a `name` (e.g. "AGRL338"). We
# extract just (geometry, name) → keeping the file small. Coordinates
# are rounded to 5 decimals (~1 m) for size.
#
# Runtime: ~30 seconds on the ~24 MB doc.kml. Re-run only if a fresh
# KMZ lands; the survey itself is fixed.

suppressPackageStartupMessages({
  library(sf)
  library(jsonlite)
})

# Shared roots (env-overridable) — see r/config.R.
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

source_dir  <- mb_parcelsearch_root
input_kmz   <- file.path(source_dir, "MB-RIVER-LOTS.kmz")
# Output publishes into the local mb-parcel-data clone (served via
# raw.githubusercontent pinned commit — see MB_PARCEL_DATA_CDN in arcgis.js).
output_path <- file.path(mb_parcel_data_root, "river-lots.json")

if (!file.exists(input_kmz)) {
  stop("Cannot find ", input_kmz, ". Drop the KMZ in the project root first.")
}

dir.create(dirname(output_path), showWarnings = FALSE, recursive = TRUE)

# Unzip to a tmp dir; sf can read KML directly. (st_read on the KMZ
# itself works in newer GDALs but the unzip route is portable across
# any GDAL build that has the KML driver.)
tmp <- tempfile("riverlots_")
dir.create(tmp)
on.exit(unlink(tmp, recursive = TRUE), add = TRUE)
unzip(input_kmz, exdir = tmp)
kml_path <- file.path(tmp, "doc.kml")
if (!file.exists(kml_path)) {
  stop("Expected doc.kml inside the KMZ; not found.")
}

cat("Reading", kml_path, "...\n")
# A KML can carry several layers; read the lot-polygon layer (skipping
# any text/label folder). st_layers() lists what's inside.
layers <- sf::st_layers(kml_path)
cat("  layers:", paste(layers$name, collapse = ", "), "\n")

# Read every polygon layer, drop point/text layers (they show as
# ST_Point with the lot's name centroid), bind them.
all_polys <- list()
for (i in seq_along(layers$name)) {
  geom_type <- layers$geomtype[[i]]
  if (length(geom_type) == 0L) next
  has_poly <- any(grepl("polygon|multipolygon", tolower(geom_type)))
  if (!has_poly) next
  lyr <- sf::st_read(kml_path, layer = layers$name[i], quiet = TRUE)
  if (nrow(lyr) == 0L) next
  # Some KML layers come back as GEOMETRYCOLLECTION mixing points and
  # polygons — extract just the polygon parts.
  lyr <- sf::st_collection_extract(lyr, "POLYGON", warn = FALSE)
  lyr <- lyr[!sf::st_is_empty(lyr), ]
  if (nrow(lyr) == 0L) next
  all_polys[[length(all_polys) + 1L]] <- lyr
}

if (length(all_polys) == 0L) {
  stop("No polygon layers in the KMZ.")
}

# rbind across layers — they may have different attribute schemas, so
# keep just the common columns: Name (the lot identifier) and geometry.
norm_layer <- function(lyr) {
  cols_lower <- tolower(names(lyr))
  name_col <- which(cols_lower == "name")
  if (length(name_col) == 0L) {
    lyr$name <- NA_character_
  } else {
    lyr$name <- as.character(lyr[[name_col[1]]])
  }
  lyr[, c("name", attr(lyr, "sf_column"))]
}
all_polys <- lapply(all_polys, norm_layer)
river <- do.call(rbind, all_polys)

if (sf::st_crs(river)$epsg != 4326L) {
  river <- sf::st_transform(river, 4326)
}

# KMZ exports ship with Z (and sometimes M) dimensions. Drop them —
# MapLibre only renders 2D, and stripping shrinks the output ~25%.
river <- sf::st_zm(river, drop = TRUE, what = "ZM")

cat("  river-lot polygons:", nrow(river), "\n")

# Tag every feature with kind='riverlot' so the map can style it
# alongside (but distinguishably from) the section-grid features in
# the same survey-grid map source. Keep just (kind, label, geometry)
# columns so the GeoJSON ships only what the frontend needs.
#
# Pretty-print the label here rather than at runtime in JS:
# raw KMZ labels jam parish + lot type + number into a single
# string ("AGRL338", "LORL79"). Split into PARISH-TYPE-NUMBER
# ("AG-RL-338", "LO-RL-79") so the parish prefix, lot type, and
# lot number all stand out. Anything that doesn't match the expected
# pattern keeps its raw form so unusual identifiers still render.
prettify_river_lot <- function(raw) {
  out <- raw
  hit <- !is.na(raw) &
         grepl("^[A-Z]{2,5}(RL|PL|WL|SL|OT)\\d+[A-Z]?$", toupper(raw))
  if (any(hit)) {
    pattern <- "^([A-Z]{2,5})(RL|PL|WL|SL|OT)(\\d+[A-Z]?)$"
    out[hit] <- sub(pattern, "\\1-\\2-\\3", toupper(raw[hit]))
  }
  out
}

river$kind  <- "riverlot"
river$label <- prettify_river_lot(river$name)
river <- river[, c("kind", "label", attr(river, "sf_column"))]

cat("Writing", output_path, "...\n")
# st_write with the GeoJSON driver produces a proper FeatureCollection
# with rounded coordinates (COORDINATE_PRECISION limits decimals; 5
# ≈ 1 m, plenty for a visual reference layer). delete_dsn=TRUE so
# re-runs overwrite cleanly.
if (file.exists(output_path)) file.remove(output_path)
sf::st_write(
  river,
  output_path,
  driver  = "GeoJSON",
  layer_options = c("COORDINATE_PRECISION=5", "RFC7946=YES"),
  quiet   = TRUE
)
size_mb <- file.info(output_path)$size / 1024 / 1024
cat(sprintf("Done. Output: %s (%.2f MB)\n", output_path, size_mb))
