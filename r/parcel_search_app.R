# parcel_search_app.R
# Shiny app for offline / historical Manitoba parcel search against a local
# snapshot of ROLL_ENTRY + zoning + dev-plan GeoPackages produced by
# download_parcels.R.
#
# Searches by Civic Address / Municipality / Roll # against the parcels
# layer, then spatially joins zoning + dev-plan polygons to populate the
# top-1 of each. (The web app does top-2; this offline app keeps it
# simpler since the use case is point-lookups, not bulk analysis.)
#
# This is a DEV / OFFLINE TOOL — the production app is the Vite site
# under web/. Use this when you need to search a historical snapshot
# without internet, or to spot-check the local GeoPackages produced by
# r/download_parcels.R. Schema drift in a freshly-pulled snapshot is
# handled defensively: missing search columns warn instead of erroring
# (the offending filter is silently dropped), and an overlay missing
# its expected columns warns and skips that enrichment rather than
# crashing the search.
#
# Requires: shiny, sf, leaflet, DT, dplyr

suppressPackageStartupMessages({
  library(shiny)
  library(sf)
  library(leaflet)
  library(DT)
  library(dplyr)
})

# Shared roots (env-overridable) — see r/config.R. (Under shiny::runApp
# there's no --file, so this resolves r/config.R from the repo-root cwd.)
.cfg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
source(if (length(.cfg)) file.path(dirname(sub("^--file=", "", .cfg[1])), "config.R") else "r/config.R")

data_dir <- mb_parcelsearch_root

# Match RollEntry_YYYYMMDD.gpkg, sorted newest-first.
roll_files <- sort(
  list.files(data_dir, pattern = "^RollEntry_\\d{8}\\.gpkg$", full.names = TRUE),
  decreasing = TRUE
)
if (length(roll_files) == 0) {
  stop(
    "No RollEntry_YYYYMMDD.gpkg found in ", data_dir,
    "\nRun r/download_parcels.R to fetch one."
  )
}

snapshot_dates <- regmatches(basename(roll_files), regexpr("\\d{8}", basename(roll_files)))
snapshot_labels <- snapshot_dates
snapshot_labels[1] <- paste0(snapshot_labels[1], " (latest)")
snapshot_choices <- setNames(roll_files, snapshot_labels)

cat("Found", length(roll_files), "RollEntry snapshot(s):",
    paste(snapshot_dates, collapse = ", "), "\n")

# Defensive schema check. Returns TRUE when every expected column is
# present; otherwise warns once with the missing list and returns FALSE
# so callers can degrade gracefully (drop a filter, skip an enrichment)
# rather than failing with an opaque "undefined columns" error.
require_cols <- function(df, cols, label) {
  missing <- setdiff(cols, names(df))
  if (length(missing) == 0) return(TRUE)
  warning(sprintf(
    "%s missing expected column(s): %s — degrading the relevant search/enrichment step.",
    label, paste(missing, collapse = ", ")
  ), call. = FALSE)
  FALSE
}

# Sister-layer file paths for a given RollEntry snapshot date. Returns NULL
# (with a warning shown in the UI) if the matching layer isn't available
# for that date — search still works, just without that enrichment.
sister_path <- function(date, prefix) {
  p <- file.path(data_dir, sprintf("%s_%s.gpkg", prefix, date))
  if (file.exists(p)) p else NULL
}

# --- UI ---
ui <- fluidPage(
  titlePanel("Manitoba Parcel Search (offline)"),

  fluidRow(
    column(4, selectInput("snapshot", "Snapshot date:", choices = snapshot_choices, selected = roll_files[1])),
    column(8, htmlOutput("snapshot_info"))
  ),

  fluidRow(
    column(3, textInput("address", "Civic Address (contains)")),
    column(3, selectInput("muni",   "Municipality", choices = c("(any)" = ""), selected = "")),
    column(3, textInput("roll",     "Roll # (contains)")),
    column(3, br(), actionButton("search", "Search", class = "btn-primary"))
  ),

  textOutput("count"),

  br(),
  leafletOutput("map", height = "500px"),
  br(),
  DTOutput("table")
)

# --- Server ---
server <- function(input, output, session) {

  # current_data() reloads layers when the snapshot picker changes.
  current_data <- reactive({
    req(input$snapshot)
    path <- input$snapshot
    date <- regmatches(basename(path), regexpr("\\d{8}", basename(path)))
    parcels <- st_read(path, quiet = TRUE)
    zoning_path <- sister_path(date, "ManitobaZoning")
    devplan_path <- sister_path(date, "ManitobaDevPlan")
    list(
      path      = path,
      date      = date,
      parcels   = parcels,
      zoning    = if (!is.null(zoning_path)) st_read(zoning_path, quiet = TRUE) else NULL,
      devplan   = if (!is.null(devplan_path)) st_read(devplan_path, quiet = TRUE) else NULL,
      zoning_p  = zoning_path,
      devplan_p = devplan_path
    )
  })

  # Refresh the muni dropdown whenever the snapshot changes — it's keyed
  # off the loaded parcels' distinct Muni_Name_With_Typ values.
  observe({
    p <- current_data()$parcels
    munis <- sort(unique(p$Muni_Name_With_Typ))
    updateSelectInput(
      session, "muni",
      choices = c("(any)" = "", munis),
      selected = ""
    )
  })

  output$snapshot_info <- renderUI({
    d <- current_data()
    pieces <- c(
      sprintf("<b>Loaded:</b> %s (%d parcels)", basename(d$path), nrow(d$parcels)),
      if (!is.null(d$zoning_p)) sprintf("<b>Zoning:</b> %s (%d polys)", basename(d$zoning_p), nrow(d$zoning))
      else "<i>No zoning snapshot for this date</i>",
      if (!is.null(d$devplan_p)) sprintf("<b>Dev Plan:</b> %s (%d polys)", basename(d$devplan_p), nrow(d$devplan))
      else "<i>No dev-plan snapshot for this date</i>"
    )
    HTML(paste(pieces, collapse = "<br>"))
  })

  results <- eventReactive(input$search, {
    d <- current_data()
    p <- d$parcels
    # Skip any filter whose backing column is missing from the snapshot;
    # the warning surfaces in the R console so a schema drift is visible.
    if (nzchar(input$address) && require_cols(p, "Property_Address", "RollEntry snapshot")) {
      p <- p[grepl(toupper(input$address), toupper(p$Property_Address), fixed = TRUE), ]
    }
    if (nzchar(input$muni) && require_cols(p, "Muni_Name_With_Typ", "RollEntry snapshot")) {
      p <- p[!is.na(p$Muni_Name_With_Typ) & p$Muni_Name_With_Typ == input$muni, ]
    }
    if (nzchar(input$roll) && require_cols(p, "Roll_No_Txt", "RollEntry snapshot")) {
      p <- p[grepl(toupper(input$roll), toupper(p$Roll_No_Txt), fixed = TRUE), ]
    }
    if (nrow(p) == 0) return(p)

    # Top-1 area-weighted zoning + dev-plan via sf::st_intersection. This
    # mirrors the offline mao-assembly pipeline's get_multiple_by_area()
    # but kept to top-1 since the Shiny app is for point lookups, not
    # bulk export.
    p$Zoning <- NA_character_
    p$ZoningCategory <- NA_character_
    p$ZoningBylaw <- NA_character_
    p$DevPlan <- NA_character_
    p$DevPlanCategory <- NA_character_
    p$DevPlanBylaw <- NA_character_

    z_cols <- c("ZONE", "ZONE_CATEGORY", "ZBL")
    if (!is.null(d$zoning) && nrow(p) > 0 && require_cols(d$zoning, z_cols, "Zoning snapshot")) {
      p <- enrich_top1(p, d$zoning, cols = z_cols,
                      out = c("Zoning", "ZoningCategory", "ZoningBylaw"))
    }
    dp_cols <- c("DES_NAME", "DES_CATEGORY", "DP_BYLAW")
    if (!is.null(d$devplan) && nrow(p) > 0 && require_cols(d$devplan, dp_cols, "Dev Plan snapshot")) {
      p <- enrich_top1(p, d$devplan, cols = dp_cols,
                      out = c("DevPlan", "DevPlanCategory", "DevPlanBylaw"))
    }
    p
  })

  output$count <- renderText({
    r <- results()
    if (is.null(r)) return("Enter at least one search field, then Search.")
    sprintf("%d parcels found", nrow(r))
  })

  output$map <- renderLeaflet({
    r <- results()
    base <- leaflet() |> addProviderTiles("CartoDB.Positron")
    if (is.null(r) || nrow(r) == 0) {
      return(base |> setView(lng = -97.6, lat = 51.0, zoom = 5))
    }
    r4326 <- if (st_crs(r) != st_crs(4326)) st_transform(r, 4326) else r
    labels <- sprintf(
      "<b>Roll #</b> %s<br>%s<br><i>%s</i><br>Zoning: %s<br>DevPlan: %s",
      r4326$Roll_No_Txt, ifelse(is.na(r4326$Property_Address), "", r4326$Property_Address),
      ifelse(is.na(r4326$Muni_Name_With_Typ), "", r4326$Muni_Name_With_Typ),
      ifelse(is.na(r4326$Zoning), "—", r4326$Zoning),
      ifelse(is.na(r4326$DevPlan), "—", r4326$DevPlan)
    )
    base |>
      addPolygons(
        data        = r4326,
        fillColor   = "firebrick",
        fillOpacity = 0.4,
        weight      = 2,
        color       = "#690000",
        label       = lapply(labels, htmltools::HTML),
        highlightOptions = highlightOptions(weight = 4, color = "navy", fillOpacity = 0.6, bringToFront = TRUE)
      )
  })

  output$table <- renderDT({
    r <- results()
    if (is.null(r) || nrow(r) == 0) return(NULL)
    rd <- st_drop_geometry(r)
    show_cols <- c("Roll_No_Txt", "Property_Address", "Muni_Name_With_Typ",
                   "Zoning", "ZoningBylaw",
                   "DevPlan", "DevPlanBylaw",
                   "Total_Value", "Asmt_Rpt_Url")
    show_cols <- intersect(show_cols, names(rd))
    display <- rd[, show_cols, drop = FALSE]
    names(display) <- gsub("_", " ", names(display))
    datatable(display, options = list(pageLength = 25, scrollX = TRUE), rownames = FALSE)
  })
}

# Helper: top-1 area-weighted spatial join. For each parcel, find the
# overlay polygon with the largest intersection area, copy `cols` to `out`.
# Both inputs must share a CRS; we transform to UTM 14N (EPSG:26914) for
# accurate Manitoba-scale areas, mirroring the mao-assembly choice.
enrich_top1 <- function(parcels, overlays, cols, out) {
  parcels_utm  <- if (st_crs(parcels)  != st_crs(26914)) st_transform(parcels,  26914) else parcels
  overlays_utm <- if (st_crs(overlays) != st_crs(26914)) st_transform(overlays, 26914) else overlays
  inter <- tryCatch(
    suppressWarnings(st_intersection(
      parcels_utm |> mutate(.parcel_id = row_number()),
      overlays_utm
    )),
    error = function(e) {
      warning("st_intersection failed: ", conditionMessage(e))
      return(NULL)
    }
  )
  if (is.null(inter) || nrow(inter) == 0) return(parcels)
  inter$.area <- as.numeric(st_area(inter))
  top <- inter |>
    st_drop_geometry() |>
    group_by(.parcel_id) |>
    slice_max(.area, n = 1, with_ties = FALSE) |>
    ungroup() |>
    select(.parcel_id, all_of(cols))
  for (i in seq_along(cols)) {
    parcels[[out[i]]][match(top$.parcel_id, seq_len(nrow(parcels)))] <- top[[cols[i]]]
  }
  parcels
}

shinyApp(ui, server)
