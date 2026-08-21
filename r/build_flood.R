# build_flood.R
#
# Pre-bakes each parcel's FLOOD ZONE membership, so the frontend can answer
# "is this parcel in a flood zone, and which one" for a whole result set
# without doing any geometry at render time.
#
# WHAT THIS IS
# ------------
# Up to nine zones per parcel, each with the share of the parcel's area that
# falls inside it:
#
#   RRVDFA  Red River Valley Designated Flood Area   statutory (WRA Act s.17)
#   LRDFA   Lower Red River Designated Flood Area    statutory (WRA Act s.17)
#   SMA     RRV Special Management Area              planning (The Planning Act)
#   F200    1-in-200 Year Flood Extent (0.5% AEP)    statistical
#   FL1997  1997 Red River Flood extent              observed
#   FL2009  2009 Red River Flood extent              observed
#   FL2011  2011 Red River / Assiniboine Flood       observed
#   WWCR    Winnipeg river waterway corridor 107 m   municipal by-law
#   WWCC    Winnipeg creek waterway corridor 76 m    municipal by-law
#
# The codes are the wire format. They are also declared in
# web/src/lib/flood.js, which owns the labels, colours and severity order;
# web/test/flood.test.js fails if the two drift. Adding a zone means adding
# it in BOTH places — a code the app does not know is dropped from the cell
# rather than printed raw.
#
# WHY THE PERCENT SHIPS, NOT JUST A FLAG
# --------------------------------------
# "In the flood zone" is not a yes/no for a parcel that straddles the line.
# A quarter section 4% inside the DFA is not encumbered the way a lot wholly
# inside it is, and an appraiser needs to see which one they have. Same
# reasoning as WaterDistanceFt in build_water.R: show the measurement rather
# than a bare verdict the reader has to take on trust.
#
# FULL RESOLUTION, DELIBERATELY
# -----------------------------
# This reads MBFloodMapping/data/ — the authoritative cache — NOT its
# web/data/, which is simplified to 3-30% of the vertices for display.
# The map overlay draws the simplified geometry and this column decides
# membership from the full geometry, so a boundary parcel can look outside
# the DFA on screen and read "RRV DFA 12%" in its cell. That is the honest
# arrangement. If the two ever have to agree, raise the overlay's fidelity —
# never lower this.
#
# THE SOURCE VINTAGE IS NOT THE BOUNDARY VINTAGE
# ----------------------------------------------
# RRVDFA, LRDFA and SMA come from the Manitoba Land Initiative, which stopped
# publishing updates on 2022-02-09. MBFloodMapping's refresh script still
# succeeds against it — it re-fetches 2022 bytes and stamps them with today's
# date. DataMB carries a newer Designated Flood Areas layer (last edited
# 2025-04-02) that has NOT been repointed to; that is Jason's call, recorded
# in the header of MBFloodMapping/R/refresh_flood_data.R. The `_meta` block
# written below carries each layer's fetch date so the Data Status dialog can
# show it, and the app's tooltip says these are screening layers. Read that
# README before quoting a DFA boundary to anyone.
#
# INPUTS
#   <repo>/RollEntry_<YYYYMMDD>.gpkg
#       Most recent parcel snapshot from r/download_parcels.R — all ~437k
#       parcels as sf polygons, carrying Roll_No_Txt and Muni_Name_With_Typ.
#   <MBFloodMapping>/data/<layer>.geojson
#       Full-resolution layer cache from that project's R/refresh_flood_data.R.
#
# OUTPUT
#   <mb-parcel-data>/flood/<MUNI_KEY>.json
#       Flat dictionary keyed by Roll_No_Txt:
#         { "3600.000": { "z": { "RRVDFA": 100, "FL1997": 62 } } }
#   <mb-parcel-data>/flood/_index.json
#       { "<Muni_Name_With_Typ>": { "file": ..., "count": N }, "_meta": {...} }
#
# ABSENCE SEMANTICS — read this before changing the filter.
#   Only parcels intersecting at least one zone are shipped. Most of Manitoba
#   is outside every layer, so shipping the rest would inflate the payload
#   many times over to say nothing. On the frontend:
#       muni in _index AND roll absent -> genuinely outside every zone
#       muni NOT in _index             -> shard never built; state unknown
#   That is the same three-state problem the Water and Tile Drainage columns
#   already handle. Do not collapse it: this is a hazard column, and a
#   confident "None" with no evidence behind it is the worst thing it can say.
#
# Runtime: ~10-25 minutes. Most of it is the 1-in-200 extent, which is 19 MB
# of vertices. Re-run after a fresh RollEntry snapshot or a MBFloodMapping
# data refresh.

suppressPackageStartupMessages({
  library(sf)
  library(dplyr)
  library(jsonlite)
  library(stringi)
})

# Shared roots (env-overridable) — see r/config.R.
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

source_dir <- mb_parcelsearch_root
flood_dir  <- file.path(mb_floodmapping_root, "data")
output_dir <- file.path(mb_parcel_data_root, "flood")
index_path <- file.path(output_dir, "_index.json")

# Zone code -> source file, in the severity order lib/flood.js declares. The
# order matters only for progress output; the frontend re-sorts by its own
# table.
ZONES <- list(
  list(code = "RRVDFA", file = "dfa_all"),
  list(code = "LRDFA",  file = "dfa_lower_red_river"),
  list(code = "SMA",    file = "rrv_special_management_area"),
  list(code = "F200",   file = "mb_1in200_flood_extent"),
  list(code = "FL1997", file = "red_river_flood_1997"),
  list(code = "FL2009", file = "red_river_flood_2009"),
  list(code = "FL2011", file = "red_river_flood_2011"),
  # Expect almost nothing from the corridor zones, and that is not a bug. The
  # corridors are clipped to the City of Winnipeg, which does its own
  # assessment and is absent from the provincial Roll Entry fabric — so the
  # only hits are parcels in the adjacent RMs that straddle the city boundary:
  # 11 of them on the 2026-08-11 fabric (Ritchot, East and West St Paul,
  # Headingley), all at 1-3% coverage. They stay in the list because the map
  # overlay draws the corridors where they ARE useful, and because a fabric
  # that one day carries Winnipeg would light this up with no code change.
  list(code = "WWCR",   file = "wpg_waterway_river_corridor"),
  list(code = "WWCC",   file = "wpg_waterway_creek_corridor")
)

# Overlap smaller than this is topology, not geography: two valid polygons
# sharing a boundary should intersect in a line of zero area, and floating
# point turns that into a few square millimetres. One square metre is far
# below the accuracy of either the parcel fabric or the flood mapping, so
# nothing real is lost and no parcel gains a zone it merely touches.
MIN_OVERLAP_M2 <- 1

dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

# ----------------------------------------------------------------------
# 1. Parcels
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
cat("  parcels:", format(nrow(parcels), big.mark = ","), "\n")

if (is.na(sf::st_crs(parcels))) sf::st_crs(parcels) <- 4326

geom_col <- attr(parcels, "sf_column")
keep <- c("Roll_No_Txt", "Muni_Name_With_Typ", geom_col)
missing_cols <- setdiff(c("Roll_No_Txt", "Muni_Name_With_Typ"), names(parcels))
if (length(missing_cols)) {
  stop("RollEntry snapshot is missing: ", paste(missing_cols, collapse = ", "))
}
parcels <- parcels[, keep]
parcels <- parcels[!is.na(parcels$Roll_No_Txt) & !is.na(parcels$Muni_Name_With_Typ), ]
parcels <- parcels[!sf::st_is_empty(parcels), ]
names(parcels)[names(parcels) == geom_col] <- "geometry"
sf::st_geometry(parcels) <- "geometry"

# Metres from here on. Every area, every intersection: UTM 14N is the CRS the
# rest of this repo measures Manitoba in (see M2_PER_ACRE / UTM14_EPSG in
# config.R), and st_area on geographic coordinates would be wrong in a way
# that varies with latitude.
cat("Projecting to UTM 14N ...\n")
parcels <- sf::st_transform(parcels, UTM14_EPSG)

# MakeValid before anything else. The Roll Layer ships self-intersecting
# rings and unclosed polygons in small numbers, and st_intersection throws on
# the first one it meets rather than skipping it — the same treatment
# build_parcel_masc.R gives this fabric.
cat("Repairing parcel geometry ...\n")
parcels <- sf::st_make_valid(parcels)
parcels <- parcels[!sf::st_is_empty(parcels), ]

parcel_area <- as.numeric(sf::st_area(parcels))
# A zero-area parcel cannot have a percentage computed against it. These are
# degenerate fabric rows, not real properties; they simply never match.
usable <- parcel_area > 0
cat("  usable parcels:", format(sum(usable), big.mark = ","),
    sprintf("(%d dropped for zero area)\n", sum(!usable)))

# ----------------------------------------------------------------------
# 2. Per-zone membership
# ----------------------------------------------------------------------
# Two-step on purpose, and the first step does most of the work:
#
#   st_covered_by  parcels wholly inside the zone -> 100%, no clipping
#   st_intersects  the rest -> only these need st_intersection
#
# In the Red River valley the overwhelming majority of hits are wholly
# inside, and clipping them against a 19 MB polygon to rediscover that they
# are 100% inside would dominate the runtime for no information.

# Accumulator: one row per (roll, zone) hit.
hits <- list()

for (z in ZONES) {
  t0 <- Sys.time()
  path <- file.path(flood_dir, paste0(z$file, ".geojson"))
  if (!file.exists(path)) {
    stop("Missing flood layer: ", path,
         "\nRun MBFloodMapping's R/refresh_flood_data.R, or set MBFLOODMAPPING_ROOT.")
  }
  layer <- sf::st_read(path, quiet = TRUE)
  if (is.na(sf::st_crs(layer))) sf::st_crs(layer) <- 4326
  layer <- sf::st_transform(layer, UTM14_EPSG)
  layer <- sf::st_make_valid(layer)
  layer <- layer[!sf::st_is_empty(layer), ]

  # Union to a single geometry per zone. The 1-in-200 extent ships as 13
  # study reaches and the historical extents as multipolygons; without the
  # union a parcel spanning two reaches would produce two rows and its
  # percentages would have to be summed by hand downstream.
  zone_geom <- sf::st_union(sf::st_geometry(layer))

  # ARGUMENT ORDER IS NOT COSMETIC HERE — it is the difference between
  # minutes and hours.
  #
  # sf builds a PREPARED geometry for the first argument of a binary
  # predicate (`prepared = TRUE` by default) and looks up candidates against
  # the second. Written the natural way round — st_covered_by(parcels, zone)
  # — that prepares 438,061 tiny parcels and tests each against an
  # UNPREPARED extent, so every one of those tests walks the full vertex
  # list of a 19 MB polygon, and the candidate index is useless because the
  # second side is a single geometry. Measured on a scaled-down stand-in
  # (60k-vertex polygon, 20k small squares) that orientation is 35x slower;
  # at the real sizes the 1-in-200 extent had not finished in 35 minutes.
  #
  # Zone first prepares the big geometry ONCE, with its own internal index,
  # and streams the parcels past it. Same predicate, same answer — st_covers
  # is exactly the converse of st_covered_by.
  covered  <- logical(nrow(parcels))
  touching <- logical(nrow(parcels))
  covered[sf::st_covers(zone_geom, parcels)[[1]]] <- TRUE
  touching[sf::st_intersects(zone_geom, parcels)[[1]]] <- TRUE
  partial <- touching & !covered & usable
  covered <- covered & usable

  pct <- rep(NA_real_, nrow(parcels))
  pct[covered] <- 100

  if (any(partial)) {
    # Clip only the straddlers. st_intersection on a subset keeps the
    # attribute columns, so the result rows line up with parcels[partial, ].
    clipped <- suppressWarnings(
      sf::st_intersection(sf::st_geometry(parcels[partial, ]), zone_geom)
    )
    # st_intersection DROPS empty results, so the output is shorter than the
    # input and positional alignment is not safe. sf records which input each
    # surviving geometry came from in the "idx" attribute — column 1 indexes
    # the x argument, here the `partial` subset. Assert rather than fall back:
    # a silent positional guess would misattribute every percentage after the
    # first dropped row, which is a wrong number rather than a missing one.
    idx <- attr(clipped, "idx")
    if (is.null(idx)) {
      stop("st_intersection returned no idx attribute for ", z$code,
           " — cannot map overlaps back to parcels safely (sf version change?)")
    }
    overlap <- as.numeric(sf::st_area(clipped))
    partial_rows <- which(partial)
    target <- partial_rows[idx[, 1]]
    ok <- overlap >= MIN_OVERLAP_M2
    target <- target[ok]
    overlap <- overlap[ok]
    if (length(target)) {
      # Sum by parcel before dividing. With a unioned zone each parcel yields
      # one geometry, so this is a no-op today — but if a future sf splits a
      # multipart result across rows, summing is right and taking the last
      # would silently under-report the coverage.
      agg <- tapply(overlap, target, sum)
      tgt <- as.integer(names(agg))
      pct[tgt] <- 100 * as.numeric(agg) / parcel_area[tgt]
    }
  }

  matched <- which(!is.na(pct))
  if (length(matched)) {
    hits[[z$code]] <- tibble::tibble(
      row  = matched,
      code = z$code,
      # Clamp at both ends. A sliver must not round to 0 (which reads as
      # "not in it") and a near-total must not round to 100 (which claims
      # the whole parcel) — the two ends are exactly where the reader is
      # deciding whether the encumbrance matters.
      pct  = pmin(100L, pmax(1L, as.integer(round(pct[matched]))))
    )
    # An area ratio can exceed 1 by a hair on a parcel whose repaired
    # geometry differs slightly from the one measured; the clamp above
    # absorbs it, but a large excess means something is wrong upstream.
    over <- pct[matched] > 105
    if (any(over)) {
      warning(sum(over), " parcels reported >105% coverage in ", z$code,
              " — check the fabric repair")
    }
  }

  # Timing per zone, because the cost is wildly uneven — the 1-in-200 extent
  # is 19 MB and the Special Management Area is 19 KB — and a run that looks
  # hung is almost always one layer rather than the whole job.
  cat(sprintf("  %-7s %7s parcels (%s wholly inside, %s clipped)  %.1f min\n",
              z$code,
              format(length(matched), big.mark = ","),
              format(sum(covered), big.mark = ","),
              format(sum(partial), big.mark = ","),
              as.numeric(difftime(Sys.time(), t0, units = "mins"))))
  flush.console()
}

if (length(hits) == 0L) {
  stop("No parcel intersected any flood layer — check the CRS and the inputs.")
}

all_hits <- dplyr::bind_rows(hits)
cat("Parcels in at least one zone:",
    format(length(unique(all_hits$row)), big.mark = ","), "\n")

# ----------------------------------------------------------------------
# 3. Per-muni shards
# ----------------------------------------------------------------------
# safe_filename is byte-identical to build_water.R / build_landcover.R /
# build_parcel_masc.R so shard filenames line up across every pipeline the
# frontend reads.
safe_filename <- function(x) {
  x |>
    stringi::stri_trans_general(id = "Latin-ASCII") |>
    toupper() |>
    gsub(pattern = "[^A-Z0-9._-]+", replacement = "_") |>
    gsub(pattern = "_+",            replacement = "_") |>
    gsub(pattern = "^_|_$",         replacement = "")
}

meta <- sf::st_drop_geometry(parcels)[, c("Roll_No_Txt", "Muni_Name_With_Typ")]
joined <- all_hits |>
  mutate(
    Roll_No_Txt        = meta$Roll_No_Txt[row],
    Muni_Name_With_Typ = meta$Muni_Name_With_Typ[row],
  ) |>
  filter(!is.na(Muni_Name_With_Typ), nzchar(Muni_Name_With_Typ)) |>
  mutate(muni_key = safe_filename(Muni_Name_With_Typ))

manifest  <- list()
muni_keys <- sort(unique(joined$muni_key))
cat("Writing", length(muni_keys), "shards ...\n")

for (key in muni_keys) {
  rows <- joined |> filter(muni_key == key)
  by_roll <- split(rows, rows$Roll_No_Txt)
  dict <- lapply(by_roll, function(r) {
    # A parcel can appear twice in one zone only if the fabric holds a
    # duplicate roll; keep the larger coverage rather than silently one of
    # them, so the cell states the strongest claim the evidence supports.
    z <- tapply(r$pct, r$code, max)
    list(z = as.list(z))
  })
  fname <- paste0(key, ".json")
  jsonlite::write_json(dict, file.path(output_dir, fname),
                       auto_unbox = TRUE, na = "null")
  manifest[[rows$Muni_Name_With_Typ[1]]] <- list(
    file  = fname,
    count = length(by_roll)
  )
}

# `_meta` carries the vintage for the Data Status dialog — same pattern as
# water/_index.json. Every consumer that walks this index filters on entries
# with a `file` string, so a key with no `file` passes through invisibly.
#
# The per-layer dates come from MBFloodMapping's own layers.yml and are FETCH
# dates, not boundary-change dates. See the header note.
layer_dates <- tryCatch({
  y <- yaml::read_yaml(file.path(flood_dir, "layers.yml"))$layers
  Filter(Negate(is.null), stats::setNames(
    lapply(ZONES, function(z) {
      entry <- Filter(function(e) identical(e$name, z$file), y)
      # refreshed_iso is a full timestamp; the date is the part that means
      # anything about a boundary, and a wall-clock time implies a currency
      # these layers do not have.
      if (length(entry)) substr(entry[[1]]$refreshed_iso, 1, 10) else NULL
    }),
    vapply(ZONES, function(z) z$code, character(1))
  ))
}, error = function(e) NULL)

manifest[["_meta"]] <- Filter(Negate(is.null), list(
  generated_at  = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  source        = basename(roll_path),
  flood_source  = "MBFloodMapping/data (full resolution)",
  layer_fetched = layer_dates
))
jsonlite::write_json(manifest, index_path, auto_unbox = TRUE, pretty = FALSE)

total_size_mb <- sum(file.info(list.files(output_dir, full.names = TRUE))$size) / 1024 / 1024
cat("Done.\n")
cat("  Output dir:", output_dir, "\n")
cat("  Manifest  :", index_path, "\n")
cat(sprintf("  Total size: %.2f MB across %d shards\n", total_size_mb, length(muni_keys)))
