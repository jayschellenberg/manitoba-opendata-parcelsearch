#!/usr/bin/env Rscript

# Stamp the current dwelling-unit count for every roll, so that TRUE
# year-over-year DU change becomes computable from here forward.
#
#   Rscript r/snapshot_dwelling_units.R            # take a snapshot
#   Rscript r/snapshot_dwelling_units.R --dry-run  # report the diff, write nothing
#   Rscript r/snapshot_dwelling_units.R --replay   # print the reconstructed state
#   Rscript r/snapshot_dwelling_units.R --force    # record a delta past the loss gate
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
#
# MAO publishes dwelling_units as a CURRENT scalar on the summary page — there
# is no DU column in the tax history and no archived DU anywhere, so a DU delta
# CANNOT be reconstructed for any period before the first run of this script.
# r/build_mf_newbuild.R works around that by triggering on assessed BUILDING
# VALUE (which does have 20 years of history) and using DU only as a filter.
# This script closes the gap prospectively: once two snapshots exist, a roll
# that gains units without gaining much value — a conversion, a basement suite,
# a rooming house — becomes detectable, which the value signal alone misses.
#
# ---------------------------------------------------------------------------
# STORAGE — baseline plus deltas, not a snapshot per run
#
# A full snapshot is ~207,000 rows (every roll with at least one unit). Written
# every cycle, twice a year, that is ~8 MB each and ~160 MB of near-identical
# copies over a decade — in a git repo that is a real cost for no information.
# DU changes on only a small fraction of rolls per cycle, so this keeps ONE
# full baseline and appends only what actually changed:
#
#   <mb-parcel-history>/du-snapshots/baseline_<YYYY-MM-DD>.csv
#       muni_no, roll_no_txt, du            (every roll with du > 0)
#   <mb-parcel-history>/du-snapshots/delta_<YYYY-MM-DD>.csv
#       muni_no, roll_no_txt, du_prev, du   (only rolls whose du moved)
#   <mb-parcel-history>/du-snapshots/_manifest.json
#       ordered file list + row counts, so a replay can verify itself
#
# The state at any date is the baseline with every delta up to that date
# applied in order. There is no separate state file to drift out of sync —
# replay_state() below is the single definition of "what did we know when".
#
# A roll absent from the state has du = 0 (vacant, non-residential, or not yet
# created). So 0 -> 6 reads as an insert and 6 -> 0 as a demolition, both of
# which are exactly the transitions worth catching; neither needs a special case.
#
# ---------------------------------------------------------------------------
# CADENCE — run it right after each scrape cycle completes, ahead of
# r/build_mf_newbuild.R. Running it twice in one day is harmless: a second run
# on the same date overwrites that date's delta rather than appending a second
# one, so the replay stays single-valued per date.

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
  library(readr)
  library(jsonlite)
})

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

parse_arg <- function(name, default = NULL) {
  prefix <- paste0("--", name, "=")
  hit <- grep(paste0("^", prefix), commandArgs(TRUE), value = TRUE)
  if (length(hit)) sub(paste0("^", prefix), "", hit[[1]]) else default
}
has_flag <- function(name) any(commandArgs(TRUE) == paste0("--", name))

DRY_RUN <- has_flag("dry-run")
REPLAY  <- has_flag("replay")
FORCE   <- has_flag("force")

# Refuse to record a delta in which more than this share of the known rolls
# lose their units. See the sanity gate below for why this is not optional.
MAX_LOSS_SHARE <- as.numeric(parse_arg("max-loss-share", "0.05"))

mao_root <- .path_default("MAO_SCRAPE_ROOT",
                          file.path(dirname(mb_parcelsearch_root), "mao-scrape"))
pc_path  <- parse_arg("parcels", file.path(mao_root, "results", "parcels.parquet"))
snap_dir <- parse_arg("output",  file.path(mb_parcel_history_root, "du-snapshots"))
man_path <- file.path(snap_dir, "_manifest.json")

# --- replay: reconstruct the state as of the last recorded snapshot ---------
# Files are applied in DATE order taken from the filename, not directory order,
# so a re-run that rewrites one date cannot reorder the history.
replay_state <- function(dir) {
  base <- sort(list.files(dir, pattern = "^baseline_[0-9-]{10}[.]csv$", full.names = TRUE))
  if (!length(base)) return(NULL)
  if (length(base) > 1) {
    stop("more than one baseline in ", dir, " - the replay order is ambiguous:\n  ",
         paste(basename(base), collapse = "\n  "))
  }
  st <- readr::read_csv(base, show_col_types = FALSE, progress = FALSE,
                        col_types = readr::cols(muni_no = readr::col_integer(),
                                                roll_no_txt = readr::col_character(),
                                                du = readr::col_integer()))
  deltas <- list.files(dir, pattern = "^delta_[0-9-]{10}[.]csv$", full.names = TRUE)
  deltas <- deltas[order(sub("^delta_", "", basename(deltas)))]
  for (d in deltas) {
    dd <- readr::read_csv(d, show_col_types = FALSE, progress = FALSE,
                          col_types = readr::cols(muni_no = readr::col_integer(),
                                                  roll_no_txt = readr::col_character(),
                                                  du_prev = readr::col_integer(),
                                                  du = readr::col_integer()))
    st <- st |>
      anti_join(dd, by = c("muni_no", "roll_no_txt")) |>
      bind_rows(dd |> select(muni_no, roll_no_txt, du) |> filter(du > 0))
  }
  st |> arrange(muni_no, roll_no_txt)
}

if (REPLAY) {
  st <- replay_state(snap_dir)
  if (is.null(st)) stop("no baseline in ", snap_dir)
  cat(sprintf("[du-snapshot] replayed state: %s rolls, %s units\n",
              format(nrow(st), big.mark = ","), format(sum(st$du), big.mark = ",")))
  print(as.data.frame(st |> count(du) |> arrange(du) |> head(12)), row.names = FALSE)
  quit(save = "no")
}

# --- current -----------------------------------------------------------------
if (!file.exists(pc_path)) stop("missing input: ", pc_path)
cur <- arrow::read_parquet(pc_path, col_select = c("muni_no", "roll_no_txt", "dwelling_units")) |>
  transmute(muni_no = as.integer(muni_no),
            roll_no_txt = as.character(roll_no_txt),
            du = as.integer(dwelling_units)) |>
  filter(!is.na(muni_no), !is.na(roll_no_txt), !is.na(du), du > 0) |>
  distinct(muni_no, roll_no_txt, .keep_all = TRUE) |>
  arrange(muni_no, roll_no_txt)

stamp <- format(Sys.Date(), "%Y-%m-%d")
cat(sprintf("[du-snapshot] %s: %s rolls with units, %s units total\n",
            stamp, format(nrow(cur), big.mark = ","), format(sum(cur$du), big.mark = ",")))

prev <- replay_state(snap_dir)

if (is.null(prev)) {
  out <- file.path(snap_dir, paste0("baseline_", stamp, ".csv"))
  cat("[du-snapshot] no prior history - writing the BASELINE\n")
  if (DRY_RUN) { cat("[du-snapshot] --dry-run: nothing written\n"); quit(save = "no") }
  dir.create(snap_dir, showWarnings = FALSE, recursive = TRUE)
  readr::write_csv(cur, out)
} else {
  # Full outer comparison: a roll present in only one side is a 0 on the other.
  cmp <- full_join(prev |> rename(du_prev = du), cur, by = c("muni_no", "roll_no_txt")) |>
    mutate(du_prev = coalesce(du_prev, 0L), du = coalesce(du, 0L)) |>
    filter(du_prev != du) |>
    arrange(muni_no, roll_no_txt)

  cat(sprintf("[du-snapshot] %s rolls changed since the last snapshot: %s gained, %s lost, net %+d units\n",
              format(nrow(cmp), big.mark = ","),
              format(sum(cmp$du > cmp$du_prev), big.mark = ","),
              format(sum(cmp$du < cmp$du_prev), big.mark = ","),
              sum(cmp$du) - sum(cmp$du_prev)))
  if (nrow(cmp)) {
    cat("\n--- largest unit gains ---\n")
    print(as.data.frame(cmp |> mutate(gain = du - du_prev) |>
            arrange(desc(gain)) |> head(12)), row.names = FALSE)
  }

  # --- sanity gate -----------------------------------------------------------
  # This log is append-only and SELF-REPLAYING: every future state is the
  # baseline plus every delta in order, so one bad delta is not a bad file, it
  # is a permanently wrong history that silently rewrites every later answer.
  # That asymmetry is why this refuses rather than warns.
  #
  # The failure it guards is a truncated parcels.parquet - a partial sweep, an
  # interrupted assembly - which presents as thousands of rolls dropping to
  # du = 0 and would be recorded as a mass demolition. assemble_parquet.R has
  # its own shrink guard upstream, but that protects the parquet, not this log,
  # and this script is scheduled to run unattended against whatever it finds.
  #
  # Only LOSSES are gated. A genuine mass gain cannot come from truncation, and
  # capping gains would be the one thing that suppresses a real construction
  # wave - exactly the signal this whole exercise exists to catch.
  lost  <- sum(cmp$du < cmp$du_prev)
  share <- if (nrow(prev)) lost / nrow(prev) else 0
  if (share > MAX_LOSS_SHARE && !FORCE) {
    cat(sprintf(paste0(
      "\n[du-snapshot] REFUSING to write: %s rolls (%.1f%% of the %s known) lost their\n",
      "  units in one cycle, over the %.1f%% gate. That is the signature of a truncated\n",
      "  parcels.parquet, not of demolition. Nothing was written and the replay chain is\n",
      "  intact.\n\n",
      "  Check the source first:  %s\n",
      "  Then re-run. If the loss is real, repeat with --force (or raise\n",
      "  --max-loss-share=<0-1>); a delta written in error cannot be undone by a later\n",
      "  one, it can only be corrected by editing the log by hand.\n"),
      format(lost, big.mark = ","), 100 * share, format(nrow(prev), big.mark = ","),
      100 * MAX_LOSS_SHARE, pc_path))
    quit(save = "no", status = 2)
  }
  if (share > MAX_LOSS_SHARE && FORCE) {
    cat(sprintf("[du-snapshot] --force: recording %s unit losses (%.1f%%) past the %.1f%% gate\n",
                format(lost, big.mark = ","), 100 * share, 100 * MAX_LOSS_SHARE))
  }

  if (DRY_RUN) { cat("\n[du-snapshot] --dry-run: nothing written\n"); quit(save = "no") }
  if (!nrow(cmp)) {
    # Writing an empty delta would add a file that says nothing; skipping it
    # keeps the replay chain honest about when DU actually moved.
    cat("[du-snapshot] no change - no delta written\n")
  } else {
    readr::write_csv(cmp |> select(muni_no, roll_no_txt, du_prev, du),
                     file.path(snap_dir, paste0("delta_", stamp, ".csv")))
  }
}

# --- manifest ----------------------------------------------------------------
files <- list.files(snap_dir, pattern = "^(baseline|delta)_[0-9-]{10}[.]csv$")
files <- files[order(sub("^(baseline|delta)_", "", files))]
man <- list(
  generated_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  source       = basename(pc_path),
  note = paste("State at any date = baseline plus every delta up to it, applied in",
               "filename-date order. A roll absent from the state has du = 0.",
               "Nothing before the baseline date is reconstructible: MAO publishes",
               "no DU history."),
  files = lapply(files, function(f) {
    n <- length(readr::read_lines(file.path(snap_dir, f), progress = FALSE)) - 1L
    list(file = f, rows = n)
  })
)
# Rewrite ONLY when the file list actually changed. This directory is a git
# repo published by commit SHA, and a scheduled monthly run that touches
# nothing but a `generated_at` stamp would leave it dirty after every quiet
# cycle. A repo that is always dirty is a repo whose status nobody reads, and
# the one thing that must stay noticeable here is an unexpected delta.
write_manifest <- TRUE
if (file.exists(man_path)) {
  old_files <- tryCatch(
    jsonlite::fromJSON(man_path, simplifyVector = FALSE)$files,
    error = function(e) NULL)
  same <- !is.null(old_files) && length(old_files) == length(man$files) &&
    all(vapply(seq_along(man$files), function(i) {
      identical(as.character(old_files[[i]]$file), as.character(man$files[[i]]$file)) &&
      identical(as.integer(old_files[[i]]$rows), as.integer(man$files[[i]]$rows))
    }, logical(1)))
  if (isTRUE(same)) write_manifest <- FALSE
}
if (write_manifest) {
  jsonlite::write_json(man, man_path, auto_unbox = TRUE, pretty = TRUE)
} else {
  cat("[du-snapshot] manifest unchanged - left alone\n")
}

st <- replay_state(snap_dir)
cat(sprintf("\nDone. %d files in %s; state now %s rolls / %s units\n",
            length(files), snap_dir,
            format(nrow(st), big.mark = ","), format(sum(st$du), big.mark = ",")))
