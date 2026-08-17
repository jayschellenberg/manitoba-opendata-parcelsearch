# build_landcover.R
#
# Pre-bakes a farmland-oriented land-cover summary for every large
# (> ACRES_THRESHOLD acre, 10 by default) Roll_Entry parcel, so the
# frontend can show "what's on
# the ground" — cultivated vs pasture vs bush vs wetland — in the
# parcel popup and results grid without any raster work at render time.
#
# The heavy lifting (zonal extraction of the 2020 Land Cover raster,
# LCR_RCT_2020_MB.tif, against every Manitoba parcel polygon) is ALREADY
# done by the sister mao-assembly pipeline — its output Parquet carries
# a per-parcel percentage for each of the 12 land-cover classes. This
# script just BRIDGES that Parquet into the webapp's per-muni shard
# format, exactly the way build_parcel_masc.R bridges the MASC ratings.
# No raster is touched here; the 2020 land-cover layer is static, so the
# numbers only change when a parcel's geometry changes, which the
# mao-assembly run already re-extracts (and caches) on its own cadence.
#
# Inputs:
#   * mao-assembly/results/MAOParcelOutputAg<YYYYMMDD>.parquet
#       — most-recent assembly output. Columns used:
#           MuniCode               (int  MAO municipality code, e.g. 135)
#           TaxID                  (num  roll number, e.g. 100, 240.25)
#           CalcAcres              (num  UTM-14N calculated parcel area)
#           LandCoverPct_Class0..11 (num fraction 0-1 of each land class)
#   * RollEntry_YYYYMMDD.gpkg (layer "roll_entry")
#       — used ONLY for a stable MuniCode -> Muni_Name_With_Typ map
#         (e.g. 135 -> "HANOVER (RM)"), the exact muni string the
#         frontend keys shards by. Muni names don't drift the way
#         individual parcels do, so a slightly stale snapshot is fine.
#
# Keying: the per-parcel shard key (Roll_No_Txt) is RECONSTRUCTED from
# the Parquet's own roll, NOT looked up in the snapshot. Roll_No_Txt is
# always the roll formatted to exactly 3 decimals ("%.3f") — verified
# true for 100% of the snapshot (151030 -> "151030.000", 240.25 ->
# "240.250"). The muni comes from the MuniCode map above.
#
# WHY reconstruct instead of inner-joining the snapshot: a parcel can be
# in the assembly Parquet (and live ArcGIS) but MISSING from the
# RollEntry snapshot if the snapshot is a slightly different vintage —
# e.g. Rockwood 151030.000 had land cover in the Parquet but no snapshot
# row, so the old inner join dropped it and the live site showed no
# cover. Reconstructing keys every Parquet parcel off its own roll, so
# snapshot drift can no longer silently drop live parcels.
#
# Output:
#   web/public/data/landcover/<MUNI_KEY>.json
#       Per-municipality JSON shards keyed on Muni_Name_With_Typ (same
#       MUNI_KEY filename scheme as parcel-masc). Inside each shard a
#       flat dictionary keyed by Roll_No_Txt:
#         { "100.000": { "cult": 0.7774, "past": 0.031,
#                        "bush": 0.18, "wet": 0.0072, "other": 0.0044 },
#           ... }
#       The five buckets are fractions (0-1) of the parcel that sum to
#       ~1. Only parcels over ACRES_THRESHOLD acres (10 by default) are
#       written — urban/residential lots drop out, keeping the shards
#       small. The frontend derives
#       the dominant bucket + per-bucket acres (parcel acres x fraction)
#       client-side, so no labels or acreage are duplicated here.
#
#   web/public/data/landcover/_index.json
#       Manifest of Muni_Name_With_Typ -> { file, count }; same shape
#       as parcel-masc/_index.json so the frontend's existing
#       lookupMuniManifestEntry() resolves it with no changes.
#
# Bucket mapping (12 raster classes -> 5 farmland buckets), per Jason:
#   cult  Cultivated     = 2  Cropland
#   past  Pasture/Grass  = 7  Grassland & shrubland, 9 Sparsely vegetated
#   bush  Bush/Treed     = 4  Treed (non-wetland), 5 Treed wetland,
#                          6  Treed area disturbance
#   wet   Wetland/Water  = 3  Inland water, 8 Wetland (non-treed)
#   other Other          = 0  Too small, 1 Built-up, 10 Barren,
#                          11 Permanent snow & ice
#
# Runtime: seconds. Pure tabular join (no spatial ops) over the parcels
# that clear the acreage filter. Re-run whenever a fresh
# mao-assembly Parquet or RollEntry snapshot lands; output is committed
# to source control (small — a few MB across all shards).

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(sf)
  library(jsonlite)
  library(stringi)
})

# Shared roots (env-overridable) — see r/config.R.
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

source_dir   <- mb_parcelsearch_root
assembly_dir <- file.path(mao_assembly_root, "results")
# Shards publish into the local mb-parcel-data clone (served via jsDelivr
# pinned commit — see MB_PARCEL_DATA_CDN in arcgis.js).
output_dir   <- file.path(mb_parcel_data_root, "landcover")
index_path   <- file.path(output_dir, "_index.json")

ACRES_THRESHOLD <- 10  # only parcels strictly larger than this are sharded
                       # KEEP IN SYNC with LAND_COVER_MIN_ACRES in
                       # web/src/lib/landcover.js — the webapp gates display
                       # on the same value so the two never drift.

dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

# ----------------------------------------------------------------------
# 1. Locate the most recent COMPLETE mao-assembly land-cover Parquet
# ----------------------------------------------------------------------
# The assembly occasionally leaves a partial/aborted run in this dir —
# e.g. a job that stopped after processing only the first handful of
# municipalities (alphabetical), producing a Parquet with ~50k rows
# instead of the full ~430k. Selecting purely by newest filename would
# silently pick that partial and collapse the shards to a few munis.
#
# So: read each candidate's row count (cheap — Parquet metadata, no
# data read), treat anything within 80% of the largest as a "complete"
# province-wide run, and take the newest of those by filename date. A
# newer-but-partial Parquet is skipped with a loud NOTE so the operator
# knows to investigate (likely an aborted assembly run to re-run).
pq_files <- list.files(assembly_dir,
                       pattern = "^MAOParcelOutputAg\\d{8}\\.parquet$",
                       full.names = TRUE)
if (length(pq_files) == 0L) {
  stop("No MAOParcelOutputAg<YYYYMMDD>.parquet found in ", assembly_dir,
       ". Run the mao-assembly pipeline first.")
}
pq_rows <- vapply(pq_files, function(f) {
  tryCatch(as.integer(nrow(arrow::open_dataset(f))), error = function(e) NA_integer_)
}, integer(1))
ok <- !is.na(pq_rows)
if (!any(ok)) stop("Could not read row counts from any Parquet in ", assembly_dir)
pq_files <- pq_files[ok]; pq_rows <- pq_rows[ok]
COMPLETE_FRAC <- 0.80
complete <- pq_rows >= COMPLETE_FRAC * max(pq_rows)
pq_path  <- tail(sort(pq_files[complete]), 1L)   # newest complete run by filename date
newest   <- tail(sort(pq_files), 1L)
if (!identical(pq_path, newest)) {
  message(sprintf(
    "NOTE: newest Parquet %s has only %s rows (< %.0f%% of the %s-row full run %s) — looks PARTIAL/aborted; using %s instead.",
    basename(newest), format(pq_rows[pq_files == newest], big.mark = ","),
    100 * COMPLETE_FRAC, format(max(pq_rows), big.mark = ","),
    basename(pq_path), basename(pq_path)))
}
cat("Reading land-cover Parquet:", basename(pq_path),
    sprintf("(%s rows)\n", format(pq_rows[pq_files == pq_path], big.mark = ",")))

lc_cols <- paste0("LandCoverPct_Class", 0:11)
pq <- arrow::open_dataset(pq_path) |>
  dplyr::select(dplyr::all_of(c("MuniCode", "Municipality", "TaxID", "CalcAcres", lc_cols))) |>
  dplyr::collect()
cat("  parcels in Parquet:", nrow(pq), "\n")

# ----------------------------------------------------------------------
# 2. Filter to farmland-scale parcels, collapse 12 classes -> 5 buckets
# ----------------------------------------------------------------------
# Treat missing class percentages as 0 so the bucket sums stay well
# defined even if the assembly extraction left a NA somewhere.
z <- function(x) ifelse(is.na(x), 0, x)

pq <- pq |>
  filter(!is.na(CalcAcres), CalcAcres > ACRES_THRESHOLD)
cat("  parcels over", ACRES_THRESHOLD, "acres:", nrow(pq), "\n")

# Reconstruct the frontend key directly from the Parquet roll instead of
# inner-joining to the RollEntry snapshot. Roll_No_Txt is ALWAYS the roll
# formatted to exactly 3 decimals ("%.3f") — verified true for 100% of
# the RollEntry snapshot (e.g. 151030 -> "151030.000", 240.25 ->
# "240.250"). Reconstructing means a parcel present in the Parquet but
# MISSING from the (sometimes slightly stale) RollEntry snapshot still
# gets land cover — previously the inner join silently dropped those,
# which is exactly how live parcels like Rockwood 151030.000 showed no
# cover despite having data. The snapshot is now used ONLY for the stable
# MuniCode -> Muni_Name_With_Typ map (section 3), not per-parcel keys.
pq <- pq |>
  mutate(
    cult  = round(z(LandCoverPct_Class2), 4),
    past  = round(z(LandCoverPct_Class7) + z(LandCoverPct_Class9), 4),
    bush  = round(z(LandCoverPct_Class4) + z(LandCoverPct_Class5) + z(LandCoverPct_Class6), 4),
    wet   = round(z(LandCoverPct_Class3) + z(LandCoverPct_Class8), 4),
    other = round(z(LandCoverPct_Class0) + z(LandCoverPct_Class1) +
                  z(LandCoverPct_Class10) + z(LandCoverPct_Class11), 4),
    roll_num    = suppressWarnings(as.numeric(TaxID)),
    Roll_No_Txt = sprintf("%.3f", roll_num),
    MuniCode    = suppressWarnings(as.integer(MuniCode))
  ) |>
  filter(!is.na(MuniCode), !is.na(roll_num)) |>
  select(MuniCode, Municipality, Roll_No_Txt, cult, past, bush, wet, other)

# A given (MuniCode, roll) should be unique; guard anyway.
dup_key <- paste0(pq$MuniCode, "|", pq$Roll_No_Txt)
if (anyDuplicated(dup_key)) {
  warning(sum(duplicated(dup_key)),
          " duplicate (MuniCode, roll) keys in Parquet — keeping first of each")
  pq <- pq[!duplicated(dup_key), ]
}

# ----------------------------------------------------------------------
# 3. MuniCode -> Muni_Name_With_Typ map from the RollEntry snapshot
# ----------------------------------------------------------------------
# This is the ONLY thing we need from the snapshot now — a stable,
# verified-1:1 lookup from the integer muni code to the exact
# Muni_Name_With_Typ string the live frontend keys shards by. Muni names
# don't drift the way individual parcels do, so a slightly stale snapshot
# is fine here. We only need attributes, so the SQL select omits geometry.
roll_files <- list.files(source_dir, pattern = "^RollEntry_\\d{8}\\.gpkg$",
                         full.names = TRUE)
if (length(roll_files) == 0L) {
  stop("No RollEntry_YYYYMMDD.gpkg found in ", source_dir,
       ". Run r/download_parcels.R first.")
}
roll_path <- tail(sort(roll_files), 1L)
cat("Reading Roll_Entry muni map:", basename(roll_path), "\n")

re <- sf::st_read(
  roll_path,
  query = 'SELECT DISTINCT "Municipality", "Muni_Name_With_Typ" FROM "roll_entry"',
  quiet = TRUE
)
muni_map <- re |>
  mutate(MuniCode = suppressWarnings(as.integer(sub("\\s*-.*$", "", Municipality)))) |>
  filter(!is.na(MuniCode), !is.na(Muni_Name_With_Typ), nzchar(Muni_Name_With_Typ)) |>
  distinct(MuniCode, Muni_Name_With_Typ)
cat("  muni codes mapped:", nrow(muni_map), "\n")

# ----------------------------------------------------------------------
# 4. Attach the muni name to every Parquet parcel (left join keeps ALL)
# ----------------------------------------------------------------------
# Fallback: for any MuniCode missing from the snapshot map (none today,
# but defensive), derive a name from the Parquet's own Municipality
# field (uppercased) so the parcel still gets sharded rather than dropped.
n_fallback <- sum(!pq$MuniCode %in% muni_map$MuniCode)
if (n_fallback > 0) {
  cat(sprintf("  NOTE: %d parcels in MuniCodes absent from the snapshot map — named from Parquet Municipality fallback\n",
              n_fallback))
}
joined <- pq |>
  left_join(muni_map, by = "MuniCode") |>
  mutate(Muni_Name_With_Typ = dplyr::coalesce(Muni_Name_With_Typ, toupper(Municipality))) |>
  filter(!is.na(Muni_Name_With_Typ), nzchar(Muni_Name_With_Typ)) |>
  select(Roll_No_Txt, Muni_Name_With_Typ, cult, past, bush, wet, other)

cat("  parcels with land cover:", nrow(joined),
    sprintf("(%.1f%% of >%dac Parquet rows)\n",
            100 * nrow(joined) / max(1, nrow(pq)), ACRES_THRESHOLD))

# ----------------------------------------------------------------------
# 5. Per-muni shards
# ----------------------------------------------------------------------
# Filename-safe form of Muni_Name_With_Typ (e.g. "HANOVER (RM)" ->
# "HANOVER_RM"). Identical to build_parcel_masc.R so the two pipelines'
# shard filenames line up.
safe_filename <- function(x) {
  x |>
    stringi::stri_trans_general(id = "Latin-ASCII") |>
    toupper() |>
    gsub(pattern = "[^A-Z0-9._-]+", replacement = "_") |>
    gsub(pattern = "_+",            replacement = "_") |>
    gsub(pattern = "^_|_$",         replacement = "")
}

joined <- joined |>
  mutate(muni_key = safe_filename(Muni_Name_With_Typ))

manifest  <- list()
muni_keys <- sort(unique(joined$muni_key))
cat("Writing", length(muni_keys), "shards ...\n")

for (key in muni_keys) {
  rows <- joined |> filter(muni_key == key)

  # Per-roll dictionary -> tiny JSON, O(1) lookup on the frontend.
  dict <- setNames(
    lapply(seq_len(nrow(rows)), function(i) {
      list(
        cult  = rows$cult[i],
        past  = rows$past[i],
        bush  = rows$bush[i],
        wet   = rows$wet[i],
        other = rows$other[i]
      )
    }),
    rows$Roll_No_Txt
  )

  fname <- paste0(key, ".json")
  jsonlite::write_json(dict, file.path(output_dir, fname),
                       auto_unbox = TRUE, digits = 4, na = "null")
  manifest[[rows$Muni_Name_With_Typ[1]]] <- list(
    file  = fname,
    count = nrow(rows)
  )
}

# Manifest indexed by Muni_Name_With_Typ (original dropdown value, not
# the safe filename) so the frontend resolves it directly.
#
# `_meta` carries the dataset's vintage for the Data Status dialog — same
# pattern as masc/_index.json (r/build_masc_shards.R). The source filename
# embeds the assembly run date (MAOParcelOutputAg<YYYYMMDD>). Every consumer
# that walks this index filters on entries with a `file` string
# (lookupMuniManifestEntry, shardIndexEntries), so a key with no `file`
# passes through them invisibly.
manifest[["_meta"]] <- list(
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  source = basename(pq_path)
)
jsonlite::write_json(manifest, index_path, auto_unbox = TRUE, pretty = FALSE)

total_size_mb <- sum(file.info(list.files(output_dir, full.names = TRUE))$size) / 1024 / 1024
cat("Done.\n")
cat("  Output dir:", output_dir, "\n")
cat("  Manifest  :", index_path, "\n")
cat(sprintf("  Total size: %.1f MB across all shards\n", total_size_mb))
