#!/usr/bin/env Rscript

# Build the multi-family NEW-CONSTRUCTION layer for the non-Winnipeg
# municipalities, from the MAO Property Search scrape.
#
#   Rscript r/build_mf_newbuild.R                  # full build + shards
#   Rscript r/build_mf_newbuild.R --report-only    # print summaries, write nothing
#   Rscript r/build_mf_newbuild.R --from=2016      # event window start (tax year)
#   Rscript r/build_mf_newbuild.R --min-du=3       # multi-family threshold
#
# ---------------------------------------------------------------------------
# WHY THIS WORKS — the biennium trick
#
# Manitoba reassesses on a two-year cycle; every tax year carries the
# reference date its values were struck at (tax_history$assessment_reference_date).
# Within one biennium the value is FROZEN by statute, so it only moves when the
# PHYSICAL property changes. Measured on this dataset (Residential 2 rolls,
# 2008-2027):
#
#     year-over-year pair             building value changed
#     across a reassessment boundary          99.8%
#     within a biennium (same ref date)         7.9%
#
# So a within-biennium building-value jump is a near-pure physical-change
# signal — new construction, a major addition, or a demolition. Across a
# boundary every roll moves, so a raw jump means nothing there; it has to be
# normalised against the general revaluation factor for that municipality AND
# property class before an excess is meaningful.
#
# ---------------------------------------------------------------------------
# WHAT IS DETECTED — three event shapes, because a new apartment block does
# NOT usually announce itself as "Residential 2 in both years":
#
#   appeared   buildings go from ~nothing to a real value on an existing roll
#   expanded   buildings rise materially above the revaluation factor
#              (addition, later phase, or a conversion adding units)
#   new_roll   the roll itself first appears mid-history already improved
#              (the development was carved out as a new parcel)
#
# Detection is deliberately done at the ROLL level across ALL property
# classes, never within Residential 2. Requiring R2 in both years finds
# 2 events province-wide, because new blocks arrive as new rolls or
# reclassify into R2 from Residential 1 / Other in the same year the building
# appears. Selkirk's 1027 Manitoba Ave is the canonical shape: OTHER PROPERTY
# at $163,900 through 2016, then $16.9M as RESIDENTIAL 2 in 2017.
#
# EVERY qualifying event on a roll is emitted, not just one. That same roll
# has a second, genuine event in 2024 ($17.0M -> $37.4M, phase two). Collapsing
# a roll to a single year would have to discard one real building.
#
# ---------------------------------------------------------------------------
# WHAT COUNTS AS MULTI-FAMILY
#
# Current dwelling_units >= MIN_DU (default 3), EXCLUDING any roll carrying a
# farm class in its latest year. That exclusion is not cosmetic: of the 1,841
# rolls with DU >= 5, 1,222 are Hutterite colonies (FARM PROPERTY alongside
# INSTITUTIONAL / OTHER / RESIDENTIAL), routinely 20-35 units and $20-38M of
# buildings. Left in, they outrank every real apartment block in the province.
#
# ---------------------------------------------------------------------------
# THE DWELLING-UNIT CAVEAT — read before trusting a unit count
#
# MAO publishes dwelling_units as a CURRENT scalar on the summary page. There
# is no DU history to diff, and none can be reconstructed retroactively. So:
#
#   * du       is TODAY's unit count, not the count at any one event. On a
#              two-phase roll it is the total of both phases.
#   * sdu      is genuine at-a-date DU from the sales PDF archive
#              (dwelling_units at sale, back to 1996) — only for rolls that
#              sold, but real evidence where it exists.
#   * Going forward, r/snapshot_dwelling_units.R stamps DU each cycle so true
#     DU deltas accumulate from now on. Nothing retroactive.
#
# A roll converted to residential without a value jump will therefore be
# missed; the value series is the trigger and DU is only the filter.
#
# ---------------------------------------------------------------------------
# BUILDING TYPE - row housing vs apartment - IS HAND-LABELLED, ON PURPOSE
#
# mf-type-overrides.csv beside this script carries `muni_no, roll_no_txt, type`
# where type is row | apt | mixed, and it is the ONLY source of the `ty` field.
# Nothing is inferred, because four separate signals were measured against
# MAO's own structure descriptor and every one of them failed:
#
#   civic address "Unit N -" vs a street address   36.5% row-housing precision
#   the same, by whole-development majority vote   61.7%
#   a civic address that is a NUMBER RANGE
#     ("147 - 153 CHAMPAGNE ST")                   20.0% at DU >= 3
#   dwelling units per acre                        below always-guessing-apartment
#
# The range one is the most instructive: apartment blocks span two municipal
# addresses just as readily as row houses do ("62 - 64 EVELINE ST" is 36 units),
# and only one of the five known developments Jason supplied even has a range.
#
# The assessment CLASS cannot help either, and the reason is worth recording so
# nobody re-tests it: RESIDENTIAL 1 vs 2 tracks UNIT COUNT (1-4 vs 5+), not
# building form. Labelled row-housing rolls sit in R1 only because they are 3-
# and 4-unit blocks; the 58-91 unit rental row housing Jason identified is
# RESIDENTIAL 2, exactly like an apartment block of the same size.
#
# So `ty` is absent unless a human put it there. A roll with no override gets
# no type, and the map shows it as "not typed" rather than guessing.
#
# ---------------------------------------------------------------------------
# ASSESSMENT LAG — `y` is the first tax year the building is ASSESSED, which
# trails physical completion, typically by about a year, and a partly built
# structure can be assessed at part value first. Treat it as "on the roll by",
# never as a construction date.
#
# ---------------------------------------------------------------------------
# OUTPUT (mirrors the landfacts shard contract)
#
#   <mb-parcel-data>/mf-newbuild/<MUNI_KEY>.json
#       { "<roll_no_txt>": {du, ad, cl, e:[...], p, sdu} }
#         du  current dwelling units
#         ad  civic address
#         cl  property classes in the latest year, abbreviated
#         ty  "row" | "apt" | "mixed" - ONLY when hand-labelled in
#             mf-type-overrides.csv; absent otherwise, never inferred
#         e   every event, oldest first:
#             {y year, k "appeared"|"expanded"|"new_roll",
#              b building value at y, bp value the year before,
#              c confidence "high"|"med"|"low"}
#         p   year of the primary event (largest value gain)
#         sdu at-a-date DU from sales PDFs: [[year, du], ...] or omitted
#   <mb-parcel-data>/mf-newbuild/_index.json
#       { "<Muni_Name_With_Typ>": {file, count}, "_meta": {...} }
#   <mb-parcel-data>/mf-newbuild/_all-events.csv   flat table, every event
#
# SECOND OUTPUT - the standing INVENTORY, not just what is new:
#
#   <mb-parcel-data>/mf-inventory/<MUNI_KEY>.json
#       { "<roll_no_txt>": {du, cl, ad} }   every qualifying roll, new or not
#   <mb-parcel-data>/mf-inventory/_index.json
#
# It ships from THIS script rather than its own because it is the same
# universe: the `mf` set below, before any event detection. Two scripts would
# be two places for MIN_DU and the farm exclusion to drift, and the whole
# point of the pair is that "existing multi-family" and "new multi-family"
# describe the same population at different times. The web layer applies the
# user's dwelling-unit threshold on top of MIN_DU, so the shard ships the
# floor and the UI narrows it.

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
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

# --- tunables ---------------------------------------------------------------
FROM_YEAR   <- as.integer(parse_arg("from", "2016"))
MIN_DU      <- as.integer(parse_arg("min-du", "3"))
# A building worth less than this is a garage, a shed or a mobile, not a
# multi-family structure. Applied to the value AT the event year.
MIN_BUILDING  <- as.numeric(parse_arg("min-building", "150000"))
# For `expanded`: the increase must clear this in dollars AND clear
# EXCESS_RATIO after the revaluation factor is divided out.
MIN_INCREASE  <- as.numeric(parse_arg("min-increase", "100000"))
EXCESS_RATIO  <- as.numeric(parse_arg("excess-ratio", "1.5"))
# `appeared` means the prior year held essentially nothing — either in
# absolute dollars, or relative to what landed.
APPEAR_PRIOR_ABS  <- 10000
APPEAR_PRIOR_FRAC <- 0.05
# Minimum rolls behind a revaluation factor before it is trusted over the
# next fallback up the chain.
FACTOR_MIN_N <- 30

REPORT_ONLY <- has_flag("report-only")

mao_root   <- .path_default("MAO_SCRAPE_ROOT",
                            file.path(dirname(mb_parcelsearch_root), "mao-scrape"))
th_path    <- parse_arg("tax-history", file.path(mao_root, "results", "tax_history.parquet"))
pc_path    <- parse_arg("parcels",     file.path(mao_root, "results", "parcels.parquet"))
sales_path <- parse_arg("sales",       file.path(mao_root, "results", "sales_archive.csv"))
output_dir <- parse_arg("output",      file.path(mb_parcel_data_root, "mf-newbuild"))
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

# --- hand-labelled building types --------------------------------------------
# Absent file is normal, not an error: the layer works without any labels, it
# simply types nothing. A bad `type` value is an error, though - silently
# dropping a row Jason meant to label would be worse than stopping.
ov_path <- parse_arg("overrides", file.path(mb_parcelsearch_root, "mf-type-overrides.csv"))
overrides <- tibble(muni_no = integer(), roll_no_txt = character(), ty = character())
if (file.exists(ov_path)) {
  ov <- readr::read_csv(ov_path, show_col_types = FALSE, progress = FALSE,
                        col_types = readr::cols(.default = readr::col_character()))
  need <- c("muni_no", "roll_no_txt", "type")
  miss <- setdiff(need, names(ov))
  if (length(miss)) stop("mf-type-overrides.csv is missing column(s): ", paste(miss, collapse = ", "))
  ov <- ov |>
    transmute(muni_no = suppressWarnings(as.integer(muni_no)),
              roll_no_txt = trimws(as.character(roll_no_txt)),
              ty = tolower(trimws(as.character(type)))) |>
    filter(!is.na(muni_no), nzchar(roll_no_txt), nzchar(ty))
  bad <- setdiff(unique(ov$ty), c("row", "apt", "mixed"))
  if (length(bad)) {
    stop("mf-type-overrides.csv has unrecognised type(s): ", paste(bad, collapse = ", "),
         " - expected row, apt or mixed")
  }
  # A roll labelled twice, differently, is a question for a human, not
  # something to resolve by picking one.
  dup <- ov |> count(muni_no, roll_no_txt) |> filter(n > 1)
  if (nrow(dup)) {
    stop("mf-type-overrides.csv labels the same roll more than once: ",
         paste(dup$roll_no_txt, collapse = ", "))
  }
  # Roll numbers are written by hand; accept "104092" for "104092.000".
  ov <- ov |> mutate(roll_no_txt = ifelse(grepl("[.]", roll_no_txt), roll_no_txt,
                                          sprintf("%.3f", suppressWarnings(as.numeric(roll_no_txt)))))
  overrides <- ov
  cat(sprintf("[mf-newbuild] hand-labelled building types: %d (%s)\n", nrow(overrides),
              paste(sprintf("%s %d", names(table(overrides$ty)), as.integer(table(overrides$ty))),
                    collapse = ", ")))
}

cat("[mf-newbuild] reading", basename(th_path), "\n")
th <- arrow::read_parquet(
  th_path,
  col_select = c("muni_no", "roll_no_txt", "tax_year", "assessment_reference_date",
                 "class", "land", "buildings", "total", "summable")
)

# --- 1. biennium map, derived from the data (never hardcoded) ---------------
# Two tax years sharing a reference date were struck at the same value level.
# 2020-2022 is a three-year biennium (the reassessment was deferred); reading
# it out of the data instead of a literal table is what keeps this correct
# when the province next shifts the cycle.
bien <- th |>
  distinct(tax_year, assessment_reference_date) |>
  filter(!is.na(assessment_reference_date)) |>
  arrange(tax_year)
if (anyDuplicated(bien$tax_year)) {
  bad <- bien$tax_year[duplicated(bien$tax_year)]
  stop("tax years with more than one reference date: ", paste(unique(bad), collapse = ", "))
}
ref_of <- setNames(bien$assessment_reference_date, as.character(bien$tax_year))
cat(sprintf("[mf-newbuild] %d tax years, %d reassessment cycles (%d-%d)\n",
            nrow(bien), n_distinct(bien$assessment_reference_date),
            min(bien$tax_year), max(bien$tax_year)))

# --- 2. per roll-year building value + dominant class -----------------------
# summable == FALSE drops FARM MARKET VALUE where FARM USE VALUE coexists —
# alternate views of the same land, summing them double-counts. Same rule the
# MAO summary page's own TOTAL line uses (see r/build_assessment_index.R).
# The dominant class (largest building value) is what the revaluation factor
# is keyed on: reassessment moves apartments and houses by different amounts.
ry <- th |>
  filter(summable) |>
  mutate(bb = coalesce(buildings, 0)) |>
  group_by(muni_no, roll_no_txt, tax_year) |>
  summarise(b  = sum(bb),
            dc = class[which.max(bb)][1], .groups = "drop") |>
  arrange(muni_no, roll_no_txt, tax_year)

# --- 3. classes + farm flag in the latest year ------------------------------
latest_year <- max(th$tax_year, na.rm = TRUE)
cls <- th |>
  filter(tax_year == latest_year) |>
  group_by(muni_no, roll_no_txt) |>
  summarise(classes = paste(sort(unique(class)), collapse = "|"), .groups = "drop") |>
  mutate(is_farm = grepl("FARM", classes, fixed = TRUE))

# --- 4. the multi-family universe -------------------------------------------
pc <- arrow::read_parquet(
  pc_path,
  col_select = c("muni_no", "roll_no_txt", "municipality", "dwelling_units",
                 "civic_address", "legal_description")
)
mf <- pc |>
  filter(!is.na(dwelling_units), dwelling_units >= MIN_DU) |>
  left_join(cls, by = c("muni_no", "roll_no_txt")) |>
  mutate(is_farm = coalesce(is_farm, FALSE))
n_all  <- nrow(mf)
n_farm <- sum(mf$is_farm)
mf <- mf |> filter(!is_farm)
cat(sprintf("[mf-newbuild] DU >= %d: %s rolls; %s dropped as farm/colony; %s kept\n",
            MIN_DU, format(n_all, big.mark = ","), format(n_farm, big.mark = ","),
            format(nrow(mf), big.mark = ",")))

# --- 5. revaluation factors, per municipality AND class ---------------------
# Across a reassessment boundary EVERY improved roll moves, so a raw ratio is
# meaningless there. The general revaluation factor is the MEDIAN b[y]/b[y-1]
# over improved rolls — median, not mean, so the handful that genuinely
# changed physically cannot drag it.
#
# Keyed on the dominant class as well as the municipality because the classes
# do NOT move together: in 2025 Residential 1 revalued at 1.142 province-wide
# while Residential 2 revalued at 1.036. A blended factor there would set the
# apartment bar 10 points too high and silently drop real expansions.
#
# Computed on the FULL parcel set, not just the MF subset: a municipality can
# have too few apartment blocks for a stable median, and the factor is a
# property of the reassessment, not of the parcels we happen to be looking at.
# Fallback chain: muni x class -> province x class -> province blended -> 1.
step <- ry |>
  group_by(muni_no, roll_no_txt) |>
  mutate(prev_b = lag(b), prev_y = lag(tax_year), prev_dc = lag(dc)) |>
  ungroup() |>
  filter(!is.na(prev_b), tax_year - prev_y == 1L)

step$same_bien <- ref_of[as.character(step$tax_year)] == ref_of[as.character(step$prev_y)]

basis <- step |> filter(!same_bien, prev_b >= 10000, b > 0, dc == prev_dc)
f_muni <- basis |> group_by(muni_no, tax_year, dc) |>
  summarise(f_muni = median(b / prev_b), n_muni = n(), .groups = "drop")
f_cls  <- basis |> group_by(tax_year, dc) |>
  summarise(f_cls = median(b / prev_b), n_cls = n(), .groups = "drop")
f_all  <- basis |> group_by(tax_year) |>
  summarise(f_all = median(b / prev_b), .groups = "drop")

reval <- f_muni |>
  full_join(f_cls, by = c("tax_year", "dc")) |>
  left_join(f_all, by = "tax_year") |>
  mutate(factor = case_when(
    !is.na(n_muni) & n_muni >= FACTOR_MIN_N ~ f_muni,
    !is.na(n_cls)  & n_cls  >= FACTOR_MIN_N ~ f_cls,
    TRUE                                    ~ f_all)) |>
  select(muni_no, tax_year, dc, factor)

cat("[mf-newbuild] revaluation factor, province-wide, by boundary year:\n")
print(as.data.frame(
  f_cls |> filter(tax_year >= FROM_YEAR,
                  dc %in% c("RESIDENTIAL 1", "RESIDENTIAL 2", "OTHER PROPERTY")) |>
    mutate(f_cls = round(f_cls, 3)) |>
    tidyr::pivot_wider(id_cols = tax_year, names_from = dc,
                       values_from = f_cls)), row.names = FALSE)

# --- 6. events ---------------------------------------------------------------
ev_step <- step |>
  semi_join(mf, by = c("muni_no", "roll_no_txt")) |>
  left_join(reval, by = c("muni_no", "tax_year", "dc")) |>
  mutate(
    factor   = ifelse(same_bien, 1, coalesce(factor, 1)),
    # Two ways to be "appeared": the prior year was empty in absolute terms,
    # or what landed dwarfs what was there.
    empty_before = prev_b <= APPEAR_PRIOR_ABS,
    appeared = (empty_before | prev_b <= APPEAR_PRIOR_FRAC * b) & b >= MIN_BUILDING,
    excess   = ifelse(prev_b > 0, (b / prev_b) / factor, NA_real_),
    expanded = !appeared & !is.na(excess) & excess >= EXCESS_RATIO &
               (b - prev_b) >= MIN_INCREASE & b >= MIN_BUILDING
  ) |>
  filter(appeared | expanded) |>
  transmute(muni_no, roll_no_txt, y = tax_year,
            k = ifelse(appeared, "appeared", "expanded"),
            b, bp = prev_b,
            # Within a biennium the value is frozen, so the jump IS physical
            # change. Across a boundary, a building landing on a roll that
            # held NOTHING is equally unambiguous — no revaluation factor
            # multiplies $0 into $17.8M (Portage's 1120 Dufferin Ave E sat at
            # $0 from 2020 and assessed at $17.8M in 2027, a boundary year).
            # It is only the EXPANSION of an already-improved roll across a
            # boundary that is a soft read of an excess over a modelled
            # factor, and that alone is emitted low.
            c = case_when(
              same_bien    ~ "high",
              empty_before ~ "high",
              appeared     ~ "med",
              TRUE         ~ "low"))

# new_roll: the roll's own first year in the history, already improved. The
# roll must not start at the very beginning of the archive (2008) — that is
# simply where the record starts, not a parcel creation.
archive_start <- min(ry$tax_year, na.rm = TRUE)
ev_new <- ry |>
  semi_join(mf, by = c("muni_no", "roll_no_txt")) |>
  group_by(muni_no, roll_no_txt) |>
  summarise(fy = min(tax_year), b_fy = b[which.min(tax_year)], .groups = "drop") |>
  filter(fy > archive_start, b_fy >= MIN_BUILDING) |>
  transmute(muni_no, roll_no_txt, y = fy, k = "new_roll",
            b = b_fy, bp = 0, c = "med")

events <- bind_rows(ev_step, ev_new) |>
  filter(y >= FROM_YEAR) |>
  arrange(muni_no, roll_no_txt, y)

# The PRIMARY event is the one that created the most building value — that is
# what the map ranks and colours by. Every other event stays in the shard.
primary <- events |>
  mutate(gain = b - bp) |>
  group_by(muni_no, roll_no_txt) |>
  slice_max(gain, n = 1, with_ties = FALSE) |>
  ungroup() |>
  select(muni_no, roll_no_txt, p = y, p_b = b, p_k = k, p_c = c)

cat(sprintf("\n[mf-newbuild] %s events on %s rolls, %d-%d\n",
            format(nrow(events), big.mark = ","),
            format(nrow(primary), big.mark = ","), FROM_YEAR, latest_year))
cat("\n--- ALL events by year and confidence ---\n")
print(as.data.frame(events |> count(y, c) |>
                    tidyr::pivot_wider(names_from = c, values_from = n, values_fill = 0) |>
                    arrange(y)), row.names = FALSE)
cat("\n--- by event shape ---\n")
print(as.data.frame(events |> count(k)), row.names = FALSE)
cat("\n--- rolls with more than one event (separate phases) ---\n")
multi <- events |> count(muni_no, roll_no_txt) |> filter(n > 1)
cat(sprintf("  %d rolls, %d events\n", nrow(multi), sum(multi$n)))

# --- 7. at-a-date DU from the sales PDF archive ------------------------------
# Real historical unit counts, for the rolls that sold. The archive's `roll` is
# Excel-escaped (="500") and its muni_no is the HISTORIC one; current_muni_no
# is the amalgamated code that matches the scrape. Roll numbers repeat across
# municipalities, so the join must carry the muni.
sdu <- NULL
if (file.exists(sales_path)) {
  sa <- readr::read_csv(sales_path, show_col_types = FALSE, progress = FALSE,
                        col_types = readr::cols(.default = readr::col_character()))
  if (all(c("roll", "current_muni_no", "dwelling_units", "sale_date") %in% names(sa))) {
    sdu <- sa |>
      transmute(
        muni_no  = suppressWarnings(as.integer(current_muni_no)),
        roll_num = suppressWarnings(as.numeric(gsub("[^0-9.]", "", roll))),
        du       = suppressWarnings(as.integer(dwelling_units)),
        y        = suppressWarnings(as.integer(stringi::stri_extract_last_regex(sale_date, "[0-9]{4}")))) |>
      filter(!is.na(muni_no), !is.na(roll_num), !is.na(du), du > 0, !is.na(y)) |>
      mutate(roll_no_txt = sprintf("%.3f", roll_num)) |>
      distinct(muni_no, roll_no_txt, y, du) |>
      semi_join(mf, by = c("muni_no", "roll_no_txt"))
    cat(sprintf("\n[mf-newbuild] at-sale DU observations for MF rolls: %s on %s rolls\n",
                format(nrow(sdu), big.mark = ","),
                format(n_distinct(paste(sdu$muni_no, sdu$roll_no_txt)), big.mark = ",")))
  }
} else {
  cat("\n[mf-newbuild] no sales archive at ", sales_path, " - sdu omitted\n", sep = "")
}

# --- 8. assemble ------------------------------------------------------------
rolls <- primary |>
  left_join(mf |> select(muni_no, roll_no_txt, municipality, dwelling_units,
                         civic_address, legal_description, classes),
            by = c("muni_no", "roll_no_txt")) |>
  mutate(cl = classes |>
           gsub(pattern = "--CONDOS &amp; CO-OPS",  replacement = "", fixed = TRUE) |>
           gsub(pattern = "RESIDENTIAL ",           replacement = "R", fixed = TRUE) |>
           gsub(pattern = "INSTITUTIONAL PROPERTY", replacement = "INST", fixed = TRUE) |>
           gsub(pattern = "OTHER PROPERTY",         replacement = "OTHER", fixed = TRUE))

rolls <- rolls |> left_join(overrides, by = c("muni_no", "roll_no_txt"))
matched <- sum(!is.na(rolls$ty))
if (nrow(overrides)) {
  cat(sprintf("[mf-newbuild] overrides matched to flagged rolls: %d of %d\n",
              matched, nrow(overrides)))
  unmatched <- overrides |> anti_join(rolls, by = c("muni_no", "roll_no_txt"))
  if (nrow(unmatched)) {
    # Not fatal: a labelled roll may sit outside the event window (Niverville
    # 46082 was built in 2015) yet still be in the inventory, where the label
    # is applied below. Named so a genuine typo is visible rather than silent.
    cat("[mf-newbuild] labelled rolls not in the flagged set (window or filter):\n")
    for (i in seq_len(nrow(unmatched))) {
      cat(sprintf("    muni %d roll %s (%s)\n", unmatched$muni_no[i],
                  unmatched$roll_no_txt[i], unmatched$ty[i]))
    }
  }
}

cat("\n--- top 20 by building value at the primary event ---\n")
print(as.data.frame(rolls |> arrange(desc(p_b)) |>
        transmute(y = p, k = p_k, c = p_c, municipality = substr(municipality, 1, 32),
                  du = dwelling_units, b_k = round(p_b / 1000), cl = substr(cl, 1, 20)) |>
        head(20)), row.names = FALSE)

cat("\n--- top 15 municipalities by current units on flagged rolls ---\n")
print(as.data.frame(rolls |> group_by(municipality) |>
        summarise(rolls = n(), units = sum(dwelling_units),
                  value_m = round(sum(p_b) / 1e6, 1), .groups = "drop") |>
        arrange(desc(units)) |> head(15)), row.names = FALSE)

if (REPORT_ONLY) {
  cat("\n[mf-newbuild] --report-only: nothing written\n")
  quit(save = "no")
}

# --- 9. municipality display names, for the shard filenames -----------------
# Same MuniCode -> Muni_Name_With_Typ map the other shard builders use. The
# scrape's `municipality` is "500 - CITY OF BRANDON", whose leading integer IS
# the MuniCode, so the join needs no fuzzy name matching.
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
} else {
  warning("no RollEntry_YYYYMMDD.gpkg under ", mb_parcelsearch_root,
          " - shard names fall back to the scrape's own municipality text")
}
rolls <- rolls |>
  left_join(muni_map %||% tibble(muni_no = integer(), Muni_Name_With_Typ = character()),
            by = "muni_no") |>
  mutate(Muni_Name_With_Typ = coalesce(Muni_Name_With_Typ,
                                       toupper(sub("^[0-9]+\\s*-\\s*", "", municipality))),
         muni_key = safe_filename(Muni_Name_With_Typ))

dir.create(output_dir, showWarnings = FALSE, recursive = TRUE)
# A stale shard from a previous run for a municipality that no longer has any
# event would otherwise survive and be served forever.
unlink(list.files(output_dir, pattern = "^[^_].*[.]json$", full.names = TRUE))

# --- 9b. the standing inventory ----------------------------------------------
# Every roll in the multi-family universe, whether or not anything was built on
# it in the window. Same MIN_DU, same farm exclusion, same muni keys - see the
# note in the header for why it lives here rather than in a script of its own.
inv <- mf |>
  left_join(overrides, by = c("muni_no", "roll_no_txt")) |>
  left_join(muni_map %||% tibble(muni_no = integer(), Muni_Name_With_Typ = character()),
            by = "muni_no") |>
  mutate(Muni_Name_With_Typ = coalesce(Muni_Name_With_Typ,
                                       toupper(sub("^[0-9]+\\s*-\\s*", "", municipality))),
         muni_key = safe_filename(Muni_Name_With_Typ),
         cl = classes |>
           gsub(pattern = "--CONDOS &amp; CO-OPS",  replacement = "", fixed = TRUE) |>
           gsub(pattern = "RESIDENTIAL ",           replacement = "R", fixed = TRUE) |>
           gsub(pattern = "INSTITUTIONAL PROPERTY", replacement = "INST", fixed = TRUE) |>
           gsub(pattern = "OTHER PROPERTY",         replacement = "OTHER", fixed = TRUE))

inv_dir <- file.path(dirname(output_dir), "mf-inventory")
dir.create(inv_dir, showWarnings = FALSE, recursive = TRUE)
unlink(list.files(inv_dir, pattern = "^[^_].*[.]json$", full.names = TRUE))

inv_manifest <- list()
for (kk in sort(unique(inv$muni_key))) {
  d <- inv |> filter(muni_key == kk) |> arrange(desc(dwelling_units))
  rec <- list()
  for (i in seq_len(nrow(d))) {
    r <- d[i, ]
    rec[[r$roll_no_txt]] <- list(du = r$dwelling_units, cl = r$cl, ad = r$civic_address,
                                 ty = if (!is.na(r$ty)) r$ty else NULL)
  }
  f <- file.path(inv_dir, paste0(kk, ".json"))
  jsonlite::write_json(rec, f, auto_unbox = TRUE, digits = NA, na = "null", null = "null")
  inv_manifest[[d$Muni_Name_With_Typ[1]]] <- list(file = basename(f), count = nrow(d))
}
inv_manifest[["_meta"]] <- list(
  generated_at    = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  source          = basename(pc_path),
  source_modified = format(file.info(pc_path)$mtime, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  min_du          = MIN_DU,
  excludes        = "rolls carrying any FARM class in the latest year (Hutterite colonies)",
  roll_count      = nrow(inv),
  note = paste("The standing multi-family inventory - every roll at or above",
               "min_du, new or not. The web layer applies the user's own",
               "dwelling-unit threshold on top of this floor. Same universe as",
               "the mf-newbuild family, before event detection.")
)
jsonlite::write_json(inv_manifest, file.path(inv_dir, "_index.json"),
                     auto_unbox = TRUE, pretty = FALSE)
cat(sprintf("[mf-inventory] %d shards, %s rolls -> %s\n",
            length(inv_manifest) - 1L, format(nrow(inv), big.mark = ","), inv_dir))

ev_key  <- split(events, paste(events$muni_no, events$roll_no_txt))
sdu_key <- if (!is.null(sdu)) split(sdu, paste(sdu$muni_no, sdu$roll_no_txt)) else list()

manifest <- list()
for (kk in sort(unique(rolls$muni_key))) {
  d <- rolls |> filter(muni_key == kk) |> arrange(desc(p), desc(p_b))
  rec <- list()
  for (i in seq_len(nrow(d))) {
    r  <- d[i, ]
    id <- paste(r$muni_no, r$roll_no_txt)
    e  <- ev_key[[id]]
    e  <- e[order(e$y), ]
    entry <- list(
      du = r$dwelling_units,
      ad = r$civic_address,
      cl = r$cl,
      p  = r$p,
      ty = if (!is.na(r$ty)) r$ty else NULL,
      e  = lapply(seq_len(nrow(e)), function(j) list(
             y = e$y[j], k = e$k[j], b = round(e$b[j]), bp = round(e$bp[j]), c = e$c[j])))
    s <- sdu_key[[id]]
    if (!is.null(s) && nrow(s)) {
      s <- s[order(s$y), ]
      entry$sdu <- lapply(seq_len(nrow(s)), function(j) c(s$y[j], s$du[j]))
    }
    rec[[r$roll_no_txt]] <- entry
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
  min_du          = MIN_DU,
  min_building    = MIN_BUILDING,
  min_increase    = MIN_INCREASE,
  excess_ratio    = EXCESS_RATIO,
  excludes        = "rolls carrying any FARM class in the latest year (Hutterite colonies)",
  roll_count      = nrow(rolls),
  typed_count     = matched,
  type_source     = paste("mf-type-overrides.csv - hand-labelled only. Row housing and",
                          "apartments are indistinguishable in this data: address form,",
                          "address ranges, unit density and assessment class were all",
                          "measured against MAO's descriptor and all failed. Class in",
                          "particular tracks UNIT COUNT (R1 = 1-4, R2 = 5+), not form."),
  event_count     = nrow(events),
  du_caveat   = paste("du is the CURRENT dwelling-unit count, not the count at any one",
                      "event; MAO publishes no DU history. sdu, where present, is at-sale",
                      "DU from the sales PDF archive."),
  lag_caveat  = paste("event years are the first tax year the building is ASSESSED, which",
                      "trails physical completion, typically by about a year."),
  confidence  = list(
    high = paste("within-biennium jump (assessed values are frozen between reassessments,",
                 "so the change is physical), or a building landing on a roll that held nothing"),
    med  = "the roll was created already improved, or a near-empty roll improved across a reassessment boundary",
    low  = "expansion of an already-improved roll across a reassessment boundary: an excess over the modelled revaluation factor")
)
jsonlite::write_json(manifest, index_path, auto_unbox = TRUE, pretty = FALSE)

csv_path <- file.path(output_dir, "_all-events.csv")
readr::write_csv(
  events |>
    left_join(rolls |> select(muni_no, roll_no_txt, municipality, Muni_Name_With_Typ,
                              dwelling_units, civic_address, legal_description, cl, p),
              by = c("muni_no", "roll_no_txt")) |>
    mutate(is_primary = y == p, gain = b - bp) |>
    select(municipality, roll_no_txt, civic_address, dwelling_units, classes = cl,
           event_year = y, kind = k, confidence = c, buildings = b, buildings_prev = bp,
           gain, is_primary, legal_description) |>
    arrange(desc(event_year), desc(gain)),
  csv_path)

total_kb <- sum(file.info(list.files(output_dir, full.names = TRUE))$size) / 1024
cat(sprintf("\nDone. %d shards, %d rolls, %d events, %.0f KB -> %s\n",
            length(manifest) - 1L, nrow(rolls), nrow(events), total_kb, output_dir))
