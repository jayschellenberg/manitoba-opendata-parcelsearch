# build_soil_palette.R
#
# Per-municipality ranking of soil associations by area, so the Soil Type
# overlay can colour its top-N palette when it is drawing from vector TILES
# instead of a loaded FeatureCollection.
#
# WHY THIS EXISTS
# ---------------
# applyIdentityPalette() in web/src/main.js ranks SOIL_CODE1 by area over the
# municipality's loaded soil FC, takes the top 20, and assigns the palette in
# that order. That works because the GeoJSON path has every polygon in hand.
# The PMTiles path does not — a tiled source only ever holds the viewport, so
# there is nothing to rank and the palette has no input.
#
# The alternative was one province-wide top-20. Rejected: "top 20 in Manitoba"
# is a different and much less useful statement than "top 20 here", and the
# legend already says "top 20 in selected municipality". Keeping the ranking
# per-municipality keeps the legend true.
#
# WHAT IT RANKS, AND WHY IT MATCHES THE OLD PATH EXACTLY
# ------------------------------------------------------
# The same thing applyIdentityPalette ranks: the FULL area of every polygon
# whose geometry intersects the municipality, summed per SOIL_CODE1. Not the
# clipped area — clipping would arguably be more correct, but it would also
# quietly reorder the legend for anyone comparing against an older screenshot,
# and this exists to preserve the existing meaning rather than improve it.
# Area comes from an equal-area projection for the same reason it does in
# build_soilfacts.R.
#
# INPUT is the per-municipality soil already cached by build_soilfacts.R under
# build-cache/soilfacts/*.gpkg, so this costs no network and no re-join. Those
# were fetched by the parcel bounding box, which is wider than the
# municipality, hence the intersect filter against the real boundary here.
#
# OUTPUT  mb-parcel-data/soilfacts/_palette.json
#   { "MACDONALD (RM)": [ { "c": "RDR", "n": "Red River" }, ... ] }
#
# A separate file rather than a key in each shard: this is derived from the
# soil survey, which is static between revisions, while the shards are derived
# from the parcel roll, which moves every refresh. Different lifecycles, and
# folding it in would mean republishing 28 MB of shards to change a legend.
#
# Run:  Rscript r/build_soil_palette.R

suppressPackageStartupMessages({
  library(sf); library(dplyr); library(jsonlite); library(stringi)
})

script_dir <- tryCatch({
  a <- commandArgs(trailingOnly = FALSE)
  dirname(normalizePath(sub("^--file=", "", a[grep("^--file=", a)])))
}, error = function(e) "r")
source(file.path(script_dir, "config.R"))

# Must match SOIL_SURVEY_PALETTE.length in web/src/main.js. More entries here
# than the palette has colours would be dead weight; fewer would leave the
# tail of the legend grey when the GeoJSON path would have coloured it.
TOP_N  <- 20
ALBERS <- "ESRI:102001"

safe_filename <- function(x) {
  x |>
    stringi::stri_trans_general(id = "Latin-ASCII") |>
    toupper() |>
    gsub(pattern = "[^A-Z0-9._-]+", replacement = "_") |>
    gsub(pattern = "_+",            replacement = "_") |>
    gsub(pattern = "^_|_$",         replacement = "")
}

cache_dir <- file.path(mb_parcelsearch_root, "build-cache", "soilfacts")
out_path  <- file.path(mb_parcel_data_root, "soilfacts", "_palette.json")
if (!dir.exists(cache_dir)) {
  stop("No ", cache_dir, " — run r/build_soilfacts.R first; this reads its cache.")
}

# The same 183-polygon file the app's muniAt.js uses, so a municipality named
# here is one the dropdown can actually select.
bnd_path <- file.path(mb_parcelsearch_root, "web", "public", "mb-municipalities.geojson")
bnd <- sf::st_read(bnd_path, quiet = TRUE) |> sf::st_make_valid()
cat(sprintf("Municipal boundaries: %d\n", nrow(bnd)))

palette <- list()
for (i in seq_len(nrow(bnd))) {
  muni <- bnd$MUNI_LIST_NAME_WITH_TYPE[i]
  if (is.na(muni) || !nzchar(muni)) next
  gpkg <- file.path(cache_dir, paste0(safe_filename(muni), ".gpkg"))
  if (!file.exists(gpkg)) next   # no parcels there, so no cached soil

  soil <- tryCatch(sf::st_read(gpkg, quiet = TRUE), error = function(e) NULL)
  if (is.null(soil) || !nrow(soil)) next
  soil <- sf::st_make_valid(soil)

  # The cache covers the parcel bbox, which overhangs the municipality. Keep
  # only what actually touches it — the same set applyIdentityPalette sees.
  hit <- tryCatch(
    lengths(sf::st_intersects(soil, sf::st_geometry(bnd)[i])) > 0,
    error = function(e) rep(TRUE, nrow(soil)))
  soil <- soil[hit, , drop = FALSE]
  if (!nrow(soil)) next

  codes <- as.character(soil$SOIL_CODE1)
  names_ <- as.character(soil$SOILNAME1)
  areas <- as.numeric(sf::st_area(sf::st_transform(soil, ALBERS)))
  keep <- !is.na(codes) & nzchar(codes) & is.finite(areas) & areas > 0
  if (!any(keep)) next

  agg <- data.frame(code = codes[keep], name = names_[keep], area = areas[keep],
                    stringsAsFactors = FALSE) |>
    dplyr::group_by(code) |>
    dplyr::summarise(area = sum(area),
                     name = dplyr::first(name[!is.na(name) & nzchar(name)]),
                     .groups = "drop") |>
    dplyr::arrange(dplyr::desc(area)) |>
    utils::head(TOP_N)

  palette[[muni]] <- lapply(seq_len(nrow(agg)), function(k) {
    list(c = agg$code[k],
         n = if (is.na(agg$name[k])) agg$code[k] else agg$name[k])
  })
  cat(sprintf("%-40s %2d soils\n", muni, nrow(agg)))
}

if (!length(palette)) stop("No municipality produced a ranking; refusing to write an empty palette.")

tmp <- paste0(out_path, ".tmp")
writeLines(jsonlite::toJSON(palette, auto_unbox = TRUE), tmp)
if (file.exists(out_path)) file.remove(out_path)
file.rename(tmp, out_path)
cat(sprintf("\n%d municipalities -> %s (%.1f KB)\n",
            length(palette), out_path, file.size(out_path) / 1024))
