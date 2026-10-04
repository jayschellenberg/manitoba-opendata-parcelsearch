# parcel_history_lib.R
#
# Parcel change history for Manitoba ROLL_ENTRY: which outline (and roll) a
# parcel had on a given date, and which earlier parcels a parcel came from.
# The main use is matching a sale to the parcel as it existed on the sale date.
#
# Sourced by r/build_parcel_history.R, r/build_lineage.R (--tables) and
# r/test_parcel_history.R. Everything here is a pure function of its inputs
# except the small IO helpers at the top; the drivers own the files.
#
# WHAT THE SOURCE CAN AND CANNOT TELL US
#   ROLL_ENTRY has no edit dates, no editor tracking and no parent-roll field.
#   The only evidence is a sequence of full snapshots (RollEntry_*.gpkg weekly,
#   MBRollGeoPackage*.gpkg semiannually). So:
#     - a change is known only to have happened inside the window between the
#       last snapshot showing the old form and the first showing the new one.
#       Those window ends are stored; no point "effective date" is invented.
#     - lineage is INFERRED from geometric overlap. It says which registered
#       plan / title to pull, not what the plan says.
#
# IDENTITY
#   Roll_No_Txt repeats across municipalities (438k rows, ~121k distinct roll
#   numbers on 2026-10-04). The key is LINC, built exactly as mao-assembly's
#   1CombineMBFiles.R builds it: <3-digit muni code>R<roll, '.' removed,
#   left-padded to 9>, e.g. 168R707400000. Unlike mao-assembly, a row with no
#   muni code or roll is dropped (and counted) rather than given a row-number
#   LINC, because a row-number key is different in every snapshot.
#
# TABLES (all under <mb_parcelsearch_root>/history/, GeoParquet, EPSG:26914)
#   snapshots.parquet       catalog of every snapshot file seen + its QC verdict
#   state.parquet           per-LINC hashes/attributes of the last ACCEPTED snapshot
#   deltas/<id>.parquet     what changed vs the previous accepted snapshot
#                           (new / geom / attr / gone), geometry only where new
#                           or changed. Raw evidence; never edited, only dropped
#                           and rebuilt when the snapshot file itself changes.
#   parcel_versions.parquet one row per geometry version of each LINC. DERIVED
#                           from the deltas, so it can be rebuilt with different
#                           thresholds at any time (--rebuild).
#   lineage_edges.parquet / lineage_events.parquet  written by build_lineage.R --tables

suppressPackageStartupMessages({
  library(sf)
  library(dplyr)
  library(arrow)
})

PH_ALGORITHM_VERSION <- "1"
PH_CRS <- 26914                 # NAD83 / UTM 14N: metric, the archive CRS-of-record

# The unchanged-prefilter hash is taken on coordinates snapped to this grid
# (1 cm). It only decides "skip the geometric test"; it never decides "changed".
PH_HASH_PRECISION <- 100

# A geometry counts as RESHAPED when the area of the symmetric difference between
# the version's outline and the new outline exceeds max(PH_RESHAPE_MIN_M2,
# PH_RESHAPE_FRAC x the larger area). Net area alone is not used: on 2026-09-06
# -> 10-04, 43 parcels moved >5% of their area with <1 m2 net area change.
# Weekly noise pairs measured that month were all < 1 m2 of symmetric difference.
PH_RESHAPE_MIN_M2 <- 5
PH_RESHAPE_FRAC   <- 0.001

# Snapshot quarantine. A snapshot whose roll set loses more than this fraction
# of the previous accepted snapshot's LINCs, or shrinks by more than
# PH_MAX_SHRINK_FRAC, is recorded but NOT applied: the 2026-05-06 file was
# missing ~6,457 rolls that were back on 2026-07-01, and applying it would have
# written thousands of false retirements. A real mass change (e.g. an
# amalgamation renumbering) is accepted when the NEXT snapshot shows the same
# losses (PH_CONFIRM_OVERLAP of its gone set matches), or by --accept <id>.
PH_MAX_GONE_FRAC   <- 0.005
PH_MAX_SHRINK_FRAC <- 0.01
PH_CONFIRM_OVERLAP <- 0.8

# Lineage: keep a parent->child overlap when it covers at least this share of
# EITHER parcel. Either-direction matters: a small parent folded into a large
# consolidation covers 100% of itself and maybe 2% of the result.
PH_LINEAGE_MIN_COVER   <- 0.05
PH_LINEAGE_MIN_M2      <- 1
# Edges covering >= this share of either parcel are STRONG and always kept.
# Weaker ones (MIN_COVER..STRONG) are kept only to explain a version that would
# otherwise have no predecessor/successor (a new LINC, or a retired one). Without
# this, where MAO redrew a whole area's parcel fabric (munis 146/163/184/203 in
# 2026), every reshaped lot overlapped its neighbours' old outlines by a few
# percent and chained hundreds of unrelated lots into one "reconfiguration".
PH_LINEAGE_STRONG_COVER <- 0.5
PH_RENUMBER_MIN_COVER  <- 0.90   # 1:1 with both covers >= this -> possible_renumber

PH_ATTR_COLS <- c("Property_Address", "Asmt_Roll", "Total_Value", "Frontage_or_Area", "Dwelling_Units")

`%||%` <- function(a, b) if (is.null(a) || length(a) == 0) b else a

ph_params <- function(...) {
  p <- list(reshape_min_m2 = PH_RESHAPE_MIN_M2, reshape_frac = PH_RESHAPE_FRAC,
            max_gone_frac = PH_MAX_GONE_FRAC, max_shrink_frac = PH_MAX_SHRINK_FRAC,
            confirm_overlap = PH_CONFIRM_OVERLAP,
            lineage_min_cover = PH_LINEAGE_MIN_COVER, lineage_min_m2 = PH_LINEAGE_MIN_M2,
            lineage_strong_cover = PH_LINEAGE_STRONG_COVER,
            renumber_min_cover = PH_RENUMBER_MIN_COVER)
  o <- list(...)
  p[names(o)] <- o
  p
}

# ---- identity ----------------------------------------------------------------

#' LINC as built by mao-assembly/scripts/1CombineMBFiles.R: "<muni3>R<roll9>".
#' NA when either part is missing (callers drop those rows).
make_linc <- function(municipality, roll_txt) {
  muni <- stringr::str_extract(as.character(municipality), "^\\d{3}")
  roll <- as.character(roll_txt)
  roll[!is.na(roll) & !nzchar(trimws(roll))] <- NA
  roll <- ifelse(is.na(roll), NA_character_,
                 stringr::str_pad(gsub(".", "", roll, fixed = TRUE), 9, "left", "0"))
  ifelse(is.na(muni) | is.na(roll), NA_character_, paste0(muni, "R", roll))
}

# ---- IO helpers ---------------------------------------------------------------

# Directory this file was source()d from (source() keeps it in `ofile`).
.ph_lib_dir <- tryCatch(dirname(sys.frame(1)$ofile), error = function(e) "r")

# PROJJSON for EPSG:26914, exported once with `gdalsrsinfo -o PROJJSON` (sf has
# no PROJJSON writer). Without it GeoParquet readers would assume OGC:CRS84.
.projjson_26914 <- function() {
  f <- file.path(.ph_lib_dir, "crs", "epsg26914.projjson")
  if (!file.exists(f)) stop("missing ", f)
  jsonlite::fromJSON(f, simplifyVector = FALSE)
}

#' Write a data.frame with an sfc (or list-of-WKB) column as GeoParquet 1.1
#' (WKB, EPSG:26914 PROJJSON). Atomic: tmp file then rename.
write_geoparquet <- function(df, path, geom_col = "geometry") {
  g <- df[[geom_col]]
  wkb <- if (inherits(g, "sfc")) {
    w <- unclass(sf::st_as_binary(g))
    w[sf::st_is_empty(g)] <- list(NULL)
    w
  } else g
  plain <- if (inherits(df, "sf")) sf::st_drop_geometry(df) else df
  plain[[geom_col]] <- NULL
  tbl <- arrow::arrow_table(plain)
  tbl$geometry <- arrow::Array$create(wkb, type = arrow::binary())
  tbl$metadata$geo <- jsonlite::toJSON(list(
    version = "1.1.0", primary_column = "geometry",
    columns = list(geometry = list(encoding = "WKB", geometry_types = list(),
                                   crs = .projjson_26914()))),
    auto_unbox = TRUE, null = "null")
  tbl$metadata$r <- NULL
  atomic_write(path, function(tmp) arrow::write_parquet(tbl, tmp))
}

#' Read GeoParquet written by write_geoparquet() back to sf (missing geometry
#' becomes an empty geometry).
read_geoparquet <- function(path) {
  d <- as.data.frame(arrow::read_parquet(path))
  w <- d$geometry; d$geometry <- NULL
  w <- lapply(w, function(x) if (is.null(x) || !length(x)) NULL else as.raw(x))
  empty <- vapply(w, is.null, TRUE)
  g <- vector("list", length(w))
  if (any(!empty)) g[!empty] <- as.list(sf::st_as_sfc(structure(w[!empty], class = "WKB"), crs = PH_CRS))
  g[empty] <- list(sf::st_multipolygon())
  sf::st_sf(d, geometry = sf::st_sfc(g, crs = PH_CRS))
}

atomic_write <- function(path, writer) {
  dir.create(dirname(path), showWarnings = FALSE, recursive = TRUE)
  tmp <- paste0(path, ".tmp")
  writer(tmp)
  if (file.exists(path)) unlink(path)
  if (!file.rename(tmp, path)) {
    # file.rename can fail under Dropbox/AV locks: copy + delete.
    if (!file.copy(tmp, path, overwrite = TRUE)) { unlink(tmp); stop("could not move ", tmp, " into place") }
    unlink(tmp)
  }
  invisible(path)
}

#' Exclusive lock (dir.create is atomic). A lock older than `stale_hours` is
#' assumed to belong to a crashed run and is broken with a warning.
acquire_lock <- function(dir, stale_hours = 8) {
  lock <- file.path(dir, ".lock")
  dir.create(dir, showWarnings = FALSE, recursive = TRUE)
  if (dir.exists(lock)) {
    age <- as.numeric(difftime(Sys.time(), file.info(lock)$mtime, units = "hours"))
    if (age < stale_hours) stop("history is locked by another run (", lock, ", ", round(age, 1), " h old)")
    warning("breaking stale history lock (", round(age, 1), " h old)")
    unlink(lock, recursive = TRUE)
  }
  if (!dir.create(lock)) stop("could not acquire ", lock)
  lock
}
release_lock <- function(lock) unlink(lock, recursive = TRUE)

# ---- snapshot files -----------------------------------------------------------

#' Every candidate snapshot file, one row each. Where two files share a date the
#' semiannual archive is preferred (it is the source-of-record copy).
list_snapshot_files <- function(weekly_dir, archive_root) {
  w <- list.files(weekly_dir, pattern = "^RollEntry_\\d{8}\\.gpkg$", full.names = TRUE)
  a <- if (dir.exists(archive_root))
    list.files(archive_root, pattern = "^MBRollGeoPackage\\d{8}\\.gpkg$", recursive = TRUE, full.names = TRUE)
  else character(0)
  if (!length(c(a, w))) return(data.frame())
  df <- data.frame(path = normalizePath(c(a, w), winslash = "/"),
                   source = c(rep("archive", length(a)), rep("weekly", length(w))),
                   stringsAsFactors = FALSE)
  df$snapshot_date <- as.Date(regmatches(basename(df$path), regexpr("\\d{8}", basename(df$path))), "%Y%m%d")
  df$snapshot_id <- paste0(format(df$snapshot_date, "%Y%m%d"), "_", df$source)
  df$size <- file.size(df$path)
  df <- df[order(df$snapshot_date, df$source != "archive"), ]
  df$preferred <- !duplicated(df$snapshot_date)
  rownames(df) <- NULL
  df
}

file_sha256 <- function(path) digest::digest(file = path, algo = "sha256")

#' Read one snapshot file into the normalised form the diff works on.
read_snapshot <- function(path) {
  lyr <- sf::st_layers(path)$name[1]
  g <- sf::st_read(path, layer = lyr, quiet = TRUE)
  keep <- intersect(c("Roll_No_Txt", "Municipality", PH_ATTR_COLS), names(g))
  g <- g[, keep]
  normalise_snapshot(g)
}

#' Key, reproject, repair, hash. Input: sf with Roll_No_Txt, Municipality and
#' (optionally) the PH_ATTR_COLS. Output: sf in EPSG:26914 with linc, muni_no,
#' area_m2, geom_hash, attr_hash; attr(, "qc") holds row accounting.
normalise_snapshot <- function(g) {
  n_raw <- nrow(g)
  gc <- attr(g, "sf_column")
  if (gc != "geometry") { names(g)[names(g) == gc] <- "geometry"; sf::st_geometry(g) <- "geometry" }
  for (a in PH_ATTR_COLS) if (!a %in% names(g)) g[[a]] <- NA
  g$linc <- make_linc(g$Municipality, g$Roll_No_Txt)
  n_no_key <- sum(is.na(g$linc))
  g <- g[!is.na(g$linc), ]
  g$muni_no <- as.integer(substr(g$linc, 1, 3))
  g <- sf::st_transform(g, PH_CRS)
  g <- sf::st_make_valid(g)
  g <- polygonal_only(g)
  n_empty <- sum(sf::st_is_empty(g))
  g <- g[!sf::st_is_empty(g), ]

  # Duplicate LINCs inside one snapshot (none observed 2026-09/10): merge the
  # pieces so the key stays unique, and count them so the catalog shows it.
  dup <- unique(g$linc[duplicated(g$linc)])
  if (length(dup)) {
    d <- g[g$linc %in% dup, ]
    merged <- d |> group_by(linc) |>
      summarise(across(c(Roll_No_Txt, Municipality, muni_no, all_of(PH_ATTR_COLS)), first),
                geometry = sf::st_union(geometry), .groups = "drop")
    merged <- polygonal_only(sf::st_make_valid(merged))
    g <- rbind(g[!g$linc %in% dup, names(merged)], merged[, names(merged)])
  }

  g$area_m2   <- as.numeric(sf::st_area(g))
  g$geom_hash <- geom_hash(sf::st_geometry(g))
  g$attr_hash <- attr_hash(sf::st_drop_geometry(g))
  attr(g, "qc") <- list(n_raw = n_raw, n_no_key = n_no_key, n_empty = n_empty,
                        n_dup_merged = length(dup))
  g
}

#' st_make_valid can return GEOMETRYCOLLECTIONs (polygon + stray line). Keep the
#' polygonal part and cast everything to MULTIPOLYGON so versions are uniform.
polygonal_only <- function(g) {
  geom <- sf::st_geometry(g)
  ty <- as.character(sf::st_geometry_type(geom))
  bad <- which(!ty %in% c("POLYGON", "MULTIPOLYGON"))
  if (length(bad)) {
    geom[bad] <- lapply(geom[bad], function(x) {
      parts <- sf::st_collection_extract(sf::st_sfc(x), "POLYGON")
      if (!length(parts)) sf::st_multipolygon() else sf::st_combine(parts)[[1]] |> sf::st_cast("MULTIPOLYGON")
    })
  }
  sf::st_geometry(g) <- sf::st_cast(geom, "MULTIPOLYGON")
  g
}

geom_hash <- function(sfc) {
  wkb <- sf::st_as_binary(sf::st_set_precision(sfc, PH_HASH_PRECISION))
  vapply(wkb, function(x) digest::digest(x, algo = "xxhash64", serialize = FALSE), "")
}

attr_hash <- function(df) {
  key <- do.call(paste, c(lapply(PH_ATTR_COLS, function(a) as.character(df[[a]])), sep = "\x1f"))
  vapply(key, function(x) digest::digest(x, algo = "xxhash64", serialize = FALSE), "", USE.NAMES = FALSE)
}

# ---- diff + QC ---------------------------------------------------------------

# All-empty sfc. (sf warns computing the bbox of nothing; that is expected here.)
empty_sfc <- function(n) suppressWarnings(sf::st_sfc(rep(list(sf::st_multipolygon()), n), crs = PH_CRS))

STATE_COLS <- c("linc", "Roll_No_Txt", "muni_no", "geom_hash", "attr_hash", "area_m2", PH_ATTR_COLS)

empty_state <- function() {
  s <- data.frame(linc = character(), Roll_No_Txt = character(), muni_no = integer(),
                  geom_hash = character(), attr_hash = character(), area_m2 = numeric(),
                  stringsAsFactors = FALSE)
  for (a in PH_ATTR_COLS) s[[a]] <- character()
  s
}

state_from_snapshot <- function(snap) {
  s <- sf::st_drop_geometry(snap)[, STATE_COLS]
  for (a in PH_ATTR_COLS) s[[a]] <- as.character(s[[a]])
  rownames(s) <- NULL
  s
}

#' Compare a normalised snapshot to the previous accepted state.
#' Returns list(delta = sf of change rows, qc = counts, gone = LINCs gone).
diff_against_state <- function(snap, state) {
  cur <- sf::st_drop_geometry(snap)
  m <- match(cur$linc, state$linc)
  is_new  <- is.na(m)
  is_geom <- !is_new & cur$geom_hash != state$geom_hash[m]
  is_attr <- !is_new & !is_geom & cur$attr_hash != state$attr_hash[m]
  gone <- setdiff(state$linc, cur$linc)

  keep <- is_new | is_geom | is_attr
  d <- snap[keep, c("linc", "Roll_No_Txt", "muni_no", "geom_hash", "attr_hash", "area_m2", PH_ATTR_COLS)]
  d$kind <- ifelse(is_new[keep], "new", ifelse(is_geom[keep], "geom", "attr"))
  for (a in PH_ATTR_COLS) d[[a]] <- as.character(d[[a]])
  # Attribute-only rows carry no geometry: it is unchanged and already recorded.
  if (any(d$kind == "attr")) {
    geom <- sf::st_geometry(d)
    geom[d$kind == "attr"] <- list(sf::st_multipolygon())
    sf::st_geometry(d) <- geom
  }

  if (length(gone)) {
    gs <- state[match(gone, state$linc), STATE_COLS]
    gs$kind <- "gone"
    gs <- sf::st_sf(gs, geometry = empty_sfc(nrow(gs)))
    d <- suppressWarnings(rbind(d[, names(gs)], gs))
  }
  qc <- list(n_cur = nrow(cur), n_prev = nrow(state), n_new = sum(is_new), n_gone = length(gone),
             n_geom = sum(is_geom), n_attr = sum(is_attr))
  list(delta = d, qc = qc, gone = gone)
}

#' Accept or quarantine a snapshot. `prev_quarantine_gone` is the gone set of the
#' immediately preceding snapshot if IT was quarantined (else NULL).
qc_decide <- function(qc, gone, prev_quarantine_gone = NULL, force_accept = FALSE, params = ph_params()) {
  if (qc$n_prev == 0) return(list(status = "accepted", reason = "baseline"))
  gone_frac <- qc$n_gone / qc$n_prev
  shrink    <- 1 - qc$n_cur / qc$n_prev
  bad <- c(if (gone_frac > params$max_gone_frac)
             sprintf("%d of %d LINCs gone (%.2f%% > %.2f%%)", qc$n_gone, qc$n_prev, 100 * gone_frac, 100 * params$max_gone_frac),
           if (shrink > params$max_shrink_frac)
             sprintf("row count fell %.2f%% (> %.2f%%)", 100 * shrink, 100 * params$max_shrink_frac))
  if (!length(bad)) return(list(status = "accepted", reason = "within thresholds"))
  if (force_accept) return(list(status = "accepted", reason = paste("forced:", paste(bad, collapse = "; "))))
  if (length(prev_quarantine_gone) && length(gone)) {
    ov <- length(intersect(gone, prev_quarantine_gone)) / length(gone)
    if (ov >= params$confirm_overlap)
      return(list(status = "accepted",
                  reason = sprintf("confirmed: %.0f%% of losses repeat the previous quarantined snapshot", 100 * ov)))
  }
  list(status = "quarantined", reason = paste(bad, collapse = "; "))
}

#' Rebuild the last accepted state from the deltas alone (used by --rebuild-from).
state_from_deltas <- function(deltas) {
  if (!nrow(deltas)) return(empty_state())
  d <- sf::st_drop_geometry(deltas)
  d <- d[order(d$snapshot_date), ]
  last <- d[!duplicated(d$linc, fromLast = TRUE), ]
  last <- last[last$kind != "gone", STATE_COLS]
  rownames(last) <- NULL
  last
}

# ---- versions ----------------------------------------------------------------

VERSION_COLS <- c("version_id", "linc", "Roll_No_Txt", "muni_no", "first_seen", "last_seen",
                  "open_not_before", "close_not_after", "opened_reason", "closed_reason",
                  "provisional", "gap_count", "area_m2", "symdiff_prev_m2",
                  "Property_Address", "Frontage_or_Area", "Asmt_Roll", "algorithm_version")

empty_versions <- function() {
  v <- data.frame(version_id = character(), linc = character(), Roll_No_Txt = character(),
                  muni_no = integer(), first_seen = as.Date(character()), last_seen = as.Date(character()),
                  open_not_before = as.Date(character()), close_not_after = as.Date(character()),
                  opened_reason = character(), closed_reason = character(), provisional = logical(),
                  gap_count = integer(), area_m2 = numeric(), symdiff_prev_m2 = numeric(),
                  Property_Address = character(), Frontage_or_Area = character(), Asmt_Roll = character(),
                  algorithm_version = character(), stringsAsFactors = FALSE)
  sf::st_sf(v, geometry = sf::st_sfc(crs = PH_CRS))
}

#' Area of the symmetric difference of each pair a[i], b[i] (m2). NA if GEOS fails.
symdiff_area <- function(a, b) {
  stopifnot(length(a) == length(b))
  if (!length(a)) return(numeric())
  aa <- as.numeric(sf::st_area(a)); bb <- as.numeric(sf::st_area(b))
  inter <- vapply(seq_along(a), function(i) {
    r <- tryCatch(sf::st_intersection(a[[i]], b[[i]]), error = function(e) NULL)
    if (is.null(r)) NA_real_ else if (sf::st_is_empty(r)) 0 else sum(as.numeric(sf::st_area(sf::st_sfc(r))))
  }, 0)
  pmax(aa + bb - 2 * inter, 0)
}

reshape_threshold <- function(area_a, area_b, params) {
  pmax(params$reshape_min_m2, params$reshape_frac * pmax(area_a, area_b))
}

new_version_rows <- function(d, first_seen, open_not_before, opened_reason, symdiff_prev = NA_real_, gap = 0L) {
  n <- nrow(d)
  sf::st_sf(
    version_id = paste0(d$linc, "@", format(first_seen, "%Y%m%d")),
    linc = d$linc, Roll_No_Txt = d$Roll_No_Txt, muni_no = as.integer(d$muni_no),
    first_seen = rep(first_seen, n), last_seen = rep(first_seen, n),
    open_not_before = if (length(open_not_before) == 1) rep(open_not_before, n) else open_not_before,
    close_not_after = rep(as.Date(NA), n),
    opened_reason = rep(opened_reason, n), closed_reason = rep(NA_character_, n),
    provisional = rep(FALSE, n), gap_count = rep(as.integer(gap), n),
    area_m2 = d$area_m2,
    symdiff_prev_m2 = if (length(symdiff_prev) == 1) rep(symdiff_prev, n) else symdiff_prev,
    Property_Address = as.character(d$Property_Address), Frontage_or_Area = as.character(d$Frontage_or_Area),
    Asmt_Roll = as.character(d$Asmt_Roll), algorithm_version = rep(PH_ALGORITHM_VERSION, n),
    geometry = sf::st_geometry(d))
}

#' Apply one accepted snapshot's delta to the version table.
#'   versions   current version table (sf)
#'   delta      rows from diff_against_state() for this snapshot
#'   snap_date  date of this snapshot; prev_date the previous ACCEPTED one (NA = first)
apply_delta <- function(versions, delta, snap_date, prev_date, params = ph_params()) {
  v <- versions
  open_before <- which(is.na(v$closed_reason))
  baseline <- is.na(prev_date)
  add <- list()

  # 1. gone: close the open version. Tentatively "retired": if the LINC comes
  #    back it is re-opened (a gap, not a retirement).
  gone <- delta$linc[delta$kind == "gone"]
  gi <- open_before[match(gone, v$linc[open_before])]
  gi <- gi[!is.na(gi)]
  v$closed_reason[gi]   <- "retired"
  v$close_not_after[gi] <- snap_date

  # 2. geometry changed: geometric test against the VERSION outline (not last
  #    week's), so sub-threshold drift cannot accumulate unnoticed.
  gd <- delta[delta$kind == "geom", ]
  if (nrow(gd)) {
    vi <- open_before[match(gd$linc, v$linc[open_before])]
    ok <- !is.na(vi); gd <- gd[ok, ]; vi <- vi[ok]
    sd <- rep(NA_real_, nrow(gd))
    thr <- reshape_threshold(v$area_m2[vi], gd$area_m2, params)
    # symdiff >= |net area change|, so a big net change is a reshape without GEOS.
    sure <- abs(v$area_m2[vi] - gd$area_m2) > thr
    need <- which(!sure)
    if (length(need)) sd[need] <- symdiff_area(sf::st_geometry(v)[vi[need]], sf::st_geometry(gd)[need])
    if (any(sure)) sd[sure] <- symdiff_area(sf::st_geometry(v)[vi[sure]], sf::st_geometry(gd)[sure])
    reshaped <- is.na(sd) | sd > thr   # GEOS failure: treat as changed, never silently same
    ri <- vi[reshaped]
    v$closed_reason[ri]   <- "reshaped"
    v$close_not_after[ri] <- snap_date
    if (any(reshaped))
      add[[length(add) + 1]] <- new_version_rows(gd[reshaped, ], snap_date, v$last_seen[ri], "reshaped",
                                                 symdiff_prev = sd[reshaped])
  }

  # 3. new LINCs: brand new, or back after an absence.
  nd <- delta[delta$kind == "new", ]
  if (nrow(nd)) {
    # Most recent version of each LINC that is closed as retired (absent).
    ret <- which(v$closed_reason %in% "retired" & !(seq_len(nrow(v)) %in% gi))
    ret <- ret[order(v$last_seen[ret], decreasing = TRUE)]
    ri <- ret[match(nd$linc, v$linc[ret])]
    back <- !is.na(ri)
    if (any(back)) {
      bd <- nd[back, ]; bi <- ri[back]
      sd <- symdiff_area(sf::st_geometry(v)[bi], sf::st_geometry(bd))
      same <- !is.na(sd) & sd <= reshape_threshold(v$area_m2[bi], bd$area_m2, params)
      si <- bi[same]
      v$closed_reason[si] <- NA; v$close_not_after[si] <- as.Date(NA)
      v$last_seen[si] <- snap_date; v$gap_count[si] <- v$gap_count[si] + 1L
      ci <- bi[!same]
      v$closed_reason[ci] <- "reshaped_during_gap"
      if (any(!same))
        add[[length(add) + 1]] <- new_version_rows(bd[!same, ], snap_date, v$last_seen[ci],
                                                   "reappeared_reshaped", symdiff_prev = sd[!same])
    }
    if (any(!back))
      add[[length(add) + 1]] <- new_version_rows(nd[!back, ], snap_date,
                                                 if (baseline) as.Date(NA) else prev_date,
                                                 if (baseline) "baseline" else "new")
  }

  # 4. every version open before and still open was seen again today.
  still <- open_before[is.na(v$closed_reason[open_before])]
  v$last_seen[still] <- snap_date

  if (length(add)) v <- rbind(v, do.call(rbind, add))
  v
}

#' One snapshot through diff -> QC -> (if accepted) versions. Shared by the
#' driver and the tests so both exercise the same path.
#'   ctx: list(state, versions, last_date, quarantine_gone)
ingest_snapshot <- function(ctx, snap, snap_date, force_accept = FALSE, params = ph_params()) {
  df <- diff_against_state(snap, ctx$state)
  dec <- qc_decide(df$qc, df$gone, ctx$quarantine_gone, force_accept, params)
  delta <- df$delta
  delta$snapshot_date <- rep(snap_date, nrow(delta))
  if (dec$status == "accepted") {
    ctx$versions <- apply_delta(ctx$versions, delta, snap_date, ctx$last_date, params)
    ctx$state <- state_from_snapshot(snap)
    ctx$last_date <- snap_date
    ctx$quarantine_gone <- NULL
  } else {
    ctx$quarantine_gone <- df$gone
  }
  list(ctx = ctx, delta = if (dec$status == "accepted") delta else NULL, qc = df$qc, decision = dec)
}

new_context <- function() list(state = empty_state(), versions = empty_versions(),
                               last_date = as.Date(NA), quarantine_gone = NULL)

#' Flag what the latest accepted snapshot cannot confirm yet: versions opened as
#' new and closures as retired at that snapshot. The next accepted snapshot
#' either confirms them or (absence -> return) re-opens them.
mark_provisional <- function(versions, last_date) {
  versions$provisional <- (versions$first_seen == last_date & versions$opened_reason %in% c("new", "reappeared_reshaped")) |
    (versions$closed_reason %in% "retired" & versions$close_not_after %in% last_date)
  versions
}

# ---- lineage -----------------------------------------------------------------

#' Overlap edges between `child` and `parent` version sets (both sf, 26914).
overlap_edges <- function(child, parent, params = ph_params()) {
  none <- data.frame(parent_version_id = character(), child_version_id = character(),
                     overlap_m2 = numeric(), overlap_pct_parent = numeric(), overlap_pct_child = numeric())
  if (!nrow(child) || !nrow(parent)) return(none)
  hits <- sf::st_intersects(child, parent)
  ci <- rep(seq_along(hits), lengths(hits)); pi <- unlist(hits)
  if (!length(ci)) return(none)
  keep <- child$version_id[ci] != parent$version_id[pi]
  ci <- ci[keep]; pi <- pi[keep]
  if (!length(ci)) return(none)
  ca <- as.numeric(sf::st_area(child))[ci]; pa <- as.numeric(sf::st_area(parent))[pi]
  ov <- vapply(seq_along(ci), function(k) {
    r <- tryCatch(sf::st_intersection(sf::st_geometry(child)[[ci[k]]], sf::st_geometry(parent)[[pi[k]]]),
                  error = function(e) NULL)
    if (is.null(r) || sf::st_is_empty(r)) 0 else sum(as.numeric(sf::st_area(sf::st_sfc(r))))
  }, 0)
  e <- data.frame(parent_version_id = parent$version_id[pi], child_version_id = child$version_id[ci],
                  overlap_m2 = ov, overlap_pct_parent = ov / pa, overlap_pct_child = ov / ca,
                  stringsAsFactors = FALSE)
  e[e$overlap_m2 >= params$lineage_min_m2 &
      (e$overlap_pct_child >= params$lineage_min_cover | e$overlap_pct_parent >= params$lineage_min_cover), ]
}

#' Lineage for one accepted window (d_prev, d_cur].
#' Backward: every version opened at d_cur (new / reshaped / reappeared) against
#'   every version alive at d_prev -> its predecessors (incl. a parent roll that
#'   continues on the remainder lot, which shows up as its own older version).
#' Forward: every version closed at d_cur against every version alive at d_cur
#'   -> successors of retired rolls, including ones absorbed by a neighbour.
lineage_window <- function(versions, d_prev, d_cur, params = ph_params()) {
  v <- versions
  alive_prev <- v[v$first_seen <= d_prev & v$last_seen >= d_prev, ]
  alive_cur  <- v[v$first_seen <= d_cur  & v$last_seen >= d_cur, ]
  opened <- v[v$first_seen == d_cur & v$opened_reason %in% c("new", "reshaped", "reappeared_reshaped"), ]
  closed <- v[v$close_not_after %in% d_cur & v$closed_reason %in% c("retired", "reshaped", "reshaped_during_gap"), ]
  e <- rbind(overlap_edges(opened, alive_prev, params), overlap_edges(alive_cur, closed, params))
  e <- e[!duplicated(e[, c("parent_version_id", "child_version_id")]), ]
  e <- prune_weak_edges(e, v, params)
  if (!nrow(e)) return(list(edges = NULL, events = NULL))

  # Connected components over versions -> events.
  nodes <- unique(c(e$parent_version_id, e$child_version_id))
  par <- seq_along(nodes)
  find <- function(i) { while (par[i] != i) { par[i] <<- par[par[i]]; i <- par[i] }; i }
  for (k in seq_len(nrow(e))) {
    a <- find(match(e$parent_version_id[k], nodes)); b <- find(match(e$child_version_id[k], nodes))
    if (a != b) par[a] <- b
  }
  comp <- vapply(seq_along(nodes), find, 0L)
  e$component <- comp[match(e$child_version_id, nodes)]

  vv <- sf::st_drop_geometry(v)
  info <- vv[match(nodes, vv$version_id), c("version_id", "linc", "muni_no", "area_m2", "close_not_after", "closed_reason")]
  lk <- function(id, col) info[[col]][match(id, info$version_id)]
  e$parent_linc <- lk(e$parent_version_id, "linc"); e$child_linc <- lk(e$child_version_id, "linc")
  e$same_linc <- e$parent_linc == e$child_linc
  e$cross_muni <- lk(e$parent_version_id, "muni_no") != lk(e$child_version_id, "muni_no")
  # A parent that is still open after d_cur kept its roll (and outline) through the change.
  e$parent_continues <- is.na(lk(e$parent_version_id, "close_not_after")) |
    lk(e$parent_version_id, "close_not_after") > d_cur

  comps <- sort(unique(e$component))
  ev <- do.call(rbind, lapply(seq_along(comps), function(j) {
    ee <- e[e$component == comps[j], ]
    pl <- sort(unique(ee$parent_linc)); cl <- sort(unique(ee$child_linc))
    type <- classify_event(pl, cl, ee, params)
    data.frame(event_id = sprintf("%s-%04d", format(d_cur, "%Y%m%d"), j),
               window_start = d_prev, window_end = d_cur, type = type,
               n_parent_lincs = length(pl), n_child_lincs = length(cl),
               parent_lincs = paste(pl, collapse = ","), child_lincs = paste(cl, collapse = ","),
               cross_muni = any(ee$cross_muni),
               confidence = round(min(pmax(ee$overlap_pct_child, ee$overlap_pct_parent)), 3),
               source = "spatial", algorithm_version = PH_ALGORITHM_VERSION,
               component = comps[j], stringsAsFactors = FALSE)
  }))
  e$event_id <- ev$event_id[match(e$component, ev$component)]
  e$relation <- ev$type[match(e$component, ev$component)]
  e$detected_date <- d_cur
  e$window_start <- d_prev
  ev$component <- NULL; e$component <- NULL
  list(edges = e, events = ev)
}

#' Keep strong edges, same-LINC edges (a reshape's own continuity), and weak
#' edges only where one end is otherwise unexplained (see PH_LINEAGE_STRONG_COVER).
prune_weak_edges <- function(e, versions, params = ph_params()) {
  if (!nrow(e)) return(e)
  linc <- versions$linc[match(c(e$parent_version_id, e$child_version_id), versions$version_id)]
  pl <- linc[seq_len(nrow(e))]; cl <- linc[nrow(e) + seq_len(nrow(e))]
  same <- pl == cl
  strong <- pmax(e$overlap_pct_parent, e$overlap_pct_child) >= params$lineage_strong_cover
  # A version is explained if it has a strong or same-LINC edge in this window.
  expl <- unique(c(e$parent_version_id[strong | same], e$child_version_id[strong | same]))
  weak_needed <- !strong & !same & (!e$parent_version_id %in% expl | !e$child_version_id %in% expl)
  e[strong | same | weak_needed, ]
}

classify_event <- function(pl, cl, ee, params) {
  if (length(pl) == 1 && length(cl) == 1) {
    if (pl == cl) return("reshape")
    if (all(ee$cross_muni)) return("administrative_transfer")
    if (all(ee$overlap_pct_parent >= params$renumber_min_cover & ee$overlap_pct_child >= params$renumber_min_cover))
      return("possible_renumber")
    return("realignment")
  }
  if (length(pl) == 1 && length(cl) >= 2)
    return(if (pl %in% cl || any(ee$parent_continues)) "subdivision_retained_parent" else "subdivision")
  if (length(pl) >= 2 && length(cl) == 1)
    return(if (cl %in% pl) "consolidation_retained" else "consolidation")
  # Several parents that all keep their rolls, plus new lots carved from them
  # (e.g. Ritchot's Legacy Dr plan, 2 parents -> 234 lots in 2026).
  if (all(pl %in% cl) && length(setdiff(cl, pl)) >= 1) return("subdivision_retained_parent")
  "reconfiguration"
}

# ---- sales -------------------------------------------------------------------

#' Candidate versions for each sale. `sales` needs columns linc, sale_date
#' (Date) and any id columns, which are carried through.
#' match_type:
#'   certain    one version, and it was actually observed on both sides of the date
#'   window     one version, but the date is inside an open/close window
#'   ambiguous  more than one version possible (the change window spans the date,
#'              including the boundary days themselves); review by hand
#'   none       LINC unknown or not in existence then -> follow lineage
#' left_censored marks a match that relies on the first snapshot's outline for a
#' date before that snapshot existed.
match_sales <- function(sales, versions) {
  vcols <- c("linc", "version_id", "first_seen", "last_seen", "open_not_before",
             "close_not_after", "opened_reason", "closed_reason", "provisional")
  v <- sf::st_drop_geometry(versions)[, vcols]
  s <- sales; s$.sale_row <- seq_len(nrow(s))
  j <- merge(s, v, by = "linc", all.x = FALSE)
  ok <- (is.na(j$open_not_before) | j$sale_date >= j$open_not_before) &
        (is.na(j$close_not_after) | j$sale_date <= j$close_not_after)
  cand <- j[ok, ]
  miss <- s[!s$.sale_row %in% cand$.sale_row, ]
  if (nrow(miss)) for (c in setdiff(vcols, "linc")) miss[[c]] <- v[[c]][NA_integer_][seq_len(nrow(miss))]
  out <- rbind(cand, miss[, names(cand)])
  out <- out[order(out$.sale_row, out$first_seen), ]
  out$n_candidates <- as.integer(ave(!is.na(out$version_id), out$.sale_row, FUN = sum))
  observed <- !is.na(out$version_id) & out$sale_date >= out$first_seen & out$sale_date <= out$last_seen
  out$match_type <- ifelse(out$n_candidates == 0, "none",
                    ifelse(out$n_candidates > 1, "ambiguous", ifelse(observed, "certain", "window")))
  out$left_censored <- !is.na(out$version_id) & is.na(out$open_not_before) & out$sale_date < out$first_seen
  out$.sale_row <- NULL
  rownames(out) <- NULL
  out
}

#' All ancestor versions of the given versions, following lineage edges child ->
#' parent. Version-based, so a parent roll that survives a subdivision cannot
#' create a cycle; the visited set and max_depth guard against bad data anyway.
lineage_ancestors <- function(version_ids, edges, max_depth = 25) {
  out <- list(); frontier <- unique(version_ids); seen <- frontier; depth <- 0
  while (length(frontier) && depth < max_depth) {
    depth <- depth + 1
    hit <- edges[edges$child_version_id %in% frontier, ]
    if (!nrow(hit)) break
    hit$depth <- depth
    out[[depth]] <- hit
    frontier <- setdiff(unique(hit$parent_version_id), seen)
    seen <- c(seen, frontier)
  }
  if (!length(out)) return(edges[0, ])
  do.call(rbind, out)
}
