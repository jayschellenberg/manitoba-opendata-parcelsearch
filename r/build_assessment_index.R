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

required_cols <- c("muni_no", "roll_no_txt", "tax_year", "class", "tax_status",
                   "land", "buildings", "total", "summable")
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
#
# Class + status: many parcels carry MULTIPLE classes in the same year
# (e.g. RESIDENTIAL 1 + FARM PROPERTY + OTHER PROPERTY). For filter UX
# we collapse to a single dominant class — the one with the largest
# `total` value for that parcel-year. That's the assessment line most
# of the property's value sits in, and it's what most appraisers mean
# when they say "what kind of property is this." Same logic for status.
# Ties broken by alphabetical first.
latest <- th |>
  group_by(muni_no, roll_no_txt) |>
  filter(tax_year == max(tax_year, na.rm = TRUE)) |>
  ungroup()

# The MAO scrape sometimes emits class names with HTML entities un-
# decoded (e.g. `RESIDENTIAL 3--CONDOS &amp; CO-OPS`). Normalise the
# handful that show up so the filter dropdown doesn't display the
# same class twice. Only the &amp; case has been observed; covering
# the other common entities defensively in case more sneak through.
decode_html <- function(x) {
  x <- gsub("&amp;",  "&",  x, fixed = TRUE)
  x <- gsub("&lt;",   "<",  x, fixed = TRUE)
  x <- gsub("&gt;",   ">",  x, fixed = TRUE)
  x <- gsub("&quot;", '"',  x, fixed = TRUE)
  x <- gsub("&#39;",  "'",  x, fixed = TRUE)
  x
}
latest <- latest |>
  mutate(
    class      = decode_html(class),
    tax_status = decode_html(tax_status)
  )

dominant <- latest |>
  group_by(muni_no, roll_no_txt, tax_year) |>
  arrange(desc(total), class) |>
  summarise(
    class      = first(class),
    tax_status = first(tax_status),
    .groups = "drop"
  )

agg <- latest |>
  group_by(muni_no, roll_no_txt, tax_year) |>
  summarise(
    land      = sum(land,      na.rm = TRUE),
    buildings = sum(buildings, na.rm = TRUE),
    total     = sum(total,     na.rm = TRUE),
    .groups = "drop"
  ) |>
  left_join(dominant, by = c("muni_no", "roll_no_txt", "tax_year")) |>
  filter(is.finite(total) & total > 0) |>
  mutate(
    muni_no = as.integer(muni_no),
    tax_year = as.integer(tax_year),
    land = as.numeric(land),
    buildings = as.numeric(buildings),
    total = as.numeric(total),
    class = as.character(class),
    tax_status = as.character(tax_status)
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

# Top-class + top-status distribution — sanity-check the dominant-
# class pick before the filter UI surfaces it.
top_classes <- agg |>
  count(class, sort = TRUE) |>
  head(10)
top_statuses <- agg |>
  count(tax_status, sort = TRUE) |>
  head(10)
message("[assessment-index] top classes: ",
        paste(sprintf("%s=%d", top_classes$class, top_classes$n), collapse = ", "))
message("[assessment-index] top statuses: ",
        paste(sprintf("%s=%d", top_statuses$tax_status, top_statuses$n), collapse = ", "))

# Pack into the same array-of-arrays shape legal-index uses so the JS
# loader can stay consistent. Field order matches the FIELD lookup in
# web/src/assessmentIndex.js — DO NOT REORDER without updating the JS.
# `class` and `tax_status` are stored at the end so older clients that
# don't know about them still read [muni, roll, year, land, bldg, total]
# correctly (the trailing fields are ignored when out of range).
fields <- c("muni_no", "roll_no_txt", "year", "land", "buildings", "total", "class", "tax_status")

rows <- unname(lapply(seq_len(nrow(agg)), function(i) {
  list(
    agg$muni_no[i],
    as.character(agg$roll_no_txt[i]),
    agg$tax_year[i],
    agg$land[i],
    agg$buildings[i],
    agg$total[i],
    if (is.na(agg$class[i])) "" else agg$class[i],
    if (is.na(agg$tax_status[i])) "" else agg$tax_status[i]
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
