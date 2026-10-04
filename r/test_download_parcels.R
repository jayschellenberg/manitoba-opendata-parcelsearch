# Offline checks for download_parcels.R's count-verified paging.
# Run from the repository root with: Rscript r/test_download_parcels.R

Sys.setenv(DOWNLOAD_PARCELS_SOURCE_ONLY = "1")
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
.r_dir <- if (length(.cfg)) dirname(sub("^--file=", "", .cfg[1])) else "r"
source(file.path(.r_dir, "download_parcels.R"))

output_dir <- tempfile("dl_test_"); dir.create(output_dir)
FORCE_REFRESH <- TRUE

# A fake layer of `total` point features served `per_page` at a time.
fake_page_fn <- function(total, per_page, stop_early_at = Inf) {
  function(url, offset) {
    if (offset >= min(total, stop_early_at)) return(NULL)
    n <- min(per_page, total - offset)
    sf::st_sf(id = offset + seq_len(n) - 1,
              geometry = sf::st_sfc(lapply(seq_len(n), function(i) sf::st_point(c(i, i))), crs = 4326))
  }
}
ds <- list(name = "TestLayer", layer = "test", url = "stub://")
written <- function() sf::st_read(file.path(output_dir, sprintf("TestLayer_%s.gpkg", date_stamp)), quiet = TRUE)

# 1. Server trims every page to 1500 (< PAGE_SIZE). The old loop stopped after
#    the first page; the new one must keep going and get every row exactly once.
out <- download_layer(ds, count_fn = function(u) 4100L, page_fn = fake_page_fn(4100, 1500))
stopifnot(!is.null(out), nrow(written()) == 4100, !anyDuplicated(written()$id))

# 2. Data ends before the advertised count: nothing written, NULL returned.
unlink(list.files(output_dir, full.names = TRUE))
out <- download_layer(ds, count_fn = function(u) 4100L, page_fn = fake_page_fn(4100, 2000, stop_early_at = 2000))
stopifnot(is.null(out), length(list.files(output_dir, pattern = "\\.gpkg$")) == 0)

# 3. Layer grew mid-fetch (more rows than counted): refuse.
out <- download_layer(ds, count_fn = function(u) 3000L, page_fn = fake_page_fn(5000, 2000))
stopifnot(is.null(out), length(list.files(output_dir, pattern = "\\.gpkg$")) == 0)

# 4. Count query fails: refuse without paging.
out <- download_layer(ds, count_fn = function(u) stop("boom"), page_fn = function(...) stop("should not page"))
stopifnot(is.null(out))

cat("download_parcels paging tests passed\n")
