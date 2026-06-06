# build_historical_shards.R
#
# Processes the dated provincial snapshots in the MAOSnapshots archive
# into per-muni GeoJSON shards for the webapp's HISTORICAL ("as-of-year")
# compare view. For each year it shards three layers — parcels, zoning,
# dev-plan — keyed by muni number, plus a manifest carrying each layer's
# own snapshot date.
#
#   source : D:/Dropbox/Appraisal/Web/MAOSnapshots/<year>/
#              MBRollGeoPackage<YYYYMMDD>.gpkg                 (parcels)
#              Manitoba_Zoning_By_Laws<YYYYMMDD>.geojson       (zoning)
#              Manitoba_Development_Plan_Designations<YYYYMMDD>.geojson (dev-plan)
#   output : <OUTPUT_ROOT>/<year>/
#              manifest.json
#              parcels/<muni_no>.json   zoning/<muni_no>.json   devplan/<muni_no>.json
#
# The output tree is destined for a SEPARATE public repo (mb-parcel-history)
# served via the jsDelivr CDN, so it stays out of the main repo + Vercel
# deploy. Hosting-agnostic: this script just writes files.
#
# Muni key: the muni NUMBER, the one field common to all three layers
# (parcels carry it as the integer prefix of `Municipality`,
# "163 - RM OF ..."; zoning/dev-plan carry `MUNI_NO` directly). Using the
# number sidesteps the name-spelling drift between the three provincial
# layers.
#
# MUNICIPAL CHANGE OVER TIME (amalgamation / annexation) — design + TODO:
# The webapp navigates by TODAY's municipalities, so historical data must
# be findable under today's muni even if it sat in a different muni back
# then. Two halves:
#   (1) Historical TRUTH is already preserved — every feature keeps its
#       own Municipality / Muni_Name_With_Typ / Roll_No_Txt as of its
#       snapshot, shown in the historical tooltip/banner. (done)
#   (2) Navigation by CURRENT geography — for years that span a
#       reorganization, re-bin each feature to the CURRENT muni boundary
#       it physically falls within (a spatial join to the live
#       MUNICIPALITY layer, the same fetch build_parcel_masc.R uses),
#       and key the shard by that CURRENT muni number. (TODO — add when
#       the first pre-2015 / post-amalgamation snapshot is archived, so
#       it can be built and tested against real reorganized data.)
# For all post-2015 snapshots (incl. the current 2025/2026) the muni
# structure is unchanged, so the muni_no below already equals the current
# muni — re-binning is a no-op and the shards are correct as-is.
#
# Geometry: reprojected to EPSG:4326 (GeoJSON / what the webapp renders)
# and Douglas-Peucker simplified (~10 m) to keep shards small for the CDN.
#
# Usage:
#   Rscript r/build_historical_shards.R                 # all years in the archive
#   Rscript r/build_historical_shards.R --year 2026     # one year
#   Rscript r/build_historical_shards.R --year 2026 --muni 168   # one muni (fast test)
#
# Runtime: ~10-15 min/year for the full province (parcels dominate).

suppressPackageStartupMessages({
  library(sf)
  library(dplyr)
  library(jsonlite)
})
sf::sf_use_s2(FALSE)   # GEOS — permissive simplify, same rationale as build_rollentry_snapshot.R

ARCHIVE_ROOT <- "D:/Dropbox/Appraisal/Web/MAOSnapshots"
OUTPUT_ROOT  <- "D:/Dropbox/ClaudeCode/MBOpenData/mb-parcel-history"
SIMPLIFY_TOLERANCE_DEG <- 0.00015   # ~10-17 m at MB latitudes

# Fields kept per layer (what the webapp actually displays). Parcels mirror
# PARCEL_OUTFIELDS minus OBJECTID (MBRollGeoPackage has no OBJECTID — we
# synthesize a row id). Zoning / dev-plan mirror the fields the live
# overlays render.
PARCEL_FIELDS  <- c("Roll_No_Txt", "Property_Address", "Municipality",
                    "Muni_Name_With_Typ", "Asmt_Roll", "Dwelling_Units",
                    "Frontage_or_Area", "Total_Value", "Asmt_Rpt_Url")
ZONING_FIELDS  <- c("ZONE", "ZONE_NAME", "ZONE_CATEGORY", "ZBL", "ZBL_A",
                    "AMENDMENT_DESCRIPTION", "MUNI_NO", "MUNI_NAME")
DEVPLAN_FIELDS <- c("DES_NAME", "DES_CATEGORY", "DP_BYLAW", "DPA_BYLAW",
                    "PLANNINGDISTRICT", "MUNI_NO", "MUNI_NAME")

# ---- args ------------------------------------------------------------
args      <- commandArgs(trailingOnly = TRUE)
arg_val   <- function(flag) { i <- match(flag, args); if (is.na(i) || i == length(args)) NA_character_ else args[i + 1] }
only_year  <- arg_val("--year")
only_muni  <- suppressWarnings(as.integer(arg_val("--muni")))
index_only <- "--index-only" %in% args   # just (re)write the root discovery index

# ---- helpers ---------------------------------------------------------
date_from_name <- function(path) {
  m <- regmatches(basename(path), regexpr("\\d{8}", basename(path)))
  if (length(m) == 0) return(NA_character_)
  paste0(substr(m,1,4), "-", substr(m,5,6), "-", substr(m,7,8))
}

# pick the newest file in `dir` matching `pattern` (by the date in its name)
latest_match <- function(dir, pattern) {
  f <- list.files(dir, pattern = pattern, full.names = TRUE)
  if (length(f) == 0) return(NA_character_)
  tail(f[order(regmatches(basename(f), regexpr("\\d{8}", basename(f))))], 1)
}

to_wgs84_simplify <- function(g) {
  if (is.na(sf::st_crs(g)) ) sf::st_crs(g) <- 4326
  if (sf::st_crs(g)$epsg %||% 0 != 4326) g <- sf::st_transform(g, 4326)
  # suppressWarnings: sf nags that DP simplify on lon/lat isn't metric-exact;
  # fine for visual rendering at webapp zooms (same call build_rollentry_snapshot.R uses).
  sf::st_geometry(g) <- sf::st_make_valid(suppressWarnings(sf::st_simplify(
    sf::st_geometry(g), dTolerance = SIMPLIFY_TOLERANCE_DEG, preserveTopology = TRUE)))
  g <- g[!sf::st_is_empty(g), ]
  g
}
`%||%` <- function(a, b) if (is.null(a) || is.na(a)) b else a

write_shards <- function(g, muni_col, out_dir, keep_fields) {
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  g <- g[!is.na(g[[muni_col]]), ]
  counts <- list()
  for (mn in sort(unique(g[[muni_col]]))) {
    if (!is.na(only_muni) && mn != only_muni) next
    shard <- g[g[[muni_col]] == mn, c(keep_fields, attr(g, "sf_column"))]
    fp <- file.path(out_dir, paste0(mn, ".json"))
    if (file.exists(fp)) file.remove(fp)
    sf::st_write(shard, fp, driver = "GeoJSON",
                 layer_options = c("COORDINATE_PRECISION=6", "RFC7946=YES"),
                 quiet = TRUE)
    counts[[as.character(mn)]] <- nrow(shard)
  }
  counts
}

# Root discovery index — the SINGLE file the webapp fetches to learn which
# years exist (and each year's layer dates), so adding a year needs NO app
# code change: regenerate, push, and the app picks it up. Scans the output
# tree so it's always consistent with what's actually published.
write_root_index <- function() {
  yrs <- sort(basename(list.dirs(OUTPUT_ROOT, recursive = FALSE)))
  yrs <- yrs[grepl("^\\d{4}$", yrs)]
  out <- list()
  for (y in yrs) {
    mf <- file.path(OUTPUT_ROOT, y, "manifest.json")
    if (!file.exists(mf)) next
    m <- jsonlite::read_json(mf)
    out[[y]] <- list(layers = m$layers, muni_count = length(m$munis))
  }
  idx <- list(
    dataset    = "mb-parcel-history",
    schema     = 1,
    generated  = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
    cdn        = "https://cdn.jsdelivr.net/gh/jayschellenberg/mb-parcel-history@main",
    years      = out
  )
  dir.create(OUTPUT_ROOT, showWarnings = FALSE, recursive = TRUE)
  jsonlite::write_json(idx, file.path(OUTPUT_ROOT, "index.json"),
                       auto_unbox = TRUE, pretty = TRUE)
  cat("Wrote root index.json — years:", paste(yrs, collapse = ", "), "\n")
}

# ---- per-year processing --------------------------------------------
process_year <- function(year) {
  ydir <- file.path(ARCHIVE_ROOT, year)
  parcel_f  <- latest_match(ydir, "^MBRollGeoPackage\\d{8}\\.gpkg$")
  zoning_f  <- latest_match(ydir, "^Manitoba_Zoning_By_?[Ll]aws\\d{8}\\.geojson$")
  devplan_f <- latest_match(ydir, "^Manitoba_Development_Plan_Designations\\d{8}\\.geojson$")

  cat("\n=== Year", year, "===\n")
  cat("  parcels :", if (is.na(parcel_f)) "(none)" else basename(parcel_f), "\n")
  cat("  zoning  :", if (is.na(zoning_f)) "(none)" else basename(zoning_f), "\n")
  cat("  devplan :", if (is.na(devplan_f)) "(none)" else basename(devplan_f), "\n")
  if (is.na(parcel_f)) { cat("  no parcel layer — skipping year\n"); return(invisible()) }

  out_year <- file.path(OUTPUT_ROOT, year)
  layers <- list()

  # --- parcels (MBRollGeoPackage) ---
  lyr <- sf::st_layers(parcel_f)$name[1]
  cat("  reading parcels (layer", lyr, ") ...\n")
  p <- sf::st_read(parcel_f, layer = lyr, quiet = TRUE)
  names(p)[names(p) == attr(p, "sf_column")] <- "geometry"; sf::st_geometry(p) <- "geometry"
  p$muni_no <- suppressWarnings(as.integer(sub("\\s*-.*$", "", p$Municipality)))
  p <- p[!is.na(p$muni_no) & !is.na(p$Muni_Name_With_Typ) & nzchar(p$Muni_Name_With_Typ), ]
  if (!is.na(only_muni)) p <- p[p$muni_no == only_muni, ]   # fast-test path
  keepP <- intersect(PARCEL_FIELDS, names(p))
  p <- p[, c(keepP, "muni_no", "geometry")]
  cat("    simplifying", nrow(p), "parcels ...\n")
  p <- to_wgs84_simplify(p)
  pc <- write_shards(p, "muni_no", file.path(out_year, "parcels"), keepP)
  layers$parcels <- list(date = date_from_name(parcel_f), munis = length(pc),
                         features = sum(unlist(pc)))
  # muni_no -> name map (for the manifest / frontend selector)
  muni_names <- p |> sf::st_drop_geometry() |> dplyr::distinct(muni_no, Muni_Name_With_Typ)

  # --- zoning ---
  if (!is.na(zoning_f)) {
    cat("  reading zoning ...\n")
    z <- sf::st_read(zoning_f, quiet = TRUE)
    z$MUNI_NO <- suppressWarnings(as.integer(z$MUNI_NO))
    if (!is.na(only_muni)) z <- z[!is.na(z$MUNI_NO) & z$MUNI_NO == only_muni, ]
    keepZ <- intersect(ZONING_FIELDS, names(z))
    z <- z[, c(keepZ, attr(z, "sf_column"))]
    z <- to_wgs84_simplify(z)
    zc <- write_shards(z, "MUNI_NO", file.path(out_year, "zoning"), setdiff(keepZ, "MUNI_NO"))
    layers$zoning <- list(date = date_from_name(zoning_f), munis = length(zc),
                          features = sum(unlist(zc)))
  }

  # --- dev plan ---
  if (!is.na(devplan_f)) {
    cat("  reading dev-plan ...\n")
    d <- sf::st_read(devplan_f, quiet = TRUE)
    d$MUNI_NO <- suppressWarnings(as.integer(d$MUNI_NO))
    if (!is.na(only_muni)) d <- d[!is.na(d$MUNI_NO) & d$MUNI_NO == only_muni, ]
    keepD <- intersect(DEVPLAN_FIELDS, names(d))
    d <- d[, c(keepD, attr(d, "sf_column"))]
    d <- to_wgs84_simplify(d)
    dc <- write_shards(d, "MUNI_NO", file.path(out_year, "devplan"), setdiff(keepD, "MUNI_NO"))
    layers$devplan <- list(date = date_from_name(devplan_f), munis = length(dc),
                           features = sum(unlist(dc)))
  }

  # --- manifest ---
  munis <- setNames(
    lapply(seq_len(nrow(muni_names)), function(i) {
      mn <- muni_names$muni_no[i]
      list(name = muni_names$Muni_Name_With_Typ[i],
           parcels = pc[[as.character(mn)]] %||% 0L)
    }),
    muni_names$muni_no
  )
  manifest <- list(year = as.integer(year), layers = layers, munis = munis)
  dir.create(out_year, showWarnings = FALSE, recursive = TRUE)
  jsonlite::write_json(manifest, file.path(out_year, "manifest.json"),
                       auto_unbox = TRUE, pretty = TRUE)

  sz <- sum(file.info(list.files(out_year, recursive = TRUE, full.names = TRUE))$size, na.rm = TRUE)
  cat(sprintf("  -> wrote %s  (%.1f MB)\n", out_year, sz/1024/1024))
}

# ---- main ------------------------------------------------------------
if (index_only) {
  cat("MAO historical shard build — index-only\n")
  write_root_index()
  cat("\nDone.\n")
} else {
  years <- if (!is.na(only_year)) only_year else
    basename(list.dirs(ARCHIVE_ROOT, recursive = FALSE))
  years <- years[grepl("^\\d{4}$", years)]
  cat("MAO historical shard build\n  archive:", ARCHIVE_ROOT, "\n  output :", OUTPUT_ROOT, "\n")
  cat("  years  :", paste(years, collapse = ", "),
      if (!is.na(only_muni)) paste0("  (muni ", only_muni, " only)") else "", "\n")
  for (y in years) process_year(y)
  write_root_index()   # keep the discovery index in lockstep with the shards
  cat("\nDone.\n")
}
