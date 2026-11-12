# Narration updates needed (as of 2026-11-12)

The videos were recorded 2026-10-10 (mb-01 to mb-06, wpg-01 to wpg-05) and 2026-10-13 (mb-07 to
mb-12). This lists what the apps have gained or changed since, video by video, so the shot lists
can be edited before the next re-record. Line numbers are the `say` steps in each shot list, in
order. Only mb-05 has been changed in the shot lists so far.

Three kinds of entry:

- **Wrong** — the narration now says something the app no longer does. Fix before re-recording.
- **Missing** — a feature added since that the video's subject covers but the narration does not.
- **Picture** — the words still hold, but the screen looks different, so the old video is dated.

Source: the commit history of this repo and of `WpgOpenData/ParcelSearch` since 2026-10-10, read
against the shot lists. Check each item on the live site before recording; the Winnipeg items are
from commit subjects only.

## Priority

1. **mb-05 Report outputs** — shot list updated 2026-11-12; needs re-recording.
2. **mb-10 / mb-11 Sales Charts** — a fifth page, a renamed page, and the Comparables map and table.
3. **mb-06 line 13** — names a button that has been renamed and moved.
4. **mb-01 / mb-03** — Dimensions wording, the address row, three new layers.
5. The rest are small.

## Manitoba

### mb-01 Search basics

| Line | Kind | Change |
|---|---|---|
| 05 | Wrong | "With a single parcel found, the map is zoomed in close" as the condition for Dimensions. Dimensions now show once a whole quarter section is on screen (sides of about 2,000 ft from zoom 13, every side from zoom 16). Also new: a side that agrees with the roll's stated frontage within 1 ft shows the roll figure, marked "(roll)"; lengths of 100 ft and up are whole feet. |
| 09, 11 | Missing | The Street box now suggests the municipality's streets after two letters (arrows and Enter take one and search). A picked street matches exactly, not as a substring. Direction is a "Dir" dropdown on the address row, no longer under Additional Searches. Ordinals match both ways (FIRST and 1ST). |
| 10 | Missing | Hovering a result parcel now gives a popup that holds still so its links can be clicked: Copy Roll, GPS, Jump to parcel in list. The line says to click for these. |
| 08 | Picture | Sidebar buttons have icons; the build's commit and time show under the page title; the top bar has Postal Code Lookup and Route Optimizer links. |

### mb-02 Legal, title and lists

| Line | Kind | Change |
|---|---|---|
| 07, 08 | Picture | Parcel numbers now sit inside a parcel that is big enough on screen, above the roll number, with no leader line. Small parcels keep the callout. |
| 01 | Picture | Street direction has left Additional Searches (see mb-01). Street Type is still there. |

### mb-03 Map layers

| Line | Kind | Change |
|---|---|---|
| 02 | Wrong | "Dimensions adds survey lengths once you are zoomed in close" — same change as mb-01 line 05. |
| 02 | Missing | Two new Parcel layers: **MLS Areas** (the real-estate boards' area boundaries with their codes; click for code and board) and **Unit Labels** (townhouse and condo unit letters and house numbers from Esri Canada Community Maps, at street-level zoom). |
| 03 | Missing | **CentrePort SPA** overlay in Planning (dashed violet outline). CentrePort zoning now reads "M.R. 48/2016 (CentrePort SPA)" instead of a Rosser by-law. |
| 08 | Wrong | "plus new multi-family" — the New Multi-Family layer now draws new buildings only (the outlined existing inventory is gone), and the hover gives the year built and units before and after. |

### mb-04 Map tools and history

No narration change needed. Line 04 already says square feet.

### mb-05 Report outputs

> **Done 2026-11-12** in `shotlists/mb-05-report-outputs.json` (narration rewritten, four steps added
> for the multi-roll subject, Parcel Pack and Aerial Pack). Not re-recorded: the step timings and the
> "Brandon map" pick in the overall-map step are untested. The table below is kept as the record of
> what changed.

| Line | Kind | Change |
|---|---|---|
| 01 | Wrong | "...the Addenda Pack and parcel snapshots." There are now three packs in this spot: Addenda Pack, **Parcel Pack** and **Aerial Pack** (the renamed Parcel Snapshots). The video never showed snapshots, despite the line. |
| 03 | Missing | Capture Map downloads are now named with the municipality and the roll numbers (`HANOVER-RM-106425-map-…`). |
| 05 | Wrong | "switch to the Winnipeg base for city subjects". The base-map list now also offers the highway map's city page for 13 cities and towns (Brandon, Steinbach, Thompson, Dauphin, Flin Flon, Morden, Neepawa, Niverville, Portage la Prairie, Selkirk, Stonewall, The Pas, Winkler), the provincial RM map, and the community plan where the subject is on one. |
| 06 | Wrong | The list of what the pack holds. It is now: the Manitoba location map; a city map, RM municipal map and community plan where they apply; a neighbourhood map (municipality named, highways, **no section grid**); **two aerials** (wide and close-up, neither with dimensions); a **site map** with assessment parcels and dimensions; the zoning map; and a results map only when the parcels are spread out. "A subject aerial with dimensions" is no longer true. |
| 06 | Missing | Zoning map: the label names the municipality, by-law and effective date; the frame is tighter for small lots; the subject's zones are boxed in the legend; a source line gives the layer's update date. |
| 07 | Wrong | "That is the report set for a single subject." Two to ten result parcels are now treated as one subject (a farm on several rolls): the location maps draw an arrow to each cluster and the other maps frame the main cluster. |
| new | Missing | **Parcel Pack (ZIP)** needs its own step: three maps per result parcel (site map, site map with dimensions, close-up aerial), each with only that parcel highlighted; with several parcels a list opens first where a small parcel can be put on another parcel's maps; up to 40 parcels; a second click cancels. |
| new | Missing | **Aerial Pack (ZIP)** could be shown here instead of in mb-06, now that it sits in the same row. |

### mb-06 Agricultural layers

| Line | Kind | Change |
|---|---|---|
| 13 | Wrong | "Parcel Snapshots makes a satellite J P G of every parcel". The button is now **Aerial Pack (ZIP)** and has moved from the export row to under the Addenda Pack. The shot's hover target `#snapshot-zip-btn` still exists, but it is in a different place, so the scroll may need changing. Consider adding a sentence on Parcel Pack for a farm on several rolls. |
| 02 | Picture | Dimensions and parcel numbers on a quarter section look different (see mb-01, mb-02). |

### mb-07 Pasting sales from MAO

| Line | Kind | Change |
|---|---|---|
| 06 | Missing | When the parcel lookup for a municipality fails, the status line now says so ("parcel lookup failed … search again") instead of showing every roll at an approximate location. Only worth a clause. |
| 07 | Wrong | "the additional filters" are described as something applied after loading. Additional filters now sit directly under the Upload / Paste line and can be set before any sales are loaded. |

### mb-07b Filters and subject

| Line | Kind | Change |
|---|---|---|
| 04 | Picture | Additional filters has moved up under the Upload / Paste line. Street name there now has the street typeahead. The zoning pickers are greyed with a note until sales are loaded. |

### mb-08 Sales database

| Line | Kind | Change |
|---|---|---|
| 03 | Wrong (minor) | The folder path is still right, but picking `AppMarketData` itself, `AppMarketData-Limited`, or a folder holding the tier shares now works too; the app steps down to `SalesData`. Worth saying, since staff on the limited tier see a different folder name. |
| 07 | Missing | A Sale Price range now narrows the database search itself, the way the date range does. |

### mb-09 Sales grid and comparables

| Line | Kind | Change |
|---|---|---|
| 08 | Missing | The Charts window now has a **Comparables map** (subject pin, comps as labelled pins coloured by property type, up to four maps) and a **comp table with comments** beside it (Copy for Excel, CSV, in the work file). This is where the stars chosen in this video end up, so the hand-off line should mention it. |
| — | Missing | Route planning has grown (real road times up to 50 stops, a printable checklist) and there is a separate Route Optimizer page. No video covers routing; decide whether one should. |

### mb-10 Sales Charts: layout and settings

| Line | Kind | Change |
|---|---|---|
| 03 | Wrong | "Trend basis uses the fitted trend from the sales themselves, or a rate per year you type." The default is now a percent per year fitted on log price, shown with its 95% range, and it is not applied when the range spans zero. The dollar basis remains as an option. |
| 07 | Wrong | "Four pages: Land Price per Unit, Agricultural, Total and Per Lot Price, and Water." There are five: **ADF Overview**, **CMS Charts** (the renamed Land Price per Unit), Agricultural, Total and Per Lot Price, and Water. |
| new | Missing | The **Sales switch** (All / Bare land / Improved) on ADF Overview and CMS Charts, with the line under the status that warns when the near market mixes the two. |

### mb-11 Sales Charts: the chart pages

| Line | Kind | Change |
|---|---|---|
| 01 | Wrong | "This video walks the four chart pages. Land Price per Unit first. The maps row has Price and Lot Size, Year and Zoning, and Water Influence." Five pages; the page is now CMS Charts; its first map tab is the new Comparables map. |
| new | Missing | **ADF Overview** needs a step: the near market (every loaded sale less unticked municipalities, nominal and far-flung sales), with Isovalue, Location effect and Uncertainty maps, and Sales by year, Distributions and Sale/Assessment tabs. |
| 02 | Wrong | "The fitted trend line and its rate per year are printed on the chart" — now a percent per year with its range (see mb-10 line 03). |

### mb-12 Comparables and work file

| Line | Kind | Change |
|---|---|---|
| 04 | Missing | The Comparables map and the comp table with comments (see mb-09). The table's title and comments are saved in the job file. |
| 07 | Missing | The work file now also holds the Comparables maps and the comp table. |

## Winnipeg

From commit subjects in `WpgOpenData/ParcelSearch`; not checked against the running app.

| Video | Line | Kind | Change |
|---|---|---|---|
| wpg-01 | 04 | Missing | Hover popups now linger and hold still so their links can be clicked. Map click popups gained Construction / Occupancy permit links. |
| wpg-01 | — | Missing | A Permits dialog on the parcel card (PPD portal and open data), and a Winnipeg Permits link in the top bar. |
| wpg-01 | 02 | Picture | A picked street now matches exactly rather than as a substring. |
| wpg-03 | 06 | Missing | Planning has two new layers: **Public Notices & Rezonings** (points, with a years-back filter and a Show dropdown) and **New Plans** (survey plans registered since the oldest snapshot, filterable by lot count and years). Zoning Changes coverage now starts in 1997. |
| wpg-03 | 07 | Wrong | Reference no longer lists everything it did: **MLS Areas** was added and then moved into Map Layers, and there is a **Multi-Family** overlay. Check the group contents on screen. |
| wpg-03 | 08 | Picture | Four more historical dates were published (2023-11-13, 2025-02-26, 2025-03-14, 2026-07-01). |
| wpg-04 | 05 | Check | The Manitoba pack changed a lot (two aerials, site map, multi-roll subject). The Winnipeg pack got the multi-roll subject and multi-parcel arrows; confirm on screen whether "a subject aerial … with dimensions" is still what it produces. There is no Parcel Pack or Aerial Pack in the Winnipeg app. |
| wpg-05 | 01 | Wrong (minor) | Same folder change as mb-08: picking `AppMarketData` or the limited-tier folder now works. |
| wpg-05 | 05 | Picture | Additional filters moved up under the import line. |
| wpg-05 | 06 | Wrong | "Charts opens the Winnipeg charts page. Land shows … Buildings shows …" The charts page gained ADF Overview and CMS pages with isovalue and location maps, a subject property, PNG downloads and trend ranges. |

## Not in any video

Decide whether these want a line somewhere or a short video of their own:

- Route Optimizer page (paste stops, optimise the driving order, print a map and checklist).
- Zoning by-law effective dates (68 by-laws) shown with the by-law.
- Unit Labels and MLS Areas, if mb-03 is not re-recorded.
