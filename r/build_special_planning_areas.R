# Build web/public/special-planning-areas.geojson: one dissolved outline per
# provincial Special Planning Area, taken from the newest zoning snapshot.
#
# Why: inside a Special Planning Area the zoning is set by a Manitoba
# Regulation, not the municipality's by-law. The province's Zoning By-Laws
# layer files those polygons under the host municipality (CentrePort's
# Inland Port SPA zones sit in Rosser with ZBL "48/2016", which is
# M.R. 48/2016). The web app draws this outline as the "CentrePort SPA"
# overlay and on the Addenda Pack zoning map, so the regulation's area
# reads as its own thing (Jason, 2026-11-05).
#
# Input : ../ManitobaZoning_YYYYMMDD.gpkg (newest), written weekly by
#         download_parcels.R.
# Output: ../web/public/special-planning-areas.geojson (EPSG:4326)
#
# Run from mb-parcelsearch/r:  Rscript build_special_planning_areas.R
# Re-run when the province changes the area's boundary; the zones inside it
# change far more often than the outline does.

suppressPackageStartupMessages({
  library(sf)
  library(dplyr)
})

# Works from mb-parcelsearch/r or from mb-parcelsearch itself.
root <- if (file.exists("../web/package.json")) ".." else "."
if (!file.exists(file.path(root, "web", "package.json"))) {
  stop("Run from mb-parcelsearch/r or mb-parcelsearch")
}

snap <- sort(Sys.glob(file.path(root, "ManitobaZoning_*.gpkg")), decreasing = TRUE)[1]
if (is.na(snap)) stop("No ManitobaZoning_*.gpkg snapshot found in ", root)
message("Snapshot: ", basename(snap))

z <- st_read(snap, quiet = TRUE) |>
  filter(grepl("special planning area", PLANNINGDISTRICT, ignore.case = TRUE))
if (nrow(z) == 0) stop("No Special Planning Area polygons in ", basename(snap))

# Union in UTM 14N so the dissolve is planar and slivers between adjacent
# zone polygons close; a 0.5 m buffer out-and-back seals digitizing gaps.
spa <- z |>
  st_make_valid() |>
  st_transform(26914) |>
  mutate(ZBL = trimws(ZBL)) |>
  group_by(district = PLANNINGDISTRICT, regulation = ZBL, muni = MUNI_NAME) |>
  summarise(zones = n(), .groups = "drop") |>
  st_buffer(0.5) |> st_buffer(-0.5) |>
  st_simplify(dTolerance = 1) |>
  st_transform(4326)

spa$acres <- round(as.numeric(st_area(spa)) / 4046.8564224)
message(paste(sprintf("  %s (%s, M.R. %s): %d zone polygons, %s acres",
                      spa$district, spa$muni, spa$regulation, spa$zones,
                      format(spa$acres, big.mark = ",")), collapse = "\n"))

out <- file.path(root, "web", "public", "special-planning-areas.geojson")
if (file.exists(out)) file.remove(out)
st_write(spa, out, driver = "GeoJSON", quiet = TRUE,
         layer_options = c("COORDINATE_PRECISION=6", "RFC7946=YES"))
message("Wrote ", out, " (", round(file.size(out) / 1024), " KB)")
