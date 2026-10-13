# Video scripts

Rebuilt from `shotlists/*.json` by `python make_scripts.py`. Narration is read exactly as written; the italic line under each step is what happens on screen.

## mb-01-search-basics (Manitoba, recorded)

_Before recording: wait for it_

**0.** This is Manitoba Parcel Search. It covers every assessed parcel outside Winnipeg, with the map on the right and the search panel on the left. Everything it shows is built from open data: the assessment roll, the parcel fabric and zoning published by the Government of Manitoba and the municipalities. In this video we find a property, open its assessment report, turn on the main map layers, and export the result.
<br>_[cursor rests]_

**1.** Most searches start with a municipality. Pick it from the list, or type a few letters to jump to it. The map flies to the municipality and outlines it.
<br>_[pick "BRANDON (CITY)" in #municipality]_

**2.** If you already know the roll number, type it here. Press Enter or a comma to add it as a chip. Several rolls can be stacked in one search, which is the everyday case for a farm with six quarters or a portfolio, and the next video shows that in detail.
<br>_[click .chip-input[data-target="roll"] .chip-input-text; type "510875"; press Enter]_

**3.** Press Search. The parcel is highlighted on the map and listed in the results table below.
<br>_[click #search; wait for it]_

**4.** With a single parcel found, the map is zoomed in close. Turn on Dimensions in the Parcel Layers group and the lot lengths are drawn along each side. They are measured from the survey parcel, which may not line up exactly with the assessment parcel, so treat them as approximate and verify against the plan.
<br>_[click #dims-toggle]_

**5.** Zoning shades every parcel by its zone and builds a legend. Hover a parcel for the zone code, and the Zoning and Zoning Type columns appear in the table.
<br>_[click #zoning-toggle; click #dims-toggle; click #zoning-toggle]_

**6.** The roll number in the table is a hyperlink to that parcel's report on Manitoba Assessment Online. Here is the pro tip: log in to M A O in another browser tab first. The link then opens straight into the logged-in site, with the full report and sales history, instead of the public page.
<br>_[hover #results tbody tr td a; hover #results tbody tr td a]_

**7.** Expand the Reference group for the province-wide layers. Environmental Sites marks the sites the province tracks for environmental impact. Traffic Counts adds the provincial count stations. And the Section Township grid draws the survey grid, clicking again for quarters.
<br>_[click details.overlay-group[data-group=reference] summary; click #contam-toggle; click #stations-toggle; click #grid-toggle; click #grid-toggle; click #contam-toggle; click #stations-toggle; click #grid-toggle; click details.overlay-group[data-group=reference] summary]_

**8.** Clear the roll and search by civic address instead. One number is a contains match, so 1511 finds the range 1511 to 1519 26th Street.
<br>_[click #clear-roll-address; type "1511" in #address-from; type "26TH" in #address-street; press Enter; wait for it]_

**9.** Click a parcel on the map for a quick popup. From here you can copy the roll number, copy the GPS coordinates, or jump to the row in the list.
<br>_[click .maplibregl-canvas]_

**10.** Search a whole street with no number to see every parcel on it. The count line reports how many were found, and the table pages through them.
<br>_[click .maplibregl-popup-close-button; clear #address-from; click #search]_

**11.** Column presets switch the table to the columns you need. Sales analysis, Commercial, Land, Zoning check, Agricultural, Residential, or the full detail. The gear lets you build your own set.
<br>_[pick "Zoning check" in #columns-preset; click #columns-gear; press Escape]_

**12.** Click any column header to sort. Untick a row to drop it from the map and the export without re-running the search.
<br>_[click #results th[data-col=address]; click #results tbody tr:nth-child(2) input[type=checkbox]]_

**13.** Export CSV writes the current table, with a provenance note on top, so the data source and date travel with the file. That is the basic search loop. The next video covers legal descriptions, titles and imported lists.
<br>_[hover #export]_

## mb-02-legal-title-lists (Manitoba, recorded)

_Before recording: wait for it_

**0.** Beyond roll numbers and addresses, Manitoba Parcel Search understands legal descriptions, certificate of title numbers, and pasted lists. Open Additional Searches to see the extra fields.
<br>_[click details.advanced-filters summary]_

**1.** Section, township and range have their own row, so a quarter like the north-east of 27, 7, 4 east can be typed directly. A certificate of title number goes in the title box, and lot, block and plan have their own fields. The legal description box is a free-text contains match for anything else, like a parcel letter or a river lot. Any of these searches the legal index, so they take a little longer than a roll search.
<br>_[hover #str-quarter; hover #title; hover #lot; hover #legal-text]_

**2.** Condominiums are searched by condo plan and unit. In the R M of Montcalm, unit 1 on plan 38239 returns the unit, not the whole building.
<br>_[pick "MONTCALM (RM)" in #municipality; open Additional Searches; type "38239" in #condo-plan; type "1" in #condo-unit; press Enter; wait for it]_

**3.** When you have a list of parcels from a client or a spreadsheet, use Import list. Paste rolls with their municipality, title numbers, or even a bare quarter section, one per line.
<br>_[click #clear; open Additional Searches; click #parcel-list-import-trigger; wait for it; type "313960, RM OF SPRINGFIELD
505, CITY OF STEINBACH
254210, ROCKWOOD
NE27-7-4E" in #parcel-list-import-text]_

**4.** Next lets you confirm which column is which. Resolve looks every line up and runs the search in one go. The quarter section line resolves through the legal index, so give it a moment.
<br>_[click #parcel-list-import-next; click #parcel-list-import-resolve; wait for it]_

**5.** The imported list pill shows how many parcels resolved, and anything that did not match is listed in the unmatched drawer with a download. Clear the pill to leave list mode.
<br>_[hover #parcel-list-pill]_

**6.** With more than one parcel, the Numbering pill labels them on the map. By muni numbers them in roll order within each municipality. Entry order keeps the order you typed, which is what you want when the list matches a report.
<br>_[click [data-pill=numbering] [data-mode=muni]]_

**7.** Multiple rolls is the everyday case: a farm with several quarters, or a client's portfolio. Type them straight into the roll box, separated by a comma, a space or an ampersand, or paste the whole list from a spreadsheet. Each becomes a chip, one search returns all of them, and numbering labels them on the map in the order you entered.
<br>_[click #clear; pick "BRANDON (CITY)" in #municipality; click .chip-input[data-target="roll"] .chip-input-text; type "510875, 525063"; press Enter; click #search; wait for it; click [data-pill=numbering] [data-mode=entry]]_

**8.** That is every way to get parcels into the tool. Next, the map layers.
<br>_[cursor rests]_

## mb-03-map-layers (Manitoba, recorded)

_Before recording: wait for it; pick "STEINBACH (CITY)" in #municipality; type "30" in #address-from; page script; type "FIRST" in #address-street; press Enter; wait for it; click #zoning-toggle; wait for it; click #zoning-toggle; click #clear-roll-address; pick "BRANDON (CITY)" in #municipality; click .chip-input[data-target="roll"] .chip-input-text; type "510875"; press Enter; click #search; wait for it_

**0.** The Map Layers panel sits under the search fields. Groups collapse, and a badge on a collapsed group shows how many of its layers are on. Each button lights up when its layer is active.
<br>_[hover #map-layers-section]_

**1.** Assessment Parcels draws every parcel in the municipality, not just the result. Dimensions adds survey lengths once you are zoomed in close.
<br>_[click #muni-parcels-toggle; click #dims-toggle]_

**2.** Zoning shades the parcels by zone and builds a legend. Development Plan adds the dev plan designation and its columns to the table. Both, like every layer here, come from open data: the Government of Manitoba's land use and development services and the municipalities' published by-laws.
<br>_[click #zoning-toggle; click #devplan-toggle]_

**3.** The changes pill works best on a bigger set. Switch to Steinbach and search 30 to 100 First Street: nineteen parcels come back. Untick a few rows and the map re-centres on the parcels that are still ticked, so culling one end of a street brings the rest back into view.
<br>_[click #clear-roll-address; pick "STEINBACH (CITY)" in #municipality; type "30" in #address-from; page script; type "FIRST" in #address-street; press Enter; wait for it; click #results tbody tr:has-text('21800') input.row-select; click #results tbody tr:has-text('21900') input.row-select; click #results tbody tr:has-text('22000') input.row-select; click #results tbody tr:has-text('22100') input.row-select]_

**4.** Turn zoning on. The Zoning and Dev Plan Changes pill finds the parcels whose zoning has changed since the previous publication. Click Show if you only want to see the sites with a zoning change: two parcels on this street were rezoned from R L D to R M D, and they are outlined on the map. Hover or click either one and the popup carries the same amber change badge as the table. Filter reduces the result set to just those two, and Off puts the full set back.
<br>_[click #zoning-toggle; wait for it; click .changes-mode-pill .changes-mode-btn[data-mode=show]; hover #results tbody tr:has-text('24300') .badge-amend; click .changes-mode-pill .changes-mode-btn[data-mode=filter]; click .changes-mode-pill .changes-mode-btn[data-mode=off]; click #zoning-toggle; click #devplan-toggle; click #dims-toggle]_

**5.** Reference holds environmental sites, traffic count stations, Manitoba Highways and the traffic flow layer with an annual average daily traffic legend. The section and township grid cycles from sections to quarters.
<br>_[click details.overlay-group[data-group=reference] summary; click #highways-toggle; click #flow-toggle; click #grid-toggle; click #flow-toggle; click #highways-toggle; click #grid-toggle; click #grid-toggle; click details.overlay-group[data-group=reference] summary]_

**6.** Water Influence classes parcels as waterfront, near water, or neither, and the Water Proximity pill filters the search on that class. The Agricultural group has its own video.
<br>_[click details.overlay-group[data-group=water] summary; click #water-toggle; hover [data-pill=water] [data-mode=waterfront]; click #water-toggle; click details.overlay-group[data-group=water] summary]_

**7.** Multi-Family maps the multi-family inventory above a chosen dwelling-unit count, plus new multi-family and new condo developments.
<br>_[click details.overlay-group[data-group=multifamily] summary; click #mfinv-toggle; click #mfinv-toggle; click details.overlay-group[data-group=multifamily] summary]_

**8.** Flood brings in the designated flood areas, the special management area, the 1 in 200 year flood extent, historical flood extents and the Winnipeg waterway corridors.
<br>_[click details.overlay-group[data-group=flood] summary; click #flood-dfa-toggle; click #flood-f200-toggle; click #flood-dfa-toggle; click #flood-f200-toggle; click details.overlay-group[data-group=flood] summary]_

**9.** Every layer you turn on is written into the page address, so you can bookmark a view or paste the link to a colleague and they see the same layers.
<br>_[cursor rests]_

## mb-04-map-tools-history (Manitoba, recorded)

_Before recording: wait for it_

**0.** This video covers the map tools: place search, basemaps, measuring, the historical as-of view, and the data status page.
<br>_[cursor rests]_

**1.** The box at the top left of the map finds towns and municipalities by name. Pick one and the map flies there, drops a pin, and sets the municipality for you.
<br>_[click input[placeholder^='Find a town']; type "Souris"; press ArrowDown; press Enter]_

**2.** The basemap menu switches between streets, satellite imagery, N R Can transportation and elevation, and Esri Wayback historical imagery with a date picker.
<br>_[hover .basemap-menu-trigger; click .basemap-menu-item[data-key=satellite]]_

**3.** Measure gives distance and area. Click points on the map and double-click to finish. The readout shows metres and feet, or hectares, square feet and acres.
<br>_[click .measure-control button; click .measure-modes button[data-mode=area]; click on map; click on map; click on map; double-click on map; click .measure-done]_

**4.** Back on streets. Search a Brandon parcel that was subdivided last year, roll 562264 on Braecrest Drive.
<br>_[hover .basemap-menu-trigger; click .basemap-menu-item[data-key=streets]; pick "BRANDON (CITY)" in #municipality; click .chip-input[data-target="roll"] .chip-input-text; type "562264"; press Enter; click #search; wait for it]_

**5.** Open the Historical group, pick an as-of date, and press Show. The parcel's earlier boundary is drawn in dashed amber over today's, so you can see the land before the subdivision.
<br>_[click details.overlay-group[data-group=historical] summary; pick latest as-of date; click #historical-toggle]_

**6.** The sub-layers add the whole historical parcel fabric, coloured by how much each parcel changed, plus the zoning and development plan as they stood on that date.
<br>_[click #historical-layer-parcels; click #historical-layer-parcels]_

**7.** Prior outlines is the other way round. It shows earlier shapes of any parcel in the result municipality that was reshaped or retired since early 2025, from weekly snapshots of the provincial layer.
<br>_[click #historical-toggle; click #prior-outlines-toggle; click #prior-outlines-toggle; click details.overlay-group[data-group=historical] summary]_

**8.** Property Data Status reports when each municipality's assessment roll was last refreshed, when the site data was published, and whether the live map services are responding. Check it when a number looks stale.
<br>_[click #data-status-open; wait for it; type "Brandon" in #data-status-muni-search; click #data-status-close]_

**9.** Data Sources, at the top right, lists every source behind the tool with its refresh date, and links to the full methods page.
<br>_[click #data-sources-details summary; click #data-sources-details summary]_

## mb-05-report-outputs (Manitoba, recorded)

_Before recording: wait for it; pick "BRANDON (CITY)" in #municipality; click .chip-input[data-target="roll"] .chip-input-text; type "510875"; press Enter; click #search; wait for it_

**0.** Once a subject is found, the buttons at the bottom of the panel produce the images and files that go into a report. This video shows Capture Map, the overall location map, the Addenda Pack and parcel snapshots.
<br>_[hover #static-map-btn]_

**1.** Capture Map renders the current view at 1950 by 1050 pixels, which is six and a half by three and a half inches at 300 d p i, the size of a report figure. Turn on zoning first and the legend can be included.
<br>_[click #zoning-toggle; click #static-map-btn; wait for it]_

**2.** Tick Include legend and the scale bar and north arrow. Copy image puts it on the clipboard for pasting straight into Word. Download P N G or J P G saves a file.
<br>_[click #map-capture-legend; click #map-capture-furniture; hover #map-capture-copy; press Escape]_

**3.** Alt C is the shortcut. It copies the current map view to the clipboard with no dialog at all.
<br>_[click #zoning-toggle; press Alt+c]_

**4.** M B Overall Map draws the province location map with a subject callout. Change the callout text, move the arrow to any side, and switch to the Winnipeg base for city subjects. Copy or download the image.
<br>_[click #location-map-btn; wait for it; hover #location-map-output; press Escape]_

**5.** Addenda Pack builds the whole set in one click. A location map, a neighbourhood map framed on the municipality with the section grid and highways, a subject aerial with dimensions, a zoning map, and an all-results map when there are several parcels.
<br>_[click #addenda-pack-btn]_

**6.** The button reports progress as each map renders. The map view is restored when it finishes, and the zip downloads with a readme listing what is inside. That is the report set for a single subject.
<br>_[hover #addenda-pack-btn]_

## mb-06-agricultural-layers (Manitoba, recorded)

_Before recording: wait for it_

**0.** This video is about farmland. Manitoba Parcel Search carries the agricultural data an appraiser reaches for on a rural file: MASC productivity ratings, soil class, land cover, crop history, tile drainage and irrigation. Start by picking a rural municipality, here the R M of Springfield.
<br>_[pick "SPRINGFIELD (RM)" in #municipality]_

**1.** Search a quarter section the way it reads on the title. Open Additional Searches, type the quarter, section, township and range, and press Enter. Every roll on that quarter is returned.
<br>_[click details.advanced-filters summary; pick "NW" in #str-quarter; type "20" in #str-section; type "11" in #str-township; type "6E" in #str-range; press Enter; wait for it]_

**2.** Switch the columns to the Agricultural preset. The table now shows the roll's stated size, land cover, the cultivated share, crop history, water influence, soil productivity class, soil type, slope, MASC risk area, tile drainage and irrigation, alongside zoning and the legal description.
<br>_[pick "Agricultural" in #columns-preset; scroll the table sideways]_

**3.** Now the map. Open the Agricultural group. MASC Risk Areas draws the crop insurance risk areas, and MASC Rating colours every parcel in the municipality by its soil productivity rating from the Manitoba Agricultural Services Corporation, the rating that drives crop insurance coverage.
<br>_[click details.overlay-group[data-group=agricultural] summary; click #riskarea-toggle; click #riskarea-toggle; click #masc-toggle]_

**4.** Click any parcel on the map and the popup carries its MASC rating and risk area, so you can read the rating of a neighbour without searching for it.
<br>_[click .maplibregl-canvas; click .maplibregl-popup-close-button]_

**5.** Soil Productivity shows the Canada Land Inventory class for agriculture, from class 1 down to class 7. Click it again and the layer switches to soil name, from the provincial soil survey.
<br>_[click #masc-toggle; click #cli-toggle; click #cli-toggle; click #cli-toggle]_

**6.** Land Cover is the federal land cover map. The first view shows the dominant cover on each parcel: cropland, grassland, forest, wetland or water. The second view shows the detailed classes.
<br>_[click #landcover-toggle; click #landcover-toggle; click #landcover-toggle]_

**7.** Crop History is built from seventeen years of the annual satellite crop inventory. Years Cropped colours each parcel by how many of those years it was in crop, which separates land that is farmed every year from land that only looks arable. Click again for the land use view, which shows what was there in the latest year.
<br>_[click #landfacts-toggle; click #landfacts-toggle; click #landfacts-toggle]_

**8.** The cultivated share and the years-cropped figure in the table come from the same data, so the numbers you export match the map. A caution: these are satellite classifications, not a cropping record. The figures can be off where land was recently broken, and they may differ from what M A O reports for the parcel. They are often quite close, but use them with caution and verify where you can.
<br>_[hover #results th[data-col=cultpct]; hover #results th[data-col=landfacts]]_

**9.** Tile Drainage shows the registered tile-drained fields. Tile Lines and Outlets adds the drainage network itself once you are zoomed in. Irrigation Licences marks each licensed point of use, where water is actually applied.
<br>_[click #tile-toggle; click #irrigation-toggle]_

**10.** The two pills beside them are search filters. Set Tile drainage to On and the search returns only tile-drained parcels. Irrigation On returns only parcels with a licensed point of use. Narrow by municipality first, because an unscoped irrigation search covers about twenty-five hundred points province-wide.
<br>_[hover [data-pill=tile] [data-mode=on]; hover [data-pill=irrigation] [data-mode=on]; click #tile-toggle; click #irrigation-toggle]_

**11.** Water Influence, in the Water group, classes each parcel as waterfront, near water, or neither, which matters for recreational and hobby-farm land as much as for crop land.
<br>_[click details.overlay-group[data-group=agricultural] summary; click details.overlay-group[data-group=water] summary; click #water-toggle; click #water-toggle; click details.overlay-group[data-group=water] summary]_

**12.** For a farm with several parcels, Parcel Snapshots makes a satellite J P G of every parcel in the result, each highlighted and zoomed to fit, and zips them up named by roll. The two parcels on this quarter give two images.
<br>_[hover #snapshot-zip-btn]_

**13.** Every one of these layers is open data from the Government of Manitoba and the Government of Canada, each adds its columns to the table, and Export CSV carries the figures out with the parcel. For sales of farmland, the Sales Charts page has an Agricultural tab that plots price per acre against these same variables.
<br>_[hover #export]_

## mb-07-sales-paste (Manitoba, NOT YET RECORDED)

_Before recording: load page_

**0.** The Sales Analysis tab analyses sales, and there are two ways to get them in. This video shows the one anyone can use: pasting the results of a sales search on Manitoba Assessment Online. The next video covers the firm's sales database.
<br>_[hover #tab-btn-sales]_

**1.** On M A O, run a sales search for the area and sale type you need. Here it is residential bare land in the R M of Springfield. Select the results table, including the header row, and copy it.
<br>_[cursor rests]_

**2.** Back here, open Upload a C S V or Paste Sales from M A O, and click Paste data.
<br>_[open Upload/Paste; click #sales-import-trigger; wait for it]_

**3.** Paste the table into the box. The columns are the ones M A O gives you: sale date, consideration, municipality, roll number, street address, legal description and primary property. Roll number and municipality are the two the tool needs to find each parcel.
<br>_[paste data/paste-springfield.tsv into #sales-import-text]_

**4.** Press Load sales. Each sale is matched to its parcel and plotted. The status line reports how many were placed, any duplicates merged, and any roll not yet on the parcel map, which is shown at an approximate location.
<br>_[click #sales-import-load; wait for it]_

**5.** From here the sales go through exactly the same tools as the database: date presets, assessment class and structure type, vacant or improved, and the additional filters.
<br>_[hover .date-preset-btn[data-months="36"]; hover #vacant-improved; hover details.more-filters summary]_

**6.** Upload sales C S V takes the same columns from a saved file, and Recent brings back earlier pastes and uploads without copying them again.
<br>_[hover #sales-dropzone; hover #recent-uploads-select]_

**7.** The grid, the comp stars, the exclusion reasons and the Charts window all work on pasted sales. The next video shows the firm's sales database, which skips the copying and covers every municipality.
<br>_[hover #charts-open]_

## mb-08-sales-database (Manitoba, NOT YET RECORDED)

_Before recording: load page_

**0.** For firm users, the M A O Sales Database turns the firm's weekly sales export into a searchable database that lives in your browser, covering every municipality at once. This video covers connecting it, searching by municipality, and the first-pass filters.
<br>_[hover #sales-db]_

**1.** Choose export folder once, and point it at the AppMarketData Sales Data Manitoba folder on Dropbox. Every municipality file imports, and the status line shows the count and newest sale date.
<br>_[open MAO Sales Database; click #sales-db-import]_

**2.** The folder stays connected. Reload picks up new weekly files, Disconnect forgets it, and Coverage shows which municipalities are in the export and how current each one is.
<br>_[click #sales-db-coverage; press Escape]_

**3.** Filter the municipality list, tick the ones you want, and the Adjacent regions pill pulls in the neighbours. A date range is required, so pick a preset, here the last 24 months. Set the sale type, here residential bare land, and Search.
<br>_[type "Springfield" in #sales-db-muni-search; click #sales-db-munis input[type=checkbox]:not(:checked); type "Tache" in #sales-db-muni-search; click #sales-db-munis input[type=checkbox]:not(:checked); clear #sales-db-muni-search; click .date-preset-btn[data-months="24"]; pick "RESIDENTIAL BARE LAND" in #sales-db-type; click #sales-db-load]_

**4.** Sales land on the map and in the grid. Nominal sales are excluded by default. Flip the pill to include transfers for a dollar.
<br>_[hover [data-pill=nominal]]_

**5.** Date presets keep the last 12, 24 or 36 months, or type exact dates. Assessment class and structure type narrow by what sold, and the vacant or improved switch separates land sales from improved sales.
<br>_[click .date-preset-btn[data-months="36"]; hover #vacant-improved]_

**6.** Additional filters add plan number, size in acres, square feet or front feet, price per acre, sale price, zoning, parcel count, and the building threshold that decides what counts as vacant.
<br>_[click details.more-filters summary; type "5" in #size-low; type "160" in #size-high]_

**7.** Far-flung flags sales more than a set distance from the cluster. Keep shows them with a flag, Exclude drops them.
<br>_[hover #far-flung-km]_

**8.** Set a subject property to add a distance column and a maximum radius. The charts page uses the subject for distance plots and for naming the work file.
<br>_[type "313960" in #subject-roll; type "25" in #distance-max; click #subject-apply]_

**9.** Province-wide search goes the other way. Pick a class at sale, a date and price range, and search every municipality in the export at once. Saved searches store the criteria.
<br>_[hover #sales-prov]_

**10.** Save job writes the whole state, the loaded sales, the filters, the comps and exclusions, to a file you can reopen later from Recent jobs. The next video covers the grid: stars, comps and exclusion reasons.
<br>_[hover #job-save]_

## mb-09-sales-grid-comps (Manitoba, recorded)

_Before recording: open MAO Sales Database; click #sales-db-import; type "Springfield" in #sales-db-muni-search; click #sales-db-munis input[type=checkbox]:not(:checked); clear #sales-db-muni-search; click .date-preset-btn[data-months="36"]; pick "RESIDENTIAL BARE LAND" in #sales-db-type; click #sales-db-load; pick "vacant" in #vacant-improved_

**0.** With sales loaded, the grid is where the comparables get chosen. This video covers the star column, comp tags, exclusion reasons, and the row colours.
<br>_[hover #results]_

**1.** Click the star on a sale to make it the next comparable. Stars are numbered in the order you click, and the numbers appear on the map.
<br>_[click #results tbody tr:nth-child(1) td.fav-col button.fav-star; click #results tbody tr:nth-child(3) td.fav-col button.fav-star]_

**2.** Right-click a star for the tag menu. A sale can be a numbered comparable, or go into Land Set 1 or Land Set 2 for a two-tier land analysis.
<br>_[page script; press Escape]_

**3.** Untick a row to exclude the sale. A popover asks why. Pick a reason or type one, and it is kept with the sale and printed in the work file.
<br>_[click #results tbody tr:nth-child(2) input[type=checkbox]; type "Non-arm's length"; press Enter]_

**4.** Row colours flag what needs a second look. Orange is an outlier more than two standard deviations from the rest. Green marks parcels that sold together as one multi-parcel sale.
<br>_[hover .sales-row-legend]_

**5.** The draw tools narrow the sales by area. Draw a circle around the subject and only sales inside it stay. Click the shape to switch it to exclude.
<br>_[click #shape-tool-circle; drag on map; clear text selection; click #shape-tool-clear]_

**6.** If an older job has stars that were added before numbering existed, a Number starred button appears and fills in the comp numbers, so the job comes forward cleanly.
<br>_[hover #results th[data-col=favorite]]_

**7.** Export C S V writes the filtered sales with their comp tags and exclusion reasons. Charts opens the analysis page in a new window, which is the next video.
<br>_[hover #charts-open]_

## mb-10-charts-layout (Manitoba, recorded)

_Before recording: open MAO Sales Database; click #sales-db-import; type "Springfield" in #sales-db-muni-search; click #sales-db-munis input[type=checkbox]:not(:checked); clear #sales-db-muni-search; click .date-preset-btn[data-months="36"]; pick "RESIDENTIAL BARE LAND" in #sales-db-type; click #sales-db-load; pick "vacant" in #vacant-improved; open Additional filters; type "313960" in #subject-roll; click #subject-apply; click #charts-open (opens new window)_

**0.** Sales Charts opens from the Charts button on the Sales Analysis tab. It is live: every filter change in the main window updates these charts. The status line reports how many sales arrived and how many are ticked.
<br>_[hover #charts-status]_

**1.** Company signs every chart with your firm name in the caption. Size unit switches between acres, square feet and front feet, and the unit is remembered. If a tab looks empty, the first thing to check is the unit.
<br>_[hover #company; click #unit-sf; click #unit-acres]_

**2.** Rates can be nominal or time-adjusted to the effective date. Trend basis uses the fitted trend from the sales themselves, or a rate per year you type.
<br>_[click #rates-adjusted; hover #adj-basis; click #rates-nominal]_

**3.** Distance from chooses the subject parcel or Portage and Main as the reference for the distance plots. Trim to percentiles drops the extremes from the fits without excluding the sales.
<br>_[hover #dist-ref; click #trim-on; click #trim-on]_

**4.** Freeze stops live updates while you read or capture. Table view shows the numbers behind the charts. Show excluded brings unticked sales back as hollow points.
<br>_[click #show-table; click #show-table; click #show-excluded; click #show-excluded]_

**5.** The filter waterfall explains the count. Sales loaded, then after the Sales Analysis filters, then unticked in the grid, then the agricultural consistency filters, so you can always say why a sale is not on the chart.
<br>_[hover #waterfall-panel]_

**6.** Four pages: Land Price per Unit, Agricultural, Total and Per Lot Price, and Water. Each has a row of maps and a row of charts. Every card has a P N G button that renders it at report size.
<br>_[click #tab-ag; click #tab-total; click #tab-water; click #tab-rates]_

## mb-11-charts-pages (Manitoba, recorded)

_Before recording: open MAO Sales Database; click #sales-db-import; type "Springfield" in #sales-db-muni-search; click #sales-db-munis input[type=checkbox]:not(:checked); clear #sales-db-muni-search; click .date-preset-btn[data-months="36"]; pick "RESIDENTIAL BARE LAND" in #sales-db-type; click #sales-db-load; pick "vacant" in #vacant-improved; open Additional filters; type "313960" in #subject-roll; click #subject-apply; click #charts-open (opens new window)_

**0.** This video walks the four chart pages. Land Price per Unit first. The maps row has Price and Lot Size, Year and Zoning, and Water Influence. Each dot is one sale, sized or coloured by the variable.
<br>_[click #tab-rates; click .page-maps .row-tabs button:nth-child(2); click .page-maps .row-tabs button:nth-child(3); click .page-maps .row-tabs button:nth-child(1)]_

**1.** The charts row plots the rate over time and against size, then by zoning and by distance from the subject. The fitted trend line and its rate per year are printed on the chart.
<br>_[click .page-charts .row-tabs button:nth-child(2); click .page-charts .row-tabs button:nth-child(1)]_

**2.** Agricultural adds the farm variables: M A S C rating, cultivated share, soil, Canada Land Inventory class, and land cover mix, each against the price per acre, plus sale to assessment ratios.
<br>_[click #tab-ag; click .page-charts .row-tabs button:nth-child(2); click .page-charts .row-tabs button:nth-child(4)]_

**3.** The Ag consistency filters keep only sales that are like the subject: a cultivated band, and M A S C, C L I and cover chips. They apply to this page only and show up as a step in the waterfall.
<br>_[hover section.ag-cons]_

**4.** Total and Per Lot Price is for lot sales and small holdings, where the whole price matters more than the rate. Total price, per lot, and per lot by distance and assessed value.
<br>_[click #tab-total; click .page-charts .row-tabs button:nth-child(2); click .page-charts .row-tabs button:nth-child(3)]_

**5.** Water looks at the waterfront premium. Influence and class, flood and water body, size and distance, a summary with the premium, and paired sales where a waterfront and a non-waterfront parcel can be matched.
<br>_[click #tab-water; click .page-charts .row-tabs button:nth-child(4); click .page-charts .row-tabs button:nth-child(5)]_

**6.** Municipal boundaries can be drawn on the maps, and every map and chart has its own P N G button at 1950 by 1050. The next video covers excluding sales from the charts and tagging comparables.
<br>_[click #tab-rates; click #map-munis; click #map-munis]_

## mb-12-charts-comps-workfile (Manitoba, recorded)

_Before recording: open MAO Sales Database; click #sales-db-import; type "Springfield" in #sales-db-muni-search; click #sales-db-munis input[type=checkbox]:not(:checked); clear #sales-db-muni-search; click .date-preset-btn[data-months="36"]; pick "RESIDENTIAL BARE LAND" in #sales-db-type; click #sales-db-load; pick "vacant" in #vacant-improved; open Additional filters; type "313960" in #subject-roll; click #subject-apply; click #charts-open (opens new window)_

**0.** Charts are interactive. Click a dot and that sale is unticked in the grid. It moves to Excluded records with the reason box focused, so you record why as you go.
<br>_[scroll to charts; click a chart dot; click #excl-panel input.excl-reason; type "Outlier"; press Enter]_

**1.** Excluded records lists every unticked sale with its reason. The suggestions cover the usual cases: nominal transfer, non-arm's length, assembly, outlier, not comparable, includes improvements, forced sale. Include again puts a sale back.
<br>_[open Excluded records; hover #excl-panel summary]_

**2.** Shift-click a dot to tag it as the next comparable. The comp number appears on the chart and on the map, and in the grid in the main window.
<br>_[shift-click a chart dot; clear text selection; shift-click a chart dot; clear text selection]_

**3.** Comparable sales is the running list. Reorder with the arrows, remove with the cross, copy the roll numbers for the report, or clear all tags. Land Set 1 and 2 are listed separately.
<br>_[open Comparable sales; hover #comps-panel summary]_

**4.** On the maps, clicking a dot opens a popup with Exclude this sale, Add as Comp, and Add to Land Set 1 or 2, so the same decisions can be made spatially.
<br>_[scroll to maps; hover .page-maps .chart-card .maplibregl-canvas]_

**5.** Work file packages the whole analysis. Choose which charts and tables to include, embed the images in the summary, and download a zip named for the subject roll and date.
<br>_[click #workfile-open; wait for it; click #workfile-embed]_

**6.** Inside are summary dot H T M L, comps dot C S V, the C M S table, excluded dot C S V with reasons, the land set files, every chart as P N G, and every table as C S V. Keep this window in front while it renders or map images can come out blank.
<br>_[hover #workfile-list; press Escape]_

**7.** Back in the main window, Save job stores the sales, filters, comps and exclusions together. Open it later and the charts page picks up exactly where you left off.
<br>_[cursor rests]_

## wpg-01-search-basics (Winnipeg, recorded)

_Before recording: load page_

**0.** This is Winnipeg Parcel Search, the city companion to the Manitoba tool. It uses the City's open data for parcels, assessment, zoning and neighbourhoods. In this video we find a property, read its popup, and export the result.
<br>_[cursor rests]_

**1.** Type a civic number and the street name. The street box suggests matches as you type, so you can pick one from the list or just press Enter to search.
<br>_[type "1347" in #address-from; type "1347" in #address-to; click #address-street; type "BORDER"; press Escape; press Enter; wait for it]_

**2.** With both From and To filled, the search is exact. One number alone is a contains match and would return every address containing it.
<br>_[hover #address-to]_

**3.** Click the parcel on the map for a popup. The click popup has Copy Roll and G P S Coordinates links, and goes straight to the assessment page.
<br>_[click .maplibregl-canvas; press Escape]_

**4.** Roll numbers go in the chip box. Enter or a comma adds a chip, and the search accepts rolls with or without dashes and leading zeros. Here is the same parcel by roll.
<br>_[click #clear; click .chip-input[data-target="roll"] .chip-input-text; type "07560170500"; press Enter; click #search; wait for it]_

**5.** The address box on the map itself is another way in. Type an address, pick it from the list, and the search fields fill and run.
<br>_[click #clear; click #map-address-input; type "400 Hargrave"; press ArrowDown; press Enter]_

**6.** Column presets switch the table between quick lookup, residential, zoning detail, sales, and full detail. The gear builds a custom set. Click a header to sort.
<br>_[pick "Zoning detail" in #columns-preset; click #columns-gear; press Escape]_

**7.** Search a whole street for every parcel on it. Border Street gives a couple of dozen. Untick rows to drop them from the map, the charts and the export without searching again.
<br>_[click #clear; click #address-street; type "BORDER"; press Escape; click #search; wait for it; click #results tbody tr:nth-child(2) input[type=checkbox]]_

**8.** Export C S V writes the table as shown. If rows are unticked, it asks first. The title at the top left is a home button that clears everything.
<br>_[hover #export; hover #topbar-home]_

## wpg-02-more-searches (Winnipeg, recorded)

_Before recording: load page_

**0.** Additional Searches opens the condo, zoning, legal description, dwelling unit and property use fields. A badge on the collapsed header lists any criteria set inside.
<br>_[click details.additional-searches summary]_

**1.** A condominium corporation number returns every unit in the building. Corp 43498.
<br>_[type "43498" in #condo-plan; press Enter; wait for it]_

**2.** Lot, block and plan find subdivisions. Plan 2930 alone returns a couple of hundred parcels, which is a good way to map a whole neighbourhood of one era.
<br>_[click #clear; click details.additional-searches summary; type "2930" in #plan; press Enter; wait for it]_

**3.** The draw tools on the top bar narrow a result set by area. Pick the rectangle, click one corner, then the opposite corner. Only the parcels inside stay in the table, the map and the export.
<br>_[click #shape-tool-rectangle; click on map; click on map]_

**4.** Click the shape to flip it from include to exclude. The clear tool removes shapes, and a new search clears them too.
<br>_[click on map; click #shape-tool-clear]_

**5.** Property use and dwelling units filter by the City's use code and unit count. Zero D U finds vacant land, and Min D U finds multi-family.
<br>_[hover #pucs-filter; pick "min" in #du-mode; type "4" in #du-min; clear #du-min; pick "" in #du-mode]_

**6.** Import list takes a pasted list of addresses or rolls. Look up matches each line, shows you what it matched, and Map parcels runs the search.
<br>_[click #clear; click details.additional-searches summary; click #parcel-list-trigger; wait for it; type "1347 Border St
400 Hargrave St
165 Provencher Blvd
07560170500" in #parcel-list-text; click #parcel-list-next]_

**7.** Review the matches, untick any that are wrong, and map the rest. Because they came from a list, Entry order numbering is available, so the map numbers follow your list.
<br>_[click #parcel-list-confirm; wait for it; click [data-pill=numbering] [data-mode=entry]]_

**8.** For a single result, such as one roll number, the Locator pill switches between the parcel shape and a pin, which reads better on a zoomed-out map.
<br>_[click #clear; click .chip-input[data-target="roll"] .chip-input-text; type "07560170500"; press Enter; click #search; wait for it; click [data-pill=locator] [data-mode=pin]]_

**9.** River lots, Outer Two Mile and section township range parcels have their own conventions. The hint at the foot of the page explains the block and plan codes to use.
<br>_[scroll to hint; click details.hint-page summary]_

## wpg-03-map-layers (Winnipeg, recorded)

_Before recording: click #search; wait for it_

**0.** Winnipeg Parcel Search has two parcel fabrics. Assessment parcels come from the City's assessment roll. Survey parcels are the legal lots. Each has a results layer and an all-parcels layer.
<br>_[click #all-parcels-toggle; click #all-survey-toggle; click #all-survey-toggle]_

**1.** Zoning cycles through three states. Shaded colours every parcel by zone with a legend. Labels prints the zone codes. A third click turns it off.
<br>_[click #zoning-toggle; click #zoning-toggle; click #zoning-toggle]_

**2.** Neighbourhoods also cycles: first the 23 neighbourhood clusters, then the 235 individual neighbourhoods. Click any polygon to see its name and cluster.
<br>_[click #neighbourhoods-toggle; click #neighbourhoods-toggle; click #neighbourhoods-toggle]_

**3.** The basemap menu has the City's aerial photography for 2016, 2018, 2021, 2024 and 2026, plus satellite. Flip between years to see when a building appeared.
<br>_[hover .basemap-menu-trigger; click .basemap-menu-item[data-key=ortho-2026]; hover .basemap-menu-trigger; click .basemap-menu-item[data-key=ortho-2016]; hover .basemap-menu-trigger; click .basemap-menu-item[data-key=streets]]_

**4.** Dimensions shows survey lengths once you are zoomed in past level 17. They are from the survey parcel, so they may not match the assessment parcel exactly.
<br>_[click #dimensions-toggle; click #dimensions-toggle]_

**5.** Planning holds the secondary plans, the infill area, malls and corridors, and the airport vicinity area. The Zoning Changes pill marks parcels with a recent D M I S zoning amendment, and Filter keeps only those.
<br>_[click #planning-group summary; click #secondary-plans-toggle; click #infill-toggle; click #secondary-plans-toggle; click #infill-toggle; click #planning-group summary]_

**6.** Reference adds 24 hour traffic counts, environmentally tracked sites, transit, dwelling units, current street names and water influence.
<br>_[click #reference-group summary; click #traffic-toggle; click #contam-toggle; click #traffic-toggle; click #contam-toggle; click #reference-group summary]_

**7.** Historical overlays an earlier snapshot of the whole city. Pick a date and press Historical. Earlier assessment parcels appear in dashed amber, tinted by how much their size changed, and survey lots in violet.
<br>_[click #historical-group summary; pick latest as-of date; click #historical-toggle; click #historical-toggle; click #historical-group summary]_

**8.** Measure, at the top right of the map, gives distance or area by clicking points and double-clicking to finish.
<br>_[click .measure-control button; click .measure-modes button[data-mode=distance]; click on map; double-click on map; click .measure-done]_

**9.** Data Status reports when the parcel tiles, the historical archive and each live City service were last updated. A banner appears at the top of the page if the tiles fall more than sixty days behind.
<br>_[click #data-status-open; wait for it; click #data-status-close]_

## wpg-04-report-outputs (Winnipeg, recorded)

_Before recording: click #search; wait for it_

**0.** With a subject found, the buttons at the bottom of the panel make the report images. Capture Map, the Winnipeg overall map, the Addenda Pack, and Export C S V.
<br>_[hover #static-map-btn]_

**1.** Capture Map renders the view at 1950 by 1050 pixels, six and a half by three and a half inches at 300 d p i. With zoning shaded, Include legend becomes available. Scale bar and north arrow are optional.
<br>_[click #zoning-toggle; click #static-map-btn; wait for it; click #map-capture-legend; click #map-capture-furniture]_

**2.** Copy image puts it on the clipboard for Word. Download P N G or the smaller J P G saves a file. Alt C copies the current view with no dialog.
<br>_[hover #map-capture-copy; press Escape; click #zoning-toggle; click #zoning-toggle; press Alt+c]_

**3.** Wpg Overall Map draws the city location map with a subject callout. Edit the callout text and position. Downtown subjects get a twin-arrow inset automatically.
<br>_[click #location-map-btn; wait for it; hover #location-map-output; press Escape]_

**4.** Addenda Pack builds the full set in one click. A location map, a neighbourhood map named and framed on the subject's neighbourhood cluster, a subject aerial from the newest City photography with dimensions, a zoning map, and a results map when there are several parcels.
<br>_[click #addenda-pack-btn]_

**5.** The button shows each stage as it renders. The map view is restored at the end, and the zip downloads with a readme.
<br>_[hover #addenda-pack-btn]_

**6.** Export C S V writes the table as shown, and warns first if any rows are unticked. That completes the Property Search tools for Winnipeg.
<br>_[hover #export]_

## wpg-05-sales-charts (Winnipeg, recorded)

_Before recording: load page_

**0.** The Winnipeg Sales Analysis tab reads the firm's SABRE export. Choose export folder once and point it at AppMarketData Sales Data Winnipeg. Any C S V with the four sales columns is imported, however it is named.
<br>_[open MAO Sales Database; click #sales-db-import]_

**1.** Set a subject roll and a radius in kilometres. The radius draws a dashed circle on the map and limits the search to it. Five kilometres here.
<br>_[click .chip-input[data-target="subject-roll"] .chip-input-text; type "07560170500"; press Enter; type "5" in #sales-radius-km]_

**2.** Pick a date preset, here 36 months, choose all sales, vacant land, or improved, and Search. Nominal sales are excluded unless you flip the pill.
<br>_[click .date-preset-btn[data-months="36"]; pick "all" in #vacant-improved; click #sales-db-load]_

**3.** After loading, the neighbourhood, category, property use, class and zoning pickers filter the sales. Click a cluster on the map to turn it off. Year built and building size narrow improved sales.
<br>_[click #category-filter-btn; press Escape; type "1990" in #sales-year-low]_

**4.** Additional filters add sale price, lot size, street name, the far-flung threshold and the N1 match filter. Save search and Load search keep a set of criteria as a file.
<br>_[click details.sales-filters summary; click details.sales-filters summary]_

**5.** Charts opens the Winnipeg charts page. Land shows price per lot square foot over time, per acre against lot size, and per lot against lot size. Buildings shows price per building square foot over time, by year built and by size.
<br>_[click #charts-open (opens new window)]_

**6.** Land sales only, Exclude already-built, and Exclude far-flung refine the land set. Freeze holds the charts while you capture them. Each point is one sale, and the charts follow the main window's filters live.
<br>_[click #mode-bldg; click #mode-land; click #drop-built]_
