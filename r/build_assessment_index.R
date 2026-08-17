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
# Defaults look for ../mao-scrape/results/tax_history.parquet
# (same sibling project as parcels.parquet for the legal index) and
# write to web/public/data/assessment-index.json under this repo's root.
#
# The output file is gitignored (matches legal-index.json). Refresh
# in production by uploading to a GitHub Release and bumping
# RELEASE_URL in api/assessment-index.js.

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(jsonlite)
})

# Shared roots (env-overridable) — see r/config.R. Sourced for
# mb_parcel_data_root only; the unified output still resolves through
# the legacy --input/--output args + env fallbacks below.
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

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
# mao-scrape sits as a sibling of mb-parcelsearch under MBOpenData/.
default_input <- file.path(
  dirname(root),
  "mao-scrape", "results", "tax_history.parquet"
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
    # basename only — this JSON ships to every visitor (GitHub Release +
    # edge function), so the local absolute path must not leak into it.
    source = basename(input),
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

# -------- Per-muni shards --------
# In addition to the unified index above, write one JSON file per
# muni_no into web/public/data/assessment/<muni_no>.json. Lets the
# client fetch only the shards relevant to the parcels at hand
# (typical sales-CSV upload knows the muni list up front) instead of
# pulling the whole 30 MB index for a single lookup. The unified
# file stays around as the fallback for legal-search results / other
# paths that don't know their muni list in advance.

# Shards publish into the local mb-parcel-data clone (served via
# raw.githubusercontent pinned commit — see MB_PARCEL_DATA_CDN in
# arcgis.js). The unified `output` JSON above still lands locally because
# it ships to users through a GitHub Release + Vercel edge function, not
# the shard CDN.
shard_dir <- file.path(mb_parcel_data_root, "assessment")
dir.create(shard_dir, recursive = TRUE, showWarnings = FALSE)
# Wipe any stale shards from a previous run — muni_no list can change
# across rebuilds when MAO reorganises municipalities.
old_shards <- list.files(shard_dir, pattern = "\\.json$", full.names = TRUE)
if (length(old_shards)) {
  unlink(old_shards)
}

shard_index <- list()
unique_munis <- unique(agg$muni_no)
for (m in unique_munis) {
  if (!is.finite(m)) next
  shard_rows <- agg[agg$muni_no == m, , drop = FALSE]
  if (nrow(shard_rows) == 0) next
  shard_packed <- unname(lapply(seq_len(nrow(shard_rows)), function(i) {
    list(
      shard_rows$muni_no[i],
      as.character(shard_rows$roll_no_txt[i]),
      shard_rows$tax_year[i],
      shard_rows$land[i],
      shard_rows$buildings[i],
      shard_rows$total[i],
      if (is.na(shard_rows$class[i])) "" else shard_rows$class[i],
      if (is.na(shard_rows$tax_status[i])) "" else shard_rows$tax_status[i]
    )
  }))
  shard_payload <- list(
    version = 1,
    muni_no = as.integer(m),
    fields = fields,
    rows = shard_packed
  )
  shard_file <- sprintf("%d.json", as.integer(m))
  shard_path <- file.path(shard_dir, shard_file)
  writeLines(toJSON(shard_payload, auto_unbox = TRUE, null = "null", digits = NA),
             shard_path, useBytes = TRUE)
  shard_index[[length(shard_index) + 1]] <- list(
    muni_no = as.integer(m),
    file = shard_file,
    row_count = as.integer(nrow(shard_rows))
  )
}

# Tiny index file lists every shard so the client doesn't have to
# probe-fetch each muni_no. Metadata mirrors the unified index plus
# the per-shard registry.
index_payload <- list(
  version = 1,
  metadata = list(
    generated_at = payload$metadata$generated_at,
    source = payload$metadata$source,
    source_modified = payload$metadata$source_modified,
    shard_count = length(shard_index),
    row_count = nrow(agg)
  ),
  shards = shard_index
)
index_path <- file.path(shard_dir, "_index.json")
writeLines(toJSON(index_payload, auto_unbox = TRUE, null = "null", digits = NA),
           index_path, useBytes = TRUE)
message("[assessment-index] sharded → ", length(shard_index), " files in ", shard_dir)
