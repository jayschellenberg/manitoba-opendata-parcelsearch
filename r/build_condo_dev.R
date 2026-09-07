#!/usr/bin/env Rscript

# Build the NEW CONDO DEVELOPMENT layer for the non-Winnipeg municipalities,
# from the MAO Property Search scrape.
#
#   Rscript r/build_condo_dev.R                  # full build + shards
#   Rscript r/build_condo_dev.R --report-only    # print summaries, write nothing
#   Rscript r/build_condo_dev.R --from=2016      # first year of the window
#   Rscript r/build_condo_dev.R --min-units=3    # smallest development kept
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS SEPARATELY FROM r/build_mf_newbuild.R
#
# The multi-family layer gates on `dwelling_units >= 3`, which is the right
# gate for rental blocks and the wrong one for everything else: measured on
# the rolls MAO itself labels, 3,975 of 4,311 row-housing rolls (92%) carry
# dwelling_units = 1, because row housing is CONDO-TITLED — one roll per unit.
# So row housing is not under-represented in the multi-family layer, it is
# absent from it, and that layer is in practice already "new apartments".
#
# New row housing is findable, just somewhere else: as a CLUSTER of new condo
# rolls sharing a plan. MAO writes a condo roll's legal description as
# "<unit>-<plan>" (1-63538, 2-63538, ...) and its legal_detail reverses that
# to "<plan>-<unit>". The plan is the only handle that turns N single-unit
# rolls back into one development, and it is a good one: 98.7% of plans are
# internally consistent in MAO's own structure labelling, which is what you
# would expect of a single architectural project.
#
# ---------------------------------------------------------------------------
# HOW A DEVELOPMENT IS TYPED — and why nothing is guessed
#
# MAO's own Primary Property descriptor (from the authenticated sales search)
# distinguishes "ROW HSG" from "APT". Where a development has at least one
# labelled roll, that label is used; a plan being architecturally uniform is
# what makes one labelled unit speak for the rest. Where it has none, the
# development is emitted as UNKNOWN.
#
# It is emitted as unknown rather than inferred, and that is a deliberate
# refusal. The obvious heuristic is the civic address — row housing units get
# their own street address ("49 WHEATGRASS BAY") while apartment condos get
# "Unit 105 - 3400 MCDONALD". Validated against 2,843 labelled condo rolls it
# reaches 76% accuracy per roll but only 36.5% row-housing PRECISION, and even
# aggregated to a whole development by majority vote only 61.7% — nearly four
# in ten "row housing" labels would be wrong. A six-plex at 31 Main St and a
# six-unit row house at 31 Main St are genuinely identical in that field. In
# an appraisal tool a confidently wrong label costs more than a blank one, so
# the address is not used and `unknown` is a first-class answer.
#
# Density was tested too and is worse: on labelled rolls apartments run a
# median 23.5 dwelling units per acre against row housing's 16.7, but the
# spreads overlap and the best single threshold scored below the accuracy of
# simply always answering "apartment".
#
# ---------------------------------------------------------------------------
# WHAT COUNTS AS NEW. The development's first year is the earliest tax year
# any of its rolls appears in the archive. As with the multi-family layer that
# is an ASSESSMENT year and trails physical completion, typically by about a
# year. A development is kept when that year is within the window, it has at
# least MIN_UNITS rolls, and it carries building value now.
#
# ---------------------------------------------------------------------------
# OUTPUT (mirrors the mf-newbuild shard contract)
#
#   <mb-parcel-data>/condo-dev/<MUNI_KEY>.json
#       { "<roll_no_txt>": {p, y, u, k, kn, b, ad} }
#         p   condo plan number - the development key
#         y   first tax year any roll in the development was assessed
#         u   units (rolls) in the development
#         k   "row" | "apt" | "mixed" | "unknown"
#         kn  how many of the development's rolls carried a MAO descriptor
#         b   the development's total building value in the latest year
#         ad  a representative civic address for the development
#   <mb-parcel-data>/condo-dev/_index.json
#   <mb-parcel-data>/condo-dev/_all-developments.csv

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(readr)
  library(stringr)
  library(jsonlite)
  library(stringi)
})

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

parse_arg <- function(name, default = NULL) {
  prefix <- paste0("--", name, "=")
  hit <- grep(paste0("^", prefix), commandArgs(TRUE), value = TRUE)
  if (length(hit)) sub(paste0("^", prefix), "", hit[[1]]) else default
}
has_flag <- function(name) any(commandArgs(TRUE) == paste0("--", name))

FROM_YEAR   <- as.integer(parse_arg("from", "2016"))
MIN_UNITS   <- as.integer(parse_arg("min-units", "3"))
REPORT_ONLY <- has_flag("report-only")

mao_root   <- .path_default("MAO_SCRAPE_ROOT",
                            file.path(dirname(mb_parcelsearch_root), "mao-scrape"))
th_path    <- parse_arg("tax-history", file.path(mao_root, "results", "tax_history.parquet"))
pc_path    <- parse_arg("parcels",     file.path(mao_root, "results", "parcels.parquet"))
ss_dir     <- parse_arg("sales-search", file.path(mao_root, "results", "sales_search", "by_muni"))
output_dir <- parse_arg("output",      file.path(mb_parcel_data_root, "condo-dev"))
index_path <- file.path(output_dir, "_index.json")

for (p in c(th_path, pc_path)) if (!file.exists(p)) stop("missing input: ", p)

safe_filename <- function(x) {
  x |>
    stringi::stri_trans_general(id = "Latin-ASCII") |>
    toupper() |>
    gsub(pattern = "[^A-Z0-9._-]+", replacement = "_") |>
    gsub(pattern = "_+",            replacement = "_") |>
    gsub(pattern = "^_|_$",         replacement = "")
}
`%||%` <- function(a, b) if (is.null(a) || length(a) == 0) b else a

# "<unit>-<plan>", with multi-unit rolls written "21&30-27691".
PLAN_RE <- "^[[:space:]]*[0-9&;[:space:]]+-([0-9]+[A-Z]?)[[:space:]]*$"
ROW_RE  <- "ROW HSG|ROW HOUSING|ROW HS|RO HS|RH$"
APT_RE  <- "\\bAPT\\b|APARTMENT"

cat("[condo-dev] reading", basename(th_path), "\n")
th <- arrow::read_parquet(th_path,
  col_select = c("muni_no", "roll_no_txt", "tax_year", "class", "buildings", "summable"))
pc <- arrow::read_parquet(pc_path,
  col_select = c("muni_no", "roll_no_txt", "municipality", "dwelling_units",
                 "legal_description", "civic_address"))

latest_year <- max(th$tax_year, na.rm = TRUE)
first <- th |> group_by(muni_no, roll_no_txt) |>
  summarise(first_y = min(tax_year), .groups = "drop")
cls <- th |> filter(tax_year == latest_year) |>
  group_by(muni_no, roll_no_txt) |>
  summarise(classes = paste(sort(unique(class)), collapse = "|"), .groups = "drop")
bnow <- th |> filter(summable, tax_year == latest_year) |>
  group_by(muni_no, roll_no_txt) |>
  summarise(b = sum(coalesce(buildings, 0)), .groups = "drop")

rolls <- pc |>
  inner_join(first, by = c("muni_no", "roll_no_txt")) |>
  inner_join(cls,   by = c("muni_no", "roll_no_txt")) |>
  inner_join(bnow,  by = c("muni_no", "roll_no_txt")) |>
  mutate(plan = str_match(toupper(coalesce(legal_description, "")), PLAN_RE)[, 2],
         is_condo = str_detect(classes, "RESIDENTIAL 3")) |>
  filter(is_condo, !is.na(plan), b > 0)
cat(sprintf("[condo-dev] condo rolls with a parseable plan and building value: %s\n",
            format(nrow(rolls), big.mark = ",")))

# --- MAO's structure descriptor, per roll ------------------------------------
lab <- NULL
if (dir.exists(ss_dir)) {
  files <- list.files(ss_dir, pattern = "[.]csv$", full.names = TRUE)
  ss <- bind_rows(lapply(files, function(f) tryCatch(
    read_csv(f, show_col_types = FALSE, progress = FALSE,
             col_types = cols(.default = col_character())) |>
      select(any_of(c("muni_no", "roll", "primary_property"))),
    error = function(e) NULL)))
  if (nrow(ss)) {
    lab <- ss |>
      mutate(muni_no = suppressWarnings(as.integer(muni_no)),
             rn = suppressWarnings(as.numeric(gsub("[^0-9.]", "", roll))),
             roll_no_txt = ifelse(is.na(rn), NA_character_, sprintf("%.3f", rn)),
             pp = toupper(coalesce(primary_property, "")),
             kind = case_when(str_detect(pp, ROW_RE) ~ "row",
                              str_detect(pp, APT_RE) ~ "apt",
                              TRUE ~ NA_character_)) |>
      filter(!is.na(kind), !is.na(muni_no), !is.na(roll_no_txt)) |>
      distinct(muni_no, roll_no_txt, kind) |>
      # A roll labelled both ways carries no signal; drop it rather than let
      # an arbitrary pick decide a whole development.
      group_by(muni_no, roll_no_txt) |> filter(n() == 1) |> ungroup()
    cat(sprintf("[condo-dev] rolls carrying a MAO structure descriptor: %s\n",
                format(nrow(lab), big.mark = ",")))
  }
} else {
  cat("[condo-dev] no sales-search directory at ", ss_dir,
      " - every development will be unknown\n", sep = "")
}
if (is.null(lab)) lab <- tibble(muni_no = integer(), roll_no_txt = character(), kind = character())

rolls <- rolls |> left_join(lab, by = c("muni_no", "roll_no_txt"))

# --- developments -------------------------------------------------------------
devs <- rolls |>
  group_by(muni_no, municipality, plan) |>
  summarise(
    u  = n(),
    y  = min(first_y),
    b  = sum(b),
    n_row = sum(kind == "row", na.rm = TRUE),
    n_apt = sum(kind == "apt", na.rm = TRUE),
    # A representative address. Prefer one WITHOUT a unit prefix so the
    # development reads as a place rather than as one of its suites; fall
    # back to whatever exists.
    ad = {
      a <- civic_address[nzchar(coalesce(civic_address, ""))]
      plain <- a[!str_detect(toupper(a), "^[[:space:]]*(UNIT|APT|SUITE|STE)[[:space:]]*[.#]?[[:space:]]*[0-9]")]
      if (length(plain)) plain[1] else if (length(a)) a[1] else NA_character_
    },
    .groups = "drop") |>
  mutate(
    kn = n_row + n_apt,
    k = case_when(
      n_row > 0 & n_apt == 0 ~ "row",
      n_apt > 0 & n_row == 0 ~ "apt",
      n_row > 0 & n_apt > 0  ~ "mixed",
      TRUE                   ~ "unknown")) |>
  filter(u >= MIN_UNITS, y >= FROM_YEAR)

cat(sprintf("\n[condo-dev] %s developments, %s units, %d-%d\n",
            format(nrow(devs), big.mark = ","), format(sum(devs$u), big.mark = ","),
            FROM_YEAR, latest_year))
cat("\n--- by type ---\n")
print(as.data.frame(devs |> group_by(k) |>
  summarise(developments = n(), units = sum(u), value_m = round(sum(b) / 1e6, 1)) |>
  arrange(desc(units))), row.names = FALSE)
cat("\n--- by first year ---\n")
print(as.data.frame(devs |> count(y, k) |>
  tidyr::pivot_wider(names_from = k, values_from = n, values_fill = 0) |> arrange(y)),
  row.names = FALSE)
cat("\n--- the row-housing developments ---\n")
print(as.data.frame(devs |> filter(k == "row") |>
  transmute(y, u, muni = substr(municipality, 1, 30), plan,
            value_m = round(b / 1e6, 1), ad = substr(ad, 1, 24)) |>
  arrange(desc(u))), row.names = FALSE)
cat("\n--- top municipalities ---\n")
print(as.data.frame(devs |> group_by(municipality) |>
  summarise(devs = n(), units = sum(u), .groups = "drop") |>
  arrange(desc(units)) |> head(10)), row.names = FALSE)

if (REPORT_ONLY) {
  cat("\n[condo-dev] --report-only: nothing written\n")
  quit(save = "no")
}

# --- shards -------------------------------------------------------------------
muni_map <- NULL
roll_files <- list.files(mb_parcelsearch_root, pattern = "^RollEntry_[0-9]{8}[.]gpkg$",
                         full.names = TRUE)
if (length(roll_files)) {
  re <- sf::st_read(tail(sort(roll_files), 1L),
                    query = 'SELECT DISTINCT "Municipality", "Muni_Name_With_Typ" FROM "roll_entry"',
                    quiet = TRUE)
  muni_map <- re |>
    mutate(muni_no = suppressWarnings(as.integer(sub("\\s*-.*$", "", Municipality)))) |>
    filter(!is.na(muni_no), nzchar(Muni_Name_With_Typ)) |>
    distinct(muni_no, Muni_Name_With_Typ)
}

# Back to the roll level: the map paints parcels, so every unit roll of a kept
# development carries its development's attributes.
out <- rolls |>
  inner_join(devs |> select(muni_no, plan, y, u, k, kn, b_dev = b, ad),
             by = c("muni_no", "plan")) |>
  left_join(muni_map %||% tibble(muni_no = integer(), Muni_Name_With_Typ = character()),
            by = "muni_no") |>
  mutate(Muni_Name_With_Typ = coalesce(Muni_Name_With_Typ,
                                       toupper(sub("^[0-9]+\\s*-\\s*", "", municipality))),
         muni_key = safe_filename(Muni_Name_With_Typ))
cat(sprintf("\n[condo-dev] unit rolls in kept developments: %s\n",
            format(nrow(out), big.mark = ",")))

dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)
unlink(list.files(output_dir, pattern = "^[^_].*[.]json$", full.names = TRUE))

manifest <- list()
for (kk in sort(unique(out$muni_key))) {
  d <- out |> filter(muni_key == kk) |> arrange(desc(y), plan)
  rec <- list()
  for (i in seq_len(nrow(d))) {
    r <- d[i, ]
    rec[[r$roll_no_txt]] <- list(
      p = r$plan, y = r$y, u = r$u, k = r$k, kn = r$kn,
      b = round(r$b_dev), ad = r$ad)
  }
  f <- file.path(output_dir, paste0(kk, ".json"))
  jsonlite::write_json(rec, f, auto_unbox = TRUE, digits = NA, na = "null", null = "null")
  manifest[[d$Muni_Name_With_Typ[1]]] <- list(file = basename(f), count = nrow(d))
}

manifest[["_meta"]] <- list(
  generated_at    = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  source          = paste(basename(th_path), basename(pc_path), sep = " + "),
  source_modified = format(file.info(th_path)$mtime, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  window          = c(FROM_YEAR, latest_year),
  min_units       = MIN_UNITS,
  development_count = nrow(devs),
  unit_count        = nrow(out),
  typed = list(
    row     = sum(devs$k == "row"),
    apt     = sum(devs$k == "apt"),
    mixed   = sum(devs$k == "mixed"),
    unknown = sum(devs$k == "unknown")),
  type_source = paste("MAO's Primary Property descriptor from the authenticated sales",
                      "search. A development is typed when at least one of its rolls",
                      "carries one; a condo plan is one architectural project, and 98.7%",
                      "of plans are internally consistent in MAO's own labelling."),
  unknown_caveat = paste("Developments with no labelled roll are emitted as unknown, never",
                         "inferred. The civic-address heuristic (a street address means row",
                         "housing, 'Unit N -' means apartment) reaches only 36.5% row-housing",
                         "precision per roll and 61.7% by development majority vote, so it is",
                         "not used. Dwelling-unit density is worse still."),
  lag_caveat = paste("y is the first tax year a roll in the development was ASSESSED, which",
                     "trails physical completion, typically by about a year.")
)
jsonlite::write_json(manifest, index_path, auto_unbox = TRUE, pretty = FALSE)

readr::write_csv(
  devs |> arrange(desc(y), desc(u)) |>
    transmute(municipality, plan, first_year = y, units = u, type = k,
              labelled_rolls = kn, building_value = round(b), address = ad),
  file.path(output_dir, "_all-developments.csv"))

total_kb <- sum(file.info(list.files(output_dir, full.names = TRUE))$size) / 1024
cat(sprintf("\nDone. %d shards, %d developments, %d unit rolls, %.0f KB -> %s\n",
            length(manifest) - 1L, nrow(devs), nrow(out), total_kb, output_dir))
