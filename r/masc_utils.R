# Shared normalization helpers for the MASC square-section scrape.
#
# The refreshed MASC site can return more than one soil rating for the
# same legal quarter. Generated website data keeps the complete rating
# label (for example "C/H") while using the most conservative/worst code
# as the single map colour. Exact duplicates collapse into the same row.

masc_rating_codes <- LETTERS[1:10]

# ----------------------------------------------------------------------
# Locating the CURRENT MASC scrape output
# ----------------------------------------------------------------------
# The MASC-SCRAPE project moved to a "v2" layout that writes each refresh
# into its own timestamped run directory and marks it finished with a
# COMPLETE file. The published shards have come from v2 since the
# 2026-07-30 run.
#
# The legacy flat CSVs still sit in this repo's root and in the scrape
# project root, frozen at 2026-04-01. They are NOT the current data:
# 153,809 square-section rows against v2's 158,455, and no Range 29A
# coverage at all. Defaulting to them — which is what these scripts did
# until 2026-08-05 — means a plain `Rscript r/build_masc_shards.R`
# silently REPUBLISHES a four-month-old, less complete dataset over the
# good one. Nothing errors; the shard count just quietly drops.
#
# So the default now resolves to the newest COMPLETE v2 run and only
# falls back to the legacy file when no such run exists, saying so
# loudly when it does. An explicit env override still wins over both, so
# pinning a specific run for a rebuild stays possible.
#
# @param env_var   env var holding an explicit path (wins if set)
# @param v2_glob   filename pattern inside a run dir, e.g. "*_square_with_latlon_v2.csv"
# @param legacy    fallback path used when no completed v2 run is found
# @return absolute path to the CSV to read
resolve_masc_csv <- function(env_var, v2_glob, legacy) {
  override <- Sys.getenv(env_var)
  if (nzchar(override)) {
    return(normalizePath(override, winslash = "/", mustWork = FALSE))
  }

  run_root <- file.path(masc_scrape_root, "v2", "output")
  if (dir.exists(run_root)) {
    runs <- list.dirs(run_root, full.names = TRUE, recursive = FALSE)
    # Only runs that finished. A killed run leaves partial CSVs behind and
    # publishing those would be worse than publishing the stale ones.
    runs <- runs[file.exists(file.path(runs, "COMPLETE"))]
    if (length(runs)) {
      # Run dirs are named run_YYYYMMDD_HHMMSS, so a plain sort is chronological.
      for (run in rev(sort(runs))) {
        hit <- Sys.glob(file.path(run, v2_glob))
        if (length(hit)) {
          cat("MASC source: newest completed v2 run —", hit[1], "\n")
          return(normalizePath(hit[1], winslash = "/", mustWork = FALSE))
        }
      }
    }
  }

  cat("MASC source: NO completed v2 run found; falling back to", legacy, "\n")
  cat("  WARNING: the legacy CSVs are frozen at 2026-04-01 and are smaller and\n")
  cat("  less complete than v2. If a v2 run exists, publishing from this file\n")
  cat("  will REGRESS the live MASC data. Set", env_var, "to override.\n")
  normalizePath(legacy, winslash = "/", mustWork = FALSE)
}

read_masc_square_csv <- function(path) {
  # V2 is mostly numeric ranges, so readr's sample-based guessing sees
  # thousands of values such as 1..30 before the first 29A and otherwise
  # converts those late special values to NA.
  header <- names(readr::read_csv(path, n_max = 0L, show_col_types = FALSE))
  types <- if ("range" %in% header) {
    readr::cols(range = readr::col_character())
  } else {
    readr::cols()
  }
  readr::read_csv(
    path,
    col_types = types,
    show_col_types = FALSE
  )
}

collapse_masc_ratings <- function(values) {
  parts <- unlist(strsplit(as.character(values), "/", fixed = TRUE), use.names = FALSE)
  parts <- toupper(trimws(parts))
  parts <- unique(parts[parts %in% masc_rating_codes])
  paste(masc_rating_codes[masc_rating_codes %in% parts], collapse = "/")
}

worst_masc_rating <- function(values) {
  label <- collapse_masc_ratings(values)
  if (!nzchar(label)) return(NA_character_)
  tail(strsplit(label, "/", fixed = TRUE)[[1]], 1L)
}

first_non_missing <- function(values) {
  values <- values[!is.na(values)]
  if (is.character(values)) values <- values[nzchar(trimws(values))]
  if (length(values)) values[[1]] else NA
}

normalize_masc_square <- function(masc) {
  required <- c(
    "quarter", "section", "township", "direction", "soil_rating",
    "risk_area", "municipality", "lat", "lon"
  )
  missing <- setdiff(required, names(masc))
  if (length(missing)) {
    stop("MASC square CSV is missing required columns: ", paste(missing, collapse = ", "))
  }
  if (!"range" %in% names(masc) && !"range_num" %in% names(masc)) {
    stop("MASC square CSV must contain `range` (V2) or `range_num` (legacy).")
  }

  # V2's text `range` is authoritative because it preserves special
  # ranges such as 29A. The legacy source only has numeric range_num.
  range_values <- if ("range" %in% names(masc)) masc$range else masc$range_num

  masc |>
    dplyr::mutate(
      quarter = toupper(trimws(as.character(quarter))),
      section = as.integer(section),
      township = as.integer(township),
      range = toupper(trimws(as.character(range_values))),
      direction = toupper(trimws(as.character(direction))),
      soil_rating = toupper(trimws(as.character(soil_rating))),
      risk_area = suppressWarnings(as.integer(risk_area)),
      municipality = trimws(as.character(municipality)),
      lat = suppressWarnings(as.numeric(lat)),
      lon = suppressWarnings(as.numeric(lon))
    ) |>
    dplyr::filter(
      nzchar(quarter), !is.na(section), !is.na(township), nzchar(range),
      nzchar(direction), nzchar(soil_rating), nzchar(municipality)
    ) |>
    dplyr::group_by(
      quarter, section, township, range, direction, municipality
    ) |>
    dplyr::summarise(
      soil_ratings = collapse_masc_ratings(soil_rating),
      soil_rating = worst_masc_rating(soil_rating),
      risk_areas = paste(sort(unique(risk_area[!is.na(risk_area)])), collapse = "/"),
      risk_area = first_non_missing(risk_area),
      lat = first_non_missing(lat),
      lon = first_non_missing(lon),
      .groups = "drop"
    )
}
