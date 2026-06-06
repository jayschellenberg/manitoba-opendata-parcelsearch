# verify_areas.R  —  "karpathy loop" area-verification harness
#
# Question 1 (CURRENT): does the app's GEOMETRY-derived acreage agree with
#   the ASSESSOR's recorded acreage (Roll_Entry Frontage_or_Area = "x Acres")
#   within a tight tolerance? The app prefers the assessor figure and silently
#   falls back to geometry, so a large divergence is otherwise invisible.
#
# Question 2 (HISTORICAL): do the archived snapshots carry sane parcel sizes,
#   and how do per-roll sizes change between snapshots (the signal behind a
#   "changed-size" map highlight)?
#
# Method: reads the archived source-of-record GeoPackages directly (no live
#   network — deterministic). Computes GEODESIC area with s2 on EPSG:4326,
#   mirroring the app's turf @turf/area (spherical) calc, so projection
#   distortion is zero. CRITICAL per the source_crs lesson: the 2025 gpkg
#   ships in EPSG:3857 (Web Mercator — native areas ~2.4x inflated); we
#   reproject every file to 4326 first, so area is always correct.
#
#   acres = st_area(4326, s2) / 4046.8564224         (4046.8564224 m^2 = 1 ac)
#   roll_acres = parse of Frontage_or_Area, mirroring acresFromFrontageField()
#
# Usage:
#   Rscript r/verify_areas.R                 # full province, current + historical
#   Rscript r/verify_areas.R --limit 20000   # smoke test on first N parcels
#   Rscript r/verify_areas.R --tol 0.02      # set the "tight tolerance" (default 2%)

suppressPackageStartupMessages({ library(sf); library(dplyr) })
sf::sf_use_s2(TRUE)   # geodesic area — matches turf, no projection distortion

ARCHIVE <- "D:/Dropbox/Appraisal/Web/MAOSnapshots"
CURRENT_GPKG    <- file.path(ARCHIVE, "2026", "MBRollGeoPackage20260605.gpkg")
HISTORICAL_GPKG <- file.path(ARCHIVE, "2025", "MBRollGeoPackage20250212.gpkg")
SQM_PER_ACRE <- 4046.8564224
OUT_DIR <- "D:/Dropbox/ClaudeCode/MBOpenData/WebSearch/logs"
dir.create(OUT_DIR, showWarnings = FALSE, recursive = TRUE)

args     <- commandArgs(trailingOnly = TRUE)
arg_val  <- function(f, d) { i <- match(f, args); if (is.na(i) || i == length(args)) d else args[i + 1] }
LIMIT    <- suppressWarnings(as.integer(arg_val("--limit", NA)))
TOL      <- suppressWarnings(as.numeric(arg_val("--tol", "0.02")))   # 2% default

# Mirror of web acresFromFrontageField(): a leading number followed by an
# acres/hectares unit -> acres; frontage-feet / blank / other -> NA.
roll_acres_vec <- function(raw) {
  s <- trimws(ifelse(is.na(raw), "", as.character(raw)))
  out <- rep(NA_real_, length(s))
  rx  <- regexpr("^[0-9]+(\\.[0-9]+)?\\s*(acres?|ac|hectares?|ha)\\b", s, ignore.case = TRUE)
  hit <- rx > 0                      # full-length logical (the earlier bug: derived from match-only)
  if (any(hit)) {
    mtxt <- regmatches(s, rx)        # length == sum(hit)
    num  <- as.numeric(regmatches(mtxt, regexpr("^[0-9]+(\\.[0-9]+)?", mtxt)))
    unit <- tolower(regmatches(mtxt, regexpr("(acres?|ac|hectares?|ha)\\b", mtxt, ignore.case = TRUE)))
    acres <- ifelse(startsWith(unit, "ha"), num * 2.471053814671653, num)
    acres[!is.finite(acres) | acres <= 0] <- NA_real_
    out[hit] <- acres
  }
  out
}

muni_no_from <- function(municipality) {
  suppressWarnings(as.integer(sub("\\s*-.*$", "", trimws(as.character(municipality)))))
}

# Read a snapshot gpkg -> data frame (geometry dropped) with geodesic acres.
read_snapshot <- function(path, label) {
  cat(sprintf("\n[%s] reading %s ...\n", label, basename(path)))
  lyr <- sf::st_layers(path)$name[1]
  # SELECT * keeps the geometry column (a restricted column list silently
  # drops it and st_read returns a plain data.frame). Only 10 fields anyway.
  q <- sprintf('SELECT * FROM "%s"%s', lyr, if (!is.na(LIMIT)) sprintf(" LIMIT %d", LIMIT) else "")
  g <- sf::st_read(path, query = q, quiet = TRUE)
  src_crs <- sf::st_crs(g)$input
  g <- sf::st_transform(g, 4326)               # correct area regardless of native CRS
  cat(sprintf("[%s] %d parcels; source CRS %s -> area computed geodesic on EPSG:4326\n",
              label, nrow(g), src_crs))
  ar <- as.numeric(sf::st_area(g))             # m^2, geodesic (s2)
  df <- sf::st_drop_geometry(g)
  df$geom_acres <- ar / SQM_PER_ACRE
  df$roll_acres <- roll_acres_vec(df$Frontage_or_Area)
  df$muni_no    <- muni_no_from(df$Municipality)
  # Roll_No_Txt repeats across munis ("100.000" exists in many) — the unique
  # parcel key is (muni_no, roll). Use it for all matching.
  df$pkey       <- paste(df$muni_no, df$Roll_No_Txt, sep = "|")
  df
}

# Agreement of geometry vs assessor acreage, on parcels where the assessor
# recorded an AREA (the appraisal-relevant rural/ag population).
report_agreement <- function(df, label) {
  cmp <- df %>% filter(!is.na(roll_acres) & roll_acres > 0 & is.finite(geom_acres) & geom_acres > 0)
  n_all <- nrow(df); n_cmp <- nrow(cmp)
  cat(sprintf("\n===== %s — geometry vs assessor acreage =====\n", label))
  cat(sprintf("  parcels total                 : %d\n", n_all))
  cat(sprintf("  with assessor AREA (acres/ha) : %d (%.1f%%)\n", n_cmp, 100 * n_cmp / n_all))
  if (n_cmp == 0) { cat("  (no comparable parcels)\n"); return(invisible(NULL)) }
  cmp$abs_pct <- abs(cmp$geom_acres - cmp$roll_acres) / cmp$roll_acres
  within <- function(t) sprintf("%.1f%%", 100 * mean(cmp$abs_pct <= t))
  cat(sprintf("  within 1%%                     : %s\n", within(0.01)))
  cat(sprintf("  within 2%% (default tol)       : %s\n", within(0.02)))
  cat(sprintf("  within 5%%                     : %s\n", within(0.05)))
  cat(sprintf("  within 10%%                    : %s\n", within(0.10)))
  cat(sprintf("  within %.0f%% (--tol)            : %s\n", 100 * TOL, within(TOL)))
  cat(sprintf("  median abs diff               : %.3f%%\n", 100 * median(cmp$abs_pct)))
  cat(sprintf("  mean abs diff                 : %.3f%%\n", 100 * mean(cmp$abs_pct)))
  cat(sprintf("  median signed (geom-roll)/roll: %+.3f%%\n",
              100 * median((cmp$geom_acres - cmp$roll_acres) / cmp$roll_acres)))
  worst <- cmp %>% arrange(desc(abs_pct)) %>% head(25) %>%
    transmute(Roll_No_Txt, Muni_Name_With_Typ, Frontage_or_Area,
              roll_acres = round(roll_acres, 3), geom_acres = round(geom_acres, 3),
              abs_pct = round(100 * abs_pct, 1))
  outp <- file.path(OUT_DIR, sprintf("area-outliers-%s.csv", gsub("[^a-z0-9]+", "-", tolower(label))))
  write.csv(worst, outp, row.names = FALSE)
  cat(sprintf("  worst-25 outliers -> %s\n", outp))
  print(utils::head(worst, 8), row.names = FALSE)
  invisible(cmp)
}

# ---- run -------------------------------------------------------------------
cat("verify_areas — area verification loop\n")
cat(sprintf("  tight tolerance = %.0f%%\n", 100 * TOL))

cur <- read_snapshot(CURRENT_GPKG, "current 2026")
report_agreement(cur, "current 2026")

if (file.exists(HISTORICAL_GPKG)) {
  his <- read_snapshot(HISTORICAL_GPKG, "historical 2025")
  report_agreement(his, "historical 2025")

  # ---- per-roll size change between snapshots (the "changed-size" signal) ----
  cat("\n===== snapshot-to-snapshot size change ((muni,roll)-matched) =====\n")
  # Dedupe to one row per parcel key within each snapshot (guards against any
  # accidental duplicate roll within a muni) before the 1:1 join.
  cur1 <- cur %>% group_by(pkey) %>% slice(1) %>% ungroup()
  his1 <- his %>% group_by(pkey) %>% slice(1) %>% ungroup()
  j <- inner_join(
    cur1 %>% transmute(pkey, Roll_No_Txt, cur_acres = geom_acres, cur_muni = Muni_Name_With_Typ),
    his1 %>% transmute(pkey, his_acres = geom_acres),
    by = "pkey"
  ) %>% filter(is.finite(cur_acres) & is.finite(his_acres) & his_acres > 0)
  j$delta_pct <- 100 * (j$cur_acres - j$his_acres) / j$his_acres
  only_cur <- setdiff(cur1$pkey, his1$pkey)
  only_his <- setdiff(his1$pkey, cur1$pkey)
  cat(sprintf("  rolls in both snapshots       : %d\n", nrow(j)))
  cat(sprintf("  rolls only in CURRENT (new)   : %d\n", length(only_cur)))
  cat(sprintf("  rolls only in HISTORICAL (gone): %d\n", length(only_his)))
  band <- function(lo, hi) sum(abs(j$delta_pct) > lo & abs(j$delta_pct) <= hi)
  cat(sprintf("  |Δ| <= 1%%                     : %d\n", sum(abs(j$delta_pct) <= 1)))
  cat(sprintf("  1%% < |Δ| <= 5%%                : %d\n", band(1, 5)))
  cat(sprintf("  5%% < |Δ| <= 25%%               : %d\n", band(5, 25)))
  cat(sprintf("  |Δ| > 25%% (material resize)   : %d\n", sum(abs(j$delta_pct) > 25)))
  changed <- j %>% filter(abs(delta_pct) > 5) %>% arrange(desc(abs(delta_pct))) %>%
    transmute(Roll_No_Txt, cur_muni, his_acres = round(his_acres, 3),
              cur_acres = round(cur_acres, 3), delta_pct = round(delta_pct, 1)) %>%
    head(50)
  outp <- file.path(OUT_DIR, "size-changed-rolls.csv")
  write.csv(changed, outp, row.names = FALSE)
  cat(sprintf("  top-50 size changes -> %s\n", outp))
  print(utils::head(changed, 10), row.names = FALSE)
}

cat("\nverify_areas done.\n")
