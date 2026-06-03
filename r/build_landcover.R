# build_landcover.R
#
# Pre-bakes a farmland-oriented land-cover summary for every large
# (> 20 acre) Roll_Entry parcel, so the frontend can show "what's on
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
#       — same parcel snapshot the live site keys off. Supplies the
#         EXACT Roll_No_Txt ("100.000") and Muni_Name_With_Typ
#         ("HANOVER (RM)") strings the frontend looks parcels up by.
#         The Parquet alone can't be sharded directly: its TaxID is the
#         bare number (100) and its Municipality is title-case, neither
#         of which match the live ROLL_ENTRY keys.
#
# Join key: (MuniCode, roll). Roll numbers repeat across munis (every
# RM has a "100.000"), so muni MUST be part of the key. We match the
# Parquet's MuniCode against the integer prefix of Roll_Entry's
# Municipality field ("135 - RM OF HANOVER" -> 135), and the Parquet's
# numeric TaxID against Roll_Entry's numeric Roll_No, both scaled to
# integer thousandths to dodge float-formatting drift. ~99.9% of
# Roll_Entry parcels match.
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
#       ~1. Only parcels > 20 acres are written — urban/residential
#       lots drop out, keeping the shards small. The frontend derives
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
# Runtime: seconds. Pure tabular join (no spatial ops) over the ~150-200k
# parcels that clear the 20-acre filter. Re-run whenever a fresh
# mao-assembly Parquet or RollEntry snapshot lands; output is committed
# to source control (small — a few MB across all shards).

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(sf)
  library(jsonlite)
  library(stringi)
})

source_dir   <- "D:/Dropbox/ClaudeCode/MBOpenData/WebSearch"
assembly_dir <- "D:/Dropbox/Appraisal/RProjects/appraisal-templates/mao-assembly/results"
output_dir   <- file.path(source_dir, "web/public/data/landcover")
index_path   <- file.path(output_dir, "_index.json")

ACRES_THRESHOLD <- 20  # only parcels strictly larger than this are sharded

dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

# ----------------------------------------------------------------------
# 1. Locate the most recent mao-assembly land-cover Parquet
# ----------------------------------------------------------------------
pq_files <- list.files(assembly_dir,
                       pattern = "^MAOParcelOutputAg\\d{8}\\.parquet$",
                       full.names = TRUE)
if (length(pq_files) == 0L) {
  stop("No MAOParcelOutputAg<YYYYMMDD>.parquet found in ", assembly_dir,
       ". Run the mao-assembly pipeline first.")
}
pq_path <- tail(sort(pq_files), 1L)   # date in filename -> lexical sort = chronological
cat("Reading land-cover Parquet:", basename(pq_path), "\n")

lc_cols <- paste0("LandCoverPct_Class", 0:11)
pq <- arrow::open_dataset(pq_path) |>
  dplyr::select(dplyr::all_of(c("MuniCode", "TaxID", "CalcAcres", lc_cols))) |>
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

pq <- pq |>
  mutate(
    cult  = round(z(LandCoverPct_Class2), 4),
    past  = round(z(LandCoverPct_Class7) + z(LandCoverPct_Class9), 4),
    bush  = round(z(LandCoverPct_Class4) + z(LandCoverPct_Class5) + z(LandCoverPct_Class6), 4),
    wet   = round(z(LandCoverPct_Class3) + z(LandCoverPct_Class8), 4),
    other = round(z(LandCoverPct_Class0) + z(LandCoverPct_Class1) +
                  z(LandCoverPct_Class10) + z(LandCoverPct_Class11), 4),
    roll_num = suppressWarnings(as.numeric(TaxID))
  ) |>
  filter(!is.na(MuniCode), !is.na(roll_num)) |>
  mutate(join_key = paste0(MuniCode, "|", sprintf("%.0f", round(roll_num * 1000)))) |>
  select(join_key, cult, past, bush, wet, other)

if (anyDuplicated(pq$join_key)) {
  warning(sum(duplicated(pq$join_key)),
          " duplicate (MuniCode, roll) keys in Parquet — keeping first of each")
  pq <- pq[!duplicated(pq$join_key), ]
}

# ----------------------------------------------------------------------
# 3. Load Roll_Entry attributes for the exact frontend keys
# ----------------------------------------------------------------------
# We only need attributes, not geometry — read with a SQL select that
# omits the geom column so st_read returns a plain data.frame and skips
# parsing 430k polygons.
roll_files <- list.files(source_dir, pattern = "^RollEntry_\\d{8}\\.gpkg$",
                         full.names = TRUE)
if (length(roll_files) == 0L) {
  stop("No RollEntry_YYYYMMDD.gpkg found in ", source_dir,
       ". Run r/download_parcels.R first.")
}
roll_path <- tail(sort(roll_files), 1L)
cat("Reading Roll_Entry attributes:", basename(roll_path), "\n")

re <- sf::st_read(
  roll_path,
  query = paste0('SELECT "Roll_No", "Roll_No_Txt", "Municipality", ',
                 '"Muni_Name_With_Typ" FROM "roll_entry"'),
  quiet = TRUE
)
cat("  Roll_Entry parcels:", nrow(re), "\n")

re <- re |>
  mutate(
    muni_code = suppressWarnings(as.integer(sub("\\s*-.*$", "", Municipality))),
    roll_num  = suppressWarnings(as.numeric(Roll_No))
  ) |>
  filter(!is.na(muni_code), !is.na(roll_num),
         !is.na(Muni_Name_With_Typ), nzchar(Muni_Name_With_Typ),
         !is.na(Roll_No_Txt)) |>
  mutate(join_key = paste0(muni_code, "|", sprintf("%.0f", round(roll_num * 1000))))

# ----------------------------------------------------------------------
# 4. Join land-cover buckets onto Roll_Entry rows
# ----------------------------------------------------------------------
joined <- re |>
  select(join_key, Roll_No_Txt, Muni_Name_With_Typ) |>
  inner_join(pq, by = "join_key")
cat("  parcels with land cover (joined):", nrow(joined),
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
jsonlite::write_json(manifest, index_path, auto_unbox = TRUE, pretty = FALSE)

total_size_mb <- sum(file.info(list.files(output_dir, full.names = TRUE))$size) / 1024 / 1024
cat("Done.\n")
cat("  Output dir:", output_dir, "\n")
cat("  Manifest  :", index_path, "\n")
cat(sprintf("  Total size: %.1f MB across all shards\n", total_size_mb))
