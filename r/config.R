# config.R — shared path roots + constants for the r/ scripts.
#
# Every script used to hardcode its D:/Dropbox/... roots; this resolves
# them in one place so another machine (or a moved Dropbox) overrides
# via environment variables instead of editing each script:
#
#   MB_PARCELSEARCH_ROOT        this repo's root      (default: parent of r/)
#   MBOPENDATA_WEBSEARCH_ROOT   legacy alias for this repo's root
#   MAO_SNAPSHOTS_ROOT          cold archive of dated provincial snapshots
#   MAO_ASSEMBLY_ROOT           sister mao-assembly project root
#   MASC_SCRAPE_ROOT            sister MASC-SCRAPE project root
#   MASC_SQUARE_CSV             refreshed square-section CSV (optional)
#   MASC_RIVERLOT_CSV           refreshed river/parish-lot CSV (optional)
#   MB_PARCEL_HISTORY_ROOT      local clone of the mb-parcel-history repo
#
# Scripts source this with a two-line bootstrap that finds config.R
# beside the running script under Rscript, falling back to r/config.R
# relative to the working directory for interactive use from the repo
# root:
#
#   .cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
#   source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

# --- roots ---------------------------------------------------------------

# This repo (mb-parcelsearch). Resolved from the running script's location
# (r/<script>.R → parent dir) so a clone works wherever it lands.
mb_parcelsearch_root <- local({
  override <- Sys.getenv("MB_PARCELSEARCH_ROOT")
  if (!nzchar(override)) override <- Sys.getenv("MBOPENDATA_WEBSEARCH_ROOT")
  if (nzchar(override)) return(normalizePath(override, winslash = "/", mustWork = FALSE))
  f <- grep("^--file=", commandArgs(FALSE), value = TRUE)
  if (length(f)) {
    return(normalizePath(file.path(dirname(sub("^--file=", "", f[1])), ".."), winslash = "/"))
  }
  normalizePath(getwd(), winslash = "/")
})

.path_default <- function(env_var, default) {
  v <- Sys.getenv(env_var)
  if (nzchar(v)) normalizePath(v, winslash = "/", mustWork = FALSE) else default
}

# External roots. The defaults are this machine's layout; scripts that
# need one fail with their own "not found" message when it's absent.
mao_snapshots_root     <- .path_default("MAO_SNAPSHOTS_ROOT",     "D:/Dropbox/Appraisal/Web/MAOSnapshots")
mao_assembly_root      <- .path_default("MAO_ASSEMBLY_ROOT",      "D:/Dropbox/Appraisal/RProjects/appraisal-templates/mao-assembly")
masc_scrape_root       <- .path_default("MASC_SCRAPE_ROOT",       "D:/Dropbox/ClaudeCode/MASC-SCRAPE")
mb_parcel_history_root <- .path_default("MB_PARCEL_HISTORY_ROOT", "D:/Dropbox/ClaudeCode/MBOpenData/mb-parcel-history")
mb_parcel_data_root    <- .path_default("MB_PARCEL_DATA_ROOT",    "D:/Dropbox/ClaudeCode/MBOpenData/mb-parcel-data")

# --- shared constants ------------------------------------------------------

M2_PER_ACRE <- 4046.8564224   # square metres per acre
UTM14_EPSG  <- 26914          # NAD83 / UTM zone 14N — Manitoba area calcs
