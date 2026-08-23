# export_rollentry_geojson.R
#
# Step 1 of the Assessment Parcels tile build: turn a local Roll_Entry
# snapshot (RollEntry_YYYYMMDD.gpkg from r/download_parcels.R) into a
# newline-delimited GeoJSON stream that web/scripts/build-parcel-tiles.mjs
# can read a feature at a time.
#
#   RollEntry_*.gpkg
#     -> [this script]      rollentry.geojsons   (raw, one feature per line)
#     -> [build-parcel-tiles.mjs]  parcels.geojsons + parcels-labels.geojsons
#     -> [tippecanoe]       parcels.pmtiles
#
# Why newline-delimited (GeoJSONSeq) and not one big FeatureCollection:
# 438,061 features at full coordinate precision is several hundred MB. As a
# single JSON document that is a ~4 GB heap in Node just to parse. One
# feature per line streams flat, and tippecanoe reads the same format
# natively, so nothing downstream ever holds the province in memory.
#
# Why gdal_utils("vectortranslate") and not st_read + st_write: this is a
# pure format conversion. Routing it through GDAL keeps the whole 438k-row
# table out of R's memory and takes well under a minute, where reading it
# into an sf object first costs ~10 minutes and several GB (see
# build_rollentry_snapshot.R, which does need the features in memory
# because it simplifies them).
#
# NOTE this deliberately does NOT simplify. build_rollentry_snapshot.R
# runs a 10 m Douglas-Peucker pass because its output is shipped to the
# browser as-is; here tippecanoe does per-zoom simplification itself
# (--simplification=2), and pre-simplifying would throw away detail it
# could otherwise keep at z18.
#
# Usage:
#   Rscript r/export_rollentry_geojson.R [path/to/RollEntry_YYYYMMDD.gpkg]
# With no argument the newest RollEntry_*.gpkg in the repo root is used.

suppressPackageStartupMessages(library(sf))

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

args <- commandArgs(trailingOnly = TRUE)

# The fields the webapp consumes, matching PARCEL_OUTFIELDS in
# web/src/arcgis.js and the WEBAPP_FIELDS list in
# build_rollentry_snapshot.R. Keeping the tile archive's property set
# identical to the snapshot shard's is what lets the PMTiles source be a
# drop-in for the GeoJSON one — a field present in one and not the other
# would show up as a popup that renders differently depending on which
# path served the parcel.
#
# Asmt_Rpt_Url is carried despite being the single largest field (a ~140
# character URL on every one of 438k rows). It holds MAO's extrct_prop_id
# and roll_id, which are NOT derivable from the roll number, and the
# overlay popup's "assessment report" link has no other source for
# parcels outside the historical-lineage URL map. It does go stale: MAO
# reissues every extrct_prop_id on its Spring/Fall rollover, so this
# archive is exactly as stale as the snapshot shards already are, and
# should be rebuilt on the same cadence.
WEBAPP_FIELDS <- c(
  "OBJECTID", "Roll_No_Txt", "Property_Address", "Municipality",
  "Muni_Name_With_Typ", "Asmt_Roll", "Dwelling_Units",
  "Frontage_or_Area", "Total_Value", "Asmt_Rpt_Url"
)

src <- if (length(args) >= 1) args[[1]] else {
  cands <- list.files(mb_parcelsearch_root, pattern = "^RollEntry_\\d{8}\\.gpkg$",
                      full.names = TRUE)
  if (length(cands) == 0) {
    stop("No RollEntry_*.gpkg found in ", mb_parcelsearch_root,
         " — run r/download_parcels.R first, or pass a path.")
  }
  sort(cands, decreasing = TRUE)[[1]]
}
if (!file.exists(src)) stop("Source not found: ", src)

# The snapshot date rides through to the tile archive's meta sidecar, so
# the app's data-status dialog can say how old the fabric is.
snapshot_date <- sub("^RollEntry_(\\d{4})(\\d{2})(\\d{2})\\.gpkg$", "\\1-\\2-\\3",
                     basename(src))
if (!grepl("^\\d{4}-\\d{2}-\\d{2}$", snapshot_date)) snapshot_date <- NA_character_

out_dir <- file.path(mb_parcelsearch_root, "web", "public", "tiles-build")
dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
out_path <- file.path(out_dir, "rollentry.geojsons")

layer <- sf::st_layers(src)$name[[1]]
cat(sprintf("Source : %s (layer %s)\n", basename(src), layer))
cat(sprintf("Output : %s\n", out_path))

if (file.exists(out_path)) unlink(out_path)

# -select keeps the geometry column implicitly; only attributes are named.
# -t_srs EPSG:4326 is a no-op for a WGS84 source but makes the contract
# explicit — tippecanoe assumes lon/lat and silently produces garbage tiles
# if handed anything else.
started <- Sys.time()
sf::gdal_utils(
  util = "vectortranslate",
  source = src,
  destination = out_path,
  options = c(
    "-f", "GeoJSONSeq",
    "-select", paste(WEBAPP_FIELDS, collapse = ","),
    "-t_srs", "EPSG:4326",
    "-lco", "RS=NO",
    "-lco", "COORDINATE_PRECISION=7"
  )
)
elapsed <- round(as.numeric(difftime(Sys.time(), started, units = "secs")))

if (!file.exists(out_path)) stop("vectortranslate produced no output.")

# Line count is the feature count — that is the whole point of the format,
# and the Node step reconciles against this number so a truncated export
# cannot quietly become the province's parcel fabric.
n <- length(readLines(out_path, warn = FALSE))
size_mb <- round(file.size(out_path) / 1024^2, 1)
cat(sprintf("Wrote  : %s features, %s MB, %ss\n", format(n, big.mark = ","), size_mb, elapsed))

meta_path <- file.path(out_dir, "export-meta.json")
writeLines(jsonlite::toJSON(list(
  source_file   = basename(src),
  snapshot_date = snapshot_date,
  layer         = layer,
  features      = n,
  fields        = WEBAPP_FIELDS,
  exported_at   = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")
), auto_unbox = TRUE, pretty = TRUE), meta_path)
cat(sprintf("Meta   : %s\n", meta_path))
