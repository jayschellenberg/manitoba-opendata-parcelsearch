# build_rollentry_snapshot.R
#
# Shards a local Roll_Entry snapshot (RollEntry_YYYYMMDD.gpkg from
# r/download_parcels.R) into per-muni GeoJSON shards that the webapp
# can fall back to when the upstream provincial ROLL_ENTRY FeatureServer
# is unavailable or mid-rebuild (observed 2026-06-03).
#
# Output layout (in the local mb-parcel-data repo clone):
#   rollentry-snapshot/<MUNI_KEY>.json    one GeoJSON FC per muni
#   rollentry-snapshot/_index.json        manifest:
#                                                          { snapshot_date, generated_at,
#                                                            munis: { <Muni_Name_With_Typ>:
#                                                              { file, count } } }
#
# Each muni shard is a FeatureCollection with the same shape the live
# ArcGIS query returns — so the webapp's snapshot-mode fetcher is a
# drop-in replacement for fetchAllParcelsInMunicipality / searchParcels.
# Only the 10 fields the webapp actually consumes are kept:
#   OBJECTID, Roll_No_Txt, Property_Address, Municipality,
#   Muni_Name_With_Typ, Asmt_Roll, Dwelling_Units, Frontage_or_Area,
#   Total_Value, Asmt_Rpt_Url.
# (See PARCEL_OUTFIELDS in web/src/arcgis.js — keep in sync.)
#
# Geometry is Douglas-Peucker-simplified at ~10 m tolerance (0.00015°
# at MB latitudes). That collapses redundant vertices on simple
# quarter-section parcels without visibly affecting the urban shapes
# at the zoom levels the webapp uses. CRS stays in EPSG:4326 (GeoJSON
# convention; matches what ArcGIS returns to the webapp).
#
# Runtime: ~10 minutes for the full 437k parcels on the report machine.
# Re-run whenever a fresh RollEntry_*.gpkg lands (typically monthly when
# Jason refreshes the local snapshot via r/download_parcels.R).

suppressPackageStartupMessages({
  library(sf)
  library(dplyr)
  library(jsonlite)
  library(stringi)
})

# Use the GEOS spatial engine instead of S2 for this script. S2 enforces
# strict topology / validity after every operation (e.g., it rejects a
# polygon where a simplified edge ends up sharing a vertex with another
# edge) and forces preserveTopology=TRUE in st_simplify. For our use case
# — visual rendering of parcels at typical map zoom levels — those strict
# checks just block legitimate simplifications. GEOS is permissive
# enough to handle the simplify pass; st_make_valid below repairs any
# degenerate polygons that slip through.
sf::sf_use_s2(FALSE)

# Shared roots (env-overridable) — see r/config.R.
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

source_dir   <- mb_parcelsearch_root
# Shards publish into the local mb-parcel-data clone (served to the app
# via jsDelivr pinned to an immutable commit — see SNAPSHOT_CDN in
# web/src/arcgis.js), NOT web/public/data/. After a rebuild: commit +
# push mb-parcel-data, then update the pinned SHA. See MAINTENANCE.md.
output_dir   <- file.path(mb_parcel_data_root, "rollentry-snapshot")
manifest_path <- file.path(output_dir, "_index.json")

# Fields the webapp uses. KEEP IN SYNC with PARCEL_OUTFIELDS in
# web/src/arcgis.js — adding a field there means add it here and re-run.
WEBAPP_FIELDS <- c(
  "OBJECTID", "Roll_No_Txt", "Property_Address", "Municipality",
  "Muni_Name_With_Typ", "Asmt_Roll", "Dwelling_Units",
  "Frontage_or_Area", "Total_Value", "Asmt_Rpt_Url"
)

# DP simplification tolerance in degrees. At MB latitudes ~50°N, 1° lat
# is ~111 km and 1° lon is ~71 km, so 0.00015° is ~10-17 m — well below
# the visual resolution at the zoom levels the webapp uses, and rural
# quarter-section parcels (the bulk of the dataset) collapse from
# raster-traced 50+ vertices to clean 4-6 vertex polygons.
SIMPLIFY_TOLERANCE_DEG <- 0.00015

# Filename-safe form of Muni_Name_With_Typ — same scheme as
# build_landcover.R / build_parcel_masc.R so all shard dirs line up.
safe_filename <- function(x) {
  x |>
    stringi::stri_trans_general(id = "Latin-ASCII") |>
    toupper() |>
    gsub(pattern = "[^A-Z0-9._-]+", replacement = "_") |>
    gsub(pattern = "_+",            replacement = "_") |>
    gsub(pattern = "^_|_$",         replacement = "")
}

# ----------------------------------------------------------------------
# 1. Locate the most recent RollEntry_*.gpkg
# ----------------------------------------------------------------------
gpkg_files <- list.files(source_dir, pattern = "^RollEntry_\\d{8}\\.gpkg$",
                         full.names = TRUE)
if (length(gpkg_files) == 0L) {
  stop("No RollEntry_YYYYMMDD.gpkg found in ", source_dir,
       ". Run r/download_parcels.R first.")
}
gpkg_path <- tail(sort(gpkg_files), 1L)
snapshot_date <- substr(basename(gpkg_path), 11, 18) |>
  (\(d) paste0(substr(d,1,4), "-", substr(d,5,6), "-", substr(d,7,8)))()
cat("Source snapshot:", basename(gpkg_path), " (", snapshot_date, ")\n")

# ----------------------------------------------------------------------
# 2. Read parcels — only the fields we'll ship, plus geom
# ----------------------------------------------------------------------
# A SQL query gets the field projection done by GDAL up front, which is
# faster and cheaper on memory than reading everything then dropping
# columns in R. GeoPackage drops the geometry column unless we ask for
# it explicitly in the SELECT — without "geom" listed, sf::st_read
# returns a plain data.frame with no spatial column at all.
field_list <- paste0('"', WEBAPP_FIELDS, '"', collapse = ", ")
cat("Reading parcels (this takes a couple of minutes)...\n")
t0 <- Sys.time()
parcels <- sf::st_read(
  gpkg_path,
  query = sprintf('SELECT %s, "geom" FROM "roll_entry"', field_list),
  quiet = TRUE
)
cat(sprintf("  Read %d parcels in %.1fs\n",
            nrow(parcels), as.numeric(Sys.time() - t0, units = "secs")))

# Drop rows without a valid muni — they can't be sharded.
parcels <- parcels[!is.na(parcels$Muni_Name_With_Typ) &
                   nzchar(parcels$Muni_Name_With_Typ), ]
cat(sprintf("  %d parcels with a Muni_Name_With_Typ\n", nrow(parcels)))

dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

# ----------------------------------------------------------------------
# 3. Simplify geometry once across the whole dataset
# ----------------------------------------------------------------------
# st_simplify on the whole sf object is a single C++ pass — much faster
# than simplifying inside the per-muni loop. Topology can't be preserved
# across the union (we'd need st_simplify_preserveTopology with a planar
# CRS), but that doesn't matter for our use case: each parcel is its own
# polygon and we never use shared edges.
cat("Simplifying geometry...\n")
t0 <- Sys.time()
# Use sf::st_geometry()<- so we don't depend on the geometry column
# being named "geom" — sf renames it under various scenarios.
sf::st_geometry(parcels) <- sf::st_simplify(
  sf::st_geometry(parcels),
  dTolerance = SIMPLIFY_TOLERANCE_DEG,
  preserveTopology = TRUE
)
cat(sprintf("  Simplified in %.1fs\n",
            as.numeric(Sys.time() - t0, units = "secs")))

# Repair any degenerate polygons produced by the simplification pass.
# In practice this is a no-op for most parcels but catches the rare
# self-intersecting shapes (Edge N shares a vertex with edge M) that
# would later trip up GeoJSON serialisation. Cheap with GEOS.
cat("Repairing geometry...\n")
t0 <- Sys.time()
sf::st_geometry(parcels) <- sf::st_make_valid(sf::st_geometry(parcels))
cat(sprintf("  Repaired in %.1fs\n",
            as.numeric(Sys.time() - t0, units = "secs")))

# Filter out any features the simplification reduced to empty (tiny
# slivers where every vertex was within tolerance — extremely rare on
# real parcel polygons).
empty <- sf::st_is_empty(parcels)
if (any(empty)) {
  cat(sprintf("  Dropping %d empty geometries after simplify\n", sum(empty)))
  parcels <- parcels[!empty, ]
}

# ----------------------------------------------------------------------
# 4. Per-muni shards
# ----------------------------------------------------------------------
muni_groups <- split(seq_len(nrow(parcels)), parcels$Muni_Name_With_Typ)
cat(sprintf("Writing %d muni shards...\n", length(muni_groups)))
manifest <- list()
total_bytes <- 0
t0 <- Sys.time()
for (mname in names(muni_groups)) {
  idx <- muni_groups[[mname]]
  shard <- parcels[idx, ]
  fname <- paste0(safe_filename(mname), ".json")
  out_path <- file.path(output_dir, fname)
  # write_sf with GeoJSON keeps coordinate precision modest — by default
  # 7 decimals (~1cm at MB latitudes), well past what the simplification
  # tolerance demands. Pass COORDINATE_PRECISION=5 (~1m) via layer_options
  # to halve the size of the coordinate strings.
  if (file.exists(out_path)) file.remove(out_path)
  # NOTE: deliberately NOT passing ID_FIELD=OBJECTID — the webapp's
  # parcel source uses MapLibre's `promoteId: 'OBJECTID'`, which reads
  # OBJECTID out of `feature.properties` (not the GeoJSON `feature.id`
  # slot). Keeping it in properties also matches what ArcGIS returns,
  # so the snapshot is a drop-in replacement.
  sf::st_write(
    shard, out_path, driver = "GeoJSON",
    quiet = TRUE,
    layer_options = c("COORDINATE_PRECISION=5", "RFC7946=NO")
  )
  # Numeric muni code lives at the head of the Municipality field
  # (e.g. "610 - RM OF PINEY" → 610). The webapp's parcelKeys path
  # (list imports) keys on muni_no, so emitting it here lets the
  # snapshot fall back to that flow without re-scanning shards at
  # runtime. NA when no row carried a parseable code.
  muni_no_raw <- suppressWarnings(as.integer(
    sub("\\s*-.*$", "", shard$Municipality[1])
  ))
  manifest[[mname]] <- list(
    file    = fname,
    count   = nrow(shard),
    muni_no = if (is.na(muni_no_raw)) NULL else muni_no_raw
  )
  total_bytes <- total_bytes + file.info(out_path)$size
}
cat(sprintf("  Done in %.1fs, total %.1f MB across all shards\n",
            as.numeric(Sys.time() - t0, units = "secs"),
            total_bytes / 1024 / 1024))

# ----------------------------------------------------------------------
# 5. Manifest
# ----------------------------------------------------------------------
jsonlite::write_json(
  list(
    snapshot_date = snapshot_date,
    generated_at  = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
    source        = basename(gpkg_path),
    fields        = WEBAPP_FIELDS,
    simplify_tolerance_deg = SIMPLIFY_TOLERANCE_DEG,
    munis         = manifest
  ),
  manifest_path,
  auto_unbox = TRUE, pretty = TRUE
)

cat("Manifest:", manifest_path, "\n")
cat("Output dir:", output_dir, "\n")
cat(sprintf("%d munis · %d total parcels · %.1f MB on disk\n",
            length(manifest), nrow(parcels), total_bytes / 1024 / 1024))
