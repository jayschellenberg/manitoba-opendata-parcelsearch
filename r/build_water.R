# build_water.R
#
# Bridges per-parcel WATER INFLUENCE (waterfront / near-water classification)
# into the webapp's per-muni shard format, the same way build_landcover.R
# bridges land cover.
#
# WHAT THIS IS
# ------------
# Four columns per parcel, produced by the V6.1 waterfront detection:
#
#   WaterInfluence       "Yes" / "No"
#   WaterInfluenceClass  Direct | Waterfront | Reserve Separated |
#                        Road Separated | Corridor Blocked |
#                        No Corroboration | None
#   WaterBodyType        Lake | Watercourse | Reservoir | Retention Pond |
#                        Water | Pond | Canal | Unknown
#   WaterBody            Name, e.g. "Red River", "Lake Manitoba",
#                        "Retention Pond"
#
# The class matters for appraisal and is NOT reducible to the Yes/No flag:
# "Road Separated" and "Corridor Blocked" are parcels near water with no
# frontage — the second-row cohort, often with a view. Keep all four fields.
#
# SOURCE, AND THE PLANNED MIGRATION OFF IT
# ----------------------------------------
# Today the columns are computed by the sister mao-assembly pipeline and read
# out of its output Parquet. That is a dependency this repo is meant to shed —
# the goal is for mb-parcelsearch to stand alone so mao-assembly can be
# deleted. Two things make that switch cheap when the detection is ported:
#
#   1. The source directory is a single variable (`water_parquet_dir`), also
#      settable via the MB_WATER_PARQUET_DIR environment variable. Point it at
#      a locally-produced Parquet and nothing else in this script changes.
#   2. Everything downstream — the shard format, the manifest, the webapp
#      fetcher — is keyed on the four column names above, not on where they
#      came from.
#
# NOTE — the NON-Ag Parquet:
#   build_landcover.R reads MAOParcelOutputAg<date>.parquet because land cover
#   only exists on farmland-scale parcels. Water influence is the opposite:
#   it matters MOST for residential — lakefront cottages, riverfront lots,
#   subdivision retention ponds. So this script reads the full
#   MAOParcelOutput<date>.parquet. Reading the Ag variant here would silently
#   drop exactly the parcels the feature exists for.
#
# INPUTS
#   <water_parquet_dir>/MAOParcelOutput<YYYYMMDD>.parquet
#       MuniCode, Municipality, TaxID + the four water columns.
#   <repo>/RollEntry_<YYYYMMDD>.gpkg
#       Used ONLY for a stable MuniCode -> Muni_Name_With_Typ map, exactly as
#       build_landcover.R does. Muni names don't drift the way parcels do, so
#       a slightly stale snapshot is fine here.
#
# OUTPUT
#   <mb-parcel-data>/water/<MUNI_KEY>.json
#       Flat dictionary keyed by Roll_No_Txt. Compact keys to keep the payload
#       small across ~180 shards:
#         { "3600.000": { "i":"Yes", "c":"Direct", "t":"Lake", "b":"Lake Winnipeg" } }
#   <mb-parcel-data>/water/_index.json
#       { "<Muni_Name_With_Typ>": { "file": "...", "count": N } }
#
# ABSENCE SEMANTICS — read this before changing the filter.
#   Only parcels with WaterInfluenceClass != "None" are shipped. 370k of 437k
#   parcels are "None", and shipping them would inflate the payload ~6x to say
#   nothing. So on the frontend:
#       muni in _index AND roll absent  -> genuinely None (no water within 50m)
#       muni NOT in _index              -> shard never built; state unknown
#   That distinction is the same three-state problem the Tile Drainage column
#   already handles (Yes / No record / not loaded). Do not collapse it.

suppressPackageStartupMessages({
  library(dplyr)
  library(arrow)
  library(sf)
  library(jsonlite)
  library(stringi)
})

# Shared roots (env-overridable) — see r/config.R.
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

source_dir <- mb_parcelsearch_root
# The one line to change when the detection is ported into this repo.
water_parquet_dir <- Sys.getenv("MB_WATER_PARQUET_DIR",
                                unset = file.path(mao_assembly_root, "results"))
output_dir <- file.path(mb_parcel_data_root, "water")
index_path <- file.path(output_dir, "_index.json")

# Same completeness guard as build_landcover.R: an aborted pipeline run leaves
# a newer-but-partial Parquet behind, and picking it would silently collapse
# the shards to whichever municipalities happened to finish.
COMPLETE_FRAC <- 0.80

dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

# ----------------------------------------------------------------------
# 1. Locate the most recent COMPLETE Parquet
# ----------------------------------------------------------------------
# Anchored pattern: MAOParcelOutput<date>, NOT MAOParcelOutputAg<date>. The
# "Ag" variant is a farmland subset — see the header note.
pq_files <- list.files(water_parquet_dir,
                       pattern = "^MAOParcelOutput\\d{8}\\.parquet$",
                       full.names = TRUE)
if (length(pq_files) == 0L) {
  stop("No MAOParcelOutput<YYYYMMDD>.parquet found in ", water_parquet_dir,
       ".\nRun the waterfront pipeline first, or set MB_WATER_PARQUET_DIR.")
}

pq_rows <- vapply(pq_files, function(f) {
  tryCatch(nrow(arrow::open_dataset(f)), error = function(e) NA_integer_)
}, integer(1))
ok <- !is.na(pq_rows)
if (!any(ok)) stop("Could not read row counts from any Parquet in ", water_parquet_dir)
pq_files <- pq_files[ok]; pq_rows <- pq_rows[ok]

complete <- pq_rows >= COMPLETE_FRAC * max(pq_rows)
pq_path  <- tail(sort(pq_files[complete]), 1L)
newest   <- tail(sort(pq_files), 1L)
if (!identical(pq_path, newest)) {
  cat(sprintf(paste0("NOTE: newest Parquet %s has only %s rows (< %.0f%% of the ",
                     "%s-row full run) — looks PARTIAL/aborted; using %s instead.\n"),
              basename(newest), format(pq_rows[pq_files == newest], big.mark = ","),
              100 * COMPLETE_FRAC, format(max(pq_rows), big.mark = ","),
              basename(pq_path)))
}
cat("Reading water Parquet:", basename(pq_path),
    sprintf("(%s rows)\n", format(pq_rows[pq_files == pq_path], big.mark = ",")))

water_cols <- c("WaterInfluence", "WaterInfluenceClass", "WaterBodyType", "WaterBody")
pq <- arrow::open_dataset(pq_path)
missing_cols <- setdiff(c("MuniCode", "Municipality", "TaxID", water_cols), names(pq))
if (length(missing_cols)) {
  stop("Parquet ", basename(pq_path), " is missing: ",
       paste(missing_cols, collapse = ", "),
       "\nIt predates the waterfront detection — re-run the pipeline.")
}
pq <- pq |>
  dplyr::select(dplyr::all_of(c("MuniCode", "Municipality", "TaxID", water_cols))) |>
  dplyr::collect()
cat("  parcels in Parquet:", format(nrow(pq), big.mark = ","), "\n")

# ----------------------------------------------------------------------
# 2. Keep only parcels with something to say, and rebuild the frontend key
# ----------------------------------------------------------------------
# Roll_No_Txt is ALWAYS the roll formatted to exactly 3 decimals — the same
# reconstruction build_landcover.R uses and verified against the RollEntry
# snapshot. Reconstructing (rather than joining) means a parcel present in the
# Parquet but missing from a slightly stale snapshot still gets its water data.
pq <- pq |>
  filter(!is.na(WaterInfluenceClass), WaterInfluenceClass != "None") |>
  mutate(
    roll_num    = suppressWarnings(as.numeric(TaxID)),
    Roll_No_Txt = sprintf("%.3f", roll_num),
    MuniCode    = suppressWarnings(as.integer(MuniCode))
  ) |>
  filter(!is.na(MuniCode), !is.na(roll_num)) |>
  select(MuniCode, Municipality, Roll_No_Txt, dplyr::all_of(water_cols))

cat("  parcels with water influence:", format(nrow(pq), big.mark = ","), "\n")
cat("  of which WaterInfluence = Yes:",
    format(sum(pq$WaterInfluence == "Yes", na.rm = TRUE), big.mark = ","), "\n")

dup_key <- paste0(pq$MuniCode, "|", pq$Roll_No_Txt)
if (anyDuplicated(dup_key)) {
  warning(sum(duplicated(dup_key)),
          " duplicate (MuniCode, roll) keys in Parquet — keeping first of each")
  pq <- pq[!duplicated(dup_key), ]
}

# ----------------------------------------------------------------------
# 3. MuniCode -> Muni_Name_With_Typ map from the RollEntry snapshot
# ----------------------------------------------------------------------
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

n_fallback <- sum(!pq$MuniCode %in% muni_map$MuniCode)
if (n_fallback > 0) {
  cat(sprintf("  NOTE: %d parcels in MuniCodes absent from the snapshot map — named from Parquet Municipality fallback\n",
              n_fallback))
}
joined <- pq |>
  left_join(muni_map, by = "MuniCode") |>
  mutate(Muni_Name_With_Typ = dplyr::coalesce(Muni_Name_With_Typ, toupper(Municipality))) |>
  filter(!is.na(Muni_Name_With_Typ), nzchar(Muni_Name_With_Typ)) |>
  select(Roll_No_Txt, Muni_Name_With_Typ, dplyr::all_of(water_cols))

# ----------------------------------------------------------------------
# 4. Per-muni shards
# ----------------------------------------------------------------------
# Identical to build_landcover.R / build_parcel_masc.R so shard filenames line
# up across every pipeline the frontend reads.
safe_filename <- function(x) {
  x |>
    stringi::stri_trans_general(id = "Latin-ASCII") |>
    toupper() |>
    gsub(pattern = "[^A-Z0-9._-]+", replacement = "_") |>
    gsub(pattern = "_+",            replacement = "_") |>
    gsub(pattern = "^_|_$",         replacement = "")
}

joined <- joined |> mutate(muni_key = safe_filename(Muni_Name_With_Typ))

manifest  <- list()
muni_keys <- sort(unique(joined$muni_key))
cat("Writing", length(muni_keys), "shards ...\n")

# Drop empty strings to null so the frontend can test one way for "absent".
nz <- function(x) if (is.na(x) || !nzchar(x)) NULL else x

for (key in muni_keys) {
  rows <- joined |> filter(muni_key == key)
  dict <- setNames(
    lapply(seq_len(nrow(rows)), function(i) {
      Filter(Negate(is.null), list(
        i = nz(rows$WaterInfluence[i]),
        c = nz(rows$WaterInfluenceClass[i]),
        t = nz(rows$WaterBodyType[i]),
        b = nz(rows$WaterBody[i])
      ))
    }),
    rows$Roll_No_Txt
  )
  fname <- paste0(key, ".json")
  jsonlite::write_json(dict, file.path(output_dir, fname),
                       auto_unbox = TRUE, na = "null")
  manifest[[rows$Muni_Name_With_Typ[1]]] <- list(
    file  = fname,
    count = nrow(rows),
    yes   = sum(rows$WaterInfluence == "Yes", na.rm = TRUE)
  )
}

jsonlite::write_json(manifest, index_path, auto_unbox = TRUE, pretty = FALSE)

total_size_mb <- sum(file.info(list.files(output_dir, full.names = TRUE))$size) / 1024 / 1024
cat("Done.\n")
cat("  Output dir:", output_dir, "\n")
cat("  Manifest  :", index_path, "\n")
cat(sprintf("  Total size: %.2f MB across %d shards\n", total_size_mb, length(muni_keys)))
