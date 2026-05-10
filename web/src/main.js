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
  fetchMunicipalityList,
  fetchZoneCategoryList,
  fetchContaminatedSites,
  fetchTrafficFlow,
  fetchAllParcelsInMunicipality,
  fetchMunicipalBoundaries,
  fetchMascRatingsForMuni,
  fetchMascRiskAreas,
  fetchSurveyGridForMuni,
  fetchProvinceSectionGrid,
  fetchRiverLots,
  fetchParcelMascForMuni,
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
  surveyFcToRows,
  MASC_PALETTE,
} from './masc.js';
import {
  initMap,
  showResults,
  setZoningData,
  setZoningPaint,
  setDevPlanData,
  setZoningVisible,
  setDevPlanVisible,
  setContamData,
  setContamVisible,
  setTrafficFlowData,
  setTrafficFlowVisible,
  setMuniParcelsData,
  setMuniParcelsVisible,
  setMuniBoundariesData,
  setMascData,
  setMascRiverlotsData,
  setMascVisible,
  setCliAgrData,
  setCliAgrVisible,
  setMascRiskAreasData,
  setMascRiskAreasVisible,
  setSurveyGridData,
  setSurveyGridVisible,
  flyToFeature,
  buildZoneCodePaint,
  parcelHtml,
} from './map.js';
import {
  hasLegalCriteria,
  legalRecordKey,
  parcelLegalKey,
  searchLegalIndex,
  lookupLegalRecordsByParcelKeys,
  warmLegalIndex,
} from './legalIndex.js';
import turfArea from '@turf/area';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

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
const $sizeUomAcres  = document.getElementById('size-uom-acres');
const $sizeUomSf     = document.getElementById('size-uom-sf');
const $search        = document.getElementById('search');
const $clear         = document.getElementById('clear');
const $export        = document.getElementById('export');
const $zoningToggle  = document.getElementById('zoning-toggle');
const $devplanToggle = document.getElementById('devplan-toggle');
const $muniWebsiteBtn = document.getElementById('muni-website-btn');
const $pdWebsiteBtn   = document.getElementById('pd-website-btn');
const $contamToggle  = document.getElementById('contam-toggle');
const $flowToggle    = document.getElementById('flow-toggle');
const $muniParcelsToggle = document.getElementById('muni-parcels-toggle');
const $mascToggle    = document.getElementById('masc-toggle');
const $riskAreaToggle = document.getElementById('riskarea-toggle');
const $cliToggle     = document.getElementById('cli-toggle');
const $cliLegend     = document.getElementById('cli-legend');
const $gridToggle    = document.getElementById('grid-toggle');
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
  'LAC DU BONNET (TOWN)':        'https://www.townoflacdubonnet.com/',
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
  'YELLOWHEAD (RM)':             'https://www.yellowheadmunicipality.ca/',

  // Municipalities (post-amalgamation single-tier)
  'BIFROST-RIVERTON (MUNICIPALITY)':       'https://www.bifrostriverton.ca/',
  'BOISSEVAIN-MORTON (MUNICIPALITY)':      'https://www.boissevain.ca/',
  'BRENDA-WASKADA (MUNICIPALITY)':         'https://www.waskada.org/',
  'CARTWRIGHT-ROBLIN (MUNICIPALITY)':      'https://cartwrightroblin.com/',
  'CLANWILLIAM-ERICKSON (MUNICIPALITY)':   'https://www.ericksonmb.ca/',
  'DELORAINE-WINCHESTER (MUNICIPALITY)':   'https://www.delowin.ca/',
  'EMERSON-FRANKLIN (MUNICIPALITY)':       'https://www.emersonfranklin.com/',
  'GILBERT PLAINS (MUNICIPALITY)':         'https://www.gilbertplains.com/',
  'GLENBORO-SOUTH CYPRESS (MUNICIPALITY)': 'https://www.glenboro.com/',
  'GLENELLA-LANSDOWNE (MUNICIPALITY)':     'https://www.glenella.ca/',
  'GRANDVIEW (MUNICIPALITY)':              'https://grandviewmanitoba.com/',
  'GRASSLAND (MUNICIPALITY)':              'https://www.grasslandmunicipality.ca/',
  'HAMIOTA (MUNICIPALITY)':                'https://www.hamiota.com/',
  'HARRISON PARK (MUNICIPALITY)':          'https://www.harrisonpark.ca/',
  'KILLARNEY-TURTLE MOUNTAIN (MUNICIPALITY)': 'https://www.killarney.ca/',
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
  'PINAWA (LGD)':                          'https://www.pinawa.com/',
};

/** Normalize a Muni_Name_With_Typ for tolerant lookup: uppercase, strip
 *  diacritics (é → e), normalize en-/em-dashes to hyphen-minus, collapse
 *  whitespace. Used on both sides of the lookup so dash/accent drift in
 *  the source data doesn't break the match. */
function normalizeMuniKey(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritics
    .toUpperCase()
    .replace(/[‐-―−]/g, '-') // any unicode dash → hyphen-minus
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

// row key -> the Feature whose geometry we should fly to when the user
// clicks that row. Cleared on every renderTable.
const rowFeatureMap = new Map();

// Cached overlay FCs from the most recent search, so toggling the zoning
// or dev-plan layer on doesn't require re-running the spatial enrichment.
let lastZoningFc = EMPTY_FC;
let lastDevPlanFc = EMPTY_FC;

// CSV-upload mode state. csvFullRows holds the full enriched row set
// from the last sales-CSV upload (with zoning / dev-plan / risk-area
// data joined in), so changing the Other Searches filters after upload
// can re-filter against the same data without another round-trip.
// null means "not in CSV mode" — Other Searches filter changes do
// nothing in that state, matching the old runSearch-only behaviour.
let csvFullRows = null;
let csvFullBaseMsg = '';

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

setExportEnabled(false);
updateSortIndicators();

$search.addEventListener('click', runSearch);
$clear.addEventListener('click', clearAll);
$export.addEventListener('click', exportCsv);

// Sales-CSV upload — see handleSalesUpload() for the parse +
// per-muni Roll # lookup + table/map rendering pipeline.
const $salesUploadBtn   = document.getElementById('sales-upload-btn');
const $salesUploadInput = document.getElementById('sales-upload-input');
if ($salesUploadBtn && $salesUploadInput) {
  $salesUploadBtn.addEventListener('click', () => $salesUploadInput.click());
  $salesUploadInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await handleSalesUpload(file);
    } catch (err) {
      console.error('Sales upload failed', err);
      setCount(`Sales upload failed: ${err.message}`);
    } finally {
      // Reset so the same file can be re-selected to retry.
      e.target.value = '';
    }
  });
}
$zoningToggle.addEventListener('click', () => toggleOverlay('zoning'));
$devplanToggle.addEventListener('click', () => toggleOverlay('devplan'));
$contamToggle.addEventListener('click', () => toggleAuxOverlay('contam'));
$flowToggle.addEventListener('click', () => toggleAuxOverlay('flow'));
$riskAreaToggle.addEventListener('click', () => toggleAuxOverlay('riskAreas'));
$muniParcelsToggle.addEventListener('click', () => toggleAuxOverlay('muniParcels'));
$mascToggle.addEventListener('click', () => toggleMascOverlay());
$cliToggle.addEventListener('click', () => toggleCliOverlay());
$gridToggle.addEventListener('click', () => toggleSurveyGridOverlay());

const $staticMapBtn     = document.getElementById('static-map-btn');
const $staticMapOutput  = document.getElementById('static-map-output');
const $staticMapSection = document.getElementById('static-map-section');
if ($staticMapBtn) $staticMapBtn.addEventListener('click', generateStaticMap);

/**
 * Draw the WebGL map canvas into a 2D canvas and burn the live
 * attribution text into the bottom-right corner. Without this the
 * saved PNG would show no basemap / data credit even though the live
 * map does — the WebGL canvas alone doesn't include the
 * AttributionControl DOM overlay. The returned data URL carries the
 * credit with the image so it survives right-click → Save.
 */
function composeWithAttribution(srcCanvas) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(srcCanvas, 0, 0);

  // Pull the exact text MapLibre shows in its attribution control. This
  // keeps the static image in sync with whatever sources/overlays are
  // currently visible — basemap (CARTO Positron or Esri Imagery), zoning,
  // dev-plan, contam, traffic, etc. — without us having to enumerate them.
  const attribEl = $mapEl.querySelector('.maplibregl-ctrl-attrib-inner') ||
                   $mapEl.querySelector('.maplibregl-ctrl-attrib');
  let text = attribEl ? attribEl.innerText.replace(/\s+/g, ' ').trim() : '';
  if (!text) text = '© OpenStreetMap © CARTO';

  // Style the credit similar to the live map's bottom-right overlay:
  // small text, semi-transparent white pill, dark text. Use the device
  // pixel ratio so it stays sharp at high-DPI; fall back to 1.
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const fontSize = Math.max(11, Math.round(11 * dpr * 0.9));
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
  return out.toDataURL('image/png');
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
});
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
  $zoneCategory, $changedStatus, $duMode, $duMin, $sizeLow, $sizeHigh,
].filter(Boolean)) {
  el.addEventListener('change', refilterCsvIfActive);
  el.addEventListener('input',  refilterCsvIfActive);
}

// UofM toggle pill — flips between Acres and Sq Ft. Click handler
// updates the .active class on both buttons and re-runs the CSV filter
// so the Low/High inputs (which are entered in the chosen unit) are
// re-applied immediately. The active unit is read off the pill's
// dataset.uom attribute so other code can introspect it without
// querying both buttons.
function setSizeUom(uom) {
  if (uom !== 'acres' && uom !== 'sf') return;
  const pill = $sizeUomAcres?.parentElement;
  if (pill) pill.dataset.uom = uom;
  if ($sizeUomAcres) $sizeUomAcres.classList.toggle('active', uom === 'acres');
  if ($sizeUomSf)    $sizeUomSf.classList.toggle('active',    uom === 'sf');
  refilterCsvIfActive();
}
if ($sizeUomAcres) $sizeUomAcres.addEventListener('click', () => setSizeUom('acres'));
if ($sizeUomSf)    $sizeUomSf.addEventListener('click',    () => setSizeUom('sf'));
// Stamp the initial UofM onto the pill container so getSizeUom() reads
// 'acres' before the user clicks anything.
setSizeUom('acres');
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
  });
}

// Populate the three dropdowns in parallel — the muni list is the slow one
// (~190 distinct values), the categories are short and quick.
populateDropdowns();

// Pre-warm the legal index in the background. The first search (legal-
// criteria or otherwise) joins the index against the parcel result set
// to populate the Legal + Title columns; without this kickoff, the
// first search would block on a 130 MB cold fetch.
warmLegalIndex();

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
    const [munis, zoneCats] = await Promise.all([
      fetchMunicipalityList(),
      fetchZoneCategoryList(),
    ]);
    fillSelect($municipality, munis, 'Any municipality');
    fillSelect($zoneCategory, zoneCats, 'Any zoning category');
  } catch (err) {
    console.error('Failed to load filter dropdowns', err);
    fillSelect($municipality, [], 'Failed to load — type to filter parcels another way');
  }
}

/**
 * On muni change, narrow the Zone Category and Dev-Plan Category dropdowns
 * to only the categories that actually appear inside that muni. Both
 * overlay layers carry MUNI_NAME (without the "(TOWN)"-style suffix), so
 * the API client strips that suffix before filtering. Any preselection
 * that's no longer valid in the narrowed list is reset.
 */
async function refilterCategoryDropdowns() {
  const muni = $municipality.value || null;
  // Show the user we're refilling — disable until results land.
  const prevZone = $zoneCategory.value;
  $zoneCategory.disabled = true;
  try {
    const zoneCats = await fetchZoneCategoryList(muni);
    fillSelect($zoneCategory, zoneCats, 'Any zoning category');
    // Restore prior selection if it's still valid in the narrowed list.
    if (zoneCats.includes(prevZone)) $zoneCategory.value = prevZone;
  } catch (err) {
    console.warn('Failed to refilter category dropdowns', err);
    $zoneCategory.disabled = false;
  }
}

function fillSelect(sel, values, blankLabel) {
  sel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = blankLabel;
  sel.appendChild(blank);
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
  sel.disabled = false;
}

// ---------- Search ----------

async function runSearch() {
  // Drop the sales-mode column reveal if a previous run came from a
  // sales CSV upload — a normal search shouldn't carry those columns.
  if ($resultsTable) $resultsTable.classList.remove('sales-mode');
  // Hide the size-range filter row since it's CSV-only.
  document.body.classList.remove('sales-mode');
  // Hide the unmatched-records panel — also CSV-upload-specific.
  renderUnmatchedPanel([]);
  // Clear the CSV-mode state so the Other Searches filter listeners
  // stop trying to re-filter the previous upload's row set.
  csvFullRows = null;
  csvFullBaseMsg = '';
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

  if (!Object.values(inputs).some(Boolean) && !hasLegalSearch) {
    setCount('Enter at least one search field.');
    clearTable();
    setMapData(EMPTY_FC, EMPTY_FC, EMPTY_FC);
    return;
  }

  setBusy(true);
  setCount('Searching parcels…');
  clearTable();
  setMapData(EMPTY_FC, EMPTY_FC, EMPTY_FC);

  try {
    let legalResult = null;
    if (hasLegalSearch) {
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

    // Civic-number range is a JS post-filter (ArcGIS SQL can't cleanly
    // CAST the leading digits of Property_Address). Applies only when
    // From or To is filled; if both blank the FC passes through. The
    // street-name substring already narrowed the SQL fetch via
    // buildParcelClauses, so the post-filter is operating on at most a
    // few hundred rows in the typical case.
    applyCivicNumberRange(parcelFc, inputs.addressFrom, inputs.addressTo);

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
      if (isBulkRollSearch) {
        setCount(`No parcels found — none of the ${rollList.length} rolls matched in this municipality.`);
      } else {
        setCount('No parcels found.');
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
    const countLabel = isBulkRollSearch
      ? `${n} of ${rollList.length} rolls matched`
      : `${n} parcels found`;
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

    // Threshold rule: small result sets auto-enrich (typical search
    // for a single property or small block — fast and the user expects
    // zoning/dev-plan in the table immediately). Large result sets
    // skip auto-enrichment because the per-parcel area-weighted join
    // (joinTopNByArea via @turf/intersect) gets slow on the main
    // thread; render the parcel rows now and offer a "Load zoning +
    // dev-plan" button on the count line so the user can opt in when
    // they actually need those columns.
    if (parcelFc.features.length > ENRICHMENT_THRESHOLD) {
      renderEnrichButton(parcelFc, inputs, baseMsg);
    } else {
      await enrichOverlays(parcelFc, inputs, baseMsg);
    }
  } finally {
    setBusy(false);
  }
}

const ENRICHMENT_THRESHOLD = 250;

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
    const text = await file.text();
    const records = parseSalesCsv(text);
    if (records.length === 0) {
      setCount('No usable rows in CSV. Expecting Roll Number + Municipality columns.');
      return;
    }

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
    const fetches = [...byMuni.entries()].map(async ([muni, recs]) => {
      const rolls = recs.map((r) => r.rollNumber).filter(Boolean).join(',');
      let fc = { type: 'FeatureCollection', features: [] };
      try {
        fc = await searchParcels({ municipality: muni, roll: rolls });
      } catch (err) {
        console.warn(`searchParcels failed for ${muni}`, err);
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
      setCount(`No matching parcels found for the ${records.length} CSV rows. ` +
               `Check that municipality names and roll numbers match Roll_Entry.`);
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

    // If every matched parcel sits in a single muni, sync the
    // dropdown to that muni so muni-scoped affordances (Roll Layer
    // / MASC Rating / CLI Soil / Muni Website / PD Website / the
    // Other Searches category dropdown) all enable themselves the
    // same way they would after a regular search. The 'change'
    // dispatch fires the existing listeners so overlay state
    // refreshes correctly. Multi-muni uploads leave the dropdown
    // empty (Roll Layer is single-muni-scoped; we'd otherwise have
    // to pick a winner arbitrarily).
    const matchedMunis = [...new Set(
      results.filter((r) => r.matched > 0).map((r) => r.muni)
    )];
    let inputsMuni = '';
    if (matchedMunis.length === 1) {
      const dominant = matchedMunis[0];
      if ($municipality.value !== dominant) {
        $municipality.value = dominant;
        $municipality.dispatchEvent(new Event('change'));
      }
      inputsMuni = dominant;
    }

    // Pass the resolved muni (or empty for multi-muni uploads) so
    // enrichOverlays can route through the bulk-by-muni overlay path
    // when applicable.
    const fakeInputs = { municipality: inputsMuni };

    if (parcelFc.features.length > ENRICHMENT_THRESHOLD) {
      renderEnrichButton(parcelFc, fakeInputs, baseMsg);
    } else {
      // Wrap in try/catch — a failed zoning/dev-plan fetch shouldn't
      // skip the group-totals computation below. The table still
      // renders parcels-only rows in that case, with the group
      // rollups applied.
      try {
        await enrichOverlays(parcelFc, fakeInputs, baseMsg);
      } catch (err) {
        console.warn('Sales upload: overlay enrichment failed (non-fatal):', err);
      }
    }

    // Mirror runSearch's auto-toggle of the Roll Layer when a single
    // muni is in scope — gives the user the surrounding parcel
    // fabric for context without an extra click.
    if (inputsMuni && $muniParcelsToggle && !$muniParcelsToggle.disabled
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

    // Runtime debugging — expose the post-stamp parcelFc + parcelHtml so the
    // tooltip / hover path can be inspected from the console without
    // re-running the upload pipeline.
    window.__parcelFc = parcelFc;
    window.__parcelHtml = parcelHtml;

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
    `<tr>${td(u.rollNumber)}${td(u.municipality)}${td(u.saleDate)}${td(u.consideration)}${td(u.legalDescription)}<td class="reason">${esc(u.reason)}</td></tr>`
  ).join('');
  $tbody.innerHTML = rows;
  $panel.hidden = false;
  // Wire Download CSV — re-bind every render so the latest list is
  // captured. Older bindings get garbage-collected with the closure.
  $download.onclick = () => downloadUnmatchedCsv(unmatched);
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
    const s = v == null ? '' : String(v);
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
  const groups = new Map();
  let stampedCount = 0;
  // Pass 1: collect group members + accumulate totals.
  for (const f of parcelFc?.features || []) {
    const gid = f.properties?._saleGroupId;
    if (gid == null) continue;
    if (!groups.has(gid)) {
      groups.set(gid, {
        oids: [],
        totalAcres: 0,
        priceNum: parseTotalValue(f.properties?._salePrice),
        acresIncomplete: false,
      });
    }
    const g = groups.get(gid);
    g.oids.push(f.properties?.OBJECTID);
    const ac = Number(f.properties?._acres);
    if (Number.isFinite(ac) && ac > 0) g.totalAcres += ac;
    else g.acresIncomplete = true;
  }
  // Pass 2: stamp each parcel with its group's rollups.
  for (const f of parcelFc?.features || []) {
    const gid = f.properties?._saleGroupId;
    if (gid == null) continue;
    const g = groups.get(gid);
    if (!g) continue;
    f.properties._saleGroupSize          = g.oids.length;
    f.properties._saleGroupRollIds       = g.oids;
    f.properties._saleGroupTotalPriceNum = g.priceNum;
    f.properties._saleGroupTotalAcres    = g.totalAcres;
    f.properties._saleGroupAcresIncomplete = g.acresIncomplete;
    stampedCount++;
    if (
      g.priceNum != null &&
      Number.isFinite(g.priceNum) &&
      g.totalAcres > 0 &&
      !g.acresIncomplete
    ) {
      f.properties._saleGroupPpa  = g.priceNum / g.totalAcres;
      f.properties._saleGroupPpsf = g.priceNum / (g.totalAcres * 43560);
    } else {
      f.properties._saleGroupPpa  = null;
      f.properties._saleGroupPpsf = null;
    }
    // $/lot — total sale price ÷ number of parcels in the group.
    // Doesn't depend on acres so it works even when one or more
    // parcels in the group are missing _acres (acresIncomplete=true).
    if (
      g.priceNum != null &&
      Number.isFinite(g.priceNum) &&
      g.oids.length > 0
    ) {
      f.properties._saleGroupPpl = g.priceNum / g.oids.length;
    } else {
      f.properties._saleGroupPpl = null;
    }
  }
  console.info(`Sales upload: stamped group totals on ${stampedCount} parcels `
             + `across ${groups.size} sale groups.`);
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
  setMapData(fc, lastZoningFc, lastDevPlanFc);
}

function filterCsvRowsByOtherSearches(rows) {
  const zoneCat = $zoneCategory?.value || '';
  const status  = $changedStatus?.value || '';
  const duMode  = $duMode?.value || '';
  const duMin   = parseInt($duMin?.value || '', 10);

  // Size range — Low/High are entered in the chosen UofM (acres or sq
  // ft); convert to acres for comparison since parcelAcres() returns
  // acres. Empty Low → 0; empty High → ∞. The filter only fires when
  // at least one of Low/High is a finite positive number; both empty
  // is a no-op so users who haven't touched the inputs aren't surprised
  // by parcels disappearing.
  const sizeLowRaw  = parseFloat($sizeLow?.value);
  const sizeHighRaw = parseFloat($sizeHigh?.value);
  const sizeUom     = $sizeUomAcres?.parentElement?.dataset?.uom || 'acres';
  const toAcres = (v) => (sizeUom === 'sf' ? v / 43560 : v);
  const sizeActive = Number.isFinite(sizeLowRaw) || Number.isFinite(sizeHighRaw);
  const sizeLoAc = Number.isFinite(sizeLowRaw)  ? toAcres(sizeLowRaw)  : 0;
  const sizeHiAc = Number.isFinite(sizeHighRaw) ? toAcres(sizeHighRaw) : Infinity;

  return rows.filter((row) => {
    const p = row.parcel?.properties || {};

    // DU filter — directly on the parcel field, no enrichment needed.
    if (duMode === 'zero') {
      const du = Number(p.Dwelling_Units);
      if (!(Number.isFinite(du) && du === 0)) return false;
    } else if (duMode === 'min' && Number.isFinite(duMin) && duMin > 0) {
      const du = Number(p.Dwelling_Units);
      if (!(Number.isFinite(du) && du >= duMin)) return false;
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
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((c) => String(c || '').trim().toLowerCase());
  const idx = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };
  const i = {
    saleDate:        idx('sale date', 'date'),
    consideration:   idx('consideration', 'sale price', 'price'),
    municipality:    idx('municipality', 'muni'),
    rollNumber:      idx('roll number', 'roll #', 'roll'),
    streetAddress:   idx('street address', 'address'),
    legalDescription: idx('legal description', 'legal'),
    primaryProperty: idx('primary property'),
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

/** Generic CSV row tokenizer — handles quoted fields with embedded
 *  commas, escaped double-quotes (""), and \r\n / \n / \r line
 *  endings. Returns an array of arrays. */
function parseCsvRows(text) {
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
    } else if (c === ',') {
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
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, ' ');
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
  setCount(`${baseMsg} · loading zoning + dev-plan…`);

  let zoningFc = EMPTY_FC;
  let devPlanFc = EMPTY_FC;
  let riskAreaFc = EMPTY_FC;
  const riskAreaPromise = fetchMascRiskAreas().catch((err) => {
    console.warn('official MASC risk-area fetch failed (non-fatal):', err);
    return EMPTY_FC;
  });
  try {
    [zoningFc, devPlanFc, riskAreaFc] = await Promise.all([
      fetchZoningOverlap(parcelFc, { municipality: inputs.municipality }),
      fetchDevPlanOverlap(parcelFc, { municipality: inputs.municipality }),
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

  const rows = parcelFc.features.map((p) => ({
    parcel: p,
    zoning:  zoningTop2.get(p.properties.OBJECTID) || [],
    devPlan: devPlanTop2.get(p.properties.OBJECTID) || [],
  }));

  // Stamp primary-zoning code onto each parcel feature so the map's
  // hover popup (which only sees the parcel-fill feature) can include
  // the zoning code without re-running the spatial join client-side.
  for (const row of rows) {
    const z = row.zoning[0]?.feature.properties;
    if (z) row.parcel.properties._zoneCode = z.ZONE || z.ZONE_NAME || null;
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
  mapReady.then(() => {
    showResults(map, parcelFc, opts);
    setZoningData(map, zoningFc);
    setDevPlanData(map, devPlanFc);
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
async function toggleOverlay(which) {
  const btn = which === 'zoning' ? $zoningToggle : $devplanToggle;
  const label = which === 'zoning' ? 'Zoning Layer' : 'Dev Plan Layer';
  const wasActive = btn.classList.contains('active');
  const visible = !wasActive;
  btn.classList.toggle('active', visible);
  btn.setAttribute('aria-pressed', String(visible));

  await mapReady;

  if (!visible) {
    btn.textContent = label;
    applyOverlayVisibility(which, false);
    return;
  }

  // Turning on — fetch first if a muni is selected and the loaded
  // muni doesn't match the dropdown.
  const muni = $municipality.value;
  const loadedFor = which === 'zoning' ? zoningLayerLoadedFor : devPlanLayerLoadedFor;
  const cachedFc  = which === 'zoning' ? lastZoningFc        : lastDevPlanFc;
  const haveData  = (cachedFc?.features?.length || 0) > 0;
  const needFetch = muni && loadedFor !== muni;

  if (needFetch) {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      if (which === 'zoning') {
        const fc = await fetchZoningOverlap(EMPTY_FC, { municipality: muni });
        setZoningData(map, fc);
        lastZoningFc = fc;
        rebuildZoningLegend(fc);
        zoningLayerLoadedFor = muni;
      } else {
        const fc = await fetchDevPlanOverlap(EMPTY_FC, { municipality: muni });
        setDevPlanData(map, fc);
        lastDevPlanFc = fc;
        devPlanLayerLoadedFor = muni;
      }
    } catch (err) {
      console.warn(`${label} fetch failed`, err);
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
      btn.disabled = false;
      btn.textContent = label;
      setCount(`Failed to load ${label}: ${err.message}`);
      return;
    }
    btn.disabled = false;
  } else if (!muni && !haveData) {
    // No muni selected and nothing cached from a previous search —
    // revert the toggle and tell the user what to do.
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = label;
    setCount(`Select a municipality to load the ${label}.`);
    return;
  }

  btn.textContent = label;
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
  const muni = $municipality.value;
  await mapReady;

  if ($zoningToggle.classList.contains('active') && zoningLayerLoadedFor !== muni) {
    if (muni) {
      try {
        const fc = await fetchZoningOverlap(EMPTY_FC, { municipality: muni });
        setZoningData(map, fc);
        lastZoningFc = fc;
        rebuildZoningLegend(fc);
        zoningLayerLoadedFor = muni;
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

  if ($devplanToggle.classList.contains('active') && devPlanLayerLoadedFor !== muni) {
    if (muni) {
      try {
        const fc = await fetchDevPlanOverlap(EMPTY_FC, { municipality: muni });
        setDevPlanData(map, fc);
        lastDevPlanFc = fc;
        devPlanLayerLoadedFor = muni;
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
 *   riskAreas — official MASC crop-insurance risk-area polygons
 *
 * These are lazily fetched on first activation and cached through the
 * shared localStorage cache. Loading the flow layer also opportunistically joins
 * AADT onto the already-loaded stations so the station popup can show
 * the segment AADT inline (and vice-versa: loading stations after flow
 * triggers the same join). Failures are non-fatal — the button reverts.
 */
const auxLoaded = { contam: false, flow: false, riskAreas: false, muniParcels: false };
const auxData   = { contam: null, flow: null, riskAreas: null, muniParcels: null };
// Tracks which muni's parcels are currently in the muni-parcels source so
// we know whether to refetch when the user switches munis.
let muniParcelsLoadedFor = null;

const AUX_META = {
  contam:      { btn: () => $contamToggle,      on: 'Enviro Sites', off: 'Enviro Sites', busy: 'Loading…',
                 fetch: () => fetchContaminatedSites(),       setData: (m, fc) => setContamData(m, fc),      setVis: setContamVisible },
  flow:        { btn: () => $flowToggle,        on: 'Traffic Flow', off: 'Traffic Flow', busy: 'Loading…',
                 fetch: () => fetchTrafficFlow(),             setData: (m, fc) => setTrafficFlowData(m, fc), setVis: setTrafficFlowVisible },
  riskAreas:   { btn: () => $riskAreaToggle,    on: 'MASC Risk Areas', off: 'MASC Risk Areas', busy: 'Loading…',
                 fetch: () => fetchMascRiskAreas(),            setData: (m, fc) => setMascRiskAreasData(m, fc), setVis: setMascRiskAreasVisible },
  muniParcels: { btn: () => $muniParcelsToggle, on: 'Roll Layer', off: 'Roll Layer', busy: 'Loading…',
                 fetch: () => fetchAllParcelsInMunicipality($municipality.value),
                 setData: (m, fc) => setMuniParcelsData(m, fc), setVis: setMuniParcelsVisible },
};

/**
 * Enable / disable the Muni Parcels toggle based on whether a muni is
 * selected. When the muni changes, force a clean refetch the next time
 * the user toggles the layer on (the previous muni's parcels stay in the
 * map source until then so a no-op change doesn't blank the overlay).
 */
function resetMuniParcelsToggle() {
  const muniSelected = !!$municipality.value;
  $muniParcelsToggle.disabled = !muniSelected;
  // If the active muni changed, mark the layer as needing a refetch and
  // turn it off so we don't show another muni's parcels on screen.
  if (muniParcelsLoadedFor && muniParcelsLoadedFor !== $municipality.value) {
    auxLoaded.muniParcels = false;
    muniParcelsLoadedFor = null;
    if ($muniParcelsToggle.classList.contains('active')) {
      $muniParcelsToggle.classList.remove('active');
      $muniParcelsToggle.setAttribute('aria-pressed', 'false');
      $muniParcelsToggle.textContent = 'Roll Layer';
      mapReady.then(() => setMuniParcelsVisible(map, false));
    }
  }
}

// MASC + Sec-Twp Grid state. Tracks which muni's data is currently
// loaded into each source so a toggle off-then-on doesn't refetch and
// a muni-change can prompt a refetch when the layer is active.
let mascLoadedFor = null;
let surveyGridLoadedFor = null;
let cliLoadedFor = null;

/** Enable/disable MASC and Sec-Twp Grid toggles based on whether a
 *  muni is selected, and clear stale data + active state if the muni
 *  changed since the layers were last loaded. Mirrors the
 *  resetMuniParcelsToggle pattern. */
function resetMascAndGridToggles() {
  const muniSelected = !!$municipality.value;
  $mascToggle.disabled = !muniSelected;
  if ($cliToggle) $cliToggle.disabled = !muniSelected;
  // Sec-Twp Grid stays enabled with or without a muni — without a muni
  // selected it falls back to the pre-baked province-wide static file.
  $gridToggle.disabled = false;
  if (mascLoadedFor && mascLoadedFor !== $municipality.value) {
    mascLoadedFor = null;
    if ($mascToggle.classList.contains('active')) {
      $mascToggle.classList.remove('active');
      $mascToggle.setAttribute('aria-pressed', 'false');
      $mascToggle.textContent = 'MASC Rating';
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
  if (cliLoadedFor && cliLoadedFor !== $municipality.value) {
    cliLoadedFor = null;
    if ($cliToggle && $cliToggle.classList.contains('active')) {
      $cliToggle.classList.remove('active');
      $cliToggle.setAttribute('aria-pressed', 'false');
      $cliToggle.textContent = 'CLI Soil';
      mapReady.then(() => {
        setCliAgrVisible(map, false);
        if ($cliLegend) $cliLegend.hidden = true;
      });
    }
  }
  // Survey grid: track muni vs the __PROVINCE__ sentinel. Switching
  // between "any muni" and a specific muni invalidates the loaded
  // dataset so the toggle refetches the right scope. When the toggle
  // is already active at the moment of the muni change, re-trigger
  // the fetch so the user doesn't have to click off-then-on to see
  // the new muni's grid.
  const desiredKey = $municipality.value || '__PROVINCE__';
  if (surveyGridLoadedFor && surveyGridLoadedFor !== desiredKey) {
    surveyGridLoadedFor = null;
    if ($gridToggle.classList.contains('active')) {
      // Flip active off, drop the stale layer, then re-toggle which
      // re-enters the active branch and runs the fetch path.
      $gridToggle.classList.remove('active');
      $gridToggle.setAttribute('aria-pressed', 'false');
      $gridToggle.textContent = 'Sec-Twp Grid';
      mapReady.then(() => {
        setSurveyGridVisible(map, false);
        toggleSurveyGridOverlay();
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
  const muni = $municipality.value;
  const wasActive = $mascToggle.classList.contains('active');
  const visible = !wasActive;
  $mascToggle.classList.toggle('active', visible);
  $mascToggle.setAttribute('aria-pressed', String(visible));
  await mapReady;

  if (!visible) {
    $mascToggle.textContent = 'MASC Rating';
    setMascVisible(map, false);
    if ($mascLegend) $mascLegend.hidden = true;
    if ($resultsTable) $resultsTable.classList.remove('masc-mode');
    return;
  }

  if (mascLoadedFor !== muni) {
    $mascToggle.disabled = true;
    $mascToggle.textContent = 'Loading…';
    try {
      // Quarter-section + river-lot ratings load in parallel. Quarter
      // sections are the primary signal for most farmland; river-lot
      // polygons fill in the parishes around Selkirk, Ritchot, Portage,
      // etc. that the quarter CSV doesn't cover.
      const [rows, riverlotsAll] = await Promise.all([
        fetchMascRatingsForMuni(muni),
        fetchMascRiverlots(),
      ]);
      const hasQuarters = !!(rows && rows.length);
      const muniRiverlots = filterMascRiverlotsForMuni(riverlotsAll?.features || [], muni);
      if (!hasQuarters && muniRiverlots.length === 0) {
        $mascToggle.classList.remove('active');
        $mascToggle.setAttribute('aria-pressed', 'false');
        $mascToggle.disabled = false;
        $mascToggle.textContent = 'MASC Rating';
        setCount(`No MASC ratings on file for ${muni}.`);
        return;
      }
      setMascData(map, hasQuarters ? quartersToFc(rows) : { type: 'FeatureCollection', features: [] });
      setMascRiverlotsData(map, { type: 'FeatureCollection', features: muniRiverlots });
      mascLoadedFor = muni;
    } catch (err) {
      console.warn('MASC fetch failed', err);
      $mascToggle.classList.remove('active');
      $mascToggle.setAttribute('aria-pressed', 'false');
      $mascToggle.disabled = false;
      $mascToggle.textContent = 'MASC Rating';
      setCount(`Failed to load MASC soil ratings: ${err.message}`);
      return;
    }
    $mascToggle.disabled = false;
  }
  $mascToggle.textContent = 'MASC Rating';
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
async function toggleCliOverlay() {
  if (!$cliToggle) return;
  const muni = $municipality.value;
  const wasActive = $cliToggle.classList.contains('active');
  const visible = !wasActive;
  $cliToggle.classList.toggle('active', visible);
  $cliToggle.setAttribute('aria-pressed', String(visible));
  await mapReady;

  if (!visible) {
    $cliToggle.textContent = 'CLI Soil';
    setCliAgrVisible(map, false);
    if ($cliLegend) $cliLegend.hidden = true;
    return;
  }

  if (!muni) {
    $cliToggle.classList.remove('active');
    $cliToggle.setAttribute('aria-pressed', 'false');
    return;
  }

  if (cliLoadedFor !== muni) {
    $cliToggle.disabled = true;
    $cliToggle.textContent = 'Loading…';
    try {
      const muniFeat = muniBoundariesFc?.features?.find(
        (f) => f.properties?.MUNI_LIST_NAME_WITH_TYPE === muni,
      ) || null;
      if (!muniFeat) {
        $cliToggle.classList.remove('active');
        $cliToggle.setAttribute('aria-pressed', 'false');
        $cliToggle.disabled = false;
        $cliToggle.textContent = 'CLI Soil';
        setCount(`Couldn't locate boundary for ${muni}; can't load CLI.`);
        return;
      }
      const fc = await fetchCliAgrForMuni(muni, muniFeat);
      if (!fc || !fc.features || fc.features.length === 0) {
        $cliToggle.classList.remove('active');
        $cliToggle.setAttribute('aria-pressed', 'false');
        $cliToggle.disabled = false;
        $cliToggle.textContent = 'CLI Soil';
        setCount(`No CLI soil-capability polygons in ${muni}.`);
        return;
      }
      setCliAgrData(map, fc);
      cliLoadedFor = muni;
    } catch (err) {
      console.warn('CLI fetch failed', err);
      $cliToggle.classList.remove('active');
      $cliToggle.setAttribute('aria-pressed', 'false');
      $cliToggle.disabled = false;
      $cliToggle.textContent = 'CLI Soil';
      setCount(`Failed to load CLI soil capability: ${err.message}`);
      return;
    }
    $cliToggle.disabled = false;
  }
  $cliToggle.textContent = 'CLI Soil';
  setCliAgrVisible(map, true);
  if ($cliLegend) $cliLegend.hidden = false;
}

/**
 * Toggle the Sec-Twp Grid layer. Lazy-fetches the Manitoba Original
 * Survey FeatureServer scoped to the active muni's boundary polygon,
 * adapts the resulting points into the row shape sectionLinesFromRows
 * expects, and renders the section bounding boxes as a dashed-line
 * grid. Cached 30 days per-muni.
 */
async function toggleSurveyGridOverlay() {
  const muni = $municipality.value;
  const wasActive = $gridToggle.classList.contains('active');
  const visible = !wasActive;
  $gridToggle.classList.toggle('active', visible);
  $gridToggle.setAttribute('aria-pressed', String(visible));
  await mapReady;

  if (!visible) {
    $gridToggle.textContent = 'Sec-Twp Grid';
    setSurveyGridVisible(map, false);
    return;
  }

  // Use a sentinel string rather than null to track the "province-wide"
  // load — that way reselecting "any muni" → empty doesn't refetch the
  // province grid every time.
  const loadKey = muni || '__PROVINCE__';
  if (surveyGridLoadedFor !== loadKey) {
    $gridToggle.disabled = true;
    $gridToggle.textContent = 'Loading…';
    try {
      if (!muni) {
        // No muni selected — load the pre-baked province-wide grid AND
        // the river-lots overlay as static files in parallel. Both are
        // cached in localStorage on first hit; subsequent toggles are
        // instant. River lots are optional — if the file is missing
        // we just render the section grid alone.
        const [gridFc, riverFc] = await Promise.all([
          fetchProvinceSectionGrid(),
          fetchRiverLots(),
        ]);
        const merged = {
          type: 'FeatureCollection',
          features: [
            ...(gridFc?.features || []),
            ...(riverFc?.features || []),
          ],
        };
        setSurveyGridData(map, dedupSectionLabels(merged));
      } else {
        // Pull the muni's full boundary polygon from the cached
        // FeatureCollection (NOT querySourceFeatures, which returns
        // viewport-clipped geometry — that's why earlier Hanover queries
        // only covered the southern part of the RM). The full FC is set
        // by the boundaries fetch at startup.
        const muniFeat = muniBoundariesFc?.features?.find(
          (f) => f.properties?.MUNI_LIST_NAME_WITH_TYPE === muni,
        ) || null;
        if (!muniFeat) {
          $gridToggle.classList.remove('active');
          $gridToggle.setAttribute('aria-pressed', 'false');
          $gridToggle.disabled = false;
          $gridToggle.textContent = 'Sec-Twp Grid';
          setCount(`Couldn't locate boundary for ${muni}; can't load the section-township grid.`);
          return;
        }
        // Fetch the per-muni section grid AND the province-wide river-
        // lots file in parallel. The river-lots fetch is cheap on
        // repeat: same static file as the province path, served from
        // the browser's HTTP cache after the first hit. We keep only
        // the river lots whose bounding box intersects the selected
        // muni so the map source doesn't carry every Manitoba river
        // lot when only the local handful are visible at this zoom.
        const [fc, riverFc] = await Promise.all([
          fetchSurveyGridForMuni(muni, muniFeat),
          fetchRiverLots(),
        ]);
        const rows = surveyFcToRows(fc || { features: [] });
        const lines = sectionLinesFromRows(rows);
        const muniBbox = bboxOfFeature(muniFeat);
        const riverInMuni = (riverFc?.features || []).filter((f) => {
          try {
            const fb = bboxOfFeature(f);
            return bboxesIntersect(muniBbox, fb);
          } catch {
            return false;
          }
        });
        const merged = {
          type: 'FeatureCollection',
          features: [...(lines.features || []), ...riverInMuni],
        };
        setSurveyGridData(map, dedupSectionLabels(merged));
      }
      surveyGridLoadedFor = loadKey;
    } catch (err) {
      console.warn('Sec-Twp Grid fetch failed', err);
      $gridToggle.classList.remove('active');
      $gridToggle.setAttribute('aria-pressed', 'false');
      $gridToggle.disabled = false;
      $gridToggle.textContent = 'Sec-Twp Grid';
      setCount(`Failed to load section-township grid: ${err.message}`);
      return;
    }
    $gridToggle.disabled = false;
  }
  $gridToggle.textContent = 'Sec-Twp Grid';
  setSurveyGridVisible(map, true);
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

async function toggleAuxOverlay(which) {
  const meta = AUX_META[which];
  const btn = meta.btn();
  const wasActive = btn.classList.contains('active');
  const visible = !wasActive;
  btn.classList.toggle('active', visible);
  btn.setAttribute('aria-pressed', String(visible));
  btn.textContent = visible ? meta.on : meta.off;
  await mapReady;
  if (visible && !auxLoaded[which]) {
    btn.disabled = true;
    btn.textContent = meta.busy;
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
      if (which === 'muniParcels') muniParcelsLoadedFor = $municipality.value;
    } catch (err) {
      console.warn(`${which} fetch failed`, err);
      btn.classList.remove('active');
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = meta.off;
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    btn.textContent = meta.on;
  }
  meta.setVis(map, visible);
  // The AADT-colour legend rides along with the Flow toggle so the user
  // can read what each segment colour means. Only one place toggles it.
  if (which === 'flow' && $flowLegend) $flowLegend.hidden = !visible;
}

// ---------- UI helpers ----------

function setCount(text) { $count.textContent = text; }
function setBusy(busy) {
  $search.disabled = busy;
  $search.textContent = busy ? 'Searching…' : 'Search';
}

/** Hard-reset the page. A full reload + cache clear guarantees every
 *  piece of state — inputs, table, sort, map zoom, overlay toggles,
 *  in-flight requests, AND every cached overlay/dropdown — goes back
 *  to first-load. Walks both storage types since older builds used
 *  sessionStorage and current builds namespace into localStorage. */
function clearAll() {
  try { sessionStorage.clear(); } catch { /* private mode quota errors etc. */ }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('mbpsCache.')) localStorage.removeItem(k);
    }
  } catch { /* private mode etc. */ }
  window.location.href = window.location.pathname + window.location.search;
}

function clearTable() {
  $tbody.innerHTML = '';
  currentRows = [];
  setExportEnabled(false);
}

function renderTable(rows) {
  $tbody.innerHTML = '';
  currentRows = rows;
  rowFeatureMap.clear();
  const sorted = sortRows(rows);
  const frag = document.createDocumentFragment();
  for (const row of sorted) {
    const p = row.parcel.properties || {};
    const tr = document.createElement('tr');
    if (p._rowKey != null) {
      tr.dataset.rowKey = String(p._rowKey);
      if (row.parcel.geometry) rowFeatureMap.set(String(p._rowKey), row.parcel);
    }
    tr.classList.add('clickable');
    tr.title = 'Click to zoom map to this parcel';
    tr.addEventListener('click', () => {
      const f = rowFeatureMap.get(tr.dataset.rowKey);
      if (f) mapReady.then(() => flyToFeature(map, f));
    });

    const z1 = row.zoning[0]?.feature.properties || {};
    const z2 = row.zoning[1]?.feature.properties || {};
    const d1 = row.devPlan[0]?.feature.properties || {};
    const ac = parcelAcres(row.parcel);

    // Zoning 2 only shown when its coverage is ≥1% — sub-1% slivers are
    // usually GIS noise (boundary digitization slop) and clutter the table.
    const z2ratio = row.zoning[1]?.ratio;
    const z2Show = Number.isFinite(z2ratio) && z2ratio >= 0.01;

    tr.appendChild(rollNumberCell(p));
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
    const ppsfCell = td(formatGroupPpsf(p), 'num');
    ppsfCell.classList.add('sales-only');
    tr.appendChild(ppsfCell);
    const ppaCell = td(formatGroupPpa(p), 'num');
    ppaCell.classList.add('sales-only');
    tr.appendChild(ppaCell);
    tr.appendChild(td(p.Property_Address));
    tr.appendChild(legalCell(p));
    tr.appendChild(titleCell(p));
    tr.appendChild(td(formatZoneCode(z1)));
    tr.appendChild(td(formatPercent(row.zoning[0]?.ratio), 'num'));
    tr.appendChild(td(z2Show ? formatZoneCode(z2) : null));
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
    tr.appendChild(td(formatChanges(row)));
    tr.appendChild(td(formatDu(p.Dwelling_Units), 'num'));
    tr.appendChild(td(formatAcres(ac), 'num'));
    tr.appendChild(td(formatSf(ac), 'num'));
    tr.appendChild(assessmentCell(p));
    tr.appendChild(walkCell(row));
    tr.appendChild(floodCell(row));
    frag.appendChild(tr);
  }
  $tbody.appendChild(frag);
  setExportEnabled(rows.length > 0);
}

/**
 * Soil rating cell. Renders the dominant MASC rating letter (A→J) as a
 * coloured chip matching the overlay's A→J palette. Tooltip carries the
 * source quarter-section label so the user can verify which quarter
 * dominated a multi-quarter parcel. Empty cell when the parcel falls
 * outside MASC coverage (typical of urban lots).
 */
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
  swatch.style.backgroundColor = soilColor(rating);
  // White text on the visually-dark swatches (C olive, F dark green,
  // H magenta, I red, J purple) so the rating letter stays legible
  // against the chip background.
  swatch.style.color = ['C', 'F', 'H', 'I', 'J'].includes(rating) ? '#fff' : '#1a1a1a';
  if (p._soilQuarter) cell.title = `Source: ${p._soilQuarter}`;
  cell.appendChild(swatch);
  return cell;
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

function soilColor(code) {
  // Mirrors MASC_PALETTE in masc.js (and the masc-fill paint expression
  // in map.js). Keep the three lists synced when updating the palette.
  const map = { A:'#fff8c8', B:'#f2d640', C:'#847b14', D:'#a6e29f', E:'#4fab57',
                F:'#1a6b26', G:'#f4c2d1', H:'#e6228b', I:'#dc0000', J:'#9c27b0' };
  return map[code] || '#cccccc';
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

/** Split a 'X / CITY; Y / CITY' style certificates_of_title string
 *  into just the number tokens. Robust against extra whitespace and
 *  the alphanumeric prefix-letter forms (D15630, etc.). */
function parseTitleNumbers(raw) {
  const out = [];
  for (const part of String(raw || '').split(/\s*;\s*/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Take everything up to the first ' / ' (or end of string).
    const num = trimmed.split(/\s*\/\s*/)[0].trim();
    if (num) out.push(num);
  }
  return out;
}

function legalDisplay(p = {}) {
  if (realStr(p._legalDescription)) return realStr(p._legalDescription);
  const parts = [];
  if (realStr(p._lot)) parts.push(`L ${realStr(p._lot)}`);
  if (realStr(p._block)) parts.push(`B ${realStr(p._block)}`);
  if (realStr(p._plan)) parts.push(`P ${realStr(p._plan)}`);
  if (parts.length) return parts.join(' · ');
  return realStr(p._legalDetail);
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
 * Validate an external URL and only return it when its protocol is one
 * we trust. Defensive against unsafe javascript: / data: / vbscript:
 * URLs sneaking in from external open-data sources we don't control
 * (Manitoba Assessment Online, contaminated-sites registry, etc.).
 * Returns null for invalid or non-http(s) URLs.
 */
function safeExternalUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw), window.location.origin);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch { /* not a parseable URL */ }
  return null;
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
      key = `S${p.section}|T${p.township}|R${p.range}|${dir}`;
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
 * In-place filter on the parcel FC: keep only features whose
 * Property_Address leads with a civic number in [from, to]. A blank
 * `from` means no lower bound; blank `to` means no upper bound. When
 * both are blank, the FC passes through untouched. Letter suffixes
 * (e.g. "100A") sort between the integer and the next integer, so:
 *   from "100"  to "200"  → matches 100, 100A, 100B, 101, ..., 200, 200A
 *   from "100A" to "100C" → matches only 100A, 100B, 100C
 *   from "100"  to "100"  → matches 100 and any 100x letter variants
 * Records that don't begin with a civic number (legal descriptions
 * stuffed into Property_Address, junk reference codes) get dropped
 * whenever a range is set; if the user hasn't set a range, those
 * records are left alone.
 */
function applyCivicNumberRange(fc, fromRaw, toRaw) {
  const from = parseCivicBound(fromRaw, 'lower');
  const to   = parseCivicBound(toRaw,   'upper');
  if (from == null && to == null) return;
  const features = fc?.features || [];
  const kept = [];
  for (const f of features) {
    const k = parseCivicAddressKey(f?.properties?.Property_Address);
    if (k == null) continue;                   // no civic number → drop when range set
    if (from != null && k < from) continue;
    if (to   != null && k > to)   continue;
    kept.push(f);
  }
  fc.features = kept;
}

/** Parse a civic-address string into a sortable integer key.
 *  "444 1ST ST"   -> 44400
 *  "100A MAIN ST" -> 10001  (A = +1)
 *  "100B MAIN ST" -> 10002
 *  "60158 ROAD 96W" -> 6015800
 *  "DESC NE22-21-3E" -> null
 *  "NE1-1-3E" -> null
 *  Letter index uses A=1..Z=26, leaving 0 for "no suffix" so a bare
 *  number sorts BEFORE any of its letter-suffixed variants. */
function parseCivicAddressKey(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d+)([A-Za-z]?)\s/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const letter = m[2] ? m[2].toUpperCase().charCodeAt(0) - 64 : 0;
  return num * 100 + letter;
}

/** Parse a From/To bound into a comparison key. The asymmetry handles
 *  user expectations:
 *    from "100" (no letter) → 100*100 + 0   so 100 itself is included
 *    to   "100" (no letter) → 100*100 + 99  so any 100x suffix included
 *    from "100A" / to "100A" → exact         (100*100 + 1)
 *  Returns null on empty/garbage input. */
function parseCivicBound(raw, kind) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d+)([A-Za-z]?)$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const letter = m[2] ? m[2].toUpperCase().charCodeAt(0) - 64 : null;
  if (letter != null) return num * 100 + letter;
  // No letter typed: lower bound includes the bare number; upper bound
  // extends across every letter-suffixed variant of that number.
  return kind === 'upper' ? num * 100 + 99 : num * 100;
}

function filterMascRiverlotsForMuni(features, selectedMuni) {
  const exact = features.filter((f) => featureMascMunis(f).some((muni) => (
    muniIdentitiesMatch(muni, selectedMuni, { allowTypeFallback: false })
  )));
  if (exact.length > 0) return exact;

  // Some long parish lots are boundary-tagged to an enclave Town while
  // the MASC source or Roll Entry parcel sits with the surrounding RM.
  // If there is no exact typed match, fall back to the shared bare
  // muni name so those rated river lots still surface for parcel users.
  return features.filter((f) => featureMascMunis(f).some((muni) => (
    muniIdentitiesMatch(muni, selectedMuni, { allowTypeFallback: true })
  )));
}

function featureMascMunis(feature) {
  const p = feature?.properties || {};
  return [
    p.muni,
    p.rating_muni,
    p.ratingMuni,
    p.source_muni,
  ].filter((value, idx, values) => value && values.indexOf(value) === idx);
}

function muniIdentitiesMatch(sourceMuni, selectedMuni, { allowTypeFallback = false } = {}) {
  const source = parseMuniIdentity(sourceMuni);
  const selected = parseMuniIdentity(selectedMuni);
  if (!source.name || !selected.name || source.name !== selected.name) return false;
  if (!source.type || !selected.type || source.type === selected.type) return true;
  return allowTypeFallback;
}

function parseMuniIdentity(value) {
  let s = String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\./g, '')
    .replace(/_/g, ' ')
    .replace(/&/g, ' AND ')
    .replace(/\s+/g, ' ')
    .trim();
  let type = null;

  const parenthetical = s.match(/\((RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE)\)\s*$/);
  if (parenthetical) {
    type = normalizeMuniType(parenthetical[1]);
    s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  s = s.replace(
    /\b(RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE)\s+OF\b/g,
    (_, t) => {
      type ||= normalizeMuniType(t);
      return '';
    },
  );
  s = s.replace(/\s+(RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE)$/g, (_, t) => {
    type ||= normalizeMuniType(t);
    return '';
  });
  s = s
    .replace(/\bMTN\b/g, 'MOUNTAIN')
    .replace(/\bFRANCOIS\b/g, 'FRANCIS')
    .replace(/\bDESALABERRY\b/g, 'DE SALABERRY')
    .replace(/\bSAINTE\b/g, 'STE')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { name: s, type };
}

function normalizeMuniType(value) {
  const t = String(value || '').toUpperCase().trim();
  if (t === 'RURAL MUNICIPALITY') return 'RM';
  return t;
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
function realStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '<Null>' || s.toLowerCase() === 'null') return null;
  return s;
}

function formatChanges(row) {
  const parts = [];
  const z = row.zoning[0]?.feature.properties || {};
  const amendDesc = realStr(z.AMENDMENT_DESCRIPTION);
  const zbl   = realStr(z.ZBL);
  const zblA  = realStr(z.ZBL_A);
  const zblChanged = zbl && zblA && zbl !== zblA;
  if (zblChanged) {
    parts.push(`Z: ${amendDesc || `${zbl} → ${zblA}`}`);
  } else if (amendDesc) {
    parts.push(`Z: ${amendDesc}`);
  }
  const d = row.devPlan[0]?.feature.properties || {};
  const dp  = realStr(d.DP_BYLAW);
  const dpA = realStr(d.DPA_BYLAW);
  if (dp && dpA && dp !== dpA) {
    parts.push(`DP: ${dp} → ${dpA}`);
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
  // Prefer Roll_Entry's Frontage_or_Area when the assessor recorded
  // an actual area ('5.000 Acres') — that's the official figure and
  // beats anything we'd derive from the polygon. Falls back to the
  // turf-area calc when the field is in frontage feet or missing.
  const fromField = acresFromFrontageField(feature?.properties?.Frontage_or_Area);
  if (fromField != null) {
    feature._acres = fromField;
    if (feature.properties) feature.properties._acresSource = 'assessor';
    return fromField;
  }
  if (!feature.geometry) return null;
  try {
    // turf area returns sq metres for GeoJSON in WGS84 (uses geodesic calc).
    const sqm = turfArea(feature);
    const ac = sqm / 4046.8564224;
    feature._acres = ac;
    if (feature.properties) feature.properties._acresSource = 'geometry';
    return ac;
  } catch {
    return null;
  }
}

function formatAcres(v) {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  // Always 2 decimals for the table column. Large values still get
  // thousands separators so '12345.67' reads as '12,345.67'.
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Group $/Acre table cell. Returns the formatted dollar string, or
 *  '—' when group acres are incomplete (insufficient data flag set
 *  by computeSaleGroupTotals), or null when the parcel isn't part
 *  of a sale group at all. */
function formatGroupPpa(p) {
  if (!p?._saleGroupSize) return null;
  if (p._saleGroupAcresIncomplete) return '—';
  const ppa = Number(p._saleGroupPpa);
  if (!Number.isFinite(ppa) || ppa <= 0) return null;
  return '$' + Math.round(ppa).toLocaleString('en-US');
}

/** Group $/SF table cell. Same shape as formatGroupPpa. */
function formatGroupPpsf(p) {
  if (!p?._saleGroupSize) return null;
  if (p._saleGroupAcresIncomplete) return '—';
  const ppsf = Number(p._saleGroupPpsf);
  if (!Number.isFinite(ppsf) || ppsf <= 0) return null;
  return '$' + ppsf.toFixed(2);
}

/** Group $/Lot table cell — sale price ÷ number of parcels in the
 *  group. Doesn't depend on acres so it works even when acres are
 *  incomplete (no '—' fallback needed). */
function formatGroupPpl(p) {
  if (!p?._saleGroupSize) return null;
  const ppl = Number(p._saleGroupPpl);
  if (!Number.isFinite(ppl) || ppl <= 0) return null;
  return '$' + Math.round(ppl).toLocaleString('en-US');
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
  if (acres == null || !Number.isFinite(acres) || acres <= 0) return null;
  return Math.round(acres * 43560).toLocaleString('en-US');
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

function formatCurrency(s) {
  const n = parseTotalValue(s);
  if (n == null || n <= 0) return null;
  return '$' + Math.round(n).toLocaleString('en-US');
}

// ---------- CSV export ----------

function setExportEnabled(enabled) { $export.disabled = !enabled; }

function exportCsv() {
  if (!currentRows.length) return;
  // Append the sales-CSV-specific columns only when the table is
  // currently in sales-mode — otherwise they'd just be empty trailing
  // cells on every row of a regular search export.
  const inSalesMode = $resultsTable?.classList.contains('sales-mode');
  const header = [
    'Roll #', 'Address',
    'Legal Description', 'Legal Detail', 'Lot', 'Block', 'Plan',
    'Certificates of Title', 'MAO Legal Source URL',
    'Zoning', 'Zoning %',
    'Zoning 2', 'ZBL',
    'Dev-Plan Designation', 'DP By-law',
    'Soil Rating', 'Risk Area',
    'Changes',
    'DU', 'Acres', 'SF',
    csvAssessHeader(currentRows), 'Asmt Report URL',
    'Walkscore URL', 'Flood-Map URL',
    ...(inSalesMode
      ? ['Sale Date', 'Sale Price', 'Group #', 'Group $/Lot', 'Group $/SF', 'Group $/Acre']
      : []),
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const row of currentRows) {
    const p = row.parcel.properties || {};
    const z1 = row.zoning[0]?.feature.properties || {};
    const z2 = row.zoning[1]?.feature.properties || {};
    const d1 = row.devPlan[0]?.feature.properties || {};
    const ac = parcelAcres(row.parcel);
    lines.push([
      p.Roll_No_Txt, p.Property_Address,
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
      formatChanges(row),
      p.Dwelling_Units ?? '',
      formatAcresCsv(ac),
      ac != null && Number.isFinite(ac) && ac > 0 ? Math.round(ac * 43560) : '',
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
  a.download = `manitoba-parcels-${today()}.csv`;
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

function csvCell(value) {
  if (value == null) return '';
  const s = String(value);
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

function td(value, className) {
  const el = document.createElement('td');
  if (value == null || value === '') {
    el.textContent = '—';
    el.classList.add('empty');
  } else {
    el.textContent = value;
  }
  if (className) el.classList.add(className);
  return el;
}
