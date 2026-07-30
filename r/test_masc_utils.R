# Lightweight regression checks for refreshed MASC square-section input.
# Run from the repository root with: Rscript r/test_masc_utils.R

suppressPackageStartupMessages(library(dplyr))

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
.r_dir <- if (length(.cfg)) dirname(sub("^--file=", "", .cfg[1])) else "r"
source(file.path(.r_dir, "masc_utils.R"))

sample <- tibble::tribble(
  ~quarter, ~section, ~township, ~range, ~range_num, ~direction,
  ~soil_rating, ~risk_area, ~municipality, ~lat, ~lon,
  "NE", 11L, 27L, "29A", 29L, "W", "D", 9L, "ROBLIN", 51.303065, -101.426435,
  "NE", 11L, 27L, "29A", 29L, "W", "H", 9L, "ROBLIN", 51.303065, -101.426435,
  "NE", 11L, 27L, "29A", 29L, "W", "D", 9L, "ROBLIN", 51.303065, -101.426435
)

out <- normalize_masc_square(sample)
stopifnot(
  nrow(out) == 1L,
  identical(out$range[[1]], "29A"),
  identical(out$soil_ratings[[1]], "D/H"),
  identical(out$soil_rating[[1]], "H")
)

legacy <- sample |>
  select(-range) |>
  filter(row_number() == 1L)
legacy_out <- normalize_masc_square(legacy)
stopifnot(identical(legacy_out$range[[1]], "29"))

tmp_csv <- tempfile(fileext = ".csv")
readr::write_csv(
  tibble::tibble(
    quarter = c(rep("NE", 1001), "NW"),
    section = 1L,
    township = 27L,
    range = c(rep("29", 1001), "29A"),
    direction = "W",
    soil_rating = "D",
    risk_area = 9L,
    municipality = "ROBLIN",
    lat = 51.3,
    lon = -101.4
  ),
  tmp_csv
)
parsed <- read_masc_square_csv(tmp_csv)
stopifnot(identical(tail(parsed$range, 1L), "29A"))
unlink(tmp_csv)

cat("MASC normalization checks passed.\n")
