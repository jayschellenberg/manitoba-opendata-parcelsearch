# Build compact MLI acquisition-year coverage polygons for the web app.
# The newest flight year inside each 5 km catalogue cell wins, matching the
# chronological raster mosaic. Cells without a flight point use the nearest
# published flight point and are marked as inferred before year polygons merge.

suppressPackageStartupMessages(library(sf))

args <- commandArgs(trailingOnly = TRUE)
root <- normalizePath(".", mustWork = TRUE)
grid_path <- if (length(args) >= 1) args[[1]] else "D:/MBOrtho/metadata/ortho-grid/loc_mb_ortho_keymap_py_shp_v9.shp"
flight_path <- if (length(args) >= 2) args[[2]] else "D:/MBOrtho/metadata/flight-lines/Refresh2007_2014_Flight_Lines.shp"
output_path <- if (length(args) >= 3) args[[3]] else file.path(root, "web/public/mli-imagery-years.geojson")

if (!file.exists(grid_path)) stop("MLI ortho grid not found: ", grid_path)
if (!file.exists(flight_path)) stop("MLI flight lines not found: ", flight_path)

grid <- st_read(grid_path, quiet = TRUE)
flights <- st_read(flight_path, quiet = TRUE)

project <- suppressWarnings(as.integer(trimws(as.character(grid$R_DATE))))
grid <- grid[!is.na(project) & project > 0, ]
grid$project <- project[!is.na(project) & project > 0]
flights$year <- suppressWarnings(as.integer(as.character(flights$YEAR)))
flights <- flights[!is.na(flights$year), ]

hits <- st_intersects(grid, flights)
assigned_year <- vapply(hits, function(ix) {
  if (!length(ix)) return(NA_integer_)
  max(flights$year[ix], na.rm = TRUE)
}, integer(1))
method <- ifelse(is.na(assigned_year), "nearest flight point", "flight point in grid cell")

missing <- which(is.na(assigned_year))
if (length(missing)) {
  nearest <- st_nearest_feature(st_centroid(grid[missing, ]), flights)
  assigned_year[missing] <- flights$year[nearest]
}

grid$year <- assigned_year
grid$year_method <- method
grid <- st_transform(grid, 4326)

# One multipolygon per year keeps the client payload small while retaining the
# exact 5 km cell boundaries that distinguish neighbouring acquisition years.
years <- sort(unique(grid$year))
merged <- do.call(rbind, lapply(years, function(y) {
  part <- grid[grid$year == y, ]
  exact_count <- sum(part$year_method == "flight point in grid cell")
  st_sf(
    year = y,
    cell_count = nrow(part),
    exact_cells = exact_count,
    inferred_cells = nrow(part) - exact_count,
    geometry = st_union(st_geometry(part))
  )
}))
merged <- st_make_valid(merged)

dir.create(dirname(output_path), recursive = TRUE, showWarnings = FALSE)
if (file.exists(output_path)) file.remove(output_path)
st_write(merged, output_path, driver = "GeoJSON", quiet = TRUE,
         layer_options = "COORDINATE_PRECISION=5")

summary <- data.frame(
  year = merged$year,
  cells = merged$cell_count,
  exact = merged$exact_cells,
  inferred = merged$inferred_cells
)
print(summary, row.names = FALSE)
cat("Wrote", output_path, "\n")
