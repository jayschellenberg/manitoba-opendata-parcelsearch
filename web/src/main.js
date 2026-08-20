// Tailwind v4 entry — picked up by the @tailwindcss/vite plugin. The
// import has no runtime export; it exists so Vite processes the file
// and emits the generated stylesheet alongside the legacy style.css.
import './lib/tailwind.css';

// Phase 3 sidebar tabs.
import { initSidebarTabs, setActiveTab, getActiveTab, onTabChange } from './lib/tabs.js';
import { initDataStatusDialog } from './dataStatusDialog.js';

// Phase 4 form controls.
import { initChipInput } from './lib/chipInput.js';
import { initInfoIcons } from './lib/infoIcon.js';
import { initParcelListImport } from './lib/parcelListImport.js';
import { initSalesPasteImport } from './lib/salesPasteImport.js';
import { initSalesDbPanel } from './lib/salesDbPanel.js';
import { listShardKeys } from './lib/salesStore.js';
import { showMuniLayer, hideMuniLayer, paintMuniSelection, wireMuniInteractions, fitToSelection }
  from './lib/muniLayer.js';
// Route planner — TSP solver + Mapbox client.
import { solveRoute, haversineMatrix, mostOutlyingIndex } from './lib/routeSolver.js';
import {
  hasToken as hasMapboxToken,
  fetchDrivingMatrix,
  fetchDrivingMatrixClustered,
  fetchDrivingRoute,
  staticRouteImageUrl,
  MATRIX_MAX_COORDS,
  MatrixTooManyCoordsError,
} from './mapbox.js';

// Phase 5 column visibility.
import {
  initColumns,
  applyVisibility as applyColumnVisibility,
  setColumnVisible,
  applyParcelImportDefaults,
  onPresetApply,
} from './lib/columns.js';

// Phase 6 URL state — serialises a small set of form values into the
// query string so a session URL is shareable.
import { encodeState, decodeState } from './lib/urlState.js';
import { setOverlayPressed } from './lib/overlayToggle.js';
import { stalenessBannerState } from './lib/staleness.js';
import { resolveDropdownSources } from './lib/dropdownSources.js';
import { readMapLegends, layoutMapLegends, paintMapLegends } from './lib/mapLegend.js';
import {
  computeSaleGroups, groupPosition, frontageRateState,
  isFarFlungSale, farFlungReason, DEFAULT_FAR_FLUNG_KM,
  isNominalSale,
} from './lib/saleGroups.js';
import {
  dedupeSalesByRoll, expandFeaturesBySale, unmatchedSales,
  uniqueParcelFeatures, dedupeParcelFeaturesForMap,
} from './lib/salesDedupe.js';
import { parseSalesCsv } from './lib/salesCsvParse.js';
import { saleRecordsFromRows } from './lib/salesCharts.js';
import { initMultiSelect } from './lib/multiSelect.js';
import {
  primaryPropertyTree,
  matchingSaleGroupIds,
  rowPassesPrimaryProperty,
} from './lib/primaryProperty.js';
import {
  zoneCategoryLabel,
  zoneCategoriesInRows,
  rowMatchesZoneCategories,
  normalizeZoneCategory,
} from './lib/zoneCategory.js';
import { assignParcelSeq, clearParcelSeq } from './lib/parcelNumbering.js';
import { parcelLat, parcelLon, featureToWkt, parcelCentrePoint } from './lib/geometryText.js';
import {
  realStr,
  legalDisplay,
  parseTitleNumbers,
  dominantCliLabel,
  dominantSoilTypeLabel,
  dominantSlopeCode,
  slopeSortRank,
  parcelSlopeRange,
  slopeRangeText,
} from './lib/cellFormat.js';
import { filterMascRiverlotsForMuni, matchMuniNameCandidates } from './lib/muniIdentity.js';
import { safeExternalUrl } from './lib/safeUrl.js';
import {
  applyCivicNumberFilter,
  addressSearchVariants,
  addressMatchesVariants,
} from './lib/civicRange.js';

// Entry point. Wires the search inputs, the map, and the results table.
//
// Single search flow (Manitoba's Roll_Entry IS the parcel layer; there's no
// separate survey/legal-lots dataset like Winnipeg has):
//
//   1. searchParcels() — attribute query against Roll_Entry. Address /
//      Roll #  use UPPER() LIKE; the muni and category dropdowns use exact
//      equality. Categorical filters first resolve to a list of OBJECTIDs
//      via spatial query against the matching overlay so all filters
//      compose with AND semantics inside one paginated parcel response.
//   2. fetchZoningOverlap + fetchDevPlanOverlap — per-parcel envelope
//      query against each overlay layer, run in parallel.
//   3. joinTopNByArea — clip each overlay polygon to each parcel polygon,
//      compute area-weighted top-2 with coverage ratios. Mirrors the
//      mao-assembly Step 1 pipeline's get_multiple_by_area().
//   4. Render the table with both top-2 zone and top-2 dev-plan columns,
//      coverage % per match, and direct links into Manitoba Assessment
//      Online for each parcel.

import {
  searchParcels,
  fetchZoningOverlap,
  fetchDevPlanOverlap,
  joinTopNByAreaAsync,
  bboxOverlapJoin,
  fetchMunicipalityList,
  fetchRollEntryCount,
  setRollEntrySnapshot,
  getRollEntrySnapshot,
  MB_PARCEL_DATA_CDN,
  fetchZoneCategoryList,
  fetchContaminatedSites,
  fetchTrafficFlow,
  fetchManitobaHighways,
  fetchAllParcelsInMunicipality,
  fetchMunicipalBoundaries,
  fetchMascRatingsForMuni,
  fetchMascRiskAreas,
  fetchSurveyGridForMuni,
  fetchProvinceSectionGrid,
  fetchRiverLots,
  fetchParcelMascForMuni,
  fetchLandCoverForMuni,
  fetchWaterForMuni,
  fetchHistoricalIndex,
  fetchHistoricalManifest,
  fetchHistoricalShard,
  fetchHistoricalLineage,
  fetchMascRiverlots,
  fetchCliAgrForMuni,
  parseRollList,
  missingRollsFromResults,
  canonicalRoll,
  acresFromFrontageField,
  fetchRollLayerPublishedDate,
} from './arcgis.js';
import {
  quartersToFc,
  sectionLinesFromRows,
  quarterLinesFromRows,
  surveyFcToRows,
  masccolor,
  mascRatingLabel,
  mascDisplayRating,
  mascTextColor,
} from './masc.js';
import {
  initMap,
  showResults,
  setRouteStart,
  setRouteData,
  setRouteVisible,
  pickStartFromMap,
  setZoningData,
  setZoningPaint,
  setParcelZoneColoring,
  setDevPlanData,
  setZoningVisible,
  setDevPlanVisible,
  setContamData,
  setContamVisible,
  setTrafficFlowData,
  setTrafficFlowVisible,
  setMbHighwaysData,
  setMbHighwaysVisible,
  setMuniParcelsData,
  setMuniParcelsVisible,
  setMuniBoundariesData,
  setMuniBoundarySelected,
  wireMuniBoundaryPicker,
  contentLayerOwnsPoint,
  setMascData,
  setMascRiverlotsData,
  setMascVisible,
  setCliAgrData,
  setCliAgrVisible,
  setCliPaintMode,
  decodeSoilDescriptor,
  setMascRiskAreasData,
  setMascRiskAreasVisible,
  setTileDrainageData,
  setTileDrainageVisible,
  setTileNetworkData,
  setTileNetworkVisible,
  setIrrigationData,
  setIrrigationVisible,
  setSurveyGridData,
  setSurveyGridVisible,
  setLandCoverVisible,
  setWaterInfluenceVisible,
  setHistoricalData,
  setHistoricalVisible,
  setHistoricalLayerVisible,
  getHistoricalLegend,
  setLandCoverRasterVisible,
  setLandCoverRasterOpacity,
  flyToFeature,
  showPlacePin,
  buildZoneCodePaint,
  parcelHtml,
  setSubjectData,
  setSubjectRadius,
  setParcelNumberData,
  setParcelNumbersVisible,
} from './map.js';
import {
  fetchTileDrainageAreas,
  fetchIrrigationLicences,
  fetchTileNetwork,
} from './wallas.js';
import { generateParcelSnapshotsZip } from './snapshotExport.js';
// Area-selection shape filter (draw radius/rectangle/polygon on the map).
import { getShapes as getMapShapes, clearShapes as clearMapShapes, onShapesChanged } from './drawShapes.js';
import { passesShapeFilter } from './lib/shapeFilter.js';
import { countSnapshotFrames } from './lib/snapshotGroups.js';
import { OUTPUT_MIME, OUTPUT_QUALITY, MAX_OUTPUT_DIM } from './lib/imageOutput.js';
import { dominantBucket, cultFraction, LAND_COVER_BUCKETS, LAND_COVER_MIN_ACRES } from './lib/landcover.js';
import {
  waterColor, waterCellText, waterTooltip, waterSortRank,
  waterCsvCells, isWaterfront, isNearWater, WATER_CLASSES,
} from './lib/water.js';
import { resolveParcelAcres, formatRollSizeField, parseRollFrontageFeet } from './lib/acres.js';
import {
  saleSizeStamp, saleSizeState, saleAcres, sizeSourceLabel, showsCurrentRollSize,
  shapeDerivedNote,
} from './lib/saleSize.js';
import { computeSizeChanges } from './lib/sizeChange.js';
import { indexHistoricalGeometry, applyHistoricalGeometry } from './lib/historicalHighlight.js';
import { withholdChangedGeometry, withheldNote } from './lib/withheldGeometry.js';
import { clearAllCache as clearAllCacheModule } from './cache.js';
import { getManifest, getManifestSync } from './manifest.js';
import { buildProvenance, provenanceCsvLines, provenanceText } from './lib/provenance.js';
import {
  hasLegalCriteria,
  legalRecordKey,
  parcelLegalKey,
  searchLegalIndex,
  lookupLegalRecordsByParcelKeys,
  warmLegalIndex,
  getLegalIndexMetadata,
} from './legalIndex.js';
import {
  warmAssessmentIndex,
  lookupAssessment,
  isVacantLand,
  uniqueClassesAndStatuses,
  getAssessmentIndexMetadata,
  prefetchAssessmentShards,
} from './assessmentIndex.js';
import turfArea from '@turf/area';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import {
  formatCurrency as fmtCurrency,
  formatAcres as fmtAcres,
  formatSqFtFromAcres,
  formatPercent as fmtPercent,
} from './lib/format.js';
import { soilSurveyComponentsFromMatches } from './soilSurvey.js';

// Civic-address search is now a 3-input row: a numeric range (From / To)
// plus a Street Name substring. The single legacy `#address` input was
// retired on 2026-05-08 — see commit history if rolling back.
const $addressFrom   = document.getElementById('address-from');
const $addressTo     = document.getElementById('address-to');
const $addressStreet = document.getElementById('address-street');
const $municipality  = document.getElementById('municipality');
const $roll          = document.getElementById('roll');
// Legal-search inputs are removed from the DOM until the MAO scrape
// index is wired up. The lookups below all return null in that state.
// Every read-site uses optional chaining ?? '' so the empty .value
// passes through harmlessly and hasLegalCriteria() short-circuits.
const $legalText     = document.getElementById('legal-text');
const $lot           = document.getElementById('lot');
const $block         = document.getElementById('block');
const $plan          = document.getElementById('plan');
const $title         = document.getElementById('title');
const $zoneCategory  = document.getElementById('zone-category');
const $changedStatus = document.getElementById('changed-status');
const $duMode        = document.getElementById('du-mode');
const $duMin         = document.getElementById('du-min');
// Sales-CSV size-range filter. Visible only when body.sales-mode is set
// (i.e. after a sales-CSV upload). Empty Low → 0; empty High → ∞. The
// `_uom` state lives on the pill container; toggleSizeUom() flips both
// buttons' .active class and updates the dataset attribute.
const $sizeLow       = document.getElementById('size-low');
const $sizeHigh      = document.getElementById('size-high');
const $sizeUom = document.getElementById('size-uom');
const SIZE_UOMS = ['acres', 'sf', 'ff'];

/** Which unit the two size boxes are read in. The select's own value is
 *  the single source of truth. */
function getSizeUom() {
  const uom = $sizeUom?.value;
  return SIZE_UOMS.includes(uom) ? uom : 'acres';
}

/**
 * Apply a change of size unit: acres, square feet, or frontage feet.
 *
 * The typed values are deliberately NOT converted — the boxes are read
 * in whichever unit is selected, so switching re-interprets what is
 * already there. Converting instead would turn a round "5" into
 * "217,800" and leave the user editing a number they never entered. The
 * placeholders move so the active unit is visible on an empty box.
 *
 * FF is a different KIND of measure, not another area unit: it reads the
 * roll's stated frontage, which only about 37% of parcels carry.
 *
 * `previous` is passed in because the select's value has already changed
 * by the time the change event fires, so it cannot be read back here.
 */
function setSizeUom(uom, previous) {
  if (!SIZE_UOMS.includes(uom)) return;
  if ($sizeUom) $sizeUom.value = uom;
  const label = uom === 'sf' ? 'SF' : uom === 'ff' ? 'FF' : 'Ac';
  if ($sizeLow)  $sizeLow.placeholder  = `Lo ${label}`;
  if ($sizeHigh) $sizeHigh.placeholder = `Hi ${label}`;
  // Always re-filter when FF is involved (selected or just left), since
  // FF alone changes the row set regardless of the boxes. Otherwise only
  // when a bound is set — switching Ac/SF with both boxes empty should
  // not disturb anything.
  if (uom === 'ff' || previous === 'ff' || $sizeLow?.value !== '' || $sizeHigh?.value !== '') {
    refilterCsvIfActive();
  }
}
// Track the outgoing value so setSizeUom can tell whether FF was just
// left, which changes the row set even with both boxes empty.
let lastSizeUom = getSizeUom();
$sizeUom?.addEventListener('change', () => {
  const previous = lastSizeUom;
  lastSizeUom = $sizeUom.value;
  setSizeUom($sizeUom.value, previous);
});
// Sales-CSV vacant/improved selector (All Sales / Vacant Land Only /
// Improved Only) — strict group semantics. Vacant reads
// _saleGroupAllVacant (every member known vacant), Improved reads
// _saleGroupAnyImproved (at least one member KNOWN to carry buildings);
// both stamped by computeSaleGroupTotals after the per-parcel
// assessment-index lookup runs in handleSalesUpload. Groups with
// missing assessment data satisfy neither, so they drop out of both
// narrowed modes rather than being guessed into one.
const $vacantImproved = document.getElementById('vacant-improved');
const $saleAsmtMax   = document.getElementById('sale-asmt-max');
// Sales-CSV sale-date range. Both inputs accept HTML5 date strings
// (YYYY-MM-DD); empty values are interpreted as "no minimum"/"no
// maximum" respectively. Sale-date strings from the CSV go through
// parseSaleDate() to be compared apples-to-apples.
const $saleDateFrom  = document.getElementById('sale-date-from');
const $saleDateTo    = document.getElementById('sale-date-to');
// Sales-CSV assessment-class filter. Options are populated post-upload
// from the matched parcels' dominant class (assessmentIndex.js's
// uniqueClassesAndStatuses helper). Nothing ticked = no filter.
//
// The tax-status twin that used to sit beside this one is gone: the
// EXEMPT / SCHOOL TAX EXEMPT / TAXABLE split never narrowed a comp
// search in practice, and it cost a four-row list box to say so. Tax
// status is still stamped on every parcel (_asmtStatus), still shown
// in the map popup and still exported — it just isn't a filter.
const $asmtClass     = document.getElementById('asmt-class');
const asmtClassFilter = initMultiSelect($asmtClass, {
  placeholder: 'Any Assessment Class',
  noun: 'classes',
  emptyLabel: 'No values yet — upload sales first.',
});
// Zoning filter. Unlike the Property tab's Zoning Category dropdown —
// which lists every category in the municipality's by-law — this lists
// only the zone codes the current result set actually contains, so
// ticking one always leaves rows behind. Needs the zoning overlay join
// to have run; on a result set past the enrichment threshold that only
// happens once the user presses "Load zoning + dev-plan".
const $zoningFilterEl = document.getElementById('zoning-filter');
const zoningFilter = initMultiSelect($zoningFilterEl, {
  placeholder: 'Any zoning',
  noun: 'zones',
  emptyLabel: 'No zoning loaded for these results yet.',
});
// Zoning TYPE — the cross-muni companion to the code picker above. Zone
// codes are municipality-specific, so on a multi-muni sales set the code
// filter cannot express "every commercial sale"; ZONE_CATEGORY can. Same
// enrichment dependency: needs the zoning join to have run.
const $zoneCatFilterEl = document.getElementById('zonecat-filter');
const zoneCatFilter = initMultiSelect($zoneCatFilterEl, {
  placeholder: 'Any zoning type',
  noun: 'types',
  emptyLabel: 'No zoning loaded for these results yet.',
});
// Primary Property — what actually stands on the parcel, per MAO. Grouped
// rather than flat (lib/primaryProperty.js explains the taxonomy): the
// descriptor runs to 565 distinct values province-wide, so the family
// (Residential / ICI / Farm, taken from the sale's own Sale Type Group)
// carries the top layer and the structure type sits under it. Unlike the
// two zoning pickers this needs no overlay join — the values ride in on
// the sales data itself, so the filter works the moment an upload lands.
const $primaryPropEl = document.getElementById('primaryprop-filter');
const primaryPropFilter = initMultiSelect($primaryPropEl, {
  placeholder: 'Any Structure Type',
  noun: 'structure types',
  emptyLabel: 'No values yet — upload sales first.',
});
// Total-consideration bounds. Distinct from the $/Ac pair: this is the
// whole transaction, so a multi-parcel sale passes or fails as one.
const $salesPriceLow  = document.getElementById('sales-price-low');
const $salesPriceHigh = document.getElementById('sales-price-high');
// Subject parcel comparison — paste a roll # to highlight a subject
// property on the map and compute centroid-to-centroid distance from
// every sale parcel. The current subject Feature lives on
// `subjectFeature`; centroid (lng/lat) lives on `subjectCentroid`.
const $subjectRoll   = document.getElementById('subject-roll');
const $subjectApply  = document.getElementById('subject-apply');
const $subjectClear  = document.getElementById('subject-clear');
// Subject muni picker. Populated by handleSalesUpload with the matched
// muni list when an upload spans 2+ munis; hidden for single-muni
// uploads where the answer is unambiguous.
const $subjectMuniRow = document.getElementById('subject-muni-row');
const $subjectMuni    = document.getElementById('subject-muni');
// Distance-from-subject filter input.
const $distanceMax   = document.getElementById('distance-max');
// Sales-mode Plan # filter — case-insensitive substring match against
// each parcel's _plan (stamped from the legal-index in
// attachLegalMetadata). Separate from the regular-search $plan input
// (#plan) because the sales filter runs post-upload, client-side,
// while the regular search drives a server-side legal-index query.
const $salesPlan     = document.getElementById('sales-plan');
// Sales-mode Street Name filter — case-insensitive substring match
// against Property_Address. Same client-side post-filter pattern as
// $salesPlan; complementary because Plan # narrows by plat/legal
// while Street Name narrows by civic address.
const $salesStreetName = document.getElementById('sales-street-name');
// N1 match filter — any / matched / unmatched against the export's
// "N1 ID" column. "Unmatched" is the working mode: it turns the site
// into the browsable queue of sales not yet entered in N1.
const $salesN1 = document.getElementById('sales-n1-filter');
// Parcels-per-sale filter — 'any' | 'single' | 'multi', tested against the
// _saleGroupSize stamped by computeSaleGroupTotals. Shares a row with the N1
// filter. Separates assemblies (one price, several rolls) from ordinary
// single-roll sales, which read completely differently as comps: an assembly's
// $/Acre is spread across land the buyer took as one deal.
const $salesGroupSize = document.getElementById('sales-groupsize-filter');
// Sales-mode $/Acre filter — pair of bounds against the
// _saleGroupPpa stamped by computeSaleGroupTotals. Useful for
// flushing out development-land sales that trade at a much higher
// rate per acre than rural / farm comps.
const $salesPpaLow   = document.getElementById('sales-ppa-low');
const $salesPpaHigh  = document.getElementById('sales-ppa-high');
// Nominal-sale exclusion (Sales Analysis, beside Sales Coverage). Drops
// sales whose whole consideration is under NOMINAL_SALE_MAX — the $0/$1
// family and corrective transfers that carry no market evidence. The
// predicate + threshold live in lib/saleGroups.js beside isFarFlungSale,
// the other "remove whole sales" rule.
const $excludeNominal = document.getElementById('exclude-nominal');
const $farFlungKm      = document.getElementById('far-flung-km');
const $farFlungCount   = document.getElementById('far-flung-count');
const $farFlungExclude = document.getElementById('far-flung-exclude');
const $search        = document.getElementById('search');
const $clear         = document.getElementById('clear');
const $export        = document.getElementById('export');
// Parcel numbering — the "Number parcels" toggle (leader-line callouts
// on the map + the "#" column in the grid). Off by default; the row is
// revealed only for multi-parcel result sets.
const $numberingRow    = document.getElementById('numbering-row');
const $numberingToggle = document.getElementById('numbering-toggle');
const $numberingLabel  = document.getElementById('numbering-toggle-label');
// "Entry order" — number by the sequence the rolls were typed rather than
// by muni + Roll #. Only offered when the results came from a typed list.
const $numberingOrderToggle = document.getElementById('numbering-order-toggle');
const $numberingOrderLabel  = document.getElementById('numbering-order-label');
// "Include legend in map image" — sits beside the numbering toggle and is
// read by composeWithAttribution. Shown only while a legend is on screen.
const $legendToggle    = document.getElementById('legend-toggle');
const $legendLabel     = document.getElementById('legend-toggle-label');
const $zoningToggle  = document.getElementById('zoning-toggle');
const $devplanToggle = document.getElementById('devplan-toggle');
const $muniWebsiteBtn = document.getElementById('muni-website-btn');
const $pdWebsiteBtn   = document.getElementById('pd-website-btn');
const $contamToggle  = document.getElementById('contam-toggle');
const $flowToggle    = document.getElementById('flow-toggle');
const $highwaysToggle = document.getElementById('highways-toggle');
const $muniParcelsToggle = document.getElementById('muni-parcels-toggle');
const $mascToggle    = document.getElementById('masc-toggle');
const $riskAreaToggle = document.getElementById('riskarea-toggle');
// WALLAS water-rights overlays (src/wallas.js).
const $tileToggle        = document.getElementById('tile-toggle');
const $tileNetworkToggle = document.getElementById('tile-network-toggle');
const $irrigationToggle  = document.getElementById('irrigation-toggle');
const $tileOnly          = document.getElementById('tile-only');
const $irrigationOnly    = document.getElementById('irrigation-only');
const $waterfrontOnly    = document.getElementById('waterfront-only');
const $nearWaterOnly     = document.getElementById('near-water-only');
const $cliToggle     = document.getElementById('cli-toggle');
const $cliLegend     = document.getElementById('cli-legend');
const $landcoverToggle = document.getElementById('landcover-toggle');
const $waterToggle     = document.getElementById('water-toggle');
const $landcoverLegend = document.getElementById('landcover-legend');
const $gridToggle    = document.getElementById('grid-toggle');
const $historicalToggle   = document.getElementById('historical-toggle');
const $historicalYear     = document.getElementById('historical-year');
const $historicalYearWrap = document.getElementById('historical-year-wrap');
const $historicalBanner   = document.getElementById('historical-banner');
// Per-layer sub-toggles, keyed to map.js's HISTORICAL_LAYER_IDS.
const $historicalLayersWrap = document.getElementById('historical-layers-wrap');
const $historicalZoningLegend  = document.getElementById('historical-zoning-legend');
const $historicalDevplanLegend = document.getElementById('historical-devplan-legend');
const $historicalLayerBtns = {
  parcels: document.getElementById('historical-layer-parcels'),
  zoning:  document.getElementById('historical-layer-zoning'),
  devplan: document.getElementById('historical-layer-devplan'),
};
const $count         = document.getElementById('count');
const $tbody         = document.querySelector('#results tbody');
const $mapEl         = document.getElementById('map');
const $flowLegend    = document.getElementById('flow-legend');
const $mascLegend    = document.getElementById('masc-legend');
const $zoningLegend  = document.getElementById('zoning-legend');

/**
 * Refresh the zoning-code legend AND the corresponding map paint
 * expression. Called after every search once the zoning enrichment FC
 * has landed, so the legend reflects only the codes actually visible
 * on screen — much more useful than a static category list when the
 * user is looking at one specific muni.
 */
function rebuildZoningLegend(zoningFc) {
  if (!$zoningLegend) return;
  const ul = $zoningLegend.querySelector('ul');
  const head = $zoningLegend.querySelector('strong');
  if (head) head.textContent = 'Zoning code';
  if (!ul) return;
  const { matchPairs, legend } = buildZoneCodePaint(zoningFc);
  // Mirror the colour assignment into the live paint expression so the
  // map and legend can never drift.
  mapReady.then(() => setZoningPaint(map, matchPairs));
  ul.innerHTML = '';
  if (legend.length === 0) {
    const li = document.createElement('li');
    li.style.color = '#888';
    li.textContent = '— no zoning data for this search —';
    ul.appendChild(li);
    return;
  }
  for (const { label, color } of legend) {
    const li = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = color;
    li.appendChild(sw);
    li.appendChild(document.createTextNode(label));
    ul.appendChild(li);
  }
}

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

/**
 * Municipality website URLs, keyed on the Muni_Name_With_Typ value
 * Roll_Entry returns (e.g. "STONEWALL (TOWN)", "BRANDON (CITY)",
 * "ROCKWOOD (RM)"). Compiled from the province's official Municipal
 * Contact Directory. A muni with no entry here shows "Muni N/A".
 *
 * A MISSING ENTRY IS BETTER THAN A WRONG ONE. An absent key degrades
 * honestly to "Muni N/A"; a rotted URL lights the button and then opens a
 * browser error, a router login, or — in one case found 2026-08-05 — a
 * HugeDomains for-sale page, all of which read as this app's bug. So when
 * a URL can't be confirmed, delete it rather than leave it hopeful.
 *
 * These are hand-curated and nothing refreshes them. A full check on
 * 2026-08-05 found 15 of 153 URLs dead (6.6% of munis, 26% of planning
 * districts); the ones with findable replacements were repointed and the
 * rest removed, each with a note saying why. Note that half the failures
 * returned HTTP 200 — a squatter page, a bare "Index of /", a 390-byte
 * stub — so a status-code checker would have passed them. That, plus the
 * many municipalities that legitimately brand off-name
 * (discoverminnedosa.com, whereyoubelong.ca for Niverville,
 * ourhomeyourhome.ca for Brokenhead), is why there is no automated link
 * checker here: measured against this list, one would flag more good
 * entries than bad. Re-derive from the province's directory instead —
 * the next refresh follows the October 2026 municipal elections.
 *
 * The lookupMuniWebsite() helper below tolerates dash/diacritic
 * variants the data layer might use (e.g. en-dash vs hyphen, accented
 * É vs plain E), so a single canonical key here covers minor
 * formatting drift on the source side.
 */
const MUNI_WEBSITES = {
  // Cities
  'BRANDON (CITY)':              'https://www.brandon.ca/',
  'DAUPHIN (CITY)':              'https://www.dauphin.ca/',
  'FLIN FLON (CITY)':            'https://www.cityofflinflon.ca/',
  'MORDEN (CITY)':               'https://www.mymorden.ca/',
  'PORTAGE LA PRAIRIE (CITY)':   'https://www.city-plap.com/',
  'SELKIRK (CITY)':              'https://www.myselkirk.ca/',
  'STEINBACH (CITY)':            'https://www.steinbach.ca/',
  'THOMPSON (CITY)':             'https://www.thompson.ca/',
  'WINKLER (CITY)':              'https://www.winkler.ca/',
  'WINNIPEG (CITY)':             'https://www.winnipeg.ca/',

  // Towns
  'ALTONA (TOWN)':               'https://www.altona.ca/',
  'ARBORG (TOWN)':               'https://www.townofarborg.com/',
  'BEAUSEJOUR (TOWN)':           'https://www.townofbeausejour.com/',
  'CARBERRY (TOWN)':             'https://www.townofcarberry.ca/',
  // Carman and Dufferin share one amalgamated site. The old
  // carmandufferin.ca / carmanmanitoba.ca domains no longer resolve.
  'CARMAN (TOWN)':               'https://carmandufferin.com/',
  'CHURCHILL (TOWN)':            'https://www.churchill.ca/',
  'GILLAM (TOWN)':               'https://www.townofgillam.com/',
  // GRAND RAPIDS (TOWN) — no entry: townofgrandrapidsmb.ca stopped resolving
  // and no replacement was findable. An absent entry reads "Muni N/A", which
  // is honest; a dead one opens a browser error and looks like our bug.
  'LAC DU BONNET (TOWN)':        'https://www.townoflacdubonnet.com/',
  // LEAF RAPIDS (TOWN) — no entry: leafrapids.com is now a HugeDomains
  // for-sale page. Worst case in the whole list, since it returns HTTP 200
  // and so looks alive to any status-code check.
  'LYNN LAKE (TOWN)':            'https://www.lynnlake.ca/',
  'MELITA (TOWN)':               'https://www.melitamb.ca/',
  'MINNEDOSA (TOWN)':            'https://www.discoverminnedosa.com/',
  'MORRIS (TOWN)':               'https://www.townofmorris.ca/',
  'NEEPAWA (TOWN)':              'https://www.neepawa.ca/',
  'NIVERVILLE (TOWN)':           'https://www.whereyoubelong.ca/',
  'POWERVIEW-PINE FALLS (TOWN)': 'https://www.powerview-pinefalls.com/',
  'SNOW LAKE (TOWN)':            'https://www.snowlake.com/',
  'STE. ANNE (TOWN)':            'https://www.steannemb.ca/',
  'STONEWALL (TOWN)':            'https://www.stonewall.ca/',
  'SWAN RIVER (TOWN)':           'https://www.swanrivermanitoba.ca/',
  'TEULON (TOWN)':               'https://www.teulon.ca/',
  'THE PAS (TOWN)':              'https://www.townofthepas.ca/',
  'VIRDEN (TOWN)':               'https://www.virden.ca/',
  'WINNIPEG BEACH (TOWN)':       'https://www.winnipegbeach.ca/',

  // Rural Municipalities
  'ALEXANDER (RM)':              'https://www.rmalexander.com/',
  'ALONSA (RM)':                 'https://www.rmofalonsa.com/',
  'ARGYLE (RM)':                 'https://www.rmofargyle.ca/',
  'ARMSTRONG (RM)':              'https://www.rmofarmstrong.com/',
  'BROKENHEAD (RM)':             'https://www.ourhomeyourhome.ca/',
  'CARTIER (RM)':                'https://www.rmofcartier.ca/',
  'COLDWELL (RM)':               'https://www.lundar.ca/',
  'CORNWALLIS (RM)':             'https://www.gov.cornwallis.mb.ca/',
  'DAUPHIN (RM)':                'https://www.rmofdauphin.ca/',
  'DE SALABERRY (RM)':           'https://www.rmdesalaberry.mb.ca/',
  'DUFFERIN (RM)':               'https://carmandufferin.com/',
  'EAST ST. PAUL (RM)':          'https://www.eaststpaul.com/',
  'ELLICE-ARCHIE (RM)':          'https://www.rmofellicearchie.ca/',
  'ELTON (RM)':                  'https://www.elton.ca/',
  'FISHER (RM)':                 'https://www.rmoffisher.com/',
  'GIMLI (RM)':                  'https://www.gimli.ca/',
  'GRAHAMDALE (RM)':             'https://www.grahamdale.ca/',
  'GREY (RM)':                   'https://www.rmofgrey.ca/',
  'HANOVER (RM)':                'https://www.hanovermb.ca/',
  'HEADINGLEY (RM)':             'https://www.rmofheadingley.ca/',
  'KELSEY (RM)':                 'https://www.rmofkelsey.ca/',
  'LA BROQUERIE (RM)':           'https://www.labroquerie.com/',
  'LAC DU BONNET (RM)':          'https://www.rmoflacdubonnet.com/',
  'LAKESHORE (RM)':              'https://www.rmoflakeshore.ca/',
  'MACDONALD (RM)':              'https://www.rmofmacdonald.com/',
  'MINTO-ODANAH (RM)':           'https://www.discoverminnedosa.com/',
  'MONTCALM (RM)':               'https://www.rmofmontcalm.com/',
  'MORRIS (RM)':                 'https://www.rmofmorris.com/',
  'MOUNTAIN (RM)':               'https://www.rmofmountain.com/',
  'OAKVIEW (RM)':                'https://www.rmofoakview.ca/',
  'PINEY (RM)':                  'https://www.rmofpiney.mb.ca/',
  'PIPESTONE (RM)':              'https://www.rmofpipestone.com/',
  'PORTAGE LA PRAIRIE (RM)':     'https://www.rmofportage.ca/',
  'PRAIRIE LAKES (RM)':          'https://www.rmofprairielakes.ca/',
  'REYNOLDS (RM)':               'https://www.rmofreynolds.com/',
  'RIDING MOUNTAIN WEST (RM)':   'https://www.rmwest.ca/',
  'RITCHOT (RM)':                'https://www.ritchot.com/',
  'ROCKWOOD (RM)':               'https://www.rockwood.ca/',
  'ROLAND (RM)':                 'https://www.rmofroland.com/',
  'ROSEDALE (RM)':               'https://www.rmrosedale.com/',
  'ROSSER (RM)':                 'https://www.rmofrosser.com/',
  'SIFTON (RM)':                 'https://www.rmofsifton.com/',
  'SPRINGFIELD (RM)':            'https://www.rmofspringfield.ca/',
  'ST. ANDREWS (RM)':            'https://www.rmofstandrews.com/',
  'ST. CLEMENTS (RM)':           'https://www.rmofstclements.com/',
  'ST. FRANCOIS XAVIER (RM)':    'https://www.rm-stfrancois.mb.ca/',
  'ST. LAURENT (RM)':            'https://www.rmstlaurent.com/',
  'STANLEY (RM)':                'https://www.rmofstanley.ca/',
  'STE. ANNE (RM)':              'https://www.rmofsteanne.com/',
  'STUARTBURN (RM)':             'https://www.rmofstuartburn.com/',
  'TACHE (RM)':                  'https://www.rmtache.ca/',
  'THOMPSON (RM)':               'https://www.rmofthompson.com/',
  'VICTORIA (RM)':               'https://www.rmofvictoria.com/',
  'VICTORIA BEACH (RM)':         'https://www.rmofvictoriabeach.ca/',
  'WALLACE-WOODWORTH (RM)':      'https://www.wallace-woodworth.com/',
  'WEST INTERLAKE (RM)':         'https://www.rmofwestinterlake.com/',
  'WEST ST. PAUL (RM)':          'https://www.weststpaul.com/',
  'WHITEHEAD (RM)':              'https://www.rmofwhitehead.ca/',
  'WHITEMOUTH (RM)':             'https://www.rmwhitemouth.com/',
  'WOODLANDS (RM)':              'https://www.rmwoodlands.ca/',
  'YELLOWHEAD (MUNICIPALITY)':   'https://www.yellowheadmunicipality.ca/',

  // Municipalities (post-amalgamation single-tier)
  'BIFROST-RIVERTON (MUNICIPALITY)':       'https://www.bifrostriverton.ca/',
  'BOISSEVAIN-MORTON (MUNICIPALITY)':      'https://www.boissevain.ca/',
  'BRENDA-WASKADA (MUNICIPALITY)':         'https://brendawaskada.ca/',
  'CARTWRIGHT-ROBLIN (MUNICIPALITY)':      'https://cartwrightroblin.com/',
  // http only — the host's TLS handshake fails, but the site serves fine
  // over http. safeExternalUrl() permits http, so the link works; a plain
  // https entry here was silently unreachable.
  'CLANWILLIAM-ERICKSON (MUNICIPALITY)':   'http://www.ericksonmb.ca/',
  'DELORAINE-WINCHESTER (MUNICIPALITY)':   'https://www.delowin.ca/',
  'EMERSON-FRANKLIN (MUNICIPALITY)':       'https://www.emersonfranklin.com/',
  'ETHELBERT (MUNICIPALITY)':              'https://www.ethelbert.ca/',
  'GILBERT PLAINS (MUNICIPALITY)':         'https://www.gilbertplains.com/',
  'GLENBORO-SOUTH CYPRESS (MUNICIPALITY)': 'https://www.glenboro.com/',
  'GLENELLA-LANSDOWNE (MUNICIPALITY)':     'https://www.glenella.ca/',
  'GRANDVIEW (MUNICIPALITY)':              'https://grandviewmanitoba.com/',
  'GRASSLAND (MUNICIPALITY)':              'https://www.grasslandmunicipality.ca/',
  'HAMIOTA (MUNICIPALITY)':                'https://www.hamiota.com/',
  'HARRISON PARK (MUNICIPALITY)':          'https://www.harrisonpark.ca/',
  'KILLARNEY TURTLE MOUNTAIN (MUNICIPALITY)': 'https://www.killarney.ca/',
  'LORNE (MUNICIPALITY)':                  'https://www.lornemb.ca/',
  'LOUISE (MUNICIPALITY)':                 'https://www.louisemb.com/',
  'MCCREARY (MUNICIPALITY)':               'https://www.exploremccreary.com/',
  'MINITONAS-BOWSMAN (MUNICIPALITY)':      'https://www.minitonas-bowsman.ca/',
  'MOSSEY RIVER (MUNICIPALITY)':           'https://www.mosseyrivermunicipality.com/',
  'NORFOLK TREHERNE (MUNICIPALITY)':       'https://www.treherne.ca/',
  // NORTH CYPRESS-LANGFORD — no entry: rmofnorthcypress.ca stopped resolving
  // and the obvious amalgamated spellings do not exist either.
  'NORTH NORFOLK (MUNICIPALITY)':          'https://www.northnorfolk.ca/',
  'OAKLAND-WAWANESA (MUNICIPALITY)':       'https://www.oakland-wawanesa.ca/',
  'PEMBINA (MUNICIPALITY)':                'https://www.pembina.ca/',
  'PRAIRIE VIEW (MUNICIPALITY)':           'https://www.myprairieview.ca/',
  'RHINELAND (MUNICIPALITY)':              'https://www.rmofrhineland.com/',
  'RIVERDALE (MUNICIPALITY)':              'https://www.riversdaly.ca/',
  'ROBLIN (MUNICIPALITY)':                 'https://www.roblinmanitoba.com/',
  'ROSSBURN (MUNICIPALITY)':               'https://www.rossburn.ca/',
  'RUSSELL-BINSCARTH (MUNICIPALITY)':      'https://www.russellbinscarth.com/',
  'SOURIS-GLENWOOD (MUNICIPALITY)':        'https://www.sourismanitoba.com/',
  'STE. ROSE (MUNICIPALITY)':              'https://www.sterose.ca/',
  // SWAN VALLEY WEST — no entry: munswanvalleywest.ca now answers with a
  // self-signed cert fronting a router admin login, not a municipal site.
  'TWO BORDERS (MUNICIPALITY)':            'https://www.twoborders.ca/',
  'WESTLAKE-GLADSTONE (MUNICIPALITY)':     'https://www.westlake-gladstone.ca/',

  // Villages
  'DUNNOTTAR (VILLAGE)':                   'https://www.dunnottar.ca/',
  'ST. PIERRE-JOLYS (VILLAGE)':            'https://www.villagestpierrejolys.ca/',

  // Local Government Districts
  'MYSTERY LAKE (LGD)':                    'https://www.lgdofmysterylake.ca/',
  'PINAWA (LGD)':                          'https://www.pinawa.com/',
};

/** Normalize a Muni_Name_With_Typ for tolerant lookup: uppercase, strip
 *  diacritics (é → e), normalize en-/em-dashes to hyphen-minus, strip
 *  periods, collapse whitespace. Used on both sides of the lookup so
 *  punctuation/accent drift in the source data doesn't break the match.
 *
 *  Roll_Entry stores muni names WITHOUT periods ("ST CLEMENTS (RM)",
 *  "EAST ST PAUL (RM)", "STE ANNE (RM)") but the MUNI_WEBSITES dict
 *  spells them with periods ("ST. CLEMENTS (RM)", etc.) to match how
 *  appraisers and Manitoba's municipal directory format the names.
 *  Without the period strip, every St./Ste. muni misses the lookup
 *  and the Muni Website button reads "N/A" — the bug the user spotted
 *  on St. Clements / St. Andrews / St. François Xavier.
 *
 *  The CSV-side normalizer (normalizeMuniFromCsv, line ~2840) already
 *  strips periods for the same reason. */
function normalizeMuniKey(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritics
    .toUpperCase()
    .replace(/[‐-―−]/g, '-') // any unicode dash → hyphen-minus
    .replace(/\./g, '')      // strip periods: "ST." → "ST", "STE." → "STE"
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look up the website URL for a given Muni_Name_With_Typ. Tries exact
 *  match first, then a normalized match against a normalized index of
 *  the MUNI_WEBSITES keys. Returns null when nothing matches. */
let _muniIndex = null;
function lookupMuniWebsite(muniNameWithTyp) {
  if (!muniNameWithTyp) return null;
  if (MUNI_WEBSITES[muniNameWithTyp]) return MUNI_WEBSITES[muniNameWithTyp];
  if (_muniIndex === null) {
    _muniIndex = new Map();
    for (const [k, v] of Object.entries(MUNI_WEBSITES)) {
      _muniIndex.set(normalizeMuniKey(k), v);
    }
  }
  return _muniIndex.get(normalizeMuniKey(muniNameWithTyp)) || null;
}

/**
 * Planning District website URLs. Keyed on a normalized form of the
 * PLANNINGDISTRICT value: uppercased, with any trailing
 * " PLANNING DISTRICT" suffix stripped, whitespace collapsed. The
 * lookup helper (lookupPdWebsite below) does the normalization on the
 * incoming value too, so the map keeps short canonical names.
 *
 * Sourced from the province's official PD contact directory. PDs whose
 * contact information is only an email at a generic host (mymts.net,
 * gmail.com) or whose communications are routed through a member RM
 * are intentionally omitted — those would need a separate phone/email
 * UI rather than a "website" button. Extend as more come online.
 */
const PD_WEBSITES = {
  // From the Manitoba PD contact directory (websites or unmistakable
  // PD-specific email-domain → website inferences):
  // BROKENHEAD RIVER — no entry: brpd.ca exists but its nameservers are
  // Microsoft 365's (ns*.bdm.microsoftonline.com) with no A record on the
  // apex or www. The domain is registered for email only; there is no site.
  // http only — port 443 on cdgplanning.com does not accept connections
  // (port 80 serves the site fine). Same shape as CLANWILLIAM-ERICKSON above.
  'CARMAN-DUFFERIN-GREY':              'http://www.cdgplanning.com/',
  'CYPRESS':                           'https://www.cypressplanningdistrict.com/',
  // EASTERN INTERLAKE — no entry: eipd.ca is email-only, same Microsoft 365
  // nameservers and no A record as BROKENHEAD RIVER above.
  // INLAND PORT SPECIAL PLANNING AREA is an area name, not a PD, but it
  // out-votes SOUTH INTERLAKE 17-to-7 in RM of Rosser's dev-plan polygons
  // and updatePdWebsiteButton takes the most frequent PLANNINGDISTRICT
  // value — so without an entry here the button dead-ends. Rosser is a
  // South Interlake member, hence the same URL. MUNI_TO_PD can't rescue
  // it; that fallback only fires when the dev-plan layer returns nothing.
  'INLAND PORT SPECIAL PLANNING AREA': 'https://www.sipd.ca/',
  'KEYSTONE':                          'https://www.keystonepd.ca/',
  'MID-WEST':                          'https://www.midwestplanning.ca/',
  'MORDEN/STANLEY/THOMPSON/WINKLER':   'https://www.mstw.ca/',
  'M.S.T.W':                           'https://www.mstw.ca/',
  'MSTW':                              'https://www.mstw.ca/',
  'NEEPAWA & AREA':                    'https://www.neepawaareaplanning.com/',
  'PORTAGE LA PRAIRIE':                'https://www.ptgplanningdistrict.ca/',
  // RHINELAND / PLUM COULEE / GRETNA / ALTONA (all three key spellings) —
  // no entry: rpgamb.ca serves a bare "Index of /" directory listing. It
  // returns HTTP 200, so only a content check catches it.
  'RED RIVER':                         'https://www.rrpd.ca/',
  'SOUTH CENTRAL':                     'https://www.scpd.ca/',
  'SOUTH INTERLAKE':                   'https://www.sipd.ca/',
  // TRANS CANADA WEST — no entry: tcwpd.ca returns a 390-byte stub whose
  // entire body is the string "TCWPD". Also HTTP 200.
  'TRI-ROADS':                         'https://www.triroads.ca/',
  // PDs administered through a member RM rather than their own site —
  // pointed at the RM's planning page so the button still reaches the
  // right office:
  'LAC DU BONNET':                     'https://www.lacdubonnet.com/',
  'LAKESHORE':                         'https://www.rmofdauphin.ca/',
  'MACDONALD - RITCHOT':               'https://www.ritchot.com/',
  'MACDONALD-RITCHOT':                 'https://www.ritchot.com/',
  'MOUNTAIN VIEW':                     'https://www.gilbertplains.com/',
  'KELSEY':                            'https://www.townofthepas.ca/',
  'THOMPSON':                          'https://www.thompson.ca/',
  'WHITE HORSE PLAINS':                'https://www.rmofcartier.ca/',
  'WINNIPEG RIVER':                    'https://www.rmalexander.com/',
  // PDs whose contact is only a generic-host email (no PD-specific
  // website on file): DENNIS COUNTY, FISHER ARMSTRONG, PELICAN-ROCK
  // LAKE, SOUTHWEST, SWAN VALLEY, TANNER'S CROSSING, WESTERN INTERLAKE,
  // WHITEMOUTH REYNOLDS. Add when a website is published.
};

/** Normalize a PLANNINGDISTRICT value the way PD_WEBSITES is keyed.
 *  Uppercase, drop a trailing " PLANNING DISTRICT", collapse whitespace.
 *  Returns the empty string for nullish input so the lookup fall-through
 *  is uniform. */
function normalizePdKey(name) {
  if (!name) return '';
  return String(name)
    .toUpperCase()
    .replace(/\s+PLANNING\s+DISTRICT\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Try the normalized key first, then the raw value as a fallback for
 *  any PD whose name we happen to have in the source format. */
function lookupPdWebsite(pdName) {
  if (!pdName) return null;
  const norm = normalizePdKey(pdName);
  return PD_WEBSITES[norm] || PD_WEBSITES[pdName] || null;
}

// Most recent table rows, kept around for CSV export.
let currentRows = [];

// Minimum coverage share for a parcel's SECONDARY zoning to count as
// real rather than boundary-digitization slop. Read by BOTH the grid's
// Zoning 2 cell and the sales zoning-code filter — one constant so the
// screen and the filter can never disagree about whether a sliver zone
// exists (they once did: the filter matched a sub-1% commercial sliver
// the grid correctly hid, and the row looked like a filter bug).
const ZONE2_MIN_RATIO = 0.01;

// Page size + current pagination index for the results grid. Big
// result sets (200+ comp uploads, muni-wide overlay searches) are
// paginated client-side so the DOM stays light. Declared at module
// top rather than inline near renderTable so renderTable (and any
// other early code path) can read them without hitting TDZ.
const PAGE_SIZE = 100;
let currentPage = 0;
const $paginator = document.getElementById('results-paginator');

// row key -> the Feature whose geometry we should fly to when the user
// clicks that row. Cleared on every renderTable.
const rowFeatureMap = new Map();

// Cached overlay FCs from the most recent search, so toggling the zoning
// or dev-plan layer on doesn't require re-running the spatial enrichment.
let lastZoningFc = EMPTY_FC;
let lastDevPlanFc = EMPTY_FC;
// Most recent parcel result set pushed to the map — drives the Parcel
// Snapshots (ZIP) export. Updated by every setMapData() call.
let lastResultFc = EMPTY_FC;
// What the last setMapData() push did to the highlight geometry under an
// active as-of date: {swapped, missing, missingRolls}, or null when no
// Historical snapshot is in force. Read by the search's status line.
let lastAsOfHighlight = null;
// Result of the most recent boundary-withholding pass, for the status line —
// same role lastAsOfHighlight plays for the as-of swap. See
// lib/withheldGeometry.js.
let lastWithheldGeometry = null;
// CSV-upload mode state. csvFullRows holds the full enriched row set
// from the last sales-CSV upload (with zoning / dev-plan / risk-area
// data joined in), so changing the Other Searches filters after upload
// can re-filter against the same data without another round-trip.
// null means "not in CSV mode" — Other Searches filter changes do
// nothing in that state, matching the old runSearch-only behaviour.
let csvFullRows = null;
let csvFullBaseMsg = '';
// Invalidates in-flight sales enrichment when a newer upload or a regular
// property search replaces the displayed parcel set.
let salesEnrichmentGeneration = 0;
// Sales exports are enabled only after Soil Survey enrichment has finished.
// A timeout/partial response must not turn into authoritative-looking blank
// CLI and soil columns in the export.
let salesExportEnrichmentComplete = true;
// Full list of munis matched by the last sales-CSV upload — populated
// in handleSalesUpload, cleared on runSearch. When non-null, the
// MASC and CLI overlay toggles fetch+merge across every muni in this
// list rather than scoping to the single dropdown value. The dropdown
// still drives the dominant-muni affordances (Muni Website, PD
// Website, Roll Layer), but the soil overlays cover the full upload.
let csvMatchedMunis = null;

// Latched by the Agricultural column preset — see wantsTileData(). It
// lives up here with the other module state rather than beside its
// readers because renderTable() reads it (via wantsWaterRightsEnrichment)
// on paths that can run during module init, and a `let` declared further
// down would be in its temporal dead zone at that point.
let waterRightsWantedForGrid = false;

// Imported parcel list. Populated by the "Import list…" modal once
// the resolver returns parcelKeys; runSearch reads this in front of
// the legal-search branch and feeds the keys straight into
// searchParcels({parcelKeys}). null = not in list mode (normal
// muni/roll/legal flow); non-null Array<{muni_no, roll_no_txt}> means
// the next Search will fetch exactly those parcels across whichever
// munis the resolver identified. Cleared by the pill's × button or by
// a page reload (clearAll() reloads, so it resets implicitly).
let listParcelKeys = null;
// Municipality names represented by the parcels returned for the active
// property-list import. The main municipality picker intentionally stays at
// "Any municipality", so this separate scope lets the MASC and CLI loaders
// cover every municipality in the list without reintroducing a search filter.
let listMatchedMunis = null;
// The unresolved rows from the same import — surfaced in the
// unmatched-records drawer (renderUnmatchedPanel) so the user can see
// at a glance which input rows didn't resolve and why.
let listUnresolvedRows = null;
// Site/Comp # tagging for a parcel-list import: Map("muni_no|roll_no_txt"
// → site label) built from the resolver's output when the import mapped a
// Site column. runSearch stamps _siteNo from this onto the fetched
// parcels so the numbering uses the caller's site labels instead of the
// auto 1..N sequence. null when the import had no Site column.
let listSiteByKey = null;

// Route planner state. routeStart is { lng, lat } once the user has
// clicked the map. routeResult holds the last calculated TSP order +
// geometry + per-leg metrics for both the on-screen panel and the
// print itinerary. routeRoundTrip mirrors the panel toggle. All three
// reset when the import-list pill is cleared.
let routeStart = null;
let routeResult = null;
let routeRoundTrip = true;
// Starred-comps routing ("Route Starred" button). When routeStarredOnly is
// true the planner's stop set is the unique starred parcels instead of every
// row; routeStartExcludeKey drops the parcel doubling as the start point (so
// the Matrix/Directions calls never see two identical coordinates); and
// routeStartLabel replaces the bare start coordinates in the panel with the
// roll that was auto-picked. All reset by clearRoutePlanner().
let routeStarredOnly = false;
let routeStartExcludeKey = null;
let routeStartLabel = null;

// Subject parcel state. setSubjectParcel() / clearSubjectParcel()
// drive these alongside the map source and re-stamp distances onto
// the current CSV row set whenever they change.
let subjectFeature = null;
let subjectCentroid = null;   // { lng, lat } — bbox midpoint, good enough for km-scale distance

// Recent uploads — last N sales CSVs cached in localStorage. Each
// entry is { name, text, ts } where `text` is the raw CSV content.
// 13–50 KB per CSV is realistic, so 5 entries comfortably fits under
// localStorage's typical 5 MB quota.
const RECENT_STORAGE_KEY = 'mb_recent_sales_csvs_v1';
const RECENT_CAP = 5;
function loadRecentUploads() {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, RECENT_CAP) : [];
  } catch { return []; }
}
function saveRecentUploads(list) {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list.slice(0, RECENT_CAP)));
  } catch { /* quota errors — best-effort */ }
}
function rememberUpload(name, text) {
  if (!name || !text) return;
  // De-dup by name, keep newest at the front. Re-uploading the same
  // file refreshes the timestamp + the cached text (handy when the
  // CSV gets fresh sales between sessions).
  const list = loadRecentUploads().filter((e) => e.name !== name);
  list.unshift({ name, text, ts: Date.now() });
  saveRecentUploads(list);
  populateRecentUploads();
}

// Favourites — persisted in localStorage as a Set of "muni_no|roll_no_txt"
// keys (same shape as parcelLegalKey). Survives reloads so the user
// can star a comp, refresh the page, re-upload the same CSV, and the
// stars come back. Capped at FAV_CAP entries to avoid runaway growth.
const FAV_STORAGE_KEY = 'mb_favorite_sales_v1';
const FAV_CAP = 500;
const favoriteKeys = loadFavorites();
function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAV_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.slice(0, FAV_CAP) : []);
  } catch { return new Set(); }
}
function saveFavorites() {
  try {
    localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...favoriteKeys]));
  } catch { /* quota / private mode — best-effort, the in-memory Set still works */ }
}

// Tracks which muni's zoning / dev-plan polygons are currently loaded
// in each map source. Lets a Zoning Layer / Dev Plan Layer toggle
// short-circuit when the displayed muni already matches the dropdown
// (avoiding a redundant refetch), and lets a muni dropdown change
// trigger a refresh when those layers are visible.
let zoningLayerLoadedFor = null;
let devPlanLayerLoadedFor = null;
// True while the current result set was built WITHOUT dev-plan data, so
// its Dev Plan column, popup line and export cells are blank pending an
// explicit load. Set by handleSalesUpload, cleared once backfilled.
let devPlanDeferred = false;

// ---------- Column sort ----------

let currentSort = { col: 'roll', dir: 'asc' };

// Parcel numbering on/off (the "Number parcels" toggle). Off by default
// per the user's choice. Persists across searches within a session so a
// user who wants numbered comp maps keeps them for every subsequent
// multi-parcel search; the "#" values themselves are fixed to each
// parcel at search time (lib/parcelNumbering.js), so re-sorting or
// filtering the grid never renumbers them.
let numberingOn = false;

// Number in the order the rolls were TYPED, rather than by muni + roll #
// (the "Entry order" checkbox beside "Number parcels"). Opt-in, and only
// offered when the result set came from an explicit Roll # list — see
// enteredRollOrder below.
let numberingEntryOrder = false;

// Roll → position in the Roll # field, captured at search time.
// `Map<canonicalRoll, rollIndex>`; null whenever the current result set
// didn't come from a typed roll list, which is what hides the checkbox.
//
// One position per roll: every roll typed into the field is its own parcel,
// whichever separator sits between them, so each consumes its own number.
let enteredRollOrder = null;

// Has a search (or an import) put results on the map this session? Gates the
// click-a-municipality picker: Jason's rule is that pointing at the map picks
// a muni only BEFORE any search has run, and Clear is what re-arms it. Clear
// reloads the page, so nothing has to reset this by hand.
let searchHasRun = false;

// The muni picker's handle, so disarmSearchPicker() can reach it.
let muniPicker = null;

/**
 * Trip the "a search has run" gate and drop the picker's hover state in the
 * same breath.
 *
 * The gate alone isn't enough: the hover tint and pointer cursor are cleared
 * by the layer's own mousemove/mouseleave handlers, and neither fires if the
 * search was started without the mouse leaving the map — Enter in the Roll #
 * field with the cursor parked over a municipality, say. That left a
 * municipality lit up and looking clickable when it no longer was.
 */
function disarmSearchPicker() {
  searchHasRun = true;
  muniPicker?.refresh();
}

const SORT_KEYS = {
  // Map # — the stable 1..N callout number (muni then Roll #). Sorting
  // this column returns the grid to the map's numbering order.
  seq:     (r) => finiteOrNeg(r.parcel.properties._seq),
  roll:    (r) => strKey(r.parcel.properties.Roll_No_Txt),
  // Muni # is the MAO authority code (e.g. 600 for RM of Headingley).
  // Numeric sort so 600 lines up between 500 and 700, not between 6
  // and 7 as a string sort would put it.
  municode: (r) => finiteOrNeg(muniNoFromProps(r.parcel.properties)),
  muniname: (r) => strKey(muniNameFromProps(r.parcel.properties)),
  address: (r) => strKey(r.parcel.properties.Property_Address),
  legal:   (r) => strKey(legalDisplay(r.parcel.properties)),
  title:   (r) => strKey(r.parcel.properties._certificatesOfTitle),
  zone1:   (r) => strKey(r.zoning[0]?.feature.properties.ZONE),
  // Sort on the DISPLAYED (normalized) type, so the typo'd polygons sort
  // with their own category rather than into a group of one.
  zonecat: (r) => strKey(
    r.zoning.length ? zoneCategoryLabel(r.zoning[0]?.feature.properties.ZONE_CATEGORY) : '',
  ),
  zone1pct:(r) => finiteOrNeg(r.zoning[0]?.ratio),
  zone2:   (r) => strKey(r.zoning[1]?.feature.properties.ZONE),
  zbl:     (r) => strKey(r.zoning[0]?.feature.properties.ZBL),
  dev1:    (r) => strKey(r.devPlan[0]?.feature.properties.DES_NAME),
  dpbylaw: (r) => strKey(r.devPlan[0]?.feature.properties.DP_BYLAW),
  // Sort by MASC rating (A best → J worst). Empty cells go last.
  soil:     (r) => strKey(r.parcel.properties._soilRating),
  riskarea: (r) => finiteOrNeg(r.parcel.properties._soilRiskArea),
  // Tile drainage sorts by coverage share, so the most heavily tiled
  // parcels group at one end. Parcels with a licensed area but no usable
  // ratio still beat parcels with none; both beat "never checked".
  tile:     (r) => {
    const hit = r.parcel.properties._tileDrainage;
    if (!hit) return -1;
    return Number.isFinite(hit.ratio) ? hit.ratio : 0;
  },
  // Irrigation is a yes/no — the column only reports licensed points of
  // use — so this just groups the Yes rows together. Coverage share is a
  // stable tiebreak and nothing more; it is deliberately never shown,
  // because the polygon is a survey quarter (see irrigationCell).
  irrigation: (r) => {
    const hit = r.parcel.properties._irrigation;
    if (!hit) return -1;
    return Number.isFinite(hit.ratio) ? hit.ratio : 0;
  },
  // CLI capability + Soil Type sort by the dominant soil's
  // AGRI_CAP / SOILNAME from the stamped composition. Empty
  // composition (no Soil Survey / CLI overlay loaded) sorts last
  // via the ￿ sentinel in strKey.
  clicls:   (r) => strKey(dominantCliLabel(r.parcel.properties)),
  soiltype: (r) => strKey(dominantSoilTypeLabel(r.parcel.properties)),
  // Slope sorts by steepness rank, not by its label or raw code — see
  // slopeSortRank. The cell shows a RANGE, so the key is its steepest
  // class: that's the limiting factor for farmability and it's a bound
  // the user can actually see in the cell. Ascending is flattest-first,
  // with the unloaded cells last. Falls back to the dominant soil's
  // class when no component carries a real slope.
  slope:    (r) => {
    const range = parcelSlopeRange(r.parcel.properties);
    if (!range) return slopeSortRank(dominantSlopeCode(r.parcel.properties));
    // Flattest bound breaks ties on the steepest class, so two parcels
    // that both top out at 45% order by how much gentler ground they
    // have rather than by whatever the previous sort left behind. min
    // tops out at 100, so /1000 always stays inside one rank step.
    return slopeSortRank(range.steepestCode) + range.min / 1000;
  },
  // Land cover sorts by the dominant bucket's label; Cult % sorts on
  // the numeric cultivated fraction. Both read the per-parcel
  // `_landCover` stamp (only present on farmland parcels over the threshold);
  // parcels without it sort last (strKey sentinel / finiteOrNeg -1).
  landcover: (r) => strKey(dominantBucket(r.parcel.properties._landCover)?.label),
  cultpct:   (r) => finiteOrNeg(cultFraction(r.parcel.properties._landCover)),
  // Water sorts by class severity (Direct first, then Waterfront, Reserve,
  // Road Separated, Corridor Blocked, Unconfirmed), so the frontage parcels
  // group together at the top rather than being scattered alphabetically by
  // water-body name. Unstamped parcels rank last.
  water:     (r) => waterSortRank(r.parcel.properties._water),
  changes: (r) => strKey(formatChanges(r)),
  du:      (r) => finiteOrNeg(r.parcel.properties.Dwelling_Units),
  // Roll Frontage/Area holds two incommensurable things — areas in acres and
  // widths in feet — so a plain numeric sort would interleave 110 feet with
  // 110 acres as though they ranked against each other. Sort by unit first so
  // like groups with like, then numerically inside each group (zero-padded so
  // the string compare orders 9 before 80). Blank rolls sort last via strKey.
  rollsize: (r) => {
    const raw = String(r.parcel.properties.Frontage_or_Area ?? '').trim();
    const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]*)/);
    if (!m) return strKey(raw);
    const unit = (m[2] || 'zz').toLowerCase();
    return `${unit}:${Number(m[1]).toFixed(3).padStart(14, '0')}`;
  },
  // Sort on the figure the cell SHOWS — the sale-resolved size on a sales row
  // (lib/saleSize.js), today's acreage everywhere else. Sorting by today's
  // acreage while displaying the at-sale one would shuffle the column out of
  // order for exactly the subdivided parcels this path exists to get right.
  acres:   (r) => finiteOrNeg(rowSizeAcres(r.parcel.properties || {}, parcelAcres(r.parcel))),
  sf:      (r) => finiteOrNeg(rowSizeAcres(r.parcel.properties || {}, parcelAcres(r.parcel))),
  // Walkscore column is just a link — sort by whether we have an address
  // to send to walkscore.com (rows without an address sort last).
  walk:    (r) => strKey(r.parcel.properties.Property_Address),
  // Flood column sorts on whether the parcel has any geometry-derivable
  // location at all (lat/lon centroid OR a usable street address); rows
  // that can't deep-link sort last.
  flood:   (r) => strKey(r.parcel.geometry ? '1' : r.parcel.properties.Property_Address),
  streetview: (r) => strKey(r.parcel.geometry ? '1' : ''),
  value:   (r) => finiteOrNeg(parseTotalValue(r.parcel.properties.Total_Value)),
  report:  (r) => strKey(r.parcel.properties.Asmt_Rpt_Url),
  saledate:    (r) => strKey(r.parcel.properties._saleDate),
  saleprice:   (r) => finiteOrNeg(parseTotalValue(r.parcel.properties._salePrice)),
  primaryprop: (r) => strKey(r.parcel.properties._primaryProperty),
  saletype:    (r) => strKey(r.parcel.properties._saleTypeGroup),
  groupsize:    (r) => finiteOrNeg(r.parcel.properties._saleGroupSize),
  grouppricelot:(r) => finiteOrNeg(r.parcel.properties._saleGroupPpl),
  grouppriceac: (r) => finiteOrNeg(r.parcel.properties._saleGroupPpa),
  // Sorts on the raw total even when the cell renders an em-dash for an
  // incomplete group — a partial total is still the right sort position, and
  // parking those rows at the bottom would hide the biggest assemblies, which
  // are exactly the ones most likely to have a member missing its area.
  groupacres:   (r) => finiteOrNeg(r.parcel.properties._saleGroupTotalAcres),
  // Group SF is Group Acres × 43,560, so it sorts on the same underlying
  // total — the multiplier is positive and constant, so the ordering is
  // identical and converting first would only add rounding.
  groupsf:      (r) => finiteOrNeg(r.parcel.properties._saleGroupTotalAcres),
  grouppricesf: (r) => finiteOrNeg(r.parcel.properties._saleGroupPpsf),
  grouppriceff: (r) => finiteOrNeg(r.parcel.properties._saleGroupPpff),
  saletoasmt:   (r) => finiteOrNeg(r.parcel.properties._saleGroupSaleToAsmt),
  subjdist:     (r) => finiteOrNeg(r.parcel.properties._distanceKm),
  asmtland:     (r) => finiteOrNeg(r.parcel.properties._asmtLand),
  asmtbldg:     (r) => finiteOrNeg(r.parcel.properties._asmtBuildings),
  asmtpct:      (r) => finiteOrNeg(r.parcel.properties._asmtPctBldg),
  asmtyear:     (r) => finiteOrNeg(r.parcel.properties._asmtYear),
};

function strKey(v) {
  return (v == null || v === '') ? '￿' : String(v).toLowerCase();
}
function finiteOrNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : -Infinity;
}

/**
 * Roll-number display form. Manitoba ROLL_ENTRY stores Roll_No_Txt
 * as <digits>.<3-digit-sub>; the .000 sub is the most common form
 * and visually noisy, so we strip it for display only — actual
 * search/comparison logic continues to use the raw Roll_No_Txt and
 * the canonicalRoll() helper. Sub-rolls like .010 or .500 are kept
 * since those carry information.
 */
function displayRoll(raw) {
  if (raw == null) return '';
  const s = String(raw);
  return s.endsWith('.000') ? s.slice(0, -4) : s;
}

/**
 * Extract the MAO muni code (the integer prefix in the Municipality
 * field) from a parcel's properties. Returns the number or null when
 * the field is missing / malformed.
 * Example: "600 - RM OF HEADINGLEY" → 600.
 */
function muniNoFromProps(props) {
  const m = String(props?.Municipality || '').match(/^\s*(\d+)\s*-/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Display name for the parcel's municipality, in Roll_Entry's
 * name-first format: "HEADINGLEY (RM)". Preferred over the
 * "RM OF HEADINGLEY" half of the Municipality field because it sorts
 * by place rather than by type prefix, and it echoes the search
 * dropdown, which is built from the same Muni_Name_With_Typ values
 * (Jason, 2026-08-17). Falls back to Municipality with its numeric
 * prefix stripped should a record arrive without the field.
 */
function muniNameFromProps(props) {
  const typ = String(props?.Muni_Name_With_Typ || '').trim();
  if (typ) return typ;
  const raw = String(props?.Municipality || '').trim();
  if (!raw) return null;
  return raw.replace(/^\s*\d+\s*-\s*/, '') || raw;
}

function sortRows(rows) {
  const { col, dir } = currentSort;
  const key = SORT_KEYS[col];
  if (!key) return rows;
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const aBlank = ka === '￿' || ka === -Infinity;
    const bBlank = kb === '￿' || kb === -Infinity;
    if (aBlank && bBlank) return 0;
    if (aBlank) return 1;
    if (bBlank) return -1;
    if (ka < kb) return -mul;
    if (ka > kb) return mul;
    return 0;
  });
}

function updateSortIndicators() {
  for (const th of document.querySelectorAll('#results th[data-col]')) {
    if (th.dataset.col === currentSort.col) {
      th.setAttribute('aria-sort', currentSort.dir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  }
}

// ---------- Init ----------

const { map, ready: mapReady } = initMap($mapEl, {
  onFeatureClick: scrollToRow,
  onPlacePick: handlePlacePick,
});
if (import.meta.env?.DEV) window.__map = map;   // dev-only handle for debugging

// Hide-map toggle. Collapses the map-pane via the .map-collapsed
// class on the workspace so the results table claims the full
// workspace. The user's choice persists to localStorage so a
// refresh keeps it consistent. mapReady gates the map.resize()
// call when the map is restored so MapLibre recomputes its canvas.
const MAP_HIDE_KEY = 'mbps_map_collapsed_v1';
const MAP_EXPAND_KEY = 'mbps_map_expanded_v1';
const $workspaceEl = document.getElementById('workspace');
const $mapToggleBtn = document.getElementById('map-toggle-btn');
const $mapToggleLabel = $mapToggleBtn?.querySelector('.map-toggle-label');
const $mapExpandBtn = document.getElementById('map-expand-btn');
const $mapExpandLabel = $mapExpandBtn?.querySelector('.map-expand-label');

function applyMapCollapsed(collapsed) {
  if (!$workspaceEl || !$mapToggleBtn) return;
  // Hide and Expand are mutually exclusive — hiding implicitly
  // un-expands so we don't leave the workspace carrying two
  // contradictory layout classes.
  if (collapsed && $workspaceEl.classList.contains('map-expanded')) {
    applyMapExpanded(false, { silent: true });
  }
  $workspaceEl.classList.toggle('map-collapsed', collapsed);
  $mapToggleBtn.setAttribute('aria-pressed', String(collapsed));
  if ($mapToggleLabel) $mapToggleLabel.textContent = collapsed ? 'Show Map' : 'Hide Map';
  if (!collapsed) {
    // Restoring the map: MapLibre needs to recompute its canvas
    // size now that the container is back in the layout.
    mapReady.then(() => map.resize());
  }
  try { localStorage.setItem(MAP_HIDE_KEY, collapsed ? '1' : '0'); } catch {}
}

function applyMapExpanded(expanded, { silent = false } = {}) {
  if (!$workspaceEl || !$mapExpandBtn) return;
  // Expand and Hide are mutually exclusive — expanding implicitly
  // un-hides so a refresh that restored both prefs from localStorage
  // doesn't render with the map both hidden AND expanded.
  if (expanded && $workspaceEl.classList.contains('map-collapsed')) {
    applyMapCollapsed(false);
  }
  $workspaceEl.classList.toggle('map-expanded', expanded);
  $mapExpandBtn.setAttribute('aria-pressed', String(expanded));
  if ($mapExpandLabel) $mapExpandLabel.textContent = expanded ? 'Restore Map' : 'Expand Map';
  // MapLibre needs to recompute its canvas size now that the
  // container's aspect-ratio + width-cap have changed.
  mapReady.then(() => map.resize());
  if (!silent) {
    try { localStorage.setItem(MAP_EXPAND_KEY, expanded ? '1' : '0'); } catch {}
  }
}

if ($mapToggleBtn) {
  $mapToggleBtn.addEventListener('click', () => {
    const next = !$workspaceEl.classList.contains('map-collapsed');
    applyMapCollapsed(next);
  });
  try {
    if (localStorage.getItem(MAP_HIDE_KEY) === '1') applyMapCollapsed(true);
  } catch {}
}

if ($mapExpandBtn) {
  $mapExpandBtn.addEventListener('click', () => {
    const next = !$workspaceEl.classList.contains('map-expanded');
    applyMapExpanded(next);
  });
  try {
    if (localStorage.getItem(MAP_EXPAND_KEY) === '1') applyMapExpanded(true);
  } catch {}
}

// Sidebar tabs. Restores the last-active tab from localStorage so a
// refresh keeps the user where they left off.
initSidebarTabs();
// Data Status dialog (top-bar button) — loads its data on first open.
initDataStatusDialog();

/**
 * Park the map-options toggles (Number parcels, Include legend) at the
 * right-hand end of the active tab's action row, beside its Clear
 * button.
 *
 * Both toggles apply to either kind of result, but there are two
 * action rows — Search + Clear on Property, Clear on Sales — and only
 * one of each toggle can exist, since a duplicated id is a broken
 * checkbox. So the row MOVES with the active tab rather than being
 * copied into both. That keeps a single source of truth for the
 * checked state: switching tabs mid-session carries the toggle's
 * state across with the element itself, no syncing required.
 */
function placeMapOptionsRow(tab) {
  const row = document.getElementById('numbering-row');
  if (!row) return;
  const panel = document.querySelector(`.sidebar-tab-panel[data-tab="${tab}"]`);
  const actionRow = panel?.querySelector(':scope > .action-row');
  if (actionRow && row.parentElement !== actionRow) actionRow.appendChild(row);
}
onTabChange(placeMapOptionsRow);
placeMapOptionsRow(getActiveTab());

// Roll # chip input. The hidden #roll input keeps holding the
// canonical comma-separated string, so existing $roll.value
// reads continue to work. Enter on an empty text input runs
// search (mirrors the legacy Enter-runs-search binding).
const $rollChip = document.querySelector('.chip-input[data-target="roll"]');
if ($rollChip) initChipInput($rollChip, { onEnterEmpty: () => runSearch() });

// Roll Entry name→muni_no reconciler for the Import-List "Municipality
// (name)" column (the sales-export shape: "RM OF SPRINGFIELD" + roll).
// Injected into the import modal's resolver so the parser/resolver stay
// free of arcgis.js. Groups the requested rolls by normalized muni name,
// fires one searchParcels({municipality, roll}) per muni (the same path
// handleSalesUpload uses), then maps each matched feature back to its
// input line by canonical roll, emitting {muni_no, roll_no_txt}. Misses
// return a human reason so the unresolved drawer can explain them.
async function resolveMuniNamesForImport(rows) {
  const resolvedByLine = new Map();
  const unresolvedByLine = new Map();
  // The municipality dropdown holds Roll Entry's canonical
  // Muni_Name_With_Typ values — the names searchParcels matches on
  // exactly, and so the candidate list for the fuzzy reconciliation.
  const knownMunis = $municipality
    ? Array.from($municipality.options).map((o) => o.value).filter(Boolean)
    : [];

  // Bucket by candidate municipality; drop rows whose name or roll is bad.
  // A bare name that fits several municipalities ("MORRIS" — both a Town
  // and an RM) is queried against each, and the roll # decides.
  const byMuni = new Map();           // canonical muni name → [{ lineNo, roll }]
  const candidatesByLine = new Map(); // lineNo → canonical names being tried
  for (const r of rows || []) {
    let candidates = matchMuniNameCandidates(r.muniName, knownMunis);
    if (candidates.length === 0) {
      // Nothing matched — either the dropdown hasn't loaded yet or the
      // name isn't one Roll Entry publishes. Fall back to the strict
      // prefix/suffix conversion so a well-formed "RM OF X" still goes
      // out on its own, exactly as it did before fuzzy matching.
      const strict = normalizeMuniFromCsv(r.muniName);
      if (strict) candidates = [strict];
    }
    if (candidates.length === 0) {
      unresolvedByLine.set(r.lineNo, `Municipality not recognised: "${r.muniName}"`);
      continue;
    }
    const roll = canonicalRoll(String(r.roll || ''));
    if (!roll) {
      unresolvedByLine.set(r.lineNo, 'Row has no usable roll #');
      continue;
    }
    candidatesByLine.set(r.lineNo, candidates);
    for (const muni of candidates) {
      if (!byMuni.has(muni)) byMuni.set(muni, []);
      byMuni.get(muni).push({ lineNo: r.lineNo, roll });
    }
  }

  // One live lookup per candidate muni. Hits and misses are collected per
  // line rather than written straight to the output maps — a row with two
  // candidates legitimately misses in one of them.
  const hitsByLine = new Map();   // lineNo → [{ muni, hit }]
  const missByLine = new Map();   // lineNo → first miss reason seen
  await Promise.all([...byMuni.entries()].map(async ([muni, recs]) => {
    const rollList = [...new Set(recs.map((r) => r.roll))].join(',');
    let fc = { features: [] };
    try {
      fc = await searchParcels({ municipality: muni, roll: rollList });
    } catch (err) {
      for (const r of recs) {
        if (!missByLine.has(r.lineNo)) missByLine.set(r.lineNo, `Lookup failed for ${muni}: ${err.message || err}`);
      }
      return;
    }
    // Index returned features by canonical Roll_No_Txt → {muni_no, roll}.
    const byRoll = new Map();
    for (const f of fc.features || []) {
      const key = parcelLegalKey(f.properties || {});
      const rtxt = f.properties?.Roll_No_Txt;
      if (!key || !rtxt) continue;
      byRoll.set(canonicalRoll(String(rtxt)), {
        muni_no: Number(key.split('|')[0]),
        roll_no_txt: String(rtxt),
      });
    }
    for (const r of recs) {
      const hit = byRoll.get(r.roll);
      if (hit) {
        if (!hitsByLine.has(r.lineNo)) hitsByLine.set(r.lineNo, []);
        hitsByLine.get(r.lineNo).push({ muni, hit });
      } else if (!missByLine.has(r.lineNo)) {
        missByLine.set(r.lineNo, `Roll ${displayRoll(r.roll)} not found in Roll Entry for ${muni}`);
      }
    }
  }));

  for (const [lineNo, candidates] of candidatesByLine) {
    const hits = hitsByLine.get(lineNo) || [];
    if (hits.length === 1) {
      resolvedByLine.set(lineNo, hits[0].hit);
    } else if (hits.length > 1) {
      // The roll exists in more than one municipality the bare name fits.
      // Genuinely ambiguous — say so rather than picking one.
      unresolvedByLine.set(
        lineNo,
        `Roll matches ${hits.length} municipalities (${hits.map((h) => h.muni).join(', ')}) — qualify the name or supply a Muni #`,
      );
    } else {
      unresolvedByLine.set(
        lineNo,
        missByLine.get(lineNo) || `Roll not found in ${candidates.join(' or ')}`,
      );
    }
  }

  return { resolvedByLine, unresolvedByLine };
}

// Build the "muni_no|roll_no_txt" → Site-label map from the resolver's
// output. Only entries whose import row carried a Site value are kept;
// returns null when the import had no Site column so runSearch skips the
// stamping pass and the numbering falls back to the auto 1..N sequence.
function buildListSiteKeyMap(resolved) {
  const map = new Map();
  for (const r of resolved || []) {
    if (r.site == null || String(r.site).trim() === '') continue;
    if (!Number.isFinite(Number(r.muniNo)) || !r.roll) continue;
    map.set(`${Number(r.muniNo)}|${String(r.roll)}`, String(r.site).trim());
  }
  return map.size > 0 ? map : null;
}

// Parcel-list import. The trigger link beside the roll chip opens a
// modal that lets the user paste / upload a cross-muni parcel list;
// the resolver returns parcelKeys ready for searchParcels. Stashed
// in listParcelKeys + surfaced as a pill above the action row so a
// subsequent Search uses the imported set instead of muni+roll.
const importModal = initParcelListImport({
  warmIndex: () => warmLegalIndex(),
  canonicalRoll,
  resolveMuniNames: resolveMuniNamesForImport,
  // A municipality selected for an earlier property search would be
  // ANDed with the resolved parcel keys by the live Roll Entry query,
  // silently dropping imported rows from every other municipality.
  // Clear it as soon as the import input is accepted (Next or Recent)
  // and use the normal change event so all municipality-dependent UI
  // state is reset exactly as if the user chose "Any municipality".
  onInputAccepted: () => {
    if (!$municipality.value) return;
    $municipality.value = '';
    $municipality.dispatchEvent(new Event('change', { bubbles: true }));
  },
  onResolved: ({ parcelKeys, resolved, unresolved, stats }) => {
    if (!parcelKeys || parcelKeys.length === 0) {
      // Nothing usable — surface the failure inline and don't enter
      // list mode (the existing muni/roll inputs stay live).
      const reason = unresolved?.[0]?.reason
        || 'No rows could be resolved to a parcel.';
      setCount(`Import: 0 of ${stats?.total ?? 0} rows resolved — ${reason}`);
      listParcelKeys = null;
      listMatchedMunis = null;
      listUnresolvedRows = unresolved || [];
      listSiteByKey = null;
      renderListPill();
      renderListUnresolvedDrawer();
      resetMascAndGridToggles();
      resetMuniParcelsToggle();
      return;
    }
    listParcelKeys = parcelKeys;
    listMatchedMunis = null;
    listUnresolvedRows = unresolved || [];
    listSiteByKey = buildListSiteKeyMap(resolved);
    renderListPill();
    renderListUnresolvedDrawer();
    // Auto-run the search so the imported list lands on the map +
    // table immediately — matches the sales-upload flow's behaviour.
    runSearch();
  },
});
document.getElementById('parcel-list-import-trigger')
  ?.addEventListener('click', () => importModal.open());
document.getElementById('parcel-list-pill-clear')
  ?.addEventListener('click', () => {
    listParcelKeys = null;
    listMatchedMunis = null;
    listUnresolvedRows = null;
    listSiteByKey = null;
    renderListPill();
    renderListUnresolvedDrawer();
    resetMascAndGridToggles();
    // Drops the button back to disabled (the picker is still blank from
    // the import) and turns the fabric off, since its loadKey no longer
    // matches the now-empty scope.
    resetMuniParcelsToggle();
    clearRoutePlanner();
    setCount('Imported list cleared.');
  });

// Route planner — gated on list mode AND on the Mapbox token being
// configured. Without a token the trigger stays disabled with a
// tooltip telling the user how to enable it (matches the import-
// modal feature-degradation pattern).
const $routePlanTrigger = document.getElementById('route-plan-trigger');
if ($routePlanTrigger && !hasMapboxToken()) {
  $routePlanTrigger.disabled = true;
  $routePlanTrigger.title = 'Route planning needs a Mapbox token. Add VITE_MAPBOX_TOKEN to web/.env.local (see .env.example) and restart the dev server, or set it in your Vercel project env vars.';
}
$routePlanTrigger?.addEventListener('click', () => {
  // The generic planner routes EVERY loaded parcel. If a starred route
  // ran earlier, drop its stop filter and auto-start bookkeeping here —
  // otherwise this panel would silently keep routing only the starred
  // subset. The start point itself survives; only its "starred" framing
  // and exclusion go.
  routeStarredOnly = false;
  routeStartExcludeKey = null;
  routeStartLabel = null;
  openRoutePanel();
});
// Starred-comps one-click route. Same token gating as the trigger above.
const $routeStarredBtn = document.getElementById('route-starred');
if ($routeStarredBtn && !hasMapboxToken()) {
  $routeStarredBtn.title = 'Route planning needs a Mapbox token. Add VITE_MAPBOX_TOKEN to web/.env.local (see .env.example) and restart the dev server, or set it in your Vercel project env vars.';
}
$routeStarredBtn?.addEventListener('click', startStarredRoute);
document.getElementById('route-panel-close')
  ?.addEventListener('click', () => { hideRoutePanel(); });
document.getElementById('route-start-btn')
  ?.addEventListener('click', handleSetStart);
document.getElementById('route-calculate-btn')
  ?.addEventListener('click', handleCalculateRoute);
document.getElementById('route-recalc-btn')
  ?.addEventListener('click', handleCalculateRoute);
document.getElementById('route-print-btn')
  ?.addEventListener('click', handlePrintItinerary);
document.getElementById('route-roundtrip')
  ?.addEventListener('change', (e) => { routeRoundTrip = !!e.target.checked; });

// Info icons. Walks every .field and inserts an "i" button beside
// the existing .tip, then wires hover/click/focus to reveal the
// tip as a popover. Idempotent; safe to re-run if new fields are
// added later.
initInfoIcons();

// Phase 5 column-visibility gear + presets. Reads stored visibility
// from localStorage; falls back to the spec's default-visible set.
initColumns();

// Picking the Agricultural preset is a request for the ag DATA, not just
// the ag columns: CLI, Soil Type, Tile Drainage and Irrigation all need a
// load an ordinary search skips, so kick it off here rather than revealing
// four empty columns. Any other preset drops the water-rights latch again
// so later searches stop paying the WALLAS fetch — that's its off-switch.
// No-op when there's nothing to load or nothing in scope.
onPresetApply((name) => {
  const wasLatched = waterRightsWantedForGrid;
  waterRightsWantedForGrid = name === 'Agricultural';
  if (name === 'Agricultural') {
    ensureAgriculturalGridData();
  } else if (wasLatched && currentRows.length > 0) {
    // Re-render so the .water-mode class drops with the latch. The data
    // stays stamped on the rows, so re-picking Agricultural is instant.
    renderTable(currentRows, { resetPage: false });
  }
});

// Phase 6 URL state — apply on boot, then re-encode the current
// form values on each input change so a copied URL reproduces the
// session. Sales-CSV state is omitted (uploaded files can't be
// encoded in a URL).
const URL_INPUT_BINDINGS = [
  { id: 'municipality',  key: 'muni',          event: 'change' },
  { id: 'roll',          key: 'roll',          event: 'change' },
  { id: 'address-from',  key: 'addressFrom',   event: 'change' },
  { id: 'address-to',    key: 'addressTo',     event: 'change' },
  { id: 'address-street', key: 'addressStreet', event: 'change' },
  { id: 'legal-text',    key: 'legalText',     event: 'change' },
  { id: 'title',         key: 'title',         event: 'change' },
  { id: 'zone-category', key: 'zoneCategory',  event: 'change' },
  { id: 'changed-status', key: 'changedStatus', event: 'change' },
  { id: 'du-mode',       key: 'duMode',        event: 'change' },
  { id: 'du-min',        key: 'duMin',         event: 'change' },
  { id: 'vacant-threshold', key: 'vacantThreshold', event: 'change' },
];

function readCurrentUrlState() {
  const state = {};
  for (const b of URL_INPUT_BINDINGS) {
    const el = document.getElementById(b.id);
    if (!el) continue;
    const raw = el.value ?? '';
    if (raw === '' || raw == null) continue;
    if (b.key === 'duMin') {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) state[b.key] = n;
    } else if (b.key === 'vacantThreshold') {
      const n = parseFloat(raw);
      if (Number.isFinite(n)) state[b.key] = n;
    } else {
      state[b.key] = raw;
    }
  }
  // Tab + selected parcel come from non-input state.
  try {
    const stored = localStorage.getItem('mbps_sidebar_tab_v1');
    if (stored === 'property' || stored === 'sales') state.tab = stored;
  } catch {}
  if (selectedParcelRow?.parcel?.properties?.Roll_No_Txt) {
    state.selectedRoll = selectedParcelRow.parcel.properties.Roll_No_Txt;
  }

  // View state — only carry these into the URL when they differ from
  // the defaults so a fresh session produces a clean URL.
  if (currentSort && currentSort.col && (currentSort.col !== 'roll' || currentSort.dir !== 'asc')) {
    state.sort = { col: currentSort.col, dir: currentSort.dir };
  }
  if (currentPage > 0) state.page = currentPage + 1;  // 1-based in the URL
  const pressedOverlays = [];
  for (const btn of document.querySelectorAll('button.overlay-btn[id$="-toggle"]')) {
    // Binary-toggle only: tri-state secondary modes (aria-pressed="mixed")
    // are deliberately NOT round-tripped — see SCHEMA.overlays comment.
    if (btn.getAttribute('aria-pressed') === 'true') {
      pressedOverlays.push(btn.id.replace(/-toggle$/, ''));
    }
  }
  if (pressedOverlays.length > 0) state.overlays = pressedOverlays;
  return state;
}

function writeUrlStateToHistory() {
  try {
    const state = readCurrentUrlState();
    const qs = encodeState(state);
    const url = qs ? `${location.pathname}?${qs}` : location.pathname;
    history.replaceState(null, '', url);
  } catch (err) {
    console.warn('writeUrlStateToHistory failed (non-fatal):', err);
  }
}

function applyUrlStateToInputs(state) {
  for (const b of URL_INPUT_BINDINGS) {
    if (!(b.key in state)) continue;
    const el = document.getElementById(b.id);
    if (!el) continue;
    el.value = String(state[b.key]);
    // The Roll # input is a hidden <input> backing a chip-input UI
    // (initChipInput in lib/chipInput.js). Its `values` array is
    // captured in a closure at init time, so a plain `el.value = …`
    // assignment updates the DOM but not the chip layer — meaning
    // a shared URL like `?r=442950` would leave the roll field
    // visually empty. The reseed event tells the chip layer to
    // re-read the hidden value and re-render. Plain (non-chip)
    // inputs have no listener for this event, so it's a no-op
    // there.
    el.dispatchEvent(new CustomEvent('chip-input:reseed', { bubbles: true }));
  }
  if (state.tab && (state.tab === 'property' || state.tab === 'sales')) {
    try { setActiveTab(state.tab, { skipFocus: true }); } catch {}
  }
  // Restore sort + page — the next renderTable picks both up from
  // module state. SORT_KEYS owns the allowed col allowlist; an unknown
  // col falls through to the default order at render time.
  if (state.sort && state.sort.col && SORT_KEYS[state.sort.col]) {
    currentSort = { col: state.sort.col, dir: state.sort.dir === 'desc' ? 'desc' : 'asc' };
    updateSortIndicators();
  }
  if (Number.isInteger(state.page) && state.page >= 1) {
    currentPage = state.page - 1;  // back to 0-based
  }
  // A shared URL can arrive with advanced criteria already filled in,
  // and none of the assignments above fire an event — badge the group
  // so the restored filters are visible while it's still collapsed.
  renderAdvancedFilterBadge();
}

// Restore overlays only after their click handlers are registered. Keeping
// this separate from applyUrlStateToInputs avoids silently dropping every
// overlay from a shared URL during initial module setup.
function restoreUrlOverlays(state) {
  if (Array.isArray(state.overlays) && state.overlays.length > 0) {
    for (const code of state.overlays) {
      const btn = document.getElementById(`${code}-toggle`);
      if (!btn || btn.disabled) continue;
      if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
    }
  }
}

// Wire input listeners. Throttled via requestAnimationFrame so a
// rapid sequence of edits coalesces into one history.replaceState.
let urlWritePending = false;
function queueUrlWrite() {
  if (urlWritePending) return;
  urlWritePending = true;
  requestAnimationFrame(() => {
    urlWritePending = false;
    writeUrlStateToHistory();
  });
}
for (const b of URL_INPUT_BINDINGS) {
  const el = document.getElementById(b.id);
  if (!el) continue;
  el.addEventListener(b.event, queueUrlWrite);
  if (el.tagName === 'INPUT') el.addEventListener('input', queueUrlWrite);
}

// Phase 7 keyboard shortcuts. Cmd/Ctrl-K focuses the active tab's
// primary input (matches the well-known shortcut of every modern
// search bar). Esc clears the focused input. Enter on a search
// input runs the search (already wired further up).
document.addEventListener('keydown', (e) => {
  // Cmd/Ctrl-K: focus the primary search input on the active tab.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    setActiveTab(getActiveTabName(), { skipFocus: false });
    return;
  }
  // Esc: clear the currently-focused text-like input.
  if (e.key === 'Escape') {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) {
      const tag = el.type;
      if (tag === 'text' || tag === 'search' || tag === 'number' || tag === 'tel' || tag === 'email' || tag === 'url') {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }
});

// Local helper to read the active tab from localStorage (the
// canonical store the tabs module writes to).
function getActiveTabName() {
  try {
    const v = localStorage.getItem('mbps_sidebar_tab_v1');
    if (v === 'property' || v === 'sales') return v;
  } catch {}
  return 'property';
}

// Initial decode + apply. The muni dropdown loads asynchronously, so
// re-apply the URL's muni once its option appears in the select.
const initialUrlState = decodeState(location.search);
applyUrlStateToInputs(initialUrlState);

if (initialUrlState.muni) {
  let attempts = 0;
  const targetMuni = initialUrlState.muni;
  const pollId = setInterval(() => {
    attempts += 1;
    const hasOption = Array.from($municipality.options).some((o) => o.value === targetMuni);
    if (hasOption) {
      clearInterval(pollId);
      $municipality.value = targetMuni;
      $municipality.dispatchEvent(new Event('change', { bubbles: true }));
      // Municipality-scoped overlays start disabled. The change handler
      // enables them synchronously, then this retry activates any that the
      // initial province-wide restoration correctly skipped.
      setTimeout(() => restoreUrlOverlays(initialUrlState), 0);
    } else if (attempts > 80) {
      // ~16 s; the muni list is finite and cached, so this is
      // generous. Stop polling if it never arrives.
      clearInterval(pollId);
    }
  }, 200);
}

setExportEnabled(false);
updateSortIndicators();

$search.addEventListener('click', runSearch);
$clear.addEventListener('click', clearAll);
$export.addEventListener('click', exportCsv);

// Sales-CSV upload — Phase 3 wires the dropzone (click + drag/drop)
// instead of the previous button. The hidden <input type="file">
// keeps its id so the change event handler is unchanged. See
// handleSalesUpload() for the parse + per-muni Roll # lookup +
// table/map rendering pipeline.
const $salesDropzone    = document.getElementById('sales-dropzone');
const $salesUploadInput = document.getElementById('sales-upload-input');

async function runSalesUploadFromFile(file) {
  if (!file) return;
  try {
    await handleSalesUpload(file);
    // Switching to the Sales tab on success exposes the filters
    // that just lit up via body.sales-mode, regardless of which
    // tab the user was on when they dropped the file.
    setActiveTab('sales', { skipFocus: true });
  } catch (err) {
    console.error('Sales upload failed', err);
    setCount(`Sales upload failed: ${err.message}`);
  }
}

if ($salesDropzone && $salesUploadInput) {
  $salesDropzone.addEventListener('click', (e) => {
    // Don't re-open the picker if the click landed on the hidden
    // <input> propagating its synthetic event after a file pick.
    if (e.target === $salesUploadInput) return;
    $salesUploadInput.click();
  });
  $salesDropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      $salesUploadInput.click();
    }
  });
  $salesUploadInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try { await runSalesUploadFromFile(file); }
    finally { e.target.value = ''; }
  });

  // Drag-and-drop. The drag-over class lights up the dropzone
  // border. dragenter/leave have to be counted (children fire
  // their own enter/leave on hover) so we keep a depth counter.
  let dragDepth = 0;
  const onDragEnter = (e) => {
    e.preventDefault();
    dragDepth += 1;
    $salesDropzone.classList.add('drag-over');
  };
  const onDragLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $salesDropzone.classList.remove('drag-over');
  };
  const onDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $salesDropzone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) await runSalesUploadFromFile(file);
  };
  $salesDropzone.addEventListener('dragenter', onDragEnter);
  $salesDropzone.addEventListener('dragleave', onDragLeave);
  $salesDropzone.addEventListener('dragover', onDragOver);
  $salesDropzone.addEventListener('drop', onDrop);
}

// "Paste data…" modal — the copy-paste alternative to the dropzone.
// onSubmit feeds the pasted/loaded text through the same pipeline as a
// file upload: handleSalesUpload (which caches it under the synthesized
// name for the Recent picker) then a hop to the Sales tab on success.
const salesImportModal = initSalesPasteImport({
  onSubmit: async ({ name, text }) => {
    try {
      await handleSalesUpload({ name, text });
      setActiveTab('sales', { skipFocus: true });
    } catch (err) {
      console.error('Sales paste load failed', err);
      setCount(`Sales load failed: ${err.message}`);
    }
  },
});

// MAO sales database — the locally-imported archive used as a source, instead
// of uploading a CSV every time. It hands us the same { name, text } shape the
// paste and Recent-uploads paths already produce, so everything downstream
// (parse, roll lookup, enrichment, charts) is unchanged. The archive lives only
// in this browser and is never uploaded — see lib/salesStore.js for why.
const salesDbPanel = initSalesDbPanel({
  setStatus: setCount,
  // Shade the municipalities the current selection would load. Two tints:
  // explicit picks solid, adjacency-derived ones weaker — the same
  // distinction the checkbox list draws, so map and list never disagree.
  onSelectionChange: (effective, picked) => {
    mapReady.then(async () => {
      try {
        await showMuniLayer(map, await listShardKeys());
        paintMuniSelection(map, effective, picked);
        fitToSelection(map, effective);
      } catch (err) { console.warn('municipality layer', err); }
    });
  },
  // The sidebar's date range doubles as the LOAD window: sales outside it
  // are never read out of the archive, so they are never parsed and never
  // trigger a parcel-geometry fetch. The shards are written newest-first,
  // so this is a cheap early-exit scan rather than a full pass.
  getDateWindow: () => ({
    from: ($saleDateFrom?.value || '').trim(),
    to:   ($saleDateTo?.value   || '').trim(),
  }),
  // Fired once a Search is committed (after the no-date-range confirm) and
  // before anything is read. Drops the previous result set so a search that
  // finds nothing — or fails — can never leave the last one on screen
  // pretending to be the answer. See clearSalesResults.
  onSearchStart: clearSalesResults,
  onLoad: async ({ name, text }) => {
    try {
      await handleSalesUpload({ name, text });
      setActiveTab('sales', { skipFocus: true });
    } catch (err) {
      console.error('Sales database load failed', err);
      setCount(`Sales load failed: ${err.message}`);
    }
  },
});

// Municipal boundaries are a Sales-Analysis affordance: they answer "which
// areas am I about to load?". On the Property Search tab they would just be
// clutter over the parcels, so the layer follows the active tab.
//
// Clicking a municipality toggles it in the picker — toggleMuni ignores any
// municipality the archive does not hold, so a click on an un-scraped one is
// a no-op rather than a selection that fails at load time.
mapReady.then(() => {
  // contentAt lets the boundary picker defer to whatever is drawn on top of
  // it — the sale the user actually meant to click, or any overlay. map.js
  // owns the layer ids; muniLayer.js can't import it and stay node-loadable,
  // so the answer is passed in from here, where both are already in scope.
  wireMuniInteractions(map, (no) => salesDbPanel.toggleMuni?.(no), {
    contentAt: (point) => contentLayerOwnsPoint(map, point),
  });
  const syncMuniLayer = async (tab) => {
    try {
      if (tab === 'sales') await showMuniLayer(map, await listShardKeys());
      else hideMuniLayer(map);
    } catch (err) { console.warn('municipality layer', err); }
  };
  onTabChange(syncMuniLayer);
  syncMuniLayer(getActiveTab());
});

// The Property Search counterpart: click a municipality on the ALWAYS-ON
// grey boundary layer to set the dropdown, instead of hunting for it among
// ~180 names. Same gesture as the Sales tab, different target.
//
// Only armed before a search has run. Once results are on the map the
// boundaries sit under parcels, popups and overlays, and a click meant for
// one of those would silently re-scope the search and reset the overlay
// toggles — so the picker stands down until Clear reloads the page. It is
// also Property-Search-only, since the Sales tab has its own muni layer and
// its own meaning for a click.
mapReady.then(() => {
  muniPicker = wireMuniBoundaryPicker(map, {
    isEnabled: () => getActiveTab() === 'property' && !searchHasRun,
    onPick: (name) => {
      // The dropdown carries Roll-Entry's Muni_Name_With_Typ, which can
      // differ from the boundary field in punctuation/accents. Match the
      // option the same tolerant way the rest of the app matches these two
      // fields; bail rather than blanking the dropdown if the muni has no
      // option (it has no parcels to search).
      const key = normalizeMuniKey(name);
      const opt = Array.from($municipality.options)
        .find((o) => o.value && (o.value === name || normalizeMuniKey(o.value) === key));
      if (!opt) return;
      // Clicking the muni that's already selected clears back to "Any
      // municipality" — click on, click off, as on the Sales tab.
      $municipality.value = ($municipality.value === opt.value) ? '' : opt.value;
      // The change event does the rest: overlay resets, the fly-to, the
      // selection outline, and the URL write (URL_INPUT_BINDINGS already
      // watches this select's `change`).
      $municipality.dispatchEvent(new Event('change', { bubbles: true }));
    },
  });
  // Drop a stale hover tint the moment the picker goes inert.
  onTabChange(() => muniPicker?.refresh());
  // The map may already be armed-and-hovered by the time it wires up, and a
  // URL-state boot can auto-run a search before this point.
  muniPicker.refresh();
  muniBoundariesPromise.then(() => paintSelectedMuniBoundary());
});

/**
 * Blue-outline the dropdown's municipality on the map. Resolves the
 * dropdown's Roll-Entry name to the boundary FC's own spelling first, so
 * the punctuation-mismatch munis still light up.
 */
function paintSelectedMuniBoundary() {
  const muni = $municipality.value;
  const feat = muni ? findMuniBoundaryFeature(muni) : null;
  mapReady.then(() => {
    setMuniBoundarySelected(map, feat?.properties?.MUNI_LIST_NAME_WITH_TYPE || null);
  });
}

document.getElementById('sales-import-trigger')
  ?.addEventListener('click', () => salesImportModal.open());

// Recent uploads — picker + Forget All button. Lazily populated
// on first page load. Picking an entry replays the cached CSV
// through handleSalesUpload (with a synthetic { name, text } file).
const $recentRow    = document.getElementById('recent-uploads-row');
const $recentSelect = document.getElementById('recent-uploads-select');
const $recentClear  = document.getElementById('recent-uploads-clear');
function populateRecentUploads() {
  if (!$recentSelect || !$recentRow) return;
  const list = loadRecentUploads();
  $recentSelect.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = list.length ? 'Pick a recent CSV…' : '—';
  $recentSelect.appendChild(blank);
  for (const e of list) {
    const opt = document.createElement('option');
    opt.value = e.name;
    const dt = new Date(e.ts || 0);
    const ts = Number.isFinite(dt.valueOf()) ? dt.toISOString().slice(0, 10) : '';
    opt.textContent = ts ? `${e.name} (${ts})` : e.name;
    $recentSelect.appendChild(opt);
  }
  $recentRow.hidden = list.length === 0;
}
if ($recentSelect) {
  $recentSelect.addEventListener('change', async () => {
    const name = $recentSelect.value;
    if (!name) return;
    const entry = loadRecentUploads().find((e) => e.name === name);
    if (!entry) return;
    try {
      await handleSalesUpload({ name: entry.name, text: entry.text });
    } catch (err) {
      console.error('Recent upload replay failed', err);
      setCount(`Recent upload replay failed: ${err.message}`);
    }
    $recentSelect.value = '';
  });
}
if ($recentClear) {
  $recentClear.addEventListener('click', () => {
    saveRecentUploads([]);
    populateRecentUploads();
  });
}
populateRecentUploads();

// Favourites: bulk-clear button. Sales-only via the .favourite-row
// class (hidden outside sales mode by the same body.sales-mode rule
// the other sales-only inputs use). Wipes the in-memory Set + the
// localStorage entry and re-renders the table so star cells reset
// to their unstarred glyph.
// "Clear" button to the right of Upload Sales CSV. Performs a full
// reset — same behavior as the sidebar Clear button — so the user
// can wipe an uploaded CSV, search results, subject parcel, filters,
// and all toggled overlays in one click. Routes through clearAll()
// which also strips sessionStorage + mbpsCache localStorage entries
// before reloading the page.
const $salesClear = document.getElementById('sales-clear');
if ($salesClear) $salesClear.addEventListener('click', clearAll);

$zoningToggle.addEventListener('click', () => toggleOverlay('zoning'));
$devplanToggle.addEventListener('click', () => toggleOverlay('devplan'));
$contamToggle.addEventListener('click', () => toggleAuxOverlay('contam'));
$flowToggle.addEventListener('click', () => toggleAuxOverlay('flow'));
$highwaysToggle.addEventListener('click', () => toggleAuxOverlay('highways'));
$riskAreaToggle.addEventListener('click', () => toggleAuxOverlay('riskAreas'));
$muniParcelsToggle.addEventListener('click', () => toggleAuxOverlay('muniParcels'));
$tileToggle?.addEventListener('click', async () => {
  await toggleAuxOverlay('tileDrainage');
  // Turning the overlay on populates the Tile Drainage column for rows
  // already on screen, so the user doesn't have to re-run the search to
  // see it — same contract the MASC and CLI overlays have.
  restampTileDrainage();
});
$tileNetworkToggle?.addEventListener('click', async () => {
  await toggleAuxOverlay('tileNetwork');
  // This layer holds only what's on screen, so toggleAuxOverlay's
  // "fetched once, keep forever" caching is wrong for it — the user may
  // have panned a county away while it was off. Clear the loaded flag so
  // the next activation re-reads the viewport, and record the key we just
  // fetched so the idle handler doesn't immediately repeat the work.
  auxLoaded.tileNetwork = false;
  tileNetworkLastKey = $tileNetworkToggle.classList.contains('active')
    ? tileNetworkViewportKey()
    : null;
});
$irrigationToggle?.addEventListener('click', async () => {
  await toggleAuxOverlay('irrigation');
  // Same contract as the tile toggle: switching the overlay on fills the
  // Irrigation column for rows already on screen.
  restampIrrigation();
});
// The tile network only ever holds the current viewport, so it has to
// follow the map. `idle` rather than `moveend`: it also covers the
// zoom-driven case where a fetch was skipped below the zoom threshold.
mapReady.then(() => {
  map.on('idle', refreshTileNetworkForViewport);
});

// ---------- Collapsible overlay groups ----------
//
// The Map layers panel holds six groups and ~20 controls; most sessions
// use two of them. Each group is a native <details>, so the collapse
// behaviour, keyboard handling, and screen-reader semantics are the
// browser's. This adds the two things it can't do for itself: remember
// which groups the user closed, and keep an active-layer count visible
// on a group that's closed — otherwise a layer could be on with no
// on-screen trace, which is the one way this could mislead.
// Open/closed state is NOT persisted. What you expand stays expanded for
// as long as the page is alive — the panel is never re-rendered, so the
// DOM holds it across tab switches and searches by itself — and a reload
// returns to the defaults in the markup.
//
// Persisting it was worse in practice: opening Agricultural once to reach
// a layer meant it was still open on every future visit, so "collapsed by
// default" quietly stopped being true. Any stale keys from that version
// are cleared below.
const LEGACY_OVERLAY_GROUP_KEYS = ['mbps_overlay_groups_v1', 'mbps_overlay_groups_v2'];

function overlayGroupEls() {
  return document.querySelectorAll('#map-layers-section .overlay-group[data-group]');
}

/**
 * Refresh every collapsed group's "N on" badge. Counts pressed toggles,
 * which includes the tri-state overlays' aria-pressed="mixed" secondary
 * modes — those are still ON, just in their second mode.
 *
 * Quick links are excluded: they're navigation, never "active".
 */
function refreshOverlayGroupCounts() {
  for (const el of overlayGroupEls()) {
    const badge = el.querySelector('.overlay-group-count');
    if (!badge) continue;
    if (el.dataset.group === 'links') { badge.textContent = ''; continue; }
    // Pressed layer toggles plus ticked search filters. The filters count
    // because they are exactly the kind of setting that must not go
    // invisible: a collapsed Agricultural group with "Licensed tile
    // drainage only" ticked would otherwise silently narrow every search.
    // 'mixed' is the tri-state overlays' second mode — still on.
    const on = el.querySelectorAll(
      '.overlay-btn[aria-pressed="true"], .overlay-btn[aria-pressed="mixed"], .overlay-check input:checked',
    ).length;
    badge.textContent = on > 0 ? `${on} on` : '';
    badge.title = on > 0 ? `${on} active setting${on === 1 ? '' : 's'} in this group` : '';
  }
}

(function initOverlayGroups() {
  const groups = overlayGroupEls();
  if (groups.length === 0) return;
  // Drop state written by the versions that persisted this, so a browser
  // that used them doesn't keep a key around forever.
  for (const key of LEGACY_OVERLAY_GROUP_KEYS) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
  // Toggle buttons flip aria-pressed from a dozen call sites (and some
  // defensive resets bypass setOverlayPressed entirely), so observe the
  // attribute rather than trying to hook every one of them. The filter
  // checkboxes fire change instead, which no attribute reflects.
  const observer = new MutationObserver(refreshOverlayGroupCounts);
  for (const el of groups) {
    el.addEventListener('toggle', refreshOverlayGroupCounts);
    el.addEventListener('change', refreshOverlayGroupCounts);
    observer.observe(el, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  }
  refreshOverlayGroupCounts();
})();
$mascToggle.addEventListener('click', () => toggleMascOverlay());
$cliToggle.addEventListener('click', () => toggleCliOverlay());
if ($landcoverToggle) $landcoverToggle.addEventListener('click', () => toggleLandCoverOverlay());
if ($waterToggle) $waterToggle.addEventListener('click', () => toggleWaterInfluenceOverlay());
if ($historicalToggle) $historicalToggle.addEventListener('click', () => toggleHistoricalOverlay());
if ($historicalYear) $historicalYear.addEventListener('change', () => onHistoricalYearChange());
for (const [key, btn] of Object.entries($historicalLayerBtns)) {
  if (btn) btn.addEventListener('click', () => toggleHistoricalLayer(key));
}
initHistoricalSnapshots();
$gridToggle.addEventListener('click', () => toggleSurveyGridOverlay());
setTimeout(() => restoreUrlOverlays(initialUrlState), 0);

const $staticMapBtn     = document.getElementById('static-map-btn');
const $staticMapOutput  = document.getElementById('static-map-output');
const $staticMapSection = document.getElementById('static-map-section');
if ($staticMapBtn) $staticMapBtn.addEventListener('click', generateStaticMap);

// Parcel Snapshots (ZIP) — render a 1600×900 satellite JPEG of each result
// subject (highlighted, fit to 16:9) and download them all as one ZIP named
// muniCode-roll.jpg. A multi-parcel comp is one subject: all its parcels
// highlighted in a single frame (see lib/snapshotGroups.js), so the count
// here is frames, not parcels. Enabled whenever the current result set is
// non-empty, so it serves both entry points the user asked for: an imported
// parcel list, and Sales Analysis after importing a list.
const $snapshotBtn = document.getElementById('snapshot-zip-btn');
let snapshotRunning = false;
let snapshotAbort = null;
if ($snapshotBtn) $snapshotBtn.addEventListener('click', handleSnapshotExport);

function snapshotResultCount() {
  return countSnapshotFrames(lastResultFc);
}

function updateSnapshotButton() {
  if (!$snapshotBtn) return;
  if (snapshotRunning) return; // mid-run label/handler owns the button
  const n = snapshotResultCount();
  $snapshotBtn.disabled = n === 0;
  $snapshotBtn.textContent = 'Parcel Snapshots (ZIP)';
  $snapshotBtn.title = n === 0
    ? 'Import a parcel list or run a search first, then generate one satellite JPEG per result parcel.'
    : `Generate ${n} satellite JPEG${n === 1 ? '' : 's'} (1600×900, highlighted, 16:9) and download as a ZIP, `
      + 'each named muniCode-roll.jpg. A multi-parcel sale is captured as one image of the whole holding, '
      + 'named for its first 3 rolls plus a parcel count.';
}

async function handleSnapshotExport() {
  if (snapshotRunning) {
    // Second click acts as Cancel.
    snapshotAbort?.abort();
    return;
  }
  const n = snapshotResultCount();
  if (n === 0) return;

  snapshotRunning = true;
  snapshotAbort = new AbortController();
  const fcSnapshot = lastResultFc;
  $snapshotBtn.disabled = false;
  $snapshotBtn.textContent = `Capturing 0/${n}… (click to cancel)`;
  setCount(`Generating ${n} parcel snapshot${n === 1 ? '' : 's'}…`);

  // Warm the manifest so the PROVENANCE.txt freshness line is populated, then
  // build the evidence record that travels inside the ZIP.
  await getManifest().catch(() => null);
  const snapProvText = provenanceText(buildProvenance({
    rowCount: fcSnapshot?.features?.length ?? n,
    kind: 'parcel-snapshots',
    manifest: getManifestSync(),
    imagery: 'Esri World Imagery (basemap) — credit burned into each frame',
    historical: historicalActive
      ? { active: true, snap: $historicalYear?.value, layerDates: historicalLayerDates($historicalYear?.value) }
      : null,
  }));

  try {
    const { blob, count, skipped } = await generateParcelSnapshotsZip(fcSnapshot, {
      signal: snapshotAbort.signal,
      fetchSurveyGrid: buildSurveyGridForSnapshot,
      provenanceText: snapProvText,
      onProgress: ({ done, total }) => {
        $snapshotBtn.textContent = `Capturing ${done}/${total}… (click to cancel)`;
      },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `parcel-snapshots-${stamp}.zip`);
    // Skipped subjects are named rather than merely counted — the whole point
    // is that the user can re-run and know which images they're still missing.
    // They're listed in PROVENANCE.txt too, in case this line scrolls away.
    const missed = skipped?.length
      ? ` ${skipped.length} skipped (imagery didn't load in time): ${skipped.join(', ')} — re-run to fill the gaps.`
      : '';
    setCount(`Saved ${count} parcel snapshot${count === 1 ? '' : 's'} to parcel-snapshots-${stamp}.zip.${missed}`);
  } catch (err) {
    if (err?.name === 'AbortError') {
      setCount('Parcel snapshot export cancelled.');
    } else {
      console.error('Parcel snapshot export failed', err);
      setCount(`Parcel snapshot export failed: ${err?.message || err}`);
    }
  } finally {
    snapshotRunning = false;
    snapshotAbort = null;
    updateSnapshotButton();
  }
}

/**
 * Resolve a municipality name to its polygon in the loaded boundaries FC:
 * an exact match on MUNI_LIST_NAME_WITH_TYPE, then a tolerant normalized
 * one — the parcel FC and the dropdown carry Roll-Entry's
 * Muni_Name_With_Typ, which can differ in punctuation/accents from the
 * boundary field. Returns null when the FC hasn't loaded yet or the name
 * matches nothing; every caller treats the boundary as optional context.
 */
function findMuniBoundaryFeature(muniName) {
  if (!muniName || !muniBoundariesFc?.features) return null;
  const exact = muniBoundariesFc.features.find(
    (f) => f.properties?.MUNI_LIST_NAME_WITH_TYPE === muniName,
  );
  if (exact) return exact;
  const key = normalizeMuniKey(muniName);
  return muniBoundariesFc.features.find(
    (f) => normalizeMuniKey(f.properties?.MUNI_LIST_NAME_WITH_TYPE) === key,
  ) || null;
}

/**
 * Build the section/township (DLS) grid FC for one muni, for the snapshot
 * export. Fetches the survey grid scoped to that muni's boundary polygon
 * and converts it to section-bbox grid lines — the same per-muni pipeline
 * toggleSurveyGridOverlay() uses. Returns null when the muni can't be
 * matched, in which case that muni's snapshots simply omit the grid.
 */
async function buildSurveyGridForSnapshot(muniName) {
  const feat = findMuniBoundaryFeature(muniName);
  if (!feat) return null;
  const fc = await fetchSurveyGridForMuni(muniName, feat);
  const rows = surveyFcToRows(fc || { features: [] });
  return sectionLinesFromRows(rows);
}

/** Trigger a browser download for an in-memory Blob. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Draw the WebGL map canvas into a 2D canvas and burn the live
 * attribution text into the bottom-right corner. Without this the
 * saved image would show no basemap / data credit even though the live
 * map does — the WebGL canvas alone doesn't include the
 * AttributionControl DOM overlay. The returned data URL carries the
 * credit with the image so it survives right-click → Save.
 *
 * The captured view is downscaled so its longest side is at most
 * MAX_OUTPUT_DIM and encoded as JPEG (see lib/imageOutput.js) — the same
 * resolution/format band as the parcel snapshots, which keeps the saved
 * image small (~a few hundred KB instead of multi-MB PNG) for dropping into
 * documents. Never upscales a smaller view.
 */
function composeWithAttribution(srcCanvas) {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const scale = Math.min(MAX_OUTPUT_DIM / sw, MAX_OUTPUT_DIM / sh, 1);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  // White backing: JPEG has no alpha, so any transparent pixel would
  // otherwise encode as black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(srcCanvas, 0, 0, w, h);

  // Pull the exact text MapLibre shows in its attribution control. This
  // keeps the static image in sync with whatever sources/overlays are
  // currently visible — basemap (CARTO Voyager or Esri Imagery), zoning,
  // dev-plan, contam, traffic, etc. — without us having to enumerate them.
  const attribEl = $mapEl.querySelector('.maplibregl-ctrl-attrib-inner') ||
                   $mapEl.querySelector('.maplibregl-ctrl-attrib');
  let text = attribEl ? attribEl.innerText.replace(/\s+/g, ' ').trim() : '';
  if (!text) text = '© OpenStreetMap © CARTO';

  // Style the credit similar to the live map's bottom-right overlay: small
  // text, semi-transparent white pill, dark text. Size relative to the
  // output width so it stays proportional after the downscale.
  const fontSize = Math.max(11, Math.round(w * 0.011));
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  // Wrap the attribution onto multiple lines if it's too long for the
  // image width — common when several overlays are active.
  const maxWidth = Math.floor(w * 0.85);
  const lines = wrapToWidth(ctx, text, maxWidth);
  const padX = 8;
  const padY = 5;
  const lineHeight = Math.round(fontSize * 1.25);
  const blockH = lines.length * lineHeight + padY * 2 - (lineHeight - fontSize);
  // Compute pill width as the widest line (plus padding).
  let blockW = 0;
  for (const line of lines) blockW = Math.max(blockW, ctx.measureText(line).width);
  blockW = Math.ceil(blockW + padX * 2);
  const x0 = w - blockW - 6;
  const y0 = h - blockH - 6;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(x0, y0, blockW, blockH);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, blockW - 1, blockH - 1);
  ctx.fillStyle = '#1a1a1a';
  for (let i = 0; i < lines.length; i++) {
    const yMid = y0 + padY + i * lineHeight + Math.round(fontSize / 2);
    ctx.fillText(lines[i], x0 + padX, yMid);
  }

  // Legend, when the user asked for it — stacked upward from just above
  // the credit pill, in the same bottom-right corner it occupies on
  // screen. Drawn last so it sits over the map; the image keeps its
  // normal dimensions.
  if ($legendToggle?.checked) drawMapLegends(ctx, w, h, y0 - 6, fontSize);

  return out.toDataURL(OUTPUT_MIME, OUTPUT_QUALITY);
}

/** Legends currently on screen, as plain data. Wraps the lib reader with
 *  this app's map pane. */
function visibleMapLegends() {
  return readMapLegends($mapEl);
}

/**
 * Draw the visible legends onto the export canvas, stacking upward from
 * `bottomY` so the first ends up nearest the credit pill. Sizes derive from
 * the attribution's font size, so the legend stays proportional to the rest
 * of the overlay after the output downscale.
 */
function drawMapLegends(ctx, w, h, bottomY, baseFont) {
  const legends = visibleMapLegends();
  if (legends.length === 0) return;
  const font = Math.max(11, Math.round(baseFont * 0.95));
  const family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const bodyFont = `${font}px ${family}`;
  const titleFont = `600 ${font + 1}px ${family}`;
  const boxes = layoutMapLegends(legends, {
    width: w,
    height: h,
    bottomY,
    font,
    measure: (text, weight) => {
      ctx.font = weight === 'title' ? titleFont : bodyFont;
      return ctx.measureText(text).width;
    },
  });
  paintMapLegends(ctx, boxes, { font, bodyFont, titleFont });
}

/** Greedy word-wrap: break `text` into lines that each measure ≤ maxWidth
 *  in the canvas' current font. Single words longer than maxWidth pass
 *  through unbroken (rare for attribution text). */
function wrapToWidth(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Capture the current interactive-map view as a static <img>. Forces a
 * synchronous repaint first so every layer toggle flag (zoning, dev-plan,
 * traffic, contam, muni-parcels, etc.) is reflected in the framebuffer
 * before we read pixels. The map was created with preserveDrawingBuffer:
 * true so canvas.toDataURL() returns real bytes; without that the buffer
 * would be cleared after each frame and the URL would come back blank.
 *
 * The output goes into a sibling div as an <img> the user can right-click
 * → Save Image As… for dropping into appraisal reports. We don't auto-
 * download because the user wants control over filename and destination,
 * and right-click + paste-into-Word is the actual workflow they
 * described.
 */
/**
 * Drop the Generate Image snapshot.
 *
 * The snapshot is a still of the map AT THE MOMENT IT WAS TAKEN, and nothing
 * on it says so. Left on the page through a new search it sits directly under
 * a grid describing different parcels, looking exactly like output of the
 * search you are now reading — the one failure mode where a stale image is
 * worse than no image, because the user's next step is pasting it into a
 * report (Jason, 2026-08-13).
 *
 * Called when a NEW RESULT SET arrives — a Property Search, or a sales upload
 * — and deliberately not on filter changes, overlay toggles or re-sorts. Those
 * refine the set the image was taken of; clearing there would yank the image
 * out from under someone who took it and then tidied the view before saving.
 */
function clearStaticMap() {
  if (!$staticMapOutput) return;
  $staticMapOutput.innerHTML = '';
  $staticMapOutput.hidden = true;
  if ($staticMapSection) $staticMapSection.hidden = true;
}

async function generateStaticMap() {
  if (!$staticMapOutput) return;
  await mapReady;
  $staticMapBtn.disabled = true;
  const originalLabel = $staticMapBtn.textContent;
  $staticMapBtn.textContent = 'Capturing…';
  try {
    // Force MapLibre to redraw and wait until it's idle so the canvas
    // contents fully match the on-screen view (otherwise a still-loading
    // tile or mid-animation frame can show up in the snapshot).
    await new Promise((resolve) => {
      const onIdle = () => { map.off('idle', onIdle); resolve(); };
      map.on('idle', onIdle);
      map.triggerRepaint();
    });
    const canvas = map.getCanvas();
    const dataUrl = composeWithAttribution(canvas);
    if ($staticMapSection) $staticMapSection.hidden = false;
    $staticMapOutput.hidden = false;
    $staticMapOutput.innerHTML = '';
    // Plain-language hint above the image so the user knows what to
    // do with the snapshot (Save Image As… isn't discoverable
    // without prompting).
    const hint = document.createElement('p');
    hint.className = 'static-map-hint';
    hint.textContent = 'Right click and Copy or Save image:';
    $staticMapOutput.appendChild(hint);
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Static snapshot of the current map view';
    img.title = 'Right-click → Save Image As… to drop into a report';
    $staticMapOutput.appendChild(img);
    $staticMapOutput.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error('static map capture failed', err);
    if ($staticMapSection) $staticMapSection.hidden = false;
    $staticMapOutput.hidden = false;
    $staticMapOutput.innerHTML = '<p style="color:#c0392b">Capture failed — try toggling the satellite basemap and re-trying. If it persists, check the browser console.</p>';
  } finally {
    $staticMapBtn.disabled = false;
    $staticMapBtn.textContent = originalLabel;
  }
}
$municipality.addEventListener('change', () => {
  refilterCategoryDropdowns();
  resetMuniParcelsToggle();
  resetMascAndGridToggles();
  updateMuniWebsiteButton();
  // Reset the PD button until the next search resolves the planning
  // district from the dev-plan layer's PLANNINGDISTRICT field.
  setExternalLinkButton($pdWebsiteBtn, null, 'PD Website ↗', 'Run a search to detect the planning district');
  // If the Zoning Layer / Dev Plan Layer are currently active, swap
  // their data to match the new muni. Skipped quietly when neither
  // layer is on; doesn't refetch when the new muni already matches.
  refreshOverlayLayersForMuniChange();
  // Blue-outline the selection on the boundary layer, so a muni picked
  // by clicking the map confirms itself where the click landed — and one
  // picked from the list is findable on the map without reading labels.
  paintSelectedMuniBoundary();
  // Zoom the map to the selected muni's bounds so the user lands in
  // the right place before running a search. Skipped if either the
  // boundaries FC hasn't loaded yet or the selection cleared.
  zoomMapToSelectedMuni();
});

/**
 * Fly the map to the bounding box of the currently-selected muni in
 * the dropdown. No-op when no muni is selected, when the boundaries
 * FC hasn't loaded yet, or when no matching feature exists.
 */
function zoomMapToSelectedMuni() {
  const feat = findMuniBoundaryFeature($municipality.value);
  if (!feat) return;
  mapReady.then(() => flyToFeature(map, feat));
}

/**
 * A place was chosen in the map's search box (lib/placeSearch.js).
 *
 * Three things happen, in this order:
 *
 *   1. The municipality dropdown is set to the RM the place falls in, so
 *      the answer to "what RM is Souris in?" is not just displayed but
 *      *loaded* — Search is one click away without retyping anything.
 *   2. That dispatch runs the normal muni-change side effects (overlay
 *      swap, boundary outline, URL state) — including a fly to the whole
 *      RM's bounds.
 *   3. We then fly to the town itself, which supersedes step 2's wider
 *      framing. Scheduled a macrotask later so it lands after the change
 *      handler's own mapReady continuation; both animations start within
 *      a frame of each other, so the RM flight never visibly begins and
 *      the user sees one smooth flight to the town.
 *
 * Places in unorganized territory carry no muni and skip step 1, as do
 * places whose RM has no dropdown option — the muni picker already treats
 * a missing option as "nothing to select" rather than blanking the field,
 * since a muni with no parcels has nothing to search.
 */
function handlePlacePick(hit, { zoom } = {}) {
  if (!hit) return;

  if (hit.muni) {
    const key = normalizeMuniKey(hit.muni);
    const opt = Array.from($municipality.options)
      .find((o) => o.value && (o.value === hit.muni || normalizeMuniKey(o.value) === key));
    if (opt && $municipality.value !== opt.value) {
      $municipality.value = opt.value;
      $municipality.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  mapReady.then(() => setTimeout(() => showPlacePin(map, hit, { zoom }), 0));
}
// The "Min #" number input is only meaningful when Min DU is selected.
// Disable it otherwise so users can't type a value that has no effect.
$duMode.addEventListener('change', () => {
  const enableMin = $duMode.value === 'min';
  $duMin.disabled = !enableMin;
  if (!enableMin) $duMin.value = '';
  if (enableMin && !$duMin.value) $duMin.value = '1';
});

// CSV-upload mode: when csvFullRows is populated, changing any of the
// ---------- Far-flung sale flagging (phase 2: flag only) ----------

// Persisted so a threshold tuned for one job carries into the next —
// the same reasoning as the column presets. Phase 2 only MARKS these
// sales; nothing is removed from the table, map or export.
const FAR_FLUNG_STORAGE_KEY = 'mbps_far_flung_km_v1';
const FAR_FLUNG_EXCLUDE_KEY = 'mbps_far_flung_exclude_v1';

/** Is the exclude toggle on? Off unless explicitly enabled — an upload
 *  never hides sales until the user asks it to. */
function farFlungExcludeOn() {
  return !!($farFlungExclude?.checked) && farFlungThresholdKm() != null;
}

/** Current threshold in km, or null when flagging is off (blank / 0 /
 *  junk input). Read fresh on every use so the grid and the popup can
 *  never disagree about what counts as far-flung. */
function farFlungThresholdKm() {
  const raw = parseFloat($farFlungKm?.value);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function loadFarFlungThreshold() {
  if (!$farFlungKm) return;
  let stored = null;
  try { stored = localStorage.getItem(FAR_FLUNG_STORAGE_KEY); } catch {}
  // A stored empty string is a deliberate "flagging off" and must
  // survive a reload; only a genuinely absent key falls back to the
  // calibrated default.
  $farFlungKm.value = stored == null ? String(DEFAULT_FAR_FLUNG_KM) : stored;
}

function saveFarFlungThreshold() {
  try { localStorage.setItem(FAR_FLUNG_STORAGE_KEY, $farFlungKm?.value ?? ''); } catch {}
}

function loadFarFlungExclude() {
  if (!$farFlungExclude) return;
  let stored = null;
  try { stored = localStorage.getItem(FAR_FLUNG_EXCLUDE_KEY); } catch {}
  // Defaults OFF. Only an explicit '1' turns it on, so a corrupt or
  // absent value can never start a session hiding sales.
  $farFlungExclude.checked = stored === '1';
}

function saveFarFlungExclude() {
  try {
    localStorage.setItem(FAR_FLUNG_EXCLUDE_KEY, $farFlungExclude?.checked ? '1' : '0');
  } catch {}
}

/**
 * Stamp `_farFlungReason` onto every row's parcel and update the
 * "N sales flagged" label beside the threshold input.
 *
 * Stamping happens across the WHOLE row set, not the rendered page:
 * the map source holds every parcel, and its popup reads the same
 * property the grid badge does, so a page-scoped pass would leave most
 * parcels with a stale or missing reason. The reason depends on the
 * user's current threshold rather than on anything intrinsic to the
 * parcel, which is why it's derived per render instead of at upload.
 *
 * Counts distinct SALES, not rows — a 14-parcel portfolio sale is one
 * flagged sale, and reporting 14 would badly overstate the problem.
 * Parcels are reported alongside so the eventual exclude toggle's
 * impact is legible before it exists.
 */
function applyFarFlungFlags(rows) {
  const threshold = farFlungThresholdKm();
  for (const row of rows || []) {
    const p = row?.parcel?.properties;
    if (!p) continue;
    const why = threshold == null ? '' : farFlungReason(p, threshold);
    p._farFlungReason = why || null;
  }
  // The tally counts against the UNFILTERED upload, not the rows being
  // rendered. Once Exclude is ticked the flagged rows are gone from
  // `rows`, and counting those would report "none flagged" at the exact
  // moment six sales are being hidden — the opposite of the truth.
  const tally = countFarFlung(csvFullRows ?? rows, threshold);
  if ($farFlungCount) {
    const source = csvFullRows ?? rows;
    // Silent unless the filter is actually biting. Its controls now live
    // behind the Additional-filters disclosure, so this line is the only
    // thing on screen that can reveal a hidden filter is marking or
    // dropping comps — and a permanent "none flagged" beside no visible
    // control would be noise that trains the eye to skip it.
    //
    // It names itself for the same reason: with the threshold input out
    // of sight, "4 sales flagged" alone doesn't say what flagged them.
    if (threshold == null || !source || source.length === 0 || tally.sales === 0) {
      $farFlungCount.textContent = '';
      $farFlungCount.removeAttribute('title');
      $farFlungCount.classList.remove('has-flagged');
    } else {
      const verb = farFlungExcludeOn() ? 'excluded' : 'flagged';
      $farFlungCount.textContent =
        `⚠ Far-Flung: ${tally.sales} sale${tally.sales === 1 ? '' : 's'} · ${tally.parcels} parcels ${verb}`;
      $farFlungCount.title = farFlungExcludeOn()
        ? `Sales whose parcels lie more than ${threshold} km apart are being REMOVED from the table, map and export. Change the threshold or untick Exclude under Additional filters.`
        : `Sales whose parcels lie more than ${threshold} km apart are marked with a ⚠ on $/Acre. Nothing is removed unless you tick Exclude under Additional filters.`;
      $farFlungCount.classList.add('has-flagged');
    }
  }
  return tally;
}

/** Distinct far-flung SALES and their parcel count across `rows`. Sales
 *  rather than rows because a 14-parcel portfolio sale is one sale, and
 *  reporting 14 would badly overstate how much is being set aside. */
function countFarFlung(rows, threshold) {
  const sales = new Set();
  let parcels = 0;
  if (threshold == null) return { sales: 0, parcels: 0 };
  for (const row of rows || []) {
    const p = row?.parcel?.properties;
    if (!p || !isFarFlungSale(p, threshold)) continue;
    parcels++;
    if (p._saleGroupId != null) sales.add(p._saleGroupId);
  }
  return { sales: sales.size, parcels };
}

if ($farFlungKm) {
  loadFarFlungThreshold();
  loadFarFlungExclude();
  const onFarFlungChange = () => {
    saveFarFlungThreshold();
    saveFarFlungExclude();
    // In CSV mode the threshold is a real filter input, so route through
    // the same path every other sales filter uses — it re-filters,
    // re-renders, re-pushes the map source and rewrites the count line.
    if (csvFullRows != null) { refilterCsvIfActive(); return; }
    if (currentRows.length === 0) { applyFarFlungFlags(currentRows); return; }
    // Outside CSV mode there's nothing to filter; just refresh badges.
    renderTable(currentRows, { resetPage: false });
    // renderTable re-stamps _farFlungReason on the feature properties,
    // but MapLibre holds its own copy of the GeoJSON — without pushing
    // the source again the popup would keep quoting the old threshold.
    // `fit: false` so tuning the number doesn't move the camera.
    setMapData(
      { type: 'FeatureCollection', features: currentRows.map((r) => r.parcel) },
      lastZoningFc || EMPTY_FC,
      lastDevPlanFc || EMPTY_FC,
      { fit: false },
    );
  };
  $farFlungKm.addEventListener('input', onFarFlungChange);
  $farFlungKm.addEventListener('change', onFarFlungChange);
  $farFlungExclude?.addEventListener('change', onFarFlungChange);
}

// Other Searches filters re-filters the displayed table + map subset
// against the loaded sales without re-fetching. Outside CSV mode
// these listeners are no-ops (Search button still drives the SQL).
for (const el of [
  $zoneCategory, $changedStatus, $duMode, $duMin, $sizeLow, $sizeHigh, $vacantImproved,
  $saleDateFrom, $saleDateTo, $asmtClass, $zoningFilterEl, $zoneCatFilterEl,
  $primaryPropEl,
  $distanceMax, $salesPlan,
  $salesStreetName, $salesPpaLow, $salesPpaHigh, $saleAsmtMax,
  $salesPriceLow, $salesPriceHigh, $salesN1, $salesGroupSize, $excludeNominal,
].filter(Boolean)) {
  el.addEventListener('change', refilterCsvIfActive);
  el.addEventListener('input',  refilterCsvIfActive);
}
// Drawn area shapes re-filter whichever mode is live: the sales-CSV
// pass when a CSV is loaded, the shapes-only basic pass otherwise.
// Committing a shape, flipping include/exclude, or erasing all
// re-runs it.
onShapesChanged(() => {
  if (csvFullRows != null) refilterCsvIfActive();
  else refilterBasicByShapes();
});
// Subject-distance ring follows the Max-Distance input in real time
// so the user sees the radius they're choosing without having to wait
// for the table to re-filter. Triggered independently of
// refilterCsvIfActive (which only runs in CSV mode) so the ring works
// in basic-search mode too.
if ($distanceMax) {
  $distanceMax.addEventListener('input',  updateSubjectRadiusRing);
  $distanceMax.addEventListener('change', updateSubjectRadiusRing);
  // Hide the Dist (km) column unless the user has set a Max km
  // value. The column has no meaning without a radius cap; show
  // it only when the filter is engaged.
  const updateMaxKmFlag = () => {
    const n = parseFloat($distanceMax.value);
    document.body.classList.toggle('has-max-km', Number.isFinite(n) && n > 0);
  };
  $distanceMax.addEventListener('input', updateMaxKmFlag);
  $distanceMax.addEventListener('change', updateMaxKmFlag);
  updateMaxKmFlag();
}

// Date-range controls. The two date inputs ARE the filter; the quick
// picks (3/6/12/24 mo) just fill them in, so a preset can be adjusted by
// hand afterwards instead of being an either/or choice. Click × to clear
// both. Today's date comes from new Date() — fine for local-time
// appraisal use, no timezone games.
const isoDate = (d) => {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};
function applyDatePreset(monthsBack, clear) {
  if (!$saleDateFrom || !$saleDateTo) return;
  if (clear) {
    $saleDateFrom.value = '';
    $saleDateTo.value = '';
  } else {
    const today = new Date();
    const back = new Date(today);
    // setMonth on a day-31 date rolls into the next month (Mar 31 minus
    // one month is "Feb 31" -> Mar 3), which would silently widen the
    // window. Clamp to the last day of the target month instead.
    const targetMonth = back.getMonth() - monthsBack;
    back.setDate(1);
    back.setMonth(targetMonth);
    const lastDay = new Date(back.getFullYear(), back.getMonth() + 1, 0).getDate();
    back.setDate(Math.min(today.getDate(), lastDay));
    // 24 months and up read as "how many YEARS of history", not as an exact
    // anniversary: at that range an appraiser wants whole calendar years, so
    // snap From back to Jan 1 of the year the offset lands in — 24 mo from
    // 2026-08-17 gives 2024-01-01, not 2024-08-17 (Jason, 2026-08-17). Only
    // ever widens the window, so nothing that used to match drops out. The
    // short picks (3/6/12) stay exact: those ARE rolling windows.
    if (monthsBack >= 24) {
      back.setMonth(0);
      back.setDate(1);
    }
    $saleDateFrom.value = isoDate(back);
    $saleDateTo.value = isoDate(today);
  }
  flashDateInputs();
  $saleDateFrom.dispatchEvent(new Event('input', { bubbles: true }));
  $saleDateTo.dispatchEvent(new Event('input', { bubbles: true }));
}
// Brief highlight so a preset click visibly lands in the boxes below —
// without it the two controls read as unrelated.
function flashDateInputs() {
  for (const el of [$saleDateFrom, $saleDateTo]) {
    if (!el) continue;
    el.classList.remove('just-set');
    void el.offsetWidth;            // restart the animation
    el.classList.add('just-set');
  }
}
for (const btn of document.querySelectorAll('.date-preset-btn')) {
  btn.addEventListener('click', () => {
    const monthsBack = parseInt(btn.dataset.months || '0', 10);
    const clear = btn.dataset.clear === '1';
    applyDatePreset(monthsBack, clear);
  });
}
// Typing in either box re-runs the filter (the change event covers the
// picker; input covers typing). A blank box means "open-ended on that
// side", which is what the filter already does with an empty value.
for (const el of [$saleDateFrom, $saleDateTo]) {
  if (el) el.addEventListener('change', () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Size filter is permanently in acres — the Acres/Sq Ft pill was
// removed at the user's request. The Lo Ac / Hi Ac inputs are
// always interpreted as acres; filterCsvRowsByOtherSearches reads
// them directly without unit conversion.

// Subject parcel — Set on button click or Enter in the roll input;
// Clear wipes the highlight + the Distance (km) column data. Both
// flows re-render the table so the distance values appear/disappear
// without needing a CSV re-upload.
if ($subjectApply) $subjectApply.addEventListener('click', applySubjectFromInput);
if ($subjectClear) $subjectClear.addEventListener('click', clearSubjectParcel);
if ($subjectRoll) $subjectRoll.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applySubjectFromInput();
  }
});
// Filter out any nulls so the keydown wiring tolerates removed inputs
// (legal/lot/block/plan/title are currently absent from the markup).
// When the user tabs into the To field after typing a number into From,
// prefill To with the same value AND select it. Default behaviour is
// then "exact-number search" — start typing to overwrite for a range,
// or press Delete to clear for an open upper bound.
if ($addressFrom && $addressTo) {
  $addressTo.addEventListener('focus', () => {
    if ($addressTo.value === '' && $addressFrom.value.trim() !== '') {
      $addressTo.value = $addressFrom.value.trim();
      // Defer select() so it runs after the focus event finishes
      // claiming the field — without the timeout some browsers
      // re-collapse the selection on the trailing focus tick.
      setTimeout(() => $addressTo.select(), 0);
    }
  });
}

for (const el of [$addressFrom, $addressTo, $addressStreet, $roll, $legalText, $lot, $block, $plan, $title].filter(Boolean)) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
}

// ---------- "Advanced searches" active-criteria badge ----------
//
// The advanced group is collapsed by default, so a criterion set in an
// earlier session (or restored from a shared URL) silently narrows the
// next search with nothing on screen to say so. The badge names each
// active criterion beside the summary title, visible open or closed;
// the title attribute carries the actual values.
//
// Deliberately excludes the Import List of Parcels action that shares
// the group — a resolved list already announces itself in its own pill
// above the action row.

/** One entry per active advanced criterion: short label + full detail. */
function advancedFilterChips() {
  const chips = [];
  const legal = $legalText?.value.trim() || '';
  if (legal) chips.push({ label: 'Legal', detail: `Legal description contains "${legal}"` });
  const ct = $title?.value.trim() || '';
  if (ct) chips.push({ label: 'Title', detail: `Certificate of title contains "${ct}"` });
  const zone = $zoneCategory?.value.trim() || '';
  if (zone) chips.push({ label: 'Zoning', detail: `Zoning category: ${zone}` });
  const status = $changedStatus?.value || '';
  if (status) {
    const text = $changedStatus.selectedOptions?.[0]?.textContent?.trim() || status;
    chips.push({ label: 'Amendments', detail: `Amendments: ${text}` });
  }
  const duMode = $duMode?.value || '';
  if (duMode === 'zero') {
    chips.push({ label: '0 DU', detail: 'Dwelling units: 0 only (vacant / non-residential)' });
  } else if (duMode === 'min') {
    const n = parseInt($duMin?.value ?? '', 10);
    chips.push(Number.isFinite(n) && n > 0
      ? { label: `DU ≥ ${n}`, detail: `Dwelling units: at least ${n}` }
      : { label: 'Min DU', detail: 'Dwelling units: minimum set, no count entered yet' });
  }
  return chips;
}

function renderAdvancedFilterBadge() {
  // Looked up per call rather than captured in a module-level const:
  // applyUrlStateToInputs() calls this during boot, well before this
  // point in the module body would have initialized one.
  const badge = document.getElementById('advanced-filters-badge');
  if (!badge) return;
  const chips = advancedFilterChips();
  if (chips.length === 0) {
    badge.hidden = true;
    badge.textContent = '';
    badge.removeAttribute('title');
    return;
  }
  badge.hidden = false;
  badge.textContent = chips.map((c) => c.label).join(' · ');
  badge.title = `${chips.length} advanced criteri${chips.length === 1 ? 'on' : 'a'} set — ${chips.map((c) => c.detail).join('; ')}`;
}

// Delegated so every control in the group is covered, including any
// added later. `input` catches typing in the two text fields; `change`
// catches the selects and the Min # spinner (and fires after the
// du-mode handler above has rewritten $duMin, so the count is current).
const $advancedFiltersGroup = document.querySelector('details.advanced-filters');
$advancedFiltersGroup?.addEventListener('input', renderAdvancedFilterBadge);
$advancedFiltersGroup?.addEventListener('change', renderAdvancedFilterBadge);
renderAdvancedFilterBadge();

for (const th of document.querySelectorAll('#results th[data-col]')) {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (currentSort.col === col) {
      currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      currentSort = { col, dir: 'asc' };
    }
    updateSortIndicators();
    if (currentRows.length > 0) renderTable(currentRows);
    queueUrlWrite();
  });
}

// ---------- Parcel numbering toggle ----------

/**
 * Reveal the "Number parcels" control only when there's more than one
 * parcel to number, and keep the checkbox in sync with numberingOn.
 * DOM-only — the map-callout visibility is driven by setMapData (on a
 * result-set change) and by the toggle's own change handler.
 */
function updateNumberingAvailability() {
  const avail = currentRows.length > 1;
  if ($numberingLabel) $numberingLabel.hidden = !avail;
  if ($numberingToggle) $numberingToggle.checked = numberingOn;
  // "Entry order" only makes sense when there IS an entry order — a typed
  // roll list naming more than one subject. A muni-wide or address search
  // has none, so the checkbox stays out of the way rather than sitting
  // there as a no-op.
  const orderAvail = avail && (enteredRollOrder?.rollCount ?? 0) > 1;
  if (!orderAvail && numberingEntryOrder) numberingEntryOrder = false;
  if ($numberingOrderLabel) $numberingOrderLabel.hidden = !orderAvail;
  if ($numberingOrderToggle) $numberingOrderToggle.checked = numberingEntryOrder;
  updateMapOptionsRow();
}

/**
 * Build the roll → typed-position map behind the "Entry order" option.
 *
 * Keyed by the canonical `<digits>.<3-digit-sub>` form the parcels carry in
 * Roll_No_Txt, so a user who types "154350" matches the stored
 * "154350.000". One position per typed roll — `+`, `&` and `|` separate the
 * same way a comma does, so "83100+83200" is two parcels taking two numbers.
 *
 * Returns null for an empty field — that's what hides the checkbox.
 * `rollCount` distinguishes "one roll typed" (no meaningful order) from a
 * real list.
 *
 * @returns {{byRoll: Map<string, number>, rollCount: number} | null}
 */
function buildEnteredRollOrder(rollInput) {
  const rolls = parseRollList(rollInput);
  if (rolls.length === 0) return null;
  const byRoll = new Map();
  rolls.forEach((roll, i) => byRoll.set(canonicalRoll(roll), i));
  return { byRoll, rollCount: rolls.length };
}

/**
 * The rollOrder to number by right now — null unless the option is on AND
 * there is a real order to follow. The `rollCount > 1` test mirrors
 * updateNumberingAvailability's, so what gets applied can never disagree
 * with what the checkbox says is on offer.
 */
function activeRollOrder() {
  if (!numberingEntryOrder) return null;
  if ((enteredRollOrder?.rollCount ?? 0) < 2) return null;
  return enteredRollOrder.byRoll;
}

/**
 * Reveal "Include legend in map image" only while there's a legend to
 * include. Nothing to include means an unexplained no-op, so the control
 * stays out of the way until an overlay that has a legend is switched on.
 */
function updateLegendAvailability() {
  if ($legendLabel) $legendLabel.hidden = visibleMapLegends().length === 0;
  updateMapOptionsRow();
}

/** The shared row shows whenever either of its toggles does. */
function updateMapOptionsRow() {
  if (!$numberingRow) return;
  const anyVisible = ($numberingLabel && !$numberingLabel.hidden)
                  || ($legendLabel && !$legendLabel.hidden);
  $numberingRow.hidden = !anyVisible;
}

// Legends appear and disappear from a dozen different overlay handlers
// (zoning, MASC, CLI's tri-state cycle, land cover, traffic flow). Rather
// than call updateLegendAvailability from each one — and miss the next one
// somebody adds — watch the map pane for the `hidden` flips that reveal
// them. Attribute-only, so it costs nothing until a legend actually toggles.
if ($mapEl) {
  new MutationObserver(() => updateLegendAvailability())
    .observe($mapEl, { attributes: true, attributeFilter: ['hidden', 'style'], subtree: true });
  updateLegendAvailability();
}

if ($numberingToggle) {
  $numberingToggle.addEventListener('change', () => {
    numberingOn = $numberingToggle.checked;
    if (numberingOn && currentRows.length > 1) {
      // Order the grid 1..N so it reads the same as the map. Numbers are
      // glued to each parcel, so the user can re-sort afterwards without
      // the callouts renumbering.
      currentSort = { col: 'seq', dir: 'asc' };
    } else if (!numberingOn && currentSort.col === 'seq') {
      // Turning it off while sorted by the (now-hidden) # column — fall
      // back to the default roll sort.
      currentSort = { col: 'roll', dir: 'asc' };
    }
    updateSortIndicators();
    const active = numberingOn && currentRows.length > 1;
    mapReady.then(() => setParcelNumbersVisible(map, active));
    if (currentRows.length > 0) renderTable(currentRows);
    queueUrlWrite();
  });
}

if ($numberingOrderToggle) {
  $numberingOrderToggle.addEventListener('change', () => {
    numberingEntryOrder = $numberingOrderToggle.checked;
    renumberCurrentResults();
  });
}

/**
 * Re-stamp `_seq` on the parcels currently on screen, then refresh the map
 * callouts and the grid. Used when "Entry order" flips — the numbers are
 * normally assigned once per result set and glued to each parcel, so this
 * is the one place that deliberately renumbers an existing set.
 */
function renumberCurrentResults() {
  const parcels = currentRows.map((r) => r.parcel).filter(Boolean);
  if (parcels.length > 1) assignParcelSeq(parcels, { rollOrder: activeRollOrder() });
  else clearParcelSeq(parcels);
  // The callout anchors were built from the OLD `_seq` values, so re-push
  // the features: setParcelNumberData re-reads `_seq` and re-solves the
  // badge placement. The grid picks the new numbers up on its own, since
  // the "#" cell reads `_seq` at render time.
  mapReady.then(() => {
    setParcelNumberData(map, parcels);
    setParcelNumbersVisible(map, numberingOn && parcels.length > 1);
  });
  if (currentRows.length > 0) renderTable(currentRows);
}

// Overlay toggle clicks — delegate at the document level so all 12
// buttons + any future ones share one listener that writes the URL on
// every aria-pressed change.
document.addEventListener('click', (e) => {
  const btn = e.target?.closest?.('button.overlay-btn[id$="-toggle"]');
  if (!btn) return;
  // Defer one tick so the toggle handler has set aria-pressed by the
  // time we read it inside queueUrlWrite -> readCurrentUrlState.
  queueMicrotask(queueUrlWrite);
});

// Populate the three dropdowns in parallel — the muni list is the slow one
// (~190 distinct values), the categories are short and quick.
populateDropdowns().finally(() => {
  // Defensive second probe after a few seconds. populateDropdowns's
  // probeRollEntrySnapshot already retries up to 3x in 2.5s; this catches
  // the worst case where extension interference persists through every
  // boot-time attempt. Quiet no-op once snapshot mode is on (or live is
  // healthy), so it's a free safety net.
  setTimeout(() => recheckRollEntrySnapshotAfterBoot(), 5000);
});

// Pre-warm the legal index in the background. The first search (legal-
// criteria or otherwise) joins the index against the parcel result set
// to populate the Legal + Title columns; without this kickoff, the
// first search would block on a 130 MB cold fetch.
warmLegalIndex();

// Once the legal + assessment shards have loaded (lazy, no block on
// page paint), surface their `generated_at` timestamps in the
// data-refresh footer so the user can tell at a glance how fresh
// the data is. Failures are non-fatal — the footer just doesn't
// show the missing source.
populateDataRefreshFooter();

// Pull municipal boundaries in the background and load them onto the
// map as soon as both the data and the map are ready. Cached for 30
// days so this is a one-time hit per month per browser; on a cache
// hit it lands instantly. Failures are non-fatal — boundaries are
// reference data, not critical to a search.
// Full muni-boundaries FC, cached at module scope so the Sec-Twp Grid
// toggle can hand the un-clipped polygon to the spatial query. Going
// through map.querySourceFeatures returns whatever the render pipeline
// clipped to the current viewport tiles, which truncated large RMs
// like Hanover.
let muniBoundariesFc = null;
const muniBoundariesPromise = (async () => {
  try {
    const fc = await fetchMunicipalBoundaries();
    muniBoundariesFc = fc;
    await mapReady;
    setMuniBoundariesData(map, fc);
    return fc;
  } catch (err) {
    console.warn('muni boundaries fetch failed (non-fatal)', err);
    return null;
  }
})();

async function populateDropdowns() {
  try {
    // Probe live muni list + live record count + the local snapshot
    // manifest in parallel. The snapshot is the static dump produced by
    // r/build_rollentry_snapshot.R; main.js flips into snapshot mode
    // (parcel queries routed to per-muni shards by arcgis.js) when live
    // is incomplete AND the snapshot is available.
    //
    // The four probes settle INDEPENDENTLY. They span two provincial
    // FeatureServers plus the CDN, and a plain Promise.all rejects on the
    // first failure — so a blip on the ZONING service, which feeds nothing
    // but the zone-category dropdown, used to blank the municipality picker
    // with "Failed to load" and leave it that way for the session. Each
    // probe now degrades to null on its own and is handled below.
    // (probeRollEntrySnapshot and fetchRollEntryCount already self-catch.)
    const [liveMunis, zoneCats, snapshotManifest, liveRecordCount] = await Promise.all([
      fetchMunicipalityList().catch((err) => {
        console.warn('Live municipality list unavailable', err);
        return null;
      }),
      fetchZoneCategoryList().catch((err) => {
        console.warn('Zone-category list unavailable (affects the zoning dropdown only)', err);
        return null;
      }),
      probeRollEntrySnapshot(),
      fetchRollEntryCount(),
    ]);
    const liveCount = Array.isArray(liveMunis) ? liveMunis.length : 0;
    const snapshotMunis = snapshotManifest?.munis
      ? Object.keys(snapshotManifest.munis).sort()
      : [];
    const incomplete = liveRollEntryIncomplete(liveCount, liveRecordCount, snapshotManifest);

    // Degradation rules live in lib/dropdownSources.js, where node can pin
    // them — which of the two lists each dropdown ends up with, and whether
    // this is a real partial-republish (flip to snapshot mode) or just a
    // failed probe (borrow the snapshot's muni names, leave parcel querying
    // alone).
    const sources = resolveDropdownSources({ liveMunis, zoneCats, snapshotMunis, incomplete });
    setRollEntrySnapshot(sources.useSnapshot ? snapshotManifest : null);
    if (sources.muniSource === 'snapshot-fallback') {
      console.warn('Municipality list served from the snapshot manifest — the live probe failed.');
    }
    fillSelect($municipality, sources.munis, sources.muniPlaceholder);
    fillSelect($zoneCategory, sources.zoneCats, sources.zonePlaceholder);
    updateRollEntryBanner({
      liveCount, liveRecordCount, snapshotManifest,
      snapshotActive: !!getRollEntrySnapshot(),
    });
  } catch (err) {
    // Backstop for a genuine programming error — every network path above
    // degrades on its own, so reaching here is not an upstream problem.
    console.error('Failed to load filter dropdowns', err);
    fillSelect($municipality, [], 'Failed to load — type to filter parcels another way');
  }
}

// Manitoba normally publishes ~180 munis / ~437k parcels on the ROLL_ENTRY
// FeatureServer. When the province is mid-republishing the service
// (observed 2026-06-03, which dropped to 18 munis / 50,724 records), the
// live query returns a small fraction of that.
//
// Two independent incompleteness signals — either trips snapshot mode:
//   - muni count < 150: catches "whole munis missing" (the 18-of-186 case).
//   - record count < 50% of the snapshot's total: catches "most munis
//     present but records sparse", which the muni-count signal alone would
//     miss. The snapshot holds ~431k parcels, healthy live is ~437k, and
//     the mid-rebuild low was ~51k (12%) — so 50% cleanly separates
//     healthy from broken with a wide margin either way.
const ROLL_ENTRY_MIN_HEALTHY_MUNIS = 150;
const ROLL_ENTRY_MIN_RECORD_RATIO = 0.5;
const ROLL_ENTRY_NORMAL_MUNIS = 180;

/** Sum of per-muni parcel counts in the snapshot manifest (the snapshot's
 *  total record count), or 0 when unavailable. */
function snapshotTotalRecords(manifest) {
  if (!manifest?.munis) return 0;
  let total = 0;
  for (const entry of Object.values(manifest.munis)) {
    const c = Number(entry?.count);
    if (Number.isFinite(c)) total += c;
  }
  return total;
}

/** True when the live Roll_Entry service looks partial on EITHER signal:
 *  too few munis, or a record count far below the snapshot total. Needs a
 *  snapshot manifest for the record-ratio check; falls back to muni-count
 *  alone when the snapshot total or live count is unknown. */
function liveRollEntryIncomplete(liveMuniCount, liveRecordCount, snapshotManifest) {
  const muniSignal = liveMuniCount > 0 && liveMuniCount < ROLL_ENTRY_MIN_HEALTHY_MUNIS;
  const snapTotal = snapshotTotalRecords(snapshotManifest);
  const recordSignal =
    Number.isFinite(liveRecordCount) && liveRecordCount > 0 && snapTotal > 0 &&
    liveRecordCount < snapTotal * ROLL_ENTRY_MIN_RECORD_RATIO;
  return muniSignal || recordSignal;
}
// Served from the mb-parcel-data repo via raw.githubusercontent (pinned
// commit — see MB_PARCEL_DATA_CDN in arcgis.js), not from web/public/data/.
const ROLL_ENTRY_SNAPSHOT_MANIFEST_URL = `${MB_PARCEL_DATA_CDN}/rollentry-snapshot/_index.json`;

/** Fetch the snapshot manifest; null on any failure (so the call site
 *  falls through to live-only mode without an error).
 *
 *  Retries up to `retries` more times on failure, with 500ms/1000ms/1500ms
 *  backoff. Browser extensions (LastPass, Grammarly, recorders, etc.) can
 *  inject content scripts mid-load and break concurrent fetches — the
 *  "A listener indicated an asynchronous response by returning true, but
 *  the message channel closed before a response was received" error class.
 *  A single retry after a short wait clears this in the vast majority of
 *  cases; the user-facing symptom is the snapshot fallback not activating
 *  despite an incomplete live muni list. */
async function probeRollEntrySnapshot(retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ROLL_ENTRY_SNAPSHOT_MANIFEST_URL, { cache: 'no-cache' });
      if (res.ok) {
        const m = await res.json();
        if (m && m.snapshot_date && m.munis && typeof m.munis === 'object') return m;
      }
    } catch {
      // fall through to retry
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

/** A few seconds after boot, if we ended up in legacy "live-incomplete" mode
 *  without snapshot activation despite the snapshot existing, try once more
 *  and swap in if it works. Catches the case where every boot-time retry
 *  failed (e.g., aggressive extension interference) but later attempts
 *  succeed. Re-evaluates BOTH the muni-count and record-count signals. */
async function recheckRollEntrySnapshotAfterBoot() {
  // Already in snapshot mode? Nothing to do.
  if (getRollEntrySnapshot()) return;
  const liveMuniCount = $municipality ? $municipality.options.length - 1 : 0;
  const [manifest, liveRecordCount] = await Promise.all([
    probeRollEntrySnapshot(),
    fetchRollEntryCount(),
  ]);
  if (!manifest || Object.keys(manifest.munis || {}).length === 0) return;
  if (!liveRollEntryIncomplete(liveMuniCount, liveRecordCount, manifest)) return;
  setRollEntrySnapshot(manifest);
  fillSelect($municipality, Object.keys(manifest.munis).sort(), 'Any municipality');
  updateRollEntryBanner({
    liveCount: liveMuniCount, liveRecordCount, snapshotManifest: manifest, snapshotActive: true,
  });
}

/**
 * Render the Roll Entry status banner across three states:
 *   - healthy (neither incompleteness signal trips): hidden.
 *   - incomplete + snapshot active: amber banner explaining the app has
 *     swapped to the dated snapshot and will revert when live is back.
 *   - incomplete + no snapshot available: the legacy "mid-update" banner
 *     telling the user to wait it out.
 * The shortfall sentence adapts to whichever signal tripped (too few
 * munis, or too few records).
 */
function updateRollEntryBanner({ liveCount, liveRecordCount, snapshotManifest, snapshotActive }) {
  const banner = document.getElementById('roll-entry-banner');
  if (!banner) return;
  if (!liveRollEntryIncomplete(liveCount, liveRecordCount, snapshotManifest)) {
    banner.hidden = true;
    banner.textContent = '';
    banner.classList.remove('data-staleness-amber', 'data-staleness-red');
    return;
  }
  banner.classList.remove('data-staleness-red');
  banner.classList.add('data-staleness-amber');

  // Describe whichever signal tripped. Muni shortfall is the more legible
  // headline; fall back to the record shortfall when munis look fine but
  // the record count is low.
  const muniSignal = liveCount > 0 && liveCount < ROLL_ENTRY_MIN_HEALTHY_MUNIS;
  const recFmt = Number.isFinite(liveRecordCount) ? liveRecordCount.toLocaleString('en-US') : liveRecordCount;
  const shortfall = muniSignal
    ? `Only ${liveCount} of the usual ~${ROLL_ENTRY_NORMAL_MUNIS} municipalities are currently published live`
    : `Live data currently holds only ${recFmt} parcels (well below the usual ~437,000)`;
  const link = '<a href="https://geoportal.gov.mb.ca/datasets/manitoba::roll-entry/about" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">Check Roll Entry status ↗</a>';

  if (snapshotActive && snapshotManifest?.snapshot_date) {
    banner.innerHTML =
      '<strong>Manitoba Roll Entry source data appears to be mid-update.</strong> ' +
      `${shortfall}. Showing snapshot data from <strong>${snapshotManifest.snapshot_date}</strong> ` +
      `(reload to revert to live data once the upstream rebuild completes — typically hours to a day). ${link}`;
  } else {
    banner.innerHTML =
      '<strong>Manitoba Roll Entry source data appears to be mid-update.</strong> ' +
      `${shortfall}; the listed municipalities work normally, but other searches may return ` +
      `no results until the upstream rebuild completes (typically hours to a day). ${link}`;
  }
  banner.hidden = false;
}

/**
 * On muni change, narrow the Zone Category and Dev-Plan Category dropdowns
 * to only the categories that actually appear inside that muni. Both
 * overlay layers carry MUNI_NAME (without the "(TOWN)"-style suffix), so
 * the API client strips that suffix before filtering. Any preselection
 * that's no longer valid in the narrowed list is reset.
 */
async function refilterCategoryDropdowns() {
  // Sales-CSV mode pulls categories from EVERY matched muni so the
  // user can filter on any category present in their upload, not just
  // the dominant muni's. Normal mode uses the dropdown's single muni.
  const munis = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.slice()
    : ($municipality.value ? [$municipality.value] : [null]);
  const prevZone = $zoneCategory.value;
  $zoneCategory.disabled = true;
  try {
    // Per-muni list fetches in parallel, then union + sort. Cached
    // per-muni in fetchZoneCategoryList so a re-run with the same
    // muni set is instant. `null` (province-wide) is treated as a
    // single fetch to preserve the original startup behaviour.
    const perMuniLists = await Promise.all(munis.map((m) => fetchZoneCategoryList(m)));
    const zoneCats = [...new Set(perMuniLists.flat())].sort();
    fillSelect($zoneCategory, zoneCats, 'Any zoning category');
    // Restore prior selection if it's still valid in the (potentially
    // narrowed/widened) list.
    if (zoneCats.includes(prevZone)) $zoneCategory.value = prevZone;
    // Refilling the select can drop a category the new muni doesn't
    // have, and that assignment fires no change event — refresh the
    // summary badge by hand so it never claims a zoning filter that
    // is no longer selected.
    renderAdvancedFilterBadge();
  } catch (err) {
    console.warn('Failed to refilter category dropdowns', err);
    $zoneCategory.disabled = false;
  }
}

function fillSelect(sel, values, blankLabel) {
  sel.innerHTML = '';
  // Multi-select dropdowns don't get a "blank" option — the empty
  // selection itself is the no-filter state, so a blank entry would
  // be a no-op the user can't visually distinguish from "deselected".
  // Single-select dropdowns keep the existing "Any zoning category"
  // sentinel placeholder.
  if (!sel.multiple) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankLabel;
    sel.appendChild(blank);
  }
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  // Initial markup paints the loading dropdown with a .skeleton pulse;
  // strip it now that real options are rendered. Cheap no-op for
  // selects that were never in the loading state.
  sel.classList.remove('skeleton');
  sel.removeAttribute('aria-label');
}

// ---------- Search ----------

async function runSearch() {
  // Results are about to land on the map, so the click-a-municipality
  // picker stands down until Clear. Done before the first await so a click
  // during a slow search can't slip through.
  disarmSearchPicker();
  const searchGeneration = ++salesEnrichmentGeneration;
  salesExportEnrichmentComplete = true;
  // Drop the sales-mode column reveal if a previous run came from a
  // sales CSV upload — a normal search shouldn't carry those columns.
  if ($resultsTable) $resultsTable.classList.remove('sales-mode');
  // Hide the size-range + vacant-only filter rows since they're CSV-only.
  document.body.classList.remove('sales-mode');
  // Reset the sales-only filter inputs so the next upload starts
  // unfiltered. clearAll already does a full page reload, but a
  // regular Search reuses the page — explicit reset matches existing
  // pattern.
  if ($vacantImproved) $vacantImproved.value = 'all';
  clearMapShapes();
  invalidateBasicShapeSnapshot();
  if ($saleDateFrom)  $saleDateFrom.value = '';
  if ($saleDateTo)    $saleDateTo.value = '';
  if ($distanceMax)   $distanceMax.value = '';
  if ($salesPlan)     $salesPlan.value = '';
  if ($salesStreetName) $salesStreetName.value = '';
  if ($salesN1)       $salesN1.value = 'any';
  if ($salesGroupSize) $salesGroupSize.value = 'any';
  if ($salesPpaLow)   $salesPpaLow.value = '';
  if ($salesPpaHigh)  $salesPpaHigh.value = '';
  if ($salesPriceLow)  $salesPriceLow.value = '';
  if ($salesPriceHigh) $salesPriceHigh.value = '';
  // Multi-selects: untick everything so the filters go back to "any"
  // rather than carrying over the last upload's picks. Zoning also
  // drops its options — they described the previous result set.
  asmtClassFilter.clear();
  zoningFilter.setOptions([]);
  zoneCatFilter.setOptions([]);
  // Same reasoning as zoning: the groups described the previous upload's
  // sales, so they go rather than lingering as options that match nothing.
  primaryPropFilter.setGroups([]);
  // Drop the subject parcel — a fresh Search shouldn't inherit a
  // previous upload's subject highlight on the map.
  clearSubjectParcel();
  // Hide the subject muni picker since it's CSV-only.
  if ($subjectMuniRow) $subjectMuniRow.hidden = true;
  // Hide the unmatched-records panel — sales-upload-specific. When
  // we're entering runSearch from list-import mode the panel may
  // already be holding the resolver's unresolved rows; preserve it.
  if (!(Array.isArray(listParcelKeys) && listParcelKeys.length > 0)) {
    renderUnmatchedPanel([]);
  }
  // Clear the CSV-mode state so the Other Searches filter listeners
  // stop trying to re-filter the previous upload's row set. Also
  // drop the multi-muni overlay scope so MASC/CLI fall back to the
  // dropdown's single-muni value for non-CSV searches.
  csvFullRows = null;
  csvFullBaseMsg = '';
  csvMatchedMunis = null;
  // A new result set is landing — the stashed pre-filter rows belong to
  // the old one, and unticking must not resurrect them.
  resetWaterFilterBase();
  const status = $changedStatus.value;
  const legalInputs = {
    legalText:      $legalText?.value.trim() ?? '',
    lot:            $lot?.value.trim()       ?? '',
    block:          $block?.value.trim()     ?? '',
    plan:           $plan?.value.trim()      ?? '',
    title:          $title?.value.trim()     ?? '',
  };
  const inputs = {
    addressFrom:    $addressFrom?.value.trim()   ?? '',
    addressTo:      $addressTo?.value.trim()     ?? '',
    addressStreet:  $addressStreet?.value.trim() ?? '',
    municipality:    $municipality.value.trim(),
    roll:            $roll.value.trim(),
    zoneCategory:    $zoneCategory.value.trim(),
    zoningChanged:   status === 'zoning'  || status === 'both',
    devPlanChanged:  status === 'devplan' || status === 'both',
    tileDrainageOnly: !!$tileOnly?.checked,
    irrigationOnly:   !!$irrigationOnly?.checked,
    duMode:          $duMode.value,
    duMin:           $duMin.value,
  };
  const hasLegalSearch = hasLegalCriteria(legalInputs);
  const hasList = Array.isArray(listParcelKeys) && listParcelKeys.length > 0;

  // Capture the order the rolls were TYPED, for the "Entry order" numbering
  // option. Read here, from the raw field, because the water pre-filter below
  // overwrites inputs.roll with its own generated list — that list is the
  // shard's order, not the user's, and must never drive the numbering.
  enteredRollOrder = buildEnteredRollOrder(inputs.roll);

  if (!Object.values(inputs).some(Boolean) && !hasLegalSearch && !hasList) {
    setCount('Enter at least one search field.');
    clearTable();
    setMapData(EMPTY_FC, EMPTY_FC, EMPTY_FC);
    return;
  }

  setBusy(true);
  setCount('Searching Roll Entry…');
  clearTable();
  // A new result set makes any existing snapshot a picture of the last one.
  clearStaticMap();
  setMapData(EMPTY_FC, EMPTY_FC, EMPTY_FC);

  // Resolve a ticked water-influence box into a roll list BEFORE the query
  // runs, so it constrains the search rather than trimming its results.
  //
  // As a post-filter this was actively misleading: a muni-wide search caps at
  // MAX_RESULTS (1,000), and Niverville's 378 waterfront parcels sit mostly
  // above that cut — so "Waterfront only" returned 1 and looked authoritative.
  // The shard already names exactly which rolls have water, so feeding them in
  // as a roll list reuses the existing chunked roll-search path (which the
  // sales-CSV import already leans on) and the cap then applies to waterfront
  // parcels rather than to the muni at large.
  const waterPre = await resolveWaterRollPrefilter(inputs);
  if (waterPre?.applied) {
    if (waterPre.rolls.length === 0) {
      setBusy(false);
      // Distinguish "this muni has none" from "the roll you asked for isn't
      // one" — saying Niverville has no waterfront parcels when it has 378
      // and the typed roll simply isn't among them would be plainly wrong.
      setCount(waterPre.narrowedByRoll
        ? `That roll is not ${waterFilterNames()} — ${inputs.municipality} has ${waterPre.muniTotal} such parcel${waterPre.muniTotal === 1 ? '' : 's'}. Clear the roll to see them.`
        : `No ${waterFilterNames()} parcels in ${inputs.municipality}.`);
      clearTable();
      setMapData(EMPTY_FC, EMPTY_FC, EMPTY_FC);
      return;
    }
    inputs.roll = waterPre.rolls.join(',');
  }

  try {
    let legalResult = null;
    // List-import takes precedence. The resolved parcelKeys already
    // identify (muni, roll) for every imported row, so we skip the
    // legal-search round-trip and feed searchParcels directly. Other
    // filters (zone category, du, address) still apply on top via
    // buildParcelClauses inside searchParcels.
    if (hasList) {
      inputs.parcelKeys = listParcelKeys;
      setCount(`Fetching ${listParcelKeys.length} parcel${listParcelKeys.length === 1 ? '' : 's'} from the imported list…`);
    } else if (hasLegalSearch) {
      setCount('Searching legal index…');
      try {
        legalResult = await searchLegalIndex({
          ...legalInputs,
          municipality: inputs.municipality,
        });
      } catch (err) {
        console.error(err);
        setCount(err.message);
        return;
      }
      if (legalResult.matches.length === 0) {
        setCount('No legal-description matches found.');
        return;
      }
      inputs.parcelKeys = legalResult.matches;
      const legalCap = legalResult.truncated ? '+' : '';
      setCount(`${legalResult.matches.length}${legalCap} legal matches · fetching live parcels…`);
    }

    let parcelFc;
    try {
      parcelFc = await searchParcels(inputs);
    } catch (err) {
      console.error(err);
      setCount(`Search failed: ${err.message}`);
      return;
    }
    // Always enrich the result table's Legal + Title columns from the
    // legal index, even when the user didn't type a legal-search
    // criterion. Previously only the explicit legal-search path
    // populated those cells, so a roll- or address-only search like
    // 'Steinbach 160200' would render Legal/Title blank even though
    // the index had a row for the parcel. We now look up the parcels'
    // (muni_no, roll_no_txt) keys directly and merge with any explicit
    // legal-search matches; the index is module-cached after first
    // load and warmLegalIndex() pre-fetches it on page init so this
    // join is effectively free after the first search.
    const parcelKeys = [];
    for (const f of parcelFc.features || []) {
      const k = parcelLegalKey(f.properties || {});
      if (k) parcelKeys.push(k);
    }
    let perParcelLegalRecs = [];
    try {
      perParcelLegalRecs = await lookupLegalRecordsByParcelKeys(parcelKeys);
    } catch (err) {
      console.warn('Legal lookup by parcel keys failed (non-fatal):', err);
    }
    const combinedLegalRecs = [
      ...(legalResult?.matches || []),
      ...perParcelLegalRecs,
    ];
    if (combinedLegalRecs.length > 0) {
      attachLegalMetadata(parcelFc, combinedLegalRecs);
    }

    // The civic-number boxes decide client-side (ArcGIS SQL can't
    // cleanly CAST the leading digits of Property_Address) — contains
    // for a lone box, exact for From == To, range for two different
    // numbers. Both blank and the FC passes through. The street-name
    // substring, and every civic mode except a true range, already
    // narrowed the SQL fetch via buildParcelClauses, so this is
    // operating on at most a few hundred rows in the typical case. A
    // bare RANGE with no street name is the exception: it post-filters
    // whatever the muni query returned, which MAX_RESULTS caps at 1000.
    applyCivicNumberFilter(parcelFc, inputs.addressFrom, inputs.addressTo);

    // Property Search never groups parcels — not from Roll # punctuation
    // ("83100+83200" is two parcels, not one subject), and not from a
    // parcel-list import row that carried several rolls in one cell. Every
    // parcel here keeps its own badge number, its own map highlight and its
    // own Parcel Snapshot.
    //
    // Grouping exists only for sales work, where the combined $/acre across
    // a multi-parcel transaction is the number that matters, so it lives on
    // the Sales tab and is stamped by handleSalesUpload alone. This search
    // path deliberately stamps no _saleGroupId of its own.

    // Site/Comp # from a parcel-list import: stamp the caller's label onto
    // each fetched parcel so assignParcelSeq uses it as the map/grid
    // number instead of the auto 1..N sequence. No-op unless the import
    // mapped a Site column.
    if (hasList && listSiteByKey) {
      for (const f of parcelFc.features || []) {
        const key = parcelLegalKey(f.properties || {});
        const site = key ? listSiteByKey.get(key) : null;
        if (site != null) f.properties._siteNo = site;
      }
    }

    const n = parcelFc.features.length;

    // Preserve the municipality scope resolved by a property-list import
    // without putting it back into the main picker (which would filter a
    // multi-municipality list). Agricultural datasets use these names to
    // fetch every relevant MASC/CLI shard in parallel.
    if (hasList) {
      listMatchedMunis = [...new Set(
        (parcelFc.features || [])
          .map((f) => f.properties?.Muni_Name_With_Typ)
          .filter(Boolean),
      )].sort();
      if (listMatchedMunis.length > 0) {
        inputs.municipalities = listMatchedMunis.slice();
      }
      resetMascAndGridToggles();
      // Same re-evaluation for the Assessment Parcels fabric — the
      // import cleared the picker, so this is the only point where the
      // button learns the list's municipality scope. Enables the button
      // only; the auto-toggle below stays gated on a picked muni.
      resetMuniParcelsToggle();
    }

    // Bulk roll-list diagnostics. When the user pasted a comma-separated
    // list of rolls, compare what came back against what they asked for
    // and surface any rolls that didn't match. List up to 10 inline; the
    // rest collapse into a "and N others" tail so a 50-roll typo doesn't
    // produce a 200-character count badge.
    const rollList = parseRollList(inputs.roll);
    const isBulkRollSearch = rollList.length > 1;
    let missingRolls = [];
    if (isBulkRollSearch) {
      missingRolls = missingRollsFromResults(inputs.roll, parcelFc);
    }

    if (n === 0) {
      if (hasList) {
        setCount(`No parcels returned from Roll Entry for any of the ${listParcelKeys.length} imported list rows. Check that the rolls are current in MAO.`);
      } else if (isBulkRollSearch) {
        setCount(`No parcels found. None of the ${rollList.length} rolls matched in this municipality. Try removing filters or changing municipality.`);
      } else {
        setCount('No parcels found. Try removing filters or changing municipality.');
      }
      return;
    }

    const capNotes = [];
    if (legalResult?.truncated) capNotes.push('legal index cap reached — refine legal search');
    if (parcelFc._truncated) capNotes.push('server cap reached — refine your search');
    if (isBulkRollSearch && missingRolls.length > 0) {
      const inline = missingRolls.slice(0, 10).join(', ');
      const tail = missingRolls.length > 10 ? ` and ${missingRolls.length - 10} others` : '';
      capNotes.push(`${missingRolls.length} of ${rollList.length} not found: ${inline}${tail}`);
    }
    // List-import mode gets its own label that frames N as
    // "of the imported list", folding the resolver's unresolved
    // count into the tail so the user sees the full pipeline at a
    // glance: how many input rows resolved, then plotted.
    let countLabel;
    if (hasList) {
      countLabel = listImportCountLabel(n);
    } else {
      countLabel = isBulkRollSearch
        ? `${n} of ${rollList.length} rolls matched`
        : `${n} parcels found`;
    }
    // `let`: an active as-of date appends its highlight note once the first
    // setMapData push below reports what it swapped.
    let baseMsg = capNotes.length
      ? `${countLabel} (${capNotes.join('; ')})`
      : countLabel;
    // Stamp _rowKey so map clicks can find the matching table row,
    // plus _rollDisplay (.000 stripped) so the hover popup matches
    // the table cell. The muni-parcels FC stamps _rollDisplay in
    // arcgis.js's fetchAllParcelsInMunicipality; mirror it here for
    // search-result parcels so both feature sources read the same.
    // Also stamp _acres on properties so the hover popup can show
    // Acres / SF without round-tripping through the feature object.
    // OBJECTID is lifted to feature.id so setFeatureState() works
    // for the sales-CSV multi-parcel sibling highlight.
    for (const f of parcelFc.features) {
      const oid = f.properties?.OBJECTID;
      if (oid != null) {
        f.properties._rowKey = `p:${oid}`;
        f.id = oid;
      }
      const r = f.properties?.Roll_No_Txt;
      if (typeof r === 'string') {
        f.properties._rollDisplay = r.endsWith('.000') ? r.slice(0, -4) : r;
      }
      const ac = parcelAcres(f);
      if (Number.isFinite(ac) && ac > 0) f.properties._acres = ac;
    }

    // Assign the stable map-numbering sequence for this fresh result set
    // (muni then Roll #, or the typed order when "Entry order" is on).
    // Done once, here — re-sorting / filtering the grid later never
    // renumbers, because the number is stamped on the feature.
    // Single-parcel results carry no number.
    if (parcelFc.features.length > 1) {
      assignParcelSeq(parcelFc.features, { rollOrder: activeRollOrder() });
    } else clearParcelSeq(parcelFc.features);

    // Show parcels-only rows immediately so the user sees something.
    renderTable(parcelFc.features.map((p) => ({ parcel: p, zoning: [], devPlan: [] })));
    setMapData(parcelFc, EMPTY_FC, EMPTY_FC);
    // Every later status line is built from baseMsg, so folding the as-of note
    // in here carries it through enrichment, water and soil stages alike.
    baseMsg += asOfHighlightNote(lastAsOfHighlight, $historicalYear?.value);
    // …and how many parcels were reduced to a pin because they changed after
    // the sale. Folded in at the same point and for the same reason: every
    // later status line is rebuilt from baseMsg.
    const withheldMsg = withheldNote(lastWithheldGeometry);
    if (withheldMsg) baseMsg += ` ${withheldMsg}.`;

    // The muni-wide parcel fabric (Assessment Parcels) is a manual
    // toggle only — it used to auto-show here on every muni-scoped
    // search for context, but turning a layer on that the user didn't
    // ask for costs a per-muni fetch and clutters the map.

    // Threshold rule: small/medium result sets auto-enrich so the
    // zoning + dev-plan columns are there as soon as the search
    // lands. Only very large result sets (above the threshold) skip
    // auto-enrichment because the per-parcel area-weighted join
    // (joinTopNByArea via @turf/intersect) gets slow on the main
    // thread; in that case we render the parcel rows now and offer
    // a "Load zoning + dev-plan" button on the count line.
    //
    // Threshold matches MAX_RESULTS so any normal muni-scoped
    // search auto-enriches — the previous 250-parcel cap surfaced
    // confusing empty Zoning columns for searches like "Springfield
    // (RM) + Zoning Changed" (708 parcels). turf.intersect on
    // ~1000 parcels × ~500 overlay polygons takes a few seconds,
    // which the busy spinner already covers.
    if (parcelFc.features.length > ENRICHMENT_THRESHOLD) {
      // A ticked water-rights filter must still be honoured when the
      // zoning / dev-plan enrichment is deferred, or the grid renders
      // unfiltered and the checkbox reads as inert. Only the WALLAS half
      // runs here: it is what the filter depends on, and it is far
      // cheaper than the overlay joins this branch exists to skip.
      //
      // This is the real snapshot-mode exposure. searchParcelsFromSnapshot
      // has no server-side OBJECTID pre-filter to lean on (live OBJECTIDs
      // don't map onto shard features) and returns the whole muni
      // uncapped, so a big muni lands here far more often than it does
      // against the live service.
      let deferredMsg = baseMsg;
      // Water influence always runs, filter ticked or not — a muni-wide search
      // caps at exactly ENRICHMENT_THRESHOLD and so ALWAYS lands in this
      // branch, and leaving it out rendered an empty Water column for every
      // such search. It is a pre-baked per-muni JSON, not an overlay join, so
      // it costs a fraction of what this branch exists to defer.
      const waterRows = parcelFc.features.map((p) => ({ parcel: p, zoning: [], devPlan: [] }));
      await stampWaterInfluence(waterRows);
      if (waterFilterActive()) {
        setCount(`${baseMsg} · Checking water-rights licences…`);
        const rows = waterRows;
        await Promise.all([stampTileDrainage(rows), stampIrrigation(rows)]);
        lastWaterFilterDropped = dropSliverOnlyMatches(rows, parcelFc);
        renderTable(rows);
        setMapData(parcelFc, EMPTY_FC, EMPTY_FC);
        deferredMsg = hasList
          ? listImportCountLabel(parcelFc.features.length)
          : (lastWaterFilterDropped > 0 ? `${baseMsg} · ${waterFilterDropNote()}` : baseMsg);
      } else {
        // Re-render so the freshly stamped Water column is visible without
        // the user having to click "Load zoning + dev-plan".
        renderTable(waterRows);
        setMapData(parcelFc, EMPTY_FC, EMPTY_FC);
      }
      renderEnrichButton(parcelFc, inputs, deferredMsg);
    } else {
      await enrichOverlays(parcelFc, inputs, baseMsg);
      // Property-list imports should arrive with the same agricultural
      // analysis fields as Sales Analysis. Load Manitoba Soil Survey/CLI
      // polygons for every represented municipality, stamp the dominant
      // CLI capability + soil type onto each parcel, and cache the polygons
      // so either CLI map mode turns on immediately when requested.
      if (hasList && listMatchedMunis?.length) {
        setCount(`${baseMsg} · Loading soil survey data…`);
        const soilResult = await enrichImportedSoilComposition(
          parcelFc,
          listMatchedMunis,
          searchGeneration,
          'list',
        );
        if (soilResult.superseded) return;
        if (soilResult.featureCount > 0) {
          refreshResultsTableAfterCompositionStamp();
          setMapData(parcelFc, lastZoningFc, lastDevPlanFc, { fit: false });
        }
        // Recompute against what actually survived. enrichOverlays runs
        // dropSliverOnlyMatches after baseMsg was built, so the original
        // string can claim more parcels than the grid is showing — the
        // same trap the sales path sidesteps via lastWaterFilterDropped.
        const finalMsg = hasList
          ? listImportCountLabel(parcelFc.features.length)
          : baseMsg;
        if (soilResult.complete) {
          setCount(finalMsg);
        } else {
          const failedMunis = soilResult.failures.map((failure) => failure.muni).join(', ');
          setCount(`${finalMsg} · Soil data failed for ${failedMunis}; run Search again to retry.`);
        }
      }
    }
  } finally {
    setBusy(false);
  }
}

/**
 * Count line for a property-list import.
 *
 * `plotted` must be how many parcels are actually on the grid, so the
 * line can never claim more than the user can see — the licensed
 * tile/irrigation filters remove parcels in two separate places (the
 * server-side OBJECTID clause before the fetch, then dropSliverOnlyMatches
 * after enrichment), and both shrink the visible set.
 *
 * Everything those filters removed is reported as ONE figure. Split into
 * two notes it reads like two unrelated problems; folded into `plotted`
 * with no note at all it's indistinguishable from rolls that failed to
 * resolve, which is the ambiguity this exists to kill.
 */
function listImportCountLabel(plotted) {
  const importedTotal = (listParcelKeys?.length || 0) + (listUnresolvedRows?.length || 0);
  const unresolvedTail = listUnresolvedRows?.length
    ? ` · ${listUnresolvedRows.length} unresolved (see panel)`
    : '';
  const excluded = waterFilterActive()
    ? (listParcelKeys?.length || 0) - plotted
    : 0;
  const filterTail = excluded > 0
    ? ` · ${excluded} excluded by the ${waterFilterNames()} filter`
    : '';
  return `${plotted} of ${importedTotal} imported parcels plotted${filterTail}${unresolvedTail}`;
}

const ENRICHMENT_THRESHOLD = 1000;

// ---------- Sales-CSV upload ----------

const $resultsTable = document.getElementById('results');

/**
 * Read a sales CSV (Sale Date, Consideration, Municipality, Roll
 * Number, [Street Address, Legal Description, Primary Property]),
 * group by municipality, fetch matching ROLL_ENTRY parcels per muni,
 * stamp the sale info onto each matched feature, then route
 * everything through the same display pipeline as a regular search.
 *
 * The table picks up a `sales-mode` class on #results so the Sale
 * Date / Sale Price columns reveal themselves; popups render the
 * sale info inline. Munis that don't normalize cleanly or rolls that
 * don't match anything in ROLL_ENTRY get reported in the count line
 * so the user sees what was lost.
 */
async function handleSalesUpload(file) {
  // Same rule as runSearch: parcels on the map disarm the muni picker.
  disarmSearchPicker();
  // …and the same rule for the snapshot: a new upload is a new result set, so
  // any image on the page is of the previous one. Covers every entry point
  // into this function — dropzone, paste modal and Recent uploads alike.
  clearStaticMap();
  // A CSV has its own row order, which is the vendor's sort rather than
  // anything the user chose — "Entry order" is a typed-Roll#-list option
  // only, so drop any order left over from an earlier search.
  enteredRollOrder = null;
  const uploadGeneration = ++salesEnrichmentGeneration;
  salesExportEnrichmentComplete = false;
  setExportEnabled(false);
  setBusy(true);
  try {
    setCount('Reading CSV…');
    // Kick off the assessment-index pre-warm immediately — it's a
    // ~3.5 MiB gzipped fetch + ~430k-row Map build, and overlapping
    // it with the per-muni parcel lookups means the stamping pass
    // below pays no extra latency on a warm shard. Failure is
    // non-fatal (warmAssessmentIndex itself swallows the error and
    // logs a warning); the per-parcel lookup helper short-circuits
    // to null so _isVacantLand simply stays undefined when the
    // shard isn't reachable, which the filter treats as 'unknown'.
    warmAssessmentIndex();
    // Accept both a File (from the upload input) and a pre-loaded
    // { name, text } object (from the Recent uploads picker). Lets
    // the same pipeline drive either entry point without copying.
    const text = (typeof file?.text === 'function') ? await file.text() : (file?.text || '');
    const fileName = file?.name || 'sales.csv';
    // Cache this CSV for the Recent uploads picker — only when the
    // text actually parsed to records (failed parses skip the cache
    // entirely so a malformed file doesn't pollute the history).
    const records = parseSalesCsv(text);
    if (records.length === 0) {
      setCount('No usable rows in CSV. Expecting Roll Number + Municipality columns.');
      return;
    }
    rememberUpload(fileName, text);

    // Group by normalized muni. Track each unmatched record alongside
    // a human-readable `reason` so the unmatched-records panel can
    // surface why a row dropped out — three buckets, in priority
    // order: empty Roll/Muni in the CSV, Muni didn't normalise to
    // a Roll_Entry-style 'NAME (TYPE)' value, or made it through but
    // the roll wasn't in Roll_Entry (added later, after the API match).
    const byMuni = new Map();
    const unmatchedRecords = [];
    for (const r of records) {
      if (!r.rollNumber || !r.municipality) {
        unmatchedRecords.push({ ...r, reason: 'Roll # or Municipality blank in CSV row' });
        continue;
      }
      const muni = normalizeMuniFromCsv(r.municipality);
      if (!muni) {
        unmatchedRecords.push({ ...r, reason: `Municipality not recognised: "${r.municipality}"` });
        continue;
      }
      if (!byMuni.has(muni)) byMuni.set(muni, []);
      byMuni.get(muni).push(r);
    }
    const dropped = unmatchedRecords.length;

    if (byMuni.size === 0) {
      setCount(`Couldn't normalize any of the ${records.length} CSV rows to a known municipality.`);
      renderUnmatchedPanel(unmatchedRecords);
      return;
    }

    setCount(`Looking up ${records.length - dropped} sales across ${byMuni.size} municipalities…`);

    // Per-muni Roll # lookups in parallel. searchParcels treats the
    // comma-separated roll list and the muni dropdown together.
    // Capture per-muni fetch errors so we can surface them in the
    // count message instead of pretending every row was "not in
    // Roll_Entry" — used to be a silent failure mode on rate-limit
    // (ArcGIS returns 429, searchParcels throws, every record got
    // tagged "Roll # not found" with no signal to the user).
    const fetchErrors = [];
    const fetches = [...byMuni.entries()].map(async ([muni, recs]) => {
      const rolls = recs.map((r) => r.rollNumber).filter(Boolean).join(',');
      let fc = { type: 'FeatureCollection', features: [] };
      try {
        fc = await searchParcels({ municipality: muni, roll: rolls });
      } catch (err) {
        console.warn(`searchParcels failed for ${muni}`, err);
        fetchErrors.push({ muni, message: err.message || String(err) });
      }
      // A lookup that stopped short has established NOTHING about the rolls it
      // never reached, so the "not in Roll_Entry" reason below would be a plain
      // falsehood for them. Carried out to the summary line too — a silently
      // short result set is the one failure the user cannot see in the grid.
      const lookupTruncated = fc._truncated === true;
      // Reconcile this muni's CSV rows down to distinct SALES before
      // stamping. A MAO export repeats a portfolio sale's block once
      // per member, so the same (roll, date, price) can appear several
      // times — those collapse. A roll sold twice on different dates
      // is two comps and both survive; each becomes its own feature
      // below. See lib/salesDedupe.js for the identity rules (muni is
      // part of the key: roll 300.000 exists in most RMs).
      const { salesByRoll, duplicateRows } = dedupeSalesByRoll(recs, {
        canonicalRoll,
        saleDateValue: parseSaleDate,
      });

      // Expand to one feature per SALE (see lib/salesDedupe.js), so a
      // repeat-sold parcel gets its own table row, sale-group rollup and
      // export line per transaction. Only the _saleSeq 0 feature is
      // drawn on the map — see dedupeParcelFeaturesForMap().
      const { features, matchedRolls, matchedSales } = expandFeaturesBySale(
        fc.features,
        salesByRoll,
        (p, sale, saleSeq, sales) => {
          // Group date/price: parseSalesCsv already copied the
          // primary's saleDate + consideration onto every member of
          // the group, so reading them here works regardless of
          // whether this row was the primary or a continuation.
          p._saleDate        = sale.saleDate || null;
          p._salePrice       = sale.consideration || null;
          p._primaryProperty = sale.primaryProperty || null;
          // MAO's own Residential / ICI / Farm classification, which is the
          // top layer of the Primary Property filter. Present only on the
          // database export — a hand-pasted MAO block is the seven-column
          // grid with no type column — so null is normal, not a fault, and
          // primaryProperty.js infers the family from the descriptor when
          // it is missing.
          p._saleTypeGroup   = sale.saleTypeGroup || null;
          // N1 comp-database ID from the crosswalk column. Null (not '')
          // when absent so the N1 filter's truthiness test reads clean.
          p._n1Id            = sale.n1Id || null;
          // CSV's raw "Legal Description" cell. Lives alongside the
          // legal-index-derived _plan/_legalDescription so the Plan #
          // filter can fall back to substring-matching against the
          // CSV-supplied text when the legal-index has no record for
          // this roll (e.g. Headingley sales 6163 / 6165 carry
          // "6--66600" / "4--66600" in the CSV but no legal-index hit
          // → _plan is null and the filter would otherwise miss them).
          p._csvLegal        = sale.legalDescription || null;
          // At-sale parcel size + how far this sale's evidence supports the
          // boundary we are about to draw, from the MAO database export's
          // Parcel Size / Parcel Size Unit / Parcel Change columns.
          //
          // The pipeline has already decided which size is safe to analyse
          // from — the PDF's at-sale figure, today's figure where the parcel
          // is verified unchanged, or nothing at all — so this only carries
          // that verdict onto the feature. See lib/saleSize.js for why a
          // blank must never fall back to today's acreage, and why a pasted
          // comp set (which has none of these columns) keeps the old
          // behaviour instead.
          Object.assign(p, saleSizeStamp(sale));
          // Group identity for the on-hover sibling-highlight + the
          // group price-per-acre / price-per-sf table columns. Used
          // by handleSalesUpload's group-totals pass below.
          p._saleGroupId  = sale.groupId;
          p._saleIsPrimary = sale.isPrimary;
          // Pre-formatted history for the map popup. Only the most
          // recent sale's feature reaches the map source, so without
          // this the popup would present a repeat-sold parcel as if it
          // had transacted once. A plain string (not an array) because
          // MapLibre stringifies non-scalar feature properties on the
          // way through the GeoJSON source.
          if (sales.length > 1) {
            p._saleHistoryText = sales
              .map((s) => [s.saleDate || 'undated', s.consideration || ''].join(' ').trim())
              .join(' · ');
          }
        },
      );
      fc = { ...fc, features };

      return {
        muni,
        fc,
        total: recs.length,
        matched: matchedSales,
        parcels: matchedRolls.size,
        duplicateRows,
        lookupTruncated,
        // Roll_No_Txt simply not in Roll_Entry for this muni (most
        // common cause: typo / old roll / wrong muni assignment in the
        // source CSV) — unless the lookup itself stopped short, in which
        // case these rolls were never queried and the miss is ours.
        unmatched: unmatchedSales(
          salesByRoll,
          matchedRolls,
          lookupTruncated
            ? `${muni} roll lookup stopped at its ceiling before reaching this roll — not a Roll_Entry miss`
            : `Roll # not found in Roll_Entry for ${muni}`,
        ),
      };
    });
    const results = await Promise.all(fetches);

    // Merge all FCs into one parcelFc. Per-muni unmatched buckets fold
    // into the global unmatchedRecords list so the panel surfaces all
    // three reasons (empty / muni-unrecognised / not-in-Roll-Entry) in
    // a single place.
    const parcelFc = { type: 'FeatureCollection', features: [] };
    let totalMatched = 0;
    // Counts for the summary line. `totalMatched` is now distinct SALES
    // plotted (a parcel sold twice contributes 2), so it needs its own
    // parcel count alongside it — the two differ whenever the upload
    // holds a repeat sale, and reporting only one of them against a
    // raw CSV row count is what made the old line unreadable.
    let totalParcels = 0;
    let totalDuplicateRows = 0;
    for (const r of results) {
      parcelFc.features.push(...(r.fc.features || []));
      totalMatched += r.matched;
      totalParcels += r.parcels || 0;
      totalDuplicateRows += (r.duplicateRows || []).length;
      unmatchedRecords.push(...(r.unmatched || []));
    }
    // Munis whose roll lookup stopped short. This has to be said out loud: a
    // truncated result set looks exactly like a complete one in the grid, and
    // before this the only trace was an unmatched panel blaming Roll_Entry.
    const truncatedMunis = results.filter((r) => r.lookupTruncated).map((r) => r.muni);
    // Distinct sales the CSV actually described, after collapsing exact
    // re-listings: everything that plotted plus everything whose roll
    // wasn't in Roll_Entry. This is the honest denominator — `records`
    // counts rows, and rows are not sales.
    const totalSales = totalMatched + unmatchedRecords.length;

    if (parcelFc.features.length === 0) {
      // Distinguish a clean "no matches" (CSV rows don't exist in
      // Roll_Entry) from a fetch-side failure (the most common cause
      // of zero matches in practice: ArcGIS rate-limited the bulk
      // query). Surface the error so the user can retry instead of
      // chasing imagined CSV problems.
      if (fetchErrors.length > 0) {
        const rateLimited = fetchErrors.some((e) => /429|rate-limited/i.test(e.message));
        if (rateLimited) {
          setCount(`Upload failed: ArcGIS rate-limited. Wait ~60s and try again. (${fetchErrors.length} muni fetch${fetchErrors.length === 1 ? '' : 'es'} failed)`);
        } else {
          setCount(`Upload failed: ${fetchErrors[0].message}. Retry or check Roll_Entry for ${fetchErrors[0].muni}.`);
        }
      } else {
        setCount(`No matching parcels found for the ${records.length} CSV rows. ` +
                 `Check that municipality names and roll numbers match Roll_Entry.`);
      }
      renderUnmatchedPanel(unmatchedRecords);
      return;
    }

    // Stamp _rowKey + _rollDisplay + _acres so the table/map pipeline
    // behaves the same as a regular search. Also lift OBJECTID up to
    // the GeoJSON feature.id so MapLibre's setFeatureState() can
    // address each parcel by id (used for the multi-parcel-sale
    // sibling highlight on hover).
    for (const f of parcelFc.features) {
      const oid = f.properties?.OBJECTID;
      if (oid != null) {
        // _rowKey addresses a TABLE ROW, so it must be unique per sale —
        // a repeat-sold parcel has one row per sale. The most recent
        // sale (_saleSeq 0) keeps the bare `p:<oid>` key so a map click,
        // which can only resolve to the one drawn polygon, still scrolls
        // to that parcel's primary row exactly as before.
        const seq = f.properties._saleSeq;
        f.properties._rowKey = seq ? `p:${oid}#${seq}` : `p:${oid}`;
        f.id = oid;
      }
      const r = f.properties?.Roll_No_Txt;
      if (typeof r === 'string') {
        f.properties._rollDisplay = r.endsWith('.000') ? r.slice(0, -4) : r;
      }
      const ac = parcelAcres(f);
      if (Number.isFinite(ac) && ac > 0) f.properties._acres = ac;
    }

    // Always-on legal enrichment: same path runSearch uses.
    const parcelKeys = [];
    for (const f of parcelFc.features || []) {
      const k = parcelLegalKey(f.properties || {});
      if (k) parcelKeys.push(k);
    }
    try {
      const recs2 = await lookupLegalRecordsByParcelKeys(parcelKeys);
      if (recs2.length > 0) attachLegalMetadata(parcelFc, recs2);
    } catch (err) {
      console.warn('Legal lookup for sales upload failed (non-fatal):', err);
    }

    // Per-parcel vacant-land enrichment from the MAO-derived assessment
    // index. Each matched parcel gets its latest-year land/buildings/
    // total stamped onto the feature, plus a boolean _isVacantLand
    // flag computed via the strict isVacantLand() predicate (land > 0
    // AND buildings/total < 2%). Parcels missing from the shard get
    // _isVacantLand = undefined — the filter treats that as 'not
    // known to be vacant' so they drop out of "Vacant land only"
    // results. Non-fatal: any error here just leaves the flags off
    // and the filter degrades gracefully.
    //
    // Prefetch every muni's assessment shard up front so the loop
    // below hits an in-memory cache for every lookup. Without this
    // the per-parcel lookupAssessment calls would fan out as one
    // shard fetch per muni serially — fine in steady state thanks
    // to the in-flight Promise dedup, but slower than firing them
    // all in parallel here. When shards aren't available (older
    // builds without the per-muni JSONs), prefetch is a no-op and
    // the loop falls back to the full-index worker path.
    const muniNos = new Set();
    for (const f of parcelFc.features || []) {
      const key = parcelLegalKey(f.properties || {});
      if (!key) continue;
      muniNos.add(Number(key.split('|')[0]));
    }
    if (muniNos.size > 0) {
      try { await prefetchAssessmentShards([...muniNos]); } catch { /* non-fatal */ }
    }

    for (const f of parcelFc.features || []) {
      const key = parcelLegalKey(f.properties || {});
      if (!key) continue;
      const [muniStr, rollStr] = key.split('|');
      const rec = await lookupAssessment({
        muni_no: Number(muniStr),
        roll_no_txt: rollStr,
      }).catch(() => null);
      if (!rec) continue;
      f.properties._asmtLand       = rec.land;
      f.properties._asmtBuildings  = rec.buildings;
      f.properties._asmtTotal      = rec.total;
      f.properties._asmtYear       = rec.year;
      f.properties._asmtPctBldg    = rec.pctBuildings;
      f.properties._asmtClass      = rec.class || '';
      f.properties._asmtStatus     = rec.tax_status || '';
      f.properties._isVacantLand   = isVacantLand(rec);
    }

    // Activate the Sale Date / Sale Price columns.
    if ($resultsTable) $resultsTable.classList.add('sales-mode');
    // Reveal the sidebar's size-range filter row (gated by CSS on
    // body.sales-mode). Toggling on body rather than the sidebar
    // alone keeps the rule shape simple and lets future sales-only
    // affordances anywhere in the layout share the same gate.
    document.body.classList.add('sales-mode');

    // Assign the stable map-numbering sequence (muni then Roll #) for
    // this uploaded sales set, so the "Number parcels" toggle works on
    // comp maps the same way it does for a roll-list search.
    //
    // Numbering is per PARCEL, not per sale row: a parcel that sold
    // twice is one polygon and must carry one badge, so the number is
    // assigned on the deduped list and then copied onto that parcel's
    // other sale rows. Both of its table rows therefore show the same
    // "#", which reads correctly — they are the same parcel on the map.
    const uniqueParcels = uniqueParcelFeatures(parcelFc.features);
    if (uniqueParcels.length > 1) assignParcelSeq(uniqueParcels);
    else clearParcelSeq(parcelFc.features);
    if (uniqueParcels.length !== parcelFc.features.length) {
      const seqByOid = new Map();
      for (const f of uniqueParcels) seqByOid.set(f.properties?.OBJECTID, f.properties?._seq);
      for (const f of parcelFc.features) {
        const s = seqByOid.get(f.properties?.OBJECTID);
        if (s != null) f.properties._seq = s;
      }
    }

    // Render parcels-only rows immediately, then run the same
    // overlay enrichment pipeline runSearch uses (respecting the same
    // ENRICHMENT_THRESHOLD threshold).
    renderTable(parcelFc.features.map((p) => ({ parcel: p, zoning: [], devPlan: [] })));
    // A sales export must never race ahead of the full parcel enrichment.
    // It is re-enabled by the final render after every requested dataset
    // has either loaded or reported that no coverage is available.
    setExportEnabled(false);
    setMapData(parcelFc, EMPTY_FC, EMPTY_FC);

    // Single combined "N unmatched" suffix that pairs with the panel
    // below the count line — the panel surfaces the per-row reasons
    // (empty, muni-unrecognised, not-in-Roll-Entry) so the count text
    // doesn't have to break it down inline.
    const unmatchedNote = unmatchedRecords.length > 0
      ? ` · ${unmatchedRecords.length} unmatched (see panel)`
      : '';
    // Sales, parcels and CSV rows are three different numbers and the
    // line now says so. The old text read "459 of 556 sales plotted",
    // comparing parcels found against rows read — which looked like ~90
    // missing sales when nothing was missing at all.
    //
    //   sales   distinct (parcel, date, price) events after collapsing
    //           the export's repeated portfolio blocks
    //   parcels distinct rolls those sales touched — fewer than sales
    //           whenever something sold more than once
    //
    // The merged-duplicates note is what lets the user reconcile back to
    // the raw CSV: sales + duplicates merged = rows they uploaded. Each
    // note is omitted when it would be a no-op, so a plain upload with
    // no repeats and no duplicates reads exactly as it always did.
    const parcelNote = totalParcels !== totalMatched
      ? ` across ${totalParcels} parcels`
      : '';
    const dupeNote = totalDuplicateRows > 0
      ? ` · ${totalDuplicateRows} duplicate row${totalDuplicateRows === 1 ? '' : 's'} merged`
      : '';
    const truncNote = truncatedMunis.length > 0
      ? ` · ⚠ roll lookup incomplete for ${truncatedMunis.join(', ')} — sales are MISSING, not absent`
      : '';
    // Parcels reduced to a pin because they changed after their sale. This is
    // the path where that actually happens (setMapData above has already run,
    // so the count is in hand), and it needs saying out loud: a pin among
    // polygons otherwise reads as a rendering glitch rather than a finding.
    const withheldMsg = withheldNote(lastWithheldGeometry);
    const withheldNoteText = withheldMsg ? ` · ${withheldMsg}` : '';
    const baseMsg = `${totalMatched} of ${totalSales} sales plotted${parcelNote}`
                  + `${dupeNote}${unmatchedNote}${truncNote}${withheldNoteText}`;
    renderUnmatchedPanel(unmatchedRecords);

    // Auto-set the muni dropdown to a "dominant" muni — the one with
    // the most matched parcels in the upload. Single-muni uploads
    // continue to behave exactly the same (their only muni is the
    // dominant). Multi-muni uploads now also get a dominant muni
    // set so the muni-scoped affordances (MASC Rating, CLI Soil,
    // Muni Website, PD Website, the Other-Searches category dropdown,
    // and the size/vacant filter sales-only rows) all enable
    // themselves instead of staying disabled until the user manually
    // picks a muni. The dropdown stays interactive so the user can
    // switch to a different muni in the upload to view its overlays.
    //
    // Two things stay scoped to truly-single-muni uploads, marked
    // with the `isSingleMuni` flag below: (a) the `inputsMuni` passed
    // to enrichOverlays — multi-muni needs the per-parcel spatial
    // query path so zoning/dev-plan reach every parcel, not just the
    // dominant's; (b) the Roll Layer auto-toggle — Roll Layer renders
    // one muni's parcel fabric at a time, and surfacing only the
    // dominant's would mislead in a multi-muni context.
    // Ranked by PARCEL count, not sale count — "dominant muni" means the
    // one holding most of the upload's geography, and a single parcel
    // that sold three times shouldn't outweigh three separate parcels.
    const matchedByMuni = results
      .filter((r) => r.parcels > 0)
      .slice()
      .sort((a, b) => b.parcels - a.parcels || a.muni.localeCompare(b.muni));
    const matchedMuniSet = new Set(matchedByMuni.map((r) => r.muni));
    const matchedMuniCount = matchedMuniSet.size;
    const isSingleMuni = matchedMuniCount === 1;
    // Stash the full matched-muni list BEFORE the dropdown dispatch
    // below so resetMascAndGridToggles (which reads csvMatchedMunis to
    // decide the overlay loadKey) sees the new sales-mode value when
    // its 'change' handler runs. Sorted so loadKey comparison is stable.
    csvMatchedMunis = [...matchedMuniSet].sort();
    let dominantMuni = '';
    if (matchedByMuni.length > 0) {
      dominantMuni = matchedByMuni[0].muni;
      if ($municipality.value !== dominantMuni) {
        $municipality.value = dominantMuni;
        $municipality.dispatchEvent(new Event('change'));
      }
    }
    // Only pass the muni to enrichOverlays when the upload is truly
    // single-muni — multi-muni gets the matched-muni list so
    // enrichOverlays can fan out per-muni bulk overlay fetches in
    // parallel (one fetch per muni) instead of the per-parcel
    // envelope query path (one fetch per parcel × N).
    const inputsMuni = isSingleMuni ? dominantMuni : '';
    const fakeInputs = isSingleMuni
      ? { municipality: inputsMuni }
      : { municipalities: csvMatchedMunis.slice() };

    // Deliberately NOT mirroring runSearch's auto-toggle of the
    // Assessment Parcels layer here. A Property Search is a "where is
    // this parcel" question, so the surrounding grey fabric is context
    // worth having for free. A sales import is the opposite: the comps
    // ARE the subject of the map, and burying them under every parcel in
    // the municipality is noise the user then has to switch off. The
    // toggle is still one click away in Map layers > Parcel layers.

    // Sales Analysis is an appraisal-data workflow, so a completed import
    // means the parcel rows are fully enriched—not merely plotted. Load the
    // same zoning, development-plan, risk-area, MASC-rating, and land-cover
    // data as Property Search, then load and compose the Manitoba Soil
    // Survey polygons for every municipality represented in the import.
    // Development-plan designations are NOT loaded here. Joining them was
  // ~70 s of a ~100 s import — the single largest cost — because the
  // layer carries polygons an order of magnitude more complex than
  // zoning (35,729 vertices at the top end vs 2,893). They aren't part
  // of the sales workflow, so the Dev Plan Layer toggle loads them on
  // demand and backfills the grid, popup and export columns.
  devPlanDeferred = true;
  await enrichOverlays(parcelFc, fakeInputs, baseMsg, { skipDevPlan: true });
    setExportEnabled(false);
    setCount(`${baseMsg} · Loading soil survey data…`);
    const soilResult = await enrichImportedSoilComposition(
      parcelFc,
      csvMatchedMunis,
      uploadGeneration,
      'sales',
    );
    if (soilResult.superseded) return;
    salesExportEnrichmentComplete = soilResult.complete;

    // Compute multi-parcel sale group totals AFTER the enrichment
    // pipeline has stamped _acres on every parcel. Each parcel in a
    // group gets _saleGroupSize, _saleGroupTotalAcres, _saleGroupPpa
    // (price/acre), _saleGroupPpsf (price/sf), and a list of sibling
    // OBJECTIDs for the on-hover highlight. _saleGroupAcresIncomplete
    // flips true if any group member's acreage is missing — popups
    // then surface 'insufficient data' rather than a misleading
    // partial-acreage rate.
    computeSaleGroupTotals(parcelFc);

    // Subject parcel comparison — stamp centroid-to-centroid distance
    // from the subject (if one is set) onto every parcel. Re-runs on
    // every upload so a newly-uploaded CSV inherits distances from
    // the existing subject without the user having to re-Set it.
    if (subjectCentroid) {
      for (const f of parcelFc.features) {
        const c = computeCentroid(f);
        if (c) f.properties._distanceKm = haversineKm(subjectCentroid, c);
      }
    }

    // Populate the Class filter from the upload's matched parcels.
    // Re-run on every upload since the available values depend on
    // which parcels matched; setOptions keeps any ticked class that
    // still exists in the new list, so refiltering across uploads
    // doesn't silently reset. (`statuses` is still returned by the
    // helper and still feeds the popup / export — there's just no
    // status filter control to fill any more.)
    const { classes } = uniqueClassesAndStatuses(parcelFc);
    asmtClassFilter.setOptions(classes);

    // Subject muni picker — populated for EVERY upload, including
    // single-muni ones.
    //
    // It used to hide itself below two munis, on the reasoning that a
    // one-option dropdown says nothing. But a roll number does not
    // identify a parcel on its own — the same roll exists in many
    // municipalities — so on a single-muni upload the picker was the
    // only thing that would have shown WHICH muni the roll was being
    // fetched from, and it was exactly the case where it was hidden.
    // A one-option dropdown answering that is worth its row.
    //
    // Defaults to the dominant muni (most matched parcels), so typing a
    // roll without touching the picker gets the likeliest match.
    if ($subjectMuni && $subjectMuniRow) {
      const munis = Array.isArray(csvMatchedMunis) ? csvMatchedMunis : [];
      $subjectMuni.innerHTML = '';
      for (const m of munis) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        $subjectMuni.appendChild(opt);
      }
      // dominantMuni is the highest-matched-count muni captured earlier
      // in this function — fall back to the first matched muni if it's
      // not in scope here for any reason.
      const defaultMuni = dominantMuni || munis[0];
      if ([...$subjectMuni.options].some((o) => o.value === defaultMuni)) {
        $subjectMuni.value = defaultMuni;
      }
      // Only hidden when there is nothing at all to pick from, which
      // would leave an empty select claiming to name a municipality.
      $subjectMuniRow.hidden = munis.length === 0;
    }

    // Runtime debugging — expose the post-stamp parcelFc + parcelHtml so the
    // tooltip / hover path can be inspected from the console without
    // re-running the upload pipeline.
    window.__parcelFc = parcelFc;
    window.__parcelHtml = parcelHtml;
    window.__csvMatchedMunis = csvMatchedMunis;

    // Re-push the parcels source to MapLibre so the hover handler can
    // see _saleGroupRollIds + per-group totals on the rendered features.
    // setMapData() was already called pre-enrichment (line ~1229) and
    // again inside enrichOverlays (after the zoning/dev-plan join lands),
    // but both fired BEFORE computeSaleGroupTotals stamped the group
    // properties — so the source still held the pre-stamp shape and the
    // multi-parcel-sale sibling highlight never fired on hover. Pushing
    // again here syncs the map source with the now-stamped parcelFc;
    // `fit: false` keeps the viewport where the user already is.
    setMapData(parcelFc, lastZoningFc || EMPTY_FC, lastDevPlanFc || EMPTY_FC, { fit: false });

    // Re-apply starred feature-state for any parcels in the existing
    // favourites Set. Lets a user re-upload a CSV they've already
    // starred and have the stars surface immediately on both the
    // map (dark-red fill) and the table (pink shading).
    applyStarredFromFavorites(parcelFc);

    // Lock in the enriched row set so post-upload Other-Searches
    // filter changes can re-filter without another fetch. We snapshot
    // currentRows (set by renderTable inside enrichOverlays) rather
    // than recomputing — that way zoning/dev-plan joins aren't lost.
    csvFullRows = currentRows.slice();
    csvFullBaseMsg = baseMsg;
    // The zoning join is in by now (enrichOverlays ran above), so the
    // Zoning picker can offer exactly the codes these results carry.
    syncZoningFilterOptions();
    // csvFullRows is the live filter's base from here on; drop any stash
    // captured against the pre-upload rows.
    resetWaterFilterBase();
    // Render once more so the new group columns / popup data show
    // up immediately. A no-op for the table if already rendered, but
    // updates the Group Size / $/ac / $/sf cells that depend on the
    // group totals just computed.
    renderTable(currentRows);
    // If the user typed filter values BEFORE the upload finished
    // (e.g. set Lo Ac while the network round-trip was still in flight),
    // refilterCsvIfActive's early-return on csvFullRows==null swallowed
    // those edits. Run one final pass now that csvFullRows is locked
    // in so any pre-set filters apply immediately instead of needing
    // the user to bump the input again to retrigger the listener.
    refilterCsvIfActive();
    setExportEnabled(salesExportEnrichmentComplete && currentRows.length > 0);
    if (soilResult.complete) {
      // Carry the water-rights filter note through — enrichOverlays folded
      // it into its own copy of baseMsg, which this line replaces.
      const filtered = lastWaterFilterDropped > 0 ? ` · ${waterFilterDropNote()}` : '';
      setCount(`${baseMsg}${filtered} · all available parcel data loaded`);
    } else {
      const failedMunis = soilResult.failures.map((failure) => failure.muni).join(', ');
      setCount(
        `${baseMsg} · Soil data failed for ${failedMunis}; export disabled. Retry the import.`,
      );
    }
  } finally {
    setBusy(false);
  }
}

/**
 * Walk the post-enrichment parcel FC and compute per-group rollups
 * for multi-parcel sales:
 *   _saleGroupSize          — N parcels in this sale
 *   _saleGroupTotalAcres    — sum of _acres across the group
 *   _saleGroupTotalPriceNum — parsed numeric of consideration
 *   _saleGroupPpa           — total price / total acres
 *   _saleGroupPpsf          — total price / (total acres × 43560)
 *   _saleGroupTotalFrontageFt — sum of roll-stated frontage feet
 *   _saleGroupPpff          — total price / total frontage feet, null
 *                             unless EVERY member states a frontage
 *   _saleGroupRollIds       — array of sibling OBJECTIDs (for the
 *                             hover-highlight feature-state lookup)
 *   _saleGroupAcresIncomplete — true if any group member is missing
 *                               _acres; ppa/ppsf left null and the
 *                               popup says 'insufficient data'
 * Single-parcel sales (groupId unique to one parcel) get the same
 * stamps but with size=1; UI then shows just the per-parcel price.
 */
/**
 * Render the unmatched-records panel below the search count. Hidden
 * when the input list is empty; otherwise mounts a sortable / scrollable
 * table of dropped CSV rows alongside their reason and a Download CSV
 * button. The panel state is held in DOM only — no module-level state,
 * so re-rendering with an empty array fully resets it.
 *
 * Three reason buckets surface here:
 *   - 'Roll # or Municipality blank in CSV row'  (caught pre-API)
 *   - 'Municipality not recognised: "<raw>"'    (normalizeMuniFromCsv → '')
 *   - 'Roll # not found in Roll_Entry for <muni>'  (API returned no match)
 */
function renderUnmatchedPanel(unmatched) {
  const $panel = document.getElementById('unmatched-panel');
  const $summary = $panel?.querySelector('.unmatched-summary');
  const $tbody = $panel?.querySelector('.unmatched-table tbody');
  const $download = document.getElementById('unmatched-download');
  if (!$panel || !$summary || !$tbody || !$download) return;
  if (!unmatched || unmatched.length === 0) {
    $panel.hidden = true;
    $tbody.innerHTML = '';
    return;
  }
  $summary.textContent = `${unmatched.length} unmatched record${unmatched.length === 1 ? '' : 's'} — click to expand`;
  // Build the body as one big string instead of per-row appendChild —
  // the unmatched lists are usually small (<20) but this stays fast at
  // the top of the range too. esc() keeps the source CSV's quirks
  // (ampersands, angle brackets, quotes) from breaking the markup.
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const td = (s) => `<td>${esc(s)}</td>`;
  const rows = unmatched.map((u) =>
    // `reason-col` class on the <td> mirrors the <th> class so the
    // CSS rule that hides the Reason column for now still finds
    // every cell to hide. Flip the rule in style.css to bring it
    // back; the data is always present.
    `<tr>${td(u.rollNumber)}${td(u.municipality)}${td(u.saleDate)}${td(u.consideration)}${td(u.legalDescription)}<td class="reason reason-col">${esc(u.reason)}</td></tr>`
  ).join('');
  $tbody.innerHTML = rows;
  $panel.hidden = false;
  // Wire Download CSV — re-bind every render so the latest list is
  // captured. Older bindings get garbage-collected with the closure.
  $download.onclick = () => downloadUnmatchedCsv(unmatched);
}

/**
 * Render the resolved-list pill above the action row. Shows the
 * count + spanning muni count once a list has been imported, plus a
 * × button that drops back to normal Property Search mode.
 *
 * Also flips the .list-mode-active class on the Property Search tab
 * panel so CSS can mute the muni dropdown + roll chip while the
 * imported list takes precedence (the panel-level class is a single
 * point for style adjustments rather than per-element disabled state,
 * which would be harder to undo on Clear).
 */
function renderListPill() {
  const $row = document.getElementById('parcel-list-pill-row');
  const $label = document.getElementById('parcel-list-pill-label');
  const $panel = document.getElementById('tab-panel-property');
  if (!$row || !$label) return;
  if (!Array.isArray(listParcelKeys) || listParcelKeys.length === 0) {
    $row.hidden = true;
    $label.textContent = '';
    $panel?.classList.remove('list-mode-active');
    $resultsTable?.classList.remove('list-import-mode');
    applyColumnVisibility();
    return;
  }
  const munis = new Set(listParcelKeys.map((k) => Number(k.muni_no)));
  const n = listParcelKeys.length;
  const m = munis.size;
  $label.textContent = `Imported list: ${n} parcel${n === 1 ? '' : 's'} across ${m} municipalit${m === 1 ? 'y' : 'ies'}`;
  $row.hidden = false;
  $panel?.classList.add('list-mode-active');
  $resultsTable?.classList.add('list-import-mode');
  applyParcelImportDefaults();
}

/**
 * Reuse renderUnmatchedPanel for the import flow's unresolved rows.
 * Maps the resolver's row shape ({lineNo, roll, muniNo, legal, title,
 * raw, reason}) into the panel's expected shape so the existing
 * markup stays unchanged. Toggles a list-import-mode class on the
 * panel so the Sale Date / Sale Price columns hide for imports —
 * the sales-only column visibility on the unmatched table is per-
 * panel, not per-row, so the class lives on the panel itself.
 */
function renderListUnresolvedDrawer() {
  const $panel = document.getElementById('unmatched-panel');
  if (!$panel) return;
  const rows = listUnresolvedRows || [];
  if (rows.length === 0) {
    $panel.classList.remove('list-import-mode');
    // Defer to the sales path's own panel state — calling
    // renderUnmatchedPanel([]) hides cleanly. Only safe to do when
    // the sales path hasn't populated its own unmatched set.
    if (csvFullRows == null) renderUnmatchedPanel([]);
    return;
  }
  $panel.classList.add('list-import-mode');
  const adapted = rows.map((u) => ({
    rollNumber: u.raw?.roll || (typeof u.roll === 'string' ? u.roll : ''),
    municipality: u.raw?.muni || (u.muniNo != null ? String(u.muniNo) : ''),
    saleDate: '',
    consideration: '',
    legalDescription: u.raw?.legal || (u.legal?.raw || ''),
    reason: u.reason || 'unresolved',
  }));
  renderUnmatchedPanel(adapted);
}

// ====================================================================
// Route planner
// ====================================================================

/** Build the cluster-id vector for fetchDrivingMatrixClustered. The
 *  start point inherits the cluster of its nearest parcel (by
 *  haversine), so the start-leg can land within a real-matrix block
 *  instead of always being a cross-cluster haversine pair. Parcels
 *  cluster by their muni_no. Points without a muni get a unique
 *  per-index cluster so they fall into the cross-cluster bucket. */
function buildClusterIds(startLngLat, parcels) {
  // start = index 0; parcels start at index 1.
  const haversine = (a, b) => {
    const R = 6371, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  // Pick the parcel closest to the start; the start joins that
  // parcel's muni cluster.
  let nearest = -1;
  let best = Infinity;
  for (let i = 0; i < parcels.length; i++) {
    const d = haversine(startLngLat, parcels[i]);
    if (d < best) { best = d; nearest = i; }
  }
  const startCluster = nearest >= 0 && parcels[nearest].muniNo != null
    ? parcels[nearest].muniNo
    : 'orphan-start';
  const ids = [startCluster];
  for (let i = 0; i < parcels.length; i++) {
    const muni = parcels[i].muniNo;
    ids.push(muni != null ? muni : `orphan-${i}`);
  }
  return ids;
}

/** Walk currentRows (the post-search table rows) and pull each parcel's
 *  centroid + display info for the route planner. Rows without geometry
 *  drop silently — the resolver shouldn't produce keys without geometry,
 *  but the guard keeps the planner robust against future shape drift. */
function collectRouteableParcels() {
  const out = [];
  const seen = new Set();
  for (const row of currentRows || []) {
    const f = row?.parcel;
    if (!f?.geometry) continue;
    const p = f.properties || {};
    const key = parcelLegalKey(p);
    if (routeStarredOnly) {
      // Starred subset: favourited parcels only, once each — a repeat-sold
      // parcel contributes several sale rows but is one physical stop —
      // minus the parcel serving as the start point, so the start never
      // appears twice in the Matrix/Directions coordinate list.
      if (!key || !favoriteKeys.has(key)) continue;
      if (key === routeStartExcludeKey || seen.has(key)) continue;
      seen.add(key);
    }
    const bb = bboxOfFeature(f);
    if (!Number.isFinite(bb[0])) continue;
    const lng = (bb[0] + bb[2]) / 2;
    const lat = (bb[1] + bb[3]) / 2;
    out.push({
      lng,
      lat,
      key,
      roll: p._rollDisplay || (typeof p.Roll_No_Txt === 'string'
        ? (p.Roll_No_Txt.endsWith('.000') ? p.Roll_No_Txt.slice(0, -4) : p.Roll_No_Txt)
        : ''),
      muniNo: muniNoFromProps(p),
      address: p.Property_Address || '',
    });
  }
  return out;
}

/** Reveal the route-planner panel. If a token is missing, the trigger
 *  is already disabled — this is defensive. */
function openRoutePanel() {
  if (!hasMapboxToken()) return;
  const $panel = document.getElementById('route-panel');
  if (!$panel) return;
  $panel.hidden = false;
  refreshRouteStartStatus();
  // Re-evaluate the calculate button gating in case currentRows or
  // routeStart changed since the last open.
  refreshCalculateEnabled();
}

function hideRoutePanel() {
  const $panel = document.getElementById('route-panel');
  if ($panel) $panel.hidden = true;
}

/** Clear all route state + UI. Called by the pill clear button and on
 *  any "exit list mode" path so route artefacts don't survive into a
 *  new context. */
function clearRoutePlanner() {
  routeStart = null;
  routeResult = null;
  routeStarredOnly = false;
  routeStartExcludeKey = null;
  routeStartLabel = null;
  setRouteStart(map, null);
  setRouteData(map, [], null);
  setRouteVisible(map, true);  // empty data renders nothing, but visibility stays on
  hideRoutePanel();
  // Reset the panel back to stage 1 so the next open is fresh.
  const $setup  = document.querySelector('#route-panel [data-stage="setup"]');
  const $result = document.querySelector('#route-panel [data-stage="result"]');
  if ($setup)  $setup.hidden  = false;
  if ($result) $result.hidden = true;
  const $err = document.getElementById('route-panel-error');
  if ($err) { $err.hidden = true; $err.textContent = ''; }
  refreshRouteStartStatus();
  refreshCalculateEnabled();
}

function refreshRouteStartStatus() {
  const $status = document.getElementById('route-start-status');
  const $btn = document.getElementById('route-start-btn');
  if (!$status || !$btn) return;
  if (routeStart) {
    // Auto-picked starred start shows its roll, not bare coordinates —
    // "Roll 12345 — most outlying starred" tells the user WHY the route
    // begins there. Built from the roll number, but escaped anyway.
    const label = routeStartLabel
      ? routeStartLabel.replace(/[<>&]/g, '')
      : `${routeStart.lng.toFixed(5)}, ${routeStart.lat.toFixed(5)}`;
    $status.innerHTML = `Start: <strong>${label}</strong>`;
    $btn.textContent = 'Change Start';
  } else {
    $status.innerHTML = 'Start: <em>not set</em>';
    $btn.textContent = 'Set Start (Click Map)';
  }
}

function refreshCalculateEnabled() {
  const $btn = document.getElementById('route-calculate-btn');
  if (!$btn) return;
  const parcels = collectRouteableParcels();
  const canCalc = !!routeStart && parcels.length >= 1 && hasMapboxToken();
  $btn.disabled = !canCalc;
  if (!routeStart) {
    $btn.title = 'Set a start point first.';
  } else if (parcels.length === 0) {
    $btn.title = 'No parcels with geometry on the map — try a fresh Search.';
  } else {
    $btn.title = `Calculate the best route through the ${parcels.length} loaded parcel${parcels.length === 1 ? '' : 's'}.`;
  }
}

async function handleSetStart() {
  // Make sure the panel doesn't intercept the map click — temporarily
  // hide it so the user can pick anywhere on the map. Re-show on
  // resolve/cancel.
  const $panel = document.getElementById('route-panel');
  const wasHidden = $panel?.hidden;
  if ($panel) $panel.hidden = true;
  setCount('Click the map to set the start point (Esc to cancel).');
  const picked = await pickStartFromMap(map);
  if ($panel) $panel.hidden = wasHidden ?? false;
  if (!picked) {
    setCount('Start-point pick cancelled.');
    return;
  }
  routeStart = picked;
  // A manual pick supersedes an auto-picked starred start: drop the label
  // (it named a parcel this start no longer is) and un-exclude that parcel
  // so it rejoins the stop list.
  routeStartLabel = null;
  routeStartExcludeKey = null;
  setRouteStart(map, routeStart);
  refreshRouteStartStatus();
  refreshCalculateEnabled();
  setCount(`Start set at ${routeStart.lng.toFixed(5)}, ${routeStart.lat.toFixed(5)}.`);
}

/**
 * One-click driving route through every starred comp (the ★ column).
 *
 * Start = the most outlying starred parcel, so the route enters the
 * cluster from its far edge and sweeps across once instead of starting
 * mid-cluster and backtracking. That parcel is excluded from the stop
 * list (it IS the start), which also keeps the Matrix/Directions calls
 * free of duplicate coordinates. One-way by construction — an efficient
 * sweep, not a loop back to the far edge — though the panel's
 * round-trip toggle still works for a recalculate.
 *
 * Everything downstream is the existing route planner: Matrix costs
 * (clustered when > 24 stops), TSP solver, Directions polyline,
 * on-screen itinerary and print.
 */
async function startStarredRoute() {
  if (!hasMapboxToken()) return;
  routeStarredOnly = true;
  routeStartExcludeKey = null;   // collect ALL starred first to pick the start
  const stops = collectRouteableParcels();
  if (stops.length < 2) {
    routeStarredOnly = false;
    setCount('Star at least two parcels (★ column) to route them.');
    return;
  }
  const start = stops[mostOutlyingIndex(stops)];
  routeStart = { lng: start.lng, lat: start.lat };
  routeStartExcludeKey = start.key;
  routeStartLabel = `Roll ${start.roll} — most outlying starred`;
  setRouteStart(map, routeStart);
  routeRoundTrip = false;
  const $rt = document.getElementById('route-roundtrip');
  if ($rt) $rt.checked = false;
  openRoutePanel();
  await handleCalculateRoute();
}

/** Enable the Route Starred button only when it can actually route:
 *  a Mapbox token plus at least two unique starred parcels with
 *  geometry in the current rows. Called from the star toggles and
 *  after every render that re-applies starred state. */
function refreshRouteStarredBtn() {
  const $btn = document.getElementById('route-starred');
  if (!$btn) return;
  if (!hasMapboxToken()) {
    $btn.disabled = true;
    $btn.title = 'Route planning needs a Mapbox token — see route planner setup.';
    return;
  }
  const seen = new Set();
  for (const row of currentRows || []) {
    if (!row?.parcel?.geometry) continue;
    const k = parcelLegalKey(row.parcel.properties || {});
    if (k && favoriteKeys.has(k)) seen.add(k);
  }
  $btn.disabled = seen.size < 2;
  $btn.title = seen.size < 2
    ? 'Star at least two parcels (★ column in sales mode) to route them.'
    : `Driving route through the ${seen.size} starred parcels, starting at the most outlying one.`;
}

async function handleCalculateRoute() {
  if (!routeStart) return;
  const parcels = collectRouteableParcels();
  if (parcels.length === 0) return;

  const $err = document.getElementById('route-panel-error');
  if ($err) { $err.hidden = true; $err.textContent = ''; }

  const $calcBtn = document.getElementById('route-calculate-btn');
  const $recBtn  = document.getElementById('route-recalc-btn');
  const prevLabel = $calcBtn?.textContent;
  if ($calcBtn) { $calcBtn.disabled = true; $calcBtn.textContent = 'Calculating…'; }
  if ($recBtn)  $recBtn.disabled = true;
  setBusy(true);
  setCount(`Routing ${parcels.length} stop${parcels.length === 1 ? '' : 's'}…`);

  try {
    // Stop 0 is the start; subsequent indexes are the parcels in
    // input order. The TSP solver returns the index permutation.
    const points = [routeStart, ...parcels];

    // Build the cost matrix. Mapbox Matrix v1 driving caps at 25
    // total coords per call. Two paths:
    //   ≤ 24 stops: one Matrix call covers the whole matrix.
    //   > 24 stops: cluster-aware path — group stops by muni, fetch
    //     real driving costs for within-cluster pairs (where road
    //     grid matters), use haversine for cross-cluster pairs
    //     (highway-distance ≈ great-circle distance once the
    //     clusters are tens of km apart). Real road costs end up
    //     covering nearly all of the optimisation work.
    let duration = null;
    let distance = null;
    let matrixMode = 'real';   // 'real' | 'clustered' | 'haversine'
    let clusterStats = null;
    try {
      const matrix = await fetchDrivingMatrix(points);
      duration = matrix.duration;
      distance = matrix.distance;
    } catch (err) {
      if (err instanceof MatrixTooManyCoordsError) {
        // Cluster by muni — parcels carry their muniNo; the start
        // joins the cluster of its nearest parcel by haversine.
        const clusterIds = buildClusterIds(routeStart, parcels);
        try {
          const matrix = await fetchDrivingMatrixClustered({
            points,
            clusterIds,
          });
          duration = matrix.duration;
          distance = matrix.distance;
          matrixMode = 'clustered';
          clusterStats = {
            clusters: new Set(clusterIds).size,
            realCalls: matrix.realCalls,
            crossClusterPairs: matrix.crossClusterCount,
            anyCallFailed: matrix.anyCallFailed,
          };
        } catch (clusterErr) {
          console.warn('Cluster matrix failed, falling back to haversine:', clusterErr);
          const hav = haversineMatrix(points);
          distance = hav.map((row) => row.map((v) => v * 1000));
          duration = distance;
          matrixMode = 'haversine';
        }
      } else {
        throw err;
      }
    }
    const usedHaversine = matrixMode === 'haversine';
    const usedClusterMatrix = matrixMode === 'clustered';

    // Solver runs on whichever matrix we have. With Mapbox driving it
    // optimises drive time; with haversine it optimises great-circle
    // distance — close enough to road-optimal in Manitoba's mostly-
    // grid rural network.
    const solved = solveRoute(duration, { start: 0, roundTrip: routeRoundTrip });

    // Real driving polyline + authoritative totals. Pass the solved
    // ordered points so the polyline traces the route the planner
    // chose. The Directions response also carries per-leg distance +
    // duration, which we use for the result panel so the cumulative
    // sum matches the reported total (the matrix-derived per-leg
    // values can disagree with the Directions total because of
    // cross-cluster haversine substitution).
    const orderedPoints = solved.order.map((idx) => points[idx]);
    const directions = await fetchDrivingRoute(orderedPoints);

    // Per-leg metrics straight from Directions — authoritative road
    // distance and time per waypoint pair. Fall back to matrix values
    // only if Directions came back with fewer legs than expected
    // (defensive; shouldn't happen).
    const legMeters = [];
    const legSeconds = [];
    for (let k = 0; k < solved.order.length - 1; k++) {
      const leg = directions.legs?.[k];
      if (leg) {
        legMeters.push(leg.distanceMeters);
        legSeconds.push(leg.durationSeconds);
      } else {
        const i = solved.order[k];
        const j = solved.order[k + 1];
        legMeters.push(distance[i][j]);
        legSeconds.push(usedHaversine ? null : duration[i][j]);
      }
    }

    routeResult = {
      orderedIndices: solved.order,
      orderedPoints,
      parcels,
      legMeters,
      legSeconds,
      geometry: directions.geometry,
      polyline: directions.polyline,
      // Totals come from the per-leg sums by construction — same
      // source as the panel's cumulative column, so the two always
      // agree even when one leg was a cluster boundary.
      totalMeters: legMeters.reduce((a, b) => a + (b || 0), 0),
      totalSeconds: legSeconds.reduce((a, b) => a + (b || 0), 0),
      roundTrip: routeRoundTrip,
      usedHaversine,
      usedClusterMatrix,
      clusterStats,
    };

    // Paint stops on the map, in visit order (excluding the start).
    const mapStops = [];
    solved.order.forEach((idx, k) => {
      if (idx === 0) return;                            // skip the start
      if (k === solved.order.length - 1 && idx === 0) return;  // skip the closing-back-to-start dup
      const p = parcels[idx - 1];
      mapStops.push({ lng: p.lng, lat: p.lat, label: String(mapStops.length + 1) });
    });
    setRouteData(map, mapStops, directions.geometry);

    renderRouteResult();
    setCount(formatRouteSummary(routeResult));
  } catch (err) {
    console.error('Route calculation failed:', err);
    if ($err) {
      $err.textContent = `Route calculation failed: ${err.message || err}`;
      $err.hidden = false;
    }
    setCount(`Route calculation failed: ${err.message || err}`);
  } finally {
    if ($calcBtn) { $calcBtn.disabled = false; $calcBtn.textContent = prevLabel || 'Calculate Route'; }
    if ($recBtn)  $recBtn.disabled = false;
    setBusy(false);
    refreshCalculateEnabled();
  }
}

/** Render the result section of the route panel. */
function renderRouteResult() {
  if (!routeResult) return;
  const $setup  = document.querySelector('#route-panel [data-stage="setup"]');
  const $result = document.querySelector('#route-panel [data-stage="result"]');
  const $summary = document.getElementById('route-panel-summary');
  const $stops = document.getElementById('route-panel-stops');
  if ($setup)  $setup.hidden  = true;
  if ($result) $result.hidden = false;
  if ($summary) $summary.textContent = formatRouteSummary(routeResult);
  if ($stops) {
    const r = routeResult;
    let cumM = 0;
    let html = '';
    // Stop 0 is the start. Indices 1..N are the visit-order stops;
    // when round-trip, the final index revisits the start.
    for (let k = 1; k < r.orderedIndices.length; k++) {
      const idx = r.orderedIndices[k];
      const isReturnToStart = (idx === 0);
      const leg = r.legMeters[k - 1] || 0;
      cumM += leg;
      const legText = formatKm(leg / 1000);
      const cumText = formatKm(cumM / 1000) + ' cum';
      if (isReturnToStart) {
        html += `<li>
          <span class="rank">↩</span>
          <span class="body"><span class="roll">Return to start</span></span>
          <span class="leg">${escHtmlSafe(legText)}<span class="cum">${escHtmlSafe(cumText)}</span></span>
        </li>`;
      } else {
        const parcel = r.parcels[idx - 1];
        const rank = k; // 1-based stop number, return-to-start handled above
        html += `<li>
          <span class="rank">${rank}</span>
          <span class="body">
            <span class="roll">Roll ${escHtmlSafe(parcel.roll || '—')}</span>
            ${parcel.address ? `<br><span class="addr">${escHtmlSafe(parcel.address)}</span>` : ''}
          </span>
          <span class="leg">${escHtmlSafe(legText)}<span class="cum">${escHtmlSafe(cumText)}</span></span>
        </li>`;
      }
    }
    $stops.innerHTML = html;
  }
}

function formatRouteSummary(r) {
  const km = (r.totalMeters / 1000);
  const mins = r.totalSeconds / 60;
  const stops = r.parcels.length;
  // Append a small honest tail describing how the matrix was built.
  // - `usedHaversine` is the catastrophic fallback (whole matrix from
  //   straight-line); always surfaced.
  // - `usedClusterMatrix` means real road costs WITHIN each muni
  //   cluster and straight-line BETWEEN clusters — the standard
  //   high-quality path for multi-muni lists. We don't tail-tag this
  //   because the within-cluster real data dominates the ordering
  //   and the cross-cluster haversine is close to road on rural MB
  //   highways.
  let tail = '';
  if (r.usedHaversine) tail = ' · order via straight-line (matrix fallback)';
  return `${stops} stop${stops === 1 ? '' : 's'} · ${formatKm(km)} · ${formatDuration(mins)} · ${r.roundTrip ? 'round trip' : 'one-way'}${tail}`;
}

function formatKm(km) {
  if (!Number.isFinite(km)) return '—';
  return km >= 100 ? `${km.toFixed(0)} km` : `${km.toFixed(1)} km`;
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return `${h} h ${m.toString().padStart(2, '0')} min`;
}

function escHtmlSafe(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function handlePrintItinerary() {
  if (!routeResult || !routeStart) return;
  const $it = document.getElementById('route-itinerary');
  if (!$it) return;

  // Group the ordered stops by cluster (muni). Each cluster gets its
  // own static map so neither the URL-length nor the overlay-count
  // cap on Mapbox Static Images bites. The visit-order rank stays
  // continuous across clusters so the printed list and the maps use
  // the same numbering.
  const clusters = buildPrintClusters(routeStart, routeResult);

  $it.innerHTML = buildPrintItineraryHtml(routeStart, routeResult, clusters);

  // Wait for the cluster maps to load (or 6 s timeout) before
  // calling print() so the browser embeds the images cleanly.
  const imgs = [...$it.querySelectorAll('img.route-itinerary-map')];
  if (imgs.length > 0) {
    await new Promise((r) => {
      let pending = imgs.length;
      const done = () => { if (--pending <= 0) r(); };
      for (const img of imgs) {
        if (img.complete) { done(); continue; }
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }
      setTimeout(r, 6000);
    });
  }
  window.print();
}

/**
 * Group the route's ordered stops by cluster for the print itinerary.
 * Clustering is by parcel.muniNo — Manitoba RMs comfortably fit
 * inside a ~50 km radius for printable scale, which is the resolution
 * the appraiser wants on the page. The route's start point is rendered
 * on the cluster containing its nearest stop (matches the matrix
 * clustering done at calculate time).
 *
 * Returns an array of clusters in visit order, each:
 *   {
 *     muniNo,
 *     stops: [{ parcel, rank }],       // rank = 1-based visit order
 *     bbox: [west, south, east, north],
 *     includesStart: boolean,
 *   }
 *
 * @param {{lng,lat}} startLngLat
 * @param {RouteResult} r
 */
function buildPrintClusters(startLngLat, r) {
  const clusters = new Map();
  const order = [];
  let nearestStartRank = -1;
  let nearestStartDist = Infinity;

  // Step through orderedIndices and bucket by muni in visit order.
  // Each stop's rank reflects its position in the full visit
  // sequence (excluding the closing return-to-start when round-trip).
  for (let k = 1; k < r.orderedIndices.length; k++) {
    const idx = r.orderedIndices[k];
    if (idx === 0) continue; // return-to-start handled below
    const parcel = r.parcels[idx - 1];
    const muniKey = parcel.muniNo != null ? String(parcel.muniNo) : 'unknown';
    if (!clusters.has(muniKey)) {
      clusters.set(muniKey, { muniNo: parcel.muniNo, stops: [], includesStart: false });
      order.push(muniKey);
    }
    clusters.get(muniKey).stops.push({ parcel, rank: k });
    // Track which cluster the start should appear on (the one with
    // the parcel geographically closest to the start).
    const dx = parcel.lng - startLngLat.lng;
    const dy = parcel.lat - startLngLat.lat;
    const d2 = dx * dx + dy * dy;
    if (d2 < nearestStartDist) {
      nearestStartDist = d2;
      nearestStartRank = order.length - 1;
    }
  }
  if (nearestStartRank >= 0) {
    clusters.get(order[nearestStartRank]).includesStart = true;
  }

  // Compute bbox for each cluster so the Static Images "auto" zoom
  // levels the pins nicely without too much surrounding empty map.
  return order.map((k) => {
    const c = clusters.get(k);
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const { parcel } of c.stops) {
      if (parcel.lng < west)  west  = parcel.lng;
      if (parcel.lng > east)  east  = parcel.lng;
      if (parcel.lat < south) south = parcel.lat;
      if (parcel.lat > north) north = parcel.lat;
    }
    if (c.includesStart) {
      if (startLngLat.lng < west)  west  = startLngLat.lng;
      if (startLngLat.lng > east)  east  = startLngLat.lng;
      if (startLngLat.lat < south) south = startLngLat.lat;
      if (startLngLat.lat > north) north = startLngLat.lat;
    }
    return { ...c, bbox: [west, south, east, north] };
  });
}

function buildPrintItineraryHtml(start, r, clusters) {
  const stamp = new Date().toLocaleString();
  const startTxt = `${start.lng.toFixed(5)}, ${start.lat.toFixed(5)}`;

  // Build the stop list (same layout as before, single chronological
  // list — the cluster maps are an additional visual aid, not a
  // restructuring of the itinerary). cumM tracks cumulative distance
  // across the WHOLE route so each row carries an accurate total.
  let cumM = 0;
  let stopsHtml = '';
  for (let k = 1; k < r.orderedIndices.length; k++) {
    const idx = r.orderedIndices[k];
    const leg = r.legMeters[k - 1] || 0;
    cumM += leg;
    if (idx === 0) {
      stopsHtml += `<li>
        <span class="rank">↩</span>
        <span class="body"><span class="roll">Return to start</span></span>
        <span class="leg">${escHtmlSafe(formatKm(leg / 1000))}<span class="cum">${escHtmlSafe(formatKm(cumM / 1000))} cum</span></span>
      </li>`;
    } else {
      const parcel = r.parcels[idx - 1];
      stopsHtml += `<li>
        <span class="rank">${k}</span>
        <span class="body">
          <span class="roll">Roll ${escHtmlSafe(parcel.roll || '—')}</span>${parcel.muniNo != null ? ` · muni ${parcel.muniNo}` : ''}
          ${parcel.address ? `<br><span class="addr">${escHtmlSafe(parcel.address)}</span>` : ''}
        </span>
        <span class="leg">${escHtmlSafe(formatKm(leg / 1000))}<span class="cum">${escHtmlSafe(formatKm(cumM / 1000))} cum</span></span>
      </li>`;
    }
  }

  // One map per cluster. Each map only carries its own pins, so the
  // URL stays well within Mapbox's 8 KB cap and the 100-overlay cap.
  // Stops are numbered using their global visit-order rank so the
  // printed list and the maps line up.
  const clusterMapsHtml = clusters.map((c, idx) => {
    const pins = c.stops.map(({ parcel, rank }) => ({
      lng: parcel.lng,
      lat: parcel.lat,
      label: String(Math.min(99, rank)),
    }));
    const imgUrl = staticClusterImageUrl({
      start: c.includesStart ? start : null,
      pins,
      width: 1100,
      height: 700,
    });
    const head = `Cluster ${idx + 1}${c.muniNo != null ? ` — muni ${c.muniNo}` : ''} · ${c.stops.length} stop${c.stops.length === 1 ? '' : 's'}${c.includesStart ? ' · includes start' : ''}`;
    return `
      <section class="route-itinerary-cluster">
        <h2 class="route-itinerary-cluster-title">${escHtmlSafe(head)}</h2>
        <img class="route-itinerary-map" src="${escHtmlSafe(imgUrl)}" alt="${escHtmlSafe(head)}" />
      </section>`;
  }).join('');

  return `
    <div class="route-itinerary-header">
      <h1 class="route-itinerary-title">Parcel route itinerary</h1>
      <div class="route-itinerary-meta">Generated ${escHtmlSafe(stamp)} · Start ${escHtmlSafe(startTxt)}</div>
    </div>
    <p class="route-itinerary-totals">${escHtmlSafe(formatRouteSummary(r))}</p>
    ${clusterMapsHtml}
    <ol class="route-itinerary-stops">${stopsHtml}</ol>
  `;
}

/** Build a small static-image URL for a single cluster — only pins,
 *  no polyline. Lets Mapbox auto-fit to the pin set so each cluster
 *  prints at a sensible zoom. */
function staticClusterImageUrl({ start, pins, width = 1100, height = 700 }) {
  const overlays = [];
  if (start && Number.isFinite(start.lng) && Number.isFinite(start.lat)) {
    overlays.push(`pin-l-s+16a34a(${start.lng.toFixed(6)},${start.lat.toFixed(6)})`);
  }
  for (const p of pins) {
    overlays.push(`pin-l-${escapeStaticLabel(p.label)}+2563eb(${p.lng.toFixed(6)},${p.lat.toFixed(6)})`);
  }
  const overlay = overlays.join(',');
  const token = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_MAPBOX_TOKEN) || '';
  return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlay}/auto/${width}x${height}@2x?access_token=${token}`;
}

/** Mapbox pin labels can be 1–99 digits, a-z, or maki icon names.
 *  Numbers are clamped at 99 (the docs limit); everything else is
 *  URL-escaped. */
function escapeStaticLabel(label) {
  const n = Number(label);
  if (Number.isFinite(n)) return String(Math.min(99, Math.max(1, Math.round(n))));
  return encodeURIComponent(String(label));
}

/**
 * Generate a CSV blob from the unmatched-records list and trigger a
 * download. Columns mirror the panel table: Roll #, Municipality,
 * Sale Date, Consideration, Street Address, Legal Description,
 * Primary Property, Reason. Filename includes the local-date timestamp
 * so multiple downloads from one session don't clobber each other.
 */
function downloadUnmatchedCsv(unmatched) {
  if (!Array.isArray(unmatched) || unmatched.length === 0) return;
  const header = [
    'Roll #', 'Municipality', 'Sale Date', 'Consideration',
    'Street Address', 'Legal Description', 'Primary Property', 'Reason',
  ];
  const cell = (v) => {
    const s = csvGuardFormula(v == null ? '' : String(v));
    // Quote when the value contains a comma, quote, or newline; double
    // any embedded quotes per RFC 4180.
    return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(cell).join(',')];
  for (const u of unmatched) {
    lines.push([
      u.rollNumber, u.municipality, u.saleDate, u.consideration,
      u.streetAddress, u.legalDescription, u.primaryProperty, u.reason,
    ].map(cell).join(','));
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const a = document.createElement('a');
  a.href = url;
  a.download = `unmatched-sales-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Free the blob URL on the next tick — Chrome holds the reference
  // until the download dialog closes, but other browsers free it
  // immediately so a delayed revoke is the safer cross-browser path.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function computeSaleGroupTotals(parcelFc) {
  const features = parcelFc?.features || [];
  // All the rollup math (acres/assessed sums, $/acre, $/sf, $/lot,
  // sale-to-assessed ratio, vacancy roll-up) lives in the pure,
  // tested lib/saleGroups.js; main.js just stamps the result onto
  // each member feature's properties. The three app-state-dependent
  // helpers are injected so the lib stays pure.
  const stamps = computeSaleGroups(features, {
    parsePrice: parseTotalValue,
    displayRoll,
    isVacant: parcelIsVacantDynamic,
    // Same centre point the export's Lat/Lon and the popup's GPS
    // Coordinates link use, so a sale's reported spread is measured
    // between the exact points the user can read off each parcel.
    centroid: parcelCentrePoint,
    // haversineKm takes {lat, lng} — parcelCentrePoint's shape.
    distanceKm: haversineKm,
  });
  let stampedCount = 0;
  for (const f of features) {
    const gid = f.properties?._saleGroupId;
    if (gid == null) continue;
    const stamp = stamps.get(gid);
    if (!stamp) continue;
    Object.assign(f.properties, stamp);
    stampedCount++;
  }
  console.info(`Sales upload: stamped group totals on ${stampedCount} parcels `
             + `across ${stamps.size} sale groups.`);
}

/**
 * Every zone code present in a row set, sorted, for the Zoning
 * filter's option list.
 *
 * Reads both of a parcel's zoning matches rather than just the
 * dominant one, so a code is listed whenever it appears in either the
 * Zoning or Zoning 2 column — the filter matches on either too, and a
 * tickable value that can never match anything visible would be worse
 * than a slightly longer list.
 *
 * Built from the FULL row set, never the filtered one: a list that
 * shrank as you ticked boxes would strand you with no way back.
 */
function zoningCodesInRows(rows) {
  const codes = new Set();
  for (const row of rows || []) {
    for (const z of row.zoning || []) {
      const code = formatZoneCode(z.feature?.properties);
      if (code) codes.add(String(code).trim());
    }
  }
  return [...codes].filter(Boolean).sort();
}

/** Refresh the Zoning filter's options from the current upload. Safe
 *  to call repeatedly — setOptions keeps any ticked code that still
 *  exists, so a re-render mid-session doesn't reset the filter. */
function syncZoningFilterOptions() {
  zoningFilter.setOptions(zoningCodesInRows(csvFullRows));
  // The type list is derived from the same rows, so it can never offer a
  // type the current upload doesn't hold.
  zoneCatFilter.setOptions(zoneCategoriesInRows(csvFullRows));
  // Primary Property rides in on the sales data rather than on an overlay
  // join, so unlike the two zoning pickers this is populated for every
  // upload the moment it lands — no "Load zoning + dev-plan" needed.
  primaryPropFilter.setGroups(primaryPropertyTree(csvFullRows, {
    saleTypeOf: (r) => r.parcel?.properties?._saleTypeGroup,
    primaryOf:  (r) => r.parcel?.properties?._primaryProperty,
  }));
}

/**
 * Re-apply the Other Searches filters (Zone Category, Status, DU)
 * to the currently-loaded CSV row set. Called whenever the filter
 * inputs change while csvFullRows is set. No-op outside CSV mode —
 * runSearch results are already SQL-filtered, so changing a filter
 * after a regular search shouldn't reshape the table.
 */
function refilterCsvIfActive() {
  if (csvFullRows == null) return;
  const filtered = filterCsvRowsByOtherSearches(csvFullRows);
  const total = csvFullRows.length;
  // Name the far-flung exclusion explicitly. A bare "(filtered)" would
  // leave the user guessing which control removed the rows, and this is
  // the one filter that fires without them touching it on this upload
  // (the toggle persists between sessions).
  const ff = farFlungExcludeOn()
    ? countFarFlung(csvFullRows, farFlungThresholdKm())
    : { sales: 0, parcels: 0 };
  const ffNote = ff.sales > 0
    ? ` · ${ff.sales} far-flung sale${ff.sales === 1 ? '' : 's'} excluded`
    : '';
  // A ticked water-influence box with no resolved shard passes every row
  // through (unknown ≠ excluded), which without a note reads as "every
  // sale qualifies" — same honesty rule renderWaterFilteredView applies.
  const waterNote = waterInfluenceFilterInert(csvFullRows)
    ? " · water-influence data hasn't loaded for these municipalities, so that filter was not applied"
    : '';
  const msg = (filtered.length === total
    ? `${csvFullBaseMsg}${ffNote}`
    : `${filtered.length} of ${total} sales shown (filtered)${ffNote}`) + waterNote;
  setCount(msg);
  renderTable(filtered);
  // Re-narrow the map's parcel highlight to the filtered subset.
  // Overlay sources (zoning / dev-plan) keep their full data so the
  // category fills still cover the whole muni context.
  const fc = {
    type: 'FeatureCollection',
    features: filtered.map((r) => r.parcel),
  };
  // When the filter narrows to zero rows, don't re-fit the map. The
  // empty-FC branch in showResults flies to MB_CENTER (province-wide
  // default), which looks like a bug — e.g. setting Max Distance to
  // 1 km with no comps within that radius zooms out from Headingley
  // to all of Manitoba. Keeping the previous viewport leaves the
  // subject and surrounding context on screen so the user can see
  // "0 of N sales shown" with geographic anchor intact.
  setMapData(fc, lastZoningFc, lastDevPlanFc, { fit: filtered.length > 0 });
  // setData() doesn't carry feature-state from before the re-tile,
  // so re-apply starred state from favoriteKeys after the source
  // refresh. mapReady gate is inside setStarredOnMap.
  applyStarredFromFavorites(fc);
}

// ---------------------------------------------------------------------------
// Area-shape narrowing for plain Property Search results. Sales-CSV
// mode runs shapes inside its full filter pass above; this is the
// basic-mode counterpart, shapes only. The full rendered set is
// snapshotted on first use so erasing shapes (or drawing a wider one)
// restores rows without a re-search; a fresh Search invalidates the
// snapshot alongside clearing the shapes themselves.
// ---------------------------------------------------------------------------

let basicFullRows = null;
let basicFullMsg = '';

function invalidateBasicShapeSnapshot() {
  basicFullRows = null;
  basicFullMsg = '';
}

function refilterBasicByShapes() {
  if (csvFullRows != null) return;   // sales-CSV path owns its filtering
  const shapes = getMapShapes();
  if (basicFullRows == null) {
    if (shapes.length === 0 || currentRows.length === 0) return;
    basicFullRows = currentRows;
    basicFullMsg = $count.textContent || '';
  }
  const total = basicFullRows.length;
  const filtered = shapes.length === 0
    ? basicFullRows
    : basicFullRows.filter((row) => passesShapeFilter(computeCentroid(row.parcel), shapes));
  renderTable(filtered);
  const fc = { type: 'FeatureCollection', features: filtered.map((r) => r.parcel) };
  // Same no-refit-on-zero reasoning as the sales refilter above.
  setMapData(fc, lastZoningFc, lastDevPlanFc, { fit: filtered.length > 0 });
  applyStarredFromFavorites(fc);
  if (shapes.length === 0) {
    setCount(basicFullMsg);
    invalidateBasicShapeSnapshot();
  } else {
    setCount(`${filtered.length} of ${total} parcels shown (area filter)`);
  }
}

function filterCsvRowsByOtherSearches(rows) {
  // Drawn area shapes (radius/rectangle/polygon, include/exclude) —
  // read once per pass; the per-row test is a centroid point-in-shape.
  const drawnShapes = getMapShapes();
  const zoneCat = $zoneCategory?.value || '';
  const status  = $changedStatus?.value || '';
  const duMode  = $duMode?.value || '';
  const duMin   = parseInt($duMin?.value || '', 10);

  // Waterfront / near-water boxes — OR'd with each other, AND'd with
  // everything else, exactly rowPassesWaterFilter's semantics so the
  // sales pass and the property-search view filter can never disagree
  // about what qualifies. Gated per-row on _waterLoaded: a row whose
  // muni shard never resolved is UNKNOWN, not excluded (see
  // rowPassesWaterFilter for the Niverville incident that rule encodes).
  const wantFront = !!$waterfrontOnly?.checked;
  const wantNear  = !!$nearWaterOnly?.checked;

  // Size range — the boxes are read in whichever unit the Ac/SF pill
  // has lit, and converted to acres here because parcelAcres() returns
  // acres. Empty Lo → 0; empty Hi → ∞. The filter only fires when at
  // least one bound is a finite number; both empty is a no-op so users
  // who haven't touched the inputs aren't surprised by parcels
  // disappearing.
  const sizeLoRaw = parseFloat($sizeLow?.value);
  const sizeHiRaw = parseFloat($sizeHigh?.value);
  const sizeUom = getSizeUom();
  // FF is a frontage, not an area, so it is compared in feet against the
  // roll's own figure rather than converted to acres. Ac and SF both
  // resolve to acres because parcelAcres() returns acres.
  const toAcres = sizeUom === 'sf' ? (v) => v / 43560 : (v) => v;
  // Ac and SF are just units for the numbers typed below, so with both
  // boxes empty they filter nothing. FF is not only a unit — it also
  // names a cohort, since roughly 63% of parcels state an area and have
  // no frontage at all. Selecting it is therefore a filter in its own
  // right: it drops the area rows immediately rather than waiting for a
  // bound, because an area row has nothing to show in a frontage view.
  const sizeActive = sizeUom === 'ff'
    || Number.isFinite(sizeLoRaw) || Number.isFinite(sizeHiRaw);
  const sizeLo = Number.isFinite(sizeLoRaw) ? sizeLoRaw : 0;
  const sizeHi = Number.isFinite(sizeHiRaw) ? sizeHiRaw : Infinity;
  const sizeLoAc = sizeUom === 'ff' ? sizeLo : toAcres(sizeLo);
  const sizeHiAc = sizeUom === 'ff' ? sizeHi : toAcres(sizeHi);

  // Sale-date range. Empty from = -Infinity, empty to = +Infinity. The
  // HTML5 date input gives us YYYY-MM-DD strings — parseSaleDate() in
  // main.js handles both that AND the CSV's DD-Mmm-YY native format,
  // so the two ends of the comparison are always JS Dates (or null
  // when unparseable; null sale dates fail the active filter, mirroring
  // the size-range "missing data excluded" behaviour).
  const dateFrom = parseSaleDate($saleDateFrom?.value);
  const dateTo   = parseSaleDate($saleDateTo?.value);
  const dateActive = !!(dateFrom || dateTo);
  const dateFromMs = dateFrom ? dateFrom.getTime() : -Infinity;
  // Inclusive 'to' — bump by 24h - 1ms so a sale on the 'to' day passes.
  const dateToMs   = dateTo   ? dateTo.getTime() + 86399999 : Infinity;

  // Class filter — multi-select. Read the ticked values into a Set for
  // O(1) lookup. Empty set = no filter. A parcel missing assessment
  // data is excluded when at least one class is ticked, matching the
  // original single-select behaviour.
  const classFilterSet = new Set(asmtClassFilter.getSelected());
  // Zoning codes ticked in the sales-tab picker. Separate from the
  // Property tab's zoneCat below: that one filters on ZONE_CATEGORY
  // chosen from the by-law, this one on the ZONE codes present in
  // these results.
  const zoneCodeFilterSet = new Set(zoningFilter.getSelected());
  // Zoning TYPE ticks. Independent of both the code picker above and the
  // Property tab's single zoneCat below: this one is multi-select and its
  // options come from the current upload, which is what makes it usable on
  // a multi-muni set where no single code spans the whole thing.
  const zoneCatFilterSet = new Set(zoneCatFilter.getSelected());

  // Primary Property ticks, resolved to SALE GROUPS in one pass up front
  // rather than tested per row.
  //
  // Group semantics, like the far-flung / size / price filters: a
  // multi-parcel sale passes or fails as one transaction. Ticking "One
  // storey" on a sale that bundles a house and a bare lot has to keep both
  // rows, because dropping the lot would leave the group's $/Acre and $/SF
  // describing land no longer on screen. That cannot be decided row by
  // row, hence the pre-pass; null means nothing is ticked.
  const primaryPropAccessors = {
    saleTypeOf: (r) => r.parcel?.properties?._saleTypeGroup,
    primaryOf:  (r) => r.parcel?.properties?._primaryProperty,
    groupIdOf:  (r) => r.parcel?.properties?._saleGroupId,
  };
  const primaryPropGroups = matchingSaleGroupIds(
    rows, new Set(primaryPropFilter.getSelected()), primaryPropAccessors);

  // Max distance from subject. Only fires when (a) a subject is set
  // and (b) the input parses to a positive number. Sales without a
  // computed distance (no subject, or subject geometry unparseable)
  // are passed through unchanged when the filter is off, dropped
  // when it's on.
  const distMaxRaw = parseFloat($distanceMax?.value);
  const distActive = subjectCentroid && Number.isFinite(distMaxRaw) && distMaxRaw > 0;

  // Plan # substring filter — case-insensitive match against each
  // parcel's _plan (stamped from the legal-index). Trimmed-empty
  // input disables the filter; any non-empty input is searched as
  // a substring so "32457" matches "32457", "1032457", etc.
  const planFilter = ($salesPlan?.value || '').trim().toUpperCase();
  // N1 match filter — 'any' is off. Matched/unmatched is a plain
  // truthiness test on the stamped _n1Id; a pasted comp set (no N1 ID
  // column at all) reads as entirely unmatched, which is the truth.
  const n1Mode = $salesN1?.value || 'any';
  // Parcels-per-sale filter — 'any' is off. See the predicate below for why
  // the two live options are not symmetrical.
  const groupSizeMode = $salesGroupSize?.value || 'any';
  // Street Name substring filter — case-insensitive match against
  // Property_Address. Same semantics as Plan #: missing addresses
  // fail when the filter is active. Expanded through the civic-number
  // spacing variants so it agrees with the regular search's clause.
  const streetVariants = addressSearchVariants($salesStreetName?.value || '');
  // $/Acre filter — Min / Max bounds against _saleGroupPpa.
  // Either bound is optional; empty = unbounded on that side. Rows
  // missing _saleGroupPpa (no acres data on the group, or single-
  // parcel sale without acreage) fail when the filter is active —
  // same "missing = exclude" rule as the size filter.
  const ppaLoRaw = parseFloat($salesPpaLow?.value);
  const ppaHiRaw = parseFloat($salesPpaHigh?.value);
  const ppaActive = Number.isFinite(ppaLoRaw) || Number.isFinite(ppaHiRaw);
  const ppaLo = Number.isFinite(ppaLoRaw) ? ppaLoRaw : 0;
  const ppaHi = Number.isFinite(ppaHiRaw) ? ppaHiRaw : Infinity;

  // Total sale price filter — bounds against the sale's whole
  // consideration, not a per-parcel share. _saleGroupTotalPriceNum is
  // the parsed Consideration stamped on every member of the group by
  // computeSaleGroupTotals, so a multi-parcel sale passes or fails as
  // one transaction — the same reasoning as the size filter using
  // group acres rather than per-parcel acres.
  const priceLoRaw = parseFloat($salesPriceLow?.value);
  const priceHiRaw = parseFloat($salesPriceHigh?.value);
  const priceActive = Number.isFinite(priceLoRaw) || Number.isFinite(priceHiRaw);
  const priceLo = Number.isFinite(priceLoRaw) ? priceLoRaw : 0;
  const priceHi = Number.isFinite(priceHiRaw) ? priceHiRaw : Infinity;

  // Far-flung exclusion. Off unless the user ticked the box AND a
  // threshold is set. Because the span is a GROUP property stamped on
  // every member, dropping flagged rows removes the whole sale — never
  // part of one, which would silently corrupt its $/Acre.
  const farFlungThreshold = farFlungExcludeOn() ? farFlungThresholdKm() : null;

  // Nominal-sale exclusion — the ticked box beside Sales Coverage.
  const excludeNominal = !!$excludeNominal?.checked;

  return rows.filter((row) => {
    const p = row.parcel?.properties || {};

    // Nominal sales — $0 / $1 family and corrective transfers, no market
    // evidence in them. Group-level like the price-range filter, so a
    // multi-parcel conveyance drops whole. Deliberately fails OPEN on an
    // unparseable consideration: "SEE DOCUMENT" is unknown, not nominal,
    // and silently dropping unknowns from a comp set would be worse than
    // leaving one nominal sale in view.
    if (excludeNominal && isNominalSale(p)) return false;

    // Far-flung sales — a portfolio or estate transaction whose blended
    // rate isn't a local comparable. isFarFlungSale fails open on an
    // unmeasurable span, so a parcel whose geometry didn't load is
    // never dropped by this filter.
    if (farFlungThreshold != null && isFarFlungSale(p, farFlungThreshold)) return false;

    // Water influence — cheap stamped-property test, no fetch.
    if ((wantFront || wantNear) && p._waterLoaded) {
      const ok = (wantFront && isWaterfront(p._water))
              || (wantNear  && isNearWater(p._water));
      if (!ok) return false;
    }

    // Plan # filter — runs before the other CSV-mode checks because
    // it's the cheapest predicate. Substring-matches against both
    // sources of plan info: the legal-index's _plan field (the
    // structured plan identifier, when available) AND the CSV's raw
    // _csvLegal text (the "Legal Description" column the user
    // uploaded — typically formatted "lot--plan" or "lot-block-plan",
    // so a plain "66600" substring catches "4--66600", "6--66600",
    // etc). Only rows missing BOTH sources fail the filter.
    if (planFilter) {
      const plan = String(p._plan || '').toUpperCase();
      const csvLegal = String(p._csvLegal || '').toUpperCase();
      if (!plan.includes(planFilter) && !csvLegal.includes(planFilter)) return false;
    }

    // Street Name filter — same shape as the Plan # filter above.
    if (streetVariants.length > 0) {
      if (!addressMatchesVariants(p.Property_Address, streetVariants)) return false;
    }

    // N1 match filter — row-level, not group-level: a multi-parcel sale
    // can be matched on some rolls only (partial crosswalk coverage),
    // and the unmatched rows are exactly the queue being asked for.
    if (n1Mode !== 'any') {
      const hasN1 = !!p._n1Id;
      if (n1Mode === 'matched' ? !hasN1 : hasN1) return false;
    }

    // Parcels-per-sale filter. Group-level by construction: _saleGroupSize is
    // identical on every member of a sale, so a whole assembly is kept or
    // dropped together and its $/Acre keeps describing the land the price
    // actually bought — the same rule the size and far-flung filters follow.
    //
    // Deliberately NOT the usual "missing = exclude": 'multi' asserts
    // something positive and demands proof (>1), while 'single' is its exact
    // complement, so a row whose group size never got stamped counts as
    // single rather than falling out of both options. Calling an unstamped
    // row an assembly would be the wrong way to be wrong, and between them
    // the two options always account for every sale on the table.
    if (groupSizeMode !== 'any') {
      const isMulti = Number(p._saleGroupSize) > 1;
      if (groupSizeMode === 'multi' ? !isMulti : isMulti) return false;
    }

    // $/Acre filter — bounds against the sale-group rate. Rows
    // missing _saleGroupPpa (no acres data, or sale rate couldn't
    // be computed) drop out when the filter is active, mirroring
    // the size-range and date "missing = exclude" semantics.
    if (ppaActive) {
      const ppa = Number(p._saleGroupPpa);
      if (!Number.isFinite(ppa) || ppa < ppaLo || ppa > ppaHi) return false;
    }

    // Total sale price filter. A sale whose Consideration didn't parse
    // to a number (blank cell, "$1", "SEE DOCUMENT") drops out while
    // either bound is set — same "missing = exclude" rule the size,
    // date and $/Acre filters use, and the honest answer when the
    // user has asked for a price range.
    if (priceActive) {
      const price = Number(p._saleGroupTotalPriceNum);
      if (!Number.isFinite(price) || price < priceLo || price > priceHi) return false;
    }

    // DU filter — directly on the parcel field, no enrichment needed.
    if (duMode === 'zero') {
      const du = Number(p.Dwelling_Units);
      if (!(Number.isFinite(du) && du === 0)) return false;
    } else if (duMode === 'min' && Number.isFinite(duMin) && duMin > 0) {
      const du = Number(p.Dwelling_Units);
      if (!(Number.isFinite(du) && du >= duMin)) return false;
    }

    // Drawn-shape area filter. A row must have a placeable centroid
    // once any shape exists — leaking unplaceable rows into an
    // area-narrowed comp set would be silently wrong (see
    // passesShapeFilter for the include/exclude semantics).
    if (drawnShapes.length > 0) {
      const c = computeCentroid(row.parcel);
      if (!passesShapeFilter(c, drawnShapes)) return false;
    }

    // Vacant/improved selector (sales-CSV mode only — the control is
    // hidden outside sales-mode but the predicate works regardless).
    // Strict group semantics, and the two narrowed modes are NOT
    // complements: Vacant requires _saleGroupAllVacant (every parcel
    // has assessment data AND passes the vacancy predicate); Improved
    // requires _saleGroupAnyImproved (at least one parcel KNOWN to
    // fail it — one building in the sale is decisive). A sale with
    // missing assessment data satisfies neither and drops out of both,
    // rather than being guessed into one side.
    const vacantMode = $vacantImproved?.value || 'all';
    if (vacantMode === 'vacant') {
      if (p._saleGroupAllVacant !== true) return false;
      // Max Sale/Asmt ratio cap. Gated by Vacant Land Only because
      // the use-case is "buildings sold before the assessment
      // caught up", which is part of the vacant-proxy workflow.
      const saleAsmtMaxRaw = $saleAsmtMax?.value;
      const saleAsmtMax = saleAsmtMaxRaw == null || saleAsmtMaxRaw === ''
        ? null
        : parseFloat(saleAsmtMaxRaw);
      if (saleAsmtMax != null && Number.isFinite(saleAsmtMax) && saleAsmtMax > 0) {
        const ratio = Number(p._saleGroupSaleToAsmt);
        if (Number.isFinite(ratio) && ratio > saleAsmtMax) return false;
      }
    } else if (vacantMode === 'improved') {
      if (p._saleGroupAnyImproved !== true) return false;
    }

    // Size range filter (sales-CSV mode only — the row is hidden by
    // CSS otherwise, but harmless to keep the check unconditional).
    // Compares against the SALE-GROUP total acres (the sum of every
    // parcel in the same sale, stamped by computeSaleGroupTotals as
    // _saleGroupTotalAcres) rather than the per-parcel acres — a
    // 5,227,900 sale that bundles a 79.78 ac NE quarter and a 42 ac
    // SE quarter is meaningfully a 121.78 ac transaction, and the
    // user-typed range expresses interest in the deal size, not the
    // individual lot size. Both rows of the multi-parcel sale share
    // _saleGroupTotalAcres so they pass-or-fail together. Falls back
    // to per-parcel parcelAcres() only when the row isn't tagged
    // with a sale group at all (defensive — sales-CSV uploads always
    // stamp _saleGroupId on every matched feature).
    if (sizeActive && sizeUom === 'ff') {
      // Frontage is a PER-PARCEL figure the assessor states, with no
      // group equivalent — summing the frontages of a 3-parcel assembly
      // would describe a shape nobody bought. So this compares each
      // parcel's own roll frontage, and a parcel whose roll states an
      // area instead (about 63% of them) drops out entirely, which is
      // the point: an area row has no frontage to filter on.
      const ff = parseRollFrontageFeet(p.Frontage_or_Area);
      if (ff == null || ff < sizeLoAc || ff > sizeHiAc) return false;
    } else if (sizeActive) {
      const groupAc = Number(p._saleGroupTotalAcres);
      const parcelAc = Number.isFinite(groupAc) && groupAc > 0
        ? groupAc
        : parcelAcres(row.parcel);
      if (p._saleGroupAcresIncomplete) return false;
      if (!Number.isFinite(parcelAc) || parcelAc < sizeLoAc || parcelAc > sizeHiAc) return false;
    }

    // Sale-date range. Parses the CSV's date string fresh each time;
    // could be cached on the feature properties later but the parsing
    // is cheap enough that the post-filter pass on 200-row CSVs is
    // imperceptible.
    if (dateActive) {
      const d = parseSaleDate(p._saleDate);
      if (!d) return false;  // missing/malformed date excluded when filter is on
      const t = d.getTime();
      if (t < dateFromMs || t > dateToMs) return false;
    }

    // Class filter (multi-select). Drops rows whose dominant class
    // isn't in the selected Set; rows with no assessment data fail
    // when at least one class is selected.
    if (classFilterSet.size > 0) {
      if (!p._asmtClass || !classFilterSet.has(p._asmtClass)) return false;
    }

    // Zoning-code filter (multi-select). Matches on EITHER of the
    // parcel's zoning matches, so a sale whose second zone is the one
    // you're after still shows. A row with no zoning join at all fails
    // while the filter is active — same "missing = exclude" rule the
    // other filters use, and here it also means the enrichment simply
    // hasn't run, which is worth seeing rather than silently passing.
    //
    // Secondary zones only count at >= ZONE2_MIN_RATIO coverage — the
    // SAME gate the grid's Zoning 2 cell renders with. Without it the
    // filter matched sub-1% digitization slivers the grid deliberately
    // hides, so a row could pass a "C1/C2/C3 only" filter while
    // showing RMD and a blank Zoning 2 — a filter the screen cannot
    // explain (found via Steinbach roll 32560, 11B Ellice Ave).
    if (zoneCodeFilterSet.size > 0) {
      const codes = (row.zoning || [])
        .filter((z, i) => i === 0
          || (Number.isFinite(z.ratio) && z.ratio >= ZONE2_MIN_RATIO))
        .map((z) => formatZoneCode(z.feature?.properties))
        .filter(Boolean);
      if (!codes.some((c) => zoneCodeFilterSet.has(String(c).trim()))) return false;
    }

    // Distance-from-subject filter. Sales without a computed
    // _distanceKm are dropped when the filter is active — they'd be
    // ambiguous and the safe default is "exclude unknown."
    if (distActive) {
      const d = Number(p._distanceKm);
      if (!Number.isFinite(d) || d > distMaxRaw) return false;
    }

    // Zoning Type ticks (the sales-tab multi-select). Any of the row's
    // zones matching is enough — a parcel straddling two zones genuinely
    // is both. Rows with no zoning join read as "(no category)", so they
    // are findable rather than silently dropped.
    if (!rowMatchesZoneCategories(row.zoning, zoneCatFilterSet)) return false;

    // Primary Property ticks. The work was done in the pre-pass above;
    // this is a Set membership test on the row's sale group. Sales with no
    // descriptor are not dropped — they are bare land, 56.4% of the
    // archive, and reachable via their family's "(no primary structure)".
    if (!rowPassesPrimaryProperty(row, primaryPropGroups, primaryPropAccessors)) return false;

    // Zone category — needs zoning enrichment. If the row has no
    // zoning matches at all (enrichment skipped via the >250 button
    // that the user never clicked), filter behaves as "exclude" so
    // the user gets a hint that they need to enrich first.
    if (zoneCat) {
      const cats = (row.zoning || [])
        .map((z) => z.feature?.properties?.ZONE_CATEGORY)
        .filter(Boolean);
      if (!cats.includes(zoneCat)) return false;
    }

    // Status filter — same realStr / different-bylaw logic the SQL
    // path uses in arcgis.js's resolveOverlayFilter. Reads off the
    // top zoning / dev-plan polygon of each row.
    if (status === 'zoning' || status === 'both') {
      if (!isZoningChanged(row.zoning?.[0]?.feature?.properties || {})) return false;
    }
    if (status === 'devplan' || status === 'both') {
      if (!isDevPlanChanged(row.devPlan?.[0]?.feature?.properties || {})) return false;
    }

    return true;
  });
}

function isZoningChanged(z) {
  const realStr = (v) => v != null && String(v).trim() !== '' && String(v).trim() !== '<Null>';
  return (realStr(z.ZBL_A) && z.ZBL_A !== z.ZBL) || realStr(z.AMENDMENT_DESCRIPTION);
}
function isDevPlanChanged(d) {
  const realStr = (v) => v != null && String(v).trim() !== '' && String(v).trim() !== '<Null>';
  return realStr(d.DPA_BYLAW) && d.DPA_BYLAW !== d.DP_BYLAW;
}

/** Filter an overlay FeatureCollection to only the features whose
 *  properties satisfy the supplied `changed` predicate. Returns a
 *  GeoJSON-shaped object suitable for handing to joinTopNByArea. */
function filterFcForChanged(fc, isChanged) {
  if (!fc?.features?.length) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: fc.features.filter((f) => isChanged(f.properties || {})),
  };
}

/** Convert a CSV-style muni string ('CITY OF WINKLER', 'RM OF
 *  HANOVER', 'RURAL MUNICIPALITY OF EMERSON-FRANKLIN') into the
 *  Roll_Entry Muni_Name_With_Typ format ('WINKLER (CITY)', 'HANOVER
 *  (RM)', 'EMERSON-FRANKLIN (MUNICIPALITY)'). Returns the empty
 *  string for inputs that don't match any known prefix. */
function normalizeMuniFromCsv(raw) {
  if (!raw) return '';
  // Uppercase, collapse whitespace, AND strip periods. Roll_Entry's
  // Muni_Name_With_Typ never carries a period — it stores "EAST ST
  // PAUL (RM)" / "STE ANNE (RM)" / "ST FRANCOIS XAVIER (RM)" — but
  // appraiser-supplied CSVs commonly use the formal/typographic form
  // ("RM OF EAST ST. PAUL", "RM OF STE. ANNE"). Without the strip,
  // the resulting normalized value contains a period and the
  // searchParcels exact-match `Muni_Name_With_Typ = '…'` clause
  // silently fails for every row in that muni. Found via a 1044-row
  // industrial-comps CSV that came back with 480 unmatched — 467 of
  // them were just the period mismatch on East/West St. Paul +
  // Ste. Anne.
  const s = String(raw).trim().toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ');
  const patterns = [
    [/^CITY\s+OF\s+(.+)$/,                                           'CITY'],
    [/^TOWN\s+OF\s+(.+)$/,                                           'TOWN'],
    [/^VILLAGE\s+OF\s+(.+)$/,                                        'VILLAGE'],
    [/^RM\s+OF\s+(.+)$/,                                             'RM'],
    [/^RURAL\s+MUNICIPALITY\s+OF\s+(.+)$/,                           'RM'],
    [/^MUNICIPALITY\s+OF\s+(.+)$/,                                   'MUNICIPALITY'],
    [/^LGD\s+OF\s+(.+)$/,                                            'LGD'],
    [/^LOCAL\s+GOVERNMENT\s+DISTRICT\s+OF\s+(.+)$/,                  'LGD'],
    [/^NORTHERN\s+COMMUNITY\s+OF\s+(.+)$/,                           'NORTHERN COMMUNITY'],
  ];
  for (const [re, type] of patterns) {
    const m = s.match(re);
    if (m) return `${m[1].trim()} (${type})`;
  }
  // Already in 'NAME (TYPE)' form? Pass through.
  if (/\([A-Z][A-Z ]*\)\s*$/.test(s)) return s;
  return '';
}

/**
 * Show the search-count line with an inline "Load zoning + dev-plan"
 * button. Used when a search returns more parcels than the auto-
 * enrichment threshold — the table already shows parcel rows, the
 * button triggers the same overlay-fetch + area-weighted join when
 * the user actually wants those columns populated.
 */
function renderEnrichButton(parcelFc, inputs, baseMsg) {
  const n = parcelFc.features.length;
  $count.innerHTML = '';
  $count.appendChild(document.createTextNode(`${baseMsg} · `));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'inline-action';
  btn.textContent = `Load zoning + dev-plan (${n} parcels)`;
  btn.title = 'Skipped automatically because the result set is larger than '
            + `${ENRICHMENT_THRESHOLD} parcels. Click to fetch overlay polygons `
            + 'and compute the area-weighted top-2 zoning + dev-plan per parcel.';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Loading zoning + dev-plan…';
    try {
      await enrichOverlays(parcelFc, inputs, baseMsg);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = `Retry zoning + dev-plan (${err.message})`;
    }
  });
  $count.appendChild(btn);
}

/**
 * Run the zoning + dev-plan + risk-area + parcel-MASC enrichment
 * pipeline against an already-fetched parcelFc. Both runSearch and
 * the on-demand button feed into this. Mirrors the original inline
 * sequence: fetch overlays in parallel, area-weighted top-2 join,
 * stamp risk areas + soil rating, refresh the assessment-year header,
 * then re-render table + map.
 */
/**
 * Stamp `_water` / `_waterLoaded` on every row from the per-muni water shards.
 *
 * DELIBERATELY NOT INSIDE enrichOverlays. That function is skipped above
 * ENRICHMENT_THRESHOLD (1,000 parcels) in favour of a "Load zoning + dev-plan"
 * button, because the zoning/dev-plan work is an expensive polygon fetch plus
 * an area-weighted join. Water influence is nothing of the sort — one
 * pre-baked ~33 KB JSON per municipality and an O(1) dictionary hit per
 * parcel. Leaving it behind that gate meant a muni-wide search (which caps at
 * exactly 1,000 and so always trips the threshold) showed an empty Water
 * column, which is precisely the case where filtering to waterfront matters
 * most. Observed on Niverville: 1,000 rows, every Water cell blank.
 *
 * Munis come from the RESULT SET, not the dropdown, so this covers a
 * single-muni search, a selected muni, and an imported list spanning several
 * munis (sales analysis included).
 *
 * `_waterLoaded` marks every parcel whose muni shard RESOLVED, even when that
 * parcel has no water. It separates "checked, nothing within 164 ft" from "never
 * looked" — the shards only carry non-"None" parcels, so a missing stamp alone
 * cannot distinguish the two, and the waterfront filter gates on it so an
 * unreachable CDN can't silently empty the grid.
 *
 * Non-fatal throughout: water is supplementary and must never break a search.
 */
/**
 * Resolve a ticked water-influence box to the roll numbers that satisfy it, so
 * the constraint can be pushed into the Roll_Entry query instead of trimming
 * the capped result set afterwards.
 *
 * Returns `{ applied: false }` — leaving the search untouched — in every case
 * where a roll list would be wrong or unobtainable:
 *
 *   - no water box ticked
 *   - a list import is active: `parcelKeys` already pins the exact parcels and
 *     takes precedence over `roll`, so the post-filter handles those rows
 *   - NO municipality selected: a province-wide sweep would mean fetching all
 *     180 shards and emitting ~54,000 rolls, which is far worse than letting
 *     the cap bite. The user is told to pick a municipality.
 *   - the shard is unreachable: filtering on data we failed to load would read
 *     as "nothing qualifies". `_waterLoaded` gating in rowPassesWaterFilter
 *     then keeps the grid honest.
 *
 * A roll the user typed themselves is INTERSECTED with, never replaced — a
 * search for one roll plus "Waterfront only" must answer "is this parcel
 * waterfront", not silently widen to every waterfront parcel in the muni.
 */
// Whether the Water Influence map overlay is currently on.
let waterOverlayOn = false;

/**
 * Toggle the Water Influence map overlay — result parcels painted by
 * waterfront class (dark blue = frontage, pale blue = near water without frontage).
 *
 * No fetch and no municipality dependency, unlike MASC / CLI / Land Cover:
 * `_waterColor` is already stamped on every row by stampWaterInfluence during
 * the search, so this is a pure visibility flip. That also means it works
 * identically on an imported sales list.
 *
 * The status line reports how many parcels actually took colour, so an empty
 * map reads as "none of these are near water" rather than as a broken layer.
 */
function toggleWaterInfluenceOverlay() {
  waterOverlayOn = !waterOverlayOn;
  setWaterInfluenceVisible(map, waterOverlayOn);
  setOverlayPressed($waterToggle, waterOverlayOn);
  if (!waterOverlayOn) return;

  setColumnVisible('water', true);
  const rows = currentRows || [];
  const painted = rows.filter((r) => r.parcel?.properties?._waterColor).length;
  const loaded  = rows.filter((r) => r.parcel?.properties?._waterLoaded).length;
  if (!rows.length) {
    setCount('Water Influence on — run a search or import a list to colour parcels.');
  } else if (!loaded) {
    setCount('Water Influence on — water data has not loaded for these municipalities yet.');
  } else {
    setCount(painted > 0
      ? `Water Influence on — ${painted} of ${rows.length} parcel${rows.length === 1 ? '' : 's'} coloured (dark blue = frontage, pale blue = near water without frontage).`
      : `Water Influence on — none of these ${rows.length} parcels are within 164 ft of mapped water.`);
  }
}

async function resolveWaterRollPrefilter(inputs) {
  const wantFront = !!$waterfrontOnly?.checked;
  const wantNear  = !!$nearWaterOnly?.checked;
  if (!wantFront && !wantNear) return { applied: false };
  if (Array.isArray(listParcelKeys) && listParcelKeys.length) return { applied: false };

  const muni = inputs?.municipality?.trim();
  if (!muni) {
    setCount('Select a municipality to use the waterfront filter — a province-wide waterfront search is too large to resolve.');
    return { applied: false };
  }

  const dict = await fetchWaterForMuni(muni).catch(() => null);
  if (!dict) return { applied: false };

  let rolls = [];
  for (const [roll, w] of Object.entries(dict)) {
    if ((wantFront && isWaterfront(w)) || (wantNear && isNearWater(w))) rolls.push(roll);
  }

  // Intersect with a typed roll rather than overriding it.
  const typed = (inputs?.roll || '').trim();
  const muniTotal = rolls.length;
  if (typed) {
    const wanted = new Set(
      typed.split(/[\s,;|+&]+/).map((s) => s.trim()).filter(Boolean)
        .map((s) => (Number.isFinite(Number(s)) ? Number(s).toFixed(3) : s)),
    );
    rolls = rolls.filter((r) => wanted.has(r) || wanted.has(String(Number(r))));
  }
  return { applied: true, rolls, narrowedByRoll: !!typed, muniTotal };
}

async function stampWaterInfluence(rows) {
  try {
    const muniNames = [...new Set(
      (rows || []).map((r) => r?.parcel?.properties?.Muni_Name_With_Typ).filter(Boolean),
    )];
    if (!muniNames.length) return;
    const dicts = await Promise.all(
      muniNames.map((m) => fetchWaterForMuni(m).catch(() => null)),
    );
    const byMuni = new Map();
    muniNames.forEach((m, i) => { if (dicts[i]) byMuni.set(m, dicts[i]); });
    for (const row of rows) {
      const p = row?.parcel?.properties;
      const dict = p?.Muni_Name_With_Typ ? byMuni.get(p.Muni_Name_With_Typ) : null;
      if (!dict) continue;
      p._waterLoaded = true;
      const hit = p?.Roll_No_Txt ? dict[p.Roll_No_Txt] : null;
      if (hit) {
        p._water = hit;
        const color = waterColor(hit);
        if (color) p._waterColor = color;
      }
    }
  } catch (err) {
    console.warn('water-influence enrichment failed (non-fatal):', err);
  }
}

// The Water Influence overlay is OFF until the user turns it on, like every
// other map layer. An earlier version auto-armed it whenever a waterfront /
// near-water filter was ticked, because the toggle was then buried in the
// collapsed Agricultural group and filtering appeared to do nothing to the
// map. That was solved better by moving the button into Parcel layers with the
// two filters directly beneath it — the control is now visible at the moment
// you would want it, so arming it on the user's behalf just takes away a
// choice.
//
// If the "filtered but the map is still yellow" complaint ever returns, the
// fix is discoverability, not re-arming: setMapData already re-asserts
// visibility from `waterOverlayOn`, so a one-line flag flip would bring the
// old behaviour back, and it would take the same choice away again.

async function enrichOverlays(parcelFc, inputs, baseMsg, { skipDevPlan = false } = {}) {
  setCount(`${baseMsg} · Loading zoning overlay…`);

  let zoningFc = EMPTY_FC;
  let devPlanFc = EMPTY_FC;
  let riskAreaFc = EMPTY_FC;
  const riskAreaPromise = fetchMascRiskAreas().catch((err) => {
    console.warn('official MASC risk-area fetch failed (non-fatal):', err);
    return EMPTY_FC;
  });
  // Multi-muni CSV uploads pass a `municipalities` array so the
  // overlay fetches take the per-muni bulk path (one fetch per muni
  // in parallel) instead of the per-parcel envelope path. For a
  // 2100-sale upload across 20 munis that's ~20 fetches in ~3-5s
  // versus ~2100 fetches at 16-way concurrency in 30+ seconds. The
  // matched-muni list is set in csvMatchedMunis at upload time;
  // basic searches fall through to the single-muni or per-parcel
  // path as before.
  const overlayOpts = inputs.municipality
    ? { municipality: inputs.municipality }
    : (Array.isArray(inputs.municipalities) && inputs.municipalities.length > 0
        ? { municipalities: inputs.municipalities }
        : {});
  try {
    // Development-plan designations are deferred on sales imports — see
    // handleSalesUpload. Fetching and joining them was ~70 s of a ~100 s
    // import, on a layer that isn't part of the sales workflow. The Dev
    // Plan Layer toggle loads it on demand and backfills the columns.
    [zoningFc, devPlanFc, riskAreaFc] = await Promise.all([
      fetchZoningOverlap(parcelFc, overlayOpts),
      skipDevPlan ? Promise.resolve(EMPTY_FC) : fetchDevPlanOverlap(parcelFc, overlayOpts),
      riskAreaPromise,
    ]);
  } catch (err) {
    console.warn('overlay fetch failed', err);
    setCount(`${baseMsg} · zoning/dev-plan enrichment failed: ${err.message}`);
    throw err;
  }
  lastZoningFc = zoningFc;
  lastDevPlanFc = devPlanFc;
  // When the search is muni-scoped, fetchZoningOverlap /
  // fetchDevPlanOverlap take the bulk-by-muni path (see arcgis.js),
  // so the overlay FCs already cover the entire muni. Stamp the
  // loaded-for state so the Zoning Layer / Dev Plan Layer toggles
  // can short-circuit when the user clicks them next.
  const overlayLoadKey = inputs.municipality
    || (Array.isArray(inputs.municipalities)
      ? inputs.municipalities.slice().filter(Boolean).sort().join('|')
      : '');
  zoningLayerLoadedFor = overlayLoadKey || null;
  // Leaving this null when skipped is what makes the Dev Plan Layer
  // toggle actually fetch rather than assume it already has the data.
  devPlanLayerLoadedFor = skipDevPlan ? null : (overlayLoadKey || null);
  rebuildZoningLegend(zoningFc);
  updatePdWebsiteButton(devPlanFc);

  // Off the main thread. These four joins are the heaviest synchronous
  // work in the app — on a multi-muni sales import they used to freeze
  // the tab outright, so the results table wouldn't scroll and the map
  // wouldn't pan while zoning loaded. The worker doesn't make them
  // cheaper (tiling did that); it stops them blocking the UI. Each pair
  // runs concurrently since they're independent.
  if (!skipDevPlan) devPlanDeferred = false;
  const [zoningTop2, devPlanTop2] = await Promise.all([
    joinTopNByAreaAsync(parcelFc, zoningFc, 2),
    joinTopNByAreaAsync(parcelFc, devPlanFc, 2),
  ]);
  // Per-parcel "changed-polygons" join, computed against a filtered
  // overlay FC containing only polygons that actually carry an
  // amendment (ZBL_A != ZBL, AMENDMENT_DESCRIPTION set, etc.). The
  // server-side Zoning-Changed / Dev-Plan-Changed filters use a
  // spatial intersect — so a parcel can land in the result set on a
  // tiny sliver overlap with a changed polygon whose code never
  // makes the top-2 area-weighted display join. Without this second
  // pass, the Changes column reads as empty for those parcels even
  // though they ARE the changed ones the filter surfaced.
  const zoningChangedFc = filterFcForChanged(zoningFc, isZoningChanged);
  const devPlanChangedFc = filterFcForChanged(devPlanFc, isDevPlanChanged);
  const [zoningChanges, devPlanChanges] = await Promise.all([
    joinTopNByAreaAsync(parcelFc, zoningChangedFc, 3),
    joinTopNByAreaAsync(parcelFc, devPlanChangedFc, 3),
  ]);
  // Bbox-overlap fallback: ArcGIS's server-side intersect counts
  // edge-touching polygons as a match, so a parcel can land in the
  // Zoning-Changed result on a sliver overlap that @turf/intersect
  // silently rejects (returns null because there's no area overlap).
  // bboxOverlapJoin mirrors the server's looser semantics. We prefer
  // joinTopNByArea results and only consult bbox-overlap when those
  // are empty — keeps the Changes text accurate when turf succeeds,
  // and surfaces the candidate amendment when turf fails.
  const zoningChangesBbox  = bboxOverlapJoin(parcelFc, zoningChangedFc, 3);
  const devPlanChangesBbox = bboxOverlapJoin(parcelFc, devPlanChangedFc, 3);

  const rows = parcelFc.features.map((p) => {
    const oid = p.properties.OBJECTID;
    const zc = zoningChanges.get(oid);
    const dc = devPlanChanges.get(oid);
    return {
      parcel: p,
      zoning:  zoningTop2.get(oid) || [],
      devPlan: devPlanTop2.get(oid) || [],
      zoningChanges:  (zc && zc.length) ? zc : (zoningChangesBbox.get(oid) || []),
      devPlanChanges: (dc && dc.length) ? dc : (devPlanChangesBbox.get(oid) || []),
    };
  });

  // Stamp primary-zoning code AND any amendment-change text onto
  // each parcel feature so the map's hover/click popups (which only
  // see the parcel-fill feature, not the row object) can render
  // them without re-running the spatial join client-side. The
  // changes text mirrors what the Changes column in the table shows,
  // formatted by formatChanges(row); null when neither zoning nor
  // dev-plan has a pending amendment, so popup builders can simply
  // skip the line.
  for (const row of rows) {
    const z = row.zoning[0]?.feature.properties;
    if (z) row.parcel.properties._zoneCode = z.ZONE || z.ZONE_NAME || null;
    row.parcel.properties._changesText = formatChanges(row);
  }

  stampOfficialRiskAreas(rows, riskAreaFc);

  // Licensed tile drainage + irrigation (WALLAS). Both self-gate on
  // their overlay being on (tile also on its search filter), so they
  // cost nothing on a search that doesn't care about water rights.
  // Both self-gate on their overlay being on (or their search filter), so
  // they cost nothing on a search that doesn't care about water rights.
  // Run concurrently: they're independent, and the clip is the slowest
  // thing left in enrichment on an irrigation-heavy municipality.
  // Cleared every pass, not just when the filters run — otherwise a
  // count from an earlier filtered search would be appended to a later
  // unfiltered one.
  lastWaterFilterDropped = 0;
  if (wantsWaterRightsEnrichment()) {
    setCount(`${baseMsg} · Checking water-rights licences…`);
    await Promise.all([stampTileDrainage(rows), stampIrrigation(rows)]);
    // Record it rather than only folding it into baseMsg: the sales-CSV
    // path overwrites the count line after enrichment returns, which
    // otherwise left "5 of 5 sales plotted" above a grid showing 3.
    lastWaterFilterDropped = dropSliverOnlyMatches(rows, parcelFc);
    if (lastWaterFilterDropped > 0) baseMsg = `${baseMsg} · ${waterFilterDropNote()}`;
  }

  // Attach the pre-baked dominant MASC soil rating for each parcel
  // (per-muni shard built by r/build_parcel_masc.R). Derive munis from
  // the result rows so multi-municipality sales imports receive the same
  // data as single-muni Property Searches. Urban-only munis may have no
  // shard; those rows remain blank without blocking the import.
  try {
    const mascMunis = [...new Set(
      rows.map((row) => row.parcel.properties?.Muni_Name_With_Typ).filter(Boolean),
    )];
    const dicts = await Promise.all(
      mascMunis.map((muni) => fetchParcelMascForMuni(muni).catch(() => null)),
    );
    const byMuni = new Map();
    mascMunis.forEach((muni, i) => { if (dicts[i]) byMuni.set(muni, dicts[i]); });
    for (const row of rows) {
      const p = row.parcel.properties;
      const dict = p?.Muni_Name_With_Typ ? byMuni.get(p.Muni_Name_With_Typ) : null;
      const hit = (dict && p?.Roll_No_Txt) ? dict[p.Roll_No_Txt] : null;
      if (hit) {
        p._soilRating = mascRatingLabel(hit) || null;
        p._soilRatingCode = mascDisplayRating(hit) || null;
        p._soilQuarter = soilSourceLabel(hit);
      }
    }
  } catch (err) {
    console.warn('parcel-MASC enrichment failed (non-fatal):', err);
  }

  // Attach the pre-baked land-cover summary (farmland buckets) for each
  // parcel — per-muni shard built by r/build_landcover.R from the
  // mao-assembly Parquet. Only parcels over LAND_COVER_MIN_ACRES are in the shards, so
  // urban/residential rolls simply find no hit and stay undefined; the
  // popup + grid suppress the field on small parcels anyway.
  //
  // Munis are derived from the RESULT SET itself (each parcel carries
  // Muni_Name_With_Typ), NOT the single muni dropdown — so land cover
  // auto-loads for single-muni searches, a selected muni, AND imported
  // lists spanning several munis. Per-muni shards fetch in parallel and
  // cache. Each match is stamped with its _landCover fractions plus a
  // _lcColor for the Land Cover map overlay. Non-fatal throughout.
  try {
    const muniNames = [...new Set(
      rows.map((r) => r.parcel.properties?.Muni_Name_With_Typ).filter(Boolean),
    )];
    if (muniNames.length) {
      const dicts = await Promise.all(
        muniNames.map((m) => fetchLandCoverForMuni(m).catch(() => null)),
      );
      const byMuni = new Map();
      muniNames.forEach((m, i) => { if (dicts[i]) byMuni.set(m, dicts[i]); });
      for (const row of rows) {
        const p = row.parcel.properties;
        const dict = p?.Muni_Name_With_Typ ? byMuni.get(p.Muni_Name_With_Typ) : null;
        const hit = (dict && p?.Roll_No_Txt) ? dict[p.Roll_No_Txt] : null;
        if (hit) {
          p._landCover = hit;
          const color = dominantBucket(hit)?.color;
          if (color) p._lcColor = color;
        }
      }
    }
  } catch (err) {
    console.warn('land-cover enrichment failed (non-fatal):', err);
  }

  await stampWaterInfluence(rows);

  // Stamp the most-common assessment year into the Total Value column
  // header so users can tell which assessment cycle the dollar figure
  // is anchored to.
  updateAssessmentYearHeader(rows);

  renderTable(rows);
  setMapData(parcelFc, zoningFc, devPlanFc);
  setCount(baseMsg);
  return rows;
}

function attachLegalMetadata(parcelFc, legalMatches) {
  const byKey = new Map();
  for (const rec of legalMatches || []) {
    const key = legalRecordKey(rec);
    if (key && !byKey.has(key)) byKey.set(key, rec);
  }
  for (const feature of parcelFc.features || []) {
    const p = feature.properties || {};
    const rec = byKey.get(parcelLegalKey(p));
    if (!rec) continue;
    p._extrctPropId = rec.extrct_prop_id || null;
    p._legalDescription = rec.legal_description || null;
    p._legalDetail = rec.legal_detail || null;
    p._lot = rec.lot || null;
    p._block = rec.block || null;
    p._plan = rec.plan || null;
    p._certificatesOfTitle = rec.certificates_of_title || null;
    p._legalSourceUrl = rec.source_url || null;
  }
}

/**
 * Convenience wrapper: build a parcelLegalKey list from any FC, look
 * up the matching legal-index records, and stamp them onto each
 * feature's properties via attachLegalMetadata. Used by the muni-
 * parcels load (so the Roll Layer hover/click popup can show the
 * legal description) and any future bulk-parcel enrichment caller.
 */
async function enrichFcWithLegals(fc) {
  const keys = [];
  for (const f of fc?.features || []) {
    const k = parcelLegalKey(f?.properties || {});
    if (k) keys.push(k);
  }
  if (keys.length === 0) return;
  const recs = await lookupLegalRecordsByParcelKeys(keys);
  if (recs.length > 0) attachLegalMetadata(fc, recs);
}

// ---------- Map / overlay helpers ----------

function setMapData(parcelFc, zoningFc, devPlanFc, opts = {}) {
  // Render map FIRST, then stamp composition. The composition pass
  // does a joinTopNByArea against every loaded soil polygon (up to
  // ~3000 on a busy muni like St Clements) — running it synchronously
  // here used to block the map paint for several seconds and made the
  // overlay toggle feel like it was hanging. The parcel popup reads
  // `_soilComposition` lazily on click; deferring the stamp means the
  // map appears immediately and the composition section fills in
  // shortly after.
  // Geometry is drawn once per parcel even when the result set carries
  // one feature per sale — see dedupeParcelFeaturesForMap().
  const mapFc = dedupeParcelFeaturesForMap(parcelFc);
  // Under an active as-of date the highlight must trace the parcel as it stood
  // THEN, not now — see asOfHighlight(). Applied here so both pushes a search
  // makes (the immediate one and the post-enrichment repush) get it.
  const asOf = asOfHighlight(mapFc);
  const asOfFc = asOf ? asOf.fc : mapFc;
  // Then withhold the boundary of any parcel this sale's own evidence says
  // changed after it sold — today's polygon there is a different piece of
  // land, so it becomes a pin instead. Runs AFTER the as-of swap on purpose:
  // a real historical boundary beats a pin, so a feature that pass redrew is
  // left alone (see shouldWithhold()).
  const withheld = withholdChangedGeometry(asOfFc, { centroid: parcelCentrePoint });
  const highlightFc = withheld.withheld ? withheld.fc : asOfFc;
  // Stashed for the search's status line, which is composed before this push
  // reports back. Null whenever no as-of date is in force.
  lastAsOfHighlight = asOf;
  lastWithheldGeometry = withheld;
  mapReady.then(() => {
    showResults(map, highlightFc, opts);
    setZoningData(map, zoningFc);
    setDevPlanData(map, devPlanFc);
    // Parcel-number callouts. The `_seq` values are assigned once per
    // new result set (runSearch / sales upload); here we just push the
    // current features' anchors and toggle visibility to match. Passing
    // a filtered subset shows only those parcels' (fixed) numbers, with
    // gaps — the number stays glued to the parcel, never renumbers.
    const numberable = (highlightFc.features?.length || 0) > 1;
    // Anchored off the HIGHLIGHT features so a callout's leader stays glued to
    // the outline actually drawn — an as-of boundary can sit well away from
    // today's centroid (Brandon 562264's moved ~120 m when it lost 8.4 acres).
    setParcelNumberData(map, highlightFc.features || []);
    setParcelNumbersVisible(map, numberingOn && numberable);
    // Re-assert the water overlay. Its layers are declared with
    // `visibility: 'none'` at style-build time, so any path that rebuilds the
    // style (a basemap switch, a re-run of the setup) silently resets them
    // while the button and `waterOverlayOn` still say the overlay is on —
    // observed as a status line reading "Water Influence on — 151 of 151
    // parcels coloured" over a map showing none of them. Re-applying on every
    // data push keeps the layer state and the UI state agreeing.
    setWaterInfluenceVisible(map, waterOverlayOn);
  });
  // Stamps run on the FULL set (every sale row), not the deduped map
  // set, so a repeat sale's extra rows carry soil data into the table
  // and the CSV export too.
  scheduleSoilCompositionStamp(parcelFc);
  // Stash the current result set so the Parcel Snapshots export can render
  // each parcel without re-querying. Covers both entry points the user
  // asked for: imported-list searches and sales-CSV uploads both funnel
  // their parcelFc through here.
  // Deduped: Parcel Snapshots renders one image per parcel, so a
  // repeat-sold parcel must not produce two identical captures.
  // Deliberately the UNSWAPPED set: the satellite snapshots and the evidence
  // exports are of today's parcel, and it is also what a Historical toggle
  // re-derives its as-of highlight from (see refreshAsOfHighlight).
  lastResultFc = mapFc;
  // Keep the SELECTED-ONLY zoning colouring tied to the parcels actually
  // on the map. Must come after lastResultFc is updated — it reads the new
  // set's zone codes — and is a no-op in every other overlay state.
  refreshZoningSelectionColoring();
  updateSnapshotButton();
}

// Track in-flight CLI/soil work so the toggle button + legend can
// reflect "still loading" even AFTER the synchronous toggle function
// returns. Without this the deferred composition stamp ran with no UI
// signal, so the button flipped back to its idle label while the
// spatial join was still chewing through the parcel set — making the
// page feel unresponsive for no obvious reason.
let cliPendingOps = 0;
function beginCliOp(label = 'Loading…') {
  cliPendingOps += 1;
  refreshCliLoadingIndicator(label);
}
function endCliOp() {
  cliPendingOps = Math.max(0, cliPendingOps - 1);
  refreshCliLoadingIndicator();
}
function refreshCliLoadingIndicator(busyLabel = 'Loading…') {
  const busy = cliPendingOps > 0;
  if ($cliToggle) {
    $cliToggle.classList.toggle('overlay-busy', busy);
    $cliToggle.disabled = busy;
    if (busy) {
      setOverlayBtnLabel($cliToggle, busyLabel);
    } else {
      setOverlayBtnLabel($cliToggle, cliButtonLabelFor(cliMode));
    }
  }
  if ($cliLegend) {
    $cliLegend.classList.toggle('legend-busy', busy);
  }
}

/**
 * Defer stampSoilCompositionOnParcels off the synchronous map-data
 * pipeline so the map paints before the join runs. After the stamp
 * lands, re-push the supplied parcel source so the click handler
 * reads the enriched `_soilComposition`. Uses requestIdleCallback
 * when available (browsers' idle slot — runs only when the main
 * thread is free); falls back to setTimeout(0) otherwise.
 *
 * Driven off the loaded soil FC, not the overlay's paint mode: the
 * polygons arrive either from the CLI overlay or from the Agricultural
 * column preset, and once we hold them for the current scope every
 * subsequent search should stamp too — otherwise the CLI / Soil Type
 * columns would go blank again on the next search for the same muni.
 * `lastCliFc` is cleared on a muni change, so this can't stamp a parcel
 * against some other municipality's soils.
 *
 * `repush` defaults to re-pushing through showResults (the search-
 * results parcel source); callers driving a different source (e.g.
 * the Roll Layer's muni-parcels source) pass their own re-push fn.
 */
function scheduleSoilCompositionStamp(parcelFc, { repush } = {}) {
  if (!lastCliFc?.features?.length) return;
  // Re-push through the as-of swap too, or a composition stamp landing while
  // the Historical overlay is on would quietly put today's boundary back.
  const defaultRepush = () => mapReady.then(() => {
    const asOf = asOfHighlight(parcelFc);
    showResults(map, asOf ? asOf.fc : parcelFc, { fit: false });
  });
  const doRepush = repush || defaultRepush;
  beginCliOp('Composing…');
  const run = async () => {
    try {
      await stampSoilCompositionOnParcels(parcelFc, lastCliFc);
      doRepush();
      // Re-render the results table so the CLI / Soil Type columns
      // pick up the freshly-stamped _soilComposition[0]. The cells
      // read dominantCliLabel / dominantSoilTypeLabel from each
      // parcel's properties at render time, and without this
      // refresh they'd show their initial empty state until the
      // next search.
      refreshResultsTableAfterCompositionStamp();
    } finally {
      endCliOp();
    }
  };
  if (typeof window !== 'undefined' && window.requestIdleCallback) {
    window.requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 0);
  }
}

/**
 * Re-renders the results table without resetting pagination so the
 * CLI / Soil Type columns reflect newly-stamped _soilComposition.
 * Safe to call at any point — no-op when currentRows is empty.
 * Defined here near scheduleSoilCompositionStamp so the call site is
 * obvious; both stamping paths (CLI overlay load and CLI mode swap)
 * funnel through this helper.
 */
/**
 * Fill in the dev-plan data a sales import deliberately skipped.
 *
 * handleSalesUpload defers the development-plan join because it cost
 * ~70 s of a ~100 s import — the layer's polygons are an order of
 * magnitude more complex than zoning's — and it isn't part of the sales
 * workflow. Turning on the Dev Plan Layer is the user asking for it, so
 * this runs the same joins enrichOverlays would have, stamps the rows,
 * and re-renders so the Dev Plan column, the Changes text, the popup
 * line and the CSV export all populate.
 *
 * Operates on csvFullRows (the unfiltered set) so rows currently hidden
 * by a filter are backfilled too — otherwise clearing a filter would
 * reveal rows that are still blank.
 */
async function backfillDevPlanColumns(devPlanFc) {
  const rows = csvFullRows || currentRows;
  if (!rows?.length || !devPlanFc?.features?.length) { devPlanDeferred = false; return; }
  const parcelFc = { type: 'FeatureCollection', features: rows.map((r) => r.parcel) };
  setCount(`${csvFullBaseMsg || ''} · Loading development plan…`.trim());
  try {
    const changedFc = filterFcForChanged(devPlanFc, isDevPlanChanged);
    const [top2, changes] = await Promise.all([
      joinTopNByAreaAsync(parcelFc, devPlanFc, 2),
      joinTopNByAreaAsync(parcelFc, changedFc, 3),
    ]);
    const changesBbox = bboxOverlapJoin(parcelFc, changedFc, 3);
    for (const row of rows) {
      const oid = row.parcel?.properties?.OBJECTID;
      if (oid == null) continue;
      const dc = changes.get(oid);
      row.devPlan = top2.get(oid) || [];
      row.devPlanChanges = (dc && dc.length) ? dc : (changesBbox.get(oid) || []);
      // Changes text mixes zoning and dev-plan amendments, so it has to
      // be recomputed now that the dev-plan half exists.
      row.parcel.properties._changesText = formatChanges(row);
    }
    updatePdWebsiteButton(devPlanFc);
    devPlanDeferred = false;
    renderTable(currentRows, { resetPage: false });
    setCount(csvFullBaseMsg || '');
  } catch (err) {
    console.warn('dev-plan backfill failed', err);
    setCount(`${csvFullBaseMsg || ''} · Development plan failed to load: ${err.message}`.trim());
  }
}

function refreshResultsTableAfterCompositionStamp() {
  if (!currentRows || currentRows.length === 0) return;
  try { renderTable(currentRows, { resetPage: false }); }
  catch (err) { console.warn('table refresh after composition stamp failed', err); }
}

function setMuniParcelsMapData(fc) {
  // Push to the map source FIRST so the Roll Layer renders without
  // waiting on the composition join. The join can take 30+ seconds
  // against a busy muni's full parcel fabric (St Clements has ~8000
  // parcels × ~3000 soil polygons = up to 24M intersect candidates).
  // Composition stamps in the background via scheduleSoilCompositionStamp;
  // the parcel popup picks up `_soilComposition` once the stamp lands.
  setMuniParcelsData(map, fc);
  scheduleSoilCompositionStamp(fc, {
    // Roll Layer source push doesn't need a viewport refit, and we
    // only re-push the muni-parcels source (not the search-results
    // source) once stamping completes.
    repush: () => mapReady.then(() => setMuniParcelsData(map, fc)),
  });
}

/**
 * Toggle Zoning Layer / Dev Plan Layer visibility, lazy-fetching the
 * full-muni overlay polygons when the layer is being turned on with a
 * municipality selected and the currently-loaded muni doesn't match.
 *
 * Lets a user select a muni and click Zoning Layer (or Dev Plan Layer)
 * to see the entire muni's zoning without first running a parcel
 * search — the most natural workflow for "show me what zones exist
 * here". Searching afterwards still works the same; the in-memory
 * overlay FC stays valid for the same muni.
 *
 * Without a muni selected, the toggle uses whatever data the previous
 * search loaded; if there's nothing cached, it gently reverts and
 * nudges the user to pick a muni.
 */
/**
 * Load Manitoba Soil Survey/CLI polygons for every municipality in a sales
 * or property-list import and stamp the area-weighted top soil components
 * onto each parcel. The polygons are cached and pushed to the hidden CLI
 * source so turning the visual layer on later is instant; loading data does
 * not force the overlay to become visible.
 *
 * Returns a structured completion result so callers can distinguish valid
 * zero-coverage from a failed municipality and avoid exporting silent blanks.
 */
async function enrichImportedSoilComposition(parcelFc, munis, generation, mode) {
  const emptyResult = {
    complete: false,
    superseded: false,
    failures: [],
    featureCount: 0,
  };
  if (!parcelFc?.features?.length || !Array.isArray(munis) || munis.length === 0) {
    return emptyResult;
  }
  const boundaries = muniBoundariesFc || await muniBoundariesPromise;
  if (!boundaries?.features?.length) {
    return {
      ...emptyResult,
      failures: munis.map((muni) => ({ muni, message: 'Municipal boundaries unavailable' })),
    };
  }

  const scoped = munis.map((muni) => {
    const exact = boundaries.features.find(
      (f) => f.properties?.MUNI_LIST_NAME_WITH_TYPE === muni,
    );
    const normalized = exact || boundaries.features.find(
      (f) => normalizeMuniKey(f.properties?.MUNI_LIST_NAME_WITH_TYPE) === normalizeMuniKey(muni),
    );
    return { muni, boundary: normalized || null };
  });
  const missing = scoped.filter((entry) => !entry.boundary).map((entry) => entry.muni);
  if (missing.length) {
    console.warn(`Imported soil enrichment: no municipal boundary for ${missing.join(', ')}`);
  }

  // Bound concurrency so a long multi-municipality import does not burst
  // dozens of ID + feature requests at ArcGIS simultaneously. Each failure
  // remains associated with its municipality instead of becoming EMPTY_FC.
  const failures = missing.map((muni) => ({ muni, message: 'Municipal boundary unavailable' }));
  const fcs = [];
  const loadable = scoped.filter((entry) => entry.boundary);
  const SOIL_IMPORT_CONCURRENCY = 4;
  for (let i = 0; i < loadable.length; i += SOIL_IMPORT_CONCURRENCY) {
    const batch = await Promise.all(loadable.slice(i, i + SOIL_IMPORT_CONCURRENCY)
      .map(async ({ muni, boundary }) => {
        try {
          return { muni, fc: await fetchCliAgrForMuni(muni, boundary), error: null };
        } catch (err) {
          console.warn(`Imported soil enrichment failed for ${muni}:`, err);
          return { muni, fc: null, error: err };
        }
      }));
    for (const result of batch) {
      if (result.error) {
        failures.push({
          muni: result.muni,
          message: result.error.message || String(result.error),
        });
      } else if (result.fc) {
        fcs.push(result.fc);
      }
    }
  }
  const modeStillActive = () => mode === 'sales'
    ? document.body.classList.contains('sales-mode')
    : Array.isArray(listParcelKeys) && listParcelKeys.length > 0;
  if (generation !== salesEnrichmentGeneration || !modeStillActive()) {
    return { ...emptyResult, superseded: true };
  }

  const cliFc = {
    type: 'FeatureCollection',
    features: fcs.flatMap((fc) => fc?.features || []),
  };
  stampSoilCompositionOnParcels(parcelFc, cliFc);
  lastCliFc = cliFc;
  // Mark the visual overlay cache complete when every requested municipality
  // resolved, including valid zero-coverage results. A failed municipality
  // leaves the key unset so a later manual toggle can retry it.
  cliLoadedFor = failures.length === 0
    ? munis.slice().sort().join('|')
    : null;
  await mapReady;
  if (generation !== salesEnrichmentGeneration || !modeStillActive()) {
    return { ...emptyResult, superseded: true };
  }
  setCliAgrData(map, cliFc);
  return {
    complete: failures.length === 0,
    superseded: false,
    failures,
    featureCount: cliFc.features.length,
  };
}

/** The distinct zone codes carried by the parcels currently on the map,
 *  sorted. Empty when the zoning join hasn't run for this result set. */
function resultZoneCodes() {
  return [...new Set(
    (lastResultFc?.features || [])
      .map((f) => f.properties?._zoneCode)
      .filter((c) => c != null && String(c).trim() !== ''))].sort();
}

/** Paint the parcels by zone code and rebuild the legend to match. The
 *  palette comes from the overlay's own builder, so parcel colours and
 *  legend swatches are one assignment rather than two that can drift. */
function paintZoningSelection(codes) {
  const pseudoFc = {
    type: 'FeatureCollection',
    features: codes.map((c) => ({ type: 'Feature', properties: { ZONE: c } })),
  };
  setParcelZoneColoring(map, buildZoneCodePaint(pseudoFc).matchPairs);
  rebuildZoningLegend(pseudoFc);
}

/**
 * Re-derive the SELECTED-ONLY zoning colouring for whatever is on the map
 * now. No-op unless the zoning toggle is actually in that state.
 *
 * Called from setMapData, so it fires twice per search and both firings
 * are wanted. The pre-enrichment call finds no `_zoneCode` yet and CLEARS
 * the colouring; the post-enrichment call repaints from the new parcels'
 * own codes.
 *
 * Without this the paint expression outlived the result set that built it:
 * a new search while the toggle sat in SELECTED-ONLY left the previous
 * search's `match` on parcel-fill, so every zone code absent from the old
 * palette fell through to the `#cccccc` fallback and the new parcels came
 * up grey (Jason, 2026-08-12). Clearing on the way through is the point —
 * a stale palette is worse than no palette, because grey reads as a real
 * answer rather than as "not loaded yet".
 */
function refreshZoningSelectionColoring() {
  if ($zoningToggle?.getAttribute('aria-pressed') !== 'mixed') return;
  const codes = resultZoneCodes();
  if (!codes.length) {
    setParcelZoneColoring(map, null);
    // The legend describes the colouring, so it goes with it — otherwise
    // it sits there listing the previous search's codes against parcels
    // that no longer carry any of them. rebuildZoningLegend renders its
    // own "no zoning data for this search" line on an empty set.
    rebuildZoningLegend(EMPTY_FC);
    return;
  }
  paintZoningSelection(codes);
}

async function toggleOverlay(which) {
  const btn = which === 'zoning' ? $zoningToggle : $devplanToggle;
  const label = which === 'zoning' ? 'Zoning' : 'Development plan';
  const wasActive = btn.classList.contains('active');
  const wasSelectedOnly = btn.getAttribute('aria-pressed') === 'mixed';

  // Zoning cycles through THREE states, because the whole-municipality
  // fabric buries the parcels being analysed (Jason, 2026-08-11):
  //
  //   off -> ALL (whole muni, the long-standing behaviour)
  //       -> SELECTED ONLY (just the zones under the loaded parcels)
  //       -> off
  //
  // 'mixed' is the codebase's existing convention for an overlay's
  // secondary mode (grid section/quarter, landcover, CLI) — see
  // lib/overlayToggle.js — so the button styling and the URL-state
  // writer already understand it. Dev plan keeps the plain on/off cycle:
  // its designations are broad by nature, so clipping them to parcels
  // hides the surrounding context that makes one readable.
  const triState = which === 'zoning';
  const selectedOnly = triState && wasActive && !wasSelectedOnly;
  const visible = triState ? (!wasActive || selectedOnly) : !wasActive;
  setOverlayPressed(btn, visible ? (selectedOnly ? 'mixed' : true) : false);

  await mapReady;

  if (!visible) {
    setOverlayBtnLabel(btn, label);
    applyOverlayVisibility(which, false);
    // Cycling OFF lands here, and the third click of the zoning cycle
    // arrives from the SELECTED-ONLY state — which paints the parcels
    // themselves with their zone colours rather than drawing polygons.
    // applyOverlayVisibility only hides the polygon layers, so without
    // this the parcels kept their zone colouring with the overlay
    // switched off, and no further click could clear it: the next cycle
    // goes off -> ALL, which repaints rather than resets (Jason,
    // 2026-08-12). Unconditional for zoning — restoring the plain
    // highlight fill when it is already the plain highlight fill is a
    // no-op, and that is cheaper than tracking which state we came from.
    if (which === 'zoning') setParcelZoneColoring(map, null);
    return;
  }

  // Determine the muni scope for the layer fetch. Sales-CSV mode
  // covers EVERY matched muni; outside sales mode it's the dropdown's
  // single value. The cache key is the joined muni list so a dropdown
  // change within sales mode doesn't trigger a refetch.
  const munisRaw = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.slice()
    : ($municipality.value ? [$municipality.value] : []);
  const munis = [...new Set(munisRaw.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  // Selected-only keys its cache on the parcel set, not the muni list —
  // filtering the table changes what "selected" means, and the layer has
  // to follow. Without the distinct prefix the two modes would share a
  // cache entry and the second click would show the first mode's data.
  const parcelCount = lastResultFc?.features?.length || 0;
  const loadKey = selectedOnly ? `sel:${munis.join('|')}:${parcelCount}` : munis.join('|');
  const loadedFor = which === 'zoning' ? zoningLayerLoadedFor : devPlanLayerLoadedFor;
  const cachedFc  = which === 'zoning' ? lastZoningFc        : lastDevPlanFc;
  const haveData  = (cachedFc?.features?.length || 0) > 0;
  // SELECTED ONLY colours the parcels themselves by their zoning code and
  // draws no zoning polygons at all. Fetching the polygons that intersect
  // the parcels (what this did first) shades whole blocks around them,
  // which is not "zoning for my selection" — and each parcel already
  // carries _zoneCode from the enrichment join, so the answer is on hand
  // with no request at all.
  if (selectedOnly && parcelCount > 0 && which === 'zoning') {
    const codes = resultZoneCodes();
    if (!codes.length) {
      setOverlayPressed(btn, true);          // fall back to the full overlay
      setOverlayBtnLabel(btn, label);
      setCount('No zoning is joined to these parcels yet — showing the full layer.');
      applyOverlayVisibility(which, true);
      return;
    }
    paintZoningSelection(codes);
    applyOverlayVisibility('zoning', false);  // no polygons in this state
    if ($zoningLegend) $zoningLegend.hidden = false;
    btn.disabled = false;
    setOverlayBtnLabel(btn, `${label} (selection)`);
    setCount(`Zoning shown on the ${parcelCount} selected parcel(s): ${codes.length} zone code(s).`);
    return;
  }
  // Leaving the selection state: parcels go back to the highlight fill.
  if (which === 'zoning') setParcelZoneColoring(map, null);

  // Selected-only needs parcels on the map, not a municipality.
  if (selectedOnly && parcelCount === 0) {
    setOverlayPressed(btn, true);            // fall back to the ALL state
    setOverlayBtnLabel(btn, label);
    setCount('Load parcels first to show zoning for the selection only.');
    applyOverlayVisibility(which, true);
    return;
  }
  const needFetch = (selectedOnly || munis.length > 0) && loadedFor !== loadKey;

  if (needFetch) {
    btn.disabled = true;
    setOverlayBtnLabel(btn, 'Loading…');
    try {
      // Two fetch shapes. SELECTED ONLY runs the per-parcel spatial
      // query (esriSpatialRelIntersects — a true intersection, so the
      // result is exactly the zones the parcels sit in). ALL does the
      // per-muni bulk fetch in parallel, so the user sees overlay
      // coverage across the entire sales-CSV upload rather than just
      // the dominant municipality's parcels.
      const fcs = selectedOnly
        ? [await (which === 'zoning'
            ? fetchZoningOverlap(lastResultFc)
            : fetchDevPlanOverlap(lastResultFc))]
        : await Promise.all(munis.map((m) => (
            which === 'zoning'
              ? fetchZoningOverlap(EMPTY_FC, { municipality: m })
              : fetchDevPlanOverlap(EMPTY_FC, { municipality: m })
          )));
      const merged = {
        type: 'FeatureCollection',
        features: fcs.flatMap((fc) => fc?.features || []),
      };
      if (which === 'zoning') {
        setZoningData(map, merged);
        lastZoningFc = merged;
        rebuildZoningLegend(merged);
        zoningLayerLoadedFor = loadKey;
      } else {
        setDevPlanData(map, merged);
        lastDevPlanFc = merged;
        devPlanLayerLoadedFor = loadKey;
        // Sales imports skip the dev-plan join entirely (see
        // handleSalesUpload). Turning the layer on is the user asking
        // for that data, so fill in the columns they were missing.
        if (devPlanDeferred) await backfillDevPlanColumns(merged);
      }
    } catch (err) {
      console.warn(`${label} fetch failed`, err);
      setOverlayPressed(btn, false);
      btn.disabled = false;
      setOverlayBtnLabel(btn, label);
      setCount(`Failed to load ${label}: ${err.message}`);
      return;
    }
    btn.disabled = false;
  } else if (!selectedOnly && munis.length === 0 && !haveData) {
    // No muni selected and nothing cached from a previous search —
    // revert the toggle and tell the user what to do.
    setOverlayPressed(btn, false);
    setOverlayBtnLabel(btn, label);
    setCount(`Select a municipality to load the ${label}.`);
    return;
  }

  // Name the mode on the button itself. Without it the two ON states are
  // distinguishable only by the pressed shade, which is not enough to
  // tell "no zoning here" from "zoning hidden outside the selection".
  setOverlayBtnLabel(btn, selectedOnly ? `${label} (selection)` : label);
  applyOverlayVisibility(which, true);
}

/** Apply the visible/hidden styling for the zoning or dev-plan overlay
 *  layers, including the floating zoning legend and the AADT-legend
 *  bump-up class that keeps the two legends from overlapping. */
function applyOverlayVisibility(which, visible) {
  if (which === 'zoning') {
    setZoningVisible(map, visible);
    if ($zoningLegend) $zoningLegend.hidden = !visible;
    if ($flowLegend) $flowLegend.classList.toggle('with-zoning', visible);
  } else {
    setDevPlanVisible(map, visible);
    // Mirror the Dev Plan Layer's visibility on the table so the
    // Dev-Plan Designation + DP By-law columns show only while the
    // overlay is on. CSS rule .devplan-only / .devplan-mode picks
    // it up.
    if ($resultsTable) $resultsTable.classList.toggle('devplan-mode', visible);
  }
}

/**
 * When the muni dropdown changes, refresh any currently-active Zoning
 * Layer / Dev Plan Layer to the new muni's polygons. Avoids the user
 * having to toggle off-then-on after picking a new muni. If the muni
 * is cleared, the layers are emptied.
 */
async function refreshOverlayLayersForMuniChange() {
  // Same dual-mode scope as toggleOverlay: sales-CSV mode covers every
  // matched muni; otherwise just the dropdown's value. The loadKey is
  // the joined muni list so a dropdown change inside sales mode is a
  // no-op (the multi-muni overlay stays loaded).
  const munis = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.slice()
    : ($municipality.value ? [$municipality.value] : []);
  const loadKey = munis.join('|');
  await mapReady;

  if ($zoningToggle.classList.contains('active') && zoningLayerLoadedFor !== loadKey) {
    if (munis.length > 0) {
      try {
        const fcs = await Promise.all(munis.map((m) => (
          fetchZoningOverlap(EMPTY_FC, { municipality: m })
        )));
        const merged = {
          type: 'FeatureCollection',
          features: fcs.flatMap((fc) => fc?.features || []),
        };
        setZoningData(map, merged);
        lastZoningFc = merged;
        rebuildZoningLegend(merged);
        zoningLayerLoadedFor = loadKey;
      } catch (err) {
        console.warn('zoning layer refresh failed on muni change', err);
      }
    } else {
      setZoningData(map, EMPTY_FC);
      lastZoningFc = EMPTY_FC;
      rebuildZoningLegend(EMPTY_FC);
      zoningLayerLoadedFor = null;
    }
  }

  if ($devplanToggle.classList.contains('active') && devPlanLayerLoadedFor !== loadKey) {
    if (munis.length > 0) {
      try {
        const fcs = await Promise.all(munis.map((m) => (
          fetchDevPlanOverlap(EMPTY_FC, { municipality: m })
        )));
        const merged = {
          type: 'FeatureCollection',
          features: fcs.flatMap((fc) => fc?.features || []),
        };
        setDevPlanData(map, merged);
        lastDevPlanFc = merged;
        devPlanLayerLoadedFor = loadKey;
      } catch (err) {
        console.warn('dev-plan layer refresh failed on muni change', err);
      }
    } else {
      setDevPlanData(map, EMPTY_FC);
      lastDevPlanFc = EMPTY_FC;
      devPlanLayerLoadedFor = null;
    }
  }
}


/**
 * Toggle one of the province-wide auxiliary overlays:
 *   contam  — Manitoba Contaminated Sites Registry (CSV → coloured points)
 *   flow    — MHTIS Traffic Flow 2023 (FeatureServer polylines, AADT-coloured)
 *   highways — Manitoba Road Network 2023 (FeatureServer polylines)
 *   riskAreas — official MASC crop-insurance risk-area polygons
 *
 * These are lazily fetched on first activation and cached through the
 * shared localStorage cache. Loading the flow layer also opportunistically joins
 * AADT onto the already-loaded stations so the station popup can show
 * the segment AADT inline (and vice-versa: loading stations after flow
 * triggers the same join). Failures are non-fatal — the button reverts.
 */
const auxLoaded = { contam: false, flow: false, highways: false, riskAreas: false, muniParcels: false, tileDrainage: false, tileNetwork: false, irrigation: false };
const auxData   = { contam: null, flow: null, highways: null, riskAreas: null, muniParcels: null, tileDrainage: null, tileNetwork: null, irrigation: null };
// Tracks which muni's parcels are currently in the muni-parcels source so
// we know whether to refetch when the user switches munis.
let muniParcelsLoadedFor = null;

const AUX_META = {
  contam:      { btn: () => $contamToggle,      on: 'Environmental sites', off: 'Environmental sites', busy: 'Loading…',
                 fetch: () => fetchContaminatedSites(),       setData: (m, fc) => setContamData(m, fc),      setVis: setContamVisible },
  flow:        { btn: () => $flowToggle,        on: 'Traffic flow', off: 'Traffic flow', busy: 'Loading…',
                 fetch: () => fetchTrafficFlow(),             setData: (m, fc) => setTrafficFlowData(m, fc), setVis: setTrafficFlowVisible },
  highways:    { btn: () => $highwaysToggle,    on: 'Manitoba Highways', off: 'Manitoba Highways', busy: 'Loading…',
                 fetch: () => fetchManitobaHighways(),         setData: (m, fc) => setMbHighwaysData(m, fc), setVis: setMbHighwaysVisible },
  riskAreas:   { btn: () => $riskAreaToggle,    on: 'MASC risk areas', off: 'MASC risk areas', busy: 'Loading…',
                 fetch: () => fetchMascRiskAreas(),            setData: (m, fc) => setMascRiskAreasData(m, fc), setVis: setMascRiskAreasVisible },
  muniParcels: { btn: () => $muniParcelsToggle, on: 'Assessment Parcels', off: 'Assessment Parcels', busy: 'Loading…',
                 fetch: () => fetchMuniParcelsForCurrentScope(),
                 setData: (m, fc) => setMuniParcelsMapData(fc), setVis: setMuniParcelsVisible },
  // WALLAS. Tile drainage is province-wide and cached, so it loads once
  // and stays; the tile network is viewport-scoped and refetches on map
  // idle (see refreshTileNetworkForViewport).
  tileDrainage: { btn: () => $tileToggle, on: 'Tile Drainage', off: 'Tile Drainage', busy: 'Loading…',
                 fetch: () => fetchTileDrainageAreas(),
                 setData: (m, fc) => setTileDrainageData(m, fc), setVis: setTileDrainageVisible },
  tileNetwork: { btn: () => $tileNetworkToggle, on: 'Tile Lines & Outlets', off: 'Tile Lines & Outlets', busy: 'Loading…',
                 fetch: () => fetchTileNetworkForViewport(),
                 setData: (m, data) => setTileNetworkData(m, data), setVis: setTileNetworkVisible },
  irrigation:  { btn: () => $irrigationToggle, on: 'Irrigation Licences', off: 'Irrigation Licences', busy: 'Loading…',
                 fetch: () => fetchIrrigationLicences(),
                 setData: (m, fc) => setIrrigationData(m, fc), setVis: setIrrigationVisible },
};

// ---------- Tile network (viewport-scoped) ----------
// 85,000 tile lines exist province-wide, so this layer only ever holds
// what's on screen. The upstream service draws these from ~1:100,000 in;
// below that zoom a fetch would return thousands of features that render
// as an unreadable smear, so we skip it and leave the source empty.
const TILE_NETWORK_MIN_ZOOM = 11;

function fetchTileNetworkForViewport() {
  if (!map || map.getZoom() < TILE_NETWORK_MIN_ZOOM) {
    return Promise.resolve({
      lines: { type: 'FeatureCollection', features: [] },
      outlets: { type: 'FeatureCollection', features: [] },
    });
  }
  const b = map.getBounds();
  return fetchTileNetwork([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
}

/**
 * Refetch the tile network for the current viewport. Wired to map idle,
 * so it fires after a pan/zoom settles rather than during it.
 *
 * `tileNetworkSeq` guards against out-of-order responses: a slow fetch
 * for a view the user has already panned away from must not overwrite a
 * newer one that landed first.
 */
let tileNetworkSeq = 0;
let tileNetworkLastKey = null;

/** Identity of the current view for tile-network purposes. `idle` fires
 *  on plenty of things that aren't a viewport change — a source finishing
 *  its load, a style repaint, a popup opening — so rounding the bounds to
 *  ~100 m collapses those into one key and we only hit the service when
 *  the user has actually moved. */
function tileNetworkViewportKey() {
  const b = map.getBounds();
  const zoomBand = map.getZoom() < TILE_NETWORK_MIN_ZOOM ? 'out' : 'in';
  return `${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(3)).join(',')}@${zoomBand}`;
}

async function refreshTileNetworkForViewport() {
  if (!$tileNetworkToggle?.classList.contains('active')) return;
  const key = tileNetworkViewportKey();
  if (key === tileNetworkLastKey) return;
  tileNetworkLastKey = key;
  const seq = ++tileNetworkSeq;
  try {
    const data = await fetchTileNetworkForViewport();
    if (seq !== tileNetworkSeq) return;
    auxData.tileNetwork = data;
    setTileNetworkData(map, data);
  } catch (err) {
    console.warn('tile network viewport refresh failed', err);
    // Clear the key so the next idle retries rather than treating the
    // failed view as already fetched.
    tileNetworkLastKey = null;
  }
}

/** Fetch the Roll Layer's parcel fabric, scoped to either import
 *  workflow's matched-muni list or the dropdown's single muni.
 *  Per-muni fetches run in parallel and merge into one FC — same
 *  pattern as the MASC/CLI/Grid/Zoning/DevPlan overlays. Returns an
 *  empty FC when nothing is in scope (toggleAuxOverlay catches that
 *  upstream via the disabled-button gate). */
async function fetchMuniParcelsForCurrentScope() {
  const munis = scopedOverlayMunis();
  if (munis.length === 0) {
    return { type: 'FeatureCollection', features: [] };
  }
  const fcs = await Promise.all(munis.map((m) => fetchAllParcelsInMunicipality(m)));
  return {
    type: 'FeatureCollection',
    features: fcs.flatMap((fc) => fc?.features || []),
  };
}

/** Resolve the muni-parcels loadKey for the current scope. Mirrors
 *  the joined-list pattern the other overlay toggles use so a
 *  dropdown change inside either import mode doesn't trigger a
 *  refetch. Empty scope collapses to '' — the falsy "never loaded"
 *  sentinel the reset below compares against. */
function muniParcelsLoadKey() {
  return scopedOverlayMunis().join('|');
}

/**
 * Enable / disable the Muni Parcels toggle based on whether a muni is
 * selected. When the muni changes, force a clean refetch the next time
 * the user toggles the layer on (the previous muni's parcels stay in the
 * map source until then so a no-op change doesn't blank the overlay).
 */
function resetMuniParcelsToggle() {
  // Button enabled when a muni is selected OR either import workflow
  // (sales CSV, property list) has resolved a multi-muni scope. The
  // fabric fetch is one request per muni, so a wide import stays a
  // deliberate click — nothing here auto-toggles the layer on.
  const inScope = scopedOverlayMunis().length > 0;
  $muniParcelsToggle.disabled = !inScope;
  // Historical compare is single-muni: enable only when a muni is picked.
  // If the muni changed while historical is on, drop it (it's another muni).
  if ($historicalToggle) {
    $historicalToggle.disabled = !$municipality.value;
    if (historicalActive && historicalLoadedMuni && historicalLoadedMuni !== $municipality.value) {
      deactivateHistorical();
    }
  }
  // If the scope changed (different dropdown muni, or sales mode just
  // ended), mark the layer as needing a refetch and turn it off so we
  // don't keep showing another scope's parcels on screen. Inside sales
  // mode the loadKey is the joined matched-muni list, so a dropdown
  // change while sales mode is active is a no-op.
  const desiredKey = muniParcelsLoadKey();
  if (muniParcelsLoadedFor && muniParcelsLoadedFor !== desiredKey) {
    auxLoaded.muniParcels = false;
    muniParcelsLoadedFor = null;
    if ($muniParcelsToggle.classList.contains('active')) {
      setOverlayPressed($muniParcelsToggle, false);
      setOverlayBtnLabel($muniParcelsToggle, 'Assessment Parcels');
      mapReady.then(() => setMuniParcelsVisible(map, false));
    }
  }
}

// ---------- Historical (as-of-year) compare overlay ----------
// Overlays an earlier year's parcels (dashed amber), zoning + dev-plan for
// the selected muni, fetched on demand from the mb-parcel-history CDN. The
// data is fully self-describing (root index.json → per-year manifest →
// per-muni shards), so adding a year needs no code change here.
let historicalActive = false;
let historicalLoadedMuni = null;
let historicalIndexCache = null;
// (muni|roll) → as-of geometry for the snapshot currently loaded, built from
// the same shard the dashed-amber overlay draws. Non-null only while the
// overlay is on; drives the search-result highlight (see asOfHighlight).
//
// Built whether or not the Parcels sub-layer below is switched on: the
// searched parcel's as-of boundary is the ONE thing an active snapshot always
// shows, and it is independent of the muni-wide context layers.
let historicalGeomByKey = null;

// Which historical context layers are showing. All OFF on first activation —
// each blankets the whole municipality, and switching the three on together
// buried the searched parcel under the wash (Jason, 2026-08-13). Deliberately
// NOT reset when the overlay is toggled off or the As-of date changes: once
// you have asked for historical zoning, walking through the snapshot dates
// should keep showing it rather than making you re-tick it each time.
const historicalLayersOn = { parcels: false, zoning: false, devplan: false };

/** Push `historicalLayersOn` to the map and to the three buttons' pressed state. */
function applyHistoricalLayers() {
  const live = historicalActive;
  for (const [key, on] of Object.entries(historicalLayersOn)) {
    // Nothing shows while the overlay is off, whatever the remembered state.
    mapReady.then(() => setHistoricalLayerVisible(map, key, live && on));
    const btn = $historicalLayerBtns[key];
    if (!btn) continue;
    btn.disabled = !live;
    setOverlayPressed(btn, live && on);
  }
  if ($historicalLayersWrap) $historicalLayersWrap.hidden = !live;
  renderHistoricalLegends();
  refreshOverlayGroupCounts();
}

/**
 * Swatch keys for the historical zoning / dev-plan fills, each shown only
 * while its own layer is drawing.
 *
 * These layers used to be one flat colour apiece, which is what made the
 * whole city read as a single zone. Colouring by category fixes the map; a
 * key is what makes the colours mean anything without clicking every polygon.
 * Deliberately separate boxes from #zoning-legend (the live Zoning Layer's) so
 * the as-of and current-day keys can sit side by side — comparing the two is
 * the reason to be in this view at all. Both draw from the same palette, so a
 * code that appears in both boxes carries the same colour.
 */
function renderHistoricalLegends() {
  const render = ($el, which, title) => {
    if (!$el) return;
    const show = historicalActive && historicalLayersOn[which];
    const rows = show ? getHistoricalLegend(which) : [];
    if (!rows.length) { $el.hidden = true; $el.innerHTML = ''; return; }
    const snap = $historicalYear?.value || '';
    const items = rows
      .map((r) => `<li><span class="swatch" style="background:${escapeHtmlText(r.color)}"></span>${escapeHtmlText(r.code)}</li>`)
      .join('');
    $el.innerHTML = `<strong>${title}${snap ? ` (${escapeHtmlText(snap)})` : ''}</strong><ul>${items}</ul>`
      + '<small style="display:block;margin-top:4px;color:#6b7280;font-style:italic">Pointer only — verify against the by-law / planning district.</small>';
    $el.hidden = false;
  };
  render($historicalZoningLegend,  'zoning',  'Historical zoning');
  render($historicalDevplanLegend, 'devplan', 'Historical dev plan');
}

function toggleHistoricalLayer(key) {
  if (!historicalActive || !(key in historicalLayersOn)) return;
  historicalLayersOn[key] = !historicalLayersOn[key];
  applyHistoricalLayers();
}

const HISTORICAL_LAYER_LABELS = { parcels: 'Parcels', zoning: 'Zoning', devplan: 'Dev Plan' };

/**
 * Status-line clause naming which context layers are drawing. With none on —
 * the default — it says so and points at the control, so an empty-looking
 * historical map reads as a setting rather than as a failed load.
 */
function historicalLayerNote() {
  const on = Object.entries(historicalLayersOn)
    .filter(([, v]) => v)
    .map(([k]) => HISTORICAL_LAYER_LABELS[k]);
  return on.length
    ? ` Context layers on: ${on.join(', ')}. Click one for its as-of details.`
    : ' Only your search result is drawn, with its as-of boundary — switch on Parcels / Zoning / Dev Plan under Layers for muni-wide context.';
}

/**
 * As-of geometry for a result set, or null when no as-of date is in force.
 *
 * With the Historical overlay on, a search has to highlight the parcel as it
 * stood at the snapshot date. Brandon roll 562264 (1501 BRAECREST DR) is the
 * reported case: 12.23 acres on 2025-02-12, 3.78 acres today after roll 562314
 * was carved off it. Highlighting today's remnant under a banner reading
 * "HISTORICAL as of 2025-02-12" asserts the wrong boundary for the date on
 * screen — and fitBounds then framed the wrong extent as well.
 *
 * Only the map highlight is swapped. The results table, the CSV/evidence
 * exports and the Parcel Snapshots images stay on today's record — those are
 * live-enriched (legal, assessment, MASC, land cover) and the shards carry none
 * of it. The popup says which boundary it is drawing (`_asOfGeom`), and the
 * status line reports the count.
 *
 * Returns null (caller uses today's geometry unchanged) when the overlay is off
 * or still loading, and when nothing in the result set is in its scope. Scope is
 * enforced per feature by the (muni, roll) key rather than by a dropdown check,
 * so a multi-muni result set keeps today's geometry on the parcels the loaded
 * snapshot says nothing about.
 */
function asOfHighlight(parcelFc) {
  if (!historicalActive || !historicalGeomByKey) return null;
  if (!(parcelFc?.features?.length)) return null;
  const r = applyHistoricalGeometry(parcelFc, historicalGeomByKey, {
    snapshot: $historicalYear?.value || null,
    canonicalRoll,
  });
  return r.swapped > 0 || r.missing > 0 ? r : null;
}

/**
 * Re-draw the current result set's highlight after the as-of date is turned
 * on, changed, or turned off, so the outline follows without re-running the
 * search. Re-fits the camera only when the swap actually moved geometry — an
 * as-of parcel can be an order of magnitude larger than today's remnant, and
 * leaving the old frame would put most of it off-screen.
 *
 * @returns {{swapped:number, missing:number, missingRolls:string[]}|null}
 *   null when there is no result set on the map, or nothing to swap.
 */
function refreshAsOfHighlight() {
  const fc = lastResultFc;
  if (!(fc?.features?.length)) return null;
  const asOf = asOfHighlight(fc);
  lastAsOfHighlight = asOf;   // keep in step with what setMapData would have stashed
  // Re-apply the boundary withholding on the same terms setMapData uses.
  // Without this, turning the as-of date off would hand every changed parcel
  // its current polygon back — the one thing the withholding exists to stop.
  const asOfFc = asOf ? asOf.fc : fc;
  const withheld = withholdChangedGeometry(asOfFc, { centroid: parcelCentrePoint });
  lastWithheldGeometry = withheld;
  const pushFc = withheld.withheld ? withheld.fc : asOfFc;
  mapReady.then(() => {
    showResults(map, pushFc, { fit: !!asOf?.swapped });
    setParcelNumberData(map, pushFc.features || []);
  });
  return asOf;
}

/** Status-line note for what the as-of highlight did, or '' when it did nothing. */
function asOfHighlightNote(asOf, snap) {
  if (!asOf?.swapped && !asOf?.missing) return '';
  const parts = [];
  if (asOf.swapped) {
    parts.push(`${asOf.swapped} highlighted parcel${asOf.swapped === 1 ? '' : 's'} redrawn`
      + ` as of ${snap} (display geometry simplified — verify against the archived source)`);
  }
  if (asOf.missing) {
    const shown = asOf.missingRolls.slice(0, 3).map(displayRoll).join(', ');
    const extra = asOf.missingRolls.length > 3 ? ` +${asOf.missingRolls.length - 3} more` : '';
    parts.push(`${asOf.missing} had no parcel at that date (roll ${shown}${extra})`
      + ' — still showing today\'s boundary');
  }
  return ` Highlight: ${parts.join('; ')}.`;
}

// Populate the "As of" picker from the CDN discovery index — snapshot dates
// (YYYY-MM-DD), grouped by year via <optgroup>. Self-describing: adding a
// snapshot needs no code change here.
async function initHistoricalSnapshots() {
  if (!$historicalYear) return;
  const idx = await fetchHistoricalIndex().catch(() => null);
  historicalIndexCache = idx;
  const snaps = idx?.snapshots
    ? Object.keys(idx.snapshots).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort().reverse()
    : [];
  $historicalYear.innerHTML = '';
  let curYear = null, grp = null;
  for (const s of snaps) {
    const yr = s.slice(0, 4);
    if (yr !== curYear) { grp = document.createElement('optgroup'); grp.label = yr; $historicalYear.appendChild(grp); curYear = yr; }
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;   // value = snapshot_id (YYYY-MM-DD)
    grp.appendChild(opt);
  }
  if (snaps.length && $historicalYearWrap) $historicalYearWrap.hidden = false;
}

// Per-layer source dates for a snapshot (from the discovery index).
function historicalLayerDates(snap) {
  const layers = historicalIndexCache?.snapshots?.[snap]?.layers || {};
  return {
    roll: layers.parcels?.source_date || null,
    zoning: layers.zoning?.source_date || null,
    devplan: layers.devplan?.source_date || null,
  };
}

// Newest snapshot > 12 months old? snapshot_ids are dates, so take the max.
function historicalIsStale() {
  const snaps = historicalIndexCache?.snapshots;
  const keys = snaps ? Object.keys(snaps).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)) : [];
  if (!keys.length) return false;
  const newest = keys.sort().reverse()[0];
  return (Date.now() - Date.parse(newest)) > 365 * 24 * 60 * 60 * 1000;
}

async function resolveHistoricalMuniNo(snap, muniName) {
  const m = await fetchHistoricalManifest(snap).catch(() => null);
  if (!m?.munis) return null;
  const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const target = norm(muniName);
  for (const [no, info] of Object.entries(m.munis)) {
    if (info?.name === muniName || norm(info?.name) === target) return Number(no);
  }
  return null;
}

async function toggleHistoricalOverlay() {
  if (!$historicalToggle) return;
  await mapReady;
  if (historicalActive) { deactivateHistorical(); return; }
  if (!$municipality.value) { setCount('Historical: select a municipality first.'); return; }
  const snap = $historicalYear?.value;
  if (!snap) { setCount('Historical: no snapshots available.'); return; }
  await loadHistorical(snap, $municipality.value);
}

async function onHistoricalYearChange() {
  if (!historicalActive || !$municipality.value || !$historicalYear?.value) return;
  await loadHistorical($historicalYear.value, $municipality.value);
}

// Match historical-snapshot parcels to today's parcels (same muni, by roll)
// and stamp each historical feature with its size-change band so the map can
// colour it and the popup can show old→new acres. Best-effort: returns the
// change summary, or null when current data can't be loaded. The current muni
// fabric fetch is cached (also used by the snapshot export).
async function stampHistoricalSizeChanges(parcels, muniName) {
  try {
    const histByRoll = new Map();
    for (const f of parcels.features || []) {
      const roll = f.properties?.Roll_No_Txt;
      const a = parcelAcres(f);
      if (roll && a > 0) histByRoll.set(roll, a);
    }
    const cur = await fetchAllParcelsInMunicipality(muniName).catch((e) => {
      console.warn(`[historical] size-change: current-parcel fetch threw for muni "${muniName}" — highlight disabled.`, e);
      return null;
    });
    const curFeatureCount = cur?.features?.length || 0;
    const curByRoll = new Map();
    // roll → today's MAO assessment-report URL, harvested from the SAME current
    // fetch. Lets the historical popup link a parcel's roll (and its lineage
    // "→ became" rolls) to the CURRENT MAO page. The URL is keyed by internal
    // MAO ids, not the roll, so it can't be synthesized — it must come from
    // today's parcel record.
    const curUrlByRoll = new Map();
    for (const f of cur?.features || []) {
      const roll = f.properties?.Roll_No_Txt;
      if (!roll) continue;
      const a = parcelAcres(f);
      if (a > 0) curByRoll.set(roll, a);
      const url = f.properties?.Asmt_Rpt_Url;
      if (url && !curUrlByRoll.has(roll)) curUrlByRoll.set(roll, url);
    }
    // Diagnostic: distinguish "genuinely no current data" from a name/roll-key
    // FORMAT MISMATCH (the failure mode flagged at review). If the muni name
    // doesn't resolve to current parcels, or the rolls don't overlap at all
    // despite both sides having data, the highlight silently no-ops — so say so
    // loudly in the console with the values needed to diagnose.
    if (curByRoll.size === 0) {
      console.warn(
        `[historical] size-change: no current parcels to compare for muni "${muniName}" `
        + `(fetch returned ${curFeatureCount} feature(s)). `
        + (curFeatureCount === 0
            ? 'Likely a municipality-name format mismatch with fetchAllParcelsInMunicipality — highlight disabled.'
            : 'Features returned but none had a roll + positive acreage — highlight disabled.'),
      );
      return null;
    }
    const { byRoll, summary } = computeSizeChanges(histByRoll, curByRoll);
    const matched = histByRoll.size - summary.gone;   // hist rolls that found a current match
    if (histByRoll.size > 0 && matched === 0) {
      const sample = (m) => Array.from(m.keys()).slice(0, 3).join(', ') || '(none)';
      console.warn(
        `[historical] size-change: ${histByRoll.size} historical and ${curByRoll.size} current parcels, `
        + `but ZERO roll overlap for muni "${muniName}" — likely a Roll_No_Txt key-format mismatch. `
        + `hist sample: [${sample(histByRoll)}] · current sample: [${sample(curByRoll)}]`,
      );
    } else {
      console.info(
        `[historical] size-change "${muniName}": ${histByRoll.size} hist / ${curByRoll.size} current rolls, `
        + `${matched} matched, ${summary.gone} gone, ${summary.appeared} new · `
        + `changed: ${summary.major} major, ${summary.minor} minor.`,
      );
    }
    for (const f of parcels.features || []) {
      if (!f.properties) continue;
      const roll = f.properties.Roll_No_Txt;
      // Current MAO page for this parcel's own roll (if it still exists today).
      const curUrl = roll ? curUrlByRoll.get(roll) : null;
      if (curUrl) f.properties._curAsmtUrl = curUrl;
      const rec = byRoll.get(roll);
      if (!rec) continue;
      f.properties._sizeBand = rec.band;
      if (rec.histAcres != null) f.properties._histAcres = rec.histAcres;
      if (rec.curAcres  != null) f.properties._curAcres  = rec.curAcres;
      if (rec.deltaPct  != null) f.properties._deltaPct  = rec.deltaPct;
    }
    return { summary, curUrlByRoll };
  } catch (err) {
    console.warn('historical size-change stamp failed', err);
    return null;
  }
}

async function loadHistorical(snap, muniName) {
  $historicalToggle.disabled = true;
  setOverlayBtnLabel($historicalToggle, 'Loading…');
  try {
    const muniNo = await resolveHistoricalMuniNo(snap, muniName);
    if (muniNo == null) { setCount(`Historical: no ${snap} data for ${muniName}.`); deactivateHistorical(); return; }
    const [parcels, zoning, devplan, lineage] = await Promise.all([
      fetchHistoricalShard(snap, 'parcels', muniNo),
      fetchHistoricalShard(snap, 'zoning', muniNo),
      fetchHistoricalShard(snap, 'devplan', muniNo),
      fetchHistoricalLineage(muniNo),
    ]);
    if (!parcels) { setCount(`Historical: couldn't load ${snap} parcels for ${muniName}.`); deactivateHistorical(); return; }
    // Stamp size-change bands + current-MAO links BEFORE setHistoricalData so
    // the colour expression and popups see them on the first render.
    const enrich = await stampHistoricalSizeChanges(parcels, muniName);
    const sizeSummary = enrich?.summary || null;
    setHistoricalData(map, {
      parcels, zoning, devplan, year: snap,
      lineage: lineage?.by_roll || null,
      currentUrls: enrich?.curUrlByRoll || null,   // roll → today's MAO URL for the popup links
    });
    historicalActive = true;
    historicalLoadedMuni = muniName;
    // Apply the remembered per-layer state rather than showing everything.
    // First activation = all three off, so an as-of date on its own draws only
    // the searched parcel's as-of boundary.
    applyHistoricalLayers();
    // Index the same shard by (muni, roll) so a search under this as-of date
    // highlights the parcel as it stood then. Built before the highlight is
    // refreshed below, and again on every snapshot change.
    historicalGeomByKey = indexHistoricalGeometry(parcels, { canonicalRoll });
    setOverlayPressed($historicalToggle, true);
    updateHistoricalBanner(snap);
    // An as-of date turned on (or changed) over an existing result set redraws
    // that highlight immediately — no need to re-run the search.
    const asOf = refreshAsOfHighlight();
    const n = parcels.features?.length || 0;
    let changeNote = '';
    if (sizeSummary) {
      const parts = [];
      if (sizeSummary.major) parts.push(`${sizeSummary.major} major`);
      if (sizeSummary.minor) parts.push(`${sizeSummary.minor} minor`);
      if (sizeSummary.gone)  parts.push(`${sizeSummary.gone} gone`);
      // The colour key only means anything while the Parcels layer is drawing;
      // the counts themselves are worth stating either way.
      if (parts.length) {
        changeNote = ` Size changes since: ${parts.join(', ')}`
          + (historicalLayersOn.parcels ? ' (red >25%, orange >5%, grey = roll gone).' : '.');
      }
    }
    setCount(`Historical as of ${snap} — ${muniName}, ${n} parcel${n === 1 ? '' : 's'} in the snapshot.`
      + `${asOfHighlightNote(asOf, snap)}${changeNote}${historicalLayerNote()}`
      + ' Verify against by-law/title records.');
  } catch (err) {
    console.warn('historical load failed', err);
    setCount('Historical: load failed.');
    deactivateHistorical();
  } finally {
    $historicalToggle.disabled = !$municipality.value;
    setOverlayBtnLabel($historicalToggle, 'Show');
  }
}

function deactivateHistorical() {
  const wasActive = historicalActive;
  historicalActive = false;
  historicalLoadedMuni = null;
  historicalGeomByKey = null;
  mapReady.then(() => setHistoricalVisible(map, false));
  // Hides + disables the three sub-toggles. historicalLayersOn itself is NOT
  // cleared — switching the overlay back on restores the layers you had chosen.
  applyHistoricalLayers();
  if ($historicalToggle) {
    setOverlayPressed($historicalToggle, false);
    setOverlayBtnLabel($historicalToggle, 'Show');
  }
  if ($historicalBanner) $historicalBanner.hidden = true;
  // Put today's boundary back under the highlight. Guarded on wasActive so the
  // no-op calls (a failed load, a muni change with the overlay already off)
  // don't touch the map.
  if (wasActive) refreshAsOfHighlight();
}

function updateHistoricalBanner(snap) {
  if (!$historicalBanner) return;
  const d = historicalLayerDates(snap);
  const parts = [];
  if (d.roll) parts.push(`Roll ${d.roll}`);
  if (d.zoning) parts.push(`Zoning ${d.zoning}`);
  if (d.devplan) parts.push(`Dev Plan ${d.devplan}`);
  const stale = historicalIsStale();
  $historicalBanner.classList.toggle('is-stale', stale);
  $historicalBanner.innerHTML =
    `HISTORICAL as of ${snap}${parts.length ? ' · ' + parts.join(' · ') : ''}`
    + ' · <span class="hb-verify">verify vs by-law / title</span>'
    + (stale ? '<span class="hb-stale-tag">archive &gt; 12 mo old</span>' : '');
  $historicalBanner.hidden = false;
}

// MASC + Sec-Twp Grid state. Tracks which muni's data is currently
// loaded into each source so a toggle off-then-on doesn't refetch and
// a muni-change can prompt a refetch when the layer is active.
let mascLoadedFor = null;
let surveyGridLoadedFor = null;
let cliLoadedFor = null;
// Land Cover overlay state. Tri-state cycle when the raster pyramid is
// available, dominant↔off when it isn't (probed once at boot):
//   null      → off
//   'dominant' → per-parcel fill (one colour per parcel = dominant bucket)
//   'detailed' → pixel-level raster overlay from build_landcover_tiles.R
// The fabric stamp scope is muni-scoped, so a muni change resets via the
// existing landCoverLoadedFor key (same pattern as CLI/MASC).
let landCoverMode = null;          // null | 'dominant' | 'detailed'
let landCoverLoadedFor = null;
let landCoverRasterAvailable = false; // set true after the manifest probe
let landCoverOpacity = 0.65;       // mirrors the layer's initial paint
// CLI tri-state cycle: null (off) → 'capability' → 'identity' → null.
// Cycle progression and button labels:
//   null       → "Soil Productivity/Soil Name" (idle invitation label)
//   capability → "Soil Productivity" (AGCAP_CLS1 1-7 + O + $ paint)
//   identity   → "Soil Type" (top-20-by-area soil-association palette,
//                recalculated for each selected municipality)
let cliMode = null;
// Centralized setter so every cliMode mutation broadcasts to map.js's
// popup builder. map.js's readOverlaysAt reads currentCliPaintMode to
// decide whether the muni-parcel popup should print the capability
// code or the soil-association name on the line under Total Value.
function setCliMode(value) {
  cliMode = value;
  setCliPaintMode(value);
  // Ensure the CLI + Soil Type results-grid columns are visible
  // whenever the CLI overlay is active (either capability or identity
  // mode). The user explicitly asked that those two columns light up
  // by default in the grid when Soil Productivity / Soil Type is on
  // — they're in DEFAULT_VISIBLE so first-time visitors already see
  // them, but a user who hid them via the Columns gear would expect
  // turning the overlay on to bring them back. No-op when the
  // columns are already visible (setColumnVisible is idempotent).
  if (value !== null) {
    setColumnVisible('clicls', true);
    setColumnVisible('soiltype', true);
    // Slope comes from the same stamped composition, so the overlay that
    // fills the other two fills this one — reveal it in step rather than
    // leaving a column the user has to hunt for in the gear.
    setColumnVisible('slope', true);
  }
}
// Last loaded CLI FC, kept so cycling between modes can re-rank the
// palette / re-stamp _paintColor without re-fetching.
let lastCliFc = EMPTY_FC;

/**
 * Categorical palette used by the CLI "Soil Type" mode to colour
 * polygons by SOIL_CODE1. Designed to read as distinct soil-TYPE
 * colours so the user sees Red River vs Osborne vs Scanterbury at
 * a glance, rather than the agricultural-capability scale (1=prime
 * → 7=no capability) which lives on the "Soil Productivity" mode.
 *
 * Cap of 20 colours: assigned to the top-20 soil associations by
 * area within the selected municipality's loaded FC. The palette
 * is computed PER MUNI — the 20 most common soils in St. Clements
 * get colours; the same SOIL_CODE1 in a different muni may map to
 * a different palette slot. Any soil outside the muni's top-20
 * falls through to SOIL_SURVEY_FALLBACK_COLOR (light grey), and
 * the legend appends an "Other soils" row when needed.
 *
 * Tableau-20 inspired, with the muddy greys removed so the fallback
 * grey stays unambiguous and the brown stays distinct from the
 * organic-soil chip colour used elsewhere.
 */
const SOIL_SURVEY_PALETTE = [
  '#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f',
  '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#7f7fbf',
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#bcbd22', '#17becf', '#aec7e8', '#98df8a', '#c5b0d5',
];
const SOIL_SURVEY_FALLBACK_COLOR = '#bfbfbf';

/**
 * Stamp `_paintColor` on every polygon in `fc` based on its
 * SOIL_CODE1's rank by total area within the loaded muni FC, then
 * update the named map fill layer's paint expression to read that
 * colour and re-render the supplied legend element with the top-N
 * soil names.
 *
 * Used by the CLI overlay's identity ("Soil Type") mode — the top-N
 * is computed PER MUNI off the same Soil_Survey_MB polygons the
 * capability mode paints, so each muni gets its own most-common-soils
 * palette rather than a global one.
 */
function applyIdentityPalette(fc, target) {
  const {
    fillLayerId,
    legendEl,
    legendTitle,
    legendSub = 'Coloured by dominant soil association',
  } = target;

  // 1. Tally area per SOIL_CODE1. Server-precomputed Shape__Area
  //    (uppercase in GeoJSON output) means we can skip the per-polygon
  //    turfArea calls that used to block the main thread for several
  //    seconds on a busy muni. Falls back to turfArea if Shape__Area
  //    is missing.
  const areaByCode = new Map();
  const nameByCode = new Map();
  for (const f of fc.features || []) {
    const code = f.properties?.SOIL_CODE1;
    if (!code) continue;
    const p = f.properties || {};
    const serverArea = Number(p.SHAPE__Area ?? p.Shape__Area ?? p.shape__Area);
    let a = Number.isFinite(serverArea) && serverArea > 0 ? serverArea : 0;
    if (a <= 0) {
      try { a = turfArea(f); } catch { /* skip topology errors */ }
    }
    if (!Number.isFinite(a) || a <= 0) continue;
    areaByCode.set(code, (areaByCode.get(code) || 0) + a);
    if (!nameByCode.has(code)) nameByCode.set(code, f.properties?.SOILNAME1 || code);
  }

  // 2. Rank top-N by area; assign palette in that order.
  const N = SOIL_SURVEY_PALETTE.length;
  const ranked = [...areaByCode.entries()].sort((a, b) => b[1] - a[1]).slice(0, N);
  const colorByCode = new Map();
  ranked.forEach(([code], i) => { colorByCode.set(code, SOIL_SURVEY_PALETTE[i]); });

  // 3. Stamp the resolved colour onto every polygon so the popup chip
  //    can match the map without map.js needing a copy of the palette.
  for (const f of fc.features || []) {
    const code = f.properties?.SOIL_CODE1;
    f.properties._paintColor = colorByCode.get(code) || SOIL_SURVEY_FALLBACK_COLOR;
  }

  // 4. Rebuild the named fill layer's paint to read the stamped colour.
  if (map.getLayer(fillLayerId)) {
    map.setPaintProperty(fillLayerId, 'fill-color', [
      'coalesce', ['get', '_paintColor'], SOIL_SURVEY_FALLBACK_COLOR,
    ]);
  }

  // 5. Render the legend (top-N soils + "Other" if anything fell off
  //    the bottom of the palette).
  renderIdentityLegend(legendEl, ranked, nameByCode, areaByCode.size > N, {
    title: legendTitle,
    sub: legendSub,
  });
}

function renderIdentityLegend(legendEl, ranked, nameByCode, hasOther, { title, sub }) {
  if (!legendEl) return;
  const lis = ranked.map(([code], i) => {
    const name  = nameByCode.get(code) || code;
    const color = SOIL_SURVEY_PALETTE[i];
    return `<li><span class="swatch" style="background:${color}"></span>${escapeHtmlText(name)}</li>`;
  });
  if (hasOther) {
    lis.push(`<li><span class="swatch" style="background:${SOIL_SURVEY_FALLBACK_COLOR}"></span>Other soils</li>`);
  }
  if (!lis.length) {
    lis.push('<li><em>No soil associations in this muni.</em></li>');
  }
  legendEl.innerHTML =
    `<strong>${escapeHtmlText(title)}</strong>` +
    `<div class="legend-sub">${escapeHtmlText(sub)}</div>` +
    `<ul>${lis.join('')}</ul>`;
}

// Local HTML-escape helper used by the legend builder. main.js doesn't
// import the one from map.js; cheap to duplicate.
function escapeHtmlText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Municipality scope for muni-wide overlays (the Assessment Parcels
 * fabric plus the agricultural layers). Sales imports and property-list
 * imports both span arbitrary municipalities while the main picker may be
 * blank; ordinary searches continue to use the picker. */
function scopedOverlayMunis() {
  const imported = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis
    : (listMatchedMunis && listMatchedMunis.length > 0 ? listMatchedMunis : null);
  return imported ? imported.slice() : ($municipality.value ? [$municipality.value] : []);
}

/** Enable/disable MASC and Sec-Twp Grid toggles based on whether a
 *  muni is selected, and clear stale data + active state if the muni
 *  changed since the layers were last loaded. Mirrors the
 *  resetMuniParcelsToggle pattern. */
function resetMascAndGridToggles() {
  // Enabled when the picker has a municipality or either import workflow
  // has retained the municipalities represented by its matched parcels.
  const scopedMunis = scopedOverlayMunis();
  const inScope = scopedMunis.length > 0;
  $mascToggle.disabled = !inScope;
  if ($cliToggle) $cliToggle.disabled = !inScope;
  // Sec-Twp Grid stays enabled with or without a muni — without a muni
  // selected it falls back to the pre-baked province-wide static file.
  $gridToggle.disabled = false;
  // The MASC + CLI overlays cache against a `loadKey` that is:
  //   - the joined+sorted list of matched munis in sales-CSV mode
  //   - the dropdown's single value in normal-search mode
  // So a dropdown change inside sales-CSV mode is a no-op for the
  // cache check (the multi-muni overlay stays loaded). Outside sales
  // mode, the dropdown value drives the key as before.
  const desiredOverlayKey = scopedMunis.join('|');
  if (mascLoadedFor && mascLoadedFor !== desiredOverlayKey) {
    mascLoadedFor = null;
    if ($mascToggle.classList.contains('active')) {
      setOverlayPressed($mascToggle, false);
      setOverlayBtnLabel($mascToggle, 'MASC rating');
      mapReady.then(() => {
        setMascVisible(map, false);
        if ($mascLegend) $mascLegend.hidden = true;
      });
    }
  }
  // CLI: same off-on-muni-change logic as MASC.
  if (cliLoadedFor && cliLoadedFor !== desiredOverlayKey) {
    cliLoadedFor = null;
    setCliMode(null);
    lastCliFc = EMPTY_FC;
    if ($cliToggle && $cliToggle.classList.contains('active')) {
      setOverlayPressed($cliToggle, false);
      setOverlayBtnLabel($cliToggle, cliButtonLabelFor(null));
      mapReady.then(() => {
        setCliAgrVisible(map, false);
        if ($cliLegend) $cliLegend.hidden = true;
      });
    }
  }
  // Land Cover: same off-on-muni-change logic as MASC/CLI. Both modes
  // reset together — the Dominant fill is muni-scoped (would otherwise
  // leave the previous muni's colours up), and Detailed is province-wide
  // but its label belongs to a stale active state on the button.
  if (landCoverLoadedFor && landCoverLoadedFor !== desiredOverlayKey) {
    landCoverLoadedFor = null;
    landCoverMode = null;
    if ($landcoverToggle && $landcoverToggle.classList.contains('active')) {
      setOverlayPressed($landcoverToggle, false);
      setOverlayBtnLabel($landcoverToggle, landCoverButtonLabelFor(null));
      mapReady.then(() => {
        setLandCoverVisible(map, false);
        setLandCoverRasterVisible(map, false);
        if ($landcoverLegend) $landcoverLegend.hidden = true;
      });
    }
  }
  // Survey grid: same cache key as Zoning / Dev Plan / MASC / CLI in
  // sales-CSV mode — the joined matched-muni list, or the dropdown's
  // value, or the __PROVINCE__ sentinel for "any muni" loads. A
  // dropdown change inside sales-CSV mode is a no-op so the multi-
  // muni grid stays loaded.
  const desiredKey = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.join('|')
    : ($municipality.value || '__PROVINCE__');
  if (surveyGridLoadedFor && surveyGridLoadedFor !== desiredKey) {
    surveyGridLoadedFor = null;
    surveyGridDataCache = null;
    // Reset the tri-state too — nextGridMode(null, …) returns 'section'
    // on the next click, the canonical "fresh start" entry point. Without
    // this, the post-muni-change re-toggle below would advance past
    // section into quarter (or off) and surprise the user.
    const wasMode = gridMode;
    gridMode = null;
    if ($gridToggle.classList.contains('active')) {
      // Flip active off, drop the stale layer, then re-toggle which
      // re-enters the active branch and runs the fetch path. Re-toggling
      // restores the previous mode (section / quarter) on the new muni
      // rather than dropping the user back to off.
      setOverlayPressed($gridToggle, false);
      setOverlayBtnLabel($gridToggle, gridButtonLabelFor(null));
      mapReady.then(() => {
        setSurveyGridVisible(map, false);
        toggleSurveyGridOverlay();
        // If they were in quarter mode before, advance once more so the
        // overlay lands in quarter mode for the new scope too.
        if (wasMode === 'quarter') toggleSurveyGridOverlay();
      });
    }
  }
}

/**
 * Toggle the MASC Soil layer. Lazy-loads the muni's MASC shard from
 * /data/masc/<MUNI>.json, builds quarter-section polygons via
 * masc.js's quartersToFc(), and pushes them onto the map's `masc`
 * source. The shard's per-muni cache is 30 days. Layer absence (a
 * muni with no MASC ratings — typically urban munis without crop
 * insurance) reverts the toggle and posts an explanatory count
 * message so the failure mode is informative, not silent.
 */
async function toggleMascOverlay() {
  // Import modes load MASC across every matched municipality. Ordinary
  // searches fall back to the picker. Import scopes are sorted when stored,
  // so the joined loadKey remains stable across repeated toggles.
  const munis = scopedOverlayMunis();
  if (munis.length === 0) {
    setOverlayPressed($mascToggle, false);
    return;
  }
  const loadKey = munis.join('|');
  const wasActive = $mascToggle.classList.contains('active');
  const visible = !wasActive;
  setOverlayPressed($mascToggle, visible);
  await mapReady;

  if (!visible) {
    setOverlayBtnLabel($mascToggle, 'MASC rating');
    setMascVisible(map, false);
    if ($mascLegend) $mascLegend.hidden = true;
    return;
  }

  if (mascLoadedFor !== loadKey) {
    $mascToggle.disabled = true;
    setOverlayBtnLabel($mascToggle, 'Loading…');
    try {
      // Quarter-section + river-lot ratings load in parallel. Quarter
      // sections are per-muni; river-lots are a single province-wide
      // FC filtered per muni client-side, so we only fetch them once
      // regardless of how many munis are in scope. Per-muni quarter
      // fetches run together via Promise.all + a single quartersFc at
      // the end.
      const riverlotsAllPromise = fetchMascRiverlots();
      const rowsArrays = await Promise.all(munis.map((m) => fetchMascRatingsForMuni(m)));
      const riverlotsAll = await riverlotsAllPromise;
      const allRows = rowsArrays.flat().filter(Boolean);
      // Per-muni filter on the global river-lot FC, deduped by the
      // feature's first-vertex coordinate string — adequate de-dupe
      // key since each river lot is a single polygon and the same
      // polygon shouldn't return twice across munis except in the
      // boundary-tagged-vs-actual case the filter helper handles.
      const allRiverlots = [];
      const seenRiverlots = new Set();
      for (const m of munis) {
        for (const f of filterMascRiverlotsForMuni(riverlotsAll?.features || [], m)) {
          const dedupeKey = JSON.stringify(f.geometry?.coordinates?.[0]?.[0] ?? f.properties?.OBJECTID ?? Math.random());
          if (seenRiverlots.has(dedupeKey)) continue;
          seenRiverlots.add(dedupeKey);
          allRiverlots.push(f);
        }
      }
      if (allRows.length === 0 && allRiverlots.length === 0) {
        setOverlayPressed($mascToggle, false);
        $mascToggle.disabled = false;
        setOverlayBtnLabel($mascToggle, 'MASC rating');
        const label = munis.length === 1 ? munis[0] : `${munis.length} matched munis (${munis.join(', ')})`;
        setCount(`No MASC ratings on file for ${label}.`);
        return;
      }
      setMascData(map, allRows.length > 0 ? quartersToFc(allRows) : { type: 'FeatureCollection', features: [] });
      setMascRiverlotsData(map, { type: 'FeatureCollection', features: allRiverlots });
      mascLoadedFor = loadKey;
    } catch (err) {
      console.warn('MASC fetch failed', err);
      setOverlayPressed($mascToggle, false);
      $mascToggle.disabled = false;
      setOverlayBtnLabel($mascToggle, 'MASC rating');
      setCount(`Failed to load MASC soil ratings: ${err.message}`);
      return;
    }
    $mascToggle.disabled = false;
  }
  setOverlayBtnLabel($mascToggle, 'MASC rating');
  setMascVisible(map, true);
  if ($mascLegend) $mascLegend.hidden = false;
  // No column plumbing here: MASC Rating and Risk Area are both stamped
  // during enrichment, so the gear alone decides whether they show.
}

/**
 * Toggle the Canada Land Inventory — Soil Capability for Agriculture
 * overlay. Live-fetched per-muni from AAFC's hosted FeatureServer
 * scoped by the cached muni boundary polygon. 30-day localStorage
 * cache means subsequent toggles for the same muni are instant.
 * Off-state hides the layer; on-state lazy-loads (if the muni
 * changed) and shows the legend.
 */
// Capability-mode paint expression + label expression for the CLI
// fill layer. Kept here as constants so the tri-state cycle can
// swap back to capability after the identity-mode paint mutation.
// Mirrors the initial paint set in map.js at layer-add time —
// keep both in sync if the palette changes.
const CLI_CAPABILITY_FILL_COLOR = [
  'match',
  ['slice', ['coalesce', ['get', 'AGCAP_CLS1'], '?'], 0, 1],
  '1', '#1a6b26',
  '2', '#4fab57',
  '3', '#a6e29f',
  '4', '#f2d640',
  '5', '#f4a040',
  '6', '#a8754f',
  '7', '#9c27b0',
  'O', '#5e3b1a',
  '$', '#cfd6dd',
  '#cccccc',
];
const CLI_CAPABILITY_LABEL_FIELD = ['coalesce', ['get', 'AGRI_CAP1'], ''];
const CLI_IDENTITY_LABEL_FIELD   = ['coalesce', ['get', 'MAPUNITNOM'], ''];

const CLI_CAPABILITY_LEGEND_HTML = (
  '<strong>Soil Productivity (CLI)</strong>' +
  '<div class="legend-sub">Manitoba Soil Survey · AGCAP_CLS1</div>' +
  '<ul>' +
    '<li><span class="swatch" style="background:#1a6b26"></span>1 — prime</li>' +
    '<li><span class="swatch" style="background:#4fab57"></span>2</li>' +
    '<li><span class="swatch" style="background:#a6e29f"></span>3</li>' +
    '<li><span class="swatch" style="background:#f2d640"></span>4</li>' +
    '<li><span class="swatch" style="background:#f4a040"></span>5</li>' +
    '<li><span class="swatch" style="background:#a8754f"></span>6</li>' +
    '<li><span class="swatch" style="background:#9c27b0"></span>7 — no agric.</li>' +
    '<li><span class="swatch" style="background:#5e3b1a"></span>O — organic</li>' +
    '<li><span class="swatch" style="background:#cfd6dd"></span>$ — urban / water</li>' +
  '</ul>'
);

function applyCliCapabilityMode() {
  if (map.getLayer('cli-agr-fill')) {
    map.setPaintProperty('cli-agr-fill', 'fill-color', CLI_CAPABILITY_FILL_COLOR);
  }
  if (map.getLayer('cli-agr-label')) {
    map.setLayoutProperty('cli-agr-label', 'text-field', CLI_CAPABILITY_LABEL_FIELD);
  }
  if ($cliLegend) $cliLegend.innerHTML = CLI_CAPABILITY_LEGEND_HTML;
}

function applyCliIdentityMode(cliFc) {
  // Top-N-by-area soil-association palette, recomputed against the
  // currently-loaded muni FC so each muni gets its own most-common
  // soils with distinct colours.
  applyIdentityPalette(cliFc, {
    fillLayerId: 'cli-agr-fill',
    legendEl: $cliLegend,
    legendTitle: 'Soil Type — top 20 in selected municipality',
    legendSub: 'Coloured by dominant soil association',
  });
  // applyIdentityPalette mutates `_paintColor` on the in-memory feature
  // properties and rewires the fill-color expression to `['get',
  // '_paintColor']`. MapLibre's GeoJSON source took a copy when
  // setCliAgrData ran at fetch time, so it doesn't see the post-hoc
  // mutation — we have to re-push the FC for the paint to find the
  // new field. Without this every polygon paints the fallback grey.
  setCliAgrData(map, cliFc);
  // Re-stamp parcel composition so the popup's per-soil swatches pick
  // up the freshly-assigned _paintColor. componentsForFeature reads
  // each polygon's _paintColor at rollup time, so a composition stamp
  // taken BEFORE the palette ran (e.g. during the first capability-mode
  // load) carries paintColor:null on every row and renders the popup
  // swatches grey. Re-stamping here pulls in the new colours so the
  // popup's left-side swatches match the legend / map polygons.
  restampSoilCompositionForActiveSources(cliFc);
  // Identity-mode labels show the soil-survey map-unit symbol (e.g.
  // "ALMv-S2") rather than the capability code ("2W"). MAPUNITNOM is
  // already on every feature.
  if (map.getLayer('cli-agr-label')) {
    map.setLayoutProperty('cli-agr-label', 'text-field', CLI_IDENTITY_LABEL_FIELD);
  }
}

/**
 * Re-stamp `_soilComposition` on every parcel source that's currently
 * loaded (search-result parcels in currentRows, plus the Roll Layer's
 * muni-parcels FC when it's loaded). Used whenever the CLI overlay's
 * paint mode swaps so the per-parcel composition rollup picks up the
 * fresh `_paintColor` that applyIdentityPalette stamped on the soil
 * polygons. Pushes the updated parcel sources back to the map so the
 * popup click handler reads the enriched properties.
 */
function restampSoilCompositionForActiveSources(soilFc) {
  if (!soilFc?.features?.length) return;
  if (currentRows.length > 0) {
    const parcelFc = { type: 'FeatureCollection', features: currentRows.map((r) => r.parcel) };
    stampSoilCompositionOnParcels(parcelFc, soilFc);
    setMapData(parcelFc, lastZoningFc || EMPTY_FC, lastDevPlanFc || EMPTY_FC, { fit: false });
    // Refresh the table so the CLI / Soil Type columns pick up the
    // newly-stamped composition.
    refreshResultsTableAfterCompositionStamp();
  }
  if (auxData.muniParcels?.features?.length) {
    stampSoilCompositionOnParcels(auxData.muniParcels, soilFc);
    mapReady.then(() => setMuniParcelsData(map, auxData.muniParcels));
  }
}

function nextCliMode(current) {
  if (current === null)         return 'capability';
  if (current === 'capability') return 'identity';
  return null; // identity → off
}

function cliButtonLabelFor(mode) {
  // Tri-state labels as cycled by toggleCliOverlay:
  //   off       → "Soil Productivity/Soil Name" (idle label inviting either mode)
  //   capability → "Soil Productivity" (1-7 + O + $ capability paint)
  //   identity   → "Soil Type" (top-20 soil-association palette)
  if (mode === 'capability') return 'Soil Productivity';
  if (mode === 'identity')   return 'Soil Type';
  return 'Soil Productivity/Soil Name';
}

/**
 * Fetch the soil-survey polygons that back BOTH the CLI overlay's paint
 * and the grid's CLI / Soil Type columns, for every municipality
 * currently in scope, and push them onto the map's CLI source.
 *
 * Returns the FC, or null when the load can't proceed — a missing muni
 * boundary, no polygons in scope, or a network failure. `onProblem`
 * receives a user-facing sentence in that case so each caller decides
 * where to put it (the toggle reverts its button; the preset just
 * annotates the count line).
 *
 * Cached against `cliLoadedFor`, so whichever entry point runs first
 * pays the fetch and the other is instant. It does NOT make the layer
 * visible — that's the toggle's business.
 */
async function loadSoilSurveyFcForScope(munis, { onProblem } = {}) {
  if (!munis?.length) return null;
  const loadKey = munis.join('|');
  if (cliLoadedFor === loadKey && lastCliFc?.features?.length) return lastCliFc;
  const report = (msg) => { if (onProblem) onProblem(msg); };

  const muniBoundaries = munis.map((m) => ({
    muni: m,
    feat: muniBoundariesFc?.features?.find(
      (f) => f.properties?.MUNI_LIST_NAME_WITH_TYPE === m,
    ) || null,
  }));
  const missing = muniBoundaries.filter((mb) => !mb.feat).map((mb) => mb.muni);
  if (missing.length > 0) {
    report(`Couldn't locate boundary for ${missing.join(', ')}; can't load CLI.`);
    return null;
  }

  let features;
  try {
    const fcs = await Promise.all(
      muniBoundaries.map((mb) => fetchCliAgrForMuni(mb.muni, mb.feat)),
    );
    features = fcs.flatMap((fc) => fc?.features || []);
  } catch (err) {
    console.warn('CLI fetch failed', err);
    report(`Failed to load CLI soil capability: ${err.message}`);
    return null;
  }
  if (features.length === 0) {
    const label = munis.length === 1
      ? munis[0]
      : `${munis.length} matched munis (${munis.join(', ')})`;
    report(`No CLI soil-capability polygons in ${label}.`);
    return null;
  }

  const cliFc = { type: 'FeatureCollection', features };
  await mapReady;
  setCliAgrData(map, cliFc);
  lastCliFc = cliFc;
  cliLoadedFor = loadKey;
  return cliFc;
}

/**
 * Run the parcel × soil-polygon join over `rows`, then re-push the map
 * source and re-render the grid so the CLI / Soil Type columns (and the
 * parcel popup) read the freshly-stamped `_soilComposition`.
 *
 * Awaits the join before re-rendering — the join runs in a worker, so
 * refreshing the table synchronously after kicking it off would re-render
 * the same empty cells and leave the columns looking broken until the
 * user happened to sort or page.
 *
 * Stamps the FULL row set (csvFullRows when a sales CSV is loaded) rather
 * than what's on screen, so clearing a filter later doesn't reveal blank
 * rows — same reasoning as backfillDevPlanColumns.
 */
async function stampSoilCompositionForRows(rows) {
  if (!rows?.length || !lastCliFc?.features?.length) return;
  const parcelFc = { type: 'FeatureCollection', features: rows.map((r) => r.parcel) };
  await stampSoilCompositionOnParcels(parcelFc, lastCliFc);
  if (currentRows.length > 0) {
    // Only the visible rows go back to the map source; the stamp above
    // covered the superset and both share the same parcel objects.
    const visibleFc = { type: 'FeatureCollection', features: currentRows.map((r) => r.parcel) };
    setMapData(visibleFc, lastZoningFc || EMPTY_FC, lastDevPlanFc || EMPTY_FC, { fit: false });
  }
  refreshResultsTableAfterCompositionStamp();
}

/**
 * Load whatever the Agricultural column preset shows but an ordinary
 * search doesn't already stamp. Two gaps, both between "the preset
 * revealed the columns" and "the columns have data in them":
 *
 *   1. CLI + Soil Type — need the soil-survey fetch + parcel join.
 *   2. Tile Drainage + Irrigation — need the WALLAS fetch + clip, which
 *      an ordinary search skips because it's 1.3 MB nobody asked for.
 *
 * MASC Rating, Risk Area and Land Cover need nothing here: all three are
 * stamped by normal enrichment.
 *
 * Deliberately does NOT paint the map: picking a column preset is a
 * request about the grid, not the map. The soil polygons still land in
 * the CLI source and cache under `cliLoadedFor`, and the WALLAS
 * collections are IDB-cached for a week, so later clicks on either
 * overlay render with no second fetch.
 *
 * The two halves are independent — a muni with no CLI coverage still
 * gets its water-rights columns, and vice versa.
 */
async function ensureAgriculturalGridData() {
  const rows = csvFullRows || currentRows;
  if (!rows?.length) return;
  const stamped = (key) => rows.every((r) => r?.parcel?.properties?.[key] !== undefined);
  // A stamped value of null still counts as done — it means "checked,
  // nothing here", which is exactly what the cells render.
  const munis = scopedOverlayMunis();
  // Soil needs a muni or import scope to fetch against; the overlay
  // button is disabled in that state too.
  const needsSoil = munis.length > 0 && !stamped('_soilComposition');
  const needsWater = !stamped('_tileDrainage') || !stamped('_irrigation');
  if (!needsSoil && !needsWater) return;

  // Restore whatever the count line said rather than assuming the sales
  // base message — this runs after plain searches and list imports too.
  const priorCount = $count.textContent;
  const withNote = (note) => setCount(`${priorCount || ''} · ${note}`.trim().replace(/^· /, ''));
  beginCliOp('Loading ag data…');
  try {
    if (needsSoil) {
      withNote('Loading soil survey…');
      const soilFc = await loadSoilSurveyFcForScope(munis, { onProblem: withNote });
      // A soil problem is already on the count line and mustn't abort the
      // water-rights half — the two datasets are unrelated.
      if (soilFc) {
        withNote('Matching soils to parcels…');
        await stampSoilCompositionForRows(rows);
      }
    }
    if (needsWater) {
      withNote('Checking water-rights licences…');
      // Both self-gate on waterRightsWantedForGrid, latched by the caller
      // before we got here. Concurrent: independent fetches + joins.
      await Promise.all([stampTileDrainage(rows), stampIrrigation(rows)]);
      // No dropSliverOnlyMatches here — that belongs to the tile-only /
      // irrigation-only search FILTERS. A column preset reveals data; it
      // must never silently remove comps from the grid.
      renderTable(currentRows, { resetPage: false });
    }
    setCount(priorCount);
  } catch (err) {
    console.warn('Agricultural preset data load failed', err);
    withNote(`Agricultural data failed to load: ${err.message}`);
  } finally {
    endCliOp();
  }
}

/**
 * Tri-state cycle:
 *   off  →  capability  →  identity  →  off  →  ...
 *
 * The capability mode is the original CLI behaviour (paint by the
 * AGCAP_CLS1 1-7 + organic + urban/water scale). The identity mode
 * paints by SOIL_CODE1 using the same top-N palette as the Soil
 * Survey overlay. Both come from the same fetched FC; switching
 * between them is a paint-expression + legend swap with no network
 * traffic, so the second click feels instant.
 */
async function toggleCliOverlay() {
  if (!$cliToggle) return;
  const munis = scopedOverlayMunis();
  if (munis.length === 0) {
    setCliMode(null);
    setOverlayPressed($cliToggle, false);
    return;
  }
  const loadKey = munis.join('|');
  const targetMode = nextCliMode(cliMode);
  await mapReady;

  // Off branch: hide layer + legend, clear active state, no fetch.
  if (targetMode === null) {
    setCliMode(null);
    setCliAgrVisible(map, false);
    if ($cliLegend) $cliLegend.hidden = true;
    setOverlayPressed($cliToggle, false);
    setOverlayBtnLabel($cliToggle, cliButtonLabelFor(null));
    return;
  }

  // First click after off (or after muni change) — make sure data is
  // loaded. Subsequent capability→identity transition reuses cached
  // FC, so this branch only runs once per muni. The Agricultural column
  // preset warms the same cache, so this is often already a no-op.
  if (cliLoadedFor !== loadKey) {
    $cliToggle.disabled = true;
    setOverlayBtnLabel($cliToggle, 'Loading…');
    let problem = null;
    const cliFc = await loadSoilSurveyFcForScope(munis, {
      onProblem: (msg) => { problem = msg; },
    });
    $cliToggle.disabled = false;
    if (!cliFc) {
      setCliMode(null);
      setOverlayPressed($cliToggle, false);
      setOverlayBtnLabel($cliToggle, cliButtonLabelFor(null));
      if (problem) setCount(problem);
      return;
    }
    const rows = csvFullRows || currentRows;
    if (rows.length > 0) {
      // Composition join stays off the paint path — the helper awaits the
      // worker, then re-pushes the source and re-renders the grid so the
      // CLI / Soil Type columns fill in when the join actually lands.
      beginCliOp('Composing…');
      stampSoilCompositionForRows(rows)
        .catch((err) => console.warn('soil composition stamp failed', err))
        .finally(endCliOp);
    }
  }

  // Apply the new mode. Paint + legend + label expression all swap
  // here; no source re-push needed.
  setCliMode(targetMode);
  if (targetMode === 'capability') {
    applyCliCapabilityMode();
  } else {
    applyCliIdentityMode(lastCliFc);
  }
  setCliAgrVisible(map, true);
  setOverlayPressed($cliToggle, true);
  setOverlayBtnLabel($cliToggle, cliButtonLabelFor(targetMode));
  if ($cliLegend) $cliLegend.hidden = false;
}

// Land Cover overlay tri-state cycle: off → Dominant → Detailed → off.
// (When the raster pyramid hasn't been built, Detailed is skipped and the
// cycle collapses to Dominant ↔ off. Probed once at boot — see
// probeLandCoverRaster below.)
//
//   Dominant — muni-scoped per-parcel fill, one colour per parcel (the
//              dominant bucket). Loads the whole municipal parcel fabric
//              and stamps every parcel from the land-cover shard, so ALL
//              parcels in the selected muni(s) colour (not just the
//              search results), gated to farmland over the threshold. Result-source
//              colouring (landcover-fill) also covers imported lists with
//              no single-muni scope.
//   Detailed — pixel-level mosaic from the static XYZ tile pyramid produced
//              by r/build_landcover_tiles.R. Shows what's ACTUALLY on the
//              ground (not the per-parcel headline). Pure visual layer —
//              no fetch on toggle, no muni dependency. Hides the Dominant
//              fill while on so the two don't compete; flipping back to
//              Dominant restores it without a refetch.
function nextLandCoverMode(current) {
  if (current === null)       return 'dominant';
  if (current === 'dominant') return landCoverRasterAvailable ? 'detailed' : null;
  return null; // 'detailed' → off
}

async function toggleLandCoverOverlay() {
  if (!$landcoverToggle) return;
  await mapReady;
  const targetMode = nextLandCoverMode(landCoverMode);

  // Off branch: hide everything, clear active state.
  if (targetMode === null) {
    landCoverMode = null;
    landCoverLoadedFor = null;
    setLandCoverVisible(map, false);
    setLandCoverRasterVisible(map, false);
    setOverlayPressed($landcoverToggle, false);
    setOverlayBtnLabel($landcoverToggle, landCoverButtonLabelFor(null));
    if ($landcoverLegend) $landcoverLegend.hidden = true;
    return;
  }

  // Dominant: load + stamp the muni-wide fabric if we haven't already
  // for this scope. Cheap re-entry path when cycling Detailed→Dominant.
  if (targetMode === 'dominant') {
    const munis = (csvMatchedMunis && csvMatchedMunis.length > 0)
      ? csvMatchedMunis.slice()
      : ($municipality.value ? [$municipality.value] : []);
    let fabricPainted = 0;

    // Only fetch / stamp if scope changed (or first turn-on). Detailed→
    // Dominant on the SAME scope skips this entirely.
    const scopeKey = muniParcelsLoadKey();
    const stampNeeded = munis.length > 0 && landCoverLoadedFor !== scopeKey;
    if (stampNeeded) {
      $landcoverToggle.disabled = true;
      setOverlayBtnLabel($landcoverToggle, 'Loading…');
      try {
        if (!auxData.muniParcels?.features?.length
            || muniParcelsLoadedFor !== scopeKey) {
          const fc = await fetchMuniParcelsForCurrentScope();
          await enrichFcWithLegals(fc).catch((err) => {
            console.warn('Legal enrichment for land-cover fabric failed (non-fatal):', err);
          });
          auxData.muniParcels = fc;
          auxLoaded.muniParcels = true;
          muniParcelsLoadedFor = scopeKey;
        }
        fabricPainted = await stampLandCoverOnFabric(auxData.muniParcels, munis);
        setMuniParcelsData(map, auxData.muniParcels);
        landCoverLoadedFor = scopeKey;
      } catch (err) {
        console.warn('Land Cover fabric load failed', err);
      } finally {
        $landcoverToggle.disabled = false;
      }
    } else if (munis.length > 0) {
      // Recount painted parcels on a no-fetch turn-on so the status line
      // is still accurate.
      fabricPainted = (auxData.muniParcels?.features || [])
        .filter((f) => f?.properties?._lcColor).length;
    }

    landCoverMode = 'dominant';
    setLandCoverVisible(map, true);
    setLandCoverRasterVisible(map, false);
    setOverlayPressed($landcoverToggle, true);
    setOverlayBtnLabel($landcoverToggle, landCoverButtonLabelFor('dominant'));
    setColumnVisible('landcover', true);
    setColumnVisible('cultpct', true);
    if ($landcoverLegend) { renderLandCoverLegend('dominant'); $landcoverLegend.hidden = false; }

    const resultPainted = (currentRows || []).filter((r) => r.parcel?.properties?._lcColor).length;
    if (munis.length) {
      const label = munis.length === 1 ? munis[0] : `${munis.length} municipalities`;
      const tail = landCoverRasterAvailable
        ? ' (click again for Detailed pixel view).'
        : '.';
      setCount(fabricPainted > 0
        ? `Land Cover on for ${label} — ${fabricPainted} parcel${fabricPainted === 1 ? '' : 's'} over ${LAND_COVER_MIN_ACRES} acres coloured by dominant land cover${tail}`
        : `Land Cover on for ${label} — no farmland parcels over ${LAND_COVER_MIN_ACRES} acres found to colour.`);
    } else if (resultPainted === 0) {
      setCount('Land Cover: select a municipality (or run/import a search with rural parcels) to load land cover.');
    }
    return;
  }

  // Detailed: pure visual swap — hide the per-parcel fill, show the
  // raster pyramid. No fetch, no muni dependency.
  landCoverMode = 'detailed';
  setLandCoverVisible(map, false);
  setLandCoverRasterVisible(map, true);
  setLandCoverRasterOpacity(map, landCoverOpacity);
  setOverlayPressed($landcoverToggle, true);
  setOverlayBtnLabel($landcoverToggle, landCoverButtonLabelFor('detailed'));
  if ($landcoverLegend) { renderLandCoverLegend('detailed'); $landcoverLegend.hidden = false; }
  setCount('Land Cover (Detailed) — pixel-level 2020 mosaic. Use the opacity slider in the legend to dial in vs the basemap.');
}

/**
 * Probe whether the Detailed raster pyramid has been built. Called once
 * during init — fetches the manifest written by r/build_landcover_tiles.R;
 * when present, the toggle's tri-state cycle includes Detailed, otherwise
 * it stays Dominant↔off. Non-fatal — a 404 just leaves the button in its
 * default 2-state mode.
 */
async function probeLandCoverRaster() {
  try {
    const url = `${MB_PARCEL_DATA_CDN}/landcover-tiles/manifest.json`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return;
    const manifest = await res.json();
    // Cheap sanity check — the manifest shape is small but a stray empty
    // file shouldn't flip the cycle on.
    if (manifest && Number.isFinite(manifest.minzoom) && Number.isFinite(manifest.maxzoom)) {
      landCoverRasterAvailable = true;
    }
  } catch {
    // Silent — the button degrades to dominant↔off without it.
  }
}
probeLandCoverRaster();

function landCoverButtonLabelFor(mode) {
  if (mode === 'dominant') return 'Land Cover (Dominant)';
  if (mode === 'detailed') return 'Land Cover (Detailed)';
  return 'Land Cover';
}

/** Stamp `_lcColor` (+ `_landCover`) on every fabric parcel from each muni's
 *  land-cover shard, matched by Muni_Name_With_Typ + Roll_No_Txt. Returns
 *  the count of parcels that got a colour (farmland over the threshold). */
async function stampLandCoverOnFabric(fabricFc, munis) {
  if (!fabricFc?.features?.length) return 0;
  const dicts = await Promise.all(
    munis.map((m) => fetchLandCoverForMuni(m).catch(() => null)),
  );
  const byMuni = new Map();
  munis.forEach((m, i) => { if (dicts[i]) byMuni.set(m, dicts[i]); });
  let painted = 0;
  for (const f of fabricFc.features) {
    const p = f.properties || (f.properties = {});
    const dict = p.Muni_Name_With_Typ ? byMuni.get(p.Muni_Name_With_Typ) : null;
    const hit = (dict && p.Roll_No_Txt) ? dict[p.Roll_No_Txt] : null;
    const color = hit ? dominantBucket(hit)?.color : null;
    if (color) {
      p._landCover = hit;
      p._lcColor = color;
      painted += 1;
    } else if (p._lcColor) {
      delete p._lcColor; // clear any stale colour from a prior scope
    }
  }
  return painted;
}

/** Render the Land Cover legend from the shared bucket palette so the map,
 *  popup, and legend colours can never drift. Mode-aware:
 *    'dominant' — notes the over-threshold fill scope.
 *    'detailed' — shows an opacity slider for the raster overlay. */
function renderLandCoverLegend(mode) {
  if (!$landcoverLegend) return;
  const items = LAND_COVER_BUCKETS
    .map((b) => `<li><span class="swatch" style="background:${b.color}"></span>${b.label}</li>`)
    .join('');
  const title = mode === 'detailed'
    ? 'Land cover (2020) · pixel-level'
    : 'Dominant land cover (2020)';
  const footnote = mode === 'detailed'
    ? '' // opacity slider replaces it
    : `<small style="display:block;margin-top:4px;color:#6b7280;font-style:italic">Farmland parcels over ${LAND_COVER_MIN_ACRES} acres · fill shows dominant cover only</small>`;
  const opacityCtl = mode === 'detailed'
    ? `<label class="landcover-opacity" style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;color:#374151">
         <span>Opacity</span>
         <input type="range" id="landcover-opacity-slider" min="20" max="100" step="5" value="${Math.round(landCoverOpacity * 100)}" style="flex:1">
         <span id="landcover-opacity-readout" style="font-variant-numeric:tabular-nums;min-width:32px;text-align:right">${Math.round(landCoverOpacity * 100)}%</span>
       </label>`
    : '';
  $landcoverLegend.innerHTML =
    `<strong>${title}</strong><ul>${items}</ul>${opacityCtl}${footnote}`;

  if (mode === 'detailed') {
    const slider = document.getElementById('landcover-opacity-slider');
    const readout = document.getElementById('landcover-opacity-readout');
    if (slider) {
      slider.addEventListener('input', () => {
        landCoverOpacity = Number(slider.value) / 100;
        setLandCoverRasterOpacity(map, landCoverOpacity);
        if (readout) readout.textContent = `${slider.value}%`;
      });
    }
  }
}

/**
 * Toggle the Sec-Twp Grid layer. Lazy-fetches the Manitoba Original
 * Survey FeatureServer scoped to the active muni's boundary polygon,
 * adapts the resulting points into the row shape sectionLinesFromRows
 * expects, and renders the section bounding boxes as a dashed-line
 * grid. Cached 30 days per-muni.
 */
// Survey-grid tri-state cycle. River lots ride along on both grid modes.
//   null    → off
//   section → section/township grid (1 line feature per 1-mile section).
//             Available with or without a muni — the province-wide fallback
//             is a pre-baked ~215k section bounding boxes.
//   quarter → quarter-section grid (4 line features per section — the
//             ~800m × 800m squares each rated quarter sits in). REQUIRES a
//             muni scope; the equivalent province-wide pyramid would be
//             ~860k features, too heavy for a client-side overlay.
let gridMode = null;
// Raw fetched data — cached so a mode swap on the same scope is a
// re-render rather than a re-fetch.
let surveyGridDataCache = null;

function nextGridMode(current, hasMuniScope) {
  if (current === null)     return 'section';
  if (current === 'section') return hasMuniScope ? 'quarter' : null;
  return null; // quarter → off
}

function gridButtonLabelFor(mode) {
  if (mode === 'section') return 'Section/township grid';
  if (mode === 'quarter') return 'Quarter section grid';
  return 'Section/township grid';
}

async function toggleSurveyGridOverlay() {
  // In sales-CSV mode load the grid for EVERY matched muni and merge.
  // Outside sales mode use the dropdown's single value (or the province-
  // wide fallback when nothing is selected).
  const munisFromCsv = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.slice()
    : null;
  const muni = $municipality.value;
  const munis = munisFromCsv || (muni ? [muni] : []);
  const hasMuniScope = munis.length > 0;
  const targetMode = nextGridMode(gridMode, hasMuniScope);
  await mapReady;

  // Off branch.
  if (targetMode === null) {
    gridMode = null;
    setSurveyGridVisible(map, false);
    setOverlayPressed($gridToggle, false);
    setOverlayBtnLabel($gridToggle, gridButtonLabelFor(null));
    return;
  }

  setOverlayPressed($gridToggle, true);

  // Cache key: joined muni list (sales-CSV mode), single muni (normal
  // mode with a muni selected), or '__PROVINCE__' (nothing selected,
  // province-wide fallback). Same shape as before — re-rendering between
  // section ↔ quarter on the same scope doesn't refetch.
  const loadKey = munis.length > 0 ? munis.join('|') : '__PROVINCE__';
  if (surveyGridLoadedFor !== loadKey) {
    $gridToggle.disabled = true;
    setOverlayBtnLabel($gridToggle, 'Loading…');
    try {
      if (munis.length === 0) {
        // No muni selected — load the pre-baked province-wide grid AND
        // the river-lots overlay as static files in parallel. Both are
        // cached in localStorage on first hit; subsequent toggles are
        // instant. River lots are optional — if the file is missing
        // we just render the section grid alone.
        const [gridFc, riverFc] = await Promise.all([
          fetchProvinceSectionGrid(),
          fetchRiverLots(),
        ]);
        surveyGridDataCache = {
          provinceSectionFc: gridFc,
          quarterRows: null,
          riverFeatures: riverFc?.features || [],
        };
      } else {
        // Resolve every muni's boundary feature up front. Any miss is
        // a hard error for that muni (we can't fetch a survey grid
        // without the polygon to scope the spatial query). Surface the
        // names so the user can act, rather than silently dropping a muni.
        const muniBoundaries = munis.map((m) => ({
          muni: m,
          feat: muniBoundariesFc?.features?.find(
            (f) => f.properties?.MUNI_LIST_NAME_WITH_TYPE === m,
          ) || null,
        }));
        const missing = muniBoundaries.filter((mb) => !mb.feat).map((mb) => mb.muni);
        if (missing.length > 0) {
          gridMode = null;
          setOverlayPressed($gridToggle, false);
          $gridToggle.disabled = false;
          setOverlayBtnLabel($gridToggle, gridButtonLabelFor(null));
          setCount(`Couldn't locate boundary for ${missing.join(', ')}; can't load the section-township grid.`);
          return;
        }
        // Per-muni quarter centroids in parallel + a single shared river-
        // lots fetch (province-wide, browser-cached after first hit).
        // Each muni's centroids feed both the section-bounding-box pass
        // and the quarter-line pass; rendering picks which to use.
        const [perMuniFcs, riverFc] = await Promise.all([
          Promise.all(muniBoundaries.map((mb) => fetchSurveyGridForMuni(mb.muni, mb.feat))),
          fetchRiverLots(),
        ]);
        const quarterRows = [];
        for (const fc of perMuniFcs) {
          quarterRows.push(...surveyFcToRows(fc || { features: [] }));
        }
        // River-lot filtering: keep features whose bbox intersects ANY
        // matched muni's bbox. Bbox checks are cheap; union semantics
        // keep parishes that straddle multiple munis in scope.
        const muniBboxes = muniBoundaries.map((mb) => bboxOfFeature(mb.feat));
        const riverInMunis = (riverFc?.features || []).filter((f) => {
          try {
            const fb = bboxOfFeature(f);
            return muniBboxes.some((mbBbox) => bboxesIntersect(mbBbox, fb));
          } catch {
            return false;
          }
        });
        surveyGridDataCache = {
          provinceSectionFc: null,
          quarterRows,
          riverFeatures: riverInMunis,
        };
      }
      surveyGridLoadedFor = loadKey;
    } catch (err) {
      console.warn('Sec-Twp Grid fetch failed', err);
      gridMode = null;
      setOverlayPressed($gridToggle, false);
      $gridToggle.disabled = false;
      setOverlayBtnLabel($gridToggle, gridButtonLabelFor(null));
      setCount(`Failed to load section-township grid: ${err.message}`);
      return;
    }
    $gridToggle.disabled = false;
  }

  // Render lines for the target mode + river lots, both pulled from the
  // cache so a mode swap is a cheap setData call.
  renderSurveyGridForMode(targetMode);
  gridMode = targetMode;
  setSurveyGridVisible(map, true);
  setOverlayBtnLabel($gridToggle, gridButtonLabelFor(targetMode));
}

/** Build the merged FC for the active grid mode (section bounding boxes
 *  vs quarter rectangles) plus river lots, then push it to the map. */
function renderSurveyGridForMode(mode) {
  if (!surveyGridDataCache) return;
  const { provinceSectionFc, quarterRows, riverFeatures } = surveyGridDataCache;
  let lineFeatures;
  if (mode === 'quarter' && Array.isArray(quarterRows)) {
    lineFeatures = quarterLinesFromRows(quarterRows).features;
  } else if (provinceSectionFc) {
    // Province-wide fallback: pre-baked section bounding boxes only;
    // quarter rendering needs the per-muni centroids that aren't fetched
    // here, so we always show sections in this branch.
    lineFeatures = provinceSectionFc.features || [];
  } else if (Array.isArray(quarterRows)) {
    lineFeatures = sectionLinesFromRows(quarterRows).features;
  } else {
    lineFeatures = [];
  }
  const merged = {
    type: 'FeatureCollection',
    features: [...lineFeatures, ...(riverFeatures || [])],
  };
  setSurveyGridData(map, dedupSectionLabels(merged));
}

/** Convert a MapLibre rendered Feature (which has lazily-evaluated
 *  geometry) into a plain GeoJSON Feature so polygonToEsriGeometry
 *  in arcgis.js can read its `coordinates`. */
function toGeoJsonFeature(f) {
  return {
    type: 'Feature',
    geometry: f.geometry,
    properties: f.properties || {},
  };
}

// ---------- Phase 6: vacant-land proxy thresholds ----------

const $vacantThreshold = document.getElementById('vacant-threshold');
const $vacantModePill  = document.querySelector('.vacant-mode-pill');

/**
 * Read the current vacant-land proxy threshold + mode from the
 * sidebar. The user picks one mode (% or $) and one value via
 * the pill toggle; the unselected dimension reads as null so the
 * filter ignores it.
 *
 * Defaults: 2% (matches the legacy hard-coded behaviour).
 */
function getVacancyThresholds() {
  const raw = $vacantThreshold?.value;
  const num = raw == null || raw === '' ? NaN : parseFloat(raw);
  const mode = $vacantModePill?.querySelector('.vacant-mode-btn.active')?.dataset.mode || 'pct';
  if (mode === 'dollar') {
    const max = Number.isFinite(num) && num >= 0 ? num : null;
    return { pctFraction: null, max };
  }
  let pct = Number.isFinite(num) ? num : 5;
  if (pct < 0) pct = 0;
  return { pctFraction: pct / 100, max: null };
}

// Wire the pill toggle so click flips the active segment, updates
// aria-pressed, and refreshes the vacancy roll-up.
if ($vacantModePill) {
  for (const btn of $vacantModePill.querySelectorAll('.vacant-mode-btn')) {
    btn.addEventListener('click', () => {
      for (const sib of $vacantModePill.querySelectorAll('.vacant-mode-btn')) {
        const on = sib === btn;
        setOverlayPressed(sib, on);
      }
      // Default the input to a sensible starting value when the
      // mode changes from one shape to the other.
      if ($vacantThreshold) {
        if (btn.dataset.mode === 'dollar' && (!$vacantThreshold.value || parseFloat($vacantThreshold.value) <= 10)) {
          $vacantThreshold.value = '20000';
        } else if (btn.dataset.mode === 'pct' && parseFloat($vacantThreshold.value) > 10) {
          $vacantThreshold.value = '5';
        }
      }
      refreshVacancyAndRefilter();
    });
  }
}

/**
 * Vacancy predicate using the live thresholds. Reads each parcel's
 * stamped `_asmtBuildings` / `_asmtTotal` and returns true / false
 * / null (null = no assessment data available).
 */
function parcelIsVacantDynamic(props) {
  const { pctFraction, max } = getVacancyThresholds();
  const buildings = Number(props?._asmtBuildings);
  const total = Number(props?._asmtTotal);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(buildings) || buildings < 0) return null;
  if ((buildings / total) < pctFraction) return true;
  if (max != null && buildings < max) return true;
  return false;
}

// Refresh group-vacancy roll-ups when the threshold inputs change,
// then refilter so the table + map update without needing a fresh
// CSV re-upload. No-op outside sales mode.
function refreshVacancyAndRefilter() {
  if (csvFullRows == null) return;
  const fc = { type: 'FeatureCollection', features: csvFullRows.map((r) => r.parcel) };
  computeSaleGroupTotals(fc);
  refilterCsvIfActive();
}

// Wire the threshold input. The mode-pill click handler already fires
// refreshVacancyAndRefilter directly (see the pill loop above), so we
// don't need a separate listener for it here. (Pre-refactor, this list
// referenced $vacantPct + $vacantMax — two separate inputs that were
// merged into a single $vacantThreshold + pill toggle. The stale names
// threw an uncaught ReferenceError that halted module init partway
// through, so every const declared later in the file landed in TDZ —
// notably SALE_DATE_RE at line 5708, which silently broke the
// Sale-Date range filter.)
for (const el of [$vacantThreshold].filter(Boolean)) {
  el.addEventListener('input', refreshVacancyAndRefilter);
  el.addEventListener('change', refreshVacancyAndRefilter);
}

// ---------- Phase 5: selected-parcel summary card ----------

/**
 * Track the row that's currently shown in the parcel-summary card.
 * Lets "Export selected" build a one-row CSV without having to walk
 * the DOM. Null when no card is showing.
 */
let selectedParcelRow = null;

const $parcelSummary = document.getElementById('parcel-summary');
const $psRoll        = document.getElementById('ps-roll');
const $psAddress     = document.getElementById('ps-address');
const $psMuni        = document.getElementById('ps-muni');
const $psAcres       = document.getElementById('ps-acres');
const $psAsmt        = document.getElementById('ps-asmt');
const $psZoning      = document.getElementById('ps-zoning');
const $psDevplan     = document.getElementById('ps-devplan');
const $psTitle       = document.getElementById('ps-title');
const $psN1          = document.getElementById('ps-n1');
const $psN1Row       = document.getElementById('ps-n1-row');
const $psOpenMao     = document.getElementById('ps-open-mao');
const $psOpenMuni    = document.getElementById('ps-open-muni');
const $psCopySource  = document.getElementById('ps-copy-source');
const $psExportSel   = document.getElementById('ps-export-selected');
const $psClose       = document.getElementById('ps-close');
const $psVerify      = document.getElementById('ps-verify');
const $psVerifyList  = document.getElementById('ps-verify-list');

// Phase 6 verify-this state. Keyed by `muni|roll` so the same
// parcel restores its ticks across visits. Persisted to
// localStorage so the user's review progress survives refreshes.
const VERIFY_STORAGE_KEY = 'mbps_verify_state_v1';
function loadVerifyState() {
  try { return JSON.parse(localStorage.getItem(VERIFY_STORAGE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function saveVerifyState(state) {
  try { localStorage.setItem(VERIFY_STORAGE_KEY, JSON.stringify(state)); } catch {}
}
function verifyKeyForParcel(p) {
  const muni = muniNoFromProps(p);
  const roll = p?.Roll_No_Txt;
  if (muni == null || !roll) return null;
  return `${muni}|${roll}`;
}
function populateVerifyChecklist(p) {
  if (!$psVerifyList) return;
  const key = verifyKeyForParcel(p);
  const state = loadVerifyState();
  const parcelState = (key && state[key]) || {};
  for (const cb of $psVerifyList.querySelectorAll('input[type="checkbox"]')) {
    cb.checked = !!parcelState[cb.dataset.key];
    cb.disabled = !key;
  }
}
if ($psVerifyList) {
  $psVerifyList.addEventListener('change', (e) => {
    const cb = e.target;
    if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox') return;
    if (!selectedParcelRow) return;
    const key = verifyKeyForParcel(selectedParcelRow.parcel?.properties || {});
    if (!key) return;
    const state = loadVerifyState();
    const parcelState = state[key] || {};
    parcelState[cb.dataset.key] = cb.checked;
    state[key] = parcelState;
    saveVerifyState(state);
  });
}

function clearSelectedParcel() {
  selectedParcelRow = null;
  if ($parcelSummary) $parcelSummary.hidden = true;
}

function populateSelectedParcel(row) {
  if (!$parcelSummary) return;
  selectedParcelRow = row;
  const p = row?.parcel?.properties || {};
  const z1 = row?.zoning?.[0]?.feature?.properties || {};
  const z1Ratio = row?.zoning?.[0]?.ratio;
  const z2 = row?.zoning?.[1]?.feature?.properties || {};
  const z2Ratio = row?.zoning?.[1]?.ratio;
  const d1 = row?.devPlan?.[0]?.feature?.properties || {};
  const ac = parcelAcres(row?.parcel);

  if ($psRoll) $psRoll.textContent = p.Roll_No_Txt ? `Roll # ${p.Roll_No_Txt}` : 'Selected parcel';
  if ($psAddress) $psAddress.textContent = p.Property_Address || '—';
  if ($psMuni) $psMuni.textContent = p.Muni_Name_With_Typ || '—';
  if ($psAcres) $psAcres.textContent = (() => {
    const a = formatAcres(ac);
    return a ? `${a} ac` : '—';
  })();
  if ($psAsmt) {
    const total = parseTotalValue(p.Total_Value);
    $psAsmt.textContent = fmtCurrency(total) || '—';
  }
  if ($psZoning) {
    const z1Code = formatZoneCode(z1);
    const z2Code = formatZoneCode(z2);
    const parts = [];
    if (z1Code) {
      const pct = z1Ratio != null ? ` (${Math.round(z1Ratio * 100)}%)` : '';
      parts.push(`${z1Code}${pct}`);
    }
    if (z2Code && z2Ratio != null && z2Ratio >= 0.01) {
      parts.push(`${z2Code} (${Math.round(z2Ratio * 100)}%)`);
    }
    $psZoning.textContent = parts.length ? parts.join(' · ') : '—';
  }
  if ($psDevplan) {
    const des = formatDes(d1);
    $psDevplan.textContent = des || '—';
  }
  if ($psTitle) $psTitle.textContent = p._certificatesOfTitle || '—';
  // N1 ID — present only on sales rows that the crosswalk has matched, so the
  // whole row comes and goes rather than sitting empty. See the markup note.
  if ($psN1Row) {
    const n1 = p._n1Id || '';
    $psN1Row.hidden = !n1;
    if ($psN1) $psN1.textContent = n1 || '—';
  }

  // Action targets.
  if ($psOpenMao) {
    if (p.Asmt_Rpt_Url) {
      $psOpenMao.href = p.Asmt_Rpt_Url;
      $psOpenMao.hidden = false;
    } else {
      $psOpenMao.hidden = true;
    }
  }
  if ($psOpenMuni) {
    const url = lookupMuniWebsite(p.Muni_Name_With_Typ);
    if (url) {
      $psOpenMuni.href = url;
      $psOpenMuni.hidden = false;
    } else {
      $psOpenMuni.hidden = true;
    }
  }
  // Phase 6 verify-this state: restore the user's prior ticks for
  // this parcel from localStorage, keyed by muni|roll.
  populateVerifyChecklist(p);

  $parcelSummary.hidden = false;
}

if ($psClose) $psClose.addEventListener('click', clearSelectedParcel);
if ($psExportSel) {
  $psExportSel.addEventListener('click', () => {
    if (!selectedParcelRow) return;
    exportCsv([selectedParcelRow]);
  });
}
if ($psCopySource) {
  // Phase 6 wires the real source-note builder. For now we surface
  // a basic citation so the button is functional rather than dead.
  $psCopySource.addEventListener('click', async () => {
    if (!selectedParcelRow) return;
    const p = selectedParcelRow.parcel?.properties || {};
    const note = `Parcel data reviewed using Manitoba Open Data (Roll Entry, Zoning By-Laws, Development Plan Designations) on ${today()}. Roll #${p.Roll_No_Txt || '—'}, ${p.Muni_Name_With_Typ || '—'}. Zoning and development plan designations were matched by spatial overlap and should be verified with the applicable municipality, planning district, or Manitoba Assessment Online.`;
    try {
      await navigator.clipboard.writeText(note);
      const prev = $psCopySource.textContent;
      $psCopySource.textContent = 'Copied';
      setTimeout(() => { $psCopySource.textContent = prev; }, 1500);
    } catch (err) {
      console.warn('Copy source note failed', err);
    }
  });
}

/**
 * Set the visible text of an overlay toggle button without nuking
 * the coloured dot or any other inner markup. The Phase 3 markup
 * wraps the label in `<span class="overlay-btn-label">`; if that
 * span exists, write to it. Falls back to plain textContent for
 * buttons that don't follow the convention (defensive, shouldn't
 * happen in current markup).
 */
function setOverlayBtnLabel(btn, text) {
  if (!btn) return;
  const label = btn.querySelector(':scope > .overlay-btn-label');
  if (label) {
    label.textContent = text;
  } else {
    btn.textContent = text;
  }
}

async function toggleAuxOverlay(which) {
  const meta = AUX_META[which];
  const btn = meta.btn();
  const wasActive = btn.classList.contains('active');
  const visible = !wasActive;
  setOverlayPressed(btn, visible);
  setOverlayBtnLabel(btn, visible ? meta.on : meta.off);
  await mapReady;
  if (visible && !auxLoaded[which]) {
    btn.disabled = true;
    setOverlayBtnLabel(btn, meta.busy);
    try {
      const fc = await meta.fetch();
      auxData[which] = fc;
      // muni-parcels: enrich each parcel with its legal-index record
      // BEFORE pushing to the map, so the hover/click popup on the
      // Roll Layer can show the legal description without doing a
      // per-popup async lookup. Cheap: the legal index is already
      // module-cached via warmLegalIndex(); the lookup is one Map
      // build + N gets.
      if (which === 'muniParcels') {
        await enrichFcWithLegals(fc).catch((err) => {
          console.warn('Legal enrichment for muni-parcels failed (non-fatal):', err);
        });
      }
      meta.setData(map, fc);
      auxLoaded[which] = true;
      if (which === 'muniParcels') muniParcelsLoadedFor = muniParcelsLoadKey();
    } catch (err) {
      console.warn(`${which} fetch failed`, err);
      setOverlayPressed(btn, false);
      setOverlayBtnLabel(btn, meta.off);
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    setOverlayBtnLabel(btn, meta.on);
  }
  meta.setVis(map, visible);
  // The AADT-colour legend rides along with the Flow toggle so the user
  // can read what each segment colour means. Only one place toggles it.
  if (which === 'flow' && $flowLegend) $flowLegend.hidden = !visible;
}

// ---------- UI helpers ----------

// Phase 7: status messages mirror to the new results-status bar
// above the table so the user sees search progress next to the
// table even when the sidebar has scrolled off-screen. Lookup is
// lazy inside the call rather than module-scope const so setCount
// (a hoisted function declaration) can be invoked from any code
// path during module init without a TDZ error — the const form
// of the same lookup tripped TDZ when setCount was reached before
// its declaration line during sales upload boot-strapping.
function setCount(text) {
  $count.textContent = text;
  const el = document.getElementById('results-status');
  if (el) {
    const trimmed = (text ?? '').trim();
    el.textContent = trimmed;
    el.hidden = trimmed === '';
    const looksLikeError = /failed|error|rate-limit|couldn't|no parcels|no usable|no matching/i.test(trimmed);
    el.classList.toggle('results-status-error', looksLikeError);
  }
}
function setBusy(busy) {
  $search.disabled = busy;
  $search.textContent = busy ? 'Searching…' : 'Search';
}

/** Hard-reset the page. A full reload + cache clear guarantees every
 *  piece of state — inputs, table, sort, map zoom, overlay toggles,
 *  in-flight requests, AND every cached overlay/dropdown — goes back
 *  to first-load. Walks every storage type the app touches: IDB
 *  (current primary), localStorage (fallback + legacy), and
 *  sessionStorage (older builds). The IDB pass is best-effort and
 *  intentionally doesn't block the reload — the page is going away
 *  anyway, and IDB wipes complete in the background. */
function clearAll() {
  // Fire-and-forget IDB clear. clearAllCache is async; we don't await
  // because the page reload below will tear down the IDB connection
  // gracefully and any in-flight delete completes server-side.
  try { clearAllCacheModule().catch(() => {}); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* private mode quota errors etc. */ }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('mbpsCache.')) localStorage.removeItem(k);
    }
  } catch { /* private mode etc. */ }
  // Reload onto the clean path with NO query string + NO hash. Earlier
  // versions appended `window.location.search`, which carried the
  // encoded URL-state params (muni, roll, address, vacant-threshold,
  // etc.) into the reload — `applyUrlStateToInputs(initialUrlState)`
  // then re-populated every form field at boot, so the page came back
  // looking like the search had just been re-run. The user's complaint
  // was exactly this: Clear didn't actually clear.
  //
  // The ONE thing carried over is which tab you were on. Clear empties the
  // work; it is not a request to be moved to a different part of the app,
  // and landing back on Property Search after clearing a sales set meant
  // navigating back every time. `t` is the URL-state schema's own tab
  // param, so this reuses the existing round-trip rather than inventing a
  // second mechanism.
  const tab = getActiveTab() === 'sales' ? '?t=sales' : '';
  window.location.href = window.location.pathname + tab;
}

function clearTable() {
  $tbody.innerHTML = '';
  currentRows = [];
  setExportEnabled(false);
}

/**
 * Drop the loaded sales result set — table, map and the filter option lists
 * derived from it — WITHOUT touching the sales-database panel's municipality
 * selection or any sidebar filter the user typed.
 *
 * Exists because a sales-database Search had no way to fail loudly. Every
 * early exit on that path — the date/type window excluding every sale, a CSV
 * that parsed to no usable rows, a thrown lookup — just set a status line and
 * returned, leaving the PREVIOUS search's rows sitting on the table and the
 * map. Switching Sale type from ICI to Residential bare land and hitting
 * Search therefore looked like the button had done nothing, when in fact it
 * had run and found nothing to show (Jason, 2026-08-19).
 *
 * Called at the start of every sales-DB search rather than only on the empty
 * paths, so no future early return can reintroduce the same class of bug.
 * Deliberately NOT a Clear: the selection is what the user is iterating on.
 */
function clearSalesResults() {
  clearTable();
  clearStaticMap();
  csvFullRows = null;
  csvFullBaseMsg = '';
  csvMatchedMunis = null;
  // These lists were derived from the results just dropped, so leaving them
  // up would offer zone codes and structure types nothing can match. Same
  // reasoning — and the same three calls — as runSearch's reset.
  zoningFilter.setOptions([]);
  zoneCatFilter.setOptions([]);
  primaryPropFilter.setGroups([]);
  resetWaterFilterBase();
  renderUnmatchedPanel([]);
  setMapData(EMPTY_FC, EMPTY_FC, EMPTY_FC, { fit: false });
}

// $paginator + PAGE_SIZE + currentPage all live near the top of the
// module so renderTable / paginator helpers can read them without
// hitting TDZ during early code paths (sales-CSV upload via the
// recent-uploads dropdown, etc).

function renderTable(rows, { resetPage = true } = {}) {
  $tbody.innerHTML = '';
  // Reveal the two water-rights columns exactly while a WALLAS overlay
  // (or one of its search filters) is active — same mode-class pattern
  // the MASC Risk Area column uses. Re-evaluated on every render so the
  // columns appear and disappear with the toggles.
  if ($resultsTable) $resultsTable.classList.toggle('water-mode', wantsWaterRightsEnrichment());
  currentRows = rows;
  rowFeatureMap.clear();
  if (resetPage) currentPage = 0;
  const sorted = sortRows(rows);
  // Clamp currentPage in case the row set shrank below it (filter
  // change, sales-CSV reload, etc).
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  if (currentPage >= pageCount) currentPage = pageCount - 1;
  if (currentPage < 0) currentPage = 0;
  const pageStart = currentPage * PAGE_SIZE;
  const pageEnd   = Math.min(pageStart + PAGE_SIZE, sorted.length);
  const pageRows  = sorted.slice(pageStart, pageEnd);
  // Stamp far-flung reasons across the FULL sorted set (not the page
  // slice) so the map popups match the grid and the sidebar tally
  // doesn't change as the user pages.
  applyFarFlungFlags(sorted);
  // Outlier detection on $/Acre — compute mean + σ across the FULL
  // sorted set (not the page slice) so thresholds don't shift as the
  // user pages. Quietly skips when fewer than 3 rows have a real
  // $/Acre value (too few for a meaningful σ). The .outlier class
  // adds a subtle background so the appraiser can spot likely
  // outliers at a glance without it dominating the table.
  const outlierThresholds = computePpaOutlierThresholds(sorted);
  const frag = document.createDocumentFragment();
  for (let pageIdx = 0; pageIdx < pageRows.length; pageIdx++) {
    const row = pageRows[pageIdx];
    const p = row.parcel.properties || {};
    const tr = document.createElement('tr');
    if (p._rowKey != null) {
      tr.dataset.rowKey = String(p._rowKey);
      if (row.parcel.geometry) rowFeatureMap.set(String(p._rowKey), row.parcel);
    }
    // Multi-parcel sale grouping. When a sale group has more than one
    // parcel AND the sibling rows happen to be adjacent in the
    // current sort order, mark first/middle/last/solo so the table
    // can connect them visually (left stripe + tint). Solo means the
    // group has >1 parcel but the row's adjacent neighbours are
    // different sales — still part of a group, but not adjacent.
    const gid = p._saleGroupId;
    const gsize = Number(p._saleGroupSize) || 0;
    if (gid != null && gsize > 1) {
      const prevGid = pageIdx > 0 ? pageRows[pageIdx - 1].parcel.properties?._saleGroupId : null;
      const nextGid = pageIdx < pageRows.length - 1 ? pageRows[pageIdx + 1].parcel.properties?._saleGroupId : null;
      tr.dataset.groupPos = groupPosition(prevGid, gid, nextGid);
      tr.dataset.groupSize = String(gsize);
      // Tooltip hint when the row has unique sibling info.
      if (!tr.title && Array.isArray(p._saleGroupRolls) && p._saleGroupRolls.length > 1) {
        tr.title = `Part of a ${gsize}-parcel sale (rolls: ${p._saleGroupRolls.join(', ')})`;
      }
    }
    // Outlier tag — only fires in sales-mode and only on rows whose
    // $/Acre exists. CSS rules in style.css gate visibility on
    // body.sales-mode so non-sales searches don't get flagged.
    if (outlierThresholds && p._saleGroupPpa != null) {
      const ppa = Number(p._saleGroupPpa);
      if (Number.isFinite(ppa) && (ppa < outlierThresholds.lo || ppa > outlierThresholds.hi)) {
        tr.classList.add('outlier');
        tr.title = `Outlier: $/Acre ${fmtCurrency(ppa)} is more than 2σ from the filtered mean ${fmtCurrency(outlierThresholds.mean)}`;
      }
    }
    // Starred row shading. The row click handler keeps the in-memory
    // Set in sync; this branch pre-applies the class at render time
    // so an upload-with-existing-favourites (page reloaded, CSV
    // re-uploaded) lights up its starred rows immediately. The map
    // feature-state is re-applied by applyStarredFromFavorites after
    // the FC reaches the source.
    const favKey = parcelLegalKey(p);
    if (favKey && favoriteKeys.has(favKey)) tr.classList.add('starred');
    tr.classList.add('clickable');
    if (!tr.title) tr.title = 'Click to zoom map to this parcel';
    tr.addEventListener('click', () => {
      const f = rowFeatureMap.get(tr.dataset.rowKey);
      if (!f) return;
      // Phase 5: populate the parcel summary card above the table so
      // the user sees the full attribute payload without having to
      // scroll the wide row.
      populateSelectedParcel(row);
      mapReady.then(() => {
        flyToFeature(map, f);
        // Scroll the map back into view so the user actually sees the
        // parcel they clicked. Without this, large result sets push
        // the table well below the map and flyToFeature animates
        // off-screen. block:'start' aligns the top of the map with
        // the top of the viewport; smooth keeps it from being jarring.
        const mapEl = document.getElementById('map');
        if (mapEl) mapEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    const z1 = row.zoning[0]?.feature.properties || {};
    const z2 = row.zoning[1]?.feature.properties || {};
    const d1 = row.devPlan[0]?.feature.properties || {};
    const ac = parcelAcres(row.parcel);
    // Size columns follow the sale, not the current parcel; `ac` stays today's
    // figure for the polygon-sampled columns further down (land cover,
    // cultivation, soil), which measure the shape that is actually there.
    const acSize = rowSizeAcres(p, ac);

    // Zoning 2 only shown when its coverage is ≥ ZONE2_MIN_RATIO —
    // sub-1% slivers are usually GIS noise (boundary digitization
    // slop) and clutter the table. The zoning-code FILTER applies the
    // same gate; if either side changes threshold, change the shared
    // constant so the screen and the filter can never disagree.
    const z2ratio = row.zoning[1]?.ratio;
    const z2Show = Number.isFinite(z2ratio) && z2ratio >= ZONE2_MIN_RATIO;

    // Favourites star — sales-only column. The cell is always emitted
    // (so the table column count stays stable across modes); the CSS
    // .sales-only class hides it outside sales-mode. Click toggles
    // the in-memory Set + persists to localStorage; the cell's
    // appearance flips immediately via the class swap.
    // Map # — the leftmost callout number, hidden by CSS unless
    // #results carries .numbering-on. Must stay the FIRST cell so it
    // lines up with the first <th> (columns.js matches columns by
    // position).
    const seqCellEl = td(p._seq != null ? String(p._seq) : null, 'num');
    seqCellEl.classList.add('seq-col');
    tr.appendChild(seqCellEl);
    tr.appendChild(favoriteCell(row));
    tr.appendChild(rollNumberCell(p));
    // Muni code (the integer authority prefix in Municipality, e.g.
    // 600 for "600 - RM OF HEADINGLEY"). Useful for joining external
    // spreadsheets keyed by muni_no without re-parsing the
    // human-readable name.
    const muniNo = muniNoFromProps(p);
    tr.appendChild(td(muniNo != null ? String(muniNo) : null, 'num'));
    // Municipality name — positional, in step with the data-col="muniname"
    // <th> right after Muni #.
    tr.appendChild(td(muniNameFromProps(p)));
    // Sale Date / Sale Price cells — always emitted, hidden by CSS
    // unless #results carries the sales-mode class (toggled by
    // handleSalesUpload). Lets the columns appear/disappear without
    // re-renders when the user uploads a CSV.
    const saleDateCell = td(p._saleDate || null);
    saleDateCell.classList.add('sales-only');
    // Repeat sale — this parcel transacted more than once in the upload
    // and so occupies more than one row. Without a marker the rows read
    // as an accidental duplicate rather than a second transaction of the
    // same land, which is exactly the comparison an appraiser wants.
    const saleCount = Number(p._saleCount);
    if (Number.isFinite(saleCount) && saleCount > 1) {
      const badge = document.createElement('span');
      badge.className = 'repeat-sale-badge';
      badge.textContent = `${Number(p._saleSeq ?? 0) + 1}/${saleCount}`;
      badge.title = `Sale ${Number(p._saleSeq ?? 0) + 1} of ${saleCount} for this parcel `
                  + '(most recent first)';
      saleDateCell.appendChild(document.createTextNode(' '));
      saleDateCell.appendChild(badge);
    }
    tr.appendChild(saleDateCell);
    const salePriceCell = td(p._salePrice || null);
    salePriceCell.classList.add('sales-only', 'num');
    tr.appendChild(salePriceCell);
    // Sale Type Group — MAO's category for the sale. Must stay positionally
    // in step with its th (between Sale Price and Primary Property): the
    // visibility pass matches tds to ths by index, not by name.
    const saleTypeCell = td(p._saleTypeGroup || null);
    saleTypeCell.classList.add('sales-only');
    tr.appendChild(saleTypeCell);
    // Primary Property. Positional, like every other cell here — the tds
    // carry no data-col of their own, so this must stay in step with the
    // <th> order in index.html.
    const primaryPropCell = td(p._primaryProperty || null);
    primaryPropCell.classList.add('sales-only');
    tr.appendChild(primaryPropCell);
    // N1 ID — positional like every cell here; must stay in step with the
    // data-col="n1id" <th> right after Primary Property.
    const n1IdCell = td(p._n1Id || null, 'num');
    n1IdCell.classList.add('sales-only');
    tr.appendChild(n1IdCell);
    // Multi-parcel-sale group columns. Identical for every parcel
    // in the same sale. Empty (single-cell dash) for non-grouped
    // single-parcel sales / no-sale rows.
    const groupSize = Number(p._saleGroupSize);
    const groupSizeCell = td(
      Number.isFinite(groupSize) && groupSize > 0 ? String(groupSize) : null,
      'num',
    );
    groupSizeCell.classList.add('sales-only');
    tr.appendChild(groupSizeCell);
    // NOTE: $/Lot is NOT emitted here any more — it moved down to close
    // the rate group after $/SF. The thead order changed to match.
    // Address + Zoning right after $/Lot so the appraiser sees
    // identifying info before the wide numeric block. These cells
    // are emitted in every mode (no sales-only class); the table's
    // thead order matches.
    tr.appendChild(td(p.Property_Address));
    tr.appendChild(td(badge(formatZoneCode(z1), 'badge-zone')));
    // Zoning Type. Blank rather than "(no category)" when there is no
    // zoning join at all — an empty cell reads as "not loaded", which is
    // the truth, whereas the label would assert the polygon was checked
    // and found blank. The filter still treats the two alike.
    tr.appendChild(td(row.zoning.length ? zoneCategoryLabel(z1.ZONE_CATEGORY) : null));
    // Sales-mode position for the Acres column. The basic-mode
    // Acres cell below carries the same value but with .basic-only
    // so only one is visible at a time.
    const rollSizeSalesCell = td(formatRollSize(p), 'num');
    rollSizeSalesCell.classList.add('sales-only');
    tr.appendChild(rollSizeSalesCell);
    const acresSalesCell = td(formatAcres(acSize), 'num');
    acresSalesCell.classList.add('sales-only');
    markAreaCheck(acresSalesCell, p);
    tr.appendChild(acresSalesCell);
    // Group Acres sits between Acres and $/Acre: per-parcel size, then the
    // sale's total, then the rate that divides by it. Reading left to right
    // now shows where the rate comes from.
    const groupAcresCell = td(formatGroupAcres(p), 'num');
    groupAcresCell.classList.add('sales-only');
    // Mark the total when it differs from this parcel's own acreage, i.e. the
    // sale bought more land than the row describes. That is the whole reason
    // the column exists, and it is invisible on a row-by-row read otherwise.
    if (Number.isFinite(groupSize) && groupSize > 1) groupAcresCell.classList.add('group-total');
    tr.appendChild(groupAcresCell);
    // Group SF — same total, square feet. Positional like every cell here;
    // must stay in step with the data-col="groupsf" <th> between Group Acres
    // and $/Acre.
    const groupSfCell = td(formatGroupSf(p), 'num');
    groupSfCell.classList.add('sales-only');
    if (Number.isFinite(groupSize) && groupSize > 1) groupSfCell.classList.add('group-total');
    tr.appendChild(groupSfCell);
    const ppaCell = td(formatGroupPpa(p), 'num');
    ppaCell.classList.add('sales-only');
    // Far-flung marker rides on $/Acre deliberately: that's the number a
    // portfolio or estate sale distorts, so the warning belongs on the
    // figure it invalidates rather than on a group-size column the
    // Agricultural preset doesn't even show. Flag only — the row stays.
    if (p._farFlungReason) {
      const badge = document.createElement('span');
      badge.className = 'far-flung-badge';
      badge.textContent = `⚠ ${Math.round(p._saleGroupSpanKm)} km`;
      badge.title = p._farFlungReason;
      ppaCell.appendChild(document.createTextNode(' '));
      ppaCell.appendChild(badge);
    }
    tr.appendChild(ppaCell);
    const ppsfCell = td(formatGroupPpsf(p), 'num');
    ppsfCell.classList.add('sales-only');
    tr.appendChild(ppsfCell);
    const ppffCell = td(formatGroupPpff(p), 'num');
    ppffCell.classList.add('sales-only');
    tr.appendChild(ppffCell);
    // $/Lot closes the rate group, so the unit rates read together.
    const pplCell = td(formatGroupPpl(p), 'num');
    pplCell.classList.add('sales-only');
    tr.appendChild(pplCell);
    const distCell = td(formatDistanceKm(p), 'num');
    distCell.classList.add('sales-only', 'subj-col');
    tr.appendChild(distCell);
    const saleToAsmtCell = td(formatSaleToAsmt(p), 'num');
    saleToAsmtCell.classList.add('sales-only');
    tr.appendChild(saleToAsmtCell);
    // Per-parcel assessment block (Land $, Bldg $, Bldg %, Asmt Yr).
    // All four cells always emit so the sales-only column count stays
    // stable; values fall through to empty strings when the assessment
    // index didn't have the parcel.
    const landCell = td(formatCurrencyNumber(p._asmtLand), 'num');
    landCell.classList.add('sales-only');
    tr.appendChild(landCell);
    const bldgCell = td(formatCurrencyNumber(p._asmtBuildings), 'num');
    bldgCell.classList.add('sales-only');
    tr.appendChild(bldgCell);
    const bldgPctCell = td(formatBuildingPct(p._asmtPctBldg), 'num');
    bldgPctCell.classList.add('sales-only');
    tr.appendChild(bldgPctCell);
    const yearCell = td(formatAsmtYear(p._asmtYear), 'num');
    yearCell.classList.add('sales-only');
    tr.appendChild(yearCell);
    tr.appendChild(legalCell(p));
    tr.appendChild(titleCell(p));
    tr.appendChild(td(formatPercent(row.zoning[0]?.ratio), 'num'));
    tr.appendChild(td(z2Show ? badge(formatZoneCode(z2), 'badge-zone') : null));
    tr.appendChild(td(z1.ZBL));
    // Dev-Plan cells get the .devplan-only class so they show/hide
    // with the Dev Plan Layer overlay toggle (CSS in style.css).
    const devNameCell = td(formatDes(d1));
    devNameCell.classList.add('devplan-only');
    tr.appendChild(devNameCell);
    const devBylawCell = td(d1.DP_BYLAW);
    devBylawCell.classList.add('devplan-only');
    tr.appendChild(devBylawCell);
    // MASC Rating and Risk Area are both stamped during enrichment
    // whether or not the MASC map overlay is on, so neither hides behind
    // the overlay toggle — the Columns gear governs them like any other
    // column.
    tr.appendChild(soilCell(p));
    tr.appendChild(td(p._soilRiskArea != null ? String(p._soilRiskArea) : null, 'num'));
    // CLI capability + Soil Type for the dominant (highest area-share)
    // soil — read directly from the stamped composition array. Empty
    // until the soil-survey join has run for this muni; the empty-cell
    // hint tells the user how to load it.
    tr.appendChild(td(dominantCliLabel(p), null, CLI_EMPTY_HINT));
    tr.appendChild(td(dominantSoilTypeLabel(p), null, SOIL_EMPTY_HINT));
    // Slope, as the numeric span across every soil class on the parcel
    // ("0 – 15%") rather than only the dominant soil's class — a quarter
    // that is half level and half moderately sloping should not read as
    // uniformly level. The per-soil breakdown goes on the title so the
    // cell stays narrow; td() only titles EMPTY cells, hence setting it
    // here. Empty string from slopeRangeText becomes null so td() renders
    // the em-dash + not-loaded hint.
    const slopeRange = parcelSlopeRange(p);
    const slopeCell = td(slopeRangeText(slopeRange) || null, null, SLOPE_EMPTY_HINT);
    if (slopeRange) slopeCell.title = slopeSummaryText(p, '\n');
    tr.appendChild(slopeCell);
    // Land Cover (dominant farmland bucket + share) and Cult % — both
    // populated only for over-threshold parcels from the pre-baked
    // _landCover stamp; blank otherwise. Cult % is right-aligned
    // numeric so it sorts/scans with the other rate columns. When the
    // parcel IS over the acreage threshold but the stamp is missing,
    // the empty-cell hint explains how land cover loads.
    tr.appendChild(landCoverCell(p, ac));
    const cultPct = Number(ac) > LAND_COVER_MIN_ACRES ? cultFraction(p._landCover) : null;
    const cultHint = (cultPct == null && Number(ac) > LAND_COVER_MIN_ACRES) ? LANDCOVER_EMPTY_HINT : undefined;
    tr.appendChild(td(cultPct != null ? formatPercent(cultPct) : null, 'num', cultHint));
    // Water influence is a pre-baked per-muni shard like land cover, NOT an
    // overlay-gated live fetch — so no .water-only class here. That class
    // belongs to the WALLAS tile/irrigation pair below, which really is gated
    // on their overlays being switched on.
    tr.appendChild(waterCell(p));
    const tileCell = tileDrainageCell(p);
    tileCell.classList.add('water-only');
    tr.appendChild(tileCell);
    const irrCell = irrigationCell(p);
    irrCell.classList.add('water-only');
    tr.appendChild(irrCell);
    tr.appendChild(td(badge(formatChanges(row), 'badge-amend')));
    tr.appendChild(td(formatDu(p.Dwelling_Units), 'num'));
    // Basic-mode position for Acres — hidden in sales mode (the
    // sales-only Acres cell above takes its place after $/Lot).
    const rollSizeBasicCell = td(formatRollSize(p), 'num');
    rollSizeBasicCell.classList.add('basic-only');
    tr.appendChild(rollSizeBasicCell);
    const acresBasicCell = td(formatAcres(acSize), 'num');
    acresBasicCell.classList.add('basic-only');
    markAreaCheck(acresBasicCell, p);
    tr.appendChild(acresBasicCell);
    tr.appendChild(td(formatSf(acSize), 'num'));
    tr.appendChild(assessmentCell(p));
    tr.appendChild(walkCell(row));
    tr.appendChild(floodCell(row));
    tr.appendChild(streetViewCell(row));
    frag.appendChild(tr);
  }
  $tbody.appendChild(frag);
  // Phase 5: re-stamp column visibility after the rows are in the
  // DOM so hidden columns stay collapsed on every re-render (sort,
  // pagination, filter change, fresh search).
  applyColumnVisibility();
  // Phase 7: toggle the empty-table state. Shown only when no rows
  // are rendered AND the user hasn't run a search yet (treated as
  // sorted.length === 0).
  const $resultsEmpty = document.getElementById('results-empty');
  if ($resultsEmpty) $resultsEmpty.hidden = sorted.length > 0;
  renderPaginator(sorted.length);
  const salesExportAllowed = !document.body.classList.contains('sales-mode')
    || salesExportEnrichmentComplete;
  setExportEnabled(rows.length > 0 && salesExportAllowed);
  // Parcel numbering: gate the "#" column on numbering being on AND
  // there being more than one parcel, and reveal the toggle when it's
  // applicable. The map callouts are driven separately (setMapData /
  // toggle handler); this just keeps the grid column + control in sync
  // on every re-render.
  $resultsTable?.classList.toggle('numbering-on', numberingOn && rows.length > 1);
  updateNumberingAvailability();
  // Keep the Sales Charts tab in step with the grid. renderTable is the
  // single funnel every filter change, sort and re-search passes through,
  // so publishing here is what makes that tab track the filters rather
  // than freeze at whatever was on screen when it opened.
  publishSalesCharts();
}

/**
 * Update the pagination control row below the table. Hidden when
 * everything fits on one page. Buttons are disabled at the boundaries
 * (first/prev on page 0, next/last on the final page) so the user
 * can't navigate off the ends. The visible page-range label uses
 * 1-based row numbers because that's what humans expect.
 */
function renderPaginator(total) {
  if (!$paginator) return;
  if (total <= PAGE_SIZE) {
    $paginator.hidden = true;
    $paginator.innerHTML = '';
    return;
  }
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const start = currentPage * PAGE_SIZE + 1;
  const end   = Math.min(start + PAGE_SIZE - 1, total);
  const onFirst = currentPage === 0;
  const onLast  = currentPage >= pageCount - 1;
  $paginator.hidden = false;
  $paginator.innerHTML =
    `<button type="button" class="paginator-btn" data-page="first" ${onFirst ? 'disabled' : ''}>« First</button>` +
    `<button type="button" class="paginator-btn" data-page="prev"  ${onFirst ? 'disabled' : ''}>‹ Prev</button>` +
    `<span class="paginator-info">${start}–${end} of ${total.toLocaleString('en-CA')} · Page ${currentPage + 1} of ${pageCount}</span>` +
    `<button type="button" class="paginator-btn" data-page="next" ${onLast ? 'disabled' : ''}>Next ›</button>` +
    `<button type="button" class="paginator-btn" data-page="last" ${onLast ? 'disabled' : ''}>Last »</button>`;
}

if ($paginator) {
  $paginator.addEventListener('click', (e) => {
    const btn = e.target.closest('.paginator-btn');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.page;
    const pageCount = Math.max(1, Math.ceil(currentRows.length / PAGE_SIZE));
    if (action === 'first')      currentPage = 0;
    else if (action === 'prev')  currentPage = Math.max(0, currentPage - 1);
    else if (action === 'next')  currentPage = Math.min(pageCount - 1, currentPage + 1);
    else if (action === 'last')  currentPage = pageCount - 1;
    queueUrlWrite();
    // resetPage:false so renderTable doesn't bounce back to page 0.
    renderTable(currentRows, { resetPage: false });
    // Scroll the table's top into view so the new page lands where
    // the user is looking, not below the fold.
    const wrap = document.getElementById('results-wrap');
    if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/**
 * Soil rating cell. Renders the dominant MASC rating letter (A→J) as a
 * coloured chip matching the overlay's A→J palette. Tooltip carries the
 * source quarter-section label so the user can verify which quarter
 * dominated a multi-quarter parcel. Empty cell when the parcel falls
 * outside MASC coverage (typical of urban lots).
 */
/**
 * Dominant CLI capability rating for the parcel — AGRI_CAP of the
 * top-share soil from the stamped composition (e.g. "2W"). Empty
 * when no Soil Survey / CLI overlay has been loaded for this muni.
 * Falls back to AGCAP_CLS if AGRI_CAP is missing.
 */
/**
 * Build the detailed CSV cells for the top three mapped soils. Reads
 * `_soilComposition[0..2]` (rolled-up by
 * soil association, each entry already carries the largest-contributing
 * polygon's descriptor codes per soilSurveyComponentsFromMatches),
 * decodes each code to its human-readable label via map.js's domain
 * tables, and returns the cells in CSV order. Missing composition
 * entries (parcel has fewer than 3 soil associations) emit empty cells
 * so the column count stays fixed across rows.
 */
/**
 * Report-ready sentence for the parcel's slope — every class present with
 * its share, plus the unclassified remainder when there is one:
 *
 *   "0 – 0.5% (level to nearly level) — 62%; >9 – 15% (moderately
 *    sloping) — 31%; not classified — 7%"
 *
 * Ordered primary-first (parcelSlopeRange sorts parts by descending
 * share), so it reads the way an appraiser would write it. Lives in
 * main.js rather than cellFormat.js because the class labels come from
 * map.js's domain tables; `sep` lets the grid tooltip break on newlines
 * while the CSV keeps it to one line.
 *
 * The unclassified tail is deliberately stated rather than dropped: the
 * composition is capped at three soil associations, so a mixed parcel can
 * legitimately have a share this range says nothing about.
 */
/**
 * The four Slope CSV cells, in the header order above: Range, Min %,
 * Max % and Summary. Min/Max stay unformatted numbers so a spreadsheet
 * reads them as numeric — no "%" suffix, that's in the header. Max is
 * blank for the open-ended top class rather than a fake ceiling.
 */
function slopeCsvCells(p) {
  const range = parcelSlopeRange(p);
  if (!range) return ['', '', '', ''];
  return [
    slopeRangeText(range),
    range.min,
    range.max ?? '',
    slopeSummaryText(p),
  ];
}

function slopeSummaryText(p, sep = '; ') {
  const range = parcelSlopeRange(p);
  if (!range) return '';
  const bits = range.parts.map(
    (part) => `${decodeSoilDescriptor('topo', part.code)} — ${Math.round(part.pct)}%`,
  );
  // Sub-1% remainders are rounding noise, not a real gap in coverage.
  if (range.unclassifiedPct >= 1) {
    bits.push(`not classified — ${Math.round(range.unclassifiedPct)}%`);
  }
  return bits.join(sep);
}

const SOIL_CSV_DOMAINS_PER_SOIL = [
  ['topo',      'Slope'],
  ['stone',     'Stones'],
  ['salinity',  'Salinity'],
  ['erosion',   'Erosion'],
  ['drainage',  'Drainage'],
  ['surftextm', 'Surface Mod'],
  ['mancon',    'Mgmt'],
  ['genRatin',  'Irrigation'],
  ['spudRtng',  'Potato'],
];
function soilCsvHeaders() {
  const cols = [];
  for (const idx of ['1', '2', '3']) {
    cols.push(`Soil ${idx} Name`);
    cols.push(`Soil ${idx} Code`);
    cols.push(`Soil ${idx} % of Parcel`);
    cols.push(`Soil ${idx} Acres`);
    cols.push(`Soil ${idx} CLI Capability`);
    cols.push(`Soil ${idx} CLI Class`);
    cols.push(`Soil ${idx} Surface Texture`);
    cols.push(`Soil ${idx} Map Units`);
    for (const [, label] of SOIL_CSV_DOMAINS_PER_SOIL) cols.push(`Soil ${idx} ${label}`);
  }
  return cols;
}
function soilCsvCells(p) {
  const comp = Array.isArray(p?._soilComposition) ? p._soilComposition : [];
  const out = [];
  for (let i = 0; i < 3; i++) {
    const c = comp[i];
    if (!c) {
      out.push('', '', '', '', '', '', '', '');
      for (let j = 0; j < SOIL_CSV_DOMAINS_PER_SOIL.length; j++) out.push('');
      continue;
    }
    out.push(c.soilName || '');
    out.push(c.soilCode || '');
    out.push(Number.isFinite(c.parcelPct) ? c.parcelPct.toFixed(1) : '');
    out.push(Number.isFinite(c.areaAcres) ? c.areaAcres.toFixed(3) : '');
    out.push(c.agriCap || '');
    out.push(c.agcapCls || '');
    out.push(c.surfaceText || '');
    out.push(Array.isArray(c.mapUnits) ? c.mapUnits.join(' | ') : (c.mapUnit || ''));
    for (const [field] of SOIL_CSV_DOMAINS_PER_SOIL) {
      out.push(decodeSoilDescriptor(field, c[field]));
    }
  }
  return out;
}

function soilCell(p) {
  const cell = document.createElement('td');
  const rating = p?._soilRating;
  if (!rating) {
    cell.textContent = '';
    return cell;
  }
  const swatch = document.createElement('span');
  swatch.className = 'soil-chip';
  swatch.textContent = rating;
  const displayCode = p?._soilRatingCode || mascDisplayRating({ ratings: rating });
  swatch.style.backgroundColor = masccolor(displayCode);
  // Legibility rule lives beside the palette in masc.js so this cell and the
  // map popup's MASC box can't drift apart.
  swatch.style.color = mascTextColor(displayCode);
  const titleParts = [];
  if (rating.includes('/')) titleParts.push(`Multiple MASC ratings: ${rating}`);
  if (p._soilQuarter) titleParts.push(`Source: ${p._soilQuarter}`);
  if (titleParts.length) cell.title = titleParts.join('\n');
  cell.appendChild(swatch);
  return cell;
}

/**
 * "Land Cover" grid cell — a colour-dot + dominant bucket + its share
 * (e.g. "● Cultivated 78%"). Empty for parcels ≤ LAND_COVER_MIN_ACRES
 * or with no `_landCover` stamp (the shards only carry farmland over
 * the threshold; the webapp gates on its own computed acreage too
 * for consistency).
 */
function landCoverCell(p, ac) {
  const cell = document.createElement('td');
  const eligible = Number(ac) > LAND_COVER_MIN_ACRES;
  const dom = eligible ? dominantBucket(p?._landCover) : null;
  if (!dom) {
    if (eligible) {
      // Over the threshold but no land-cover stamp → show the em-dash +
      // hint so the blank reads as "not loaded" rather than "no data".
      cell.textContent = '—';
      cell.classList.add('empty', 'empty-hint');
      cell.title = LANDCOVER_EMPTY_HINT;
    } else {
      cell.textContent = '';
    }
    return cell;
  }
  const dot = document.createElement('span');
  dot.className = 'lc-dot';
  dot.style.backgroundColor = dom.color;
  cell.appendChild(dot);
  cell.appendChild(document.createTextNode(`${dom.label} ${Math.round(dom.pct * 100)}%`));
  return cell;
}

/**
 * "Water" grid cell — a colour dot plus the water body name, e.g.
 * "● Red River" or "● Retention pond".
 *
 * Three states, and the difference is the whole point (same reasoning as the
 * Tile Drainage cell below):
 *   - shard never loaded (`_waterLoaded` falsy) → blank. We genuinely do not
 *     know; rendering "No water" here would be a confident lie.
 *   - shard loaded, no stamp                    → "No water" in the empty
 *     style. The detection ran and found nothing within 164 ft.
 *   - stamp present                             → dot + body name, class and
 *     caveats on hover.
 *
 * The dot colour carries the frontage-vs-near-water distinction (blues vs
 * ambers, see lib/water.js), so a scan down the column separates parcels
 * WITH frontage from parcels merely near water without reading a word.
 */
function waterCell(p) {
  const cell = document.createElement('td');
  const w = p?._water;
  if (!w) {
    if (p?._waterLoaded) {
      cell.textContent = 'No water';
      cell.classList.add('empty');
      cell.title = 'No mapped water feature within 164 ft of this parcel.';
    } else {
      cell.textContent = '';
    }
    return cell;
  }
  const dot = document.createElement('span');
  dot.className = 'lc-dot';
  dot.style.backgroundColor = waterColor(w) || '#9aa0a6';
  cell.appendChild(dot);
  cell.appendChild(document.createTextNode(waterCellText(w)));
  const tip = waterTooltip(w);
  if (tip) cell.title = tip;
  return cell;
}

/**
 * Tile Drainage cell — coverage share plus the licence number.
 *
 * Three distinct states, and the difference matters enough to an
 * appraiser to be worth the extra branch:
 *   - not loaded  → em-dash + hint pointing at the overlay toggle
 *   - loaded, no overlap → blank (a real "nothing licensed here")
 *   - overlap → "78% · 17-WCW-0078"
 */
function tileDrainageCell(p) {
  const hit = p?._tileDrainage;
  if (hit === undefined) return td(null, null, TILE_EMPTY_HINT);
  if (hit === null) return noLicenceCell(NO_TILE_HINT);
  // Leads with "Yes" so a column of sales comps scans at a glance; the
  // licence number moves to the tooltip, since it's the coverage share
  // that matters when comparing parcels and the licence that matters
  // when chasing one down.
  const parts = ['Yes'];
  if (Number.isFinite(hit.ratio)) parts.push(formatPercent(hit.ratio));
  const cell = td(parts.join(' · '));
  // The detail fields are populated on well under 10% of records, so the
  // tooltip carries whatever exists rather than a fixed layout.
  const detail = [
    hit.licence ? `Licence ${hit.licence}` : null,
    hit.client,
    hit.status,
    hit.date ? `Applied ${hit.date}` : null,
    hit.area ? `${hit.area} ac licensed` : null,
    hit.depth ? `${hit.depth}″ deep` : null,
    hit.spacing ? `${hit.spacing}′ lateral spacing` : null,
    hit.count > 1 ? `${hit.count} licensed areas overlap this parcel` : null,
  ].filter(Boolean);
  if (detail.length) cell.title = detail.join('\n');
  return cell;
}

/**
 * Clip licensed tile-drainage footprints to each parcel and stamp the
 * best match onto the parcel's properties.
 *
 * Uses the same area-weighted join as the zoning / dev-plan columns, so a
 * percentage in the Tile column means what it means everywhere else:
 * share of THIS parcel's area, not of the tiled area.
 *
 * Only runs when the data is already warranted — see wantsTileData().
 * Otherwise an ordinary search would pull 1.3 MB nobody asked for.
 * fetchTileDrainageAreas is IDB-cached for a week, so repeat calls
 * inside a session are local.
 *
 * `undefined` (never touched) and `null` (checked, nothing found) are
 * deliberately different — see tileDrainageCell.
 */
async function stampTileDrainage(rows) {
  if (!wantsTileData() || !rows?.length) return;
  let tileFc;
  try {
    tileFc = auxData.tileDrainage || await fetchTileDrainageAreas();
  } catch (err) {
    console.warn('tile-drainage enrichment failed (non-fatal):', err);
    return;
  }
  if (!tileFc?.features?.length) return;
  const parcelFc = { type: 'FeatureCollection', features: rows.map((r) => r.parcel) };
  const scoped = clipWallasToParcels(tileFc, parcelFc);
  let join;
  try {
    join = await joinTopNByAreaAsync(parcelFc, scoped, 2);
  } catch (err) {
    console.warn('tile-drainage join failed (non-fatal):', err);
    return;
  }
  for (const row of rows) {
    const parcel = row.parcel;
    const oid = parcel?.properties?.OBJECTID;
    const matches = significantMatches(join.get(oid), oid);
    if (matches.length === 0) {
      parcel.properties._tileDrainage = null;
      continue;
    }
    const top = matches[0].feature.properties || {};
    parcel.properties._tileDrainage = {
      licence: top.LICENCE_NO || top.FILE_NO || null,
      status:  top.APPLICATION_STATUS || null,
      date:    top.APPLICATION_DATE || null,
      client:  top.CLIENT_NAME || null,
      area:    top.TILE_AREA || null,
      depth:   top.TILE_DEPTH || null,
      spacing: top.TILE_SPACING_OF_LATERAL_PIPE || null,
      ratio:   Number.isFinite(matches[0].ratio) ? matches[0].ratio : null,
      count:   matches.length,
    };
  }
}

/**
 * Re-run the tile join against the rows already on screen and repaint,
 * so flipping the overlay on fills the column without a fresh search.
 * No-op when there's nothing rendered.
 */
async function restampTileDrainage() {
  if (!currentRows || currentRows.length === 0) return;
  await stampTileDrainage(currentRows);
  renderTable(currentRows, { resetPage: false });
}

/**
 * Irrigation cell — which side of the licence touches this parcel, the
 * coverage share, and the licence number.
 *
 * Point of Use leads when both are present: "water is applied here" is
 * the irrigated-land signal an appraiser is actually pricing, while a
 * point of diversion only says the parcel holds the intake or well.
 * States mirror tileDrainageCell — undefined is "never checked", null is
 * a real "nothing licensed here".
 */
function irrigationCell(p) {
  const hit = p?._irrigation;
  if (hit === undefined) return td(null, null, IRRIGATION_EMPTY_HINT);
  if (hit === null) return noLicenceCell(NO_IRRIGATION_HINT);
  // A bare "Yes", deliberately — no percentage, no location, no
  // diversion.
  //
  // WALLAS's Point of Use polygons are DLS quarter sections, not watered
  // areas: 92% are four-corner quadrilaterals with a median footprint of
  // 803 × 804 m and 158 acres, against a quarter section's 805 × 805 m
  // and 160 acres. Once the quarter covers the parcel, everything that
  // geometry can tell you is "this parcel falls under a licensed
  // irrigation location" — so that is the whole answer, and any number
  // beside it would only invite a false reading. Licence, licensee,
  // supply and location live in the tooltip and the CSV.
  const cell = td('Yes');
  const detail = [
    hit.licence ? `Licence ${hit.licence}` : null,
    hit.client,
    hit.status,
    // Groundwater vs surface, and the works type, are what decide how
    // secure the supply behind an irrigated valuation actually is.
    [hit.subProgram, hit.projectType].filter(Boolean).join(' · ') || null,
    hit.source ? `Source: ${hit.source}` : null,
    hit.location ? `Location ${hit.location}` : null,
    hit.date ? `Applied ${hit.date}` : null,
    hit.count > 1 ? `${hit.count} licensed points of use overlap this parcel` : null,
    'Location is the survey quarter the licence names, not a mapped watered area.',
  ].filter(Boolean);
  if (detail.length) cell.title = detail.join('\n');
  return cell;
}

/**
 * Cell for "we checked, and Manitoba has no licensed record here".
 *
 * Deliberately "No record" rather than a bare "No". WALLAS holds LICENSED
 * works only, and its tile-drainage polygons lag their own application
 * tracker by a year or more, so the absence of a record is genuinely not
 * the same claim as "this land is not tiled" — and a Yes/No column gets
 * pasted into reports, where that distinction stops being academic. The
 * cell says what we actually know; the tooltip says why.
 */
function noLicenceCell(hintText) {
  const cell = document.createElement('td');
  cell.textContent = 'No record';
  cell.classList.add('empty', 'empty-hint');
  cell.title = hintText;
  return cell;
}

/**
 * True when the tile / irrigation column should be populated for this
 * search — its overlay is on, its search filter is ticked, or the
 * Agricultural preset asked for the whole ag picture.
 *
 * `waterRightsWantedForGrid` (declared with the module state up top) is
 * that preset's latch: the preset lists Tile Drainage + Irrigation, so
 * picking it is the user asking for the data, the same way ticking a
 * filter or lighting the overlay is. Session-only and cleared by any
 * other preset — otherwise every later search would keep paying the
 * WALLAS fetch for columns the user has moved on from.
 */
function wantsTileData() {
  return !!($tileToggle?.classList.contains('active')
    || $tileOnly?.checked
    || waterRightsWantedForGrid);
}
function wantsIrrigationData() {
  return !!($irrigationToggle?.classList.contains('active')
    || $irrigationOnly?.checked
    || waterRightsWantedForGrid);
}

/** True when EITHER water-rights column should be populated. Lets the
 *  caller skip the status message (and the await) entirely otherwise,
 *  and drives the .water-mode class that reveals both columns. */
function wantsWaterRightsEnrichment() {
  return wantsTileData() || wantsIrrigationData();
}

/**
 * Narrow a province-wide WALLAS collection to the footprints whose bbox
 * could touch the current result set, before handing it to the join.
 *
 * The join is bbox-indexed and would reach the same answer either way —
 * this is purely about not paying to structured-clone ~5,300 irrigation
 * polygons into the worker and index them, when a search in one corner of
 * the province is only near a handful. A bbox test is conservative, so
 * nothing that could intersect is ever dropped.
 *
 * Returns the original collection untouched when nothing can be pruned,
 * so the join core's WeakMap-cached bbox index still gets reused across
 * repeat searches in that case.
 */
function clipWallasToParcels(fc, parcelFc) {
  const features = fc?.features || [];
  const parcels = parcelFc?.features || [];
  if (features.length === 0 || parcels.length === 0) return fc;

  // bboxOfFeature takes a single Feature, so fold the parcels into one
  // extent rather than handing it the collection.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parcels) {
    let b;
    try { b = bboxOfFeature(p); } catch { continue; }
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2];
    if (b[3] > maxY) maxY = b[3];
  }
  const extent = [minX, minY, maxX, maxY];
  if (!extent.every(Number.isFinite)) return fc;

  const kept = features.filter((f) => {
    let b;
    // A footprint we can't measure is kept — the join will bbox-test it
    // properly. Dropping it here would be the one way this pre-filter
    // could change an answer.
    try { b = bboxOfFeature(f); } catch { return true; }
    return bboxesIntersect(b, extent);
  });
  if (kept.length === features.length) return fc;
  return { type: 'FeatureCollection', features: kept };
}

/**
 * When a water-rights SEARCH FILTER is on, drop the parcels whose only
 * overlap turned out to be a sliver. Returns how many were removed.
 *
 * The filter resolves server-side through esriSpatialRelIntersects, which
 * has no notion of "how much" — it counts a shared edge. On a filtered RM
 * of Rockwood search roughly half the hits were of that kind. The exact
 * clip that runs a moment later is the only place that can tell, so it
 * gets the final say and the filter keeps its promise: every row it
 * returns is a row the column can actually vouch for.
 *
 * Mutates `rows` and `parcelFc.features` in place and in step, so the
 * grid, the map, and the caller's own reference can't drift apart.
 */
// How many rows the water-rights filters removed on the last enrichment
// pass. Read by the sales-CSV path, which writes its own count line after
// enrichOverlays has returned.
let lastWaterFilterDropped = 0;

/** Which water-rights filters are ticked, as a phrase. Shared by the
 *  post-search drop note and the live view filter so both name the
 *  cause the same way. */
function waterFilterNames() {
  return [
    $tileOnly?.checked ? 'licensed tile drainage' : null,
    $irrigationOnly?.checked ? 'licensed irrigation' : null,
    $waterfrontOnly?.checked ? 'waterfront' : null,
    $nearWaterOnly?.checked ? 'near-water' : null,
  ].filter(Boolean).join(' + ') || 'water';
}

/** Phrase for the count line, naming which filter did the removing so
 *  "3 of 5" never looks like rows went missing on their own. */
function waterFilterDropNote() {
  // "licensed" now lives inside waterFilterNames() per-filter — waterfront and
  // near-water aren't licensed anything, and hardcoding it here made the note
  // read "hidden by the licensed waterfront filter".
  return `${lastWaterFilterDropped} hidden by the ${waterFilterNames()} filter`;
}

// ---------- Live water-rights view filter ----------
//
// Ticking "Licensed tile drainage only" / "Licensed irrigation only"
// filters what is already on screen, immediately, instead of waiting for
// the next Search. The unfiltered set is stashed on the first tick so
// unticking restores it with no round-trip; runSearch and the sales
// upload clear the stash when they replace the result set.
//
// This is purely a VIEW filter — it never touches listParcelKeys or the
// search inputs, so the server-side OBJECTID pre-filter still runs on the
// next Search exactly as before. That pre-filter is what keeps a capped
// muni-wide search honest (122 of 186 munis hold more parcels than
// MAX_RESULTS), and filtering a returned page can't replace it.
//
// Numbering survives: _seq is stamped on the feature, so hiding rows
// leaves the survivors' numbers glued to their parcels — see setMapData.
let waterFilterBaseRows = null;
let waterFilterBaseMsg = '';

function waterFilterActive() {
  return !!($tileOnly?.checked || $irrigationOnly?.checked
    || $waterfrontOnly?.checked || $nearWaterOnly?.checked);
}

/** Forget the stashed unfiltered set. Called wherever a new result set
 *  replaces the old one, so an untick can't resurrect a previous
 *  search's rows. */
function resetWaterFilterBase() {
  waterFilterBaseRows = null;
  waterFilterBaseMsg = '';
}

/** True when the row satisfies every ticked box. Same predicate
 *  dropSliverOnlyMatches applies after a search, so the live filter and
 *  the post-search drop can never disagree about what qualifies. */
function rowPassesWaterFilter(row) {
  const q = row?.parcel?.properties || {};
  if ($tileOnly?.checked && !q._tileDrainage) return false;
  if ($irrigationOnly?.checked && !q._irrigation) return false;
  // Waterfront / near-water are OR'd with each other and AND'd with
  // everything else — ticking both gives "any water influence", which is a
  // question an appraiser actually asks when assembling comps.
  //
  // GATED ON `_waterLoaded`, for the same reason the WALLAS boxes gate on a
  // successful load: filtering on a stamp that never arrived reads as
  // "nothing qualifies" and silently empties the grid. Observed for real —
  // a Niverville search with the shards unpublished hid all 100 rows, which
  // would have been read as "no waterfront in Niverville" when the town in
  // fact has 378 such parcels. A row whose muni shard didn't resolve is
  // UNKNOWN, not excluded, so it passes through and the count line says the
  // filter couldn't be applied (see waterFilterUnavailable).
  const wantFront = !!$waterfrontOnly?.checked;
  const wantNear  = !!$nearWaterOnly?.checked;
  if ((wantFront || wantNear) && q._waterLoaded) {
    const ok = (wantFront && isWaterfront(q._water))
            || (wantNear  && isNearWater(q._water));
    if (!ok) return false;
  }
  return true;
}

/** True when a water-influence box is ticked but NO row in the current set
 *  carries a resolved shard — i.e. the filter is inert. Drives the honest
 *  count-line note instead of showing an unexplained full result set. */
function waterInfluenceFilterInert(rows) {
  if (!($waterfrontOnly?.checked || $nearWaterOnly?.checked)) return false;
  return !rows?.some((r) => r?.parcel?.properties?._waterLoaded);
}

/**
 * Load + stamp whatever the ticked boxes need, when the rows in hand
 * don't carry it yet. Mirrors the water half of
 * ensureAgriculturalGridData; both stamps self-gate on wantsTileData /
 * wantsIrrigationData, which a ticked checkbox already satisfies.
 *
 * Returns false if the load failed — the caller must not filter on
 * absent stamps, or an unreachable WALLAS would read as "nothing
 * qualifies" and empty the grid.
 */
async function ensureWaterDataForRows(rows) {
  const stamped = (key) => rows.every((r) => r?.parcel?.properties?.[key] !== undefined);
  const needTile = !!$tileOnly?.checked && !stamped('_tileDrainage');
  const needIrr  = !!$irrigationOnly?.checked && !stamped('_irrigation');
  if (!needTile && !needIrr) return true;
  const prior = $count.textContent || '';
  setCount(`${prior} · Checking water-rights licences…`.replace(/^ · /, ''));
  beginCliOp('Checking water rights…');
  try {
    await Promise.all([
      needTile ? stampTileDrainage(rows) : Promise.resolve(),
      needIrr  ? stampIrrigation(rows)   : Promise.resolve(),
    ]);
    // stampTileDrainage / stampIrrigation swallow their own fetch and
    // join failures and simply return without writing anything, so a
    // rejected promise is NOT the only way this comes back empty.
    // Re-check that the stamps actually landed: filtering on absent data
    // would fail every row and read as a confident "nothing qualifies".
    const landed = (!$tileOnly?.checked || stamped('_tileDrainage'))
      && (!$irrigationOnly?.checked || stamped('_irrigation'));
    if (!landed) {
      setCount(`${prior} · Water-rights data unavailable — filter not applied`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Water-rights filter data load failed', err);
    setCount(`${prior} · Water-rights data unavailable: ${err.message} — filter not applied`);
    return false;
  } finally {
    endCliOp();
  }
}

/**
 * Re-render grid + map from `rows`, naming how many of `base` the filter
 * removed. Same shape as refilterCsvIfActive: the zoning / dev-plan
 * sources keep their full data so the surrounding context stays on the
 * map, and a filter that narrows to zero doesn't re-fit (an empty FC
 * flies to province-wide, which reads as a bug).
 */
function renderWaterFilteredView(rows, base, baseMsg) {
  const hidden = base.length - rows.length;
  // Unticking restores what is IN HAND, which is less than the imported
  // list whenever the last Search pre-filtered server-side — those rows
  // were never fetched. Say so rather than leaving a bare count that
  // looks like the rest went missing.
  const shortOfList = !baseMsg
    && listParcelKeys?.length
    && rows.length < listParcelKeys.length;
  // An inert water-influence filter must announce itself. Otherwise the user
  // ticks "Waterfront only", sees the untouched result set, and reasonably
  // concludes every parcel is waterfront.
  const waterInert = waterInfluenceFilterInert(rows);
  setCount(hidden > 0
    ? `${rows.length} of ${base.length} shown · ${hidden} hidden by the ${waterFilterNames()} filter`
    : waterInert
      ? `${rows.length} parcel${rows.length === 1 ? '' : 's'} shown · water-influence data hasn't loaded for these municipalities, so that filter was not applied`
      : shortOfList
        ? `${rows.length} of ${listParcelKeys.length} imported parcels in hand — press Search to refetch the full list`
        : (baseMsg || `${rows.length} parcel${rows.length === 1 ? '' : 's'} shown`));
  renderTable(rows);
  const fc = { type: 'FeatureCollection', features: rows.map((r) => r.parcel) };
  setMapData(fc, lastZoningFc, lastDevPlanFc, { fit: rows.length > 0 });
  applyStarredFromFavorites(fc);
}

/** Tick / untick handler for both boxes. */
async function onWaterFilterToggle() {
  const base = waterFilterBaseRows
    || (csvFullRows?.length ? csvFullRows : currentRows);
  // Nothing on screen yet — the box still counts for the next Search,
  // which is where the server-side pre-filter picks it up.
  if (!base?.length) return;

  if (!waterFilterActive()) {
    const restore = waterFilterBaseRows || base;
    const msg = waterFilterBaseMsg;
    resetWaterFilterBase();
    renderWaterFilteredView(restore, restore, msg);
    return;
  }

  if (!waterFilterBaseRows) {
    waterFilterBaseRows = base;
    waterFilterBaseMsg = $count.textContent || '';
  }
  const ok = await ensureWaterDataForRows(waterFilterBaseRows);
  if (!ok) return;   // message already explains why nothing changed
  const kept = waterFilterBaseRows.filter(rowPassesWaterFilter);
  renderWaterFilteredView(kept, waterFilterBaseRows, waterFilterBaseMsg);
  // Deliberately does NOT arm the Water Influence overlay — see the note above
  // autoEnable's removal. The map colouring is the user's choice to make.
}

$tileOnly?.addEventListener('change', onWaterFilterToggle);
$irrigationOnly?.addEventListener('change', onWaterFilterToggle);
$waterfrontOnly?.addEventListener('change', onWaterInfluenceFilterToggle);
$nearWaterOnly?.addEventListener('change', onWaterInfluenceFilterToggle);

/**
 * Waterfront / near-water boxes need a RE-SEARCH, not a view filter, whenever
 * the roll pre-filter is in play.
 *
 * resolveWaterRollPrefilter constrains the Roll_Entry query itself, so after a
 * "Waterfront only" search the rows in hand ARE the waterfront parcels and
 * nothing else. Unticking that and ticking "Near water" then filters those 69
 * rows for near-water and finds none — the grid empties and reads
 * "0 of 69 shown · 69 hidden by the near-water filter", which looks exactly
 * like the filter being broken. A view filter can only ever narrow what was
 * fetched; it cannot recover parcels the pre-filter excluded.
 *
 * So: with a municipality selected and no list import — the conditions
 * resolveWaterRollPrefilter itself requires — re-run the search. Otherwise
 * (imported list, or province-wide where no pre-filter ran) the rows in hand
 * are the full set and the cheap live view filter is still correct.
 *
 * Sales-CSV mode trumps all of that: the pasted/uploaded sales are the
 * whole universe, so the boxes join the other sales filters via
 * refilterCsvIfActive — never a re-search, which would destroy the upload.
 */
let waterInfluenceRerunTimer = null;

async function onWaterInfluenceFilterToggle() {
  // Sales-CSV mode: the loaded sales ARE the universe. No roll pre-filter
  // ever constrained them, so a view filter is fully correct — and a
  // re-search would be worse than useless, since runSearch clears
  // csvFullRows and replaces the upload with a plain parcel search.
  // Routing through the sales filter pass (rather than the stash-based
  // view filter below) lets these boxes compose with the date / class /
  // size filters instead of the two paths overwriting each other's render.
  if (csvFullRows != null) { refilterCsvIfActive(); return; }

  const usedPrefilter = !!$municipality?.value.trim()
    && !(Array.isArray(listParcelKeys) && listParcelKeys.length);
  if (!usedPrefilter) return onWaterFilterToggle();

  // Debounced, because switching filters is TWO change events — untick
  // "Waterfront only", tick "Near water" — and firing a search on each would
  // put two of them in flight at once with no ordering guarantee. Observed:
  // the unfiltered search (1,000 rows) resolved after the near-water one and
  // overwrote it, so the grid showed everything instead of the 82 near-water
  // parcels. Collapsing to one search on the settled checkbox state also means
  // a user toggling quickly doesn't queue up a run per click.
  if (waterInfluenceRerunTimer) clearTimeout(waterInfluenceRerunTimer);
  waterInfluenceRerunTimer = setTimeout(() => {
    waterInfluenceRerunTimer = null;
    resetWaterFilterBase();   // the stashed set belongs to the old filter state
    runSearch();
  }, 250);
}

function dropSliverOnlyMatches(rows, parcelFc) {
  const tileOn = !!$tileOnly?.checked;
  const irrOn = !!$irrigationOnly?.checked;
  if (!tileOn && !irrOn) return 0;
  const keep = (row) => {
    const q = row?.parcel?.properties || {};
    // Both filters ticked means both must still hold, matching how
    // resolveOverlayFilter ANDs them server-side.
    if (tileOn && !q._tileDrainage) return false;
    if (irrOn && !q._irrigation) return false;
    return true;
  };
  const kept = rows.filter(keep);
  const shed = rows.length - kept.length;
  if (shed === 0) return 0;
  rows.length = 0;
  rows.push(...kept);
  if (Array.isArray(parcelFc?.features)) {
    const survivors = new Set(kept.map((r) => r.parcel));
    parcelFc.features = parcelFc.features.filter((f) => survivors.has(f));
  }
  return shed;
}

/** Drop overlaps too small to mean anything — see MIN_WATER_COVERAGE.
 *  Returns [] for a missing OBJECTID or an unjoined parcel, so callers
 *  can treat "no significant match" uniformly. */
function significantMatches(matches, oid) {
  if (oid == null || !Array.isArray(matches)) return [];
  return matches.filter((m) => Number.isFinite(m.ratio) && m.ratio >= MIN_WATER_COVERAGE);
}

/** Flatten one WALLAS irrigation feature into the fields the cell, the
 *  tooltip, and the CSV all read. */
function irrigationMatch(match) {
  const q = match.feature.properties || {};
  return {
    licence: q.LICENCE_NO || null,
    client: q.CLIENT_NAME || null,
    status: q.APPLICATION_STATUS || null,
    date: q.APPLICATION_DATE || null,
    subProgram: q.SUB_PROGRAM || null,
    projectType: q.PROJECT_TYPE || null,
    // WATER_SOURCE_NAME names the river/lake for surface licences;
    // ACQUIFER_NAME (the service's spelling) fills in for groundwater.
    source: q.WATER_SOURCE_NAME || q.ACQUIFER_NAME || null,
    // The legal land description the licence names. This is what the
    // geometry actually IS — see the note on irrigationCell — so it is
    // reported in place of a coverage percentage.
    location: q.FULL_LOCATION || null,
    // Kept for ordering only, never displayed: the polygon is a survey
    // quarter, so its overlap share is not a fact about irrigation.
    ratio: Number.isFinite(match.ratio) ? match.ratio : null,
  };
}

/**
 * Clip licensed irrigation footprints to each parcel and stamp the best
 * match of each kind. Same area-weighted join as the tile, zoning, and
 * dev-plan columns, so the percentage is comparable across all of them.
 *
 * The join keeps every overlap rather than a top-N: points of diversion
 * and points of use share one collection, and a top-N by ratio could
 * drop the parcel's only point of use behind several larger diversion
 * footprints. Overlap counts here are small (these are legal-location
 * footprints), so keeping them all is cheap and removes the failure mode.
 */
async function stampIrrigation(rows) {
  if (!wantsIrrigationData() || !rows?.length) return;
  let irrFc;
  try {
    irrFc = auxData.irrigation || await fetchIrrigationLicences();
  } catch (err) {
    console.warn('irrigation enrichment failed (non-fatal):', err);
    return;
  }
  if (!irrFc?.features?.length) return;
  const parcelFc = { type: 'FeatureCollection', features: rows.map((r) => r.parcel) };
  const scoped = clipWallasToParcels(irrFc, parcelFc);
  let join;
  try {
    join = await joinTopNByAreaAsync(parcelFc, scoped, Infinity);
  } catch (err) {
    console.warn('irrigation join failed (non-fatal):', err);
    return;
  }
  for (const row of rows) {
    const parcel = row.parcel;
    const oid = parcel?.properties?.OBJECTID;
    const matches = significantMatches(join.get(oid), oid);
    if (matches.length === 0) {
      parcel.properties._irrigation = null;
      continue;
    }
    // Points of USE only. A point of diversion is an intake or a well —
    // it says water is taken from here, not that this land is watered —
    // so it has no bearing on whether a parcel is irrigated and is not
    // reported. joinTopNByArea returns matches sorted by ratio desc, so
    // the first one is the best.
    const uses = matches.filter((m) => m.feature.properties?._wallasKind === 'use');
    if (uses.length === 0) {
      parcel.properties._irrigation = null;
      continue;
    }
    parcel.properties._irrigation = {
      ...irrigationMatch(uses[0]),
      count: uses.length,
    };
  }
}

/** Fill the Irrigation column for rows already on screen when the
 *  overlay is switched on, so it doesn't take a fresh search. */
async function restampIrrigation() {
  if (!currentRows || currentRows.length === 0) return;
  await stampIrrigation(currentRows);
  renderTable(currentRows, { resetPage: false });
}

/**
 * CSV cells for the land-cover columns: dominant bucket label followed
 * by each bucket's share as a one-decimal percent. All blank for
 * parcels ≤ LAND_COVER_MIN_ACRES or with no `_landCover` stamp, mirroring
 * the grid.
 */
function landCoverCsvCells(p, ac) {
  const lc = Number(ac) > LAND_COVER_MIN_ACRES ? p?._landCover : null;
  if (!lc) return ['', '', '', '', '', ''];
  const dom = dominantBucket(lc);
  const pct = (k) => {
    const v = Number(lc[k]);
    return Number.isFinite(v) ? (v * 100).toFixed(1) : '';
  };
  return [dom ? dom.label : '', pct('cult'), pct('past'), pct('bush'), pct('wet'), pct('other')];
}

/** Licence / % / status / applied-date for the tile-drainage columns.
 *  Blank for both "never checked" and "checked, none found" — a CSV has
 *  no room for that distinction, and the empty cell is honest either
 *  way given the source layer's known gaps. */
function tileDrainageCsvCells(p) {
  const hit = p?._tileDrainage;
  // Three states, and the spreadsheet needs to tell them apart: never
  // checked (blank), checked with nothing found ("No record"), and a hit
  // ("Yes"). A bare "No" would assert more than WALLAS can support — see
  // noLicenceCell.
  if (hit === undefined) return ['', '', '', '', ''];
  if (hit === null) return ['No record', '', '', '', ''];
  return [
    'Yes',
    hit.licence ?? '',
    Number.isFinite(hit.ratio) ? (hit.ratio * 100).toFixed(1) : '',
    hit.status ?? '',
    hit.date ?? '',
  ];
}

/** Licence / type / % / supply / source for the irrigation columns.
 *  Reports the point of USE when there is one — the irrigated-land
 *  signal — and falls back to the point of diversion, matching what the
 *  grid cell shows so the CSV and the screen never disagree. */
function irrigationCsvCells(p) {
  const hit = p?._irrigation;
  if (hit === undefined) return ['', '', '', '', ''];
  if (hit === null) return ['No record', '', '', '', ''];
  return [
    'Yes',
    hit.licence ?? '',
    // The survey quarter the licence names — reported instead of a
    // coverage share, which would misrepresent what the polygon is.
    hit.location ?? '',
    hit.subProgram ?? '',
    hit.source ?? '',
  ];
}

function soilSourceLabel(hit) {
  if (!hit) return null;
  if (hit.source === 'riverlot' || isMascRiverLotHit(hit)) {
    const label = hit.label || riverLotHitLabel(hit);
    return label ? `River lot ${label}` : null;
  }
  if (!hit.q) return null;
  return `${hit.q} ${hit.s}-${hit.t}-${hit.r}${hit.d || ''}`;
}

function isMascRiverLotHit(hit) {
  if (!hit) return false;
  const q = String(hit.q || '').toUpperCase();
  return /(?:RL|OT|WL|SL)$/.test(q) || hit.s == null || hit.t == null;
}

function riverLotHitLabel(hit) {
  if (!hit) return null;
  const q = String(hit.q || '').toUpperCase().trim();
  const lot = hit.r == null ? '' : String(hit.r).trim();
  const suffix = hit.d == null ? '' : String(hit.d).trim().toUpperCase();
  if (!q && !lot) return null;
  return `${q || 'RL'}${lot ? `-${lot}` : ''}${suffix}`;
}

/**
 * Stamp each parcel with the official MASC Risk_Area polygon containing
 * the parcel's bbox-centre point. Risk areas are broad crop-insurance
 * polygons, so a representative point is sufficient and avoids running
 * expensive parcel x province-boundary polygon intersections in the
 * search path.
 */
/**
 * Stamp each parcel's `_soilComposition` with soil components weighted
 * by both polygon overlap and the source EXTENT1/2/3 component share.
 * Each entry surfaces the soil name/code, agricultural-capability rating
 * (AGRI_CAP with subclass plus AGCAP_CLS for the paint chip), surface
 * texture, map-unit symbols, and the parcel's percent covered.
 *
 * Powered by joinTopNByArea so a parcel split across two map units, each
 * with mixed source extents, renders as true area-weighted component
 * percentages instead of treating SOIL_1 as the whole map unit.
 */
async function stampSoilCompositionOnParcels(parcelFc, soilFc) {
  if (!parcelFc?.features?.length || !soilFc?.features?.length) return;
  // Off the main thread like the zoning/dev-plan joins. This one is the
  // heaviest of the lot — every soil polygon that touches a parcel is
  // kept (n = Infinity, since the composition needs the full breakdown,
  // not a top-2) against up to ~3000 polygons on a busy municipality.
  // requestIdleCallback only defers when it STARTS; without the worker
  // the work still froze the tab once it began.
  const join = await joinTopNByAreaAsync(parcelFc, soilFc, Infinity);
  for (const parcel of parcelFc.features) {
    const oid = parcel.properties?.OBJECTID;
    const matches = (oid != null) ? join.get(oid) : null;
    if (!matches || matches.length === 0) {
      // Explicit null so the popup builder can distinguish "no
      // soil-survey data" from "soil survey not loaded".
      parcel.properties._soilComposition = null;
      continue;
    }
    const composition = soilSurveyComponentsFromMatches(matches, {
      maxRows: 3,
      parcelAreaAcres: parcelAcres(parcel),
    });
    parcel.properties._soilComposition = composition.length ? composition : null;
  }
}

function stampOfficialRiskAreas(rows, riskAreaFc) {
  const features = (riskAreaFc?.features || [])
    .map((feature) => {
      const risk = String(feature.properties?.Risk_Area ?? '').trim();
      if (!risk) return null;
      try {
        return { feature, risk, bbox: bboxOfFeature(feature) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (features.length === 0) return;

  for (const row of rows || []) {
    const parcel = row?.parcel;
    if (!parcel?.geometry) continue;
    try {
      const [minLon, minLat, maxLon, maxLat] = bboxOfFeature(parcel);
      const point = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
      const hit = features.find(({ feature, bbox }) => (
        point[0] >= bbox[0] && point[0] <= bbox[2] &&
        point[1] >= bbox[1] && point[1] <= bbox[3] &&
        booleanPointInPolygon(point, feature)
      ));
      if (hit) parcel.properties._soilRiskArea = hit.risk;
    } catch {
      // Leave the cell blank for malformed geometries; risk areas should
      // never make an otherwise-good parcel row fail to render.
    }
  }
}

function legalCell(p) {
  const cell = td(legalDisplay(p));
  const details = [
    p._legalDetail ? `Detail: ${p._legalDetail}` : null,
    p._lot ? `Lot: ${p._lot}` : null,
    p._block ? `Block: ${p._block}` : null,
    p._plan ? `Plan: ${p._plan}` : null,
  ].filter(Boolean);
  if (details.length) cell.title = details.join('\n');
  return cell;
}

/**
 * Title cell. The MAO scrape stores certificates_of_title as
 * '<NUMBER> / <CITY>' for a single title or a semicolon-separated
 * list for multi-title parcels. The number is the meaningful piece
 * for an appraiser; the trailing ' / WINNIPEG' (or whichever Land
 * Titles office) just clutters the column.
 *
 * Render rules:
 *   - 1 title  → bare number, e.g. '3317402'
 *   - 2+       → first number + ' …', e.g. '2464089 …'
 *                full list lives in the cell's hover tooltip
 *   - empty    → blank cell
 */
function titleCell(p) {
  const raw = (p?._certificatesOfTitle || '').trim();
  if (!raw) return td(null);
  const numbers = parseTitleNumbers(raw);
  if (numbers.length === 0) return td(raw);  // unexpected shape — show raw
  const display = numbers.length === 1 ? numbers[0] : `${numbers[0]} …`;
  const cell = td(display);
  if (numbers.length > 1) {
    // Tooltip lists every number on its own line so the user sees the
    // full set without leaving the table. Includes the LTO suffix
    // from the raw value for context.
    cell.title = `${numbers.length} titles:\n${raw.split(/\s*;\s*/).join('\n')}`;
  } else if (raw !== numbers[0]) {
    // Single title with the LTO suffix — surface the suffix on hover.
    cell.title = raw;
  }
  return cell;
}

/**
 * Walkscore cell. Just a link to walkscore.com/score/<address> — same
 * pattern as the Asmt Report column. Walk Score's interactive page does
 * its own lookup of Walk / Transit / Bike from the address, so we don't
 * need to call the API or ship a key. No-op when the parcel has no
 * civic-address text (rural quarter-section descriptions, etc.).
 */
function walkCell(row) {
  const cell = document.createElement('td');
  const p = row.parcel.properties || {};
  const street = (p.Property_Address || '').trim();
  if (!street) {
    cell.textContent = '—';
    cell.classList.add('empty');
    return cell;
  }
  const muni = (p.Muni_Name_With_Typ || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const addressForUrl = encodeURIComponent(
    [street, muni, 'MB'].filter(Boolean).join(', ')
  );
  const a = document.createElement('a');
  a.href = `https://www.walkscore.com/score/${addressForUrl}`;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = 'Walkscore';
  a.addEventListener('click', (e) => e.stopPropagation());
  cell.appendChild(a);
  return cell;
}

/**
 * Google Street View deep link for a parcel, or '' without geometry.
 *
 * The Maps URLs pano action takes a VIEWPOINT, not an address — Google
 * opens the nearest panorama to that point, i.e. the road in front of
 * the parcel. That is what makes this work for unaddressed rural
 * parcels (a quarter-section legal description geocodes nowhere), and
 * it needs no API key. Where no panorama exists nearby, Google falls
 * back to a map at the spot instead of erroring.
 */
function streetViewUrl(feature) {
  if (!feature?.geometry) return '';
  try {
    const [minLon, minLat, maxLon, maxLat] = bboxOfFeature(feature);
    const lat = (minLat + maxLat) / 2;
    const lon = (minLon + maxLon) / 2;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
    return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)}%2C${lon.toFixed(6)}`;
  } catch {
    return '';
  }
}

/** StreetView cell — a 🌐 link into Street View at the parcel, same
 *  interaction pattern as the Walkscore / Flood link cells. */
function streetViewCell(row) {
  const cell = document.createElement('td');
  const url = streetViewUrl(row.parcel);
  if (!url) {
    cell.textContent = '—';
    cell.classList.add('empty');
    return cell;
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = '🌐';
  a.title = 'Open Google Street View at this parcel (nearest panorama)';
  a.addEventListener('click', (e) => e.stopPropagation());
  cell.appendChild(a);
  return cell;
}

/**
 * Flood-screening deep-link. Sister tool at mb-flood-mapping.vercel.app
 * accepts ?lat=&lon=&label=… (preferred) or ?address=… (geocodes via
 * Mapbox/Nominatim). We pass lat/lon when we can compute a centroid from
 * the parcel polygon, otherwise fall back to the address. Cell renders
 * a "view" link in the same style as the Walkscore / Asmt Report cells;
 * rows with no usable location render the dash.
 */
function floodCell(row) {
  const cell = document.createElement('td');
  const p = row.parcel.properties || {};
  const url = new URL('https://mb-flood-mapping.vercel.app/');
  let haveTarget = false;
  if (row.parcel.geometry) {
    try {
      const [minLon, minLat, maxLon, maxLat] = bboxOfFeature(row.parcel);
      const lat = (minLat + maxLat) / 2;
      const lon = (minLon + maxLon) / 2;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        url.searchParams.set('lat', lat.toFixed(6));
        url.searchParams.set('lon', lon.toFixed(6));
        haveTarget = true;
      }
    } catch { /* topology errors — fall through to address */ }
  }
  if (!haveTarget && p.Property_Address) {
    const muni = (p.Muni_Name_With_Typ || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    url.searchParams.set('address', [p.Property_Address, muni, 'MB'].filter(Boolean).join(', '));
    haveTarget = true;
  }
  if (haveTarget && p.Property_Address) {
    url.searchParams.set('label', p.Property_Address);
  }
  if (!haveTarget) {
    cell.textContent = '—';
    cell.classList.add('empty');
    return cell;
  }
  const a = document.createElement('a');
  a.href = url.toString();
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Flood';
  a.title = 'Open this parcel in the Manitoba flood-mapping tool';
  a.addEventListener('click', (e) => e.stopPropagation());
  cell.appendChild(a);
  return cell;
}

/** Walk a Feature's coordinates and return [minLon, minLat, maxLon, maxLat].
 *  Inlined here so the flood/walkscore cells don't drag in another turf
 *  import — same logic as @turf/bbox for our Polygon/MultiPolygon shapes. */
function bboxOfFeature(feature) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else {
      for (const sub of c) visit(sub);
    }
  };
  visit(feature.geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

/** Cheap bbox-vs-bbox overlap test. Both bboxes are [minX, minY, maxX, maxY].
 *  Used in the per-muni Sec-Twp Grid path to keep only the river lots
 *  whose envelope touches the selected muni's envelope — avoids
 *  pushing the entire province's river-lot polygon set onto the map
 *  source when the user is focused on one muni. */
function bboxesIntersect(a, b) {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

/**
 * Defensive dedupe for the survey-grid FC. River-lot features
 * (kind='riverlot') stay as-is because each lot has its own unique
 * identifier; DLS section features collapse to one entry per
 * (section, township, range, direction) regardless of how the label
 * was spelled. Catches any upstream duplication — pre-fix cached
 * data with mixed meridian encodings, accidental whitespace in
 * label strings, future schema changes — and also dedups by
 * polygon centroid as a final fallback if a feature lacks the
 * section/township/range/direction triple in properties.
 *
 * First feature wins; the rest drop.
 */
function dedupSectionLabels(fc) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const f of fc?.features || []) {
    const p = f?.properties || {};
    if (p.kind === 'riverlot') { out.push(f); continue; }
    // Build the dedup key from the section coords if available; fall
    // back to a normalized label; final fallback to a centroid hash
    // so even malformed features dedup if they sit at the same spot.
    let key;
    if (p.section != null && p.township != null && p.range != null) {
      const dir = String(p.direction || '').toUpperCase().replace(/[^EW]/g, '');
      // Quarter is part of the dedup key in quarter-grid mode so the four
      // quarters of a section stay distinct; empty/undefined in section
      // mode where one feature per section is already the goal.
      const quarter = String(p.quarter || '').toUpperCase();
      key = `S${p.section}|T${p.township}|R${p.range}|${dir}|Q${quarter}`;
    } else if (p.label) {
      key = `L:${String(p.label).trim().toUpperCase().replace(/\s+/g, '')}`;
    } else {
      // Centroid key — quantized to ~10m so near-identical polygons
      // collapse.
      const c = centroidKey(f);
      key = c ? `C:${c}` : null;
    }
    if (key && seen.has(key)) { dropped++; continue; }
    if (key) seen.add(key);
    out.push(f);
  }
  console.info(`Sec-Twp Grid: ${fc?.features?.length || 0} features in, `
             + `${out.length} out (${dropped} duplicates dropped).`);
  return { type: 'FeatureCollection', features: out };
}

function centroidKey(f) {
  const coords = f?.geometry?.coordinates?.[0];
  if (!Array.isArray(coords) || coords.length === 0) return null;
  let cx = 0, cy = 0, n = 0;
  for (const c of coords) {
    if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
      cx += c[0]; cy += c[1]; n++;
    }
  }
  if (n === 0) return null;
  return `${(cx / n).toFixed(4)},${(cy / n).toFixed(4)}`;
}

/**
 * Combined Assessment column cell: renders the formatted Total_Value
 * as a link to the parcel's Manitoba Assessment Online report when
 * Asmt_Rpt_Url is present, otherwise renders the value as plain text.
 * Earlier versions had a separate "Asmt Report" column with a 'MAO'
 * link; merging the two cuts a column and gives users a single
 * affordance — the dollar figure itself is the link.
 */
/**
 * Roll # cell: renders Roll_No_Txt as a link to the parcel's
 * Manitoba Assessment Online report when Asmt_Rpt_Url is present,
 * matching the affordance offered by assessmentCell() below. Both
 * cells point at the same MAO URL — appraisers can click whichever
 * value (the roll # or the dollar figure) is closer to where their
 * eye landed. The cost of carrying two links per row is just the
 * extra <a> element; same network behaviour either way.
 */
function rollNumberCell(p) {
  const cell = document.createElement('td');
  const value = p.Roll_No_Txt;
  if (value == null || value === '') {
    cell.textContent = '—';
    cell.classList.add('empty');
    return cell;
  }
  const display = displayRoll(value);
  const safe = safeExternalUrl(p.Asmt_Rpt_Url);
  if (!safe) {
    cell.textContent = display;
    return cell;
  }
  const a = document.createElement('a');
  a.href = safe;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = display;
  a.title = 'Open this parcel on Manitoba Assessment Online';
  a.addEventListener('click', (e) => e.stopPropagation());
  cell.appendChild(a);
  return cell;
}

function assessmentCell(p) {
  const cell = document.createElement('td');
  cell.classList.add('num');
  const value = formatCurrency(p.Total_Value);
  const safe  = safeExternalUrl(p.Asmt_Rpt_Url);
  if (value == null) {
    cell.textContent = '—';
    cell.classList.add('empty');
    return cell;
  }
  if (!safe) {
    cell.textContent = value;
    return cell;
  }
  const a = document.createElement('a');
  a.href = safe;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = value;
  a.title = 'Open this parcel on Manitoba Assessment Online';
  a.addEventListener('click', (e) => e.stopPropagation());
  cell.appendChild(a);
  return cell;
}

function reportCell(url) {
  const cell = document.createElement('td');
  const safe = safeExternalUrl(url);
  if (!safe) {
    cell.textContent = '—';
    cell.classList.add('empty');
    return cell;
  }
  const a = document.createElement('a');
  a.href = safe;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = 'MAO';
  // Don't trigger the row's fly-to handler when the link is clicked.
  a.addEventListener('click', (e) => e.stopPropagation());
  cell.appendChild(a);
  return cell;
}

function scrollToRow(key) {
  const tr = $tbody.querySelector(`tr[data-row-key="${cssEscape(String(key))}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const prev of $tbody.querySelectorAll('tr.row-highlight')) {
    prev.classList.remove('row-highlight');
  }
  tr.classList.remove('row-highlight');
  void tr.offsetWidth;
  tr.classList.add('row-highlight');
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, '\\$&');
}

// ---------- Formatters ----------

/** Show only the short ZONE code (RG, CG, P, etc.) — typically 2-3 letters.
 *  The full ZONE_NAME is still available on the hover popup over a parcel. */
function formatZoneCode(z) {
  if (!z) return null;
  return z.ZONE || z.ZONE_NAME || null;
}

function formatDes(d) {
  if (!d || (!d.DES_NAME && !d.DES_CATEGORY)) return null;
  return d.DES_NAME || d.DES_CATEGORY;
}

/**
 * Build a short summary of any zoning/dev-plan amendments visible on this
 * row's primary (top-1) overlay matches. Each line is one layer; layers
 * with no amendment are omitted, and rows with no amendments at all
 * return null so the cell renders as a dash.
 *
 * Zoning side prefers AMENDMENT_DESCRIPTION when present (the source data
 * sometimes stores the from→to text directly, e.g. "RG8 to RG5"); otherwise
 * falls back to "ZBL → ZBL_A".
 */
/**
 * Treat a value as a real string only if it isn't one of the source's
 * various stand-ins for null: actual nullish, empty/whitespace string,
 * or the literal text "<Null>" / "Null" / "null" (Esri's stringified-
 * null sneaks through some service configs as text). Returns the
 * trimmed string when real, otherwise null.
 */
function formatChanges(row) {
  const parts = [];
  // Read from the changed-polygons-only join (row.zoningChanges /
  // row.devPlanChanges) populated by enrichOverlays so a parcel that
  // intersects a changed polygon as a sliver still shows the change
  // text even when its top-area zoning is unchanged. Falls back to
  // the top-2 display join when zoningChanges is empty so legacy
  // call sites (and basic searches without the changed-join data)
  // still produce something sensible.
  const zoningEntries = (row.zoningChanges?.length ? row.zoningChanges : row.zoning) || [];
  for (const entry of zoningEntries) {
    const z = entry?.feature?.properties || {};
    const amendDesc = realStr(z.AMENDMENT_DESCRIPTION);
    const zbl   = realStr(z.ZBL);
    const zblA  = realStr(z.ZBL_A);
    const zblChanged = zbl && zblA && zbl !== zblA;
    if (zblChanged) {
      parts.push(`Z: ${amendDesc || `${zbl} → ${zblA}`}`);
      break;
    } else if (amendDesc) {
      parts.push(`Z: ${amendDesc}`);
      break;
    }
  }
  const devEntries = (row.devPlanChanges?.length ? row.devPlanChanges : row.devPlan) || [];
  for (const entry of devEntries) {
    const d = entry?.feature?.properties || {};
    const dp  = realStr(d.DP_BYLAW);
    const dpA = realStr(d.DPA_BYLAW);
    if (dp && dpA && dp !== dpA) {
      parts.push(`DP: ${dp} → ${dpA}`);
      break;
    }
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

function formatPercent(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  const pct = ratio * 100;
  if (pct < 0.5) return '<1%';
  return `${Math.round(pct)}%`;
}

/**
 * Compute parcel area in acres from polygon geometry. Roll_Entry's
 * Frontage_or_Area column is sometimes acres, sometimes frontage-feet; the
 * Shape__Area we'd get from the service is in the layer's CRS units (web
 * mercator m²). Computing acreage from the geometry directly with turf is
 * the most consistent approach across rural and urban parcels alike.
 */
function parcelAcres(feature) {
  if (!feature) return null;
  // Lazy-attach the result so we don't recompute on each sort tick.
  if (feature._acres != null) return feature._acres;
  // Two candidate figures:
  //  - the assessor's recorded area (Frontage_or_Area = '5.000 Acres') — the
  //    official value, normally trusted over anything we derive; and
  //  - the geometry area (turf, geodesic on WGS84 — sq m / 4046.8564224 ac;
  //    authalic-radius spherical-excess, accurate to <0.0001% of ellipsoidal).
  // resolveParcelAcres() prefers the assessor figure EXCEPT when it's an
  // implausible nominal placeholder (e.g. '0.01 Acres' on a 357-ac crown/
  // reserve polygon), where it falls back to geometry and flags the parcel.
  const rollAcres = acresFromFrontageField(feature?.properties?.Frontage_or_Area);
  let geomAcres = null;
  if (feature.geometry) {
    try { geomAcres = turfArea(feature) / 4046.8564224; } catch { geomAcres = null; }
  }
  const r = resolveParcelAcres(rollAcres, geomAcres);
  if (r.acres == null) return null;
  feature._acres = r.acres;
  if (feature.properties) {
    feature.properties._acresSource = r.source;
    if (r.rollNominal) {
      feature.properties._acresRollNominal = true;
      feature.properties._rollNominalAcres = r.rollValue;
    }
    // Roll-vs-polygon disagreement. Both figures are kept so the popup and
    // the CSV can show what they actually differ by rather than just
    // asserting that they do.
    if (r.areaMismatch) {
      feature.properties._acresMismatch = true;
      feature.properties._acresVariancePct = r.variancePct;
      feature.properties._acresGeomValue = r.geomValue;
    }
  }
  return r.acres;
}

const formatRollSize = (p) => formatRollSizeField(p?.Frontage_or_Area);

/**
 * Append the area cross-check marker to an Acres cell, if the parcel earned
 * one. No-op on the ~85% that agree, so the column stays clean.
 */
// The roll-vs-polygon area check compares two CURRENT figures. On a row showing
// the at-sale size it would warn about numbers that appear nowhere on screen,
// and on a withheld row there is no size to warn about — so the marker is gated
// on the cell actually showing today's roll figure. See showsCurrentRollSize().
function markAreaCheck(cell, p) {
  if (!cell || !p?._acresMismatch) return;
  if (!showsCurrentRollSize(p)) return;
  const gv = Number(p._acresGeomValue);
  const pct = Number(p._acresVariancePct);
  const flag = document.createElement('span');
  flag.className = 'area-check-flag';
  flag.textContent = '⚠';
  flag.title = `Roll area (${fmtAcres(p._acres)} ac) disagrees with the parcel shape`
    + `${Number.isFinite(gv) ? ` (${gv.toFixed(1)} ac)` : ''}`
    + `${Number.isFinite(pct) ? ` by ${(pct * 100).toFixed(0)}%` : ''}.`
    + ' A few percent is usually survey-vs-mapped boundary difference; a large gap can mean'
    + ' a subdivision or consolidation. Confirm on Manitoba Assessment Online before relying on the figure.';
  cell.appendChild(flag);
}

/**
 * The "Area Check" CSV cell — blank when the assessor area and the polygon
 * agree (the overwhelming majority), otherwise a short phrase naming what the
 * shape measures and how far off it is. Written out in full words because the
 * cell can be read months later by someone who never saw this app.
 */
function areaCheckCsv(p) {
  if (!p) return '';
  if (p._acresRollNominal) {
    const rv = Number(p._rollNominalAcres);
    return `roll area nominal${Number.isFinite(rv) ? ` (states ${rv} ac)` : ''} — showing shape area`;
  }
  if (!p._acresMismatch) return '';
  const gv = Number(p._acresGeomValue);
  const pct = Number(p._acresVariancePct);
  const bits = [];
  if (Number.isFinite(gv)) bits.push(`shape measures ${gv.toFixed(1)} ac`);
  if (Number.isFinite(pct)) bits.push(`${(pct * 100).toFixed(0)}% apart`);
  return `roll disagrees with shape${bits.length ? ` (${bits.join(', ')})` : ''} — verify on MAO`;
}

/**
 * The acreage this row's SIZE columns and unit rates are computed from.
 *
 * Not the same thing as parcelAcres(): that is the parcel as it stands today,
 * which is what the polygon-sampled columns (land cover, soil, cultivation)
 * must keep using because they measure today's shape. The size columns instead
 * have to agree with the $/Acre beside them, and on a sales row that rate
 * divides by the size the pipeline resolved for the sale — see lib/saleSize.js.
 *
 * Returns null on a sales row whose at-sale size was withheld, which is the
 * point: the cell goes blank rather than showing a figure the rate did not use.
 *
 * @param {object} props       the parcel's properties
 * @param {number|null} today  parcelAcres() for this row, already computed
 */
function rowSizeAcres(props, today) {
  return saleSizeState(props) === 'legacy' ? today : saleAcres(props);
}

function formatAcres(v) {
  // One-decimal acres per the Phase 1 number-formatting tokens. The
  // 2-decimal precision that used to live here was an internal
  // preference; appraisers reading the column will still get the
  // thousands separator for large parcels (e.g. "12,345.6").
  return fmtAcres(v);
}

/**
 * Total acres across every parcel in the sale — the land the price actually
 * bought, and the denominator behind the $/Acre cell beside it.
 *
 * Same three-outcome shape as the rate cells, and for the same reason: '—'
 * when a member parcel has no area, because a partial total understates the
 * land and would make $/Acre look high while both numbers read as plausible.
 * Returns null when the row isn't part of a sale at all — td() renders that as
 * an em-dash too, but carrying the `.empty` class, which is how "no sale here"
 * stays distinguishable from "withheld" exactly as it is for $/Acre.
 *
 * A single-parcel sale still gets a figure rather than a blank. It equals the
 * Acres cell, which looks redundant, but a blank here would read as "unknown"
 * on precisely the rows where the total is most certain — and it is what makes
 * the column safe to total or eyeball down a mixed column of single- and
 * multi-parcel sales.
 */
function formatGroupAcres(p) {
  if (!p?._saleGroupSize) return null;
  if (p._saleGroupAcresIncomplete) return '—';
  const total = Number(p._saleGroupTotalAcres);
  if (!Number.isFinite(total) || total <= 0) return null;
  return fmtAcres(total);
}

/**
 * Group SF cell — the same group total in square feet, i.e. the denominator
 * $/SF divides by. Deliberately derived from _saleGroupTotalAcres rather than
 * summed separately: two independent totals over the same parcels could drift
 * apart, and then Group SF ÷ 43,560 would not equal Group Acres on screen.
 *
 * Every withholding rule matches formatGroupAcres, including the em-dash on
 * an incomplete group — a partial total understates the land and would make
 * $/SF beside it read high while both numbers still look plausible.
 */
function formatGroupSf(p) {
  if (!p?._saleGroupSize) return null;
  if (p._saleGroupAcresIncomplete) return '—';
  const total = Number(p._saleGroupTotalAcres);
  if (!Number.isFinite(total) || total <= 0) return null;
  return formatSqFtFromAcres(total);
}

/** Group $/Acre table cell. Returns the formatted dollar string, or
 *  '—' when group acres are incomplete (insufficient data flag set
 *  by computeSaleGroupTotals), or null when the parcel isn't part
 *  of a sale group at all. */
function formatGroupPpa(p) {
  if (!p?._saleGroupSize) return null;
  if (p._saleGroupAcresIncomplete) return '—';
  return fmtCurrency(p._saleGroupPpa);
}

/** Group $/SF table cell. Same shape as formatGroupPpa. $/SF is shown
 *  to two decimals because per-foot prices land in single digits
 *  where rounding to whole dollars would lose meaningful resolution. */
function formatGroupPpsf(p) {
  if (!p?._saleGroupSize) return null;
  if (p._saleGroupAcresIncomplete) return '—';
  const ppsf = Number(p._saleGroupPpsf);
  if (!Number.isFinite(ppsf) || ppsf <= 0) return null;
  return '$' + ppsf.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Group $/FF table cell — sale price ÷ total roll-stated frontage feet.
 *
 * Returns null (an empty cell, not an em-dash) when the roll states an
 * area rather than a frontage, which is the majority of parcels. A dash
 * would read as "we tried and failed"; there is simply no frontage on
 * these records, and ~63% of the grid saying so would be noise.
 *
 * The em-dash IS used for the one case worth flagging: a multi-parcel
 * sale where some members state a frontage and others don't, so a rate
 * could have been computed and was deliberately withheld as misleading.
 *
 * Whole dollars (Jason, 2026-08-12), like $/Acre and $/Lot rather than
 * $/SF. Frontage rates run to hundreds or thousands of dollars a foot,
 * so cents are noise on the end of a figure nobody quotes that precisely.
 */
function formatGroupPpff(p) {
  const state = frontageRateState(p);
  if (state === 'withheld') return '—';
  if (state === 'none') return null;
  return fmtCurrency(p._saleGroupPpff);
}

/** Group $/Lot table cell — sale price ÷ number of parcels in the
 *  group. Doesn't depend on acres so it works even when acres are
 *  incomplete (no '—' fallback needed). */
function formatGroupPpl(p) {
  if (!p?._saleGroupSize) return null;
  return fmtCurrency(p._saleGroupPpl);
}

/** Build the favourites star cell for a row. Click toggles the
 *  in-memory + localStorage favourite state and stops the click
 *  from bubbling up to the row-click handler (which would otherwise
 *  fly the map to the parcel). Cells outside sales-mode are hidden
 *  by CSS — the rendered classes still flip when starred so the
 *  user sees the change immediately on re-toggling sales mode. */
function favoriteCell(row) {
  const cell = document.createElement('td');
  cell.classList.add('sales-only', 'fav-col');
  const key = parcelLegalKey(row?.parcel?.properties || {});
  if (!key) return cell;
  const isFav = favoriteKeys.has(key);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = isFav ? 'fav-star active' : 'fav-star';
  btn.textContent = isFav ? '★' : '☆';
  btn.title = isFav ? 'Unstar — remove from comparables' : 'Star — mark as comparable';
  btn.setAttribute('aria-pressed', String(isFav));
  // Lets the click handler find every row showing this same parcel.
  btn.dataset.favKey = key;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (favoriteKeys.has(key)) favoriteKeys.delete(key);
    else if (favoriteKeys.size < FAV_CAP) favoriteKeys.add(key);
    saveFavorites();
    // Local DOM swap rather than a full re-render — keeps the rest
    // of the table stable and avoids losing scroll position.
    const nowFav = favoriteKeys.has(key);
    // A favourite is a PARCEL, keyed by muni+roll, so a repeat-sold
    // parcel's other sale rows carry the same key and must flip with
    // this one — otherwise the sibling row keeps showing ☆ for a
    // parcel that is now starred, until the next full re-render.
    for (const el of document.querySelectorAll('#results td.fav-col button.fav-star')) {
      if (el.dataset.favKey !== key) continue;
      el.className = nowFav ? 'fav-star active' : 'fav-star';
      el.textContent = nowFav ? '★' : '☆';
      el.title = nowFav ? 'Unstar — remove from comparables' : 'Star — mark as comparable';
      el.setAttribute('aria-pressed', String(nowFav));
      el.closest('tr')?.classList.toggle('starred', nowFav);
    }
    setStarredOnMap(row?.parcel, nowFav);
    refreshRouteStarredBtn();
  });
  cell.appendChild(btn);
  return cell;
}

/**
 * Flip the `starred` map feature-state for a parcel (and every
 * sibling in its sale group, since starring one half of a 2-parcel
 * sale should colour the whole assembly). Reads OBJECTIDs from the
 * sale-group rollIds array stamped by computeSaleGroupTotals; falls
 * back to the parcel's own OBJECTID for single-parcel sales / non-
 * CSV searches. mapReady gates the call so an early invocation (page
 * paint before WebGL init) doesn't drop the state.
 */
function setStarredOnMap(parcel, on) {
  const oids = new Set();
  const groupOids = parcel?.properties?._saleGroupRollIds;
  if (Array.isArray(groupOids)) for (const o of groupOids) if (o != null) oids.add(o);
  const own = parcel?.properties?.OBJECTID;
  if (own != null) oids.add(own);
  if (oids.size === 0) return;
  mapReady.then(() => {
    for (const oid of oids) {
      map.setFeatureState({ source: 'parcels', id: oid }, { starred: !!on });
    }
  });
}

/**
 * Walk every parcel in the current FC and apply the `starred`
 * feature-state to anyone in favoriteKeys. Called after every
 * setMapData so stars persist across re-renders (filter changes,
 * sort changes, fresh uploads of the same CSV). Also walks the
 * rendered rows to apply the .starred class for table shading.
 */
function applyStarredFromFavorites(parcelFc) {
  // Route Starred gating tracks the same events that change starred
  // state on screen — refresh it here even when nothing is starred,
  // so the button correctly disables after an unstar-everything.
  refreshRouteStarredBtn();
  if (favoriteKeys.size === 0) return;
  // Map-side flip
  for (const f of parcelFc?.features || []) {
    const k = parcelLegalKey(f.properties || {});
    if (k && favoriteKeys.has(k)) setStarredOnMap(f, true);
  }
  // Table-side flip (DOM walk for currently-rendered rows)
  for (const tr of document.querySelectorAll('#results tbody tr')) {
    const rowKey = tr.dataset.rowKey;
    const row = rowFeatureMap.get(rowKey);
    const k = row ? parcelLegalKey(row.properties || {}) : null;
    if (k && favoriteKeys.has(k)) tr.classList.add('starred');
  }
}

/**
 * Compute mean ± 2σ thresholds for $/Acre across the rendered rows.
 * Returns `{lo, hi, mean}` (numbers) when ≥3 rows have a finite
 * positive $/Acre value, else null (too few samples to flag).
 *
 * 2σ is the convention for "statistical outlier" — captures ~5% of
 * a normal distribution. For an appraisal comp set that's the right
 * granularity: the typical "this is suspiciously high / low" sale
 * lands well outside 2σ, while typical market variance stays inside.
 */
function computePpaOutlierThresholds(rows) {
  const vals = [];
  for (const r of rows) {
    const v = Number(r?.parcel?.properties?._saleGroupPpa);
    if (Number.isFinite(v) && v > 0) vals.push(v);
  }
  if (vals.length < 3) return null;
  let sum = 0;
  for (const v of vals) sum += v;
  const mean = sum / vals.length;
  let sumSq = 0;
  for (const v of vals) sumSq += (v - mean) * (v - mean);
  const variance = sumSq / vals.length;
  const sigma = Math.sqrt(variance);
  return { mean, lo: mean - 2 * sigma, hi: mean + 2 * sigma };
}

/** Currency value cell — accepts a raw number, returns "$1,234,500"
 *  or null. Used for the per-parcel Land $ / Bldg $ assessment
 *  columns (not the sale-price ones, which already accept strings). */
function formatCurrencyNumber(v) {
  return fmtCurrency(v);
}

/** Building % cell — 0.0853 -> "8.5%". One decimal is enough at
 *  the appraisal granularity the appraiser actually reads here. */
function formatBuildingPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return fmtPercent(n, { fraction: true, decimals: 1 });
}

/** Assessment year cell — just the year as a string, or null. */
function formatAsmtYear(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.trunc(n));
}

/** Distance-to-subject table cell. Renders as km with one decimal
 *  for in-town distances (< 10 km), no decimals for further afield.
 *  Returns null when no subject is set or the distance isn't
 *  computable. */
function formatDistanceKm(p) {
  const d = Number(p?._distanceKm);
  if (!Number.isFinite(d) || d < 0) return null;
  return d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString('en-CA');
}

/** Sale/Assessed ratio table cell. Shows '—' when the group's
 *  assessed total is incomplete (one or more parcels missing
 *  assessment data); null (= empty cell) when the parcel isn't
 *  part of a sale group. Formatted to two decimals — appraisers
 *  read ratios at that precision. */
function formatSaleToAsmt(p) {
  if (!p?._saleGroupSize) return null;
  if (p._saleGroupAsmtIncomplete) return '—';
  const r = Number(p._saleGroupSaleToAsmt);
  if (!Number.isFinite(r) || r <= 0) return null;
  return r.toFixed(2);
}

// Dwelling units — show 0 explicitly (it's a meaningful "vacant" signal,
// not "unknown"). Null/undefined renders as the dash.
function formatDu(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return String(Math.round(n));
}

// Square feet from acres. Always integer with thousands separators.
function formatSf(acres) {
  return formatSqFtFromAcres(acres);
}

// ---------- Subject parcel comparison ----------

/**
 * Read the subject roll # input, derive the muni from the dropdown,
 * fetch the parcel via ROLL_ENTRY, highlight it on the map, and
 * re-stamp distances onto the current CSV row set. Surfaces failures
 * via setCount() so the user sees what went wrong (bad roll, wrong
 * muni, etc.) without opening the console.
 */
async function applySubjectFromInput() {
  const raw = $subjectRoll?.value?.trim();
  // Pick the muni for the subject in priority order:
  //   1. The inline subject-muni dropdown when visible (multi-muni
  //      uploads — user explicitly picks which matched muni)
  //   2. The single matched muni when csvMatchedMunis has just one
  //      entry (unambiguous, so we skip showing the picker)
  //   3. The main muni dropdown's value (regular-search path, no CSV
  //      uploaded yet)
  let muni = '';
  if ($subjectMuniRow && !$subjectMuniRow.hidden && $subjectMuni?.value) {
    muni = $subjectMuni.value;
  } else if (csvMatchedMunis && csvMatchedMunis.length === 1) {
    muni = csvMatchedMunis[0];
  } else {
    muni = $municipality?.value || '';
  }
  if (!raw) {
    setCount('Subject: enter a roll number first.');
    return;
  }
  if (!muni) {
    setCount('Subject: pick a municipality before setting a subject roll.');
    return;
  }
  $subjectApply.disabled = true;
  const prevLabel = $subjectApply.textContent;
  $subjectApply.textContent = '…';
  try {
    const fc = await searchParcels({ municipality: muni, roll: raw });
    const feat = fc?.features?.[0];
    if (!feat) {
      setCount(`Subject: roll ${raw} not found in ${muni}.`);
      return;
    }
    // Stamp _isSubject so the shared popup builder can flag the row
    // with the "Subject parcel" header instead of a sales-style line.
    if (feat.properties) feat.properties._isSubject = true;
    // Try to pull the subject's own assessment record so the popup's
    // Land/Bldg/Year block surfaces for it the same way as a comp.
    // Non-fatal — popup gracefully drops the block if the lookup
    // fails or the parcel isn't in the shard.
    try {
      const key = parcelLegalKey(feat.properties || {});
      if (key) {
        const [muniStr, rollStr] = key.split('|');
        const rec = await lookupAssessment({
          muni_no: Number(muniStr),
          roll_no_txt: rollStr,
        });
        if (rec) {
          feat.properties._asmtLand      = rec.land;
          feat.properties._asmtBuildings = rec.buildings;
          feat.properties._asmtTotal     = rec.total;
          feat.properties._asmtYear      = rec.year;
          feat.properties._asmtPctBldg   = rec.pctBuildings;
          feat.properties._asmtClass     = rec.class || '';
          feat.properties._asmtStatus    = rec.tax_status || '';
        }
      }
    } catch (e) { /* non-fatal */ }
    subjectFeature = feat;
    subjectCentroid = computeCentroid(feat);
    setSubjectData(map, { type: 'FeatureCollection', features: [feat] });
    updateSubjectRadiusRing();
    document.querySelector('.subject-row')?.classList.add('has-subject');
    // If we have CSV rows already, restamp distances and re-render
    // so the new column shows up immediately. Outside CSV mode the
    // column isn't visible anyway, so no-op.
    let refiltered = false;
    if (csvFullRows && csvFullRows.length > 0) {
      stampDistancesFromSubject(csvFullRows);
      refilterCsvIfActive();
      refiltered = true;
    }
    // Only claim the status line when the refilter did not. Setting a subject
    // with a Max km already typed ARMS the distance filter — that pass writes
    // "N of M sales shown (filtered)", and overwriting it here erased the one
    // signal that the radius had done anything, which read as the radius not
    // working at all (Jason, 2026-08-19).
    if (!refiltered) setCount(`Subject set to ${raw} (${muni}). Distance column populated.`);
    // Fly the map to include the subject in view. Keep zoom modest so
    // the surrounding sales stay on-screen.
    mapReady.then(() => flyToFeature(map, feat));
  } catch (err) {
    console.warn('Subject fetch failed', err);
    setCount(`Subject: failed to load (${err.message}).`);
  } finally {
    $subjectApply.disabled = false;
    $subjectApply.textContent = prevLabel || 'Set';
  }
}

/**
 * Wipe the subject highlight + distance column. Called by the Clear
 * button and indirectly by runSearch / clearAll. Safe to call when
 * no subject is set — just no-ops everything.
 */
function clearSubjectParcel() {
  subjectFeature = null;
  subjectCentroid = null;
  if ($subjectRoll) $subjectRoll.value = '';
  document.querySelector('.subject-row')?.classList.remove('has-subject');
  mapReady.then(() => {
    setSubjectData(map, { type: 'FeatureCollection', features: [] });
    setSubjectRadius(map, null, 0);
  });
  if (csvFullRows && csvFullRows.length > 0) {
    for (const r of csvFullRows) {
      if (r?.parcel?.properties) delete r.parcel.properties._distanceKm;
    }
    refilterCsvIfActive();
  }
}

/**
 * Push the current subject + Max-Distance value to the subject-radius
 * map layer. No-ops cleanly when either is absent (so the ring just
 * disappears when the user clears the subject or empties the input).
 * Called whenever the subject or the distance input changes.
 */
function updateSubjectRadiusRing() {
  const km = parseFloat($distanceMax?.value);
  if (!subjectCentroid || !Number.isFinite(km) || km <= 0) {
    mapReady.then(() => setSubjectRadius(map, null, 0));
    return;
  }
  mapReady.then(() => setSubjectRadius(map, subjectCentroid, km));
}

/**
 * Centroid of a parcel polygon — bbox midpoint approximation. We're
 * computing km-scale distances between rural parcels and a subject;
 * the difference between a true centroid-of-mass and the bbox center
 * is below the noise floor at that scale. Avoids pulling in
 * `@turf/center` for one math op.
 */
function computeCentroid(feature) {
  try {
    const [minLon, minLat, maxLon, maxLat] = bboxOfFeature(feature);
    return { lng: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
  } catch {
    return null;
  }
}

/**
 * Haversine distance between two lng/lat points, in kilometres. Plenty
 * of precision for the parcel-to-parcel use case (the spheroidal
 * inaccuracy is < 0.5% at this latitude).
 */
function haversineKm(a, b) {
  if (!a || !b) return NaN;
  const R = 6371; // mean Earth radius, km
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lng - a.lng) * rad;
  const sa = Math.sin(dLat / 2);
  const sb = Math.sin(dLon / 2);
  const c = sa * sa + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * sb * sb;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)));
}

/**
 * Stamp `_distanceKm` onto every parcel in the CSV row set, measured
 * from the current subject's centroid. Falls back to clearing the
 * stamp when no subject is set. Sort + filter pick up the change
 * automatically since they read off `_distanceKm`.
 */
function stampDistancesFromSubject(rows) {
  if (!Array.isArray(rows)) return;
  if (!subjectCentroid) {
    for (const r of rows) if (r?.parcel?.properties) delete r.parcel.properties._distanceKm;
    return;
  }
  for (const r of rows) {
    const f = r?.parcel;
    if (!f) continue;
    const c = computeCentroid(f);
    if (!c) continue;
    f.properties._distanceKm = haversineKm(subjectCentroid, c);
  }
}

/**
 * Render the "Data refreshed:" footer with each shard's
 * `generated_at` timestamp. Lazy on purpose — both helpers
 * await the relevant shard's load before returning a metadata
 * block, so this kicks off the assessment-index fetch (~3.5 MiB
 * gzipped) in the background. Once both promises settle, the
 * footer surfaces whichever sources came back successfully.
 *
 * Format: `Legal: 2026-05-06 · Assessment: 2026-05-10`.
 * Source rows that failed to fetch are silently skipped — the
 * footer is informational, not load-bearing.
 */
async function populateDataRefreshFooter() {
  const $footer = document.getElementById('data-refresh-footer');
  const $list   = document.getElementById('data-refresh-list');
  if (!$footer || !$list) return;
  // Prefer the manifest (a ~2 KB file with every dataset's
  // generated_at). Falls back to the legacy "load the full index
  // and read its metadata" path when the manifest is missing — keeps
  // the footer working in environments where build-manifest.js hasn't
  // run yet (e.g. fresh dev clones before `npm run manifest`).
  const manifest = await getManifest();
  let legalMetaValue = manifest?.datasets?.legal_index || null;
  let asmtMetaValue  = manifest?.datasets?.assessment_index || null;
  if (!legalMetaValue || !asmtMetaValue) {
    const [legalMeta, asmtMeta] = await Promise.allSettled([
      legalMetaValue ? Promise.resolve(legalMetaValue) : getLegalIndexMetadata(),
      asmtMetaValue  ? Promise.resolve(asmtMetaValue)  : getAssessmentIndexMetadata(),
    ]);
    legalMetaValue = legalMetaValue || (legalMeta.status === 'fulfilled' ? legalMeta.value : null);
    asmtMetaValue  = asmtMetaValue  || (asmtMeta.status  === 'fulfilled' ? asmtMeta.value  : null);
  }
  const parts = [];
  const fmt = (raw) => {
    // generated_at comes from R as ISO Zulu (YYYY-MM-DDTHH:MM:SSZ).
    // Show just the date portion — the time is rarely interesting
    // and a UTC timestamp formatted naively confuses the user.
    if (!raw) return '';
    const d = new Date(raw);
    if (!Number.isFinite(d.valueOf())) return '';
    return d.toISOString().slice(0, 10);
  };
  const legalDate = fmt(legalMetaValue?.generated_at);
  const asmtDate  = fmt(asmtMetaValue?.generated_at);
  if (legalDate) parts.push(`<strong>Legal:</strong> ${legalDate}`);
  if (asmtDate)  parts.push(`<strong>Assessment:</strong> ${asmtDate}`);
  // The province's own publish date for the live parcel layer. Deliberately
  // carries its caveat in the tooltip rather than standing as a bare date:
  // the extract trails Manitoba Assessment Online, so a recent publish date
  // does NOT mean an individual roll is current (see
  // fetchRollLayerPublishedDate in arcgis.js for the worked example).
  const rollPublished = await fetchRollLayerPublishedDate();
  if (rollPublished) {
    parts.push(
      `<strong>Provincial roll:</strong> <span class="roll-published" title="`
      + `The province last re-published the parcel layer on ${rollPublished}. `
      + `That is when the extract was posted, not proof that any one roll is current — `
      + `the extract trails Manitoba Assessment Online, so a recent subdivision or `
      + `consolidation can still show its old area and old boundary here. `
      + `Confirm recently-changed parcels on MAO.">${rollPublished}</span>`,
    );
  }
  if (parts.length === 0) return;
  $list.innerHTML = parts.join('<span class="data-refresh-list-sep">·</span>');
  $footer.hidden = false;

  // Staleness banner. Use source_modified (the underlying MAO
  // scrape file's mtime) rather than generated_at (when the R
  // script ran) — the user cares about how old the actual MAO
  // data is, not when we re-built the shard from it. Falls back
  // to generated_at when source_modified isn't present.
  updateStalenessBanner(legalMetaValue, asmtMetaValue);
}

/**
 * Decide whether to show the MAO staleness banner and which tone.
 * Reads the manifest entries for legal_index + assessment_index,
 * picks the oldest source_modified, and delegates the threshold
 * decision to lib/staleness.js (semiannual cadence — see there for
 * why a 1-2 month old scrape is fresh, not a slip).
 */
function updateStalenessBanner(legalMeta, asmtMeta) {
  const banner = document.getElementById('data-staleness-banner');
  if (!banner) return;
  const pickAge = (m) => {
    const raw = m?.source_modified || m?.generated_at;
    if (!raw) return null;
    const d = new Date(raw);
    if (!Number.isFinite(d.valueOf())) return null;
    const ms = Date.now() - d.valueOf();
    return Math.max(0, Math.floor(ms / 86400000));
  };
  const ages = [pickAge(legalMeta), pickAge(asmtMeta)].filter((n) => n != null);
  banner.classList.remove('data-staleness-amber', 'data-staleness-red');
  const state = stalenessBannerState(ages.length ? Math.max(...ages) : null);
  if (!state.show) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.classList.add(state.tone);
  banner.innerHTML = `<strong>${state.lead}</strong>${state.tail}`;
  banner.hidden = false;
}

function parseTotalValue(s) {
  if (s == null || s === '') return null;
  // Roll_Entry stores Total_Value as a string ("$1,234,500" or "1234500"
  // depending on the muni). Strip everything but digits and dot before
  // parsing so both forms work.
  const cleaned = String(s).replace(/[^0-9.]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the sales-CSV Sale Date column into a Date object. The CSV
 * convention is `DD-Mmm-YY` (e.g. "30-Jan-26") with a two-digit year;
 * fall back to Date.parse for anything else (so YYYY-MM-DD / ISO
 * strings still work if the upstream CSV format ever shifts).
 *
 * The two-digit year disambiguates against a 50-year sliding window:
 * 00-49 → 20xx, 50-99 → 19xx. Manitoba sales data is firmly in the
 * 21st century, so this is just defensive.
 *
 * Returns null when the string can't be parsed — callers treat that
 * as "skip the date check" so a malformed date doesn't drop the row.
 */
const SALE_DATE_RE = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/;
const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function parseSaleDate(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = str.match(SALE_DATE_RE);
  if (m) {
    const day = parseInt(m[1], 10);
    const mon = MONTHS[m[2].toLowerCase()];
    let year = parseInt(m[3], 10);
    if (m[3].length === 2) year = (year < 50 ? 2000 : 1900) + year;
    if (Number.isFinite(day) && mon != null && Number.isFinite(year)) {
      const d = new Date(year, mon, day);
      return Number.isFinite(d.valueOf()) ? d : null;
    }
  }
  // Fallback: HTML5 date inputs hand us 'YYYY-MM-DD' directly, and the
  // upstream sales-CSV format could shift to ISO at any point.
  const fallback = new Date(str);
  return Number.isFinite(fallback.valueOf()) ? fallback : null;
}

function formatCurrency(s) {
  return fmtCurrency(parseTotalValue(s));
}

// ---------- Sales Charts tab ----------

/*
 * charts.html plots whatever the Sales Analysis grid is currently
 * showing. Rather than handing it a URL payload or a localStorage blob
 * (either would freeze at open time), the grid pushes its filtered set
 * over a BroadcastChannel on every render — so the tab re-plots as the
 * filters move.
 *
 * What crosses the channel is one record PER SALE, not per parcel: the
 * projection collapses multi-parcel groups so an assembly counts once
 * in every trendline. That also keeps the message small — the grid rows
 * carry full parcel geometry, which has no business being cloned into
 * another tab several times a second.
 */
const CHARTS_CHANNEL_NAME = 'mbps-sales-charts';
let chartsChannel;          // undefined = not yet tried, null = unavailable

function getChartsChannel() {
  if (chartsChannel !== undefined) return chartsChannel;
  try {
    chartsChannel = new BroadcastChannel(CHARTS_CHANNEL_NAME);
    // The tab may open long after the last render, so it asks rather
    // than waiting for the next filter change.
    chartsChannel.addEventListener('message', (e) => {
      if (e.data?.type === 'request') publishSalesCharts();
    });
  } catch {
    chartsChannel = null; // no BroadcastChannel — the button just won't feed
  }
  return chartsChannel;
}

function publishSalesCharts() {
  const channel = getChartsChannel();
  if (!channel) return;
  // Only sales mode has dates and prices to plot. Publishing an empty
  // set on a plain Property Search is deliberate: it clears the tab
  // instead of leaving stale sales on screen next to unrelated results.
  const inSalesMode = $resultsTable?.classList.contains('sales-mode');
  const rows = inSalesMode ? currentRows : [];
  let records = [];
  try {
    records = saleRecordsFromRows(rows, {
      parseDate: parseSaleDate,
      centroid: parcelCentrePoint,
    });
  } catch (err) {
    console.warn('Sales charts projection failed', err);
    return;
  }
  const subjectAcres = subjectFeature ? parcelAcres(subjectFeature) : null;
  try {
    channel.postMessage({
      type: 'sales',
      records,
      meta: {
        parcelCount: rows.length,
        subject: subjectCentroid
          ? {
              lat: subjectCentroid.lat,
              lng: subjectCentroid.lng,
              roll: displayRoll(subjectFeature?.properties?.Roll_No_Txt) || '',
              acres: Number.isFinite(subjectAcres) && subjectAcres > 0 ? subjectAcres : null,
            }
          : null,
        ts: Date.now(),
      },
    });
  } catch (err) {
    // A record that won't structured-clone would otherwise throw on
    // every render and take the grid down with it.
    console.warn('Sales charts publish failed', err);
  }
}

document.getElementById('charts-open')?.addEventListener('click', () => {
  // A named target so clicking twice focuses the existing tab instead of
  // piling up windows that all listen on the same channel.
  let tab = null;
  try { tab = window.open('charts.html', 'mbps-sales-charts'); } catch { tab = null; }
  if (tab) { tab.focus?.(); return; }

  // A null return does NOT reliably mean "popup blocked": some embedded
  // browsers honour the navigation and still hand back null, and there
  // is no way to tell the two apart from here. So rather than guess —
  // and rather than show a "popup blocked" message to someone whose tab
  // just opened fine — synthesize a link click, which is honoured in
  // both cases and is never subject to the popup blocker.
  const link = document.createElement('a');
  link.href = 'charts.html';
  link.target = '_blank';
  // The charts tab talks over a BroadcastChannel, not window.opener, so
  // severing the opener reference costs nothing.
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
});

// ---------- CSV export ----------

function setExportEnabled(enabled) { $export.disabled = !enabled; }

// One warning per session is enough to surface a header/row drift in
// exportCsv without spamming the console once per exported parcel.
let exportColumnMismatchWarned = false;

function exportCsv(explicitRows) {
  // Phase 5: callers can pass an explicit subset (the parcel-summary
  // card's "Export selected" button does this with a one-element
  // array). Falls back to currentRows when nothing is passed.
  const sourceRows = Array.isArray(explicitRows) ? explicitRows : currentRows;
  if (!sourceRows.length) return;
  // Append the sales-CSV-specific columns only when the table is
  // currently in sales-mode — otherwise they'd just be empty trailing
  // cells on every row of a regular search export.
  const inSalesMode = $resultsTable?.classList.contains('sales-mode');
  if (inSalesMode && !salesExportEnrichmentComplete) {
    setCount('Export blocked: soil enrichment did not complete. Retry the sales import.');
    return;
  }
  // Starred-only mode — if any row's parcel is in the favourites
  // set, export only those rows AND every sibling parcel in the
  // same sale group. Starring one half of a 2-parcel sale should
  // pull the other half into the export too, since the appraiser
  // is interested in the WHOLE deal, not just one parcel of it.
  // No starred rows -> fall through to the original full-export.
  // Explicit subsets (Phase 5 Export selected) skip the starred-only
  // expansion — the caller has already chosen the exact set.
  let exportRows = sourceRows;
  let starredOnly = false;
  const allowStarredExpansion = !Array.isArray(explicitRows);
  if (allowStarredExpansion && inSalesMode && favoriteKeys.size > 0) {
    const starredKeys = new Set();
    const starredGroupIds = new Set();
    for (const r of currentRows) {
      const k = parcelLegalKey(r?.parcel?.properties || {});
      if (k && favoriteKeys.has(k)) {
        starredKeys.add(k);
        const gid = r.parcel?.properties?._saleGroupId;
        if (gid != null) starredGroupIds.add(gid);
      }
    }
    if (starredKeys.size > 0) {
      // Expand: any row whose sale group has at least one starred
      // member gets included. Falls back to the per-row key check
      // for rows that aren't part of a sale group (single-parcel
      // searches starred from a non-CSV path).
      exportRows = currentRows.filter((r) => {
        const k = parcelLegalKey(r?.parcel?.properties || {});
        if (k && starredKeys.has(k)) return true;
        const gid = r.parcel?.properties?._saleGroupId;
        if (gid != null && starredGroupIds.has(gid)) return true;
        return false;
      });
      starredOnly = true;
    }
  }
  // Map # is the leftmost column when numbering is on, so the exported
  // spreadsheet's numbers line up with the numbered map the user just
  // generated. Omitted entirely when numbering is off.
  const withSeq = numberingOn;
  const header = [
    ...(withSeq ? ['Map #'] : []),
    'Roll #', 'Muni #', 'Municipality', 'Address',
    'Legal Description', 'Legal Detail', 'Lot', 'Block', 'Plan',
    'Certificates of Title', 'MAO Legal Source URL',
    'Zoning 1 Code', 'Zoning 1 Name', 'Zoning 1 Category', 'Zoning 1 %', 'Zoning 1 By-law',
    'Zoning 2 Code', 'Zoning 2 Name', 'Zoning 2 Category', 'Zoning 2 %', 'Zoning 2 By-law',
    'Dev-Plan Designation', 'Dev-Plan Category', 'Dev-Plan %', 'DP By-law', 'Planning District',
    'MASC Rating', 'MASC Source', 'Risk Area',
    // Dominant-soil pair, mirroring the grid columns.
    'CLI', 'Soil Type',
    // Slope, split so one export serves both jobs: Min/Max are bare
    // numbers to filter and pivot on, Range matches the grid cell, and
    // Summary is the paste-into-the-report sentence. The per-soil
    // backing detail (Soil 1/2/3 Slope + % of Parcel) follows in
    // soilCsvHeaders.
    'Slope Range', 'Slope Min %', 'Slope Max %', 'Slope Summary',
    ...soilCsvHeaders(),
    'Land Cover', 'Cult %', 'Pasture %', 'Bush %', 'Wetland %', 'Other %',
    // Water sits between Land Cover and Tiled, matching the grid's column
    // order. 'Water' is the frontage verdict so a spreadsheet can filter
    // comps on it directly; distance is a bare number for sorting.
    'Water', 'Water Class', 'Water Body', 'Water Type', 'Water Distance (ft)',
    // Tiled / Irrigated lead their groups so a sales spreadsheet can
    // filter or pivot on one column instead of testing whether a licence
    // string is blank.
    'Tiled', 'Tile Licence', 'Tile %', 'Tile Status', 'Tile Applied',
    // No "Irrigation Type" column: only points of use are reported, so
    // it would be the constant "Use" on every populated row.
    'Irrigated', 'Irrigation Licence', 'Irrigation Location', 'Irrigation Supply', 'Irrigation Source',
    'Changes',
    // "Roll Frontage/Area" is the assessor's figure verbatim and leads the
    // size group because it is the primary source — including for the ~37% of
    // parcels stating a frontage in feet, where Acres is only a polygon
    // estimate. "Area Check" carries the roll-vs-shape cross-check: blank when
    // the two agree, otherwise the shape's own measurement and how far apart
    // they are. Both travel beside Acres so a reviewer sees the provenance and
    // the caveat on the same row as the figure.
    'DU', 'Roll Frontage/Area', 'Acres', 'SF', 'Acres Src', 'Area Check',
    csvAssessHeader(currentRows), 'Asmt Report URL',
    'Walkscore URL', 'Flood-Map URL', 'Street View URL',
    ...(inSalesMode
      ? [
          'Sale Date', 'Sale Price', 'Primary Property', 'Sale Type Group', 'N1 ID',
          // Repeat sales: 'Sale # for Parcel' is 1-based, most recent
          // first, so a spreadsheet can filter to first sales only or
          // pair a parcel's transactions without regrouping by roll.
          'Sale # for Parcel', 'Sales for Parcel',
          'Sale Group ID', 'Parcels in Sale', 'Group Rolls',
          'Group Total Sale Price', 'Group Total Acres', 'Group Total SF', 'Group Acres Complete',
          'Group $/Lot', 'Group $/SF', 'Group $/Acre',
          'Group Total Frontage Ft', 'Group $/FF',
          'Group Assessment Total', 'Group Assessment Complete', 'Sale/Asmt',
          // Far-flung diagnostics: how spread out the sale's parcels
          // actually are, and how many munis they touch. Spread Complete
          // is No when a member had no usable geometry, meaning the km
          // figure understates the true spread.
          'Sale Spread (km)', 'Munis in Sale', 'Spread Complete',
          // What the shape-derived columns (Soil, CLI, Slope, Land Cover,
          // Cult %, MASC, Water) actually describe on this row. Blank when the
          // parcel is the one that sold; otherwise it names the parcel they
          // were sampled from, so a figure lifted into a report carries its
          // referent with it. See lib/saleSize.js shapeDerivedNote().
          'Shape-Derived Basis',
          'Dist (km)', 'Asmt Land', 'Asmt Buildings', 'Asmt Bldg %', 'Asmt Year', 'Asmt Class', 'Asmt Status',
        ]
      : []),
    // Geometry, last in every mode and export-only — there are no
    // matching grid columns. Lat/Lon are the parcel's bounding-box
    // midpoint, the same point the popup's GPS Coordinates link copies
    // and the subject-distance is measured from. WKT is the full
    // polygon, which QGIS/ArcGIS load directly as a geometry field.
    'Lat', 'Lon', 'Geometry (WKT)',
  ];
  // Provenance preamble — a `#`-prefixed comment block at the top of the file
  // so the export can stand on its own as appraisal evidence (when/which
  // build/what sources/caveats). Single-column rows, blank-row separated from
  // the table, trivial to delete in a spreadsheet. Best-effort: reads the
  // already-warmed manifest synchronously, omits the freshness line if absent.
  const prov = buildProvenance({
    rowCount: exportRows.length,
    kind: 'csv',
    salesMode: inSalesMode,
    starredOnly,
    manifest: getManifestSync(),
    historical: historicalActive
      ? { active: true, snap: $historicalYear?.value, layerDates: historicalLayerDates($historicalYear?.value) }
      : null,
    // Cite WALLAS only when a row was actually checked against it — both
    // stamps stay undefined until their enrichment runs, so this is false
    // on an export that never touched water rights.
    waterRights: exportRows.some((r) => {
      const q = r.parcel?.properties;
      return q?._tileDrainage !== undefined || q?._irrigation !== undefined;
    }),
  });
  const lines = provenanceCsvLines(prov).map(csvCell);
  lines.push(header.map(csvCell).join(','));
  for (const row of exportRows) {
    const p = row.parcel.properties || {};
    const z1 = row.zoning[0]?.feature.properties || {};
    const z2 = row.zoning[1]?.feature.properties || {};
    const d1 = row.devPlan[0]?.feature.properties || {};
    const ac = parcelAcres(row.parcel);
    // Same split as the grid: acSize follows the sale, ac stays today's
    // figure for the polygon-sampled columns (land cover, soil).
    const acSize = rowSizeAcres(p, ac);
    const cells = [
      ...(withSeq ? [p._seq ?? ''] : []),
      p.Roll_No_Txt, muniNoFromProps(p) ?? '', muniNameFromProps(p) ?? '', p.Property_Address,
      p._legalDescription ?? '',
      p._legalDetail ?? '',
      p._lot ?? '',
      p._block ?? '',
      p._plan ?? '',
      p._certificatesOfTitle ?? '',
      p._legalSourceUrl ?? '',
      // Category exports NORMALIZED, matching the Zoning Type column and
      // the filter. A row the grid shows as "Residential" writing out as
      // "Resdential" would be a discrepancy between the screen and the
      // file, and the file is the one that ends up in a report.
      formatZoneCode(z1), z1.ZONE_NAME ?? '', normalizeZoneCategory(z1.ZONE_CATEGORY) ?? '', ratioPct(row.zoning[0]?.ratio), z1.ZBL ?? '',
      formatZoneCode(z2), z2.ZONE_NAME ?? '', normalizeZoneCategory(z2.ZONE_CATEGORY) ?? '', ratioPct(row.zoning[1]?.ratio), z2.ZBL ?? '',
      formatDes(d1), d1.DES_CATEGORY ?? '', ratioPct(row.devPlan[0]?.ratio), d1.DP_BYLAW ?? '', d1.PLANNINGDISTRICT ?? '',
      p._soilRating ?? '', p._soilQuarter ?? '', p._soilRiskArea ?? '',
      dominantCliLabel(p) ?? '', dominantSoilTypeLabel(p) ?? '',
      ...slopeCsvCells(p),
      ...soilCsvCells(p),
      ...landCoverCsvCells(p, ac),
      ...waterCsvCells(p._water, !!p._waterLoaded),
      ...tileDrainageCsvCells(p),
      ...irrigationCsvCells(p),
      formatChanges(row),
      p.Dwelling_Units ?? '',
      formatRollSize(p),
      formatAcresCsv(acSize),
      acSize != null && Number.isFinite(acSize) && acSize > 0 ? Math.round(acSize * 43560) : '',
      // Where the exported size came from. On a sales row the acreage is the
      // pipeline's, so naming the current record's source ('assessor' /
      // 'geometry') would misattribute it — sizeSourceLabel() reads the Size
      // Source column and distinguishes a property-sales-report figure from a
      // verified-unchanged current one, which is the difference an appraisal
      // has to be able to state.
      sizeSourceLabel(p)
        || (p._acresRollNominal ? 'geometry (roll nominal)' : (p._acresSource ?? '')),
      areaCheckCsv(p),
      parseTotalValue(p.Total_Value) ?? '',
      p.Asmt_Rpt_Url ?? '',
      walkscoreUrl(p),
      floodMapUrl(row),
      streetViewUrl(row.parcel),
      ...(inSalesMode
        ? [
            p._saleDate ?? '',
            p._salePrice ?? '',
            p._primaryProperty ?? '',
            p._saleTypeGroup ?? '',
            p._n1Id ?? '',
            p._saleSeq != null ? Number(p._saleSeq) + 1 : '',
            p._saleCount ?? '',
            p._saleGroupId ?? '',
            p._saleGroupSize ?? '',
            Array.isArray(p._saleGroupRolls) ? p._saleGroupRolls.join(' | ') : '',
            Number.isFinite(p._saleGroupTotalPriceNum) ? Math.round(p._saleGroupTotalPriceNum) : '',
            Number.isFinite(p._saleGroupTotalAcres) ? p._saleGroupTotalAcres.toFixed(3) : '',
            // Rounded to whole feet: the acreage it converts from is only
            // three decimals, so decimals here would be false precision.
            Number.isFinite(p._saleGroupTotalAcres) ? Math.round(p._saleGroupTotalAcres * 43560) : '',
            p._saleGroupSize != null ? (p._saleGroupAcresIncomplete ? 'No' : 'Yes') : '',
            p._saleGroupPpl != null ? Math.round(p._saleGroupPpl) : '',
            p._saleGroupAcresIncomplete ? '' : (p._saleGroupPpsf != null ? p._saleGroupPpsf.toFixed(2) : ''),
            p._saleGroupAcresIncomplete ? '' : (p._saleGroupPpa  != null ? Math.round(p._saleGroupPpa)   : ''),
            // Frontage total is written whenever any member states one, so
            // a blank $/FF beside a non-blank total is legible as "mixed
            // sale, rate withheld" rather than as missing data.
            Number.isFinite(p._saleGroupTotalFrontageFt) && p._saleGroupTotalFrontageFt > 0
              ? p._saleGroupTotalFrontageFt.toFixed(2) : '',
            p._saleGroupPpff != null ? Math.round(p._saleGroupPpff) : '',
            Number.isFinite(p._saleGroupAsmtTotal) ? Math.round(p._saleGroupAsmtTotal) : '',
            p._saleGroupSize != null ? (p._saleGroupAsmtIncomplete ? 'No' : 'Yes') : '',
            p._saleGroupAsmtIncomplete ? '' : (Number.isFinite(p._saleGroupSaleToAsmt) ? p._saleGroupSaleToAsmt.toFixed(2) : ''),
            Number.isFinite(p._saleGroupSpanKm) ? p._saleGroupSpanKm.toFixed(1) : '',
            p._saleGroupMuniCount ?? '',
            p._saleGroupSpanKm == null ? '' : (p._saleGroupSpanIncomplete ? 'No' : 'Yes'),
            shapeDerivedNote(p),
            Number.isFinite(p._distanceKm) ? p._distanceKm.toFixed(2) : '',
            Number.isFinite(p._asmtLand) ? Math.round(p._asmtLand) : '',
            Number.isFinite(p._asmtBuildings) ? Math.round(p._asmtBuildings) : '',
            Number.isFinite(p._asmtPctBldg) ? (p._asmtPctBldg * 100).toFixed(2) : '',
            Number.isFinite(p._asmtYear) ? Math.trunc(p._asmtYear) : '',
            p._asmtClass ?? '',
            p._asmtStatus ?? '',
          ]
        : []),
      // Geometry columns — must stay last, matching the header above.
      parcelLat(row.parcel),
      parcelLon(row.parcel),
      featureToWkt(row.parcel),
    ];
    // The header and the row are two hand-maintained lists that have to
    // stay in lockstep through several mode-conditional spreads. A drift
    // between them silently shifts every later column under the wrong
    // heading — which reads as plausible data, not as a bug. Warn once
    // rather than per row, and still emit the file: a shifted export the
    // user is told about beats no export at all.
    if (cells.length !== header.length && !exportColumnMismatchWarned) {
      exportColumnMismatchWarned = true;
      console.warn(
        `CSV export column mismatch: ${cells.length} cells vs ${header.length} headers. `
        + 'A column was added to one list and not the other — later columns are misaligned.',
      );
    }
    lines.push(cells.map(csvCell).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Filename advertises whether the export is starred-only so the
  // file's purpose reads at-a-glance in the user's downloads folder.
  const suffix = starredOnly ? `-starred-${exportRows.length}` : '';
  a.download = `manitoba-parcels${suffix}-${today()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// CSV uses raw ratio (0-1, four decimals) — spreadsheets can format. The
// table version was rounded to whole percent for display.
function ratioPct(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return v.toFixed(4);
}

function formatAcresCsv(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return v.toFixed(3);
}

/**
 * Generic helper to point an overlay-grid button at an external URL.
 * When `url` is a real http(s) string, the button is enabled, its
 * label becomes the active label, and clicking opens the URL in a
 * new tab. When `url` is null, the button is disabled and labelled
 * with the inactive label (typically "N/A" suffixed).
 */
function setExternalLinkButton(btn, url, activeLabel, inactiveTitle) {
  if (!btn) return;
  // Drop any prior click handler so we don't stack listeners across
  // muni-change events.
  if (btn._extHandler) btn.removeEventListener('click', btn._extHandler);
  const safe = safeExternalUrl(url);
  if (safe) {
    btn.disabled = false;
    btn.textContent = activeLabel;
    btn.title = `Open ${safe} in a new tab`;
    btn.classList.add('active');
    btn._extHandler = () => window.open(safe, '_blank', 'noopener,noreferrer');
    btn.addEventListener('click', btn._extHandler);
  } else {
    btn.disabled = true;
    btn.textContent = `${activeLabel.split(' ')[0]} N/A`;
    btn.title = inactiveTitle;
    btn.classList.remove('active');
    btn._extHandler = null;
  }
}

/** Refresh the RM Website button against the current muni dropdown
 *  selection. Pulls from the static MUNI_WEBSITES mapping. */
function updateMuniWebsiteButton() {
  const muni = $municipality.value;
  if (!muni) {
    setExternalLinkButton($muniWebsiteBtn, null, 'Muni Website ↗', 'Select a municipality to enable');
    return;
  }
  const url = lookupMuniWebsite(muni);
  setExternalLinkButton($muniWebsiteBtn, url, 'Muni Website ↗',
    `No website on file for ${muni}. Add it to MUNI_WEBSITES in main.js.`);
}

/** Muni → Planning District fallback map. Used when the dev-plan
 *  layer returns no features for a search (typical of cities, which
 *  often manage land-use under their own bylaws and don't appear in
 *  the provincial dev-plan polygon set) so the PD Website button
 *  still resolves to the right planning-district URL. Keys are the
 *  exact Muni_Name_With_Typ values from Roll_Entry; values are
 *  PD_WEBSITES keys. Add an entry whenever a real-world city or RM
 *  has no dev-plan coverage but a known PD URL. */
const MUNI_TO_PD = {
  'PORTAGE LA PRAIRIE (CITY)': 'PORTAGE LA PRAIRIE',
  'PORTAGE LA PRAIRIE (RM)':   'PORTAGE LA PRAIRIE',
};

/** After a search lands, infer the parcel set's Planning District from
 *  the dev-plan layer's PLANNINGDISTRICT field (most-frequent value
 *  wins) and look up its URL in PD_WEBSITES. When the dev-plan layer
 *  is empty for the search (common for cities), fall back to the
 *  selected muni's MUNI_TO_PD entry so the button still resolves. */
function updatePdWebsiteButton(devPlanFc) {
  const counts = new Map();
  for (const f of devPlanFc?.features || []) {
    const pd = f.properties?.PLANNINGDISTRICT;
    if (pd) counts.set(pd, (counts.get(pd) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [pd, c] of counts) if (c > bestCount) { best = pd; bestCount = c; }

  // Fallback: map the selected muni to a known PD when no dev-plan
  // features were returned. Lets cities like Portage la Prairie still
  // route to their planning-district URL.
  if (!best) {
    const muni = $municipality.value;
    if (muni && MUNI_TO_PD[muni]) {
      const url = lookupPdWebsite(MUNI_TO_PD[muni]);
      setExternalLinkButton($pdWebsiteBtn, url, 'PD Website ↗',
        `${MUNI_TO_PD[muni]} — no website on file. Add it to PD_WEBSITES in main.js.`);
      return;
    }
    setExternalLinkButton($pdWebsiteBtn, null, 'PD Website ↗',
      'No planning district found in this search\'s dev-plan polygons');
    return;
  }
  const url = lookupPdWebsite(best);
  setExternalLinkButton($pdWebsiteBtn, url, 'PD Website ↗',
    `${best} — no website on file. Add it to PD_WEBSITES in main.js.`);
}

/** Parse the 4-digit year out of Roll_Entry's Asmt_Roll field. Values
 *  look like "2024 Final" / "2025 Preliminary" / "2024 Tax", with the
 *  first 4 digits being the assessment year. Returns null when the
 *  field is missing or malformed. */
function parseAssessmentYear(asmtRoll) {
  if (asmtRoll == null) return null;
  const m = String(asmtRoll).match(/(\d{4})/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Find the most-common assessment year across a result set. */
function dominantAssessmentYear(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    const yr = parseAssessmentYear(row.parcel.properties?.Asmt_Roll);
    if (yr != null) counts.set(yr, (counts.get(yr) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [yr, c] of counts) if (c > bestCount) { best = yr; bestCount = c; }
  return best;
}

/** CSV header label for the Assessment column. Mirrors the table-header
 *  logic so the export carries the same year stamp as what the user saw. */
function csvAssessHeader(rows) {
  const yr = dominantAssessmentYear(rows);
  return yr != null ? `Assess-${yr} ($)` : 'Assessment ($)';
}

/**
 * Update the Total Value column header to "Assess-{year}" using the
 * most-common assessment year (parsed from Asmt_Roll, e.g. "2024
 * Final" → 2024) across the current result set. Falls back to a
 * generic "Assessment" label when no rows have a parseable year.
 */
function updateAssessmentYearHeader(rows) {
  const $hdr = document.getElementById('value-header');
  if (!$hdr) return;
  const yr = dominantAssessmentYear(rows);
  $hdr.textContent = yr != null ? `Assess-${yr}` : 'Assessment';
}

/** Compose the walkscore.com search URL for a parcel, or '' when no
 *  street address is present. Mirrors the table-cell logic so CSV exports
 *  match what the user sees. */
function walkscoreUrl(p) {
  const street = (p.Property_Address || '').trim();
  if (!street) return '';
  const muni = (p.Muni_Name_With_Typ || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return `https://www.walkscore.com/score/${encodeURIComponent([street, muni, 'MB'].filter(Boolean).join(', '))}`;
}

/** Compose the mb-flood-mapping deep-link for a parcel — same lat/lon-
 *  preferring, address-fallback logic as floodCell(). Returns '' when
 *  neither geometry nor address is available. */
function floodMapUrl(row) {
  const p = row.parcel.properties || {};
  const url = new URL('https://mb-flood-mapping.vercel.app/');
  let have = false;
  if (row.parcel.geometry) {
    try {
      const [minLon, minLat, maxLon, maxLat] = bboxOfFeature(row.parcel);
      const lat = (minLat + maxLat) / 2;
      const lon = (minLon + maxLon) / 2;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        url.searchParams.set('lat', lat.toFixed(6));
        url.searchParams.set('lon', lon.toFixed(6));
        have = true;
      }
    } catch { /* fall through */ }
  }
  if (!have && p.Property_Address) {
    const muni = (p.Muni_Name_With_Typ || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    url.searchParams.set('address', [p.Property_Address, muni, 'MB'].filter(Boolean).join(', '));
    have = true;
  }
  if (have && p.Property_Address) url.searchParams.set('label', p.Property_Address);
  return have ? url.toString() : '';
}

// Neutralize spreadsheet formula injection: a cell whose text begins with
// =, +, -, @ (or a leading tab/CR) is interpreted as a formula by Excel /
// Google Sheets, so a poisoned upstream value like `=HYPERLINK(...)` would
// execute on open. Prefix a single quote to force literal-text rendering —
// but leave genuine numbers (e.g. "-5") untouched so numeric columns still
// import as numbers. Shared by csvCell and downloadUnmatchedCsv's `cell`.
function csvGuardFormula(s) {
  if (s && /^[=+\-@\t\r]/.test(s) && !Number.isFinite(Number(s))) {
    return `'${s}`;
  }
  return s;
}

function csvCell(value) {
  if (value == null) return '';
  const s = csvGuardFormula(String(value));
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Hover hints shown on empty (em-dash) cells whose data isn't loaded by a
// plain search, so "—" reads as "not loaded yet" rather than "no data". CLI
// and Soil Type need the soil-survey join, from either entry point; Land Cover
// / Cult % load from a muni-scoped search of > LAND_COVER_MIN_ACRES-acre parcels (no overlay needed).
const CLI_EMPTY_HINT =
  'Pick the Agricultural column preset, or turn on the Soil Productivity/Soil Name overlay, to load soil capability for this municipality.';
const SOIL_EMPTY_HINT =
  'Pick the Agricultural column preset, or turn on the Soil Productivity/Soil Name overlay, to load the soil association for this municipality.';
const SLOPE_EMPTY_HINT =
  'Pick the Agricultural column preset, or turn on the Soil Productivity/Soil Name overlay, to load the soil survey’s slope class for this municipality.';
const LANDCOVER_EMPTY_HINT =
  `Loads automatically on a municipality-scoped search (select the municipality, then search) for parcels over ${LAND_COVER_MIN_ACRES} acres.`;
const TILE_EMPTY_HINT =
  'Pick the Agricultural column preset, or turn on the Tile Drainage overlay, to check these parcels against Manitoba’s licensed tile-drainage areas.';
const IRRIGATION_EMPTY_HINT =
  'Pick the Agricultural column preset, or turn on the Irrigation Licences overlay, to check these parcels against Manitoba’s licensed irrigation points of use and diversion.';
// Shown on a "No record" cell. The point is to stop the cell being read
// as a confident "this land is not tiled / not irrigated" — see
// noLicenceCell.
const NO_TILE_HINT =
  'No licensed tile-drainage area from Manitoba Water Rights Licensing (WALLAS) overlaps this parcel. '
  + 'Licensed works only, and the source polygons run to Aug 2024 — this is not proof the land is undrained.';
/**
 * Minimum share of a parcel a licensed footprint must cover to count as
 * a match at all.
 *
 * ArcGIS's esriSpatialRelIntersects treats edge contact as an
 * intersection, and neighbouring survey polygons share edges by
 * construction, so a licensed area routinely clips the rim of parcels it
 * has nothing to do with. Those produced "<1%" cells, which say nothing
 * true about whether land is drained or watered — roughly half the hits
 * on a filtered RM of Rockwood search were of that kind. Below this
 * threshold the match is discarded outright rather than reported.
 */
const MIN_WATER_COVERAGE = 0.01;   // 1% of parcel area

const NO_IRRIGATION_HINT =
  'No licensed irrigation point of use or diversion from Manitoba Water Rights Licensing (WALLAS) overlaps this parcel. '
  + 'Licensed works only — this is not proof the land is unirrigated.';

function td(value, className, emptyTitle) {
  const el = document.createElement('td');
  if (value == null || value === '') {
    el.textContent = '—';
    el.classList.add('empty');
    if (emptyTitle) {
      el.title = emptyTitle;
      el.classList.add('empty-hint');
    }
  } else if (value instanceof Element) {
    el.appendChild(value);
  } else {
    el.textContent = value;
  }
  if (className) el.classList.add(className);
  return el;
}

/**
 * Phase 5: small inline pill that wraps a categorical cell value
 * (zoning code, amendment status, vacant proxy). Returns null for
 * empty / falsy input so callers can keep using `td(null)` to
 * render the em-dash placeholder.
 */
function badge(text, badgeClass) {
  if (text == null) return null;
  const s = String(text);
  if (s === '' || s === '—') return null;
  const span = document.createElement('span');
  span.className = `badge ${badgeClass}`;
  span.textContent = s;
  return span;
}
