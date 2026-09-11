# Build web/public/data/traffic-history.json — the per-station AADT series
# behind the traffic-count station overlay.
#
# WHY THIS EXISTS. The MHTIS ArcGIS Traffic Flow service carries at most
# three AADT columns and only two of them have a trustworthy year, so the map
# could show a current count and nothing else. Two things it cannot show at
# all:
#
#   - a real per-station series. Most stations have far more history than the
#     service exposes; continuous counters run to 22 years.
#   - the ~291 TOWN count stations. They have no flow segment, so they carry
#     no number in the service at all — and for an in-town commercial
#     property they are the counts that matter. Arborg's two run about 3x the
#     rural segments on the same highways.
#
# Both live only in MHTIS's annual PDF, "Traffic on Manitoba Highways",
# published at gov.mb.ca/mti/traffic/mhtis_traffic_reports.html. This script
# parses every edition into one small JSON keyed on station number.
#
# WHY COLUMN-X PARSING, NOT TOKEN ORDER. The PDF text layer's reading order
# is NOT stable across editions. The 2025 edition emits a Section III row as
#
#     StationNo Dir Type Location... Year AADT ASDT 30th
#
# and the 2008 edition emits the same logical row as
#
#     Dir Year StationNo Type AADT ASDT 30th Location...
#
# so "the number after the year" reads the AADT in one and the STATION NUMBER
# in the other — a plausible-looking wrong answer, with no error. The only
# thing stable across editions is the physical layout, so columns are learned
# from each page's header row and every word is bucketed by its x centre.
#
# EDITIONS ARE ROLLING REPUBLICATIONS. Each report restates a window of prior
# years, so the middle editions contribute almost nothing unique: measured
# 2026-09-10, the 2008 edition is the sole source of 1,170 station-years and
# the 2025 edition of 622, while every edition between them contributes 0-4.
# Two editions defeat this parser and it does not matter: the 2013 PDF parses
# only partially, and the 2017 PDF mixes two broken font encodings (headers
# shifted +29 codepoints, data -29, so text extracts as "$$'7" and "OMNT").
# Both contribute 0 unique station-years, and calendar 2017 is already covered
# by 737 stations from neighbouring editions. Parse what parses; the checks
# below catch it if that ever stops being true.
#
# NEWEST EDITION WINS on a conflict. Editions disagree on about 0.26% of the
# station-years they share, and those are MHTIS restating its own estimates,
# not parse errors — verified on both sides against the PDFs. Station 5136
# (Brandon) reads 5,190 for 2019 in the 2019/2023/2024 editions and 2,010 in
# the 2025 one; since the same station reads 2,140 in 2016 and 2,280 in 2025,
# the 5,190 was the error and the newest edition is the correction.
#
# Usage:
#   Rscript r/build_traffic_history.R [--cache=DIR] [--out=FILE] [--offline]
#
# The cache holds the downloaded PDFs (~500 MB across 15 editions); it is
# gitignored. --offline parses whatever is already cached.

suppressPackageStartupMessages({
  library(pdftools)
  library(jsonlite)
})

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

args <- commandArgs(trailingOnly = TRUE)
arg_val <- function(name, default) {
  hit <- grep(paste0("^--", name, "="), args, value = TRUE)
  if (length(hit)) sub(paste0("^--", name, "="), "", hit[[1]]) else default
}
cache_dir <- arg_val("cache", file.path(mb_parcelsearch_root, "build-cache", "mhtis"))
out_path <- arg_val("out", file.path(mb_parcelsearch_root, "web/public/data/traffic-history.json"))
offline <- any(args == "--offline")

INDEX_URL <- "https://www.gov.mb.ca/mti/traffic/mhtis_traffic_reports.html"
PDF_BASE <- "https://www.gov.mb.ca/mti/traffic/mhtis/"

# ---------------------------------------------------------------- fetch ----

#' Editions MHTIS currently publishes, read off the index page so a new
#' report is picked up without editing this script. Falls back to the known
#' list when the page can't be read (2020-2022 were never published).
discover_editions <- function() {
  fallback <- c(2008:2019, 2023:2025)
  if (offline) return(fallback)
  html <- tryCatch(paste(readLines(INDEX_URL, warn = FALSE), collapse = "\n"),
                   error = function(e) NULL)
  if (is.null(html)) {
    message("! could not read the MHTIS index page; using the known edition list")
    return(fallback)
  }
  m <- regmatches(html, gregexpr("traffic_report_([0-9]{4})\\.pdf", html))[[1]]
  yrs <- sort(unique(as.integer(sub("traffic_report_([0-9]{4})\\.pdf", "\\1", m))))
  if (!length(yrs)) {
    message("! index page listed no reports; using the known edition list")
    return(fallback)
  }
  yrs
}

ensure_pdf <- function(year) {
  dir.create(cache_dir, recursive = TRUE, showWarnings = FALSE)
  path <- file.path(cache_dir, sprintf("traffic_report_%d.pdf", year))
  # A truncated download is worse than none: it parses to a handful of rows
  # and looks like a thin edition rather than a broken file.
  if (file.exists(path) && file.info(path)$size > 1e6) return(path)
  if (offline) return(NA_character_)
  url <- paste0(PDF_BASE, sprintf("traffic_report_%d.pdf", year))
  tmp <- paste0(path, ".part")
  ok <- tryCatch({
    utils::download.file(url, tmp, mode = "wb", quiet = TRUE)
    TRUE
  }, error = function(e) FALSE)
  if (!ok || !file.exists(tmp) || file.info(tmp)$size < 1e6) {
    if (file.exists(tmp)) unlink(tmp)
    message(sprintf("! %d: download failed", year))
    return(NA_character_)
  }
  file.rename(tmp, path)
  path
}

# --------------------------------------------------------------- parsing ---

SECTION_III <- "Provincial Trunk Highways and Provincial Roads"
SECTION_IV <- c("Town Count Stations", "Counts on Provincial Access Roads")
SKIP_SECTION <- "Turning Movement"

DIRS <- c("C", "EB", "WB", "NB", "SB")

# Header labels vary between editions ("Station No." vs "Station No",
# "Location" vs "Location Description", "AADT" on highway tables vs "ADT" on
# town tables), so match a normalised vocabulary rather than exact strings.
HEADER_ALIASES <- c(
  "station no" = "station", "stationno" = "station", "station" = "station",
  "dir" = "dir", "type" = "type",
  "location description" = "location", "location" = "location",
  "year est" = "year", "year" = "year",
  "aadt" = "aadt", "adt" = "aadt",
  "asdt" = "asdt", "30thhour" = "hour30", "hwy" = "hwy"
)

norm_label <- function(x) {
  trimws(gsub("[^a-z0-9 ]", "", tolower(x)))
}

#' Words grouped into visual rows (list of data.frames, each sorted by x).
#'
#' Cluster on the GAP between baselines rather than bucketing y into fixed
#' bands. A single logical row is not always one y value: the 2008 edition
#' prints its header as "Year Est. AADT ASDT% 30thHour%" at y=38 and
#' "Station No. Type Location" at y=39, which any fixed band can split down
#' the middle — and a header split in two matches nothing, so the whole
#' edition parses to zero rows. Data rows sit 12+ apart, so a 3pt gap
#' separates rows without ever merging two.
page_rows <- function(pg, ytol = 3) {
  if (!nrow(pg)) return(list())
  pg$x1 <- pg$x + pg$width
  ys <- sort(unique(pg$y))
  grp <- cumsum(c(1L, as.integer(diff(ys) > ytol)))
  key <- grp[match(pg$y, ys)]
  ord <- order(key, pg$x)
  pg <- pg[ord, ]
  split(pg, key[ord])
}

#' Column x-spans, learned from the header row.
#'
#' Gap size cannot segment the header: "Year"/"Est" sit 2pt apart while
#' "Est"/"AADT" sit 18pt apart, but so do "No"/"Dir" — splitting on gaps fuses
#' real columns together. The label vocabulary is small and known, so walk the
#' row taking the longest alias that fits at each position.
find_header <- function(rows) {
  for (row in rows) {
    joined <- norm_label(paste(row$text, collapse = " "))
    if (!grepl("aadt|adt", joined) || !grepl("year", joined)) next
    cols <- list()
    i <- 1L
    n <- nrow(row)
    while (i <= n) {
      matched <- FALSE
      for (span in c(2L, 1L)) {           # "year est" before "year"
        if (i + span - 1L > n) next
        label <- norm_label(paste(row$text[i:(i + span - 1L)], collapse = " "))
        # `x[["missing"]]` on a named vector is an error in R, not NULL.
        nm <- unname(HEADER_ALIASES[label])
        if (!is.na(nm)) {
          if (is.null(cols[[nm]])) cols[[nm]] <- c(row$x[i], row$x1[i + span - 1L])
          i <- i + span
          matched <- TRUE
          break
        }
      }
      if (!matched) i <- i + 1L
    }
    if (!is.null(cols$aadt) && !is.null(cols$year) && !is.null(cols$station)) return(cols)
  }
  NULL
}

#' Contiguous x boundaries from the header spans.
#'
#' Numeric columns are right-aligned and text columns left-aligned, so a
#' header cell's own span under-describes its column. Split the gap between
#' neighbours down the middle; the outer columns run to the page edges.
column_bounds <- function(cols) {
  nm <- names(cols)
  starts <- vapply(cols, `[`, numeric(1), 1)
  ends <- vapply(cols, `[`, numeric(1), 2)
  ord <- order(starts)
  nm <- nm[ord]; starts <- starts[ord]; ends <- ends[ord]
  k <- length(nm)
  left <- numeric(k); right <- numeric(k)
  for (i in seq_len(k)) {
    left[i] <- if (i == 1L) -1e6 else (ends[i - 1L] + starts[i]) / 2
    right[i] <- if (i == k) 1e6 else (ends[i] + starts[i + 1L]) / 2
  }
  list(name = nm, left = left, right = right)
}

bucket_row <- function(row, bounds) {
  mid <- (row$x + row$x1) / 2
  idx <- vapply(mid, function(m) {
    hit <- which(m >= bounds$left & m < bounds$right)
    if (length(hit)) hit[[1]] else NA_integer_
  }, integer(1))
  out <- setNames(rep("", length(bounds$name)), bounds$name)
  for (i in seq_along(bounds$name)) {
    take <- !is.na(idx) & idx == i
    if (any(take)) out[[i]] <- paste(row$text[take], collapse = " ")
  }
  out
}

# Column boundaries are straight vertical lines, but a long location
# ("3.2 KM S. OF MANIGOTAGAN ACCESS RD.") runs past them, so the year cell can
# read "RD. 2017". Requiring the whole cell to be a number silently dropped
# every such row — station 533 vanished from the dataset entirely that way.
cell_year <- function(txt) {
  toks <- strsplit(trimws(txt), "\\s+")[[1]]
  toks <- gsub("[.,]$", "", toks)
  hit <- toks[grepl("^(19|20)[0-9]{2}$", toks)]
  if (!length(hit)) return(NA_integer_)
  as.integer(hit[[length(hit)]])   # spillover arrives from the left
}

cell_num <- function(txt) {
  toks <- strsplit(trimws(txt), "\\s+")[[1]]
  toks <- gsub("\\.$", "", toks)
  hit <- toks[grepl("^[0-9]{1,3}(,[0-9]{3})*$", toks)]
  if (!length(hit)) return(NA_integer_)
  as.integer(gsub(",", "", hit[[1]]))
}

# Editions from 2008-2013 print a direction on every row but give it NO header
# label, so it lands in whatever column's x-range covers it — the station
# column, yielding cells like "2560 C" or "86 WB".
cell_station <- function(txt) {
  toks <- strsplit(trimws(txt), "\\s+")[[1]]
  toks <- gsub("[.,]", "", toks)
  station <- NA_integer_
  dir <- NA_character_
  for (tk in toks) {
    if (is.na(station) && grepl("^[0-9]+$", tk)) station <- as.integer(tk)
    else if (toupper(tk) %in% DIRS) dir <- toupper(tk)
  }
  list(station = station, dir = dir)
}

parse_edition <- function(path, report_year) {
  pages <- pdf_data(path)
  recs <- list()
  n_pages_parsed <- 0L
  n_no_header <- 0L
  n_dir_skipped <- 0L
  for (pi in seq_along(pages)) {
    pg <- pages[[pi]]
    if (!nrow(pg)) next
    flat <- paste(pg$text, collapse = " ")
    if (grepl(SKIP_SECTION, flat, fixed = TRUE)) next
    section <- if (grepl(SECTION_III, flat, fixed = TRUE)) "highway"
               else if (any(vapply(SECTION_IV, grepl, logical(1), x = flat, fixed = TRUE))) "town"
               else next

    rows <- page_rows(pg)
    cols <- find_header(rows)
    if (is.null(cols)) { n_no_header <- n_no_header + 1L; next }
    bounds <- column_bounds(cols)
    n_pages_parsed <- n_pages_parsed + 1L

    hwy <- NA_character_
    for (row in rows) {
      line <- paste(row$text, collapse = " ")
      hm <- regmatches(line, regexec("^\\s*Highway Number:\\s*(\\S+)", line))[[1]]
      if (length(hm) == 2L) { hwy <- hm[[2]]; next }
      if (grepl("Highway Number", line, fixed = TRUE)) next
      if (grepl("AADT", line, fixed = TRUE)) next

      cell <- bucket_row(row, bounds)
      get <- function(nm) if (nm %in% names(cell)) cell[[nm]] else ""
      year <- cell_year(get("year"))
      if (is.na(year) || year > report_year || year < 1980) next
      aadt <- cell_num(get("aadt"))
      st <- cell_station(get("station"))
      if (is.na(aadt) || is.na(st$station)) next

      dir <- toupper(trimws(get("dir")))
      if (!(dir %in% DIRS)) dir <- if (!is.na(st$dir)) st$dir else "C"
      # Continuous stations also publish EB/WB/NB/SB rows. Those are
      # components of the C row, never additional traffic — keeping them
      # would double every continuous station.
      if (dir != "C") { n_dir_skipped <- n_dir_skipped + 1L; next }

      recs[[length(recs) + 1L]] <- list(
        station = st$station, year = year, aadt = aadt, section = section,
        hwy = if (!is.na(hwy)) hwy else trimws(get("hwy")),
        location = trimws(get("location")), report = report_year
      )
    }
  }
  list(records = recs, pages = n_pages_parsed, no_header = n_no_header,
       dir_skipped = n_dir_skipped)
}

# ------------------------------------------------------------------ run ----

editions <- discover_editions()
message(sprintf("editions to read: %s", paste(editions, collapse = ", ")))

all_recs <- list()
for (yr in editions) {
  path <- ensure_pdf(yr)
  if (is.na(path)) next
  res <- tryCatch(parse_edition(path, yr), error = function(e) {
    message(sprintf("! %d: parse failed — %s", yr, conditionMessage(e)))
    NULL
  })
  if (is.null(res)) next
  st <- unique(vapply(res$records, `[[`, numeric(1), "station"))
  message(sprintf("%d: %6d rows  %5d stations  pages %3d (no header %3d)  dir-skipped %4d",
                  yr, length(res$records), length(st), res$pages, res$no_header,
                  res$dir_skipped))
  all_recs <- c(all_recs, res$records)
}
if (!length(all_recs)) stop("no records parsed from any edition")

df <- data.frame(
  station = vapply(all_recs, `[[`, numeric(1), "station"),
  year = vapply(all_recs, `[[`, numeric(1), "year"),
  aadt = vapply(all_recs, `[[`, numeric(1), "aadt"),
  report = vapply(all_recs, `[[`, numeric(1), "report"),
  section = vapply(all_recs, `[[`, character(1), "section"),
  hwy = vapply(all_recs, `[[`, character(1), "hwy"),
  location = vapply(all_recs, `[[`, character(1), "location"),
  stringsAsFactors = FALSE
)

# ---- checks that can actually fail ---------------------------------------
# Row counts only prove the parser produced output. These compare it against
# things known independently: values read by eye off the PDFs, and the
# editions' agreement with each other.

spot <- data.frame(
  station = c(1193, 1193, 1194, 1194, 5023, 5023, 5025, 5025, 73, 73, 533, 533, 2571),
  year    = c(2018, 2024, 2018, 2024, 2018, 2024, 2018, 2024, 2016, 2019, 2017, 2023, 2004),
  want    = c(1130, 1230,  880, 1040, 3480, 3620, 3100, 3240, 1110, 1040,  540,  400, 1130)
)
spot_bad <- 0L
for (i in seq_len(nrow(spot))) {
  got <- unique(df$aadt[df$station == spot$station[i] & df$year == spot$year[i]])
  ok <- length(got) == 1L && got == spot$want[i]
  if (!ok) {
    spot_bad <- spot_bad + 1L
    message(sprintf("! spot check FAILED: stn %d %d want %d got %s",
                    spot$station[i], spot$year[i], spot$want[i],
                    if (length(got)) paste(got, collapse = "/") else "(missing)"))
  }
}
message(sprintf("spot checks: %d/%d passed", nrow(spot) - spot_bad, nrow(spot)))
if (spot_bad > 2) stop("too many spot checks failed — the parser is misreading columns")

key <- paste(df$station, df$year)
tab <- table(key)
shared <- names(tab)[tab > 1]
disagree <- sum(vapply(shared, function(k) {
  length(unique(df$aadt[key == k])) > 1L
}, logical(1)))
rate <- if (length(shared)) disagree / length(shared) else 0
message(sprintf("cross-edition: %d station-years in >1 edition, %d disagree (%.2f%%)",
                length(shared), disagree, rate * 100))
if (rate > 0.02) {
  stop(sprintf("cross-edition disagreement %.2f%% is far above the ~0.26%% of genuine MHTIS restatements — likely a column misread", rate * 100))
}

# ---- merge: newest edition wins ------------------------------------------
df <- df[order(df$station, df$year, df$report), ]
keep <- !duplicated(paste(df$station, df$year), fromLast = TRUE)
merged <- df[keep, ]

stations <- list()
for (s in unique(merged$station)) {
  part <- merged[merged$station == s, ]
  part <- part[order(part$year), ]
  newest <- part[nrow(part), ]
  yrs <- as.list(as.integer(part$aadt))
  names(yrs) <- as.character(part$year)
  stations[[as.character(s)]] <- list(
    t = if (newest$section == "town") 1L else 0L,
    hwy = newest$hwy,
    loc = newest$location,
    y = yrs
  )
}

payload <- list(
  version = 1L,
  metadata = list(
    built = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    source = "MHTIS \"Traffic on Manitoba Highways\" annual reports",
    source_url = INDEX_URL,
    editions = as.integer(sort(unique(df$report))),
    stations = length(stations),
    station_years = nrow(merged),
    years = range(merged$year),
    note = paste("Direction 'C' (combined) rows only. Where editions disagree",
                 "the newest wins. 2020-2022 are sparse: MHTIS published no",
                 "report for those years and only the permanent counters ran.")
  ),
  stations = stations
)

dir.create(dirname(out_path), recursive = TRUE, showWarnings = FALSE)
# Write to a sibling temp file and rename: an in-place overwrite under
# Dropbox can report success and leave the old bytes in place.
tmp_out <- paste0(out_path, ".tmp")
write(toJSON(payload, auto_unbox = TRUE, digits = NA, null = "null"), tmp_out)
if (file.exists(out_path)) unlink(out_path)
invisible(file.rename(tmp_out, out_path))

sz <- file.info(out_path)$size
if (is.na(sz) || sz < 10000) stop("output looks truncated: ", out_path)
message(sprintf("\nwrote %s  (%.0f KB)  %d stations, %d station-years, %d-%d",
                out_path, sz / 1024, length(stations), nrow(merged),
                min(merged$year), max(merged$year)))
