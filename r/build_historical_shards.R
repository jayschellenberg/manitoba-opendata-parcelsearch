# build_historical_shards.R
#
# Processes the dated provincial snapshots in the MAOSnapshots archive
# into per-muni GeoJSON shards for the webapp's HISTORICAL ("as-of-date")
# compare view. Each snapshot = one dated parcel file; its date IS the
# snapshot_id (YYYY-MM-DD). For each snapshot it shards three layers —
# parcels, zoning, dev-plan — keyed by muni number, plus a manifest (schema 2)
# carrying each layer's own source date AND its provenance (source_file,
# sha256, retrieved_at, source_url, source_crs, license) lifted from the
# archive .meta.json sidecars.
#
#   source : D:/Dropbox/Appraisal/Web/MAOSnapshots/<year>/
#              MBRollGeoPackage<YYYYMMDD>.gpkg                 (parcels)
#              Manitoba_Zoning_By_Laws<YYYYMMDD>.geojson       (zoning)
#              Manitoba_Development_Plan_Designations<YYYYMMDD>.geojson (dev-plan)
#   output : <OUTPUT_ROOT>/<snapshot_id>/            (snapshot_id = YYYY-MM-DD)
#              manifest.json
#              parcels/<muni_no>.json   zoning/<muni_no>.json   devplan/<muni_no>.json
#            <OUTPUT_ROOT>/index.json                 # discovery: snapshots + per-layer dates
#
# Display shards are simplified (~2-3 m) for VISUALIZATION only — they are NOT
# survey-accurate. Resolve acreage/boundary evidence back to the archived
# source-of-record named in each layer's provenance (source_file / sha256).
#
# The output tree is destined for a SEPARATE public repo (mb-parcel-history)
# served via the jsDelivr CDN, so it stays out of the main repo + Vercel
# deploy. Hosting-agnostic: this script just writes files.
#
# Muni key: the muni NUMBER, the one field common to all three layers
# (parcels carry it as the integer prefix of `Municipality`,
# "163 - RM OF ..."; zoning/dev-plan carry `MUNI_NO` directly). Using the
# number sidesteps the name-spelling drift between the three provincial
# layers.
#
# MUNICIPAL CHANGE OVER TIME (amalgamation / annexation) — design + TODO:
# The webapp navigates by TODAY's municipalities, so historical data must
# be findable under today's muni even if it sat in a different muni back
# then. Two halves:
#   (1) Historical TRUTH is already preserved — every feature keeps its
#       own Municipality / Muni_Name_With_Typ / Roll_No_Txt as of its
#       snapshot, shown in the historical tooltip/banner. (done)
#   (2) Navigation by CURRENT geography — for years that span a
#       reorganization, re-bin each feature to the CURRENT muni boundary
#       it physically falls within (a spatial join to the live
#       MUNICIPALITY layer, the same fetch build_parcel_masc.R uses),
#       and key the shard by that CURRENT muni number. (TODO — add when
#       the first pre-2015 / post-amalgamation snapshot is archived, so
#       it can be built and tested against real reorganized data.)
# For all post-2015 snapshots (incl. the current 2025/2026) the muni
# structure is unchanged, so the muni_no below already equals the current
# muni — re-binning is a no-op and the shards are correct as-is.
#
# Geometry: reprojected to EPSG:4326 (GeoJSON / what the webapp renders)
# and Douglas-Peucker simplified (~2-3 m) to keep shards small for the CDN.
#
# Usage:
#   Rscript r/build_historical_shards.R                 # every snapshot in the archive
#   Rscript r/build_historical_shards.R --year 2026     # only snapshots dated 2026
#   Rscript r/build_historical_shards.R --year 2026 --muni 168   # one muni (fast test)
#   Rscript r/build_historical_shards.R --index-only    # just rewrite the discovery index
#   ... --require zoning,devplan                        # HARD-FAIL any processed snapshot
#                                                       #   missing those layers (used by the
#                                                       #   semiannual publish wrapper; default
#                                                       #   keeps them optional for old archives)
#
# Runtime: ~10-15 min/snapshot for the full province (parcels dominate).

suppressPackageStartupMessages({
  library(sf)
  library(dplyr)
  library(jsonlite)
})
sf::sf_use_s2(FALSE)   # GEOS — permissive simplify, same rationale as build_rollentry_snapshot.R

# Shared roots (env-overridable) — see r/config.R.
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

ARCHIVE_ROOT <- mao_snapshots_root
OUTPUT_ROOT  <- mb_parcel_history_root
# ~2-3 m at MB latitudes. The previous 0.00015 (~11-17 m) was larger than half
# the width of small urban lots, so Douglas-Peucker dropped a corner and
# collapsed rectangles into TRIANGLES (seen in Hanover's Becki/Ciara Cove
# subdivisions). A lot survives simplification only when the tolerance is below
# half its narrowest dimension, so keep this small; it still strips most
# digitization noise from long rural boundaries.
SIMPLIFY_TOLERANCE_DEG <- 0.00003

# Parcels BELOW this area are NOT simplified at all (kept exact). A small lot is
# already near-minimal (a rectangle is 5 points), so Douglas-Peucker can only
# drop a corner and collapse it into a triangle — even at a small tolerance the
# narrowest lots still collapse (e.g. 138 m² Steinbach strips). The vertex
# savings live entirely in large/complex rural boundaries, which are also too
# big for DP to collapse, so gate simplification on area and leave small lots
# untouched. 10000 m² = 1 ha (~2.5 ac) — well above any urban lot.
SIMPLIFY_MIN_AREA_M2 <- 10000

# Fields kept per layer (what the webapp actually displays). Parcels mirror
# PARCEL_OUTFIELDS minus OBJECTID (MBRollGeoPackage has no OBJECTID — we
# synthesize a row id). Zoning / dev-plan mirror the fields the live
# overlays render.
PARCEL_FIELDS  <- c("Roll_No_Txt", "Property_Address", "Municipality",
                    "Muni_Name_With_Typ", "Asmt_Roll", "Dwelling_Units",
                    "Frontage_or_Area", "Total_Value", "Asmt_Rpt_Url")
ZONING_FIELDS  <- c("ZONE", "ZONE_NAME", "ZONE_CATEGORY", "ZBL", "ZBL_A",
                    "AMENDMENT_DESCRIPTION", "MUNI_NO", "MUNI_NAME")
DEVPLAN_FIELDS <- c("DES_NAME", "DES_CATEGORY", "DP_BYLAW", "DPA_BYLAW",
                    "PLANNINGDISTRICT", "MUNI_NO", "MUNI_NAME")

# ---- args ------------------------------------------------------------
args      <- commandArgs(trailingOnly = TRUE)
arg_val   <- function(flag) { i <- match(flag, args); if (is.na(i) || i == length(args)) NA_character_ else args[i + 1] }
only_year  <- arg_val("--year")
only_muni  <- suppressWarnings(as.integer(arg_val("--muni")))
index_only <- "--index-only" %in% args   # just (re)write the root discovery index

# Layers that MUST be present (and non-empty on full runs) in every processed
# snapshot, else the run hard-fails. The publish wrapper passes
# `--require zoning,devplan` so a snapshot can never silently publish
# parcels-only; plain/manual runs keep the layers optional (historical archives
# may predate a layer).
required_layers <- local({
  v <- arg_val("--require")
  if (is.na(v)) return(character(0))
  v <- trimws(strsplit(v, ",", fixed = TRUE)[[1]])
  bad <- setdiff(v, c("zoning", "devplan"))
  if (length(bad)) stop("--require: unknown layer(s): ", paste(bad, collapse = ", "),
                        " (valid: zoning, devplan)")
  v
})

# ---- helpers ---------------------------------------------------------
date_from_name <- function(path) {
  m <- regmatches(basename(path), regexpr("\\d{8}", basename(path)))
  if (length(m) == 0) return(NA_character_)
  paste0(substr(m,1,4), "-", substr(m,5,6), "-", substr(m,7,8))
}

# pick the newest file in `dir` matching `pattern` (by the date in its name)
latest_match <- function(dir, pattern) {
  f <- list.files(dir, pattern = pattern, full.names = TRUE)
  if (length(f) == 0) return(NA_character_)
  tail(f[order(regmatches(basename(f), regexpr("\\d{8}", basename(f))))], 1)
}

to_wgs84_simplify <- function(g) {
  if (is.na(sf::st_crs(g)) ) sf::st_crs(g) <- 4326
  # Real-m² area for the gate, computed in a metric CRS (UTM-14N) — s2 is OFF
  # (GEOS), so we must NOT area on lon/lat, and the source CRS varies (2025
  # ships EPSG:3857 whose native area is ~2.4x inflated; 2026 EPSG:26914). A
  # coarse province-wide UTM area is plenty for a 1-ha threshold.
  area_m2 <- as.numeric(sf::st_area(sf::st_transform(sf::st_geometry(g), 26914)))
  if (sf::st_crs(g)$epsg %||% 0 != 4326) g <- sf::st_transform(g, 4326)
  geom <- sf::st_geometry(g)
  # Simplify ONLY parcels >= SIMPLIFY_MIN_AREA_M2; leave small lots exact so DP
  # can't collapse a rectangle into a triangle. suppressWarnings: sf nags that
  # DP simplify on lon/lat isn't metric-exact; fine for visual rendering.
  big <- is.finite(area_m2) & area_m2 >= SIMPLIFY_MIN_AREA_M2
  if (any(big)) {
    geom[big] <- sf::st_make_valid(suppressWarnings(sf::st_simplify(
      geom[big], dTolerance = SIMPLIFY_TOLERANCE_DEG, preserveTopology = TRUE)))
  }
  sf::st_geometry(g) <- geom
  g <- g[!sf::st_is_empty(g), ]
  g
}
`%||%` <- function(a, b) if (is.null(a) || is.na(a)) b else a

write_shards <- function(g, muni_col, out_dir, keep_fields) {
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  g <- g[!is.na(g[[muni_col]]), ]
  counts <- list()
  for (mn in sort(unique(g[[muni_col]]))) {
    if (!is.na(only_muni) && mn != only_muni) next
    shard <- g[g[[muni_col]] == mn, c(keep_fields, attr(g, "sf_column"))]
    fp <- file.path(out_dir, paste0(mn, ".json"))
    if (file.exists(fp)) file.remove(fp)
    sf::st_write(shard, fp, driver = "GeoJSON",
                 layer_options = c("COORDINATE_PRECISION=6", "RFC7946=YES"),
                 quiet = TRUE)
    counts[[as.character(mn)]] <- nrow(shard)
  }
  counts
}

# ---- provenance + validation helpers --------------------------------
# Read the archived source file's provenance sidecar (written by
# archive_snapshot.R). NULL when absent.
read_meta <- function(src_path) {
  mp <- paste0(src_path, ".meta.json")
  if (!file.exists(mp)) return(NULL)
  tryCatch(jsonlite::read_json(mp), error = function(e) NULL)
}

# Short git commit of THIS generator (the main repo), recorded in the
# manifest so a finding can be traced to the exact build. Best-effort.
# `-C mb_parcelsearch_root` because scheduled-task runs inherit a cwd of System32 —
# a bare `git rev-parse` there finds no repo and the manifest records null.
generator_commit <- function() {
  tryCatch({
    out <- suppressWarnings(system2("git", c("-C", mb_parcelsearch_root, "rev-parse", "--short", "HEAD"),
                                    stdout = TRUE, stderr = FALSE))
    if (length(out)) trimws(out[1]) else NA_character_
  }, error = function(e) NA_character_)
}

# Pick the layer file whose date is the latest on-or-before `on_or_before`
# (falls back to the earliest available), so each snapshot pairs the
# version of zoning/dev-plan current as of the parcel date even when the
# three downloads land on different days.
pick_layer <- function(dir, pattern, on_or_before) {
  f <- list.files(dir, pattern = pattern, full.names = TRUE)
  if (!length(f)) return(NA_character_)
  dts <- vapply(f, date_from_name, character(1))
  keep <- !is.na(dts); f <- f[keep]; dts <- dts[keep]
  if (!length(f)) return(NA_character_)
  ok <- dts <= on_or_before                       # ISO strings sort chronologically
  if (any(ok)) return(tail(f[ok][order(dts[ok])], 1))   # latest on-or-before
  f[order(dts)][1]                                       # else earliest available
}

# Per-layer provenance block for the snapshot manifest, sourced from the
# archived file's .meta.json sidecar (source-of-record hash, dates, etc.).
layer_meta <- function(src_f, munis, features) {
  m <- read_meta(src_f)
  list(
    source_file           = basename(src_f),
    source_date           = date_from_name(src_f),
    retrieved_at          = m$retrieved_at %||% NA_character_,
    retrieved_at_inferred = if (is.null(m$retrieved_at_inferred)) NA else m$retrieved_at_inferred,
    source_crs            = m$source_crs %||% NA_character_,
    sha256                = m$sha256 %||% NA_character_,
    bytes                 = m$bytes %||% NA,
    source_url            = m$source_url %||% NA_character_,
    license               = m$license %||% NA_character_,
    munis                 = munis,
    features              = features
  )
}

# Loud check that critical fields are present. `hard = TRUE` stops the run
# (used for parcels — without the roll/muni we can't key or render).
require_fields <- function(present, critical, label, hard = FALSE) {
  miss <- setdiff(critical, present)
  if (length(miss)) {
    msg <- sprintf("  !! %s %s critical field(s): %s",
                   label, if (hard) "MISSING" else "missing", paste(miss, collapse = ", "))
    if (hard) stop(msg) else cat(msg, "\n")
  }
  invisible(length(miss) == 0)
}

# Root discovery index — the SINGLE file the webapp fetches to learn which
# SNAPSHOTS exist (and each layer's source date), so adding a snapshot needs
# NO app code change. Keyed by snapshot_id = YYYY-MM-DD. Scans the output
# tree so it's always consistent with what's published.
write_root_index <- function() {
  snaps <- sort(basename(list.dirs(OUTPUT_ROOT, recursive = FALSE)), decreasing = TRUE)
  snaps <- snaps[grepl("^\\d{4}-\\d{2}-\\d{2}$", snaps)]
  out <- list()
  for (s in snaps) {
    mf <- file.path(OUTPUT_ROOT, s, "manifest.json")
    if (!file.exists(mf)) next
    m <- jsonlite::read_json(mf)
    # Slim per-layer summary for discovery (source_date only); the full
    # provenance lives in each snapshot's manifest.json.
    lyrs <- lapply(m$layers, function(l) list(source_date = l$source_date))
    out[[s]] <- list(snapshot_id = s, layers = lyrs, muni_count = length(m$munis))
  }
  idx <- list(
    dataset   = "mb-parcel-history",
    schema    = 2,
    generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
    # Base only — consumers MUST append an immutable @<commit-sha> (never @main).
    cdn       = "https://cdn.jsdelivr.net/gh/jayschellenberg/mb-parcel-history",
    snapshots = out
  )
  dir.create(OUTPUT_ROOT, showWarnings = FALSE, recursive = TRUE)
  jsonlite::write_json(idx, file.path(OUTPUT_ROOT, "index.json"),
                       auto_unbox = TRUE, pretty = TRUE, null = "null")
  cat("Wrote root index.json — snapshots:", paste(names(out), collapse = ", "), "\n")

  dts <- suppressWarnings(as.Date(names(out)))
  dts <- dts[!is.na(dts)]
  if (length(dts)) {
    age_days <- as.integer(Sys.Date() - max(dts))
    if (age_days > 365) {
      cat(sprintf("  !! STALE: newest snapshot is %d days old (> 12 months) — archive a fresh snapshot.\n",
                  age_days))
    }
  }
}

# ---- per-snapshot processing ----------------------------------------
# A snapshot = one parcel file; its date IS the snapshot_id (YYYY-MM-DD).
# Zoning/dev-plan are paired from the same archive folder (latest version
# on-or-before the parcel date). Output goes to OUTPUT_ROOT/<snapshot_id>/.
process_snapshot <- function(parcel_f) {
  snap <- date_from_name(parcel_f)
  if (is.na(snap)) { cat("  skip (no date in name):", basename(parcel_f), "\n"); return(invisible()) }
  if (!is.na(only_year) && substr(snap, 1, 4) != only_year) return(invisible())

  ydir <- dirname(parcel_f)
  zoning_f  <- pick_layer(ydir, "^Manitoba_Zoning_By_?[Ll]aws\\d{8}\\.geojson$", snap)
  devplan_f <- pick_layer(ydir, "^Manitoba_Development_Plan_Designations\\d{8}\\.geojson$", snap)

  cat("\n=== Snapshot", snap, "===\n")
  cat("  parcels :", basename(parcel_f), "\n")
  cat("  zoning  :", if (is.na(zoning_f)) "(none)" else basename(zoning_f), "\n")
  cat("  devplan :", if (is.na(devplan_f)) "(none)" else basename(devplan_f), "\n")

  # Required-layer gate (publish path): a missing zoning/dev-plan must be a
  # loud stop BEFORE any parcel work — not a "(none)" that quietly publishes a
  # parcels-only snapshot.
  if ("zoning" %in% required_layers && is.na(zoning_f)) {
    stop("snapshot ", snap, ": zoning REQUIRED but no Manitoba_Zoning_By_Laws<YYYYMMDD>.geojson in ", ydir)
  }
  if ("devplan" %in% required_layers && is.na(devplan_f)) {
    stop("snapshot ", snap, ": devplan REQUIRED but no Manitoba_Development_Plan_Designations<YYYYMMDD>.geojson in ", ydir)
  }

  out_dir <- file.path(OUTPUT_ROOT, snap)
  layers <- list()

  # --- parcels (MBRollGeoPackage) ---
  lyr <- sf::st_layers(parcel_f)$name[1]
  p <- sf::st_read(parcel_f, layer = lyr, quiet = TRUE)
  names(p)[names(p) == attr(p, "sf_column")] <- "geometry"; sf::st_geometry(p) <- "geometry"
  require_fields(names(p), c("Roll_No_Txt", "Municipality", "Muni_Name_With_Typ"),
                 "parcels", hard = TRUE)
  p$muni_no <- suppressWarnings(as.integer(sub("\\s*-.*$", "", p$Municipality)))
  p <- p[!is.na(p$muni_no) & !is.na(p$Muni_Name_With_Typ) & nzchar(p$Muni_Name_With_Typ), ]
  if (!is.na(only_muni)) p <- p[p$muni_no == only_muni, ]   # fast-test path
  keepP <- intersect(PARCEL_FIELDS, names(p))
  p <- p[, c(keepP, "muni_no", "geometry")]
  cat("    simplifying", nrow(p), "parcels ...\n")
  p <- to_wgs84_simplify(p)
  pc <- write_shards(p, "muni_no", file.path(out_dir, "parcels"), keepP)
  layers$parcels <- layer_meta(parcel_f, length(pc), sum(unlist(pc)))
  muni_names <- p |> sf::st_drop_geometry() |> dplyr::distinct(muni_no, Muni_Name_With_Typ)

  # --- zoning ---
  if (!is.na(zoning_f)) {
    z <- sf::st_read(zoning_f, quiet = TRUE)
    # Critical-field misses are fatal when the layer is required (a schema
    # drift would otherwise publish shards missing their display fields).
    require_fields(names(z), c("MUNI_NO", "ZONE", "ZBL"), "zoning",
                   hard = "zoning" %in% required_layers)
    z$MUNI_NO <- suppressWarnings(as.integer(z$MUNI_NO))
    if (!is.na(only_muni)) z <- z[!is.na(z$MUNI_NO) & z$MUNI_NO == only_muni, ]
    keepZ <- intersect(ZONING_FIELDS, names(z))
    z <- z[, c(keepZ, attr(z, "sf_column"))]
    z <- to_wgs84_simplify(z)
    zc <- write_shards(z, "MUNI_NO", file.path(out_dir, "zoning"), setdiff(keepZ, "MUNI_NO"))
    # Zero features on a full run = truncated/empty source, not a real province.
    # (Skipped under --muni: 48 munis legitimately have no provincial zoning.)
    if ("zoning" %in% required_layers && is.na(only_muni) && sum(unlist(zc)) == 0) {
      stop("snapshot ", snap, ": zoning REQUIRED but produced 0 features from ", basename(zoning_f))
    }
    layers$zoning <- layer_meta(zoning_f, length(zc), sum(unlist(zc)))
  }

  # --- dev plan ---
  if (!is.na(devplan_f)) {
    d <- sf::st_read(devplan_f, quiet = TRUE)
    require_fields(names(d), c("MUNI_NO", "DES_NAME", "DP_BYLAW"), "dev-plan",
                   hard = "devplan" %in% required_layers)
    d$MUNI_NO <- suppressWarnings(as.integer(d$MUNI_NO))
    if (!is.na(only_muni)) d <- d[!is.na(d$MUNI_NO) & d$MUNI_NO == only_muni, ]
    keepD <- intersect(DEVPLAN_FIELDS, names(d))
    d <- d[, c(keepD, attr(d, "sf_column"))]
    d <- to_wgs84_simplify(d)
    dc <- write_shards(d, "MUNI_NO", file.path(out_dir, "devplan"), setdiff(keepD, "MUNI_NO"))
    if ("devplan" %in% required_layers && is.na(only_muni) && sum(unlist(dc)) == 0) {
      stop("snapshot ", snap, ": devplan REQUIRED but produced 0 features from ", basename(devplan_f))
    }
    layers$devplan <- layer_meta(devplan_f, length(dc), sum(unlist(dc)))
  }

  # --- manifest (with provenance) ---
  munis <- setNames(
    lapply(seq_len(nrow(muni_names)), function(i) {
      mn <- muni_names$muni_no[i]
      list(name = muni_names$Muni_Name_With_Typ[i], parcels = pc[[as.character(mn)]] %||% 0L)
    }),
    muni_names$muni_no
  )
  manifest <- list(
    schema      = 2,
    snapshot_id = snap,
    generated   = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
    generator   = list(
      script = "build_historical_shards.R",
      commit = generator_commit(),
      crs    = "EPSG:4326",
      simplify_tolerance_deg = SIMPLIFY_TOLERANCE_DEG,
      simplify_min_area_m2   = SIMPLIFY_MIN_AREA_M2,   # parcels below this kept EXACT (no triangles)
      geometry_note = paste("Geometry simplified ~2-3 m for display — NOT survey-accurate.",
                            "Resolve acreage/boundary evidence to the archived source-of-record",
                            "(layers[].source_file / sha256).")
    ),
    disclaimer  = paste("Historical zoning/dev-plan are pointers to likely by-law/designation",
                        "context as of the source date; verify against municipal / planning-district",
                        "records and registered plans/titles. Not a legal survey or legal determination."),
    layers      = layers,
    munis       = munis
  )
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  jsonlite::write_json(manifest, file.path(out_dir, "manifest.json"),
                       auto_unbox = TRUE, pretty = TRUE, null = "null", digits = 12)

  sz <- sum(file.info(list.files(out_dir, recursive = TRUE, full.names = TRUE))$size, na.rm = TRUE)
  cat(sprintf("  -> wrote %s  (%.1f MB)\n", out_dir, sz / 1024 / 1024))
}

# ---- main ------------------------------------------------------------
if (index_only) {
  cat("MAO historical shard build — index-only\n")
  write_root_index()
  cat("\nDone.\n")
} else {
  # One snapshot per parcel file anywhere in the archive (any year folder).
  parcel_files <- sort(list.files(ARCHIVE_ROOT, pattern = "^MBRollGeoPackage\\d{8}\\.gpkg$",
                                  recursive = TRUE, full.names = TRUE))
  cat("MAO historical shard build\n  archive:", ARCHIVE_ROOT, "\n  output :", OUTPUT_ROOT, "\n")
  cat("  parcel snapshots found:", length(parcel_files),
      if (!is.na(only_year)) paste0(" (year ", only_year, ")") else "",
      if (!is.na(only_muni)) paste0(" (muni ", only_muni, " only)") else "", "\n")
  for (pf in parcel_files) process_snapshot(pf)
  write_root_index()   # keep the discovery index in lockstep with the shards
  cat("\nDone.\n")
}
