# archive_snapshot.R
#
# Append-only annual archive of the provincial MAO source layers, so a
# parcel's size/shape (and later its zoning / dev-plan designation) at a
# point in time can be recovered after subdivisions and rezonings.
#
# What it does: copies the CURRENT provincial source file(s) out of
# mao-assembly/inputs into a dated, year-foldered Dropbox archive,
# NEVER overwriting a prior capture. Idempotent — safe to run any time;
# re-running only adds files that aren't already archived.
#
#   source : D:/Dropbox/Appraisal/RProjects/appraisal-templates/mao-assembly/inputs
#   archive: D:/Dropbox/Appraisal/Web/MAOSnapshots/<year>/
#
# Naming: each source is archived as <sourcebasename><YYYYMMDD>.<ext>,
# where the date is the SOURCE FILE'S modification date (= when you
# downloaded it from Manitoba Open Data). The name is taken straight from
# the source file so the archive always matches what the province ships
# (e.g. MBRollGeoPackage.gpkg -> MBRollGeoPackage20260605.gpkg). The year
# subfolder comes from that same date.
#
# (Note: the 2025 zoning file was hand-named "Manitoba_Zoning_Bylaws…"
# whereas the provincial source is "Manitoba_Zoning_By_Laws"; going
# forward this archiver uses the source spelling. Rename the 2025 file to
# match if you want the series perfectly uniform — cosmetic only.)
#
# Trigger: run this by hand whenever you've downloaded a fresh provincial
# source into mao-assembly/inputs (the downloads are manual + infrequent).
# Because it dates by file mtime and is append-only, you can also just run
# it periodically and it will capture whatever is currently in inputs.
#
#   Rscript r/archive_snapshot.R          # geometry only (the `active` set)
#   Rscript r/archive_snapshot.R --all    # also capture zoning + dev-plan
#
# Storage note: archives live in Dropbox, OUTSIDE the git repo and OUTSIDE
# web/public (so they never bloat history or the Vercel deploy). ~225 MB
# per geometry snapshot; consult them cold in QGIS/R when needed.

ARCHIVE_ROOT <- "D:/Dropbox/Appraisal/Web/MAOSnapshots"
SRC_DIR <- "D:/Dropbox/Appraisal/RProjects/appraisal-templates/mao-assembly/inputs"

# Source layers. `active` gates whether a plain run captures it. Geometry
# is on now. Zoning + dev-plan are wired and ready — set their `active` to
# TRUE (or run with --all) to start retaining them.
sources <- list(
  list(active = TRUE,  file = "MBRollGeoPackage.gpkg"),
  list(active = FALSE, file = "Manitoba_Zoning_By_Laws.geojson"),
  list(active = FALSE, file = "Manitoba_Development_Plan_Designations.geojson")
)

args        <- commandArgs(trailingOnly = TRUE)
capture_all <- "--all" %in% args

archive_one <- function(s) {
  src <- file.path(SRC_DIR, s$file)
  if (!file.exists(src)) {
    cat(sprintf("  SKIP  %-45s (not found in inputs)\n", s$file))
    return(invisible(FALSE))
  }
  info  <- file.info(src)
  d     <- as.Date(info$mtime)
  ymd   <- format(d, "%Y%m%d")
  year  <- format(d, "%Y")
  ext   <- tools::file_ext(s$file)
  base  <- tools::file_path_sans_ext(s$file)   # archive name == source name + date
  ddir  <- file.path(ARCHIVE_ROOT, year)
  dest  <- file.path(ddir, paste0(base, ymd, ".", ext))

  if (file.exists(dest)) {
    cat(sprintf("  HAVE  %-45s -> %s/%s\n", s$file, year, basename(dest)))
    return(invisible(FALSE))
  }
  dir.create(ddir, showWarnings = FALSE, recursive = TRUE)
  cat(sprintf("  COPY  %-45s -> %s/%s  (%.1f MB) ...\n",
              s$file, year, basename(dest), info$size / 1024^2))
  ok <- file.copy(src, dest, overwrite = FALSE, copy.date = TRUE)
  if (!ok || !file.exists(dest)) stop("copy failed: ", src, " -> ", dest)
  if (file.info(dest)$size != info$size) {
    file.remove(dest)
    stop("size mismatch after copy (removed partial): ", dest)
  }
  cat("        done.\n")
  invisible(TRUE)
}

cat("MAO snapshot archive\n")
cat("  source :", SRC_DIR, "\n")
cat("  archive:", ARCHIVE_ROOT, "\n\n")
for (s in sources) {
  if (s$active || capture_all) {
    archive_one(s)
  } else {
    cat(sprintf("  OFF   %-45s (inactive — run with --all to capture)\n", s$file))
  }
}
cat("\nArchive run complete.\n")
