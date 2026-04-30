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
  fetchTrafficStations,
  fetchTrafficFlow,
  fetchAllParcelsInMunicipality,
  buildAadtIndex,
} from './arcgis.js';
import {
  initMap,
  showResults,
  setZoningData,
  setDevPlanData,
  setZoningVisible,
  setDevPlanVisible,
  setContamData,
  setContamVisible,
  setTrafficData,
  setTrafficVisible,
  setTrafficFlowData,
  setTrafficFlowVisible,
  setMuniParcelsData,
  setMuniParcelsVisible,
  flyToFeature,
} from './map.js';
import turfArea from '@turf/area';

const $address       = document.getElementById('address');
const $municipality  = document.getElementById('municipality');
const $roll          = document.getElementById('roll');
const $zoneCategory  = document.getElementById('zone-category');
const $changedStatus = document.getElementById('changed-status');
const $duMode        = document.getElementById('du-mode');
const $duMin         = document.getElementById('du-min');
const $search        = document.getElementById('search');
const $clear         = document.getElementById('clear');
const $export        = document.getElementById('export');
const $zoningToggle  = document.getElementById('zoning-toggle');
const $devplanToggle = document.getElementById('devplan-toggle');
const $contamToggle  = document.getElementById('contam-toggle');
const $trafficToggle = document.getElementById('traffic-toggle');
const $flowToggle    = document.getElementById('flow-toggle');
const $muniParcelsToggle = document.getElementById('muni-parcels-toggle');
const $count         = document.getElementById('count');
const $tbody         = document.querySelector('#results tbody');
const $mapEl         = document.getElementById('map');
const $legend        = document.getElementById('map-legend');
const $flowLegend    = document.getElementById('flow-legend');

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Most recent table rows, kept around for CSV export.
let currentRows = [];

// row key -> the Feature whose geometry we should fly to when the user
// clicks that row. Cleared on every renderTable.
const rowFeatureMap = new Map();

// Cached overlay FCs from the most recent search, so toggling the zoning
// or dev-plan layer on doesn't require re-running the spatial enrichment.
let lastZoningFc = EMPTY_FC;
let lastDevPlanFc = EMPTY_FC;

// ---------- Column sort ----------

let currentSort = { col: 'roll', dir: 'asc' };

const SORT_KEYS = {
  roll:    (r) => strKey(r.parcel.properties.Roll_No_Txt),
  address: (r) => strKey(r.parcel.properties.Property_Address),
  zone1:   (r) => strKey(r.zoning[0]?.feature.properties.ZONE),
  zone1pct:(r) => finiteOrNeg(r.zoning[0]?.ratio),
  zone2:   (r) => strKey(r.zoning[1]?.feature.properties.ZONE),
  zone2pct:(r) => finiteOrNeg(r.zoning[1]?.ratio),
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
$trafficToggle.addEventListener('click', () => toggleAuxOverlay('traffic'));
$flowToggle.addEventListener('click', () => toggleAuxOverlay('flow'));
$muniParcelsToggle.addEventListener('click', () => toggleAuxOverlay('muniParcels'));
$municipality.addEventListener('change', () => {
  refilterCategoryDropdowns();
  resetMuniParcelsToggle();
});
// The "Min #" number input is only meaningful when Min DU is selected.
// Disable it otherwise so users can't type a value that has no effect.
$duMode.addEventListener('change', () => {
  const enableMin = $duMode.value === 'min';
  $duMin.disabled = !enableMin;
  if (!enableMin) $duMin.value = '';
  if (enableMin && !$duMin.value) $duMin.value = '1';
});
for (const el of [$address, $roll]) {
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

  if (!Object.values(inputs).some(Boolean)) {
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
    let parcelFc;
    try {
      parcelFc = await searchParcels(inputs);
    } catch (err) {
      console.error(err);
      setCount(`Search failed: ${err.message}`);
      return;
    }

    const n = parcelFc.features.length;
    if (n === 0) {
      setCount('No parcels found.');
      return;
    }

    const baseMsg = parcelFc._truncated
      ? `${n} parcels found (server cap reached — refine your search)`
      : `${n} parcels found`;
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

    renderTable(rows);
    setMapData(parcelFc, zoningFc, devPlanFc);
    setCount(baseMsg);
  } finally {
    setBusy(false);
  }
}

// ---------- Map / overlay helpers ----------

function setMapData(parcelFc, zoningFc, devPlanFc) {
  if ($legend) $legend.hidden = parcelFc.features.length === 0;
  mapReady.then(() => {
    showResults(map, parcelFc);
    setZoningData(map, zoningFc);
    setDevPlanData(map, devPlanFc);
  });
}

function toggleOverlay(which) {
  const btn = which === 'zoning' ? $zoningToggle : $devplanToggle;
  const labelOn  = which === 'zoning' ? 'Hide Zoning'   : 'Hide Dev Plan';
  const labelOff = which === 'zoning' ? 'Show Zoning'   : 'Show Dev Plan';
  const wasActive = btn.classList.contains('active');
  const visible = !wasActive;
  btn.classList.toggle('active', visible);
  btn.setAttribute('aria-pressed', String(visible));
  btn.textContent = visible ? labelOn : labelOff;
  mapReady.then(() => {
    if (which === 'zoning') {
      setZoningVisible(map, visible);
    } else {
      setDevPlanVisible(map, visible);
    }
  });
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
const auxLoaded = { contam: false, traffic: false, flow: false, muniParcels: false };
const auxData   = { contam: null, traffic: null, flow: null, muniParcels: null };
// Tracks which muni's parcels are currently in the muni-parcels source so
// we know whether to refetch when the user switches munis.
let muniParcelsLoadedFor = null;

const AUX_META = {
  contam:      { btn: () => $contamToggle,      on: 'Hide Enviro',       off: 'Show Enviro',       busy: 'Loading enviro…',
                 fetch: () => fetchContaminatedSites(),       setData: (m, fc) => setContamData(m, fc),      setVis: setContamVisible },
  traffic:     { btn: () => $trafficToggle,     on: 'Hide Stations',     off: 'Show Stations',     busy: 'Loading stations…',
                 fetch: () => fetchTrafficStations(),         setData: (m, fc) => setTrafficData(m, fc),     setVis: setTrafficVisible },
  flow:        { btn: () => $flowToggle,        on: 'Hide Flow',         off: 'Show Flow',         busy: 'Loading flow…',
                 fetch: () => fetchTrafficFlow(),             setData: (m, fc) => setTrafficFlowData(m, fc), setVis: setTrafficFlowVisible },
  muniParcels: { btn: () => $muniParcelsToggle, on: 'Hide Muni Parcels', off: 'Show Muni Parcels', busy: 'Loading muni parcels…',
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
      $muniParcelsToggle.textContent = 'Show Muni Parcels';
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
      if (which === 'flow' && auxData.traffic) stampStationAadt(auxData.traffic, fc);
      if (which === 'traffic' && auxData.flow) stampStationAadt(fc, auxData.flow);
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

/** Mutate each station feature in-place to carry the AADT value of the
 *  matching Traffic Flow segment (max AADT across all matching segments).
 *  Re-pushes the station data to the map so the popup template sees the
 *  updated property. */
function stampStationAadt(stationsFc, flowFc) {
  const idx = buildAadtIndex(flowFc);
  for (const f of stationsFc.features || []) {
    const sn = f.properties?.StationNum;
    if (sn != null && idx.has(sn)) f.properties._aadt = idx.get(sn);
  }
  // If the stations layer is currently visible, push the updated FC so
  // the popup hits the new property.
  setTrafficData(map, stationsFc);
}

// ---------- UI helpers ----------

function setCount(text) { $count.textContent = text; }
function setBusy(busy) {
  $search.disabled = busy;
  $search.textContent = busy ? 'Searching…' : 'Search';
}

/** Hard-reset the page. A full reload + sessionStorage clear guarantees
 *  every piece of state — inputs, table, sort, map zoom, overlay toggles,
 *  in-flight requests, AND the cached muni/category dropdown lists — goes
 *  back to first-load. */
function clearAll() {
  try { sessionStorage.clear(); } catch { /* private mode quota errors etc. */ }
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

    tr.appendChild(td(p.Roll_No_Txt));
    tr.appendChild(td(p.Property_Address));
    tr.appendChild(td(formatZoneCode(z1)));
    tr.appendChild(td(formatPercent(row.zoning[0]?.ratio), 'num'));
    tr.appendChild(td(z2Show ? formatZoneCode(z2) : null));
    tr.appendChild(td(z2Show ? formatPercent(z2ratio) : null, 'num'));
    tr.appendChild(td(z1.ZBL));
    tr.appendChild(td(formatDes(d1)));
    tr.appendChild(td(d1.DP_BYLAW));
    tr.appendChild(td(formatChanges(row)));
    tr.appendChild(td(formatDu(p.Dwelling_Units), 'num'));
    tr.appendChild(td(formatAcres(ac), 'num'));
    tr.appendChild(td(formatSf(ac), 'num'));
    tr.appendChild(walkCell(row));
    tr.appendChild(td(formatCurrency(p.Total_Value), 'num'));
    tr.appendChild(reportCell(p.Asmt_Rpt_Url));
    frag.appendChild(tr);
  }
  $tbody.appendChild(frag);
  setExportEnabled(rows.length > 0);
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
  a.textContent = 'view';
  a.addEventListener('click', (e) => e.stopPropagation());
  cell.appendChild(a);
  return cell;
}

function reportCell(url) {
  const cell = document.createElement('td');
  if (!url) {
    cell.textContent = '—';
    cell.classList.add('empty');
    return cell;
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = 'view';
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
function formatChanges(row) {
  const parts = [];
  const z = row.zoning[0]?.feature.properties || {};
  // The source data stores ~385 AMENDMENT_DESCRIPTION values as a literal
  // single-space (or other whitespace) instead of null. Treat those as
  // empty so the cell doesn't render as "Z: " with nothing useful after.
  const amendDesc = z.AMENDMENT_DESCRIPTION && z.AMENDMENT_DESCRIPTION.trim();
  const zblChanged = z.ZBL_A && z.ZBL && z.ZBL_A !== z.ZBL;
  if (zblChanged) {
    parts.push(`Z: ${amendDesc || `${z.ZBL} → ${z.ZBL_A}`}`);
  } else if (amendDesc) {
    parts.push(`Z: ${amendDesc}`);
  }
  const d = row.devPlan[0]?.feature.properties || {};
  if (d.DPA_BYLAW && d.DP_BYLAW && d.DPA_BYLAW !== d.DP_BYLAW) {
    parts.push(`DP: ${d.DP_BYLAW} → ${d.DPA_BYLAW}`);
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
    'Zoning', 'Zoning %',
    'Zoning 2', 'Zoning 2 %', 'Zoning By-law',
    'Dev-Plan Designation', 'DP By-law',
    'Changes',
    'DU', 'Acres', 'SF',
    'Walkscore URL',
    'Total Value ($)', 'Asmt Report URL',
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
      formatZoneCode(z1), ratioPct(row.zoning[0]?.ratio),
      formatZoneCode(z2), ratioPct(row.zoning[1]?.ratio), z1.ZBL,
      formatDes(d1), d1.DP_BYLAW,
      formatChanges(row),
      p.Dwelling_Units ?? '',
      formatAcresCsv(ac),
      ac != null && Number.isFinite(ac) && ac > 0 ? Math.round(ac * 43560) : '',
      walkscoreUrl(p),
      parseTotalValue(p.Total_Value) ?? '',
      p.Asmt_Rpt_Url ?? '',
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

/** Compose the walkscore.com search URL for a parcel, or '' when no
 *  street address is present. Mirrors the table-cell logic so CSV exports
 *  match what the user sees. */
function walkscoreUrl(p) {
  const street = (p.Property_Address || '').trim();
  if (!street) return '';
  const muni = (p.Muni_Name_With_Typ || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return `https://www.walkscore.com/score/${encodeURIComponent([street, muni, 'MB'].filter(Boolean).join(', '))}`;
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
