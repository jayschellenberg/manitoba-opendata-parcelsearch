# build_change_shards.R
#
# Publishes the parcel change history (history/, built by build_parcel_history.R
# and build_lineage.R --tables) for the web app, as per-muni shards in the
# mb-parcel-history clone:
#
#   changes/_index.json        { schema, generated, first_snapshot, last_snapshot,
#                                quarantined, disclaimer, munis: { "<muni_no>": {rolls, outlines} } }
#   changes/<muni_no>.json     { schema, muni_no,
#                                rolls:    { "<Roll_No_Txt>": [version, ...] },  -- sale matching
#                                outlines: GeoJSON FeatureCollection }           -- superseded outlines
#
# Only rolls with a CHANGE are included (more than one version, a roll that is
# new since the first snapshot, or a retired roll). A roll absent from `rolls`
# has had one outline since the first snapshot, so today's geometry applies to
# any sale after that date.
#
# Version object (short keys, the app's lib/parcelHistory.js reads them):
#   fs  first_seen         first snapshot showing this outline
#   ls  last_seen          last snapshot showing it; OMITTED for the current
#                          version (it is always _index.last_snapshot), so a
#                          shard only changes when its muni actually changed
#   onb open_not_before    the outline appeared after this date (null = before
#                          the first snapshot)
#   cna close_not_after    it was gone by this date (null = current)
#   o / c                  opened / closed reason
#   a                      area m2;  p  provisional (latest snapshot only)
#   from / to              other rolls this version came from / went to (lineage)
#   rel                    lineage event type
# Outline feature properties: roll, fs, ls, cna, c, a, a2 (area of the outline
# that replaced it under the same roll), to, rel, p.
#
# No timestamps inside per-muni shards: git only stores a new blob for a muni
# whose history changed, which keeps the weekly publish small.
#
#   Rscript r/build_change_shards.R            # write into the mb-parcel-history clone
#   CHANGE_SHARDS_OUT=<dir> Rscript ...         # write elsewhere (tests / dry runs)

suppressPackageStartupMessages({ library(sf); library(arrow); library(dplyr); library(jsonlite) })
sf::sf_use_s2(FALSE)

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
.r_dir <- if (length(.cfg)) dirname(sub("^--file=", "", .cfg[1])) else "r"
source(file.path(.r_dir, "config.R"))
source(file.path(.r_dir, "parcel_history_lib.R"))

HIST <- Sys.getenv("PARCEL_HISTORY_DIR")
if (!nzchar(HIST)) HIST <- file.path(mb_parcelsearch_root, "history")
OUT <- Sys.getenv("CHANGE_SHARDS_OUT")
if (!nzchar(OUT)) OUT <- file.path(mb_parcel_history_root, "changes")

DISCLAIMER <- paste(
  "Built from snapshots of the province's ROLL_ENTRY layer, which publishes no change dates:",
  "each change is known only to fall between two snapshot dates. Lineage (from / to) is",
  "inferred from overlapping outlines. Verify against registered plans and titles.")

catalog  <- as.data.frame(arrow::read_parquet(file.path(HIST, "snapshots.parquet")))
accepted <- sort(as.Date(catalog$snapshot_date[catalog$status == "accepted"]))
first_snap <- min(accepted); last_snap <- max(accepted)

v <- read_geoparquet(file.path(HIST, "parcel_versions.parquet"))
for (dc in c("first_seen", "last_seen", "open_not_before", "close_not_after")) v[[dc]] <- as.Date(v[[dc]])
edges <- as.data.frame(arrow::read_parquet(file.path(HIST, "lineage_edges.parquet")))
vt <- sf::st_drop_geometry(v)

# Rolls with a change worth publishing.
changed <- vt |> group_by(linc) |>
  summarise(n = n(), any_new = any(opened_reason != "baseline"), any_closed = any(!is.na(closed_reason)),
            .groups = "drop") |>
  filter(n > 1 | any_new | any_closed)
vt <- vt[vt$linc %in% changed$linc, ]

# Cross-roll lineage per version: rolls it came from / went to, and the event type.
roll_of <- setNames(v$Roll_No_Txt, v$version_id)
cross <- edges[edges$parent_linc != edges$child_linc, ]
agg <- function(by, other) {
  if (!nrow(cross)) return(data.frame(version_id = character(), rolls = I(list()), rel = character()))
  d <- data.frame(version_id = cross[[by]], roll = unname(roll_of[cross[[other]]]), rel = cross$relation)
  d |> group_by(version_id) |>
    summarise(rolls = list(sort(unique(roll))), rel = first(rel), .groups = "drop")
}
to_tbl <- agg("parent_version_id", "child_version_id")
from_tbl <- agg("child_version_id", "parent_version_id")
vt$to   <- to_tbl$rolls[match(vt$version_id, to_tbl$version_id)]
vt$from <- from_tbl$rolls[match(vt$version_id, from_tbl$version_id)]
vt$rel  <- coalesce(to_tbl$rel[match(vt$version_id, to_tbl$version_id)],
                    from_tbl$rel[match(vt$version_id, from_tbl$version_id)])

# Area of the outline that replaced each closed version under the same roll.
vt <- vt |> arrange(linc, first_seen) |> group_by(linc) |>
  mutate(a2 = lead(area_m2)) |> ungroup()

d8 <- function(x) ifelse(is.na(x), NA_character_, format(x, "%Y-%m-%d"))
version_obj <- function(r) {
  o <- list(fs = d8(r$first_seen),
            onb = d8(r$open_not_before), cna = d8(r$close_not_after),
            o = r$opened_reason, c = r$closed_reason, a = round(r$area_m2))
  if (!is.na(r$closed_reason)) o$ls <- d8(r$last_seen)
  if (isTRUE(r$provisional)) o$p <- TRUE
  # I(): keep one-roll lists as JSON arrays despite auto_unbox.
  if (length(r$from[[1]])) o$from <- I(r$from[[1]])
  if (length(r$to[[1]]))   o$to   <- I(r$to[[1]])
  if (!is.na(r$rel)) o$rel <- r$rel
  o
}

# Superseded outlines, simplified to 1 m (UTM) and written at 6 decimals.
sup_ids <- vt$version_id[!is.na(vt$closed_reason)]
outl <- v[v$version_id %in% sup_ids, "version_id"]
outl <- sf::st_simplify(outl, dTolerance = 1, preserveTopology = TRUE)
outl <- cbind(outl, vt[match(outl$version_id, vt$version_id),
                       c("Roll_No_Txt", "muni_no", "first_seen", "last_seen", "close_not_after",
                         "closed_reason", "area_m2", "a2", "rel", "provisional")])
outl$to <- vapply(vt$to[match(outl$version_id, vt$version_id)],
                  function(x) if (length(x)) paste(x, collapse = ", ") else NA_character_, "")
outl <- outl |> transmute(roll = Roll_No_Txt, muni_no, fs = d8(first_seen), ls = d8(last_seen),
                          cna = d8(close_not_after), c = closed_reason, a = round(area_m2),
                          a2 = round(a2), to, rel, p = ifelse(provisional, TRUE, NA))
outl <- sf::st_transform(outl, 4326)

geojson_text <- function(x) {
  f <- tempfile(fileext = ".geojson")
  on.exit(unlink(f))
  sf::st_write(x, f, driver = "GeoJSON", quiet = TRUE,
               layer_options = c("COORDINATE_PRECISION=6", "RFC7946=YES", "WRITE_NAME=NO"))
  paste(readLines(f, warn = FALSE, encoding = "UTF-8"), collapse = "")
}

dir.create(OUT, showWarnings = FALSE, recursive = TRUE)
munis <- sort(unique(vt$muni_no))
idx <- list()
written <- 0L
for (mn in munis) {
  mv <- vt[vt$muni_no == mn, ]
  mv <- mv[order(mv$Roll_No_Txt, mv$first_seen), ]
  rolls <- lapply(split(seq_len(nrow(mv)), mv$Roll_No_Txt),
                  function(ix) lapply(ix, function(i) version_obj(mv[i, ])))
  mo <- outl[outl$muni_no == mn, ]
  mo$muni_no <- NULL
  head_json <- jsonlite::toJSON(list(schema = 1, muni_no = mn, rolls = rolls),
                                auto_unbox = TRUE, null = "null", na = "null", digits = NA)
  body <- if (nrow(mo)) geojson_text(mo) else '{"type":"FeatureCollection","features":[]}'
  txt <- paste0(sub("\\}$", "", head_json), ',"outlines":', body, "}")
  fp <- file.path(OUT, paste0(mn, ".json"))
  old <- if (file.exists(fp)) paste(readLines(fp, warn = FALSE, encoding = "UTF-8"), collapse = "") else ""
  if (!identical(old, txt)) { writeLines(txt, fp, useBytes = TRUE); written <- written + 1L }
  idx[[as.character(mn)]] <- list(rolls = length(rolls), outlines = nrow(mo))
}
# Remove shards for munis that no longer have any change (rare: a rebuild).
stale <- setdiff(sub("\\.json$", "", list.files(OUT, pattern = "^\\d+\\.json$")), as.character(munis))
unlink(file.path(OUT, paste0(stale, ".json")))

quarantined <- sort(format(as.Date(catalog$snapshot_date[catalog$status == "quarantined"])))
jsonlite::write_json(
  list(schema = 1, generated = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
       first_snapshot = format(first_snap), last_snapshot = format(last_snap),
       snapshots = I(format(accepted)), quarantined = I(quarantined),
       disclaimer = DISCLAIMER, munis = idx),
  file.path(OUT, "_index.json"), auto_unbox = TRUE, pretty = TRUE)

cat(sprintf("change shards: %d munis (%d rewritten, %d removed), %d rolls, %d outlines -> %s\n",
            length(munis), written, length(stale), sum(vapply(idx, `[[`, 0L, "rolls")),
            nrow(outl), OUT))
cat(sprintf("total size: %.1f MB\n", sum(file.size(list.files(OUT, full.names = TRUE))) / 1e6))
