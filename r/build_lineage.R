# build_lineage.R
#
# Infers parcel LINEAGE (subdivisions / consolidations / replacements) between
# consecutive archived snapshots by geometric overlap of the UNSIMPLIFIED
# archived parcels (the source-of-record GeoPackages — NOT the simplified
# display shards). Output: per-muni lineage JSON for the mb-parcel-history
# CDN, so the app can answer "which prior parcel(s) did this parcel come
# from?" from a click.
#
# *** INFERRED, NOT AUTHORITATIVE. *** Geometry overlap can't distinguish a
# true subdivision from a re-survey, and snapshots are months apart, so a
# link only tells you WHICH registered plan / title to pull. Every record
# carries a confidence (overlap coverage) and a verify disclaimer.
#
# Method, per consecutive pair (t1 -> t2), per municipality:
#   - The ROLL NUMBER is the parcel identity. A roll present in both snapshots
#     is the same parcel; small area/geometry drift between snapshots is
#     re-survey noise, NOT a lineage event, and is ignored.
#   - Lineage comes from rolls that APPEAR (new in t2) or DISAPPEAR (gone from
#     t1). Each NEW parcel is intersected against ALL t1 parcels to find the
#     prior parcel(s) that cover >= EDGE_COVER of it (its predecessor / the
#     parcel it was carved from). Each REMOVED parcel is intersected against
#     ALL t2 parcels to find its successor(s).
#   - Overlap edges are clustered (connected components) into events:
#     1->N subdivision, N->1 consolidation, 1->1 replacement, else
#     reconfiguration. Confidence = the weakest overlap coverage in the event.
#
# Usage:
#   Rscript r/build_lineage.R               # all munis, all consecutive pairs
#   Rscript r/build_lineage.R --muni 168    # one muni (still reads full files)
#
# Runtime: a few minutes — only the new/removed parcels (a few thousand
# province-wide) are intersected, against a spatial index of the full set.

suppressPackageStartupMessages({
  library(sf)
  library(jsonlite)
})
sf::sf_use_s2(FALSE)   # planar ops in the GeoPackage's native UTM-14N

ARCHIVE_ROOT <- "D:/Dropbox/Appraisal/Web/MAOSnapshots"
OUTPUT_ROOT  <- "D:/Dropbox/ClaudeCode/MBOpenData/mb-parcel-history"
LINEAGE_DIR  <- file.path(OUTPUT_ROOT, "lineage")

EDGE_COVER <- 0.50    # an overlap must cover >= 50% of the new/removed parcel
M2_PER_AC  <- 4046.8564224

`%||%` <- function(a, b) if (is.null(a) || (length(a) == 1 && is.na(a))) b else a

args      <- commandArgs(trailingOnly = TRUE)
arg_val   <- function(flag) { i <- match(flag, args); if (is.na(i) || i == length(args)) NA_character_ else args[i + 1] }
only_muni <- suppressWarnings(as.integer(arg_val("--muni")))

date_from_name <- function(p) {
  m <- regmatches(basename(p), regexpr("\\d{8}", basename(p)))
  if (length(m) == 0) return(NA_character_)
  paste0(substr(m,1,4), "-", substr(m,5,6), "-", substr(m,7,8))
}

# Read a snapshot's parcels into a COMMON metric CRS (UTM-14N / EPSG:26914).
# Snapshots can ship in different CRS — e.g. the 2025-02-12 GeoPackage is
# EPSG:3857 (Web Mercator) and 2026-06-05 is EPSG:26914 — so we reproject
# both here; otherwise the cross-snapshot intersection errors AND Web
# Mercator's ~2.4x area inflation at MB latitudes corrupts the areas.
LINEAGE_CRS <- 26914
read_snap <- function(gpkg) {
  lyr <- sf::st_layers(gpkg)$name[1]
  g <- sf::st_read(gpkg, layer = lyr, quiet = TRUE)
  names(g)[names(g) == attr(g, "sf_column")] <- "geometry"; sf::st_geometry(g) <- "geometry"
  g$muni_no <- suppressWarnings(as.integer(sub("\\s*-.*$", "", g$Municipality)))
  g <- g[!is.na(g$muni_no) & !is.na(g$Roll_No_Txt) & nzchar(g$Roll_No_Txt),
         c("Roll_No_Txt", "muni_no", "geometry")]
  g <- sf::st_transform(g, LINEAGE_CRS)
  g <- sf::st_make_valid(g)
  g <- g[!sf::st_is_empty(g), ]
  g$area_m2 <- as.numeric(sf::st_area(g))
  g
}

make_dsu <- function(n) {
  p <- seq_len(n)
  find <- function(i) { r <- i; while (p[r] != r) r <- p[r]; while (p[i] != r) { nx <- p[i]; p[i] <<- r; i <- nx }; r }
  list(find = find, union = function(a, b) { ra <- find(a); rb <- find(b); if (ra != rb) p[ra] <<- rb })
}

classify <- function(from_rolls, to_rolls) {
  if (length(from_rolls) == 1 && length(to_rolls) >= 2) return("subdivision")
  if (length(from_rolls) >= 2 && length(to_rolls) == 1) return("consolidation")
  if (length(from_rolls) == 1 && length(to_rolls) == 1) return("replacement")
  "reconfiguration"
}

ac <- function(m2) round(m2 / M2_PER_AC, 2)

# Overlap edges (from t1 roll -> to t2 roll, with coverage) for one muni-pair.
muni_events <- function(t1m, t2m, from_snap, to_snap) {
  r1 <- t1m$Roll_No_Txt; r2 <- t2m$Roll_No_Txt
  new_idx <- which(!r2 %in% r1)
  rem_idx <- which(!r1 %in% r2)
  if (!length(new_idx) && !length(rem_idx)) return(list())

  edges <- list()   # list(from=<t1 roll>, to=<t2 roll>, cover=<frac of active parcel>)
  add_edges <- function(active, full, active_is_t1) {
    if (!nrow(active) || !nrow(full)) return(invisible())
    active$.aarea <- active$area_m2
    full$.farea   <- full$area_m2
    inter <- tryCatch(suppressWarnings(sf::st_intersection(
      active[, c(".aarea", "Roll_No_Txt")], full[, c(".farea", "Roll_No_Txt")])),
      error = function(e) NULL)
    if (is.null(inter) || nrow(inter) == 0) return(invisible())
    ov <- as.numeric(sf::st_area(inter))
    inter <- sf::st_drop_geometry(inter)
    cover <- ov / inter$.aarea                       # fraction of the ACTIVE parcel covered
    keep <- is.finite(cover) & cover >= EDGE_COVER & inter$Roll_No_Txt != inter$Roll_No_Txt.1
    for (k in which(keep)) {
      a_roll <- inter$Roll_No_Txt[k]; f_roll <- inter$Roll_No_Txt.1[k]
      e <- if (active_is_t1) list(from = a_roll, to = f_roll, cover = cover[k])
           else              list(from = f_roll, to = a_roll, cover = cover[k])
      edges[[length(edges) + 1L]] <<- e
    }
  }
  if (length(rem_idx)) add_edges(t1m[rem_idx, ], t2m, TRUE)    # removed t1 -> covering t2
  if (length(new_idx)) add_edges(t2m[new_idx, ], t1m, FALSE)   # new t2 -> covering t1
  if (!length(edges)) return(list())

  ekey  <- vapply(edges, function(e) paste(e$from, e$to), "")
  edges <- edges[!duplicated(ekey)]

  nodes <- unique(c(vapply(edges, function(e) paste0("1|", e$from), ""),
                    vapply(edges, function(e) paste0("2|", e$to), "")))
  id  <- setNames(seq_along(nodes), nodes)
  dsu <- make_dsu(length(nodes))
  for (e in edges) dsu$union(id[[paste0("1|", e$from)]], id[[paste0("2|", e$to)]])
  comp <- vapply(seq_along(nodes), dsu$find, integer(1))

  a1 <- setNames(t1m$area_m2, t1m$Roll_No_Txt)
  a2 <- setNames(t2m$area_m2, t2m$Roll_No_Txt)
  events <- list()
  for (cid in unique(comp)) {
    members    <- nodes[comp == cid]
    from_rolls <- sub("^1\\|", "", members[startsWith(members, "1|")])
    to_rolls   <- sub("^2\\|", "", members[startsWith(members, "2|")])
    if (!length(from_rolls) || !length(to_rolls)) next
    covers <- vapply(edges[vapply(edges, function(e) paste0("1|", e$from) %in% members, TRUE)],
                     function(e) e$cover, 0)
    events[[length(events) + 1L]] <- list(
      type = classify(from_rolls, to_rolls), from_snapshot = from_snap, to_snapshot = to_snap,
      from = lapply(from_rolls, function(r) list(roll = r, area_ac = ac(a1[[r]] %||% NA))),
      to   = lapply(to_rolls,   function(r) list(roll = r, area_ac = ac(a2[[r]] %||% NA))),
      confidence = round(min(covers), 2)
    )
  }
  events
}

# ---- main ------------------------------------------------------------
parcel_files <- sort(list.files(ARCHIVE_ROOT, pattern = "^MBRollGeoPackage\\d{8}\\.gpkg$",
                                recursive = TRUE, full.names = TRUE))
if (length(parcel_files) < 2) stop("Need >= 2 archived snapshots for lineage; found ", length(parcel_files))
cat("Lineage build — snapshots:", paste(vapply(parcel_files, date_from_name, ""), collapse = " -> "), "\n")

acc <- new.env()
for (pi in seq_len(length(parcel_files) - 1)) {
  f1 <- parcel_files[pi]; f2 <- parcel_files[pi + 1]
  s1 <- date_from_name(f1); s2 <- date_from_name(f2)
  cat(sprintf("\n=== %s -> %s ===\n  reading ...\n", s1, s2))
  g1 <- read_snap(f1); g2 <- read_snap(f2)
  munis <- sort(intersect(unique(g1$muni_no), unique(g2$muni_no)))
  if (!is.na(only_muni)) munis <- munis[munis == only_muni]
  cat("  munis to scan:", length(munis), "\n")
  for (mn in munis) {
    ev <- muni_events(g1[g1$muni_no == mn, ], g2[g2$muni_no == mn, ], s1, s2)
    if (length(ev)) {
      key <- as.character(mn)
      acc[[key]] <- c(if (is.null(acc[[key]])) list() else acc[[key]], ev)
    }
  }
  cat("  munis with events so far:", length(ls(acc)), "\n")
}

# ---- write per-muni lineage + index ---------------------------------
dir.create(LINEAGE_DIR, showWarnings = FALSE, recursive = TRUE)
DISCLAIMER <- paste("Inferred from geometry overlap of public parcel snapshots —",
                    "NOT authoritative lineage. Verify against registered plans of",
                    "subdivision / consolidation and certificates of title.")
snaps <- vapply(parcel_files, date_from_name, "")
idx <- list()
keys <- ls(acc)
cat("\nWriting lineage for", length(keys), "munis with events ...\n")
for (key in keys) {
  events <- acc[[key]]
  by_roll <- list()
  for (e in events) {
    fr <- vapply(e$from, function(x) x$roll, "")
    tr <- vapply(e$to,   function(x) x$roll, "")
    for (r in tr) by_roll[[r]] <- list(snapshot = e$to_snapshot, type = e$type,
      confidence = e$confidence,
      predecessors = lapply(fr, function(x) list(snapshot = e$from_snapshot, roll = x)))
    for (r in fr) {
      prev <- by_roll[[r]]
      by_roll[[r]] <- list(snapshot = e$from_snapshot, type = e$type, confidence = e$confidence,
        predecessors = if (!is.null(prev)) prev$predecessors else NULL,
        successors = lapply(tr, function(x) list(snapshot = e$to_snapshot, roll = x)))
    }
  }
  out <- list(schema = 1, muni_no = as.integer(key), snapshots = snaps,
              generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
              disclaimer = DISCLAIMER, events = events, by_roll = by_roll)
  jsonlite::write_json(out, file.path(LINEAGE_DIR, paste0(key, ".json")),
                       auto_unbox = TRUE, pretty = TRUE, null = "null", digits = 4)
  idx[[key]] <- list(events = length(events))
}
jsonlite::write_json(list(schema = 1, generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
                          disclaimer = DISCLAIMER, snapshots = snaps, munis = idx),
                     file.path(LINEAGE_DIR, "_index.json"),
                     auto_unbox = TRUE, pretty = TRUE, null = "null")
cat("Done — lineage for", length(keys), "munis;",
    sum(vapply(keys, function(k) length(acc[[k]]), 0L)), "events total.\n")
