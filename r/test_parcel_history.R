# Offline checks for parcel_history_lib.R (versions, QC, lineage, sales match).
# Run from the repository root with: Rscript r/test_parcel_history.R

.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
.r_dir <- if (length(.cfg)) dirname(sub("^--file=", "", .cfg[1])) else "r"
source(file.path(.r_dir, "parcel_history_lib.R"))
sf::sf_use_s2(FALSE)

X0 <- 600000; Y0 <- 5520000      # somewhere in southern Manitoba, UTM 14N
sq <- function(x, y, w = 100, h = 100) {
  sf::st_polygon(list(rbind(c(x, y), c(x + w, y), c(x + w, y + h), c(x, y + h), c(x, y)) +
                        matrix(c(X0, Y0), 5, 2, byrow = TRUE)))
}
# A snapshot from a list of list(muni, roll, geom[, addr]).
snap <- function(...) {
  p <- list(...)
  sf::st_sf(Roll_No_Txt = vapply(p, `[[`, "", 2),
            Municipality = sprintf("%s - TEST MUNI", vapply(p, `[[`, "", 1)),
            Property_Address = vapply(p, function(z) z$addr %||% "1 MAIN ST", ""),
            Asmt_Roll = "2027 Fall", Total_Value = "100000", Frontage_or_Area = "1 AC", Dwelling_Units = "1",
            geometry = sf::st_sfc(lapply(p, `[[`, 3), crs = PH_CRS)) |> normalise_snapshot()
}
P <- function(muni, roll, geom, addr = NULL) list(muni, roll, geom, addr = addr)
run <- function(snaps, dates, params = ph_params(), force = character()) {
  ctx <- new_context(); log <- list()
  for (i in seq_along(snaps)) {
    r <- ingest_snapshot(ctx, snaps[[i]], as.Date(dates[i]), force_accept = dates[i] %in% force, params = params)
    ctx <- r$ctx; log[[i]] <- r$decision$status
  }
  ctx$versions <- mark_provisional(ctx$versions, ctx$last_date)
  ctx$log <- unlist(log)
  ctx
}
V <- function(ctx, linc) sf::st_drop_geometry(ctx$versions[ctx$versions$linc == linc, ])
check <- function(cond, what) { if (!isTRUE(cond)) stop("FAILED: ", what, call. = FALSE); cat("ok  ", what, "\n") }
lp <- ph_params(max_gone_frac = 1.01, max_shrink_frac = 1.01)  # tiny fixtures: QC off except in the QC tests

# ---- identity ----
check(identical(make_linc("168 - RM OF ROCKWOOD", "707400.000"), "168R707400000"), "LINC matches mao-assembly format")
check(identical(make_linc(c(NA, "168 - X", "168 - X"), c("1.000", NA, "")), rep(NA_character_, 3)), "LINC is NA without muni or roll")
check(make_linc("163 - A", "707400.000") != make_linc("176 - B", "707400.000"), "same roll in two munis -> two LINCs")

# ---- shared condo footprint: distinct rolls, same outline ----
c1 <- run(list(snap(P("463", "10501.000", sq(0, 0)), P("463", "10502.000", sq(0, 0)))), "2026-01-01")
check(nrow(c1$versions) == 2 && all(c1$versions$opened_reason == "baseline"), "shared footprint keeps one version per roll")

# ---- noise vs real change ----
a <- sq(0, 0, 200, 200)
rot <- sf::st_polygon(list(rbind(c(200, 0), c(200, 200), c(0, 200), c(0, 0), c(200, 0)) +
                             matrix(c(X0, Y0), 5, 2, byrow = TRUE)))           # same ring, other start vertex
jit <- a + c(0.004, -0.003)                                                    # sub-centimetre wobble
moved <- sq(30, 0, 200, 200)                                                    # equal area, shifted 30 m
r <- run(list(snap(P("101", "1.000", a)), snap(P("101", "1.000", rot)), snap(P("101", "1.000", jit)),
              snap(P("101", "1.000", moved))),
         c("2026-01-01", "2026-01-08", "2026-01-15", "2026-01-22"), lp)
vv <- V(r, "101R000001000")
check(nrow(vv) == 2, "ring rotation and cm jitter do not open versions; equal-area shift does")
check(vv$opened_reason[2] == "reshaped" && vv$closed_reason[1] == "reshaped", "shift recorded as reshape")
check(vv$last_seen[1] == as.Date("2026-01-15") && vv$open_not_before[2] == as.Date("2026-01-15") &&
        vv$first_seen[2] == as.Date("2026-01-22") && vv$close_not_after[1] == as.Date("2026-01-22"),
      "reshape window = (last seen old, first seen new]")
check(abs(vv$symdiff_prev_m2[2] - 2 * 30 * 200) < 1, "symdiff metric stored (12,000 m2)")

# ---- present / absent / present is a gap, not a retirement ----
g <- run(list(snap(P("101", "1.000", sq(0, 0)), P("101", "2.000", sq(200, 0))),
              snap(P("101", "1.000", sq(0, 0))),
              snap(P("101", "1.000", sq(0, 0)), P("101", "2.000", sq(200, 0)))),
         c("2026-01-01", "2026-01-08", "2026-01-15"), lp)
v2 <- V(g, "101R000002000")
check(nrow(v2) == 1 && is.na(v2$closed_reason) && v2$gap_count == 1 && v2$last_seen == as.Date("2026-01-15"),
      "roll missing for one snapshot is re-opened with gap_count 1")

g2 <- run(list(snap(P("101", "1.000", sq(0, 0)), P("101", "2.000", sq(200, 0))),
               snap(P("101", "1.000", sq(0, 0)))), c("2026-01-01", "2026-01-08"), lp)
check(isTRUE(V(g2, "101R000002000")$provisional), "retirement at the latest snapshot is provisional")

# ---- QC quarantine ----
base <- lapply(1:20, function(i) P("101", sprintf("%d.000", i), sq(i * 150, 0)))
half <- base[1:10]
q <- run(list(do.call(snap, base), do.call(snap, half), do.call(snap, base)),
         c("2026-01-01", "2026-01-08", "2026-01-15"))
check(identical(q$log, c("accepted", "quarantined", "accepted")), "snapshot missing half its rolls is quarantined")
check(all(is.na(q$versions$closed_reason)) && all(q$versions$last_seen == as.Date("2026-01-15")),
      "quarantined snapshot writes no retirements")
q2 <- run(list(do.call(snap, base), do.call(snap, half), do.call(snap, half)),
          c("2026-01-01", "2026-01-08", "2026-01-15"))
check(identical(q2$log, c("accepted", "quarantined", "accepted")) &&
        sum(q2$versions$closed_reason %in% "retired") == 10, "a repeated mass loss is confirmed and applied")
q3 <- run(list(do.call(snap, base), do.call(snap, half)), c("2026-01-01", "2026-01-08"), force = "2026-01-08")
check(identical(q3$log, c("accepted", "accepted")), "--accept forces a quarantined snapshot through")

# ---- lineage ----
lin <- function(ctx, d0, d1) lineage_window(ctx$versions, as.Date(d0), as.Date(d1))
# subdivision: 1 retired -> 2 new
s <- run(list(snap(P("101", "1.000", sq(0, 0, 200, 100)), P("101", "9.000", sq(500, 0))),
              snap(P("101", "1.100", sq(0, 0, 100, 100)), P("101", "1.200", sq(100, 0, 100, 100)), P("101", "9.000", sq(500, 0)))),
         c("2026-01-01", "2026-01-08"), lp)
L <- lin(s, "2026-01-01", "2026-01-08")
check(nrow(L$events) == 1 && L$events$type == "subdivision" && nrow(L$edges) == 2, "subdivision 1 -> 2")
check(all(abs(L$edges$overlap_pct_child - 1) < 1e-6) && all(abs(L$edges$overlap_pct_parent - 0.5) < 1e-6),
      "edge overlap percentages in both directions")

# subdivision keeping the parent roll on the remainder
s2 <- run(list(snap(P("101", "1.000", sq(0, 0, 200, 100))),
               snap(P("101", "1.000", sq(0, 0, 150, 100)), P("101", "1.100", sq(150, 0, 50, 100)))),
          c("2026-01-01", "2026-01-08"), lp)
L2 <- lin(s2, "2026-01-01", "2026-01-08")
check(nrow(L2$events) == 1 && L2$events$type == "subdivision_retained_parent", "parent roll retained on remainder")
anc <- lineage_ancestors("101R000001100@20260108", L2$edges)
check(identical(anc$parent_version_id, "101R000001000@20260101"), "ancestor of the child is the parent's OLD version (no self-cycle)")

# consolidation 2 -> 1, with a small parent (either-direction cover)
s3 <- run(list(snap(P("101", "1.000", sq(0, 0, 980, 1000)), P("101", "2.000", sq(980, 0, 20, 1000))),
               snap(P("101", "3.000", sq(0, 0, 1000, 1000)))), c("2026-01-01", "2026-01-08"), lp)
L3 <- lin(s3, "2026-01-01", "2026-01-08")
check(nrow(L3$events) == 1 && L3$events$type == "consolidation" && nrow(L3$edges) == 2,
      "consolidation keeps a parent covering 2% of the child")

# fabric redraw: two neighbours both shifted 15 m keep their rolls -> two
# reshapes, not one reconfiguration glued together by 15% sliver overlaps
s6 <- run(list(snap(P("101", "1.000", sq(0, 0)), P("101", "2.000", sq(100, 0))),
               snap(P("101", "1.000", sq(15, 0)), P("101", "2.000", sq(115, 0)))), c("2026-01-01", "2026-01-08"), lp)
L6 <- lin(s6, "2026-01-01", "2026-01-08")
check(nrow(L6$events) == 2 && all(L6$events$type == "reshape") && all(L6$edges$same_linc),
      "fabric shift: sliver overlaps between continuing lots are dropped")
# ... but a weak overlap is kept when it is the only explanation for a new roll
s7 <- run(list(snap(P("101", "1.000", sq(0, 0, 100, 100))),
               snap(P("101", "1.000", sq(0, 0, 100, 100)), P("101", "5.000", sq(80, 0, 300, 100)))),
          c("2026-01-01", "2026-01-08"), lp)
L7 <- lin(s7, "2026-01-01", "2026-01-08")
check(NROW(L7$edges) == 1, "weak edge kept when it is a new roll's only link")

# renumber and cross-muni transfer
s4 <- run(list(snap(P("101", "1.000", sq(0, 0))), snap(P("101", "77.000", sq(0, 0)))), c("2026-01-01", "2026-01-08"), lp)
check(lin(s4, "2026-01-01", "2026-01-08")$events$type == "possible_renumber", "same outline, new roll -> possible_renumber")
s5 <- run(list(snap(P("101", "1.000", sq(0, 0))), snap(P("102", "1.000", sq(0, 0)))), c("2026-01-01", "2026-01-08"), lp)
check(lin(s5, "2026-01-01", "2026-01-08")$events$type == "administrative_transfer", "muni change -> administrative_transfer")

# ---- sales ----
sv <- V(r, "101R000001000")
sales <- data.frame(sale_id = 1:6, linc = c(rep("101R000001000", 5), "999R000000001"),
                    sale_date = as.Date(c("2025-06-01", "2026-01-10", "2026-01-15", "2026-01-18", "2026-02-01", "2026-01-10")))
m <- match_sales(sales, r$versions)
mt <- as.vector(tapply(m$match_type, m$sale_id, `[`, 1))
check(identical(unname(mt), c("window", "certain", "ambiguous", "ambiguous", "window", "none")),
      "sales: observed span certain; change window + boundary day ambiguous; before first / after last snapshot window; unknown none")
check(isTRUE(m$left_censored[m$sale_id == 1]), "sale before the first snapshot flagged left_censored")
check(sum(m$sale_id == 4) == 2, "ambiguous sale returns both candidate versions")

# ---- full replay equals incremental ----
dl <- list(); ctx <- new_context(); snaps <- list(snap(P("101", "1.000", a)), snap(P("101", "1.000", moved)), snap(P("101", "1.000", moved), P("101", "5.000", sq(400, 0))))
ds <- as.Date(c("2026-01-01", "2026-01-08", "2026-01-15"))
for (i in seq_along(snaps)) { rr <- ingest_snapshot(ctx, snaps[[i]], ds[i], params = lp); ctx <- rr$ctx; dl[[i]] <- rr$delta }
replay <- empty_versions(); prev <- as.Date(NA)
for (i in seq_along(dl)) { replay <- apply_delta(replay, dl[[i]], ds[i], prev, lp); prev <- ds[i] }
st <- state_from_deltas(do.call(rbind, dl))
check(identical(sf::st_drop_geometry(replay), sf::st_drop_geometry(ctx$versions)), "replay from deltas == incremental versions")
check(setequal(st$linc, ctx$state$linc) && identical(st$geom_hash[order(st$linc)], ctx$state$geom_hash[order(ctx$state$linc)]),
      "state rebuilt from deltas == live state")

# ---- GeoParquet round trip ----
f <- tempfile(fileext = ".parquet")
write_geoparquet(ctx$versions, f)
back <- read_geoparquet(f)
check(nrow(back) == nrow(ctx$versions) && isTRUE(all.equal(as.numeric(sf::st_area(back)), ctx$versions$area_m2)),
      "GeoParquet round trip keeps rows and geometry")
meta <- jsonlite::fromJSON(arrow::read_parquet(f, as_data_frame = FALSE)$metadata$geo)
check(meta$columns$geometry$crs$id$code == 26914, "GeoParquet metadata carries EPSG:26914")

# ---- map realignment ----
# Muni 101: three lots shifted 10 m at equal area in one snapshot (a redraw), and
# one lot that grew 20% the same week (a real change). Muni 102: one lot shifted
# alone. Cluster threshold 3 for the tiny fixture.
rp <- ph_params(max_gone_frac = 1.01, max_shrink_frac = 1.01, realign_min_cluster = 3L)
s1 <- snap(P("101", "1.000", sq(0, 0)), P("101", "2.000", sq(200, 0)), P("101", "3.000", sq(400, 0)),
           P("101", "4.000", sq(600, 0)), P("102", "1.000", sq(0, 400)))
s2 <- snap(P("101", "1.000", sq(10, 0)), P("101", "2.000", sq(210, 0)), P("101", "3.000", sq(410, 0)),
           P("101", "4.000", sq(600, 0, w = 120)), P("102", "1.000", sq(10, 400)))
ra <- run(list(s1, s2), c("2026-01-01", "2026-01-08"), params = rp)
rt <- tag_realignments(ra$versions, rp)
ro <- function(linc) V(list(versions = rt), linc)
check(all(vapply(c("101R000001000", "101R000002000", "101R000003000"), function(l) {
        x <- ro(l); identical(x$opened_reason, c("baseline", "realigned")) && identical(x$closed_reason, c("realigned", NA_character_))
      }, TRUE)), "an equal-area cluster in one muni + snapshot is tagged realigned (both ends)")
check(identical(ro("101R000004000")$opened_reason[2], "reshaped"), "a 20% area change in the same week stays reshaped")
check(identical(ro("102R000001000")$opened_reason[2], "reshaped"), "a lone equal-area shift stays reshaped")
back <- tag_realignments(rt, ph_params(realign_min_cluster = 4L))
check(identical(V(list(versions = back), "101R000001000")$opened_reason[2], "reshaped") &&
      identical(V(list(versions = back), "101R000001000")$closed_reason[1], "reshaped"),
      "raising the threshold re-tags realigned back to reshaped")
lw <- lineage_window(rt, as.Date("2026-01-01"), as.Date("2026-01-08"), rp)
lk <- if (is.null(lw$edges)) character() else unique(c(lw$edges$parent_linc, lw$edges$child_linc))
check(!any(c("101R000001000", "101R000002000", "101R000003000") %in% lk), "realigned lots produce no lineage edges")

cat("\nall parcel_history tests passed\n")
