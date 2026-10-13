# Winnipeg ParcelSearch — feature inventory for screencasts (2026-10-09)

Production: https://winnipeg-opendata-parcelsearch.vercel.app/  ·  charts: /charts.html (from `#charts-open`, BroadcastChannel; alone shows "Waiting for the Sales Analysis tab…").

## URL preload (fills fields, does NOT run search — click `#search`)
`af/at/as` address, `r` roll(s), `l/b/p/d` lot/block/plan/desc, `z` zoning, `pu` PUCS, `su/cu/cp` condo suite/unit/corp, `du=zero|min`, `dn`;
layers `sv av ap ay dl zo tr sp if mc bt cn dm st` (=1/0); `nh=clusters|individual`; `zc=show|filter`; `sc` sort col, `sd=asc|desc`; `t=sales`; `nu=1 no=1 pn=1`; `sr` subject roll, `rad` km, `n1`.
Example: `/?af=1393&at=1393&as=BORDER&zo=1&nh=clusters` then click `#search`.

## index.html — Property Search
Top: `#topbar-home`, `#map-toggle-btn` Hide map, `#map-expand-btn` Expand map, draw tools `#shape-tool-circle/-rectangle/-polygon/-clear` (narrow results; needs search), links Manitoba portal / Housing/Data Portal, `#data-status-open`→`#data-status-modal` (`#data-status-close`), `#data-sources-details`, `#data-staleness-banner`.
Map: address box `#map-address-input` ("Find an address…", list `#map-address-list`); zoom + geolocate; basemap `.basemap-menu-trigger` / `.basemap-menu-item[data-key=streets|ortho-2026|ortho-2024|ortho-2021|ortho-2018|ortho-2016|satellite]`; `.measure-control` → `.measure-modes button[data-mode=distance|area]`, `.measure-clear`, `.measure-done`.
Tabs `#tab-btn-property`, `#tab-btn-sales`.
Fields: `#address-from #address-to #address-street` (typeahead `#address-street-suggest` after 2 letters); roll chips `.chip-input[data-target="roll"] .chip-input-text` (hidden `#roll`);
`details.additional-searches` (badge `#advanced-filters-badge`): `#suite #condo-unit #condo-plan #zoning #lot #block #plan #desc #du-mode #du-min #pucs-filter`, water pill `.mode-pill[data-pill=water] [data-mode=off|waterfront|near|any]`, `#parcel-list-trigger`, Sample CSV.
`#search`, `#clear` (reloads bare URL). Pills: `#numbering-row [data-pill=numbering]` Off / By roll # (`[data-mode=roll]`) / Entry order (`[data-mode=entry]`, `#numbering-order-label`); `#pin-row [data-pill=locator]` Shape/Pin (1 result). `#count`, `#results-status`.
Import dialog `#parcel-list-modal`: `#parcel-list-text`, `#parcel-list-file`, `#parcel-list-recent-select`, `#parcel-list-cancel`, `#parcel-list-next` (Look up; Ctrl+Enter), review table, `#parcel-list-check-all`, `#parcel-list-back`, `#parcel-list-confirm` (Map parcels).
Results: `#columns-preset` (Quick lookup, Residential, Zoning detail, Sales analysis, Commercial Sales, Land Sales, MLS Sales, Full detail), `#columns-gear`→`#columns-popover`; table `#results` (`th[data-col=…]`, row checkbox cull, `tbody tr.clickable`).
Card `#parcel-summary`: `#ps-roll #ps-address #ps-area #ps-zoning #ps-asmt #ps-coords`; links `#ps-open-assessment #ps-open-ppd #ps-open-dmis #ps-open-zoning`; `#ps-verify`; `#ps-close`.
Map click popup: "Assessment →", "Copy Roll", "GPS Coordinates" (`.parcel-coords-copy`).
Layers: `#all-parcels-toggle #assess-toggle(default on) #all-survey-toggle(z15+) #survey-toggle #zoning-toggle(3-state: Shaded→Labels→off, `#zoning-legend`) #neighbourhoods-toggle(Off→Clusters 23→Neighbourhoods 235) #dimensions-toggle(z17+, needs search)`.
 Planning `#planning-group`: `#secondary-plans-toggle #infill-toggle(#infill-legend) #malls-corridors-toggle #airport-toggle`, `.zoning-changes-pill` Off/Show/Filter.
 Reference `#reference-group`: `#traffic-toggle #contam-toggle #transit-toggle #dwelling-units-toggle #streets-toggle #water-toggle`.
 Historical `#historical-group`: `#historical-date` then `#historical-toggle`; `#historical-banner`. Website links `#quick-links-group`.
Outputs: `#static-map-btn` (Alt+C) → `#map-capture-modal` (`#map-capture-legend #map-capture-furniture #map-capture-copy #map-capture-download #map-capture-download-jpg`);
`#location-map-btn` → `#location-map-modal` "Winnipeg Overall Map" (callout text "SUBJECT", position select disabled downtown → twin-arrow inset, Title, Copy image, Download PNG);
`#addenda-pack-btn` → `wpg-addenda-YYYY-MM-DD.zip` (1-location-map, neighbourhood-map 1950×1500, subject-aerial, zoning-map "By-law 200/2006", results-map if >1, README); `#export` CSV.

## index.html — Sales Analysis (`#tab-panel-sales`, needs SABRE data)
`#sales-db` (`#sales-db-status` "Not connected"; `#sales-db-import` folder → `#sales-db-refresh #sales-db-forget #sales-db-coverage`→`#sales-db-coverage-modal`). Any *.csv with the four required cols (Parcel ID, Instrument Number, Sale Dates, Sold Price) or MLS header is imported.
`#sales-import-collapse`: `#sales-dropzone`, `#sales-import-trigger`→`#sales-import-modal` (`#sales-import-text #sales-import-load`), `#parcel-list-trigger-sales` (pill `#sales-list-filter`), `#recent-uploads-select`.
Subject chips `.chip-input[data-target="subject-roll"]` (`#subject-roll`), `#sales-radius-km` (dashed circle). `.date-preset-btn[data-months=3..72]`, `#sales-date-from/-to`. `#vacant-improved` (All / Vacant Land Only / Improved – Res/Apt / Improved – Non-Res/Mixed). Pill `[data-pill=nominal]` Include/Exclude.
`#sales-db-load` Search, `#sales-clear`. Post-load filters: `#cluster-filter-btn` (or click cluster on map), `#category-filter-btn #pucs-filter-btn #class-filter-btn #zoning-filter-btn`, `#sales-year-low/-high`, `#sales-bldg-low/-high`.
`#criteria-save #criteria-load #sales-export #charts-open #far-flung-count`. `details.sales-filters`: `#sales-price-low/-high #sales-size-low/-high #sales-street-name #far-flung-km` + Keep/Exclude pill, `#sales-n1-filter`. Legend `#sales-category-legend`.

## charts.html
`#charts-title`, `#charts-sub`; `#mode-land` / `#mode-bldg`; `#land-only #drop-built #drop-far-flung #freeze`; `#charts-grid`.
 Land: $/Lot SF over time · $/Acre vs lot size · $/Lot vs lot size. Buildings: $/Bldg SF over time · by year built · by building size. Live-linked to Sales-tab filters.

## Demo inputs
1347 Border St = roll 07560170500 (alias 1393 Border St finds the same parcel); 400 Hargrave St; 330/393/407 Selkirk Ave; 11 St. Mary's Rd; 101 Rue Marion; 165 Provencher = 06093124800.
Rolls 14010256100, 1000001000, 010-000-055-00; entry order 01003547800 then 01003546600. Condo corp 43498; suite 1203 (1203-50 Main St). Plan 2930 (~220 rows). River lot Block RL + Plan JA/CH. STR NW 10-11-4E (Lot 10, Block 11, Plan 4E, Desc NW). Outer Two Mile Block OT.
Clusters: Fort Garry South, Point Douglas North, Transcona. `web/public/sample-parcel-list.csv` 9 rows.

## Differences vs Manitoba
Wpg Overall Map is Winnipeg-only with downtown inset; addenda neighbourhood map names the City neighbourhood, frames on cluster, masks outside grey (MB: municipality + section grid + highways). MB-only: highways, grid, Parcel Snapshots. Wpg-only: aerial-year basemaps, Historical as-of, Zoning Changes (DMIS), street typeahead, cluster picker, Land/Buildings charts page.
Doc nits: addenda tooltip lists 4 maps (code builds 5); verify checklist says By-law 100/2019 vs zoning map 200/2006; README "under Generate Map" stale.
