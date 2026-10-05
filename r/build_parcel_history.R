# build_parcel_history.R
#
# Maintains the parcel change history (see r/parcel_history_lib.R for the model
# and the table layout) from the geometry snapshots already on disk:
#   RollEntry_YYYYMMDD.gpkg         this folder, weekly (download_parcels.R)
#   MBRollGeoPackageYYYYMMDD.gpkg   MAOSnapshots archive, semiannual
# Output: <mb_parcelsearch_root>/history/ (local only; not published).
#
# Usage:
#   Rscript r/build_parcel_history.R                      # process new snapshots
#   Rscript r/build_parcel_history.R --dry-run            # report what would run
#   Rscript r/build_parcel_history.R --accept 20261011_weekly   # force a quarantined snapshot
#   Rscript r/build_parcel_history.R --rebuild            # re-derive versions from deltas
#                                                          # (after changing thresholds)
#   Rscript r/build_parcel_history.R --rebuild-from 2026-08-04  # re-read files from a date
#   Rscript r/build_parcel_history.R --max-new 3          # cap snapshots this run
#   Rscript r/build_parcel_history.R --keep-files 8       # weekly gpkgs kept on disk (default 4)
#   Rscript r/build_parcel_history.R --no-prune           # delete no weekly gpkgs this run
#
# Exit codes: 0 ok; 1 error; 2 a snapshot was QUARANTINED this run (nothing
# wrong with the code, but a human should look: see history/snapshots.parquet
# for the reason, and --accept it if the change is real).
#
# Rebuilds happen on their own when the evidence changes underneath us:
#   - a processed snapshot file's SHA-256 changed (download_parcels.R --force)
#   - an archive file appears for a date already processed from a weekly file
#   - a file appears dated before the newest processed snapshot
# In each case everything from that date on is re-derived from the files.
#
# Run after download_parcels.R by mao-assembly/refresh-monthly-wrapper.ps1.

suppressPackageStartupMessages({ library(sf); library(arrow); library(dplyr) })
sf::sf_use_s2(FALSE)

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
.r_dir <- if (length(.cfg)) dirname(sub("^--file=", "", .cfg[1])) else "r"
source(file.path(.r_dir, "config.R"))
source(file.path(.r_dir, "parcel_history_lib.R"))

args <- commandArgs(trailingOnly = TRUE)
arg_vals <- function(flag) { i <- which(args == flag); if (!length(i)) character() else args[pmin(i + 1, length(args))] }
DRY_RUN      <- "--dry-run" %in% args
REBUILD      <- "--rebuild" %in% args
ACCEPT       <- arg_vals("--accept")
REBUILD_FROM <- as.Date(arg_vals("--rebuild-from")[1] %||% NA)
MAX_NEW      <- suppressWarnings(as.integer(arg_vals("--max-new")[1] %||% NA))
if (is.na(MAX_NEW)) MAX_NEW <- .Machine$integer.max
NO_PRUNE     <- "--no-prune" %in% args
KEEP_FILES   <- suppressWarnings(as.integer(arg_vals("--keep-files")[1] %||% NA))
if (is.na(KEEP_FILES)) KEEP_FILES <- 4L
if (KEEP_FILES < 2L) stop("--keep-files must be at least 2")

HIST <- Sys.getenv("PARCEL_HISTORY_DIR")
if (!nzchar(HIST)) HIST <- file.path(mb_parcelsearch_root, "history")
P <- list(catalog  = file.path(HIST, "snapshots.parquet"),
          state    = file.path(HIST, "state.parquet"),
          versions = file.path(HIST, "parcel_versions.parquet"),
          deltas   = file.path(HIST, "deltas"),
          quar     = file.path(HIST, "quarantine"))
delta_path <- function(id) file.path(P$deltas, paste0(id, ".parquet"))
quar_path  <- function(id) file.path(P$quar, paste0(id, "_gone.txt"))
log <- function(...) { cat(format(Sys.time(), "%H:%M:%S"), sprintf(...), "\n"); flush.console() }

read_catalog <- function() {
  if (!file.exists(P$catalog)) return(NULL)
  c <- as.data.frame(arrow::read_parquet(P$catalog))
  c$snapshot_date <- as.Date(c$snapshot_date)
  c
}
write_catalog <- function(c) atomic_write(P$catalog, function(tmp) arrow::write_parquet(c, tmp))
write_state   <- function(s) atomic_write(P$state,   function(tmp) arrow::write_parquet(s, tmp))

read_deltas <- function(ids) {
  if (!length(ids)) return(NULL)
  do.call(rbind, lapply(ids, function(id) { d <- read_geoparquet(delta_path(id)); d$snapshot_date <- as.Date(d$snapshot_date); d }))
}

#' Re-derive versions + state from the stored deltas of the accepted snapshots.
replay <- function(catalog) {
  acc <- catalog[catalog$status == "accepted", ]
  acc <- acc[order(acc$snapshot_date), ]
  ctx <- new_context()
  log("replaying %d accepted snapshot delta(s)", nrow(acc))
  all_d <- list()
  for (i in seq_len(nrow(acc))) {
    d <- read_deltas(acc$snapshot_id[i])
    ctx$versions <- apply_delta(ctx$versions, d, acc$snapshot_date[i], ctx$last_date, ph_params())
    ctx$last_date <- acc$snapshot_date[i]
    all_d[[i]] <- sf::st_drop_geometry(d)
  }
  ctx$state <- if (length(all_d)) state_from_deltas(do.call(rbind, all_d)) else empty_state()
  last <- catalog[order(catalog$snapshot_date), ][nrow(catalog), ]
  if (nrow(catalog) && last$status == "quarantined" && file.exists(quar_path(last$snapshot_id)))
    ctx$quarantine_gone <- readLines(quar_path(last$snapshot_id))
  ctx
}

main <- function() {
files <- list_snapshot_files(mb_parcelsearch_root, mao_snapshots_root)
if (!nrow(files)) stop("no snapshot files found")
pref <- files[files$preferred, ]
catalog <- read_catalog()
log("%d snapshot file(s) on disk, %d dates; %d processed", nrow(files), nrow(pref), NROW(catalog))

# ---- has the evidence changed under us? ----------------------------------------
pref$sha256 <- NA_character_
known <- if (is.null(catalog)) data.frame(path = character(), size = numeric(), sha256 = character()) else catalog
for (i in seq_len(nrow(pref))) {
  k <- match(pref$snapshot_id[i], known$snapshot_id %||% character())
  recent <- pref$snapshot_date[i] >= Sys.Date() - 14
  pref$sha256[i] <- if (!is.na(k) && identical(known$size[k], pref$size[i]) && !recent) known$sha256[k]
                    else file_sha256(pref$path[i])
}
dirty <- REBUILD_FROM
if (!is.null(catalog) && nrow(catalog)) {
  last_done <- max(catalog$snapshot_date)
  m <- match(catalog$snapshot_date, pref$snapshot_date)
  changed_file <- catalog$snapshot_date[is.na(m) | pref$snapshot_id[m] != catalog$snapshot_id |
                                          pref$sha256[m] != catalog$sha256]
  late <- pref$snapshot_date[pref$snapshot_date <= last_done & !pref$snapshot_date %in% catalog$snapshot_date]
  cand <- c(changed_file, late)
  # A processed snapshot whose file is simply gone (pruned) is NOT a reason to
  # rebuild: its delta is the record. Only replaced or new evidence is.
  gone_files <- catalog$snapshot_date[is.na(m)]
  cand <- cand[!cand %in% gone_files]
  if (length(cand)) {
    log("evidence changed for: %s", paste(format(sort(unique(cand))), collapse = ", "))
    dirty <- min(c(dirty, cand), na.rm = TRUE)
  }
}

if (DRY_RUN) {
  todo <- pref[is.null(catalog) | !pref$snapshot_date %in% (catalog$snapshot_date %||% as.Date(character())) |
                 (!is.na(dirty) & pref$snapshot_date >= dirty), ]
  log("dry run: rebuild from %s; would process: %s", format(dirty), paste(todo$snapshot_id, collapse = ", "))
  return(0L)
}

# ---- load or re-derive the working context -------------------------------------
if (!is.na(dirty)) {
  drop <- catalog[catalog$snapshot_date >= dirty, ]
  missing <- drop$snapshot_date[!drop$snapshot_date %in% pref$snapshot_date & drop$status == "accepted"]
  if (length(missing)) stop("cannot rebuild from ", dirty, ": snapshot file(s) no longer on disk for ",
                            paste(format(missing), collapse = ", "))
  log("rebuilding from %s: dropping %d processed snapshot(s)", format(dirty), nrow(drop))
  for (id in drop$snapshot_id) { unlink(delta_path(id)); unlink(quar_path(id)) }
  catalog <- catalog[catalog$snapshot_date < dirty, ]
  write_catalog(catalog)
  ctx <- replay(catalog)
} else if (is.null(catalog) || !nrow(catalog)) {
  catalog <- NULL
  ctx <- new_context()
} else {
  ctx <- new_context()
  ok <- file.exists(P$versions) && file.exists(P$state) && !REBUILD
  if (ok) {
    ctx$versions <- read_geoparquet(P$versions)
    for (dc in c("first_seen", "last_seen", "open_not_before", "close_not_after"))
      ctx$versions[[dc]] <- as.Date(ctx$versions[[dc]])
    ctx$state <- as.data.frame(arrow::read_parquet(P$state))
    acc_last <- max(catalog$snapshot_date[catalog$status == "accepted"])
    # Crash between writing versions and the catalog leaves versions AHEAD of
    # the catalog; the catalog is the commit point, so re-derive.
    ok <- nrow(ctx$versions) && max(ctx$versions$last_seen) == acc_last
    if (!ok) log("versions out of step with catalog -> replay")
  }
  if (!ok) ctx <- replay(catalog)
  ctx$last_date <- max(catalog$snapshot_date[catalog$status == "accepted"])
  last <- catalog[order(catalog$snapshot_date), ][nrow(catalog), ]
  if (last$status == "quarantined" && file.exists(quar_path(last$snapshot_id)))
    ctx$quarantine_gone <- readLines(quar_path(last$snapshot_id))
}

checkpoint <- function(ctx, catalog) {
  ctx$versions <- tag_realignments(ctx$versions)
  ctx$versions <- mark_provisional(ctx$versions, ctx$last_date)
  write_geoparquet(ctx$versions, P$versions)
  write_state(ctx$state)
  write_catalog(catalog)          # last: the commit point
  ctx
}

# ---- process new snapshots -------------------------------------------------------
done_dates <- catalog$snapshot_date %||% as.Date(character())
pending <- pref[!pref$snapshot_date %in% done_dates, ]
pending <- pending[order(pending$snapshot_date), ]
if (!is.na(ctx$last_date)) pending <- pending[pending$snapshot_date > max(done_dates), ]
pending <- head(pending, MAX_NEW)
log("%d snapshot(s) to process", nrow(pending))

quarantined_now <- character()
for (i in seq_len(nrow(pending))) {
  f <- pending[i, ]
  t0 <- Sys.time()
  log("== %s (%s)", f$snapshot_id, basename(f$path))
  snap <- read_snapshot(f$path)
  qc0 <- attr(snap, "qc")
  log("   read %d rows -> %d LINCs (no key %d, empty %d, dup-merged %d)",
      qc0$n_raw, nrow(snap), qc0$n_no_key, qc0$n_empty, qc0$n_dup_merged)
  r <- ingest_snapshot(ctx, snap, f$snapshot_date, force_accept = f$snapshot_id %in% ACCEPT)
  q <- r$qc
  log("   vs previous accepted: new %d, gone %d, geom-hash changed %d, attr-only %d -> %s (%s)",
      q$n_new, q$n_gone, q$n_geom, q$n_attr, toupper(r$decision$status), r$decision$reason)
  if (r$decision$status == "accepted") {
    write_geoparquet(r$delta, delta_path(f$snapshot_id))
  } else {
    dir.create(P$quar, showWarnings = FALSE, recursive = TRUE)
    writeLines(r$ctx$quarantine_gone, quar_path(f$snapshot_id))
    quarantined_now <- c(quarantined_now, f$snapshot_id)
  }
  ctx <- r$ctx
  vv <- ctx$versions
  row <- data.frame(snapshot_id = f$snapshot_id, snapshot_date = f$snapshot_date, source = f$source,
                    path = f$path, size = f$size, sha256 = f$sha256,
                    status = r$decision$status, reason = r$decision$reason,
                    n_raw = qc0$n_raw, n_no_key = qc0$n_no_key, n_empty = qc0$n_empty,
                    n_dup_merged = qc0$n_dup_merged, n_linc = q$n_cur, n_prev = q$n_prev,
                    n_new = q$n_new, n_gone = q$n_gone, n_geom_hash = q$n_geom, n_attr = q$n_attr,
                    n_reshaped = sum(vv$first_seen == f$snapshot_date & vv$opened_reason == "reshaped"),
                    n_opened_new = sum(vv$first_seen == f$snapshot_date & vv$opened_reason == "new"),
                    processed_at = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
                    algorithm_version = PH_ALGORITHM_VERSION, stringsAsFactors = FALSE)
  catalog <- if (is.null(catalog)) row else rbind(catalog, row[, names(catalog)])
  ctx <- checkpoint(ctx, catalog)
  log("   versions now %d (%d open); %.1f min", nrow(ctx$versions), sum(is.na(ctx$versions$closed_reason)),
      as.numeric(difftime(Sys.time(), t0, units = "mins")))
}

if (!nrow(pending) && (REBUILD || !is.na(dirty))) ctx <- checkpoint(ctx, catalog)

# ---- prune weekly RollEntry files the history no longer needs --------------------
# ~265 MB each, weekly: ~14 GB/year if nothing deletes them. Once a snapshot is
# accepted its delta in history/deltas/ is the record (replay and --rebuild read
# deltas, not files, and a processed file that is merely gone does not trigger a
# rebuild). Deleted only when ALL hold: weekly (never the semiannual archive),
# accepted, delta on disk, SHA-256 matches the catalog, and not among the newest
# KEEP_FILES weekly files (every other reader takes the newest file, and
# --rebuild-from needs files from its date on). Quarantined and unprocessed
# files are never deleted. Dropbox keeps deleted files recoverable for a while.
if (!NO_PRUNE) {
  wk <- pref[pref$source == "weekly", ]
  wk <- wk[order(wk$snapshot_date, decreasing = TRUE), ]
  old <- wk[-seq_len(min(KEEP_FILES, nrow(wk))), ]
  k <- match(old$snapshot_id, catalog$snapshot_id)
  ok <- !is.na(k) & catalog$status[k] %in% "accepted" & old$sha256 == catalog$sha256[k] &
        file.exists(delta_path(old$snapshot_id))
  prune <- old[ok, ]
  if (nrow(prune)) {
    gone <- vapply(prune$path, function(f) isTRUE(file.remove(f)), TRUE)
    log("pruned %d weekly file(s), %.0f MB: %s", sum(gone), sum(prune$size[gone]) / 2^20,
        paste(basename(prune$path[gone]), collapse = ", "))
    if (any(!gone)) log("could not delete: %s", paste(basename(prune$path[!gone]), collapse = ", "))
  }
  if (nrow(old) > nrow(prune))
    log("kept older weekly file(s) not safe to prune: %s", paste(basename(old$path[!ok]), collapse = ", "))
}

v <- sf::st_drop_geometry(ctx$versions)
log("done: %d versions over %d LINCs; reasons opened: %s", nrow(v), length(unique(v$linc)),
    paste(names(table(v$opened_reason)), table(v$opened_reason), sep = "=", collapse = " "))
if (length(quarantined_now)) {
  log("QUARANTINED this run: %s. See %s; re-run with --accept <id> if the change is real.",
      paste(quarantined_now, collapse = ", "), P$catalog)
  return(2L)
}
0L
}

# Top-level on.exit() does nothing under Rscript, so the lock is released in a
# finally around the whole run instead.
lock <- if (!DRY_RUN) acquire_lock(HIST) else NULL
status <- tryCatch(main(), finally = if (!is.null(lock)) release_lock(lock))
quit(status = status)
