# Manitoba ParcelSearch — feature inventory for screencasts (2026-10-09)

Source-derived; verify transient text on production before recording.
Production: https://manitoba-opendata-parcelsearch.vercel.app/  ·  charts: /charts.html (opens only from `#charts-open`, data via BroadcastChannel `mbps-sales-charts`).

## URL preload (fills fields/overlays, does NOT run search — click `#search`)
`m` municipality (`BRANDON (CITY)`, `SPRINGFIELD (RM)`), `r` roll(s), `af/at/as` address from/to/street, `ay/ad` street type/dir,
`lt` legal text, `ti` title, `lo/bk/pn` lot/block/plan, `cp/cu` condo plan/unit, `ph/py/pw/pz` parish, `sq/ss/sw/sg/se` STR,
`zc` zoning cat, `cs` amendments, `du/dn`, `t=property|sales`, `vt/vd`, `s` sort (`-` desc), `p` page,
`o=zoning,devplan,flow,contam,muni-parcels` overlays (button ids minus `-toggle`), `pl=water:waterfront,tile:on,numbering:muni` pills.
Example: `?m=BRANDON%20(CITY)&r=510875&o=zoning`

## index.html — Property Search
Top bar: `#topbar-home` (reset), `#map-toggle-btn` Hide Map, `#map-expand-btn` Expand Map, draw tools `#shape-tool-circle/-rectangle/-polygon/-clear` (sales mode),
`#data-status-open` → `#data-status-modal` (filter `#data-status-muni-search`), `#data-sources-details`.
Tabs: `#tab-btn-property`, `#tab-btn-sales`.
Fields: `#municipality` select; roll chips `.chip-input[data-target="roll"] .chip-input-text` (hidden `#roll`); `#address-from/#address-to/#address-street`;
`details.advanced-filters` (badge `#advanced-filters-badge`): `#address-type #address-dir #condo-unit #condo-plan #legal-text #title #lot #block #plan`
`#parish #parish-lot-type #parish-lot #parish-plan` · `#str-quarter #str-section #str-township #str-range #str-dir` · `#zone-category #changed-status #du-mode #du-min`
· `#parcel-list-import-trigger` + `a.sample-csv-link`.
Buttons: `#search`, `#clear-roll-address`, `#clear`. Enter runs search. Ctrl+K focuses main input.
Import dialog `#parcel-list-import-modal`: `#parcel-list-import-text`, `#parcel-list-import-file`, `#parcel-list-import-next` → mapping → `#parcel-list-import-resolve`; pill `#parcel-list-pill`.
Results: `#count` (inline "Load zoning + dev-plan" `#count button.inline-action`), `#results-status`, `#columns-preset` (Sales analysis, Commercial Sales, Land Sales, Zoning check, Agricultural, Residential, Full detail), `#columns-gear`→`#columns-popover`,
table `#results` (`th[data-col=roll|address|zone1|value]`, `#select-all-rows`, pager `#results-paginator`), row click → `#parcel-summary` (`#ps-open-mao #ps-open-muni #ps-copy-source #ps-export-selected #ps-verify #ps-close`).
Map popup: `.parcel-roll-copy .parcel-coords-copy .parcel-jump-to-list`. Splitter `#workspace-resize`.
Map controls: place search "Find a town or municipality…"; basemap `.basemap-menu-trigger` / `.basemap-menu-item[data-key=…]` (Streets, Satellite, Historical (Esri Wayback)+Imagery date, NRCan Transportation, NRCan Elevation); `.measure-control button` → Distance/Area/Clear/Done; geolocate.
Layers `#map-layers-section` (`details.overlay-group[data-group=…]`, `button.overlay-btn[aria-pressed]`):
 Parcel: `#muni-parcels-toggle` (needs muni), `#dims-toggle` (zoom16+).
 Planning: `#zoning-toggle` (`#zoning-legend`), `#devplan-toggle`, changes pill `.changes-mode-pill .changes-mode-btn[data-mode=off|show|filter]`.
 Reference: `#contam-toggle #stations-toggle #highways-toggle #flow-toggle #grid-toggle`.
 Agricultural: `#riskarea-toggle #masc-toggle #cli-toggle(3-state) #landcover-toggle #landfacts-toggle #tile-toggle #tile-network-toggle #irrigation-toggle`, pills `[data-pill=tile|irrigation]`.
 Water: `#water-toggle`, pill `[data-pill=water] [data-mode=off|waterfront|near|any]`.
 Multi-family: `#mfinv-toggle #mfinv-min-du #mfnb-toggle #condodev-toggle`.
 Flood: `#flood-dfa-toggle #flood-sma-toggle #flood-f200-toggle #flood-hist-toggle #flood-corridor-toggle`.
 Historical: `#historical-toggle` (needs muni) + `#historical-year`; `#historical-layer-parcels/-zoning/-devplan`; `#prior-outlines-toggle`.
 Quick links: `#muni-website-btn #pd-website-btn`.
Report outputs: `#static-map-btn` (Alt+C) → `#map-capture-modal` (`#map-capture-legend #map-capture-furniture #map-capture-copy #map-capture-download #map-capture-download-jpg`);
`#location-map-btn` → `#location-map-modal` (base-map select MB/Wpg, callout text "SUBJECT", position, Title, Copy image, Download PNG);
`#addenda-pack-btn` (progress "Addenda n/N: …", zip `…addenda-YYYY-MM-DD.zip`); `#export` CSV; `#route-starred #route-plan-trigger` (Mapbox token); `#snapshot-zip-btn`.
Pills: `[data-pill=numbering]` Off/By muni/Entry order (>1 parcel); `[data-pill=locator]` Shape/Pin (1 parcel).

## index.html — Sales Analysis (`#tab-panel-sales`)
Job: `#job-save #job-open #job-recent`. MAO Sales Database `#sales-db` (`#sales-db-status` "Not imported"; `#sales-db-import` folder picker → `#sales-db-refresh #sales-db-forget #sales-db-coverage`).
Province-wide `#sales-prov`: `#sales-prov-saved #sales-prov-class #sales-prov-unknown #sales-prov-from/-to #sales-prov-min/-max #sales-prov-types #sales-prov-subs #sales-prov-search #sales-prov-save`.
`#sales-db-muni-search`, pill `[data-pill=adjacent]`, `#sales-db-munis`, `#sales-db-type`, `#sales-db-load`, pill `[data-pill=nominal]`.
Manual `#sales-manual`: `#sales-dropzone #sales-upload-input`, `#sales-import-trigger` → `#sales-import-modal` (`#sales-import-text #sales-import-load`; cols Sale Date, Consideration, Municipality, Roll Number, Street Address, Legal Description, Primary Property), `#recent-uploads-select`.
Filters (`.sales-only`): `.date-preset-btn[data-months=3..72]`, `#sale-date-from/-to`, `#asmt-class`, `#primaryprop-filter`, `#vacant-improved`, `#charts-open`, `#far-flung-count`.
`details.more-filters`: `#sales-plan #size-uom #size-low #size-high #sales-street-name #sales-ppa-low/-high #sales-price-low/-high #zoning-filter #zonecat-filter #sales-groupsize-filter #sales-n1-filter #sales-outline-filter #vacant-threshold .vacant-mode-btn #sale-asmt-max #far-flung-km [data-pill=farflung]`,
Subject: `#subject-muni #subject-roll #distance-max #subject-apply #subject-clear`. `#sales-clear`.
Grid: ★ `th[data-col=favorite]` (click = next comp; right/Alt-click = tag menu: Comparable #n, Land Set 1, Land Set 2); untick row → "Why exclude this sale?" popover; `#number-starred`; orange = outlier, green = multi-parcel.

## charts.html — Sales Charts
`#charts-status`, `#company`, `#workfile-open`. Units `#unit-acres #unit-sf #unit-ff`; rates `#rates-nominal #rates-adjusted`, `#adj-basis #adj-rate #eff-date`; `#map-munis`; `#dist-ref`; `#trim-on #trim-lo #trim-hi`; `#freeze #show-table #show-excluded`. localStorage `mbps_charts_opts_v2` (stale unit → empty tab).
`#charts-empty`, `#waterfall-panel`, `#comps-panel` (↑↓×, Copy comp roll numbers, Clear all tags), `#excl-panel` (`input.excl-reason`; suggestions Nominal transfer, Non-arm's length, Assembly, Outlier, Not comparable, Includes improvements, Forced sale; Include again).
Page tabs `#tab-rates #tab-ag #tab-total #tab-water`; row tabs `.page-maps .row-tabs button`, `.page-charts .row-tabs button` (`.is-on`).
 Land Price/Unit: maps Price & Lot Size · Year & Zoning · Water Influence; charts Over Time & Size · Zoning & Distance.
 Agricultural: map MASC & CLI; charts MASC Rating · Cultivation & Soil · CLI & Land Cover · Cover Mix · Sale/Assessment · S/A Distribution; `section.ag-cons` bar.
 Total/Per Lot: map Price per Lot; charts Total Price · Per Lot · Per Lot by Distance & Assessed.
 Water: map Water Class; charts Influence & Class · Flood & Water Body · Size & Distance · Summary & Premium · Paired Sales.
Chart dots: click = untick (opens Excluded with reason focused); Shift-click = tag next comp; keyboard arrows/Enter/Esc; "Restore N unticked sales"; PNG per card (1950×1050). Map dot popup: Exclude/Include, Add as Comp #n / Land Set 1/2.
Work file `#workfile-dialog`: `#workfile-embed #workfile-list #workfile-go` → `work-file-<roll>-<date>.zip`. Keep window in front during export.

## Demo inputs
Brandon roll 510875 = 1511-1519 26TH ST (civic 1515 finds it); 525063 = Unit 10 - 1015 26TH ST; 562264 (1501 BRAECREST DR) 12.23 ac on 2025-02-12 vs 3.78 ac now (Historical demo; 562314 carved off).
Ste Anne RM roll 26325 ("80.07 FEET" vs 79.9 ac). Multi-roll `284950&373300`; entry order `154350, 154345`.
STR NE 27-7-4E; river lot RL-65-FX-5066; condo Unit 1 Plan 38239; title 2476500; legal contains "PCL G", "RIVER LOT 12", "PLAN 24208"; street MAIN ST, DRURY, ROAD 96W.
Munis: BRANDON (CITY) ~17k parcels, SPRINGFIELD (RM), RITCHOT (RM), PORTAGE LA PRAIRIE (RM) (irrigation demo, 691 parcels ~26 s). Places: Souris, ile des chenes, Gimli.
Sample import list `/sample-parcel-list.csv` (all rows resolve). No sample sales CSV in repo.

## Private/internal
MAO Sales Database folder, province-wide search, coverage, saved searches; N1 column/filter; job files; route planning (token); MLI aerial / Land Cover detailed (env).
