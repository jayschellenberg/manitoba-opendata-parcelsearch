// Tailwind v4 entry — picked up by the @tailwindcss/vite plugin. The
// import has no runtime export; it exists so Vite processes the file
// and emits the generated stylesheet alongside the legacy style.css.
import './lib/tailwind.css';

// Phase 3 sidebar tabs.
import { initSidebarTabs, setActiveTab } from './lib/tabs.js';

// Phase 4 form controls.
import { initChipInput } from './lib/chipInput.js';
import { initInfoIcons } from './lib/infoIcon.js';
import { initParcelListImport } from './lib/parcelListImport.js';
import { initSalesPasteImport } from './lib/salesPasteImport.js';
// Route planner — TSP solver + Mapbox client.
import { solveRoute, haversineMatrix } from './lib/routeSolver.js';
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
import { initColumns, applyVisibility as applyColumnVisibility, setColumnVisible } from './lib/columns.js';

// Phase 6 URL state — serialises a small set of form values into the
// query string so a session URL is shareable.
import { encodeState, decodeState } from './lib/urlState.js';
import { setOverlayPressed } from './lib/overlayToggle.js';
import { stalenessBannerState } from './lib/staleness.js';
import { computeSaleGroups, groupPosition } from './lib/saleGroups.js';
import {
  realStr,
  legalDisplay,
  parseTitleNumbers,
  dominantCliLabel,
  dominantSoilTypeLabel,
} from './lib/cellFormat.js';
import { filterMascRiverlotsForMuni } from './lib/muniIdentity.js';
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
  joinTopNByArea,
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
} from './arcgis.js';
import {
  quartersToFc,
  sectionLinesFromRows,
  quarterLinesFromRows,
  surveyFcToRows,
  masccolor,
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
  setMascData,
  setMascRiverlotsData,
  setMascVisible,
  setCliAgrData,
  setCliAgrVisible,
  setCliPaintMode,
  decodeSoilDescriptor,
  setMascRiskAreasData,
  setMascRiskAreasVisible,
  setSurveyGridData,
  setSurveyGridVisible,
  setLandCoverVisible,
  setHistoricalData,
  setHistoricalVisible,
  setLandCoverRasterVisible,
  setLandCoverRasterOpacity,
  flyToFeature,
  buildZoneCodePaint,
  parcelHtml,
  setSubjectData,
  setSubjectRadius,
} from './map.js';
import { generateParcelSnapshotsZip } from './snapshotExport.js';
import { OUTPUT_MIME, OUTPUT_QUALITY, MAX_OUTPUT_DIM } from './lib/imageOutput.js';
import { dominantBucket, cultFraction, LAND_COVER_BUCKETS, LAND_COVER_MIN_ACRES } from './lib/landcover.js';
import { resolveParcelAcres } from './lib/acres.js';
import { computeSizeChanges } from './lib/sizeChange.js';
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
// (Acres/Sq Ft pill removed — size filter is permanently acres.)
// Sales-CSV "Vacant land only" filter — strict group semantics. Reads
// _saleGroupAllVacant which computeSaleGroupTotals stamps after the
// per-parcel assessment-index lookup runs in handleSalesUpload.
const $vacantOnly    = document.getElementById('vacant-only');
const $saleAsmtMax   = document.getElementById('sale-asmt-max');
// Sales-CSV sale-date range. Both inputs accept HTML5 date strings
// (YYYY-MM-DD); empty values are interpreted as "no minimum"/"no
// maximum" respectively. Sale-date strings from the CSV go through
// parseSaleDate() to be compared apples-to-apples.
const $saleDateFrom  = document.getElementById('sale-date-from');
const $saleDateTo    = document.getElementById('sale-date-to');
// Sales-CSV class + status filters. Options populated post-upload from
// the matched parcels' dominant class/status (assessmentIndex.js
// uniqueClassesAndStatuses helper). Empty = no filter.
const $asmtClass     = document.getElementById('asmt-class');
const $asmtStatus    = document.getElementById('asmt-status');
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
// Sales-mode $/Acre filter — pair of bounds against the
// _saleGroupPpa stamped by computeSaleGroupTotals. Useful for
// flushing out development-land sales that trade at a much higher
// rate per acre than rural / farm comps.
const $salesPpaLow   = document.getElementById('sales-ppa-low');
const $salesPpaHigh  = document.getElementById('sales-ppa-high');
const $search        = document.getElementById('search');
const $clear         = document.getElementById('clear');
const $export        = document.getElementById('export');
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
const $cliToggle     = document.getElementById('cli-toggle');
const $cliLegend     = document.getElementById('cli-legend');
const $landcoverToggle = document.getElementById('landcover-toggle');
const $landcoverLegend = document.getElementById('landcover-legend');
const $gridToggle    = document.getElementById('grid-toggle');
const $historicalToggle   = document.getElementById('historical-toggle');
const $historicalYear     = document.getElementById('historical-year');
const $historicalYearWrap = document.getElementById('historical-year-wrap');
const $historicalBanner   = document.getElementById('historical-banner');
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
 * Contact Directory — every muni with a published website is here.
 * Munis whose only published contact is an email (Ethelbert, Grand
 * Rapids, Leaf Rapids, Mystery Lake) intentionally have no entry, so
 * the Muni Website button reads "Muni N/A" for those.
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
  'CARMAN (TOWN)':               'https://www.carmandufferin.ca/',
  'CHURCHILL (TOWN)':            'https://www.churchill.ca/',
  'GILLAM (TOWN)':               'https://www.townofgillam.com/',
  'GRAND RAPIDS (TOWN)':         'https://townofgrandrapidsmb.ca/',
  'LAC DU BONNET (TOWN)':        'https://www.townoflacdubonnet.com/',
  'LEAF RAPIDS (TOWN)':          'https://leafrapids.com/',
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
  'DUFFERIN (RM)':               'https://www.carmanmanitoba.ca/',
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
  'BRENDA-WASKADA (MUNICIPALITY)':         'https://www.waskada.org/',
  'CARTWRIGHT-ROBLIN (MUNICIPALITY)':      'https://cartwrightroblin.com/',
  'CLANWILLIAM-ERICKSON (MUNICIPALITY)':   'https://www.ericksonmb.ca/',
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
  'LORNE (MUNICIPALITY)':                  'https://www.rmoflorne.ca/',
  'LOUISE (MUNICIPALITY)':                 'https://www.louisemb.com/',
  'MCCREARY (MUNICIPALITY)':               'https://www.exploremccreary.com/',
  'MINITONAS-BOWSMAN (MUNICIPALITY)':      'https://www.minitonas-bowsman.ca/',
  'MOSSEY RIVER (MUNICIPALITY)':           'https://www.mosseyrivermunicipality.com/',
  'NORFOLK TREHERNE (MUNICIPALITY)':       'https://www.treherne.ca/',
  'NORTH CYPRESS-LANGFORD (MUNICIPALITY)': 'https://www.rmofnorthcypress.ca/',
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
  'SWAN VALLEY WEST (MUNICIPALITY)':       'https://www.munswanvalleywest.ca/',
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
  'BROKENHEAD RIVER':                  'https://www.brpd.ca/',
  'CARMAN-DUFFERIN-GREY':              'https://www.cdgplanning.com/',
  'CYPRESS':                           'https://www.cypressplanningdistrict.com/',
  'EASTERN INTERLAKE':                 'https://www.eipd.ca/',
  'KEYSTONE':                          'https://www.keystonepd.ca/',
  'MID-WEST':                          'https://www.midwestplanning.ca/',
  'MORDEN/STANLEY/THOMPSON/WINKLER':   'https://www.mstw.ca/',
  'M.S.T.W':                           'https://www.mstw.ca/',
  'MSTW':                              'https://www.mstw.ca/',
  'NEEPAWA & AREA':                    'https://www.neepawaareaplanning.com/',
  'PORTAGE LA PRAIRIE':                'https://www.ptgplanningdistrict.ca/',
  'RHINELAND, PLUM COULEE GRETNA, ALTONA': 'https://www.rpgamb.ca/',
  'RHINELAND PLUM COULEE GRETNA ALTONA':   'https://www.rpgamb.ca/',
  'RPGA':                              'https://www.rpgamb.ca/',
  'RED RIVER':                         'https://www.rrpd.ca/',
  'SOUTH CENTRAL':                     'https://www.scpd.ca/',
  'SOUTH INTERLAKE':                   'https://www.sipd.ca/',
  'TRANS CANADA WEST':                 'https://www.tcwpd.ca/',
  'TRI-ROADS':                         'https://www.triroads.ca/',
  // PDs administered through a member RM rather than their own site —
  // pointed at the RM's planning page so the button still reaches the
  // right office:
  'LAC DU BONNET':                     'https://www.lacdubonnet.com/',
  'LAKESHORE':                         'https://www.rmofdauphin.ca/',
  'MACDONALD - RITCHOT':               'https://www.ritchot.com/',
  'MACDONALD-RITCHOT':                 'https://www.ritchot.com/',
  'MOUNTAIN VIEW':                     'https://www.gilbertplains.net/',
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
// CSV-upload mode state. csvFullRows holds the full enriched row set
// from the last sales-CSV upload (with zoning / dev-plan / risk-area
// data joined in), so changing the Other Searches filters after upload
// can re-filter against the same data without another round-trip.
// null means "not in CSV mode" — Other Searches filter changes do
// nothing in that state, matching the old runSearch-only behaviour.
let csvFullRows = null;
let csvFullBaseMsg = '';
// Full list of munis matched by the last sales-CSV upload — populated
// in handleSalesUpload, cleared on runSearch. When non-null, the
// MASC and CLI overlay toggles fetch+merge across every muni in this
// list rather than scoping to the single dropdown value. The dropdown
// still drives the dominant-muni affordances (Muni Website, PD
// Website, Roll Layer), but the soil overlays cover the full upload.
let csvMatchedMunis = null;

// Imported parcel list. Populated by the "Import list…" modal once
// the resolver returns parcelKeys; runSearch reads this in front of
// the legal-search branch and feeds the keys straight into
// searchParcels({parcelKeys}). null = not in list mode (normal
// muni/roll/legal flow); non-null Array<{muni_no, roll_no_txt}> means
// the next Search will fetch exactly those parcels across whichever
// munis the resolver identified. Cleared by the pill's × button or by
// a page reload (clearAll() reloads, so it resets implicitly).
let listParcelKeys = null;
// The unresolved rows from the same import — surfaced in the
// unmatched-records drawer (renderUnmatchedPanel) so the user can see
// at a glance which input rows didn't resolve and why.
let listUnresolvedRows = null;
// Sale-group tagging for an imported sales list: Map("muni_no|roll_no_txt"
// → groupId) built from the resolver's output for any stacked multi-parcel
// sale (one Consideration, several rolls). runSearch stamps _saleGroupId
// from this onto the fetched parcels so computeSaleGroupTotals + the map's
// group shade / hover-sibling highlight treat them as one sale. null when
// the import had no multi-parcel groups.
let listSaleGroupByKey = null;

// Route planner state. routeStart is { lng, lat } once the user has
// clicked the map. routeResult holds the last calculated TSP order +
// geometry + per-leg metrics for both the on-screen panel and the
// print itinerary. routeRoundTrip mirrors the panel toggle. All three
// reset when the import-list pill is cleared.
let routeStart = null;
let routeResult = null;
let routeRoundTrip = true;

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

// ---------- Column sort ----------

let currentSort = { col: 'roll', dir: 'asc' };

const SORT_KEYS = {
  roll:    (r) => strKey(r.parcel.properties.Roll_No_Txt),
  // Muni # is the MAO authority code (e.g. 600 for RM of Headingley).
  // Numeric sort so 600 lines up between 500 and 700, not between 6
  // and 7 as a string sort would put it.
  municode: (r) => finiteOrNeg(muniNoFromProps(r.parcel.properties)),
  address: (r) => strKey(r.parcel.properties.Property_Address),
  legal:   (r) => strKey(legalDisplay(r.parcel.properties)),
  title:   (r) => strKey(r.parcel.properties._certificatesOfTitle),
  zone1:   (r) => strKey(r.zoning[0]?.feature.properties.ZONE),
  zone1pct:(r) => finiteOrNeg(r.zoning[0]?.ratio),
  zone2:   (r) => strKey(r.zoning[1]?.feature.properties.ZONE),
  zbl:     (r) => strKey(r.zoning[0]?.feature.properties.ZBL),
  dev1:    (r) => strKey(r.devPlan[0]?.feature.properties.DES_NAME),
  dpbylaw: (r) => strKey(r.devPlan[0]?.feature.properties.DP_BYLAW),
  // Sort by MASC rating (A best → J worst). Empty cells go last.
  soil:     (r) => strKey(r.parcel.properties._soilRating),
  riskarea: (r) => finiteOrNeg(r.parcel.properties._soilRiskArea),
  // CLI capability + Soil Type sort by the dominant soil's
  // AGRI_CAP / SOILNAME from the stamped composition. Empty
  // composition (no Soil Survey / CLI overlay loaded) sorts last
  // via the ￿ sentinel in strKey.
  clicls:   (r) => strKey(dominantCliLabel(r.parcel.properties)),
  soiltype: (r) => strKey(dominantSoilTypeLabel(r.parcel.properties)),
  // Land cover sorts by the dominant bucket's label; Cult % sorts on
  // the numeric cultivated fraction. Both read the per-parcel
  // `_landCover` stamp (only present on farmland parcels over the threshold);
  // parcels without it sort last (strKey sentinel / finiteOrNeg -1).
  landcover: (r) => strKey(dominantBucket(r.parcel.properties._landCover)?.label),
  cultpct:   (r) => finiteOrNeg(cultFraction(r.parcel.properties._landCover)),
  changes: (r) => strKey(formatChanges(r)),
  du:      (r) => finiteOrNeg(r.parcel.properties.Dwelling_Units),
  acres:   (r) => finiteOrNeg(parcelAcres(r.parcel)),
  sf:      (r) => finiteOrNeg(parcelAcres(r.parcel)),
  // Walkscore column is just a link — sort by whether we have an address
  // to send to walkscore.com (rows without an address sort last).
  walk:    (r) => strKey(r.parcel.properties.Property_Address),
  // Flood column sorts on whether the parcel has any geometry-derivable
  // location at all (lat/lon centroid OR a usable street address); rows
  // that can't deep-link sort last.
  flood:   (r) => strKey(r.parcel.geometry ? '1' : r.parcel.properties.Property_Address),
  value:   (r) => finiteOrNeg(parseTotalValue(r.parcel.properties.Total_Value)),
  report:  (r) => strKey(r.parcel.properties.Asmt_Rpt_Url),
  saledate:    (r) => strKey(r.parcel.properties._saleDate),
  saleprice:   (r) => finiteOrNeg(parseTotalValue(r.parcel.properties._salePrice)),
  groupsize:    (r) => finiteOrNeg(r.parcel.properties._saleGroupSize),
  grouppricelot:(r) => finiteOrNeg(r.parcel.properties._saleGroupPpl),
  grouppriceac: (r) => finiteOrNeg(r.parcel.properties._saleGroupPpa),
  grouppricesf: (r) => finiteOrNeg(r.parcel.properties._saleGroupPpsf),
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
});

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

  // Bucket by normalized muni name; drop rows whose name or roll is bad.
  const byMuni = new Map(); // normName → [{ lineNo, roll }]
  for (const r of rows || []) {
    const norm = normalizeMuniFromCsv(r.muniName);
    if (!norm) {
      unresolvedByLine.set(r.lineNo, `Municipality not recognised: "${r.muniName}"`);
      continue;
    }
    const roll = canonicalRoll(String(r.roll || ''));
    if (!roll) {
      unresolvedByLine.set(r.lineNo, 'Row has no usable roll #');
      continue;
    }
    if (!byMuni.has(norm)) byMuni.set(norm, []);
    byMuni.get(norm).push({ lineNo: r.lineNo, roll });
  }

  // One live lookup per muni. A fetch error drops that muni's rows to
  // unresolved with the reason rather than letting them vanish silently.
  await Promise.all([...byMuni.entries()].map(async ([muni, recs]) => {
    const rollList = [...new Set(recs.map((r) => r.roll))].join(',');
    let fc = { features: [] };
    try {
      fc = await searchParcels({ municipality: muni, roll: rollList });
    } catch (err) {
      for (const r of recs) unresolvedByLine.set(r.lineNo, `Lookup failed for ${muni}: ${err.message || err}`);
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
      if (hit) resolvedByLine.set(r.lineNo, hit);
      else unresolvedByLine.set(r.lineNo, `Roll ${displayRoll(r.roll)} not found in Roll Entry for ${muni}`);
    }
  }));

  return { resolvedByLine, unresolvedByLine };
}

// Build the "muni_no|roll_no_txt" → groupId map the highlight path reads
// to shade multi-parcel sale groups. Only entries with a real groupId
// (the stacked multi-parcel rows) are kept; returns null when the import
// had no groups so runSearch can skip the stamping pass entirely.
function buildListGroupKeyMap(resolved) {
  const map = new Map();
  for (const r of resolved || []) {
    if (r.groupId == null) continue;
    if (!Number.isFinite(Number(r.muniNo)) || !r.roll) continue;
    map.set(`${Number(r.muniNo)}|${String(r.roll)}`, r.groupId);
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
  onResolved: ({ parcelKeys, resolved, unresolved, stats }) => {
    if (!parcelKeys || parcelKeys.length === 0) {
      // Nothing usable — surface the failure inline and don't enter
      // list mode (the existing muni/roll inputs stay live).
      const reason = unresolved?.[0]?.reason
        || 'No rows could be resolved to a parcel.';
      setCount(`Import: 0 of ${stats?.total ?? 0} rows resolved — ${reason}`);
      listParcelKeys = null;
      listUnresolvedRows = unresolved || [];
      listSaleGroupByKey = null;
      renderListPill();
      renderListUnresolvedDrawer();
      return;
    }
    listParcelKeys = parcelKeys;
    listUnresolvedRows = unresolved || [];
    listSaleGroupByKey = buildListGroupKeyMap(resolved);
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
    listUnresolvedRows = null;
    listSaleGroupByKey = null;
    renderListPill();
    renderListUnresolvedDrawer();
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
$routePlanTrigger?.addEventListener('click', openRoutePanel);
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
$mascToggle.addEventListener('click', () => toggleMascOverlay());
$cliToggle.addEventListener('click', () => toggleCliOverlay());
if ($landcoverToggle) $landcoverToggle.addEventListener('click', () => toggleLandCoverOverlay());
if ($historicalToggle) $historicalToggle.addEventListener('click', () => toggleHistoricalOverlay());
if ($historicalYear) $historicalYear.addEventListener('change', () => onHistoricalYearChange());
initHistoricalSnapshots();
$gridToggle.addEventListener('click', () => toggleSurveyGridOverlay());
setTimeout(() => restoreUrlOverlays(initialUrlState), 0);

const $staticMapBtn     = document.getElementById('static-map-btn');
const $staticMapOutput  = document.getElementById('static-map-output');
const $staticMapSection = document.getElementById('static-map-section');
if ($staticMapBtn) $staticMapBtn.addEventListener('click', generateStaticMap);

// Parcel Snapshots (ZIP) — render a 1600×900 satellite JPEG of each result
// parcel (highlighted, fit to 16:9) and download them all as one ZIP named
// muniCode-roll.jpg. Enabled whenever the current result set is non-empty,
// so it serves both entry points the user asked for: an imported parcel
// list, and Sales Analysis after importing a list.
const $snapshotBtn = document.getElementById('snapshot-zip-btn');
let snapshotRunning = false;
let snapshotAbort = null;
if ($snapshotBtn) $snapshotBtn.addEventListener('click', handleSnapshotExport);

function snapshotResultCount() {
  return (lastResultFc?.features || []).filter((f) => f?.geometry).length;
}

function updateSnapshotButton() {
  if (!$snapshotBtn) return;
  if (snapshotRunning) return; // mid-run label/handler owns the button
  const n = snapshotResultCount();
  $snapshotBtn.disabled = n === 0;
  $snapshotBtn.textContent = 'Parcel Snapshots (ZIP)';
  $snapshotBtn.title = n === 0
    ? 'Import a parcel list or run a search first, then generate one satellite JPEG per result parcel.'
    : `Generate ${n} satellite JPEG${n === 1 ? '' : 's'} (1600×900, highlighted, 16:9) and download as a ZIP named muniCode-roll.jpg.`;
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
    const { blob, count } = await generateParcelSnapshotsZip(fcSnapshot, {
      signal: snapshotAbort.signal,
      fetchSurveyGrid: buildSurveyGridForSnapshot,
      provenanceText: snapProvText,
      onProgress: ({ done, total }) => {
        $snapshotBtn.textContent = `Capturing ${done}/${total}… (click to cancel)`;
      },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `parcel-snapshots-${stamp}.zip`);
    setCount(`Saved ${count} parcel snapshot${count === 1 ? '' : 's'} to parcel-snapshots-${stamp}.zip.`);
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
 * Build the section/township (DLS) grid FC for one muni, for the snapshot
 * export. Resolves the muni's boundary polygon from the loaded boundaries
 * FC (exact match on MUNI_LIST_NAME_WITH_TYPE, then a tolerant normalized
 * match — the parcel FC carries Roll-Entry's Muni_Name_With_Typ, which can
 * differ in punctuation/accents from the boundary field), fetches the
 * survey grid scoped to that polygon, and converts it to section-bbox grid
 * lines — the same per-muni pipeline toggleSurveyGridOverlay() uses.
 * Returns null when the boundaries FC hasn't loaded or the muni can't be
 * matched, in which case that muni's snapshots simply omit the grid.
 */
async function buildSurveyGridForSnapshot(muniName) {
  if (!muniName || !muniBoundariesFc?.features) return null;
  let feat = muniBoundariesFc.features.find(
    (f) => f.properties?.MUNI_LIST_NAME_WITH_TYPE === muniName,
  );
  if (!feat) {
    const key = normalizeMuniKey(muniName);
    feat = muniBoundariesFc.features.find(
      (f) => normalizeMuniKey(f.properties?.MUNI_LIST_NAME_WITH_TYPE) === key,
    );
  }
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
  // currently visible — basemap (CARTO Positron or Esri Imagery), zoning,
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
  return out.toDataURL(OUTPUT_MIME, OUTPUT_QUALITY);
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
  // Zoom the map to the selected muni's bounds so the user lands in
  // the right place before running a search. Skipped if either the
  // boundaries FC hasn't loaded yet or the selection cleared.
  zoomMapToSelectedMuni();
});

/**
 * Fly the map to the bounding box of the currently-selected muni in
 * the dropdown. No-op when no muni is selected, when the boundaries
 * FC hasn't loaded yet, or when no matching feature exists. The
 * boundaries FC matches the dropdown value via MUNI_LIST_NAME_WITH_TYPE
 * (same field already used elsewhere for spatial joins).
 */
function zoomMapToSelectedMuni() {
  const muni = $municipality.value;
  if (!muni || !muniBoundariesFc) return;
  const feat = muniBoundariesFc.features?.find(
    (f) => f.properties?.MUNI_LIST_NAME_WITH_TYPE === muni
  );
  if (!feat) return;
  mapReady.then(() => flyToFeature(map, feat));
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
// Other Searches filters re-filters the displayed table + map subset
// against the loaded sales without re-fetching. Outside CSV mode
// these listeners are no-ops (Search button still drives the SQL).
for (const el of [
  $zoneCategory, $changedStatus, $duMode, $duMin, $sizeLow, $sizeHigh, $vacantOnly,
  $saleDateFrom, $saleDateTo, $asmtClass, $asmtStatus, $distanceMax, $salesPlan,
  $salesStreetName, $salesPpaLow, $salesPpaHigh, $saleAsmtMax,
].filter(Boolean)) {
  el.addEventListener('change', refilterCsvIfActive);
  el.addEventListener('input',  refilterCsvIfActive);
}
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

// Date-range quick-preset buttons. Click "12 mo" -> set sale-date-from
// to 12 months ago, sale-date-to to today, fire input events so the
// filter re-runs. Click × to clear both. Today's date comes from
// new Date() — fine for local-time appraisal use, no timezone games.
function applyDatePreset(monthsBack, clear) {
  if (!$saleDateFrom || !$saleDateTo) return;
  if (clear) {
    $saleDateFrom.value = '';
    $saleDateTo.value = '';
  } else {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm   = String(today.getMonth() + 1).padStart(2, '0');
    const dd   = String(today.getDate()).padStart(2, '0');
    const toIso = `${yyyy}-${mm}-${dd}`;
    const back = new Date(today);
    back.setMonth(back.getMonth() - monthsBack);
    const fy = back.getFullYear();
    const fm = String(back.getMonth() + 1).padStart(2, '0');
    const fd = String(back.getDate()).padStart(2, '0');
    $saleDateFrom.value = `${fy}-${fm}-${fd}`;
    $saleDateTo.value = toIso;
  }
  $saleDateFrom.dispatchEvent(new Event('input', { bubbles: true }));
  $saleDateTo.dispatchEvent(new Event('input', { bubbles: true }));
}
for (const btn of document.querySelectorAll('.date-preset-btn')) {
  btn.addEventListener('click', () => {
    const monthsBack = parseInt(btn.dataset.months || '0', 10);
    const clear = btn.dataset.clear === '1';
    applyDatePreset(monthsBack, clear);
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
(async () => {
  try {
    const fc = await fetchMunicipalBoundaries();
    muniBoundariesFc = fc;
    await mapReady;
    setMuniBoundariesData(map, fc);
  } catch (err) {
    console.warn('muni boundaries fetch failed (non-fatal)', err);
  }
})();

async function populateDropdowns() {
  try {
    // Probe live muni list + live record count + the local snapshot
    // manifest in parallel. The snapshot is the static dump produced by
    // r/build_rollentry_snapshot.R; main.js flips into snapshot mode
    // (parcel queries routed to per-muni shards by arcgis.js) when live
    // is incomplete AND the snapshot is available.
    const [liveMunis, zoneCats, snapshotManifest, liveRecordCount] = await Promise.all([
      fetchMunicipalityList(),
      fetchZoneCategoryList(),
      probeRollEntrySnapshot(),
      fetchRollEntryCount(),
    ]);
    const liveCount = Array.isArray(liveMunis) ? liveMunis.length : 0;
    const snapshotMuniCount = snapshotManifest ? Object.keys(snapshotManifest.munis || {}).length : 0;
    const incomplete = liveRollEntryIncomplete(liveCount, liveRecordCount, snapshotManifest);

    // Pick the dropdown source. In snapshot mode the snapshot's full muni
    // list is the right truth source — listing 18 live munis when the
    // snapshot has all 186 would leave the user unable to even SELECT
    // most of Manitoba.
    let dropdownMunis = liveMunis;
    if (incomplete && snapshotMuniCount > 0) {
      setRollEntrySnapshot(snapshotManifest);
      dropdownMunis = Object.keys(snapshotManifest.munis).sort();
    } else {
      setRollEntrySnapshot(null);
    }
    fillSelect($municipality, dropdownMunis, 'Any municipality');
    fillSelect($zoneCategory, zoneCats, 'Any zoning category');
    updateRollEntryBanner({
      liveCount, liveRecordCount, snapshotManifest,
      snapshotActive: !!getRollEntrySnapshot(),
    });
  } catch (err) {
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
// Served from the mb-parcel-data repo via jsDelivr (pinned commit —
// see MB_PARCEL_DATA_CDN in arcgis.js), not from web/public/data/.
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
  // Drop the sales-mode column reveal if a previous run came from a
  // sales CSV upload — a normal search shouldn't carry those columns.
  if ($resultsTable) $resultsTable.classList.remove('sales-mode');
  // Hide the size-range + vacant-only filter rows since they're CSV-only.
  document.body.classList.remove('sales-mode');
  // Reset the sales-only filter inputs so the next upload starts
  // unfiltered. clearAll already does a full page reload, but a
  // regular Search reuses the page — explicit reset matches existing
  // pattern.
  if ($vacantOnly)    $vacantOnly.checked = false;
  if ($saleDateFrom)  $saleDateFrom.value = '';
  if ($saleDateTo)    $saleDateTo.value = '';
  if ($distanceMax)   $distanceMax.value = '';
  if ($salesPlan)     $salesPlan.value = '';
  if ($salesStreetName) $salesStreetName.value = '';
  if ($salesPpaLow)   $salesPpaLow.value = '';
  if ($salesPpaHigh)  $salesPpaHigh.value = '';
  // Multi-select: clear all selected options so the filter goes back
  // to "any" rather than carrying over the last upload's picks.
  if ($asmtClass)     [...$asmtClass.options].forEach((o) => { o.selected = false; });
  if ($asmtStatus)    [...$asmtStatus.options].forEach((o) => { o.selected = false; });
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
    duMode:          $duMode.value,
    duMin:           $duMin.value,
  };
  const hasLegalSearch = hasLegalCriteria(legalInputs);
  const hasList = Array.isArray(listParcelKeys) && listParcelKeys.length > 0;

  if (!Object.values(inputs).some(Boolean) && !hasLegalSearch && !hasList) {
    setCount('Enter at least one search field.');
    clearTable();
    setMapData(EMPTY_FC, EMPTY_FC, EMPTY_FC);
    return;
  }

  setBusy(true);
  setCount('Searching Roll Entry…');
  clearTable();
  setMapData(EMPTY_FC, EMPTY_FC, EMPTY_FC);

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

    // Multi-parcel imported sales: stamp the shared group id resolved at
    // import time, then reuse the sales-group rollup so the map shades
    // each group (parcel-fill's _saleGroupSize branch) and the
    // hover-sibling highlight lights up its members. No-op unless the
    // import carried a stacked multi-parcel sale.
    if (hasList && listSaleGroupByKey) {
      for (const f of parcelFc.features || []) {
        const key = parcelLegalKey(f.properties || {});
        const gid = key ? listSaleGroupByKey.get(key) : null;
        if (gid != null) f.properties._saleGroupId = gid;
      }
      computeSaleGroupTotals(parcelFc);
    }

    const n = parcelFc.features.length;

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
      const importedTotal = listParcelKeys.length + (listUnresolvedRows?.length || 0);
      const unresolvedTail = listUnresolvedRows?.length
        ? ` · ${listUnresolvedRows.length} unresolved (see panel)`
        : '';
      countLabel = `${n} of ${importedTotal} imported parcels plotted${unresolvedTail}`;
    } else {
      countLabel = isBulkRollSearch
        ? `${n} of ${rollList.length} rolls matched`
        : `${n} parcels found`;
    }
    const baseMsg = capNotes.length
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

    // Show parcels-only rows immediately so the user sees something.
    renderTable(parcelFc.features.map((p) => ({ parcel: p, zoning: [], devPlan: [] })));
    setMapData(parcelFc, EMPTY_FC, EMPTY_FC);

    // Auto-show the muni-wide parcel fabric so the search results
    // sit in their surrounding context. Done up front (not gated on
    // enrichment finishing) so the user gets context immediately.
    if (inputs.municipality && !$muniParcelsToggle.disabled
        && !$muniParcelsToggle.classList.contains('active')) {
      toggleAuxOverlay('muniParcels');
    }

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
      renderEnrichButton(parcelFc, inputs, baseMsg);
    } else {
      await enrichOverlays(parcelFc, inputs, baseMsg);
    }
  } finally {
    setBusy(false);
  }
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
      // Stamp sale info onto each matched feature, keyed by canonical
      // Roll_No_Txt.
      const saleByRoll = new Map();
      for (const r of recs) {
        const k = canonicalRoll(r.rollNumber);
        if (k) saleByRoll.set(k, r);
      }
      const matchedRollSet = new Set();
      let matched = 0;
      for (const f of fc.features || []) {
        const roll = f.properties?.Roll_No_Txt;
        const sale = roll ? saleByRoll.get(roll) : null;
        if (sale) {
          matchedRollSet.add(roll);
          // Group date/price: parseSalesCsv already copied the
          // primary's saleDate + consideration onto every member of
          // the group, so reading them here works regardless of
          // whether this row was the primary or a continuation.
          f.properties._saleDate        = sale.saleDate || null;
          f.properties._salePrice       = sale.consideration || null;
          f.properties._primaryProperty = sale.primaryProperty || null;
          // CSV's raw "Legal Description" cell. Lives alongside the
          // legal-index-derived _plan/_legalDescription so the Plan #
          // filter can fall back to substring-matching against the
          // CSV-supplied text when the legal-index has no record for
          // this roll (e.g. Headingley sales 6163 / 6165 carry
          // "6--66600" / "4--66600" in the CSV but no legal-index hit
          // → _plan is null and the filter would otherwise miss them).
          f.properties._csvLegal        = sale.legalDescription || null;
          // Group identity for the on-hover sibling-highlight + the
          // group price-per-acre / price-per-sf table columns. Used
          // by handleSalesUpload's group-totals pass below.
          f.properties._saleGroupId  = sale.groupId;
          f.properties._saleIsPrimary = sale.isPrimary;
          matched++;
        }
      }
      // Identify the records the API didn't return — Roll_No_Txt
      // simply not in Roll_Entry for this muni (most common cause:
      // typo / old roll / wrong muni assignment in the source CSV).
      const unmatchedHere = [];
      for (const r of recs) {
        const k = canonicalRoll(r.rollNumber);
        if (k && !matchedRollSet.has(k)) {
          unmatchedHere.push({
            ...r,
            reason: `Roll # not found in Roll_Entry for ${muni}`,
          });
        }
      }
      return { muni, fc, total: recs.length, matched, unmatched: unmatchedHere };
    });
    const results = await Promise.all(fetches);

    // Merge all FCs into one parcelFc. Per-muni unmatched buckets fold
    // into the global unmatchedRecords list so the panel surfaces all
    // three reasons (empty / muni-unrecognised / not-in-Roll-Entry) in
    // a single place.
    const parcelFc = { type: 'FeatureCollection', features: [] };
    let totalMatched = 0;
    let totalRequested = 0;
    for (const r of results) {
      parcelFc.features.push(...(r.fc.features || []));
      totalMatched += r.matched;
      totalRequested += r.total;
      unmatchedRecords.push(...(r.unmatched || []));
    }

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

    // Render parcels-only rows immediately, then run the same
    // overlay enrichment pipeline runSearch uses (respecting the same
    // ENRICHMENT_THRESHOLD threshold).
    renderTable(parcelFc.features.map((p) => ({ parcel: p, zoning: [], devPlan: [] })));
    setMapData(parcelFc, EMPTY_FC, EMPTY_FC);

    // Single combined "N unmatched" suffix that pairs with the panel
    // below the count line — the panel surfaces the per-row reasons
    // (empty, muni-unrecognised, not-in-Roll-Entry) so the count text
    // doesn't have to break it down inline.
    const unmatchedNote = unmatchedRecords.length > 0
      ? ` · ${unmatchedRecords.length} unmatched (see panel)`
      : '';
    const baseMsg = `${totalMatched} of ${records.length} sales plotted${unmatchedNote}`;
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
    const matchedByMuni = results
      .filter((r) => r.matched > 0)
      .slice()
      .sort((a, b) => b.matched - a.matched || a.muni.localeCompare(b.muni));
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

    // Phase 7 follow-up: zoning + dev-plan enrichment is now deferred
    // until the user toggles those overlays in Map Layers. The
    // upload-time fetch was the dominant cost of a sales CSV import
    // — for a multi-muni upload it could take 10+ seconds on a cold
    // cache. Skipping it makes the upload feel instantaneous; the
    // table zoning columns are blank until the user clicks Zoning,
    // and the Zoning toggle handler runs the enrichment lazily then.
    // Kept the inputsMuni / fakeInputs object built above so the
    // enrichment can be triggered on demand without re-deriving.
    pendingOverlayEnrichInputs = fakeInputs;

    // Mirror runSearch's auto-toggle of the Roll Layer when a single
    // muni is in scope — gives the user the surrounding parcel
    // fabric for context without an extra click. Skipped for multi-
    // muni uploads (see comment above the dominant-muni block).
    if (isSingleMuni && dominantMuni
        && $muniParcelsToggle && !$muniParcelsToggle.disabled
        && !$muniParcelsToggle.classList.contains('active')) {
      toggleAuxOverlay('muniParcels');
    }

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

    // Populate the Class + Tax-Status filter dropdowns from the
    // upload's matched parcels. Reuses the existing fillSelect helper
    // so the 'Any …' placeholder + sorted-unique options behave the
    // same as the Zoning category dropdown. Re-run on every upload
    // since the available values depend on which parcels matched.
    const { classes, statuses } = uniqueClassesAndStatuses(parcelFc);
    if ($asmtClass)  fillSelect($asmtClass,  classes,  'Any class');
    if ($asmtStatus) fillSelect($asmtStatus, statuses, 'Any status');

    // Subject muni picker. Visible only when the upload spans 2+ munis
    // — single-muni uploads use that muni implicitly so the picker
    // would just be a one-option dropdown. Default the selection to
    // the dominant muni (the one with the most matched parcels), so
    // a user typing a subject roll without touching the picker gets
    // the most-likely-correct muni.
    if ($subjectMuni && $subjectMuniRow) {
      if (csvMatchedMunis && csvMatchedMunis.length > 1) {
        $subjectMuni.innerHTML = '';
        for (const m of csvMatchedMunis) {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          $subjectMuni.appendChild(opt);
        }
        // dominantMuni is the highest-matched-count muni captured
        // earlier in this function — fall back to the first matched
        // muni if it's not in scope here for any reason.
        const defaultMuni = dominantMuni || csvMatchedMunis[0];
        if ([...$subjectMuni.options].some((o) => o.value === defaultMuni)) {
          $subjectMuni.value = defaultMuni;
        }
        $subjectMuniRow.hidden = false;
      } else {
        $subjectMuniRow.hidden = true;
      }
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
    return;
  }
  const munis = new Set(listParcelKeys.map((k) => Number(k.muni_no)));
  const n = listParcelKeys.length;
  const m = munis.size;
  $label.textContent = `Imported list: ${n} parcel${n === 1 ? '' : 's'} across ${m} municipalit${m === 1 ? 'y' : 'ies'}`;
  $row.hidden = false;
  $panel?.classList.add('list-mode-active');
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
  for (const row of currentRows || []) {
    const f = row?.parcel;
    if (!f?.geometry) continue;
    const bb = bboxOfFeature(f);
    if (!Number.isFinite(bb[0])) continue;
    const lng = (bb[0] + bb[2]) / 2;
    const lat = (bb[1] + bb[3]) / 2;
    const p = f.properties || {};
    out.push({
      lng,
      lat,
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
    $status.innerHTML = `Start: <strong>${routeStart.lng.toFixed(5)}, ${routeStart.lat.toFixed(5)}</strong>`;
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
  setRouteStart(map, routeStart);
  refreshRouteStartStatus();
  refreshCalculateEnabled();
  setCount(`Start set at ${routeStart.lng.toFixed(5)}, ${routeStart.lat.toFixed(5)}.`);
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
  const msg = filtered.length === total
    ? csvFullBaseMsg
    : `${filtered.length} of ${total} sales shown (filtered)`;
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

function filterCsvRowsByOtherSearches(rows) {
  const zoneCat = $zoneCategory?.value || '';
  const status  = $changedStatus?.value || '';
  const duMode  = $duMode?.value || '';
  const duMin   = parseInt($duMin?.value || '', 10);

  // Size range — Lo Ac / Hi Ac are always interpreted as acres
  // (the Sq Ft pill was removed; the simplified appraisal workflow
  // never wanted the unit toggle in practice). Empty Lo → 0;
  // empty Hi → ∞. Filter only fires when at least one bound is a
  // finite positive number; both empty is a no-op so users who
  // haven't touched the inputs aren't surprised by parcels
  // disappearing.
  const sizeLoAcRaw = parseFloat($sizeLow?.value);
  const sizeHiAcRaw = parseFloat($sizeHigh?.value);
  const sizeActive = Number.isFinite(sizeLoAcRaw) || Number.isFinite(sizeHiAcRaw);
  const sizeLoAc = Number.isFinite(sizeLoAcRaw) ? sizeLoAcRaw : 0;
  const sizeHiAc = Number.isFinite(sizeHiAcRaw) ? sizeHiAcRaw : Infinity;

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

  // Class + status filters — multi-select. Read the selected <option>
  // values into a Set for O(1) lookup. Empty set = no filter on that
  // axis. Any parcel missing assessment data is excluded when at
  // least one option is selected, matching the original single-select
  // behaviour.
  const classFilterSet = $asmtClass
    ? new Set([...$asmtClass.selectedOptions].map((o) => o.value).filter(Boolean))
    : new Set();
  const statusFilterSet = $asmtStatus
    ? new Set([...$asmtStatus.selectedOptions].map((o) => o.value).filter(Boolean))
    : new Set();

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

  return rows.filter((row) => {
    const p = row.parcel?.properties || {};

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

    // $/Acre filter — bounds against the sale-group rate. Rows
    // missing _saleGroupPpa (no acres data, or sale rate couldn't
    // be computed) drop out when the filter is active, mirroring
    // the size-range and date "missing = exclude" semantics.
    if (ppaActive) {
      const ppa = Number(p._saleGroupPpa);
      if (!Number.isFinite(ppa) || ppa < ppaLo || ppa > ppaHi) return false;
    }

    // DU filter — directly on the parcel field, no enrichment needed.
    if (duMode === 'zero') {
      const du = Number(p.Dwelling_Units);
      if (!(Number.isFinite(du) && du === 0)) return false;
    } else if (duMode === 'min' && Number.isFinite(duMin) && duMin > 0) {
      const du = Number(p.Dwelling_Units);
      if (!(Number.isFinite(du) && du >= duMin)) return false;
    }

    // Vacant-land filter (sales-CSV mode only — checkbox is hidden
    // outside sales-mode but the predicate works regardless). Strict
    // group semantics: the entire sale group must be flagged
    // _saleGroupAllVacant, which is true only when every parcel in
    // the group has assessment data AND passes the vacancy predicate
    // (Buildings < 2% of Total). Sales with one or more parcels
    // missing assessment data fall through `_saleGroupVacantUnknown`
    // and get treated as 'not known to be vacant' — they drop out.
    if ($vacantOnly?.checked) {
      if (p._saleGroupAllVacant !== true) return false;
      // Max Sale/Asmt ratio cap. Gated by Vacant Only because
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
    if (sizeActive) {
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

    // Tax-status filter (multi-select). Same shape as the class
    // filter above.
    if (statusFilterSet.size > 0) {
      if (!p._asmtStatus || !statusFilterSet.has(p._asmtStatus)) return false;
    }

    // Distance-from-subject filter. Sales without a computed
    // _distanceKm are dropped when the filter is active — they'd be
    // ambiguous and the safe default is "exclude unknown."
    if (distActive) {
      const d = Number(p._distanceKm);
      if (!Number.isFinite(d) || d > distMaxRaw) return false;
    }

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

/**
 * Tiny CSV parser tuned for the sales-export format Jason sends:
 *   Sale Date, Consideration, Municipality, Roll Number,
 *   Street Address, Legal Description, Primary Property
 *
 * Returns an array of `{saleDate, consideration, municipality,
 * rollNumber, streetAddress, legalDescription, primaryProperty}`
 * objects. Quoted fields with embedded commas (e.g. "$425,000") are
 * handled correctly. Rows missing both Roll Number AND Municipality
 * are silently dropped.
 */
function parseSalesCsv(text) {
  // Sniff the delimiter so a block pasted straight from Excel / the
  // assessment table (tab-separated, and full of commas inside the
  // Consideration cells like "$720,000") parses the same as a real
  // comma CSV file. Tab wins whenever it's present on the first
  // non-empty line; otherwise fall back to comma.
  const rows = parseCsvRows(text, detectSalesDelimiter(text));
  if (rows.length < 2) return [];
  const header = rows[0].map((c) => String(c || '').trim().toLowerCase());
  const idx = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };
  // Header aliases — both human-readable ("Sale Date") and no-space
  // ("SaleDate") variants accepted, plus a few common short forms.
  // Headers are lowercased before comparison so the matching is
  // case-insensitive across all variants.
  const i = {
    saleDate:        idx('sale date', 'saledate', 'date'),
    consideration:   idx('consideration', 'sale price', 'saleprice', 'price'),
    municipality:    idx('municipality', 'muni'),
    rollNumber:      idx('roll number', 'rollnumber', 'roll #', 'roll'),
    streetAddress:   idx('street address', 'streetaddress', 'address'),
    legalDescription: idx('legal description', 'legaldesc', 'legaldescription', 'legal'),
    primaryProperty: idx('primary property', 'primaryprop', 'primaryproperty'),
  };
  if (i.rollNumber < 0 || i.municipality < 0) return [];

  // Multi-parcel sales: a row with a Sale Date or Consideration starts
  // a new sale group; rows that follow it with BOTH fields blank are
  // continuation parcels in the same sale (the date/price applies to
  // the whole group). Each record gets a sequential `groupId`, an
  // `isPrimary` flag (true on the row that carried the date+price),
  // and the group's date+price copied onto every member so downstream
  // code doesn't need to hunt the primary.
  const out = [];
  let groupCounter = 0;
  let currentGroup = null;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const rollRaw      = (row[i.rollNumber]      || '').trim();
    const muni         = (row[i.municipality]    || '').trim();
    const saleDate     = i.saleDate      >= 0 ? (row[i.saleDate]      || '').trim() : '';
    const consideration= i.consideration >= 0 ? (row[i.consideration] || '').trim() : '';
    if (!rollRaw || !muni) continue;
    const hasSaleData = saleDate !== '' || consideration !== '';
    if (hasSaleData || currentGroup == null) {
      groupCounter++;
      currentGroup = {
        id: groupCounter,
        saleDate,
        consideration,
      };
    }
    out.push({
      saleDate:         currentGroup.saleDate,
      consideration:    currentGroup.consideration,
      municipality:     muni,
      rollNumber:       rollRaw,
      streetAddress:    i.streetAddress    >= 0 ? (row[i.streetAddress]    || '').trim() : '',
      legalDescription: i.legalDescription >= 0 ? (row[i.legalDescription] || '').trim() : '',
      primaryProperty:  i.primaryProperty  >= 0 ? (row[i.primaryProperty]  || '').trim() : '',
      groupId:          currentGroup.id,
      isPrimary:        hasSaleData,
    });
  }
  return out;
}

/** Sniff the row delimiter for a sales block. Tab wins when the first
 *  non-empty line carries one (the Excel/assessment-table copy-paste
 *  workflow), otherwise comma (a genuine CSV file). Keeping this
 *  separate from the tokenizer means the paste and file paths share
 *  exactly one detection rule. */
function detectSalesDelimiter(text) {
  const firstLine = String(text || '').split(/\r\n|\r|\n/).find((l) => l.trim()) || '';
  return firstLine.includes('\t') ? '\t' : ',';
}

/** Generic delimited-row tokenizer — handles quoted fields with embedded
 *  delimiters, escaped double-quotes (""), and \r\n / \n / \r line
 *  endings. `delimiter` is a single character (',' or '\t'). Returns an
 *  array of arrays. */
function parseCsvRows(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => {
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += c; i++; }
    } else if (c === '"') {
      inQuotes = true; i++;
    } else if (c === delimiter) {
      pushField(); i++;
    } else if (c === '\r' || c === '\n') {
      pushField(); pushRow();
      if (c === '\r' && text[i + 1] === '\n') i += 2; else i++;
    } else {
      field += c; i++;
    }
  }
  if (field !== '' || row.length > 0) { pushField(); pushRow(); }
  return rows;
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
async function enrichOverlays(parcelFc, inputs, baseMsg) {
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
    [zoningFc, devPlanFc, riskAreaFc] = await Promise.all([
      fetchZoningOverlap(parcelFc, overlayOpts),
      fetchDevPlanOverlap(parcelFc, overlayOpts),
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
  if (inputs.municipality) {
    zoningLayerLoadedFor = inputs.municipality;
    devPlanLayerLoadedFor = inputs.municipality;
  } else {
    zoningLayerLoadedFor = null;
    devPlanLayerLoadedFor = null;
  }
  rebuildZoningLegend(zoningFc);
  updatePdWebsiteButton(devPlanFc);

  const zoningTop2  = joinTopNByArea(parcelFc, zoningFc, 2);
  const devPlanTop2 = joinTopNByArea(parcelFc, devPlanFc, 2);
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
  const zoningChanges  = joinTopNByArea(parcelFc, zoningChangedFc, 3);
  const devPlanChanges = joinTopNByArea(parcelFc, devPlanChangedFc, 3);
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

  // Attach the pre-baked dominant MASC soil rating for each parcel
  // (per-muni shard built by r/build_parcel_masc.R). Lazy: skipped
  // when the muni isn't in the index (urban-only munis don't get a
  // shard). Falls through silently on network or parse errors so a
  // missing shard never blocks the search.
  if (inputs.municipality) {
    try {
      const dict = await fetchParcelMascForMuni(inputs.municipality);
      if (dict) {
        for (const row of rows) {
          const roll = row.parcel.properties?.Roll_No_Txt;
          const hit  = roll ? dict[roll] : null;
          if (hit) {
            row.parcel.properties._soilRating = hit.rating || null;
            row.parcel.properties._soilQuarter = soilSourceLabel(hit);
          }
        }
      }
    } catch (err) {
      console.warn('parcel-MASC enrichment failed (non-fatal):', err);
    }
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

  // Stamp the most-common assessment year into the Total Value column
  // header so users can tell which assessment cycle the dollar figure
  // is anchored to.
  updateAssessmentYearHeader(rows);

  renderTable(rows);
  setMapData(parcelFc, zoningFc, devPlanFc);
  setCount(baseMsg);
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
  mapReady.then(() => {
    showResults(map, parcelFc, opts);
    setZoningData(map, zoningFc);
    setDevPlanData(map, devPlanFc);
  });
  scheduleSoilCompositionStamp(parcelFc);
  // Stash the current result set so the Parcel Snapshots export can render
  // each parcel without re-querying. Covers both entry points the user
  // asked for: imported-list searches and sales-CSV uploads both funnel
  // their parcelFc through here.
  lastResultFc = parcelFc;
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
 * Driven off the CLI overlay's loaded FC — composition stamps when
 * the CLI overlay is on (either capability OR identity mode) and the
 * fetched soil polygons are available.
 *
 * `repush` defaults to re-pushing through showResults (the search-
 * results parcel source); callers driving a different source (e.g.
 * the Roll Layer's muni-parcels source) pass their own re-push fn.
 */
function scheduleSoilCompositionStamp(parcelFc, { repush } = {}) {
  if (cliMode === null) return;
  if (!lastCliFc?.features?.length) return;
  const defaultRepush = () => mapReady.then(() => showResults(map, parcelFc, { fit: false }));
  const doRepush = repush || defaultRepush;
  beginCliOp('Composing…');
  const run = () => {
    try {
      stampSoilCompositionOnParcels(parcelFc, lastCliFc);
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
// Phase 7 follow-up: stored CSV-upload enrichment inputs so the
// Zoning / Dev plan toggle handlers can lazily enrich the loaded
// CSV's parcels on first activation. Cleared on Clear / refresh.
let pendingOverlayEnrichInputs = null;
let csvOverlayEnriched = false;

/**
 * Lazy enrichment after a CSV upload. Fires once when the user
 * first toggles Zoning or Development plan — stamps each parcel's
 * top-2 zoning + dominant dev-plan + coverage % onto the feature
 * so the table's zoning columns populate.
 */
async function ensureCsvOverlayEnrichment() {
  if (csvOverlayEnriched) return;
  if (!pendingOverlayEnrichInputs) return;
  if (!csvFullRows || csvFullRows.length === 0) return;
  const fc = { type: 'FeatureCollection', features: csvFullRows.map((r) => r.parcel) };
  setCount('Loading zoning + dev-plan for uploaded sales…');
  try {
    // enrichOverlays builds and returns a fresh `rows` array with
    // .zoning / .devPlan / .zoningChanges / .devPlanChanges
    // populated per parcel; merge those fields back onto our
    // csvFullRows entries so renderTable sees them.
    const enrichedRows = await enrichOverlays(fc, pendingOverlayEnrichInputs, 'Sales loaded');
    if (Array.isArray(enrichedRows)) {
      const byOid = new Map();
      for (const er of enrichedRows) {
        const oid = er?.parcel?.properties?.OBJECTID;
        if (oid != null) byOid.set(oid, er);
      }
      for (const row of csvFullRows) {
        const oid = row?.parcel?.properties?.OBJECTID;
        const er = oid != null ? byOid.get(oid) : null;
        if (!er) continue;
        row.zoning         = er.zoning || [];
        row.devPlan        = er.devPlan || [];
        row.zoningChanges  = er.zoningChanges || [];
        row.devPlanChanges = er.devPlanChanges || [];
      }
    }
    csvOverlayEnriched = true;
    refilterCsvIfActive();
  } catch (err) {
    console.warn('Lazy overlay enrichment failed (non-fatal):', err);
  }
}

async function toggleOverlay(which) {
  const btn = which === 'zoning' ? $zoningToggle : $devplanToggle;
  const label = which === 'zoning' ? 'Zoning' : 'Development plan';
  const wasActive = btn.classList.contains('active');
  const visible = !wasActive;
  setOverlayPressed(btn, visible);

  await mapReady;

  if (!visible) {
    setOverlayBtnLabel(btn, label);
    applyOverlayVisibility(which, false);
    return;
  }

  // Phase 7 follow-up: lazy CSV-overlay enrichment. First time the
  // user toggles Zoning or Dev plan after a CSV upload, stamp the
  // top-2 zoning + dev-plan onto each parcel so the table's zoning
  // columns populate. Fires once per upload.
  if (pendingOverlayEnrichInputs && !csvOverlayEnriched) {
    ensureCsvOverlayEnrichment().catch(() => {});
  }

  // Determine the muni scope for the layer fetch. Sales-CSV mode
  // covers EVERY matched muni; outside sales mode it's the dropdown's
  // single value. The cache key is the joined muni list so a dropdown
  // change within sales mode doesn't trigger a refetch.
  const munisRaw = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.slice()
    : ($municipality.value ? [$municipality.value] : []);
  const munis = [...new Set(munisRaw.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const loadKey = munis.join('|');
  const loadedFor = which === 'zoning' ? zoningLayerLoadedFor : devPlanLayerLoadedFor;
  const cachedFc  = which === 'zoning' ? lastZoningFc        : lastDevPlanFc;
  const haveData  = (cachedFc?.features?.length || 0) > 0;
  const needFetch = munis.length > 0 && loadedFor !== loadKey;

  if (needFetch) {
    btn.disabled = true;
    setOverlayBtnLabel(btn, 'Loading…');
    try {
      // Per-muni bulk fetch in parallel — every matched muni gets its
      // full zoning / dev-plan fabric, merged into one FC for the
      // layer source so the user sees overlay coverage across the
      // entire sales-CSV upload (not just the dominant muni's parcels).
      const fcs = await Promise.all(munis.map((m) => (
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
  } else if (munis.length === 0 && !haveData) {
    // No muni selected and nothing cached from a previous search —
    // revert the toggle and tell the user what to do.
    setOverlayPressed(btn, false);
    setOverlayBtnLabel(btn, label);
    setCount(`Select a municipality to load the ${label}.`);
    return;
  }

  setOverlayBtnLabel(btn, label);
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
 *   flow    — MHTIS Traffic Flow 2019 (FeatureServer polylines, AADT-coloured)
 *   highways — Manitoba Road Network 2023 (FeatureServer polylines)
 *   riskAreas — official MASC crop-insurance risk-area polygons
 *
 * These are lazily fetched on first activation and cached through the
 * shared localStorage cache. Loading the flow layer also opportunistically joins
 * AADT onto the already-loaded stations so the station popup can show
 * the segment AADT inline (and vice-versa: loading stations after flow
 * triggers the same join). Failures are non-fatal — the button reverts.
 */
const auxLoaded = { contam: false, flow: false, highways: false, riskAreas: false, muniParcels: false };
const auxData   = { contam: null, flow: null, highways: null, riskAreas: null, muniParcels: null };
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
};

/** Fetch the Roll Layer's parcel fabric, scoped to either the
 *  sales-CSV mode's matched-muni list or the dropdown's single muni.
 *  Per-muni fetches run in parallel and merge into one FC — same
 *  pattern as the MASC/CLI/Grid/Zoning/DevPlan overlays. Returns an
 *  empty FC when nothing is in scope (toggleAuxOverlay catches that
 *  upstream via the disabled-button gate). */
async function fetchMuniParcelsForCurrentScope() {
  const munis = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.slice()
    : ($municipality.value ? [$municipality.value] : []);
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
 *  dropdown change inside sales mode doesn't trigger a refetch. */
function muniParcelsLoadKey() {
  return (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.join('|')
    : ($municipality.value || '');
}

/**
 * Enable / disable the Muni Parcels toggle based on whether a muni is
 * selected. When the muni changes, force a clean refetch the next time
 * the user toggles the layer on (the previous muni's parcels stay in the
 * map source until then so a no-op change doesn't blank the overlay).
 */
function resetMuniParcelsToggle() {
  // Button enabled when either a muni is selected OR a sales-CSV upload
  // has loaded a multi-muni scope.
  const inScope = !!$municipality.value
    || !!(csvMatchedMunis && csvMatchedMunis.length > 0);
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
    setHistoricalVisible(map, true);
    historicalActive = true;
    historicalLoadedMuni = muniName;
    setOverlayPressed($historicalToggle, true);
    updateHistoricalBanner(snap);
    const n = parcels.features?.length || 0;
    let changeNote = '';
    if (sizeSummary) {
      const parts = [];
      if (sizeSummary.major) parts.push(`${sizeSummary.major} major`);
      if (sizeSummary.minor) parts.push(`${sizeSummary.minor} minor`);
      if (sizeSummary.gone)  parts.push(`${sizeSummary.gone} gone`);
      if (parts.length) changeNote = ` Size changes: ${parts.join(', ')} (red >25%, orange >5%, grey = roll gone).`;
    }
    setCount(`Historical as of ${snap} — ${n} parcel${n === 1 ? '' : 's'} in ${muniName}, dashed over today's lots. Click a parcel/zone for its as-of details.${changeNote} Verify against by-law/title records.`);
  } catch (err) {
    console.warn('historical load failed', err);
    setCount('Historical: load failed.');
    deactivateHistorical();
  } finally {
    $historicalToggle.disabled = !$municipality.value;
    setOverlayBtnLabel($historicalToggle, 'Historical');
  }
}

function deactivateHistorical() {
  historicalActive = false;
  historicalLoadedMuni = null;
  mapReady.then(() => setHistoricalVisible(map, false));
  if ($historicalToggle) {
    setOverlayPressed($historicalToggle, false);
    setOverlayBtnLabel($historicalToggle, 'Historical');
  }
  if ($historicalBanner) $historicalBanner.hidden = true;
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

/** Enable/disable MASC and Sec-Twp Grid toggles based on whether a
 *  muni is selected, and clear stale data + active state if the muni
 *  changed since the layers were last loaded. Mirrors the
 *  resetMuniParcelsToggle pattern. */
function resetMascAndGridToggles() {
  // Enabled when EITHER a dropdown muni is selected OR a sales-CSV
  // upload has populated csvMatchedMunis — covers the rare case where
  // sales-mode is active but the dropdown is empty (shouldn't happen
  // with the current dominant-muni auto-set, but cheap belt-and-
  // braces for future flows that might disable the auto-set).
  const inScope = !!$municipality.value
    || !!(csvMatchedMunis && csvMatchedMunis.length > 0);
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
  const desiredOverlayKey = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.join('|')
    : $municipality.value;
  if (mascLoadedFor && mascLoadedFor !== desiredOverlayKey) {
    mascLoadedFor = null;
    if ($mascToggle.classList.contains('active')) {
      setOverlayPressed($mascToggle, false);
      setOverlayBtnLabel($mascToggle, 'MASC rating');
      mapReady.then(() => {
        setMascVisible(map, false);
        if ($mascLegend) $mascLegend.hidden = true;
      });
      // Drop the Soil + Risk Area columns when MASC turns off on
      // a muni change.
      if ($resultsTable) $resultsTable.classList.remove('masc-mode');
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
  // Sales-CSV mode: load MASC across EVERY matched muni. Otherwise
  // fall back to the dropdown's single value (matches the original
  // non-upload search flow exactly). csvMatchedMunis is already
  // sorted (handleSalesUpload sorts before stashing) so the joined
  // loadKey is stable across calls and the cache check below works.
  const munis = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.slice()
    : ($municipality.value ? [$municipality.value] : []);
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
    if ($resultsTable) $resultsTable.classList.remove('masc-mode');
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
  // Reveal the Soil + Risk Area columns alongside the overlay.
  if ($resultsTable) $resultsTable.classList.add('masc-mode');
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
  const munis = (csvMatchedMunis && csvMatchedMunis.length > 0)
    ? csvMatchedMunis.slice()
    : ($municipality.value ? [$municipality.value] : []);
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
  // FC, so this branch only runs once per muni.
  if (cliLoadedFor !== loadKey) {
    $cliToggle.disabled = true;
    setOverlayBtnLabel($cliToggle, 'Loading…');
    try {
      const muniBoundaries = munis.map((m) => ({
        muni: m,
        feat: muniBoundariesFc?.features?.find(
          (f) => f.properties?.MUNI_LIST_NAME_WITH_TYPE === m,
        ) || null,
      }));
      const missing = muniBoundaries.filter((mb) => !mb.feat).map((mb) => mb.muni);
      if (missing.length > 0) {
        setCliMode(null);
        setOverlayPressed($cliToggle, false);
        $cliToggle.disabled = false;
        setOverlayBtnLabel($cliToggle, cliButtonLabelFor(null));
        setCount(`Couldn't locate boundary for ${missing.join(', ')}; can't load CLI.`);
        return;
      }
      const fcs = await Promise.all(
        muniBoundaries.map((mb) => fetchCliAgrForMuni(mb.muni, mb.feat)),
      );
      const features = fcs.flatMap((fc) => fc?.features || []);
      if (features.length === 0) {
        setCliMode(null);
        setOverlayPressed($cliToggle, false);
        $cliToggle.disabled = false;
        setOverlayBtnLabel($cliToggle, cliButtonLabelFor(null));
        const label = munis.length === 1 ? munis[0] : `${munis.length} matched munis (${munis.join(', ')})`;
        setCount(`No CLI soil-capability polygons in ${label}.`);
        return;
      }
      const cliFc = { type: 'FeatureCollection', features };
      setCliAgrData(map, cliFc);
      lastCliFc = cliFc;
      if (currentRows.length > 0) {
        const parcelFc = { type: 'FeatureCollection', features: currentRows.map((r) => r.parcel) };
        stampSoilCompositionOnParcels(parcelFc, cliFc);
        setMapData(parcelFc, lastZoningFc || EMPTY_FC, lastDevPlanFc || EMPTY_FC, { fit: false });
        // Re-render the table so CLI / Soil Type columns populate
        // from the freshly-stamped composition. Without this, the
        // columns stay visually empty (showing their initial blank
        // state) until the user runs another search, even though
        // the data is on each parcel feature.
        refreshResultsTableAfterCompositionStamp();
      }
      cliLoadedFor = loadKey;
    } catch (err) {
      console.warn('CLI fetch failed', err);
      setCliMode(null);
      setOverlayPressed($cliToggle, false);
      $cliToggle.disabled = false;
      setOverlayBtnLabel($cliToggle, cliButtonLabelFor(null));
      setCount(`Failed to load CLI soil capability: ${err.message}`);
      return;
    }
    $cliToggle.disabled = false;
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
  window.location.href = window.location.pathname;
}

function clearTable() {
  $tbody.innerHTML = '';
  currentRows = [];
  setExportEnabled(false);
}

// $paginator + PAGE_SIZE + currentPage all live near the top of the
// module so renderTable / paginator helpers can read them without
// hitting TDZ during early code paths (sales-CSV upload via the
// recent-uploads dropdown, etc).

function renderTable(rows, { resetPage = true } = {}) {
  $tbody.innerHTML = '';
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

    // Zoning 2 only shown when its coverage is ≥1% — sub-1% slivers are
    // usually GIS noise (boundary digitization slop) and clutter the table.
    const z2ratio = row.zoning[1]?.ratio;
    const z2Show = Number.isFinite(z2ratio) && z2ratio >= 0.01;

    // Favourites star — sales-only column. The cell is always emitted
    // (so the table column count stays stable across modes); the CSS
    // .sales-only class hides it outside sales-mode. Click toggles
    // the in-memory Set + persists to localStorage; the cell's
    // appearance flips immediately via the class swap.
    tr.appendChild(favoriteCell(row));
    tr.appendChild(rollNumberCell(p));
    // Muni code (the integer authority prefix in Municipality, e.g.
    // 600 for "600 - RM OF HEADINGLEY"). Useful for joining external
    // spreadsheets keyed by muni_no without re-parsing the
    // human-readable name.
    const muniNo = muniNoFromProps(p);
    tr.appendChild(td(muniNo != null ? String(muniNo) : null, 'num'));
    // Sale Date / Sale Price cells — always emitted, hidden by CSS
    // unless #results carries the sales-mode class (toggled by
    // handleSalesUpload). Lets the columns appear/disappear without
    // re-renders when the user uploads a CSV.
    const saleDateCell = td(p._saleDate || null);
    saleDateCell.classList.add('sales-only');
    tr.appendChild(saleDateCell);
    const salePriceCell = td(p._salePrice || null);
    salePriceCell.classList.add('sales-only', 'num');
    tr.appendChild(salePriceCell);
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
    const pplCell = td(formatGroupPpl(p), 'num');
    pplCell.classList.add('sales-only');
    tr.appendChild(pplCell);
    // Address + Zoning right after $/Lot so the appraiser sees
    // identifying info before the wide numeric block. These cells
    // are emitted in every mode (no sales-only class); the table's
    // thead order matches.
    tr.appendChild(td(p.Property_Address));
    tr.appendChild(td(badge(formatZoneCode(z1), 'badge-zone')));
    // Sales-mode position for the Acres column. The basic-mode
    // Acres cell below carries the same value but with .basic-only
    // so only one is visible at a time.
    const acresSalesCell = td(formatAcres(ac), 'num');
    acresSalesCell.classList.add('sales-only');
    tr.appendChild(acresSalesCell);
    const ppaCell = td(formatGroupPpa(p), 'num');
    ppaCell.classList.add('sales-only');
    tr.appendChild(ppaCell);
    const ppsfCell = td(formatGroupPpsf(p), 'num');
    ppsfCell.classList.add('sales-only');
    tr.appendChild(ppsfCell);
    const saleToAsmtCell = td(formatSaleToAsmt(p), 'num');
    saleToAsmtCell.classList.add('sales-only');
    tr.appendChild(saleToAsmtCell);
    const distCell = td(formatDistanceKm(p), 'num');
    distCell.classList.add('sales-only', 'subj-col');
    tr.appendChild(distCell);
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
    // Soil + Risk Area cells get .masc-only so they follow the
    // MASC Rating overlay toggle.
    const soilCellEl = soilCell(p);
    soilCellEl.classList.add('masc-only');
    tr.appendChild(soilCellEl);
    const riskAreaCell = td(p._soilRiskArea != null ? String(p._soilRiskArea) : null, 'num');
    riskAreaCell.classList.add('masc-only');
    tr.appendChild(riskAreaCell);
    // CLI capability + Soil Type for the dominant (highest area-share)
    // soil — read directly from the stamped composition array. Empty
    // when no overlay has loaded for this muni yet; the empty-cell hint
    // tells the user to turn the Soil Productivity overlay on.
    tr.appendChild(td(dominantCliLabel(p), null, CLI_EMPTY_HINT));
    tr.appendChild(td(dominantSoilTypeLabel(p), null, SOIL_EMPTY_HINT));
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
    tr.appendChild(td(badge(formatChanges(row), 'badge-amend')));
    tr.appendChild(td(formatDu(p.Dwelling_Units), 'num'));
    // Basic-mode position for Acres — hidden in sales mode (the
    // sales-only Acres cell above takes its place after $/Lot).
    const acresBasicCell = td(formatAcres(ac), 'num');
    acresBasicCell.classList.add('basic-only');
    tr.appendChild(acresBasicCell);
    tr.appendChild(td(formatSf(ac), 'num'));
    tr.appendChild(assessmentCell(p));
    tr.appendChild(walkCell(row));
    tr.appendChild(floodCell(row));
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
  setExportEnabled(rows.length > 0);
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
 * Build the 33 CSV cells (11 columns × 3 soils) for the per-soil land-
 * feature descriptors. Reads `_soilComposition[0..2]` (rolled-up by
 * soil association, each entry already carries the largest-contributing
 * polygon's descriptor codes per soilSurveyComponentsFromMatches),
 * decodes each code to its human-readable label via map.js's domain
 * tables, and returns the cells in CSV order. Missing composition
 * entries (parcel has fewer than 3 soil associations) emit empty cells
 * so the column count stays fixed across rows.
 */
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
    cols.push(`Soil ${idx} % of Parcel`);
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
      out.push('', '');
      for (let j = 0; j < SOIL_CSV_DOMAINS_PER_SOIL.length; j++) out.push('');
      continue;
    }
    out.push(c.soilName || c.soilCode || '');
    out.push(Number.isFinite(c.parcelPct) ? c.parcelPct.toFixed(1) : '');
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
  swatch.style.backgroundColor = masccolor(rating);
  // White text on the visually-dark swatches (C olive, F dark green,
  // H magenta, I red, J purple) so the rating letter stays legible
  // against the chip background.
  swatch.style.color = ['C', 'F', 'H', 'I', 'J'].includes(rating) ? '#fff' : '#1a1a1a';
  if (p._soilQuarter) cell.title = `Source: ${p._soilQuarter}`;
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
function stampSoilCompositionOnParcels(parcelFc, soilFc) {
  if (!parcelFc?.features?.length || !soilFc?.features?.length) return;
  const join = joinTopNByArea(parcelFc, soilFc, Infinity);
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
  }
  return r.acres;
}

function formatAcres(v) {
  // One-decimal acres per the Phase 1 number-formatting tokens. The
  // 2-decimal precision that used to live here was an internal
  // preference; appraisers reading the column will still get the
  // thousands separator for large parcels (e.g. "12,345.6").
  return fmtAcres(v);
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
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (favoriteKeys.has(key)) favoriteKeys.delete(key);
    else if (favoriteKeys.size < FAV_CAP) favoriteKeys.add(key);
    saveFavorites();
    // Local DOM swap rather than a full re-render — keeps the rest
    // of the table stable and avoids losing scroll position.
    const nowFav = favoriteKeys.has(key);
    btn.className = nowFav ? 'fav-star active' : 'fav-star';
    btn.textContent = nowFav ? '★' : '☆';
    btn.title = nowFav ? 'Unstar — remove from comparables' : 'Star — mark as comparable';
    btn.setAttribute('aria-pressed', String(nowFav));
    // Row shading + map fill flip in lockstep. The closest <tr> for
    // the click target is the row we want to restyle; the parcel
    // feature is captured by row at render-time (no DOM walk).
    const tr = cell.closest('tr');
    if (tr) tr.classList.toggle('starred', nowFav);
    setStarredOnMap(row?.parcel, nowFav);
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
    if (csvFullRows && csvFullRows.length > 0) {
      stampDistancesFromSubject(csvFullRows);
      refilterCsvIfActive();
    }
    setCount(`Subject set to ${raw} (${muni}). Distance column populated.`);
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

// ---------- CSV export ----------

function setExportEnabled(enabled) { $export.disabled = !enabled; }

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
  const header = [
    'Roll #', 'Muni #', 'Address',
    'Legal Description', 'Legal Detail', 'Lot', 'Block', 'Plan',
    'Certificates of Title', 'MAO Legal Source URL',
    'Zoning', 'Zoning %',
    'Zoning 2', 'ZBL',
    'Dev-Plan Designation', 'DP By-law',
    'Soil Rating', 'Risk Area',
    'CLI', 'Soil Type',
    ...soilCsvHeaders(),
    'Land Cover', 'Cult %', 'Pasture %', 'Bush %', 'Wetland %', 'Other %',
    'Changes',
    'DU', 'Acres', 'SF', 'Acres Src',
    csvAssessHeader(currentRows), 'Asmt Report URL',
    'Walkscore URL', 'Flood-Map URL',
    ...(inSalesMode
      ? [
          'Sale Date', 'Sale Price', 'Group #', 'Group $/Lot', 'Group $/SF', 'Group $/Acre', 'Sale/Asmt',
          'Dist (km)', 'Asmt Land', 'Asmt Buildings', 'Asmt Bldg %', 'Asmt Year', 'Asmt Class', 'Asmt Status',
        ]
      : []),
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
  });
  const lines = provenanceCsvLines(prov).map(csvCell);
  lines.push(header.map(csvCell).join(','));
  for (const row of exportRows) {
    const p = row.parcel.properties || {};
    const z1 = row.zoning[0]?.feature.properties || {};
    const z2 = row.zoning[1]?.feature.properties || {};
    const d1 = row.devPlan[0]?.feature.properties || {};
    const ac = parcelAcres(row.parcel);
    lines.push([
      p.Roll_No_Txt, muniNoFromProps(p) ?? '', p.Property_Address,
      p._legalDescription ?? '',
      p._legalDetail ?? '',
      p._lot ?? '',
      p._block ?? '',
      p._plan ?? '',
      p._certificatesOfTitle ?? '',
      p._legalSourceUrl ?? '',
      formatZoneCode(z1), ratioPct(row.zoning[0]?.ratio),
      formatZoneCode(z2), z1.ZBL,
      formatDes(d1), d1.DP_BYLAW,
      p._soilRating ?? '', p._soilRiskArea ?? '',
      dominantCliLabel(p) ?? '', dominantSoilTypeLabel(p) ?? '',
      ...soilCsvCells(p),
      ...landCoverCsvCells(p, ac),
      formatChanges(row),
      p.Dwelling_Units ?? '',
      formatAcresCsv(ac),
      ac != null && Number.isFinite(ac) && ac > 0 ? Math.round(ac * 43560) : '',
      p._acresRollNominal ? 'geometry (roll nominal)' : (p._acresSource ?? ''),
      parseTotalValue(p.Total_Value) ?? '',
      p.Asmt_Rpt_Url ?? '',
      walkscoreUrl(p),
      floodMapUrl(row),
      ...(inSalesMode
        ? [
            p._saleDate ?? '',
            p._salePrice ?? '',
            p._saleGroupSize ?? '',
            p._saleGroupPpl != null ? Math.round(p._saleGroupPpl) : '',
            p._saleGroupAcresIncomplete ? '' : (p._saleGroupPpsf != null ? p._saleGroupPpsf.toFixed(2) : ''),
            p._saleGroupAcresIncomplete ? '' : (p._saleGroupPpa  != null ? Math.round(p._saleGroupPpa)   : ''),
            p._saleGroupAsmtIncomplete ? '' : (Number.isFinite(p._saleGroupSaleToAsmt) ? p._saleGroupSaleToAsmt.toFixed(2) : ''),
            Number.isFinite(p._distanceKm) ? p._distanceKm.toFixed(2) : '',
            Number.isFinite(p._asmtLand) ? Math.round(p._asmtLand) : '',
            Number.isFinite(p._asmtBuildings) ? Math.round(p._asmtBuildings) : '',
            Number.isFinite(p._asmtPctBldg) ? (p._asmtPctBldg * 100).toFixed(2) : '',
            Number.isFinite(p._asmtYear) ? Math.trunc(p._asmtYear) : '',
            p._asmtClass ?? '',
            p._asmtStatus ?? '',
          ]
        : []),
    ].map(csvCell).join(','));
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
// and Soil Type need the Soil Productivity overlay on; Land Cover / Cult %
// load from a muni-scoped search of > LAND_COVER_MIN_ACRES-acre parcels (no overlay needed).
const CLI_EMPTY_HINT =
  'Turn on the Soil Productivity/Soil Name overlay (Agricultural section) to load soil capability for this municipality.';
const SOIL_EMPTY_HINT =
  'Turn on the Soil Productivity/Soil Name overlay (Agricultural section) to load the soil association for this municipality.';
const LANDCOVER_EMPTY_HINT =
  `Loads automatically on a municipality-scoped search (select the municipality, then search) for parcels over ${LAND_COVER_MIN_ACRES} acres.`;

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
