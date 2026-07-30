# Shared normalization helpers for the MASC square-section scrape.
#
# The refreshed MASC site can return more than one soil rating for the
# same legal quarter. Generated website data keeps the complete rating
# label (for example "C/H") while using the most conservative/worst code
# as the single map colour. Exact duplicates collapse into the same row.

masc_rating_codes <- LETTERS[1:10]

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
