#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(arrow)
  library(jsonlite)
})

script_path <- function() {
  args <- commandArgs(FALSE)
  file_arg <- grep("^--file=", args, value = TRUE)
  if (length(file_arg)) return(normalizePath(sub("^--file=", "", file_arg[[1]]), winslash = "/", mustWork = TRUE))
  normalizePath("r/build_legal_index.R", winslash = "/", mustWork = TRUE)
}

parse_arg <- function(name, default = NULL) {
  prefix <- paste0("--", name, "=")
  hit <- grep(paste0("^", prefix), commandArgs(TRUE), value = TRUE)
  if (length(hit)) sub(paste0("^", prefix), "", hit[[1]]) else default
}

root <- normalizePath(file.path(dirname(script_path()), ".."), winslash = "/", mustWork = TRUE)
# mao-scrape sits as a sibling of mb-parcelsearch under MBOpenData/.
# Override at the command line (--input=...) or via the
# MAO_PARCELS_PARQUET env var if you keep the scrape elsewhere.
default_input <- file.path(
  dirname(root),
  "mao-scrape", "results", "parcels.parquet"
)
default_output <- file.path(root, "web", "public", "data", "legal-index.json")

input <- normalizePath(
  parse_arg("input", Sys.getenv("MAO_PARCELS_PARQUET", default_input)),
  winslash = "/",
  mustWork = TRUE
)
output <- normalizePath(
  parse_arg("output", default_output),
  winslash = "/",
  mustWork = FALSE
)

fields <- c(
  "muni_no",
  "roll_no_txt",
  "extrct_prop_id",
  "municipality",
  "civic_address",
  "legal_description",
  "legal_detail",
  "lot",
  "block",
  "plan",
  "certificates_of_title",
  "source_url"
)

message("[legal-index] reading ", input)
parcels <- read_parquet(input)
missing <- setdiff(fields, names(parcels))
if (length(missing)) {
  stop("Input parquet is missing expected columns: ", paste(missing, collapse = ", "))
}

idx <- parcels[fields]
clean_chr <- function(x) {
  x <- as.character(x)
  x[is.na(x)] <- ""
  x
}
idx$muni_no <- as.integer(idx$muni_no)
for (nm in setdiff(fields, "muni_no")) {
  idx[[nm]] <- clean_chr(idx[[nm]])
}

rows <- unname(lapply(seq_len(nrow(idx)), function(i) {
  unname(as.list(idx[i, , drop = TRUE]))
}))

payload <- list(
  version = 1,
  fields = fields,
  metadata = list(
    generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    source = input,
    source_modified = format(file.info(input)$mtime, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    row_count = nrow(idx)
  ),
  rows = rows
)

dir.create(dirname(output), recursive = TRUE, showWarnings = FALSE)
tmp <- tempfile("legal-index-", fileext = ".json")
message("[legal-index] writing ", output, " (", nrow(idx), " rows)")
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
message("[legal-index] done")
