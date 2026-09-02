# build_landfacts.R
#
# Pre-bakes, for every farmland-scale parcel, the open-data land facts that
# rural-report computes one parcel at a time — so the frontend can show crop
# history, relief, mapped wetland and surface water in the popup and grid
# without any raster work at render time.
#
# WHAT THIS IS
# ------------
# Per parcel, from four federal rasters:
#
#   crop history  AAFC Annual Crop Inventory, every year 2009-2025 (30 m;
#                 56 m in 2009-2010). Per year: the dominant class code and
#                 the share of the parcel under annual crop.
#   relief        NRCan MRDEM-30: elevation range and area-weighted mean slope.
#   wetland       Canadian Wetland Inventory Map v3A (DUC/NRCan, 10 m): share
#                 of the parcel mapped as wetland, and which classes.
#   water         JRC Global Surface Water 1984-2021 (30 m): share of the
#                 parcel where open water was detected in >=75% of
#                 observations (permanent) and in 5-75% (intermittent).
#
# WHY THE FULL YEARLY SERIES SHIPS, NOT A SUMMARY
# ----------------------------------------------
# Jason wanted the last year, or the last three, for day-to-day use, and the
# longer history for retrospective work. Shipping the per-year arrays gives
# both: the client derives "last year", "last three", "years cropped" and a
# 17-letter cover string from the same 17 numbers. Measured cost is ~200
# bytes per parcel, ~35 MB across all shards — the same order as parcel-masc,
# so pre-summarising would save nothing that matters.
#
# A year the inventory did not observe (raster background or cloud over more
# than half the parcel) is null, never zero. Zero would read as "nothing
# grew"; null reads as "not seen", which is the truth. See the
# `aci-nodata-is-not-cover` note in rural-report.
#
# WHICH PARCELS
# -------------
# CalcAcres >= MIN_ACRES (20) AND a MASC rating. Measured on the 2026-08-20
# Parquet: 174,997 parcels clear 20 ac and 173,697 of those carry a MASC
# rating; the rating is what says "this is agricultural land", the acreage
# just trims hobby blocks. At 20 ac a 30 m cell is ~1% of the parcel, so
# every layer clears the 5%-precision floor rural-report enforces on small
# parcels, and no cell-count caveats are needed in these shards.
#
# The threshold and the MASC requirement are recorded in the manifest's
# `_meta` so the app can gate display on the same rule. KEEP IN SYNC with
# LANDFACTS_MIN_ACRES in web/src/lib/landfacts.js.
#
# INPUTS
#   <mao-assembly>/results/MAOParcelOutputAg<YYYYMMDD>.parquet
#       Newest COMPLETE assembly run (same partial-run guard as
#       build_landcover.R). Columns: TaxID, MuniCode, Municipality,
#       CalcAcres, MASCRating, geometry_wkt (WGS84).
#   <repo>/RollEntry_<YYYYMMDD>.gpkg
#       Only for the stable MuniCode -> Muni_Name_With_Typ map, exactly as
#       build_landcover.R uses it.
#   <rural-report>/R/extract_parcel.R
#       Raster endpoints, the local ACI cache and the class legend. The
#       crop-inventory GeoTIFFs must already be cached there
#       (bash rural-report/fetch_aci.sh) — a remote read of those zips
#       costs up to 161 s per year per parcel-window and is not viable in
#       bulk. MRDEM, CWIM3A and GSW are plain COGs and are read remotely.
#
# OUTPUT
#   <mb-parcel-data>/landfacts/<MUNI_KEY>.json
#       Per-muni shard keyed by Roll_No_Txt (roll to 3 decimals, reconstructed
#       from the Parquet's own TaxID — see build_landcover.R for why):
#         { "69300.000": {
#             "cp":  [0,12,0,20,...],        crop % per year, null = unobserved
#             "dom": [110,110,110,122,...],  dominant ACI class code per year
#             "rel": 5.9, "slp": 0.63, "z": [345,351],
#             "wet": 0.19, "wc": "1",        wetland %, CWIM classes present
#             "gsw": 0.0,  "gsi": 0.0        permanent %, intermittent %
#           }, ... }
#   <mb-parcel-data>/landfacts/_index.json
#       { "<Muni_Name_With_Typ>": { file, count }, "_meta": {...} } — same
#       shape as flood/landcover so lookupMuniManifestEntry() resolves it.
#       `_meta` carries years, sources, thresholds and the ACI cache vintage.
#
# HOW IT RUNS
# -----------
# One municipality at a time: every raster is cropped ONCE to the muni's
# extent, then extracted against all its parcels in one exact_extract call.
# That is the difference between minutes and days — rural-report's
# per-parcel path reopens each raster per parcel.
#
# Resumable: a muni whose shard already exists is skipped unless --force,
# so an interrupted run picks up where it stopped. The index is rebuilt from
# whatever shards exist at the end of every run.
#
# Usage:
#   Rscript r/build_landfacts.R                   # all munis, skip done ones
#   Rscript r/build_landfacts.R --muni PINEY      # one muni (substring match)
#   Rscript r/build_landfacts.R --muni 610        # ... or by MuniCode
#   Rscript r/build_landfacts.R --force           # rebuild even if present
#   Rscript r/build_landfacts.R --limit 50        # first 50 parcels/muni (test)
#   Rscript r/build_landfacts.R --index-only      # rebuild _index.json only

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(sf)
  library(terra)
  library(jsonlite)
  library(stringi)
})

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

# rural-report's constants and cache paths are relative to its own root, so
# point its env overrides there before sourcing.
Sys.setenv(
  ACI_CACHE        = file.path(rural_report_root, "cache", "aci"),
  ACI_LEGEND_CACHE = file.path(rural_report_root, "cache", "aci-legend.csv")
)
source(file.path(rural_report_root, "R", "extract_parcel.R"))

`%||%` <- function(a, b) if (is.null(a) || length(a) == 0L || is.na(a[1])) b else a

# --- arguments -------------------------------------------------------------
args <- commandArgs(TRUE)
arg_val <- function(flag) { i <- match(flag, args); if (is.na(i) || i == length(args)) NULL else args[i + 1] }
ONLY_MUNI  <- arg_val("--muni")
LIMIT      <- as.integer(arg_val("--limit") %||% NA)
FORCE      <- "--force" %in% args
INDEX_ONLY <- "--index-only" %in% args

MIN_ACRES <- 20        # KEEP IN SYNC with LANDFACTS_MIN_ACRES in web/src/lib/landfacts.js
YEARS     <- 2009:2025
CROP_MIN_OBSERVED <- 0.5   # a year less than half observed is null, not data

source_dir   <- mb_parcelsearch_root
assembly_dir <- file.path(mao_assembly_root, "results")
output_dir   <- file.path(mb_parcel_data_root, "landfacts")
index_path   <- file.path(output_dir, "_index.json")
dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

# safe_filename is byte-identical to build_water.R / build_landcover.R /
# build_flood.R so every family's shard filenames line up.
safe_filename <- function(x) {
  x |>
    stringi::stri_trans_general(id = "Latin-ASCII") |>
    toupper() |>
    gsub(pattern = "[^A-Z0-9._-]+", replacement = "_") |>
    gsub(pattern = "_+",            replacement = "_") |>
    gsub(pattern = "^_|_$",         replacement = "")
}

# --- extraction engine ------------------------------------------------------
# exactextractr is 10-100x faster than terra::extract on a big feature set
# (mao-assembly's own measurement) and is what makes a whole-province run a
# matter of hours. Fall back to terra so the script still works without it.
HAVE_EXACT <- requireNamespace("exactextractr", quietly = TRUE)

# Crop a raster once to the extent of a parcel set (+ halo, metres in the
# raster's own CRS units where projected) and return it with the parcels
# transformed to match.
crop_to <- function(r, parcels, halo = 0.02) {
  v <- sf::st_transform(parcels, sf::st_crs(terra::crs(r)))
  e <- terra::ext(terra::vect(v))
  dx <- (e$xmax - e$xmin) * halo; dy <- (e$ymax - e$ymin) * halo
  e2 <- terra::ext(e$xmin - dx, e$xmax + dx, e$ymin - dy, e$ymax + dy)
  list(r = terra::crop(r, e2, snap = "out"), v = v)
}

# Per-feature weights for a categorical raster. Returns, per feature, the
# total coverage of the parcel (tot, EVERY touched cell including NoData) and a
# (value, w) table of the cells that carry a value.
#
# The denominator is the whole parcel on purpose. CWIM3A declares 15 as
# NoData, so terra hands "not wetland" cells over as NA; dividing by the
# valued cells alone made every parcel with any wetland read 100% wetland.
zonal_weights <- function(r, v) {
  if (HAVE_EXACT) {
    out <- exactextractr::exact_extract(r, v, progress = FALSE)
    lapply(out, function(d) {
      if (is.null(d) || !nrow(d)) return(NULL)
      tot <- sum(d$coverage_fraction)
      d <- d[!is.na(d$value), ]
      tab <- if (nrow(d)) {
        s <- tapply(d$coverage_fraction, d$value, sum)
        data.frame(value = as.numeric(names(s)), w = as.numeric(s))
      } else NULL
      list(tot = tot, tab = tab)
    })
  } else {
    x <- terra::extract(r, terra::vect(v), exact = TRUE, ID = TRUE)
    names(x)[2] <- "value"
    sp <- split(x, factor(x$ID, levels = seq_len(nrow(v))))
    lapply(sp, function(d) {
      if (!nrow(d)) return(NULL)
      tot <- sum(d$fraction)
      d <- d[!is.na(d$value), ]
      tab <- if (nrow(d)) {
        s <- tapply(d$fraction, d$value, sum)
        data.frame(value = as.numeric(names(s)), w = as.numeric(s))
      } else NULL
      list(tot = tot, tab = tab)
    })
  }
}

# --- per-layer summarisers ---------------------------------------------------
# Crop inventory, one year: per parcel -> list(cp = crop %, dom = code), or
# NULL when the year did not observe the parcel. 0 = background, 10 = cloud.
# Annual crops are codes 130-199; 200-230 are forest and must not count as
# crop even though they are numerically above 130.
crop_year <- function(rpath, parcels) {
  cr <- crop_to(terra::rast(rpath), parcels)
  ws <- zonal_weights(cr$r, cr$v)
  lapply(ws, function(z) {
    if (is.null(z) || is.null(z$tab)) return(NULL)
    d <- z$tab[!(z$tab$value %in% c(0, 10)), ]
    if (!nrow(d) || sum(d$w) / z$tot < CROP_MIN_OBSERVED) return(NULL)
    d$share <- d$w / sum(d$w)
    list(cp  = round(100 * sum(d$share[d$value >= 130 & d$value < 200])),
         dom = as.integer(d$value[which.max(d$share)]))
  })
}

# CWIM3A: wetland % of the parcel and the classes present (1 Bog 2 Fen
# 3 Swamp 4 Marsh 5 Water). 15 / NA = not mapped as wetland.
wetland_all <- function(parcels) {
  cr <- crop_to(terra::rast(CWIM), parcels)
  ws <- zonal_weights(cr$r, cr$v)
  lapply(ws, function(z) {
    if (is.null(z) || is.null(z$tab)) return(list(wet = 0, wc = ""))
    d <- z$tab[z$tab$value %in% 1:5, ]
    if (!nrow(d)) return(list(wet = 0, wc = ""))
    list(wet = round(100 * sum(d$w) / z$tot, 2),
         wc  = paste(sort(unique(as.integer(d$value))), collapse = ""))
  })
}

# GSW occurrence: a municipality can straddle a 10-degree tile boundary, so
# take every tile its bbox touches and mosaic them.
gsw_raster_for <- function(parcels) {
  b <- sf::st_bbox(sf::st_transform(parcels, 4326))
  lons <- seq(floor(b[["xmin"]] / 10) * 10, floor(b[["xmax"]] / 10) * 10, by = 10)
  lats <- seq(ceiling(b[["ymin"]] / 10) * 10, ceiling(b[["ymax"]] / 10) * 10, by = 10)
  tiles <- unlist(lapply(lons, function(lo) lapply(lats, function(la)
    sprintf("%s/occurrence/occurrence_%d%s_%d%sv1_4_2021.tif", GSW_BASE,
            abs(lo), ifelse(lo < 0, "W", "E"), abs(la), ifelse(la < 0, "S", "N")))))
  rs <- lapply(tiles, function(t) tryCatch(crop_to(terra::rast(t), parcels)$r,
                                           error = function(e) NULL))
  rs <- Filter(Negate(is.null), rs)
  if (!length(rs)) return(NULL)
  if (length(rs) == 1L) rs[[1]] else do.call(terra::merge, rs)
}

# Shares of the whole parcel: permanent = water in >=75% of observations,
# intermittent = 5-75%. Cells never observed count as not water.
water_all <- function(parcels) {
  r <- gsw_raster_for(parcels)
  if (is.null(r)) return(rep(list(list(gsw = NA, gsi = NA)), nrow(parcels)))
  v <- sf::st_transform(parcels, sf::st_crs(terra::crs(r)))
  ws <- zonal_weights(r, v)
  lapply(ws, function(z) {
    if (is.null(z)) return(list(gsw = NA, gsi = NA))
    if (is.null(z$tab)) return(list(gsw = 0, gsi = 0))
    d <- z$tab
    list(gsw = round(100 * sum(d$w[d$value >= 75]) / z$tot, 2),
         gsi = round(100 * sum(d$w[d$value >= 5 & d$value < 75]) / z$tot, 2))
  })
}

# MRDEM: elevation min/max and coverage-weighted mean slope. Cropped with a
# wider halo so slope at the edge parcels is computed from real neighbours.
relief_all <- function(parcels) {
  cr <- crop_to(terra::rast(MRDEM), parcels, halo = 0.05)
  sl <- terra::terrain(cr$r, v = "slope", unit = "degrees", neighbors = 8)
  if (HAVE_EXACT) {
    z  <- exactextractr::exact_extract(cr$r, cr$v, c("min", "max"), progress = FALSE)
    s  <- exactextractr::exact_extract(sl,   cr$v, "mean",          progress = FALSE)
    lapply(seq_len(nrow(cr$v)), function(i)
      list(rel = round(z$max[i] - z$min[i], 1), z = c(round(z$min[i]), round(z$max[i])),
           slp = round(s[i], 2)))
  } else {
    x <- terra::extract(c(cr$r, sl), terra::vect(cr$v), exact = TRUE, ID = TRUE)
    names(x)[2:3] <- c("z", "slope")
    sp <- split(x, factor(x$ID, levels = seq_len(nrow(cr$v))))
    lapply(sp, function(d) {
      d <- d[!is.na(d$z), ]
      if (!nrow(d)) return(list(rel = NA, z = c(NA, NA), slp = NA))
      list(rel = round(max(d$z) - min(d$z), 1), z = c(round(min(d$z)), round(max(d$z))),
           slp = round(sum(d$slope * d$fraction, na.rm = TRUE) / sum(d$fraction), 2))
    })
  }
}

# --- 1. parcels ---------------------------------------------------------------
if (!INDEX_ONLY) {
  pq_files <- list.files(assembly_dir, pattern = "^MAOParcelOutputAg\\d{8}\\.parquet$",
                         full.names = TRUE)
  if (!length(pq_files)) stop("No MAOParcelOutputAg<YYYYMMDD>.parquet in ", assembly_dir)
  pq_rows <- vapply(pq_files, function(f)
    tryCatch(as.integer(nrow(arrow::open_dataset(f))), error = function(e) NA_integer_), integer(1))
  ok <- !is.na(pq_rows); pq_files <- pq_files[ok]; pq_rows <- pq_rows[ok]
  complete <- pq_rows >= 0.80 * max(pq_rows)
  pq_path  <- tail(sort(pq_files[complete]), 1L)
  cat("Reading parcels:", basename(pq_path), "\n")

  pq <- arrow::open_dataset(pq_path) |>
    dplyr::select(TaxID, MuniCode, Municipality, CalcAcres, MASCRating, geometry_wkt) |>
    dplyr::filter(!is.na(CalcAcres), CalcAcres >= MIN_ACRES) |>
    dplyr::collect() |>
    dplyr::filter(!is.na(MASCRating), nzchar(as.character(MASCRating)),
                  !is.na(geometry_wkt), nzchar(geometry_wkt)) |>
    dplyr::mutate(roll_num = suppressWarnings(as.numeric(TaxID)),
                  Roll_No_Txt = sprintf("%.3f", roll_num),
                  MuniCode = suppressWarnings(as.integer(MuniCode))) |>
    dplyr::filter(!is.na(MuniCode), !is.na(roll_num))
  cat(sprintf("  parcels >= %d ac with a MASC rating: %s\n", MIN_ACRES,
              format(nrow(pq), big.mark = ",")))

  roll_files <- list.files(source_dir, pattern = "^RollEntry_\\d{8}\\.gpkg$", full.names = TRUE)
  if (!length(roll_files)) stop("No RollEntry_YYYYMMDD.gpkg in ", source_dir)
  re <- sf::st_read(tail(sort(roll_files), 1L),
                    query = 'SELECT DISTINCT "Municipality", "Muni_Name_With_Typ" FROM "roll_entry"',
                    quiet = TRUE)
  muni_map <- re |>
    dplyr::mutate(MuniCode = suppressWarnings(as.integer(sub("\\s*-.*$", "", Municipality)))) |>
    dplyr::filter(!is.na(MuniCode), nzchar(Muni_Name_With_Typ)) |>
    dplyr::distinct(MuniCode, Muni_Name_With_Typ)

  pq <- pq |>
    dplyr::left_join(muni_map, by = "MuniCode") |>
    dplyr::mutate(Muni_Name_With_Typ = dplyr::coalesce(Muni_Name_With_Typ, toupper(Municipality)),
                  muni_key = safe_filename(Muni_Name_With_Typ))

  parcels <- sf::st_as_sf(pq, wkt = "geometry_wkt", crs = 4326)

  muni_keys <- sort(unique(parcels$muni_key))
  if (!is.null(ONLY_MUNI)) {
    code <- suppressWarnings(as.integer(ONLY_MUNI))
    muni_keys <- if (!is.na(code)) unique(parcels$muni_key[parcels$MuniCode == code])
                 else muni_keys[grepl(toupper(ONLY_MUNI), muni_keys, fixed = TRUE)]
    if (!length(muni_keys)) stop("no municipality matches --muni ", ONLY_MUNI)
  }
  cat("Municipalities to build:", length(muni_keys),
      if (HAVE_EXACT) " (exactextractr)" else " (terra fallback — slow)", "\n")

  # --- 2. per-muni shards -----------------------------------------------------
  for (key in muni_keys) {
    fname <- file.path(output_dir, paste0(key, ".json"))
    if (file.exists(fname) && !FORCE) { cat("  skip  ", key, "(exists)\n"); next }
    p <- parcels[parcels$muni_key == key, ]
    if (!is.na(LIMIT)) p <- head(p, LIMIT)
    t0 <- Sys.time()
    cat(sprintf("  %-40s %5d parcels ...", key, nrow(p)))

    res <- setNames(vector("list", nrow(p)), p$Roll_No_Txt)
    cp  <- matrix(NA_integer_, nrow(p), length(YEARS))
    dom <- matrix(NA_integer_, nrow(p), length(YEARS))
    for (j in seq_along(YEARS)) {
      u <- aci_url(YEARS[j])
      if (is.na(u) || grepl("^/vsizip//vsicurl/", u)) next   # not cached: skip, do not stream
      yr <- tryCatch(crop_year(u, p), error = function(e) NULL)
      if (is.null(yr)) next
      for (i in seq_len(nrow(p))) if (!is.null(yr[[i]])) { cp[i, j] <- yr[[i]]$cp; dom[i, j] <- yr[[i]]$dom }
    }
    wet <- tryCatch(wetland_all(p), error = function(e) rep(list(list(wet = NA, wc = "")), nrow(p)))
    wat <- tryCatch(water_all(p),   error = function(e) rep(list(list(gsw = NA, gsi = NA)), nrow(p)))
    rel <- tryCatch(relief_all(p),  error = function(e) rep(list(list(rel = NA, z = c(NA, NA), slp = NA)), nrow(p)))

    for (i in seq_len(nrow(p))) {
      res[[i]] <- list(
        cp = as.list(ifelse(is.na(cp[i, ]), NA, cp[i, ])),
        dom = as.list(ifelse(is.na(dom[i, ]), NA, dom[i, ])),
        rel = rel[[i]]$rel, slp = rel[[i]]$slp, z = rel[[i]]$z,
        wet = wet[[i]]$wet, wc = wet[[i]]$wc,
        gsw = wat[[i]]$gsw, gsi = wat[[i]]$gsi
      )
    }
    jsonlite::write_json(res, fname, auto_unbox = TRUE, digits = NA, na = "null", null = "null")
    cat(sprintf(" %6.0f s\n", as.numeric(difftime(Sys.time(), t0, units = "secs"))))
  }
}

# --- 3. manifest, rebuilt from whatever shards exist --------------------------
manifest <- list()
for (f in sort(list.files(output_dir, pattern = "^[^_].*\\.json$", full.names = TRUE))) {
  d <- jsonlite::fromJSON(f, simplifyVector = FALSE)
  key <- tools::file_path_sans_ext(basename(f))
  # Recover the display name from the parcel set when we have it, else from
  # an existing manifest entry, else the key itself.
  nm <- if (exists("parcels")) unique(parcels$Muni_Name_With_Typ[parcels$muni_key == key])[1] else NA
  if (is.na(nm) && file.exists(index_path)) {
    old <- jsonlite::fromJSON(index_path, simplifyVector = FALSE)
    hit <- names(old)[vapply(old, function(x) identical(x$file %||% "", basename(f)), logical(1))]
    if (length(hit)) nm <- hit[1]
  }
  if (is.na(nm)) nm <- key
  manifest[[nm]] <- list(file = basename(f), count = length(d))
}
aci_cached <- list.files(Sys.getenv("ACI_CACHE"), pattern = "\\.tif$")
manifest[["_meta"]] <- list(
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  source       = if (exists("pq_path")) basename(pq_path) else NA,
  min_acres    = MIN_ACRES,
  requires     = "MASC rating",
  years        = YEARS,
  layers = list(
    crop    = "AAFC Annual Crop Inventory 2009-2025, 30 m (56 m 2009-2010); null = year not observed",
    relief  = "NRCan MRDEM-30 (CanElevation)",
    wetland = "Canadian Wetland Inventory Map v3A, 10 m (DUC/NRCan); classes 1 Bog 2 Fen 3 Swamp 4 Marsh 5 Water",
    water   = "JRC Global Surface Water v1.4 occurrence 1984-2021; gsw >=75% of observations, gsi 5-75%"
  ),
  aci_cache_files = length(aci_cached)
)
jsonlite::write_json(manifest, index_path, auto_unbox = TRUE, pretty = FALSE)
total_mb <- sum(file.info(list.files(output_dir, full.names = TRUE))$size) / 1024 / 1024
cat(sprintf("Done. %d shards, %.1f MB, manifest %s\n",
            length(manifest) - 1L, total_mb, index_path))
