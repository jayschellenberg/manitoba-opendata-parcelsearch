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
#   * MB-RIVER-LOTS.kmz (optional)             — historic parish/river lot
#                                               polygon geometry
#   * D:/Dropbox/ClaudeCode/MASC-SCRAPE/masc_soil_ratings_riverlots.csv
#                                              (optional) — per-lot ratings
#                                              for parish/river lots; joined
#                                              to the KMZ via parish-prefix
#                                              + lot-number heuristic
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
# 2b. River-lot ratings — join MASC riverlot scrape to KMZ polygons
# ----------------------------------------------------------------------
# Planar projection used by the spatial join below — same CRS the
# section-3 intersection uses, hoisted up here so this block can
# share it.
utm14 <- 26914

# Quarter-section MASC squares miss river-lot parcels (long narrow
# strips perpendicular to the river that fall between the discrete
# quarter centroids). MASC publishes a separate per-lot table for
# parish/river lots that we ingest from a sister scrape. The MASC
# table has no geometry — we attach geometry from the public
# MB-RIVER-LOTS.kmz polygon set.
#
# The two sources use different parish encodings:
#   KMZ label       PARISH_PREFIX + LOT_TYPE + LOT_NUMBER
#                   (e.g. "NORL241" = NORBERT, river lot, lot 241)
#                   PARISH_PREFIX is 2 letters, mostly the first
#                   letters of the parish name (after stripping
#                   ST./STE.).
#   MASC scrape     parish_code = single letter, scoped within muni.
#                   parish_name = full name ("ST. NORBERT").
#                   land_parcel = "R 1 241 /001 B" with B = parish_code.
#
# We bridge them by deriving the expected KMZ prefix from each MASC
# parish_name (heuristic + override map) and matching on
# (muni, prefix, lot_number).
riverlot_kmz_path <- file.path(source_dir, "MB-RIVER-LOTS.kmz")
riverlot_csv_path <- "D:/Dropbox/ClaudeCode/MASC-SCRAPE/masc_soil_ratings_riverlots.csv"

riverlot_polys <- NULL
if (file.exists(riverlot_kmz_path) && file.exists(riverlot_csv_path)) {

  cat("Reading river-lot MASC scrape ...\n")
  rl_csv <- readr::read_csv(riverlot_csv_path, show_col_types = FALSE)
  cat("  rows:", nrow(rl_csv), "\n")

  # Hardcoded overrides for parish names whose KMZ prefix doesn't
  # follow the simple "first 2 letters after ST./STE." rule. Built
  # by inspecting the KMZ prefix list against the MASC parish list.
  # Add to this map if the build warns about unmapped (muni, prefix).
  parish_prefix_overrides <- c(
    "PASQUIA SETTLEMENT"           = "PQ",  # PA reserved for ST. PAUL
    "BIRCH RIVER SETTLEMENT NORTH" = "BN",
    "BIRCH RIVER SETTLEMENT SOUTH" = "BS",
    "BAIE ST. PAUL"                = "BP",
    "MANITOBA HOUSE SETTLEMENT (1)" = "MH",
    "MANITOBA HOUSE SETTLEMENT (2)" = "MH",
    "MANITOBA HOUSE SETTLEMENT (3)" = "MH",
    # Heuristic mismatches against the KMZ encoding:
    "ST. ANDREWS"                  = "AD",  # heuristic would give AN (collides with STE. ANNE)
    "POPLAR POINT"                 = "PO",  # heuristic would give PP
    "CARROT RIVER SETTLEMENT"      = "CA"   # heuristic would give CR
    # WHITEMOUTH RIVER SETTLEMENT is split K/L for north/south; handled
    # row-by-row below since the parish_name is identical for both.
  )
  parish_to_prefix <- function(name) {
    if (name %in% names(parish_prefix_overrides)) {
      return(unname(parish_prefix_overrides[name]))
    }
    s <- toupper(name)
    # Strip "ST." / "STE." prefix words. The earlier regex
    # `\bSTE?\.?\b` failed because the trailing word boundary doesn't
    # exist between ".  " (period and space — both non-word chars), so
    # the period stayed behind and broke the first-letter heuristic
    # ("ST. NORBERT" → ". NORBERT" → ".N"). Match optional period then
    # whitespace explicitly instead.
    s <- gsub("(^|\\s)STE?\\.?\\s+",       "\\1", s)  # leading or mid-string
    s <- gsub("\\s+SETTLEMENT.*$",         "",    s)
    s <- gsub("\\s+INDIAN\\s+RESERVE.*$",  "",    s)
    s <- gsub("\\([^)]*\\)",               "",    s)
    s <- gsub("\\s+", " ", trimws(s))
    words <- strsplit(s, "\\s+")[[1]]
    if (length(words) == 0L) return(NA_character_)
    if (length(words) == 1L) return(substr(words[1], 1, 2))
    paste0(substr(words[1], 1, 1), substr(words[2], 1, 1))
  }

  # Parse the lot number out of "R 1 241 /001 B" — the second integer.
  rl_csv <- rl_csv |>
    mutate(
      prefix  = vapply(parish_name, parish_to_prefix, character(1)),
      lot_num = as.integer(sub("^[A-Z]\\s+\\d+\\s+(\\d+).*$", "\\1", land_parcel))
    ) |>
    filter(!is.na(lot_num))

  # WHITEMOUTH RIVER SETTLEMENT carries the same parish_name for both
  # banks of the river but two parish_codes (K = north, L = south),
  # while the KMZ uses two distinct prefixes (WN / WS). Route per-row
  # via parish_code so each set lines up with its KMZ counterpart.
  rl_csv$prefix[rl_csv$parish_name == "WHITEMOUTH RIVER SETTLEMENT" &
                rl_csv$parish_code == "K"] <- "WN"
  rl_csv$prefix[rl_csv$parish_name == "WHITEMOUTH RIVER SETTLEMENT" &
                rl_csv$parish_code == "L"] <- "WS"

  # POPLAR POINT lots in Portage la Prairie split across two KMZ
  # prefixes (PO and PP) covering different lot-number ranges. MASC
  # stores them all under one parish_name (POPLAR POINT, parish_code
  # J), so we don't know upfront which range a given row belongs to.
  # Duplicate every POPLAR POINT row under both prefixes — the
  # downstream join is on (muni, prefix, lot_num) so a row only
  # matches a KMZ feature with the right prefix AND lot number;
  # extras silently drop out.
  pp_dupes <- rl_csv |>
    filter(parish_name == "POPLAR POINT") |>
    mutate(prefix = "PP")
  rl_csv <- bind_rows(rl_csv, pp_dupes)

  # Normalize muni names so the join with KMZ-derived muni keys works
  # regardless of which source uses (RM)/(MUNICIPALITY)/etc. Both sides
  # get stripped to the bare uppercase name with whitespace normalized.
  norm_muni <- function(x) {
    x |>
      stringi::stri_trans_general(id = "Latin-ASCII") |>
      toupper() |>
      gsub(pattern = "\\s*\\([^)]*\\)\\s*$", replacement = "") |>
      gsub(pattern = "\\bRM\\s+OF\\b",       replacement = "") |>
      gsub(pattern = "\\bMUNICIPALITY\\s+OF\\b", replacement = "") |>
      gsub(pattern = "\\bTOWN\\s+OF\\b",     replacement = "") |>
      gsub(pattern = "\\bCITY\\s+OF\\b",     replacement = "") |>
      gsub(pattern = "\\bVILLAGE\\s+OF\\b",  replacement = "") |>
      gsub(pattern = "\\s+",                 replacement = " ") |>
      trimws()
  }
  rl_csv$muni_norm <- norm_muni(rl_csv$muni_name)

  cat("Reading MB-RIVER-LOTS.kmz ...\n")
  tmp <- tempfile("rl_kmz_")
  dir.create(tmp)
  unzip(riverlot_kmz_path, exdir = tmp)
  kml_file <- file.path(tmp, "doc.kml")
  layers <- sf::st_layers(kml_file)
  poly_layers <- layers$name[vapply(seq_along(layers$name), function(i) {
    gt <- layers$geomtype[[i]]
    length(gt) > 0 && any(grepl("polygon|multipolygon", tolower(gt)))
  }, logical(1))]

  rl_polys_list <- list()
  for (lyr in poly_layers) {
    g <- sf::st_read(kml_file, layer = lyr, quiet = TRUE)
    if (nrow(g) == 0L) next
    g <- sf::st_collection_extract(g, "POLYGON", warn = FALSE)
    g <- g[!sf::st_is_empty(g), ]
    if (nrow(g) == 0L) next
    cols_lower <- tolower(names(g))
    name_col   <- which(cols_lower == "name")
    g$name     <- if (length(name_col) == 0L) NA_character_ else as.character(g[[name_col[1]]])
    g <- g[, c("name", attr(g, "sf_column"))]
    rl_polys_list[[length(rl_polys_list) + 1L]] <- g
  }
  unlink(tmp, recursive = TRUE)

  rl_polys <- do.call(rbind, rl_polys_list)
  if (sf::st_crs(rl_polys)$epsg != 4326L) {
    rl_polys <- sf::st_transform(rl_polys, 4326)
  }
  rl_polys <- sf::st_zm(rl_polys, drop = TRUE, what = "ZM")

  # Parse KMZ label: "NORL241" → prefix="NO", type="RL", lot_num=241.
  m <- regmatches(rl_polys$name,
                  regexec("^([A-Z]{2,5})(RL|PL|WL|SL|OT)(\\d+)([A-Z]?)$",
                          toupper(rl_polys$name)))
  rl_polys$prefix   <- vapply(m, function(x) if (length(x) >= 2) x[2] else NA_character_, character(1))
  rl_polys$lot_type <- vapply(m, function(x) if (length(x) >= 3) x[3] else NA_character_, character(1))
  rl_polys$lot_num  <- as.integer(vapply(m, function(x) if (length(x) >= 4) x[4] else NA_character_, character(1)))
  rl_polys <- rl_polys[!is.na(rl_polys$prefix) & !is.na(rl_polys$lot_num), ]

  # Spatially attach a muni to each KMZ polygon. Earlier versions
  # used the polygon's centroid, which dropped river lots whose
  # geometric centre fell on a road, in water, or in any sliver not
  # covered by a current ROLL_ENTRY parcel — including ~788 PERL
  # (Parish of St. Peter) features in St. Andrews / St. Clements.
  # Switching to a polygon-level intersect is more permissive: any
  # KMZ polygon that overlaps any parcel picks up that parcel's muni.
  # Slower per-feature but the dataset is small (~7k features).
  cat("Tagging river-lot polygons with muni ...\n")
  rl_polys_utm <- sf::st_transform(rl_polys, utm14)

  # Quick lookup: build a parcels muni-tag layer with just (muni, geom).
  parcels_muni_tag_utm <- sf::st_transform(
    parcels |> select(Muni_Name_With_Typ), utm14
  )
  hits <- sf::st_intersects(rl_polys_utm, parcels_muni_tag_utm)
  rl_polys$muni_with_typ <- vapply(hits, function(idx) {
    if (length(idx) == 0L) return(NA_character_)
    # Pick the most common Muni_Name_With_Typ across all overlapping
    # parcels — defends against river lots that straddle a muni
    # boundary (a single parcel-overlap could be misleading; the
    # majority vote tracks the muni the lot actually sits in).
    munis <- parcels_muni_tag_utm$Muni_Name_With_Typ[idx]
    munis <- munis[!is.na(munis)]
    if (length(munis) == 0L) return(NA_character_)
    tab <- table(munis)
    names(tab)[which.max(tab)]
  }, character(1))
  rl_polys$muni_norm <- norm_muni(rl_polys$muni_with_typ)
  cat(sprintf("  river-lot polygons with muni assigned: %d / %d\n",
              sum(!is.na(rl_polys$muni_norm)), nrow(rl_polys)))

  # Now do the join: KMZ (muni_norm, prefix, lot_num) ⨝ MASC (muni_norm, prefix, lot_num)
  rl_join <- rl_polys |>
    sf::st_drop_geometry() |>
    select(name, muni_norm, prefix, lot_num) |>
    inner_join(
      rl_csv |>
        select(muni_norm, prefix, lot_num, parish_name, parish_code,
               rating = soil_rating, ra = risk_area),
      by = c("muni_norm", "prefix", "lot_num"),
      relationship = "many-to-many"
    ) |>
    distinct(name, .keep_all = TRUE)   # keep one rating per KMZ feature

  cat("  KMZ river-lot polygons:", nrow(rl_polys), "\n")
  cat("  MASC river-lot rows:   ", nrow(rl_csv), "\n")
  cat("  KMZ ⨝ MASC matches:    ", nrow(rl_join), "\n")

  # Diagnostic: list (muni, prefix) combos that exist in the KMZ for
  # munis where MASC does have river-lot data, but produced zero
  # matches. These are the candidates for adding to the override map
  # below. Sorted by KMZ-feature count so the highest-impact rows
  # show first.
  unmatched <- rl_polys |>
    sf::st_drop_geometry() |>
    select(muni_norm, prefix) |>
    distinct() |>
    anti_join(rl_csv |> select(muni_norm, prefix) |> distinct(),
              by = c("muni_norm", "prefix")) |>
    inner_join(
      rl_csv |> select(muni_norm) |> distinct() |>
        mutate(masc_has_muni = TRUE),
      by = "muni_norm"
    ) |>
    select(muni_norm, prefix)
  if (nrow(unmatched) > 0) {
    cnt <- rl_polys |>
      sf::st_drop_geometry() |>
      count(muni_norm, prefix, name = "kmz_features") |>
      inner_join(unmatched, by = c("muni_norm", "prefix")) |>
      arrange(desc(kmz_features))
    cat("\n  Unmatched (muni, prefix) — extend parish_prefix_overrides:\n")
    print(as.data.frame(head(cnt, 20)), row.names = FALSE)
    cat("\n")
  }

  # Build sf object: KMZ geometry + MASC rating columns, in the same
  # column shape as the quarter-section masc_sf so we can rbind later.
  # rl_polys already carries `prefix` and `lot_num`; drop them out of
  # the rl_join select so the left_join doesn't suffix the duplicates
  # (prefix.x / prefix.y) and break the transmute below.
  if (nrow(rl_join) > 0) {
    riverlot_polys <- rl_polys |>
      filter(name %in% rl_join$name) |>
      left_join(rl_join |> select(name, rating, ra, parish_name, parish_code),
                by = "name") |>
      transmute(
        q      = paste0(prefix, "RL"),                    # mimic the quarter "q" column
        s      = NA_integer_,
        t      = NA_integer_,
        r      = lot_num,
        d      = parish_code,
        rating = rating,
        ra     = as.integer(ra),
        geometry
      )
    cat("  rated river-lot polygons:", nrow(riverlot_polys), "\n")

    # ALSO write the rated river-lot polygons to a single static file
    # the frontend can use to render river-lot ratings on the MASC
    # Rating overlay. The existing per-muni masc/<MUNI>.json shards
    # only carry quarter-section centroids (built by build_masc_shards.R
    # from the quarter-section CSV), so river lots paint nothing on
    # the overlay until this file lands. ~6,700 polygons across the
    # province; ~2-4 MB minified, gzipped under 1 MB on the wire.
    masc_riverlots_out <- file.path(
      source_dir, "web/public/data/masc-riverlots.json"
    )
    riverlot_overlay <- rl_polys |>
      filter(name %in% rl_join$name) |>
      left_join(rl_join |> select(name, rating, ra, parish_name, parish_code),
                by = "name") |>
      transmute(
        label  = paste0(prefix, "-", lot_type, "-", lot_num),
        rating = rating,
        ra     = as.integer(ra),
        muni   = muni_with_typ,
        geometry
      )
    if (file.exists(masc_riverlots_out)) file.remove(masc_riverlots_out)
    sf::st_write(
      riverlot_overlay,
      masc_riverlots_out,
      driver        = "GeoJSON",
      layer_options = c("COORDINATE_PRECISION=5", "RFC7946=YES"),
      quiet         = TRUE
    )
    cat(sprintf("  wrote %s (%.2f MB)\n",
                masc_riverlots_out,
                file.info(masc_riverlots_out)$size / 1024 / 1024))
  } else {
    cat("  no river-lot ratings matched — check parish_prefix_overrides\n")
  }
}

# Combine quarter-section squares + rated river-lot polygons (when
# present) into a single sf for the intersection step. Same columns,
# same CRS — just two different sources of MASC ratings.
if (!is.null(riverlot_polys) && nrow(riverlot_polys) > 0) {
  cat("Merging quarter-section + river-lot MASC sources ...\n")
  masc_sf <- rbind(masc_sf, riverlot_polys)
  cat("  combined ratings:", nrow(masc_sf), "\n")
}

# ----------------------------------------------------------------------
# 3. Spatial intersection (parcel × quarter), area-weighted
# ----------------------------------------------------------------------
# Use a planar projection for area calculations — UTM 14N covers most
# of southern Manitoba's farmland; minor distortion at the extremes is
# fine for "pick the dominant rating". `utm14` is already defined up
# in section 2b so the river-lot block could share it.
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

cat("  parcels with a rating from intersection:", nrow(dominant), "\n")

# ----------------------------------------------------------------------
# 4b. Nearest-quarter fallback for parcels that no quarter polygon
#     overlapped. River lots are the typical case — they're long
#     narrow strips perpendicular to the riverbank that can fall
#     entirely between the discrete MASC quarter centroids' 800 m
#     padded boxes, missing every intersection. For each unmatched
#     parcel, find the nearest MASC quarter centroid and adopt its
#     rating. Tolerance = 1 km from the parcel centroid; beyond that
#     we leave the parcel unrated (genuinely outside MASC coverage).
# ----------------------------------------------------------------------
matched_rolls <- unique(dominant$Roll_No_Txt)
unmatched <- parcels_utm[!parcels_utm$Roll_No_Txt %in% matched_rolls, ]
cat("  parcels missing intersection (river lots, narrow strips):",
    nrow(unmatched), "\n")

if (nrow(unmatched) > 0) {
  cat("Running centroid-nearest fallback ...\n")
  # MASC centroids (the original lat/lon, UTM-projected). We match
  # against centroids — not the padded quarter polygons — so a river
  # lot just outside the box still pulls the closest rating.
  masc_pts <- sf::st_sf(
    rating = masc$soil_rating,
    ra     = as.integer(masc$risk_area),
    q      = masc$quarter,
    s      = as.integer(masc$section),
    t      = as.integer(masc$township),
    r      = as.integer(masc$range_num),
    d      = masc$direction,
    geometry = sf::st_sfc(
      mapply(function(lon, lat) sf::st_point(c(lon, lat)),
             masc$lon, masc$lat, SIMPLIFY = FALSE),
      crs = 4326
    )
  )
  masc_pts <- sf::st_transform(masc_pts, utm14)

  # Use parcel centroids; sf prints a "centroid is approximate" warning
  # for projected CRS that we suppress. nearest_feature returns one
  # index per source row.
  parcel_pts <- suppressWarnings(sf::st_centroid(unmatched))
  near_idx <- sf::st_nearest_feature(parcel_pts, masc_pts)
  near_dist <- as.numeric(
    sf::st_distance(parcel_pts, masc_pts[near_idx, ], by_element = TRUE)
  )

  fallback <- data.frame(
    Roll_No_Txt        = unmatched$Roll_No_Txt,
    Muni_Name_With_Typ = unmatched$Muni_Name_With_Typ,
    rating             = masc_pts$rating[near_idx],
    q                  = masc_pts$q[near_idx],
    s                  = masc_pts$s[near_idx],
    t                  = masc_pts$t[near_idx],
    r                  = masc_pts$r[near_idx],
    d                  = masc_pts$d[near_idx],
    ra                 = masc_pts$ra[near_idx],
    near_m             = near_dist
  ) |>
    filter(near_m <= 1000) |>      # within 1 km of a real quarter centroid
    select(-near_m)

  cat("  parcels rescued by fallback:", nrow(fallback), "\n")
  dominant <- bind_rows(dominant, fallback)
}

cat("  parcels with a rating (intersection + fallback):", nrow(dominant), "\n")

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
