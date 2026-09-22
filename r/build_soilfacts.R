# build_soilfacts.R
#
# Pre-bakes the parcel x Manitoba Soil Survey overlap that the frontend
# otherwise computes at render time, so the CLI / Soil Type / Slope columns
# and the soil popups fill from a lookup instead of a geometric clip.
#
# WHY
# ---
# The clip is the one cost that could not be tuned away. Measured 2026-09-22
# against the live app: ~30 ms per parcel, dominated by clipping small
# parcels against high-vertex soil polygons (53 ms/call at >=2,000 vertices,
# 36% of calls). A 1,141-sale run over Macdonald and its neighbours spent
# ~34 s there. Finer tiling was 20% slower, simplifying the soil bought 1.28x
# for real error, and the spatial index was already fine at 3.4 candidates
# per parcel — so the work does not get cheaper, it has to happen earlier.
#
# WHAT THIS STORES, AND WHAT IT DELIBERATELY DOES NOT
# ---------------------------------------------------
# Per parcel, the OVERLAP RATIOS only:
#
#   "100.000": [[29049, 0.6350], [29112, 0.3650]]     soil OBJECTID, share
#
# plus one per-municipality dictionary of the matched polygons' ATTRIBUTES
# (no geometry), keyed by that OBJECTID.
#
# It does NOT store the composition rows, the "Other mapped soils"
# remainder, or the CLI class rollup — even though those are what the UI
# shows. Those rules live in web/src/soilSurvey.js
# (soilSurveyComponentsFromMatches: EXTENT normalisation, component keying,
# the top-3 cap) and web/src/lib/cliRollup.js, and re-implementing them here
# would be two copies of one contract, drifting the moment either side is
# touched. The expensive half is the geometry; the rollup is arithmetic over
# three to ten rows and costs nothing at render time. So this ships the
# geometry and the frontend keeps running its own rules over it — the same
# code path that serves a parcel with no shard.
#
# That is also what makes the shard verifiable: the live join and the shard
# must produce identical compositions, because they reach the same function
# with the same numbers.
#
# SCOPE
# -----
# Rural parcels at or above MIN_ACRES, which is where soil is the question
# being asked. A parcel with no shard entry falls back to the live scoped
# fetch + join, so the hybrid degrades quietly rather than showing blanks.
# Unlike landfacts this does NOT require a MASC rating: river lots carry no
# quarter-section rating but do sit on mapped soil.
#
# OUTPUT
# ------
#   mb-parcel-data/soilfacts/<MUNI_SLUG>.json
#     { "_meta": { built, source, parcels, polygons, min_acres },
#       "soils": { "<OBJECTID>": { n1,c1,e1,a1,g1,t1, n2,..., n3,... } },
#       "rolls": { "<Roll_No_Txt>": [[oid, ratio], ...] } }
#
# Slug matches the other shard sets: Muni_Name_With_Typ with non-alphanumerics
# collapsed to "_" (PINEY (RM) -> PINEY_RM), NOT Municipality.
#
# Run:  Rscript r/build_soilfacts.R [MUNI_NAME_WITH_TYP ...]
#       with no arguments, every municipality.

suppressPackageStartupMessages({
  library(sf); library(dplyr); library(arrow); library(jsonlite); library(httr)
})

script_dir <- tryCatch({
  a <- commandArgs(trailingOnly = FALSE)
  dirname(normalizePath(sub("^--file=", "", a[grep("^--file=", a)])))
}, error = function(e) "r")
source(file.path(script_dir, "config.R"))

MIN_ACRES  <- 20
# Equal-area, because these ratios are areas. EPSG:3979 is CONFORMAL and
# loses 0.07 ac in southern Manitoba and 3.45 ac at Easterville — small, but
# this is the denominator of every percentage the UI prints.
ALBERS     <- "ESRI:102001"
SOIL_URL   <- paste0("https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/",
                     "services/Soil_Survey_MB/FeatureServer/0/query")
# The slots the rollup actually reads. Kept in step with CLI_AGR_CAP_OUTFIELDS
# in web/src/arcgis.js — a field added there and not here shows up as a blank
# line in the popup for shard-served parcels only.
SOIL_FIELDS <- c(
  "OBJECTID", "MAPUNITNOM",
  paste0(rep(c("SOILNAME", "SOIL_CODE", "EXTENT", "SURFTEXT", "AGCAP_CLS", "AGRI_CAP"), each = 3),
         rep(1:3, times = 6))
)

out_dir <- file.path(mb_parcel_data_root, "soilfacts")
dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
cache_dir <- file.path(mb_parcelsearch_root, "build-cache", "soilfacts")
dir.create(cache_dir, showWarnings = FALSE, recursive = TRUE)

slug_of <- function(x) toupper(gsub("_+$", "", gsub("[^A-Za-z0-9]+", "_", x)))

# --- soil polygons for one municipality -----------------------------------
#
# Fetched per municipality rather than province-wide (116,767 polygons) so
# peak memory stays bounded and a rerun resumes. Cached as GeoPackage: the
# survey is static between revisions, so a rebuild after a parcel refresh
# re-downloads nothing.
soil_for_extent <- function(bb, key) {
  cache <- file.path(cache_dir, paste0(key, ".gpkg"))
  if (file.exists(cache)) return(sf::st_read(cache, quiet = TRUE))

  env <- sprintf("%.6f,%.6f,%.6f,%.6f", bb["xmin"], bb["ymin"], bb["xmax"], bb["ymax"])
  ids <- httr::POST(SOIL_URL, body = list(
    where = "1=1", geometry = env, geometryType = "esriGeometryEnvelope",
    inSR = "4326", spatialRel = "esriSpatialRelIntersects",
    returnIdsOnly = "true", returnGeometry = "false", f = "json"
  ), encode = "form") |> httr::content(as = "text", encoding = "UTF-8") |>
    jsonlite::fromJSON()
  oids <- ids$objectIds
  if (is.null(oids) || !length(oids)) return(NULL)

  parts <- list()
  for (i in seq(1, length(oids), by = 500)) {
    chunk <- oids[i:min(i + 499, length(oids))]
    txt <- httr::POST(SOIL_URL, body = list(
      where = "1=1", objectIds = paste(chunk, collapse = ","),
      outFields = paste(SOIL_FIELDS, collapse = ","),
      returnGeometry = "true", outSR = "4326", f = "geojson"
    ), encode = "form") |> httr::content(as = "text", encoding = "UTF-8")
    g <- tryCatch(sf::st_read(txt, quiet = TRUE), error = function(e) NULL)
    if (!is.null(g) && nrow(g)) parts[[length(parts) + 1]] <- g
  }
  if (!length(parts)) return(NULL)
  soil <- do.call(rbind, parts)
  # Written to cache before any repair so the cache mirrors the source.
  sf::st_write(soil, cache, quiet = TRUE, delete_dsn = TRUE)
  soil
}

# --- parcels ---------------------------------------------------------------
assembly_dir <- file.path(mao_assembly_root, "results")
pq_files <- list.files(assembly_dir, pattern = "^MAOParcelOutputAg\\d{8}\\.parquet$",
                       full.names = TRUE)
if (!length(pq_files)) stop("No MAOParcelOutputAg<YYYYMMDD>.parquet in ", assembly_dir)
pq_path <- tail(sort(pq_files), 1L)
cat("Reading parcels:", basename(pq_path), "\n")

pq <- arrow::open_dataset(pq_path) |>
  dplyr::select(TaxID, MuniCode, Municipality, CalcAcres, geometry_wkt) |>
  dplyr::filter(!is.na(CalcAcres), CalcAcres >= MIN_ACRES) |>
  dplyr::collect() |>
  dplyr::filter(!is.na(geometry_wkt), nzchar(geometry_wkt)) |>
  dplyr::mutate(roll_num = suppressWarnings(as.numeric(TaxID)),
                Roll_No_Txt = sprintf("%.3f", roll_num),
                MuniCode = suppressWarnings(as.integer(MuniCode))) |>
  dplyr::filter(!is.na(MuniCode), !is.na(roll_num))
cat(sprintf("  parcels >= %d ac: %s\n", MIN_ACRES, format(nrow(pq), big.mark = ",")))

roll_files <- list.files(mb_parcelsearch_root, pattern = "^RollEntry_\\d{8}\\.gpkg$",
                         full.names = TRUE)
if (!length(roll_files)) stop("No RollEntry_YYYYMMDD.gpkg in ", mb_parcelsearch_root)
muni_map <- sf::st_read(tail(sort(roll_files), 1L),
                        query = 'SELECT DISTINCT "Municipality", "Muni_Name_With_Typ" FROM "roll_entry"',
                        quiet = TRUE) |>
  dplyr::mutate(MuniCode = suppressWarnings(as.integer(sub("\\s*-.*$", "", Municipality)))) |>
  dplyr::filter(!is.na(MuniCode), nzchar(Muni_Name_With_Typ)) |>
  dplyr::distinct(MuniCode, Muni_Name_With_Typ)

pq <- dplyr::inner_join(pq, muni_map, by = "MuniCode")

wanted <- commandArgs(trailingOnly = TRUE)
munis <- sort(unique(pq$Muni_Name_With_Typ))
if (length(wanted)) munis <- munis[munis %in% wanted]
cat(sprintf("Municipalities to build: %d\n\n", length(munis)))

# --- per-municipality build ------------------------------------------------
for (muni in munis) {
  t0 <- Sys.time()
  rows <- dplyr::filter(pq, Muni_Name_With_Typ == muni)
  parcels <- sf::st_as_sf(rows, wkt = "geometry_wkt", crs = 4326)
  parcels <- parcels[!sf::st_is_empty(parcels), ]
  if (!nrow(parcels)) { cat(sprintf("%-28s no parcels\n", muni)); next }

  bb <- sf::st_bbox(parcels)
  soil <- tryCatch(soil_for_extent(bb, slug_of(muni)), error = function(e) {
    cat(sprintf("%-28s soil fetch failed: %s\n", muni, conditionMessage(e))); NULL
  })
  if (is.null(soil) || !nrow(soil)) { cat(sprintf("%-28s no soil coverage\n", muni)); next }

  # Repair before any predicate: the survey carries self-intersections, and
  # river-lot parcels are rejected unrepaired (see the s2 note in the
  # mb-parcel-data README).
  parcels <- sf::st_make_valid(parcels)
  soil    <- sf::st_make_valid(soil)

  pa <- sf::st_transform(parcels, ALBERS)
  so <- sf::st_transform(soil, ALBERS)
  pa$.area <- as.numeric(sf::st_area(pa))
  pa <- pa[pa$.area > 0, ]

  # Big layer FIRST: sf prepares argument one, and putting the larger layer
  # there measured 34.7x faster on the parcel joins in this repo with
  # identical results.
  hits <- sf::st_intersects(so, pa)

  acc <- vector("list", nrow(pa))
  for (si in seq_along(hits)) {
    pis <- hits[[si]]
    if (!length(pis)) next
    inter <- tryCatch(
      sf::st_intersection(sf::st_geometry(pa)[pis], sf::st_geometry(so)[si]),
      error = function(e) NULL)
    if (is.null(inter) || !length(inter)) next
    a <- as.numeric(sf::st_area(inter))
    for (k in seq_along(pis)) {
      if (!is.finite(a[k]) || a[k] <= 0) next
      ratio <- min(1, a[k] / pa$.area[pis[k]])
      if (ratio <= 0) next
      acc[[pis[k]]] <- rbind(acc[[pis[k]]],
                             data.frame(oid = so$OBJECTID[si], r = ratio))
    }
  }

  rolls <- list(); used <- integer(0)
  for (i in seq_len(nrow(pa))) {
    d <- acc[[i]]
    if (is.null(d) || !nrow(d)) next
    d <- d[order(-d$r), , drop = FALSE]
    rolls[[pa$Roll_No_Txt[i]]] <- lapply(seq_len(nrow(d)), function(k)
      list(d$oid[k], round(d$r[k], 6)))
    used <- union(used, d$oid)
  }
  if (!length(rolls)) { cat(sprintf("%-28s no overlaps\n", muni)); next }

  sd <- sf::st_drop_geometry(soil[match(used, soil$OBJECTID), , drop = FALSE])
  soils <- setNames(lapply(seq_len(nrow(sd)), function(i) {
    one <- function(p) { v <- sd[[p]][i]; if (is.na(v) || !nzchar(as.character(v))) NULL else as.character(v) }
    num <- function(p) { v <- suppressWarnings(as.numeric(sd[[p]][i])); if (is.na(v)) NULL else v }
    out <- list(u = one("MAPUNITNOM"))
    for (s in 1:3) {
      out[[paste0("n", s)]] <- one(paste0("SOILNAME", s))
      out[[paste0("c", s)]] <- one(paste0("SOIL_CODE", s))
      out[[paste0("e", s)]] <- num(paste0("EXTENT", s))
      out[[paste0("t", s)]] <- one(paste0("SURFTEXT", s))
      out[[paste0("g", s)]] <- one(paste0("AGCAP_CLS", s))
      out[[paste0("a", s)]] <- one(paste0("AGRI_CAP", s))
    }
    Filter(Negate(is.null), out)
  }), as.character(sd$OBJECTID))

  payload <- list(
    # `muni` is the Muni_Name_With_Typ this shard is for. Carried so the
    # index can be rebuilt from the files on disk without reversing the slug
    # — PINEY_RM could be "PINEY (RM)" or "PINEY (R.M.)", and guessing wrong
    # makes every parcel in that municipality read as having no soil.
    `_meta` = list(built = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
                   muni = muni,
                   source = basename(pq_path), min_acres = MIN_ACRES,
                   parcels = length(rolls), polygons = length(soils)),
    soils = soils, rolls = rolls)

  # Temp + rename: an in-place overwrite under D:\Dropbox\ClaudeCode can
  # report success and change nothing.
  dest <- file.path(out_dir, paste0(slug_of(muni), ".json"))
  tmp  <- paste0(dest, ".tmp")
  writeLines(jsonlite::toJSON(payload, auto_unbox = TRUE, null = "null", digits = 6), tmp)
  if (file.exists(dest)) file.remove(dest)
  file.rename(tmp, dest)
  cat(sprintf("%-28s %5d parcels  %5d polygons  %6.1f KB  %4.1fs\n",
              muni, length(rolls), length(soils),
              file.size(dest) / 1024,
              as.numeric(difftime(Sys.time(), t0, units = "secs"))))
}

# --- index ----------------------------------------------------------------
#
# Same shape the other shard sets publish: Muni_Name_With_Typ -> { file,
# count }. The frontend resolves through this rather than deriving the
# filename from the municipality name, because a slug that is a near-miss
# (PINEY (RM) -> PINEY_RM) fails silently as "this parcel has no soil"
# rather than as an error.
#
# Rebuilt from what is actually on disk, so a partial run (or a rerun of one
# municipality) leaves an index that matches the shards beside it rather than
# one that promises files that were never written.
index_path <- file.path(out_dir, "_index.json")
shard_files <- list.files(out_dir, pattern = "[.]json$", full.names = TRUE)
shard_files <- shard_files[basename(shard_files) != "_index.json"]
idx <- list()
for (f in shard_files) {
  d <- tryCatch(jsonlite::fromJSON(f, simplifyVector = FALSE), error = function(e) NULL)
  if (is.null(d) || is.null(d$rolls)) next
  nm <- d$`_meta`$muni
  if (is.null(nm) || !nzchar(nm)) next
  idx[[nm]] <- list(file = basename(f), count = length(d$rolls))
}
if (length(idx)) {
  tmp <- paste0(index_path, ".tmp")
  writeLines(jsonlite::toJSON(idx, auto_unbox = TRUE), tmp)
  if (file.exists(index_path)) file.remove(index_path)
  file.rename(tmp, index_path)
  cat(sprintf("\nIndex: %d municipalities -> %s\n", length(idx), basename(index_path)))
} else {
  cat("\nIndex: nothing to write.\n")
}

cat("\nDone.\n")
