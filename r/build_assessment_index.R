#!/usr/bin/env Rscript

# Build a per-roll latest-year assessment index from the MAO scrape's
# tax_history.parquet. The web app loads this shard to power the
# "Vacant land only" sales-CSV filter (and any future value-based
# filters / table columns).
#
# Output: web/public/data/assessment-index.json
#   {
#     version: 1,
#     fields: ["muni_no","roll_no_txt","year","land","buildings","total"],
#     metadata: {generated_at, source, source_modified, row_count, ...},
#     rows: [[muni_no, roll_no_txt, year, land, buildings, total], ...]
#   }
#
# Per-roll aggregation rules — mirror what the MAO summary page itself
# shows on its "TOTAL" line:
#   1. Drop rows where summable == FALSE. The scrape parser already
#      flags FARM MARKET VALUE as not-summable when FARM USE VALUE
#      coexists in the same year (those are alternate views of the
#      same physical land; summing them double-counts).
#   2. Pick the most recent tax_year per (muni_no, roll_no_txt). User
#      doesn't care which year — just want the latest signal we have.
#   3. Sum land / buildings / total across all surviving classes for
#      that year.
#   4. Drop rolls where the resulting total is 0 or NA — there's no
#      usable signal for the vacancy predicate.
#
# Path resolution (mirrors r/build_legal_index.R):
#   - --input  / MAO_TAX_HISTORY_PARQUET env  → tax_history.parquet
#   - --output / ASSESSMENT_INDEX_OUT env     → assessment-index.json
# Defaults look for ../ParcelSearch/mao-scrape/results/tax_history.parquet
# (same sibling repo as parcels.parquet for the legal index) and write
# to web/public/data/assessment-index.json under this repo's root.
#
# The output file is gitignored (matches legal-index.json). Refresh
# in production by uploading to a GitHub Release and bumping
# RELEASE_URL in api/assessment-index.js.

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(jsonlite)
})

script_path <- function() {
  args <- commandArgs(FALSE)
  file_arg <- grep("^--file=", args, value = TRUE)
  if (length(file_arg)) return(normalizePath(sub("^--file=", "", file_arg[[1]]), winslash = "/", mustWork = TRUE))
  normalizePath("r/build_assessment_index.R", winslash = "/", mustWork = TRUE)
}

parse_arg <- function(name, default = NULL) {
  prefix <- paste0("--", name, "=")
  hit <- grep(paste0("^", prefix), commandArgs(TRUE), value = TRUE)
  if (length(hit)) sub(paste0("^", prefix), "", hit[[1]]) else default
}

root <- normalizePath(file.path(dirname(script_path()), ".."), winslash = "/", mustWork = TRUE)
default_input <- file.path(
  dirname(root),
  "ParcelSearch", "mao-scrape", "results", "tax_history.parquet"
)
default_output <- file.path(root, "web", "public", "data", "assessment-index.json")

input <- normalizePath(
  parse_arg("input", Sys.getenv("MAO_TAX_HISTORY_PARQUET", default_input)),
  winslash = "/",
  mustWork = TRUE
)
output <- normalizePath(
  parse_arg("output", Sys.getenv("ASSESSMENT_INDEX_OUT", default_output)),
  winslash = "/",
  mustWork = FALSE
)

message("[assessment-index] reading ", input)
th <- read_parquet(input)

required_cols <- c("muni_no", "roll_no_txt", "tax_year", "land", "buildings", "total", "summable")
missing <- setdiff(required_cols, names(th))
if (length(missing)) {
  stop("Input parquet is missing expected columns: ", paste(missing, collapse = ", "))
}

# Per-row prep: drop non-summable rows, drop rows missing the join keys.
# `summable` already encodes the FARM MARKET vs FARM USE de-dup rule
# (see mao-scrape/scripts/parse_summary.R), so we just trust it.
th <- th |>
  filter(!is.na(summable) & summable) |>
  filter(!is.na(muni_no), !is.na(roll_no_txt), nzchar(roll_no_txt))

# Per (muni_no, roll_no_txt): pick the most recent tax_year, then sum
# land/buildings/total across the surviving classes for that year.
# `na.rm = TRUE` so a single missing land/buildings cell doesn't wipe
# out the whole year's sum.
agg <- th |>
  group_by(muni_no, roll_no_txt) |>
  filter(tax_year == max(tax_year, na.rm = TRUE)) |>
  group_by(muni_no, roll_no_txt, tax_year) |>
  summarise(
    land      = sum(land,      na.rm = TRUE),
    buildings = sum(buildings, na.rm = TRUE),
    total     = sum(total,     na.rm = TRUE),
    .groups = "drop"
  ) |>
  filter(is.finite(total) & total > 0) |>
  mutate(
    muni_no = as.integer(muni_no),
    tax_year = as.integer(tax_year),
    land = as.numeric(land),
    buildings = as.numeric(buildings),
    total = as.numeric(total)
  )

message(
  "[assessment-index] aggregated ", nrow(agg), " parcels; ",
  "year range ", min(agg$tax_year, na.rm = TRUE),
  "..", max(agg$tax_year, na.rm = TRUE)
)

# Quick sanity counters — surface the predicate hit-rate so the user
# can sanity-check after each rebuild without running the web app.
nominal_vacant_count <- sum(agg$land > 0 & (agg$buildings / agg$total) < 0.02, na.rm = TRUE)
true_vacant_count    <- sum(agg$buildings == 0 & agg$land > 0, na.rm = TRUE)
message(
  "[assessment-index] nominal vacant (buildings < 2% of total, land > 0): ", nominal_vacant_count,
  " · zero-buildings: ", true_vacant_count
)

# Pack into the same array-of-arrays shape legal-index uses so the JS
# loader can stay consistent. Field order matches the FIELD lookup in
# web/src/assessmentIndex.js — DO NOT REORDER without updating the JS.
fields <- c("muni_no", "roll_no_txt", "year", "land", "buildings", "total")

rows <- unname(lapply(seq_len(nrow(agg)), function(i) {
  list(
    agg$muni_no[i],
    as.character(agg$roll_no_txt[i]),
    agg$tax_year[i],
    agg$land[i],
    agg$buildings[i],
    agg$total[i]
  )
}))

payload <- list(
  version = 1,
  fields = fields,
  metadata = list(
    generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    source = input,
    source_modified = format(file.info(input)$mtime, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    row_count = nrow(agg),
    year_min = min(agg$tax_year, na.rm = TRUE),
    year_max = max(agg$tax_year, na.rm = TRUE),
    vacant_threshold_pct = 2,
    nominal_vacant_count = nominal_vacant_count,
    zero_buildings_count = true_vacant_count
  ),
  rows = rows
)

dir.create(dirname(output), recursive = TRUE, showWarnings = FALSE)
tmp <- tempfile("assessment-index-", fileext = ".json")
message("[assessment-index] writing ", output, " (", nrow(agg), " rows)")
writeLines(toJSON(payload, auto_unbox = TRUE, null = "null", digits = NA), tmp, useBytes = TRUE)
renamed <- file.rename(tmp, output)
if (!renamed) {
  copied <- file.copy(tmp, output, overwrite = TRUE)
  if (!copied) {
    stop("Failed to move generated index into place: ", output)
  }
  if (unlink(tmp) != 0) {
    warning("Generated temp file could not be removed: ", tmp)
  }
}

# File size for sanity — reviewer measured ~16.86 MiB, ~3.51 MiB gzipped.
out_size_mb <- round(file.info(output)$size / (1024 * 1024), 2)
message("[assessment-index] done — ", out_size_mb, " MiB on disk")
