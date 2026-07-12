# build_masc_shards.R
#
# Splits the MASC soil-ratings CSV (~150k rows, ~8 MB) into per-municipality
# JSON shards under web/public/data/masc/ so the parcel-search frontend can
# fetch only the active muni's ratings on toggle. Same shard pattern the
# legal-search index uses; gitignored generated artifacts.
#
# Input  : masc_soil_ratings_with_latlon.csv (CSV with quarter, section,
#          township, range_num, direction, soil_rating, risk_area,
#          municipality, lat, lon)
# Output : web/public/data/masc/<MUNI_KEY>.json, plus
#          web/public/data/masc/_index.json — a manifest of muni keys with
#          row counts so the frontend can show "no MASC data" without a
#          404. Muni keys are normalized for matching against
#          Roll_Entry's Muni_Name_With_Typ values: uppercase, dashes
#          collapsed, accents stripped (same shape as
#          normalizeMuniKey() in main.js).
#
# Shard structure: a flat array of compact records to keep payload small.
#   [
#     { "q": "NE", "s": 1,  "t": 1,  "r": 1,  "d": "W", "rating": "D",
#       "ra": 32, "lat": 49.01159924, "lon": -97.46536894 },
#     ...
#   ]
#
# Re-run after a fresh masc_soil_ratings_with_latlon.csv lands. Typical
# runtime: ~10 seconds on the full 150k-row CSV.

suppressPackageStartupMessages({
  library(dplyr)
  library(jsonlite)
  library(readr)
  library(stringi)
})

# Shared roots (env-overridable) — see r/config.R.
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

input_path  <- file.path(mb_parcelsearch_root, "masc_soil_ratings_with_latlon.csv")
# Shards publish into the local mb-parcel-data clone (served to the app
# via jsDelivr pinned commit — see MB_PARCEL_DATA_CDN in arcgis.js).
output_dir  <- file.path(mb_parcel_data_root, "masc")
index_path  <- file.path(output_dir, "_index.json")

if (!file.exists(input_path)) {
  stop("Cannot find ", input_path, " in the project root. Run from the repo root.")
}

dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)

cat("Reading", input_path, "...\n")
masc <- readr::read_csv(input_path, show_col_types = FALSE)
cat("  rows:", nrow(masc), "; munis:", length(unique(masc$municipality)), "\n")

# Normalize muni key the same way the frontend's normalizeMuniKey() does:
# uppercase, strip diacritics, collapse whitespace, normalize dashes.
# Source CSV's `municipality` column is the bare muni name (no type
# suffix). We don't have the type here, so the frontend's lookup builds
# multiple candidate keys (with and without the type) when it queries
# this index — see fetchMascRatingsForMuni in arcgis.js.
normalize_muni <- function(x) {
  x |>
    stringi::stri_trans_general(id = "Latin-ASCII") |>
    toupper() |>
    gsub(pattern = "[‐-―−]", replacement = "-") |>
    gsub(pattern = "\\s+",                    replacement = " ") |>
    trimws()
}

masc <- masc |>
  mutate(muni_key = normalize_muni(municipality))

# Drop any row that didn't normalize to a usable key.
masc <- masc |> filter(!is.na(muni_key) & nzchar(muni_key))

# Filename-safe form of the muni key. Replace anything not [A-Z0-9._-] with
# underscore; collapse runs.
safe_filename <- function(key) {
  key |>
    gsub(pattern = "[^A-Z0-9._-]+", replacement = "_") |>
    gsub(pattern = "_+",            replacement = "_")
}

manifest <- list()
muni_keys <- sort(unique(masc$muni_key))
cat("Writing shards (", length(muni_keys), "munis) ...\n")

for (key in muni_keys) {
  rows <- masc |>
    filter(muni_key == key) |>
    transmute(
      q      = quarter,
      s      = as.integer(section),
      t      = as.integer(township),
      r      = as.integer(range_num),
      d      = direction,
      rating = soil_rating,
      ra     = as.integer(risk_area),
      lat    = round(lat, 6),
      lon    = round(lon, 6)
    )

  fname <- paste0(safe_filename(key), ".json")
  fpath <- file.path(output_dir, fname)
  jsonlite::write_json(rows, fpath, dataframe = "rows", auto_unbox = TRUE,
                       digits = 6, na = "null")
  manifest[[key]] <- list(file = fname, count = nrow(rows))
}

# Manifest indexed by normalized key so the frontend can look up an
# entry without listing the directory at runtime.
jsonlite::write_json(manifest, index_path, auto_unbox = TRUE, pretty = FALSE)

cat("Done.\n")
cat("  Output dir:", output_dir, "\n")
cat("  Manifest  :", index_path, "\n")
cat("  Total munis:", length(manifest), "\n")
total_size_mb <- sum(file.info(list.files(output_dir, full.names = TRUE))$size) / 1024 / 1024
cat(sprintf("  Total size: %.1f MB across all shards\n", total_size_mb))
