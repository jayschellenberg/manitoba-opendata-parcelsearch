# build_parcel_masc.R
#
# Pre-bakes the dominant MASC soil rating for every Roll_Entry parcel,
# so the frontend can attach a soil rating to each parcel row without
# doing a per-parcel spatial query at render time.
#
# Inputs:
#   * RollEntry_YYYYMMDD.gpkg                 — most-recent parcel snapshot
#                                               from r/download_parcels.R
#   * masc_soil_ratings_with_latlon.csv       — quarter-section centroids
#                                               with rating + risk-area cols
#
# Output:
#   web/public/data/parcel-masc/<MUNI_KEY>.json
#       Per-municipality JSON shards keyed on Muni_Name_With_Typ (the same
#       value Roll_Entry stamps on each parcel). Inside each shard:
#         { "<roll_no_txt>": { "rating": "C", "ra": 32,
#                              "q": "NE", "s": 1, "t": 12, "r": 5, "d": "E" },
#           ... }
#       Only parcels with ≥1 quarter-section overlap are written; urban
#       parcels (city lots, cottage subdivisions) typically drop out.
#
#   web/public/data/parcel-masc/_index.json
#       Manifest of muni keys with rated-parcel counts; same shape as the
#       MASC overlay's _index.json.
#
# Pipeline:
#   1. Load Roll_Entry parcels (all 437k, sf polygons in EPSG:4326).
#   2. Build ~800 m × ~800 m square polygons around each MASC centroid
#      (same approximation as masc.js's quarterPolygon — DLS quarters are
#      nominally 800 m square; minor real-world irregularities don't
#      matter for "which rating dominates this parcel").
#   3. Spatial join (sf::st_intersection): every parcel × every
#      overlapping quarter, with the intersection area weighted by
#      quarter so we know which rating covers the most ground.
#   4. For each parcel, pick the dominant rating (largest summed
#      intersection area). If ties, pick alphabetically (A wins over B).
#   5. Group by Muni_Name_With_Typ and write per-muni shards.
#
# Runtime: ~5-15 minutes depending on machine. Re-run after a fresh
# RollEntry snapshot or a refreshed MASC CSV. Output is committed to
# source control (small enough — ~437k parcels * ~80 bytes/row ≈ 35 MB
# total across all shards, max single-muni shard < 2 MB).

suppressPackageStartupMessages({
  library(sf)
  library(dplyr)
  library(readr)
  library(jsonlite)
  library(stringi)
})

source_dir <- "D:/Dropbox/ClaudeCode/MBOpenData/WebSearch"
output_dir <- file.path(source_dir, "web/public/data/parcel-masc")
index_path <- file.path(output_dir, "_index.json")

dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

# ----------------------------------------------------------------------
# 1. Locate the most recent Roll_Entry snapshot
# ----------------------------------------------------------------------
roll_files <- list.files(source_dir, pattern = "^RollEntry_\\d{8}\\.gpkg$",
                         full.names = TRUE)
if (length(roll_files) == 0L) {
  stop("No RollEntry_YYYYMMDD.gpkg found in ", source_dir,
       ". Run r/download_parcels.R first.")
}
roll_path <- tail(sort(roll_files), 1L)
cat("Reading parcels from:", basename(roll_path), "\n")
parcels <- sf::st_read(roll_path, quiet = TRUE)
cat("  parcels:", nrow(parcels), "\n")

# Ensure WGS84 lat/lon — MASC centroids are in lat/lon.
if (sf::st_crs(parcels)$epsg != 4326L) {
  parcels <- sf::st_transform(parcels, 4326)
}

# Keep only the columns we need + geometry. Roll_No_Txt is unique within
# a muni only — Muni_Name_With_Typ is the join key for shard partitioning.
# The gpkg's geometry column may be named "geom", "geometry", or "SHAPE"
# depending on which writer produced it; use the sf-aware accessor instead
# of naming it directly so the script is portable across snapshots.
geom_col <- attr(parcels, "sf_column")
parcels <- parcels[, c("Roll_No_Txt", "Muni_Name_With_Typ", geom_col)]
parcels <- parcels[!is.na(parcels$Roll_No_Txt) & !is.na(parcels$Muni_Name_With_Typ), ]
# Normalize the geometry column name so the rest of the script (and the
# st_intersection result) carries a predictable "geometry" column.
if (geom_col != "geometry") {
  names(parcels)[names(parcels) == geom_col] <- "geometry"
  sf::st_geometry(parcels) <- "geometry"
}

# ----------------------------------------------------------------------
# 2. Read MASC ratings; build quarter-section polygons (~800m squares)
# ----------------------------------------------------------------------
masc_csv <- file.path(source_dir, "masc_soil_ratings_with_latlon.csv")
if (!file.exists(masc_csv)) {
  stop("Cannot find masc_soil_ratings_with_latlon.csv at ", masc_csv)
}
cat("Reading MASC ratings ...\n")
masc <- readr::read_csv(masc_csv, show_col_types = FALSE)
cat("  rows:", nrow(masc), "\n")

masc <- masc |> filter(!is.na(lat), !is.na(lon))

# Half-side for the quarter polygon, in metres. Mirrors masc.js.
QUARTER_HALF_M <- 400
M_PER_DEG_LAT  <- 111320

cat("Building quarter polygons ...\n")
make_quarter_geom <- function(lat, lon) {
  d_lat <- QUARTER_HALF_M / M_PER_DEG_LAT
  d_lon <- QUARTER_HALF_M / (M_PER_DEG_LAT * cos(lat * pi / 180))
  sf::st_polygon(list(matrix(c(
    lon - d_lon, lat - d_lat,
    lon + d_lon, lat - d_lat,
    lon + d_lon, lat + d_lat,
    lon - d_lon, lat + d_lat,
    lon - d_lon, lat - d_lat
  ), ncol = 2, byrow = TRUE)))
}

# Vectorise polygon construction. mapply is quick enough — this is ~150k
# rows, runs in a few seconds.
geoms <- mapply(make_quarter_geom, masc$lat, masc$lon, SIMPLIFY = FALSE)
masc_sf <- sf::st_sf(
  q      = masc$quarter,
  s      = as.integer(masc$section),
  t      = as.integer(masc$township),
  r      = as.integer(masc$range_num),
  d      = masc$direction,
  rating = masc$soil_rating,
  ra     = as.integer(masc$risk_area),
  geometry = sf::st_sfc(geoms, crs = 4326)
)
cat("  quarters:", nrow(masc_sf), "\n")

# ----------------------------------------------------------------------
# 3. Spatial intersection (parcel × quarter), area-weighted
# ----------------------------------------------------------------------
# Use a planar projection for area calculations — UTM 14N covers most
# of southern Manitoba's farmland; minor distortion at the extremes is
# fine for "pick the dominant rating".
utm14 <- 26914
parcels_utm <- sf::st_transform(parcels, utm14)
masc_utm    <- sf::st_transform(masc_sf, utm14)

# Repair invalid geometries before the intersection. ROLL_ENTRY ships
# parcels with self-intersections, near-duplicate vertices, and stray
# spikes that GEOS refuses to operate on (TopologyException: Ring edge
# missing). st_make_valid() runs MakeValid which fixes these by
# decomposing into a clean GeometryCollection. The MASC squares are
# constructed in this script so they're clean by definition, but
# running it on both sides is cheap insurance.
cat("Repairing invalid parcel geometries ...\n")
parcels_utm <- sf::st_make_valid(parcels_utm)
# After MakeValid, a parcel might come back as a GeometryCollection
# mixing polygons + lines + points. Keep just the polygon parts —
# st_intersection won't return area for the rest anyway.
parcels_utm <- sf::st_collection_extract(parcels_utm, "POLYGON", warn = FALSE)
parcels_utm <- parcels_utm[!sf::st_is_empty(parcels_utm), ]
cat("  parcels after repair:", nrow(parcels_utm), "\n")

masc_utm <- sf::st_make_valid(masc_utm)

cat("Computing parcel × quarter intersections (this is the slow step) ...\n")
# st_intersection returns one feature per parcel-quarter pair where they
# overlap. Areas computed on the result. s2=FALSE is implicit since
# we're in a planar projection (UTM 14N).
inter <- sf::st_intersection(parcels_utm, masc_utm)
cat("  intersections:", nrow(inter), "\n")

inter$area_m2 <- as.numeric(sf::st_area(inter))

# ----------------------------------------------------------------------
# 4. Pick the dominant rating per parcel
# ----------------------------------------------------------------------
cat("Selecting dominant rating per parcel ...\n")
dominant <- inter |>
  sf::st_drop_geometry() |>
  group_by(Roll_No_Txt, Muni_Name_With_Typ, rating) |>
  summarise(
    area_m2 = sum(area_m2),
    q  = first(q),
    s  = first(s),
    t  = first(t),
    r  = first(r),
    d  = first(d),
    ra = first(ra),
    .groups = "drop_last"
  ) |>
  arrange(desc(area_m2), rating) |>
  slice_head(n = 1) |>
  ungroup()

cat("  parcels with a rating:", nrow(dominant), "\n")

# ----------------------------------------------------------------------
# 5. Per-muni shards
# ----------------------------------------------------------------------
# Filename safe form of Muni_Name_With_Typ (e.g. "HANOVER (RM)" → "HANOVER_RM").
safe_filename <- function(x) {
  x |>
    stringi::stri_trans_general(id = "Latin-ASCII") |>
    toupper() |>
    gsub(pattern = "[^A-Z0-9._-]+", replacement = "_") |>
    gsub(pattern = "_+",            replacement = "_") |>
    gsub(pattern = "^_|_$",         replacement = "")
}

dominant <- dominant |>
  mutate(muni_key = safe_filename(Muni_Name_With_Typ))

manifest <- list()
muni_keys <- sort(unique(dominant$muni_key))
cat("Writing", length(muni_keys), "shards ...\n")

for (key in muni_keys) {
  rows <- dominant |>
    filter(muni_key == key)

  # Build the per-roll dictionary. Using a named list keeps the JSON
  # tiny and lookups O(1) on the frontend (`dict[rollNoTxt]`).
  dict <- setNames(
    lapply(seq_len(nrow(rows)), function(i) {
      list(
        rating = rows$rating[i],
        ra     = rows$ra[i],
        q      = rows$q[i],
        s      = rows$s[i],
        t      = rows$t[i],
        r      = rows$r[i],
        d      = rows$d[i]
      )
    }),
    rows$Roll_No_Txt
  )

  fname <- paste0(key, ".json")
  fpath <- file.path(output_dir, fname)
  jsonlite::write_json(dict, fpath, auto_unbox = TRUE, na = "null")
  manifest[[rows$Muni_Name_With_Typ[1]]] <- list(
    file  = fname,
    count = nrow(rows)
  )
}

# Manifest indexed by Muni_Name_With_Typ (the original key, not the safe
# filename) so the frontend can look up directly from the dropdown value.
jsonlite::write_json(manifest, index_path, auto_unbox = TRUE, pretty = FALSE)

total_size_mb <- sum(file.info(list.files(output_dir, full.names = TRUE))$size) / 1024 / 1024
cat("Done.\n")
cat("  Output dir:", output_dir, "\n")
cat("  Manifest  :", index_path, "\n")
cat(sprintf("  Total size: %.1f MB across all shards\n", total_size_mb))
