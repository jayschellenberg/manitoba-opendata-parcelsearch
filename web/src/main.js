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
  parseRollList,
  missingRollsFromResults,
} from './arcgis.js';
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
  flyToFeature,
  buildZoneCodePaint,
} from './map.js';
import {
  hasLegalCriteria,
  legalRecordKey,
  parcelLegalKey,
  searchLegalIndex,
} from './legalIndex.js';
import turfArea from '@turf/area';

const $address       = document.getElementById('address');
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
const $count         = document.getElementById('count');
const $tbody         = document.querySelector('#results tbody');
const $mapEl         = document.getElementById('map');
const $flowLegend    = document.getElementById('flow-legend');
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
  'PORTAGE LA PRAIRIE':                'https://www.ptgplanning.ca/',
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
};

function strKey(v) {
  return (v == null || v === '') ? '￿' : String(v).toLowerCase();
}
function finiteOrNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : -Infinity;
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
$zoningToggle.addEventListener('click', () => toggleOverlay('zoning'));
$devplanToggle.addEventListener('click', () => toggleOverlay('devplan'));
$contamToggle.addEventListener('click', () => toggleAuxOverlay('contam'));
$flowToggle.addEventListener('click', () => toggleAuxOverlay('flow'));

const $staticMapBtn    = document.getElementById('static-map-btn');
const $staticMapOutput = document.getElementById('static-map-output');
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
    $staticMapOutput.hidden = false;
    $staticMapOutput.innerHTML = '<p style="color:#c0392b">Capture failed — try toggling the satellite basemap and re-trying. If it persists, check the browser console.</p>';
  } finally {
    $staticMapBtn.disabled = false;
    $staticMapBtn.textContent = originalLabel;
  }
}
$muniParcelsToggle.addEventListener('click', () => toggleAuxOverlay('muniParcels'));
$municipality.addEventListener('change', () => {
  refilterCategoryDropdowns();
  resetMuniParcelsToggle();
  updateMuniWebsiteButton();
  // Reset the PD button until the next search resolves the planning
  // district from the dev-plan layer's PLANNINGDISTRICT field.
  setExternalLinkButton($pdWebsiteBtn, null, 'PD Website', 'Run a search to detect the planning district');
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
// Filter out any nulls so the keydown wiring tolerates removed inputs
// (legal/lot/block/plan/title are currently absent from the markup).
for (const el of [$address, $roll, $legalText, $lot, $block, $plan, $title].filter(Boolean)) {
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

// Pull municipal boundaries in the background and load them onto the
// map as soon as both the data and the map are ready. Cached for 30
// days so this is a one-time hit per month per browser; on a cache
// hit it lands instantly. Failures are non-fatal — boundaries are
// reference data, not critical to a search.
(async () => {
  try {
    const fc = await fetchMunicipalBoundaries();
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
  const status = $changedStatus.value;
  const legalInputs = {
    legalText:      $legalText?.value.trim() ?? '',
    lot:            $lot?.value.trim()       ?? '',
    block:          $block?.value.trim()     ?? '',
    plan:           $plan?.value.trim()      ?? '',
    title:          $title?.value.trim()     ?? '',
  };
  const inputs = {
    address:         $address.value.trim(),
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
    if (legalResult) attachLegalMetadata(parcelFc, legalResult.matches);

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
    setCount(`${baseMsg} · loading zoning + dev-plan…`);

    // Stamp _rowKey so map clicks can find the matching table row.
    for (const f of parcelFc.features) {
      const oid = f.properties?.OBJECTID;
      if (oid != null) f.properties._rowKey = `p:${oid}`;
    }

    // Show parcels-only rows immediately so the user sees something.
    renderTable(parcelFc.features.map((p) => ({ parcel: p, zoning: [], devPlan: [] })));
    setMapData(parcelFc, EMPTY_FC, EMPTY_FC);

    // Spatial enrichment in parallel — both overlay layers from one pass.
    let zoningFc = EMPTY_FC;
    let devPlanFc = EMPTY_FC;
    try {
      [zoningFc, devPlanFc] = await Promise.all([
        fetchZoningOverlap(parcelFc, { municipality: inputs.municipality }),
        fetchDevPlanOverlap(parcelFc, { municipality: inputs.municipality }),
      ]);
    } catch (err) {
      console.warn('overlay fetch failed', err);
      setCount(`${baseMsg} · zoning/dev-plan enrichment failed: ${err.message}`);
      return;
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

    // Stamp the most-common assessment year into the Total Value column
    // header so users can tell which assessment cycle the dollar figure
    // is anchored to (Manitoba's general assessment year rolls every
    // two years; the field is sometimes mid-cycle for a recent revision).
    updateAssessmentYearHeader(rows);

    renderTable(rows);
    setMapData(parcelFc, zoningFc, devPlanFc);
    setCount(baseMsg);
  } finally {
    setBusy(false);
  }
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

// ---------- Map / overlay helpers ----------

function setMapData(parcelFc, zoningFc, devPlanFc) {
  mapReady.then(() => {
    showResults(map, parcelFc);
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
 *   traffic — MHTIS station locations (FeatureServer points)
 *   flow    — MHTIS Traffic Flow 2019 (FeatureServer polylines, AADT-coloured)
 *
 * All three are lazily fetched on first activation and cached in
 * sessionStorage. Loading the flow layer also opportunistically joins
 * AADT onto the already-loaded stations so the station popup can show
 * the segment AADT inline (and vice-versa: loading stations after flow
 * triggers the same join). Failures are non-fatal — the button reverts.
 */
const auxLoaded = { contam: false, flow: false, muniParcels: false };
const auxData   = { contam: null, flow: null, muniParcels: null };
// Tracks which muni's parcels are currently in the muni-parcels source so
// we know whether to refetch when the user switches munis.
let muniParcelsLoadedFor = null;

const AUX_META = {
  contam:      { btn: () => $contamToggle,      on: 'Enviro Sites', off: 'Enviro Sites', busy: 'Loading…',
                 fetch: () => fetchContaminatedSites(),       setData: (m, fc) => setContamData(m, fc),      setVis: setContamVisible },
  flow:        { btn: () => $flowToggle,        on: 'Traffic Flow', off: 'Traffic Flow', busy: 'Loading…',
                 fetch: () => fetchTrafficFlow(),             setData: (m, fc) => setTrafficFlowData(m, fc), setVis: setTrafficFlowVisible },
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
      // If the station data and the flow data are both loaded, stamp each
      // station with the matching segment's AADT so the station popup can
      // render the value inline. Done as a stable index lookup, no per-
      // popup network calls.
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
    tr.appendChild(td(p.Property_Address));
    tr.appendChild(legalCell(p));
    tr.appendChild(td(p._certificatesOfTitle));
    tr.appendChild(td(formatZoneCode(z1)));
    tr.appendChild(td(formatPercent(row.zoning[0]?.ratio), 'num'));
    tr.appendChild(td(z2Show ? formatZoneCode(z2) : null));
    tr.appendChild(td(z1.ZBL));
    tr.appendChild(td(formatDes(d1)));
    tr.appendChild(td(d1.DP_BYLAW));
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
  const safe = safeExternalUrl(p.Asmt_Rpt_Url);
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
  if (!feature?.geometry) return null;
  // Lazy-attach the result so we don't recompute on each sort tick.
  if (feature._acres != null) return feature._acres;
  try {
    // turf area returns sq metres for GeoJSON in WGS84 (uses geodesic calc).
    const sqm = turfArea(feature);
    const ac = sqm / 4046.8564224;
    feature._acres = ac;
    return ac;
  } catch {
    return null;
  }
}

function formatAcres(v) {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  if (v < 0.1)   return v.toFixed(3);
  if (v < 10)    return v.toFixed(2);
  if (v < 1000)  return v.toFixed(1);
  return Math.round(v).toLocaleString('en-US');
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
  const header = [
    'Roll #', 'Address',
    'Legal Description', 'Legal Detail', 'Lot', 'Block', 'Plan',
    'Certificates of Title', 'MAO Legal Source URL',
    'Zoning', 'Zoning %',
    'Zoning 2', 'ZBL',
    'Dev-Plan Designation', 'DP By-law',
    'Changes',
    'DU', 'Acres', 'SF',
    csvAssessHeader(currentRows), 'Asmt Report URL',
    'Walkscore URL', 'Flood-Map URL',
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
      formatChanges(row),
      p.Dwelling_Units ?? '',
      formatAcresCsv(ac),
      ac != null && Number.isFinite(ac) && ac > 0 ? Math.round(ac * 43560) : '',
      parseTotalValue(p.Total_Value) ?? '',
      p.Asmt_Rpt_Url ?? '',
      walkscoreUrl(p),
      floodMapUrl(row),
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
    setExternalLinkButton($muniWebsiteBtn, null, 'Muni Website', 'Select a municipality to enable');
    return;
  }
  const url = lookupMuniWebsite(muni);
  setExternalLinkButton($muniWebsiteBtn, url, 'Muni Website',
    `No website on file for ${muni}. Add it to MUNI_WEBSITES in main.js.`);
}

/** After a search lands, infer the parcel set's Planning District from
 *  the dev-plan layer's PLANNINGDISTRICT field (most-frequent value
 *  wins) and look up its URL in PD_WEBSITES. */
function updatePdWebsiteButton(devPlanFc) {
  const counts = new Map();
  for (const f of devPlanFc?.features || []) {
    const pd = f.properties?.PLANNINGDISTRICT;
    if (pd) counts.set(pd, (counts.get(pd) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [pd, c] of counts) if (c > bestCount) { best = pd; bestCount = c; }
  if (!best) {
    setExternalLinkButton($pdWebsiteBtn, null, 'PD Website',
      'No planning district found in this search\'s dev-plan polygons');
    return;
  }
  const url = lookupPdWebsite(best);
  setExternalLinkButton($pdWebsiteBtn, url, 'PD Website',
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
