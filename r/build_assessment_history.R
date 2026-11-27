#!/usr/bin/env Rscript

# Per-roll assessed-value HISTORY from the MAO scrape's tax_history.parquet,
# for the year-over-year charts (parcel summary card, preliminary report).
#
# The assessment index (build_assessment_index.R) keeps the latest tax year
# only. This keeps every year, 2008 on, but stores a roll's values only in
# the years they CHANGE: Manitoba freezes assessed values between biennial
# reassessments, so a 20-year series is usually 8-11 change points. A reader
# carries each value forward to the next change point.
#
# Output: <mb-parcel-data>/assessment-history/<muni_no>.json
#   {
#     version: 1, muni_no,
#     first_year, last_year,                       // the archive's span
#     fields: ["year","land","buildings"],         // total = land + buildings
#     rolls: { "<Roll_No_Txt>": [[year, land, buildings], ...] }
#   }
#   plus _index.json { version, metadata, shards: [{muni_no, file, roll_count}] }
#
# Per-year values follow build_assessment_index.R exactly: summable rows
# only (FARM MARKET vs FARM USE de-dup), summed across classes. A roll's
# last change point is always its latest year, even when unchanged, so a
# reader knows how far the series runs. Years a roll is missing from the
# archive are simply absent (a new roll starts at its first year).
#
# Assessed values only. No tax dollars: MAO publishes none.
#
#   Rscript r/build_assessment_history.R [--input=...] [--out-dir=...]

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(jsonlite)
})

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

parse_arg <- function(name, default = NULL) {
  hit <- grep(paste0("^--", name, "="), commandArgs(TRUE), value = TRUE)
  if (length(hit)) sub(paste0("^--", name, "="), "", hit[[1]]) else default
}

here <- dirname(normalizePath(sub("^--file=", "", .cfg[1]), winslash = "/"))
default_input <- file.path(dirname(dirname(here)), "mao-scrape", "results", "tax_history.parquet")
input <- normalizePath(parse_arg("input", Sys.getenv("MAO_TAX_HISTORY_PARQUET", default_input)),
                       winslash = "/", mustWork = TRUE)
out_dir <- parse_arg("out-dir", file.path(mb_parcel_data_root, "assessment-history"))

message("[assessment-history] reading ", input)
th <- read_parquet(input, col_select = c("muni_no", "roll_no_txt", "tax_year", "land", "buildings", "total", "summable"))

yearly <- th |>
  filter(!is.na(summable) & summable,
         !is.na(muni_no), !is.na(roll_no_txt), nzchar(roll_no_txt), !is.na(tax_year)) |>
  group_by(muni_no, roll_no_txt, tax_year) |>
  summarise(land = sum(land, na.rm = TRUE),
            buildings = sum(buildings, na.rm = TRUE),
            total = sum(total, na.rm = TRUE),
            .groups = "drop") |>
  mutate(muni_no = as.integer(muni_no), tax_year = as.integer(tax_year),
         land = round(as.numeric(land)), buildings = round(as.numeric(buildings)),
         total = round(as.numeric(total))) |>
  arrange(muni_no, roll_no_txt, tax_year)

first_year <- min(yearly$tax_year)
last_year  <- max(yearly$tax_year)

# Keep a year when any value differs from the roll's previous kept year, or
# it is the roll's first or last year.
stopifnot("total must equal land + buildings for the 3-field encoding" =
            all(yearly$total == yearly$land + yearly$buildings))

changes <- yearly |>
  group_by(muni_no, roll_no_txt) |>
  mutate(keep = row_number() == 1 | row_number() == n() |
           land != lag(land) | buildings != lag(buildings)) |>
  ungroup() |>
  filter(keep) |>
  select(-keep)

message(sprintf("[assessment-history] %d roll-years -> %d change points across %d rolls (%d-%d)",
                nrow(yearly), nrow(changes), n_distinct(paste(changes$muni_no, changes$roll_no_txt)),
                first_year, last_year))

dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
unlink(list.files(out_dir, pattern = "\\.json$", full.names = TRUE))

shards <- list()
for (m in sort(unique(changes$muni_no))) {
  d <- changes[changes$muni_no == m, , drop = FALSE]
  by_roll <- split(d, d$roll_no_txt)
  rolls <- lapply(by_roll, function(r) unname(Map(function(y, l, b) c(y, l, b),
                                                    r$tax_year, r$land, r$buildings)))
  payload <- list(version = 1, muni_no = m, first_year = first_year, last_year = last_year,
                  fields = c("year", "land", "buildings"), rolls = rolls)
  file <- sprintf("%d.json", m)
  writeLines(toJSON(payload, auto_unbox = TRUE, digits = NA), file.path(out_dir, file), useBytes = TRUE)
  shards[[length(shards) + 1]] <- list(muni_no = m, file = file, roll_count = length(rolls))
}

index <- list(
  version = 1,
  metadata = list(
    generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    source = "tax_history.parquet",
    source_modified = format(file.info(input)$mtime, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    first_year = first_year, last_year = last_year,
    shard_count = length(shards), roll_count = sum(vapply(shards, `[[`, 0L, "roll_count")),
    note = "Assessed values only: land and buildings, summable classes summed; total = land + buildings (verified for every point at build). Stored at change points; carry each forward to the next. No tax dollars."
  ),
  shards = shards
)
writeLines(toJSON(index, auto_unbox = TRUE, digits = NA), file.path(out_dir, "_index.json"), useBytes = TRUE)
mb <- sum(file.info(list.files(out_dir, full.names = TRUE))$size) / 2^20
message(sprintf("[assessment-history] %d shards, %.1f MB -> %s", length(shards), mb, out_dir))
