// ArcGIS REST API client for Manitoba Open Data.
//
// Three FeatureServer layers, all hosted on the same Manitoba ArcGIS Online
// org and CORS-enabled (Access-Control-Allow-Origin: *):
//
//   ROLL_ENTRY                       parcels   geometry: polygon
//     Roll_No_Txt, Property_Address, Municipality, Muni_Name_With_Typ,
//     Asmt_Roll, Dwelling_Units, Frontage_or_Area, Total_Value,
//     Asmt_Rpt_Url, Shape__Area
//   Manitoba_Zoning_By_Laws          zoning    geometry: polygon
//     ZONE, ZONE_NAME, ZONE_CATEGORY, ZBL, ZBL_A, MUNI_NAME,
//     PLANNINGREGION, PLANNINGDISTRICT, AREA
//   Manitoba_Development_Plan_Designations  dev plan  geometry: polygon
//     DES_NAME, DES_CATEGORY, DP_BYLAW, DPA_BYLAW, PLANNINGDISTRICT,
//     PLANNINGREGION, MUNI_NAME, RES_MIN_ACRES_PER_LOT,
//     RES_MAX_ACRES_PER_LOT, ACRES, AU_LIMIT
//
// Single search flow (Manitoba doesn't have a separate survey/legal-lots
// dataset — Roll_Entry IS the parcels):
//
//   1. searchParcels({ address, municipality, roll, zoneCategory,
//        devPlanCategory }) — attribute query against Roll_Entry. Filled
//        text fields use case-insensitive UPPER(...) LIKE; the muni and
//        category dropdowns use exact equality.
//   2. fetchZoningOverlap(parcelFc) and fetchDevPlanOverlap(parcelFc) —
//      per-parcel envelope query against Zoning + Dev Plan layers (true
//      esriSpatialRelIntersects, no padding needed). Run in parallel.
//   3. joinTopNByArea(parcelFc, overlayFc, n=2) — for each parcel, clip
//      overlay polygons to the parcel polygon, compute intersection area,
//      sort desc, return top N with coverage ratio. Mirrors the
//      get_multiple_by_area() helper in mao-assembly's Step 1 pipeline.
//
// Notes vs. the Winnipeg sister tool:
//   - Pagination uses resultOffset/resultRecordCount (not Socrata's
//     $offset/$limit).
//   - 'where' uses real SQL UPPER(col) LIKE '%X%' — not Socrata upper().
//   - spatialRel=esriSpatialRelIntersects is a true intersection test, so
//     there's no 150m bbox padding (Bug 10.2 in REPLICATION_GUIDE doesn't
//     apply). The client-side overlap re-check is dropped accordingly.
//   - There's no province-wide civic-addresses dataset in Manitoba, so
//     the multi-address xref pattern (Winnipeg's cam2-ii3u) is dropped.

import area from '@turf/area';
import bbox from '@turf/bbox';
import intersect from '@turf/intersect';

const BASE = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services';
const ROLL_URL    = `${BASE}/ROLL_ENTRY/FeatureServer/0`;
const ZONING_URL  = `${BASE}/Manitoba_Zoning_By_Laws/FeatureServer/0`;
const DEVPLAN_URL = `${BASE}/Manitoba_Development_Plan_Designations/FeatureServer/0`;

// ArcGIS Online hosted services cap any single page at 2000 features.
const PAGE_SIZE = 2000;
// Maximum total parcels we'll surface in one search. Beyond this the user
// needs to refine. Roll_Entry has ~437k features province-wide so a
// hard cap is essential for both server etiquette and browser sanity.
const MAX_RESULTS = 1000;
// How many per-feature spatial queries we run in parallel. ArcGIS hosted
// services tolerate this comfortably; staying conservative keeps us off
// any rate-limit radar.
const SPATIAL_CONCURRENCY = 16;

// ---------- Public API ----------

/**
 * Search Roll Entry parcels by attribute. Each provided field becomes a
 * SQL clause ANDed with the others. Returns a GeoJSON FeatureCollection
 * (already paginated to MAX_RESULTS, with `_truncated` set true on the
 * collection if the cap was reached).
 */
export async function searchParcels({ address, municipality, roll, zoneCategory, devPlanCategory, zoningChanged, devPlanChanged, duMode, duMin }) {
  const clauses = [];
  if (address)         clauses.push(`UPPER(Property_Address) LIKE '%${escapeSql(address.toUpperCase())}%'`);
  // Muni dropdown delivers the exact stored form, e.g. "STONEWALL (TOWN)";
  // exact equality is faster than LIKE and avoids surprise partial-matches.
  if (municipality)    clauses.push(`Muni_Name_With_Typ = '${escapeSql(municipality)}'`);
  // Roll # is an exact match. The source data stores rolls with a ".000"
  // decimal suffix (e.g. "3600.000"); accept either form by checking both.
  if (roll) {
    const trimmed = roll.trim();
    const withDecimal = /\./.test(trimmed) ? trimmed : `${trimmed}.000`;
    clauses.push(
      `(Roll_No_Txt = '${escapeSql(trimmed)}' OR Roll_No_Txt = '${escapeSql(withDecimal)}')`
    );
  }

  // Dwelling-units filter. The source field is Dwelling_Units (smallInteger).
  // Most rural / commercial / vacant parcels store 0; the "0 DU only" option
  // is useful for finding vacant land. The "min" option treats null/missing
  // as not-matching, which is correct: a parcel with no DU value isn't
  // confirmed to have ≥N dwellings.
  if (duMode === 'zero') {
    clauses.push(`Dwelling_Units = 0`);
  } else if (duMode === 'min') {
    const n = Math.max(1, Math.floor(Number(duMin) || 1));
    clauses.push(`Dwelling_Units >= ${n}`);
  }

  // Zone / Dev-Plan category aren't fields on Roll_Entry — they live on the
  // overlay layers. We resolve them to a list of parcel OBJECTIDs by spatial
  // query against the matching overlay first, then add an `OBJECTID IN (...)`
  // clause to the parcel query. Done up front so the result row cap respects
  // the category filter.
  let oidFilter = null;
  if (zoneCategory || devPlanCategory || zoningChanged || devPlanChanged) {
    oidFilter = await resolveOverlayFilter({
      zoneCategory, devPlanCategory, zoningChanged, devPlanChanged,
      municipality,
    });
    // Empty result set on the overlay side → empty parcel result.
    if (oidFilter !== null && oidFilter.length === 0) {
      return makeEmptyFc({ truncated: false });
    }
  }

  if (clauses.length === 0 && !oidFilter) {
    return makeEmptyFc({ truncated: false });
  }

  if (oidFilter && oidFilter.length > 0) {
    // Esri SQL `IN (a, b, c)` clause. ArcGIS Online services tolerate
    // very long IN-lists (we cap at MAX_RESULTS so worst-case ~12 KB).
    clauses.push(`OBJECTID IN (${oidFilter.join(',')})`);
  }

  const where = clauses.join(' AND ');
  // Only the fields the table/map/popup actually use. Drops Shape__Area,
  // Shape__Length, FID, and a couple of internal fields that the previous
  // outFields:'*' was pulling in unread — typically ~30% wire-size cut on
  // a full 1000-row response.
  const PARCEL_OUTFIELDS = 'OBJECTID,Roll_No_Txt,Property_Address,Municipality,Muni_Name_With_Typ,Asmt_Roll,Dwelling_Units,Frontage_or_Area,Total_Value,Asmt_Rpt_Url';
  return fetchAllPages(ROLL_URL, {
    where,
    outFields: PARCEL_OUTFIELDS,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, MAX_RESULTS);
}

/**
 * Per-parcel envelope query against the Zoning By-Laws layer. Returns a
 * deduplicated FeatureCollection of zoning polygons covering the parcel
 * set. esriSpatialRelIntersects is a true intersection — no bbox padding
 * needed, no client-side re-check needed for spatial correctness.
 */
const ZONING_OUTFIELDS  = 'OBJECTID,ZONE,ZONE_NAME,ZONE_CATEGORY,ZBL,ZBL_A,AMENDMENT_DESCRIPTION,MUNI_NAME,PLANNINGDISTRICT,PLANNINGREGION';
const DEVPLAN_OUTFIELDS = 'OBJECTID,DES_NAME,DES_CATEGORY,DP_BYLAW,DPA_BYLAW,PLANNINGDISTRICT,PLANNINGREGION,MUNI_NAME,RES_MIN_ACRES_PER_LOT,RES_MAX_ACRES_PER_LOT,AU_LIMIT';

export async function fetchZoningOverlap(parcelFc, { municipality } = {}) {
  if (municipality) return fetchOverlayByMunicipality(ZONING_URL, municipality, ZONING_OUTFIELDS);
  return fetchSpatialOverlap(ZONING_URL, parcelFc, { outFields: ZONING_OUTFIELDS });
}

/**
 * Per-parcel envelope query against the Development Plan Designations layer.
 * Same shape as fetchZoningOverlap. When a municipality is set, takes the
 * fast bulk path (one query for the whole muni) instead.
 */
export async function fetchDevPlanOverlap(parcelFc, { municipality } = {}) {
  if (municipality) return fetchOverlayByMunicipality(DEVPLAN_URL, municipality, DEVPLAN_OUTFIELDS);
  return fetchSpatialOverlap(DEVPLAN_URL, parcelFc, { outFields: DEVPLAN_OUTFIELDS });
}

/**
 * Fast path for muni-scoped searches: pull every overlay polygon in the
 * municipality in a single paginated query, instead of firing N per-parcel
 * envelope queries. Avoids the transient-failure mode where one of the
 * 1000 per-parcel queries silently fails and leaves a parcel with empty
 * zoning or dev-plan in the table. Roll Entry's Muni_Name_With_Typ
 * ("NIVERVILLE (TOWN)") differs from the overlay layers' MUNI_NAME
 * ("Niverville") — strip the suffix and ignore case.
 */
async function fetchOverlayByMunicipality(baseUrl, municipality, outFields) {
  const bare = municipality.replace(/\s*\([^)]*\)\s*$/, '').trim().toUpperCase();
  return fetchAllPages(baseUrl, {
    where: `UPPER(MUNI_NAME) = '${escapeSql(bare)}'`,
    outFields,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, 20000);
}

/**
 * Compute area-weighted top-N overlay matches for each parcel. Returns
 *   Map<parcelOid, Array<{ feature, ratio }>>
 * where `ratio = intersectionArea / parcelArea` (0-1) and the array is
 * sorted descending by ratio, length ≤ n.
 *
 * Mirrors `get_multiple_by_area()` in mao-assembly/scripts/pipeline_utils.R:
 * intersect(parcel, overlay), area(intersection), sort desc, take top N.
 *
 * Failures on individual parcels are logged and skipped — one bad geometry
 * never kills the whole join.
 */
export function joinTopNByArea(parcelFc, overlayFc, n = 2) {
  const result = new Map();
  if (!parcelFc.features.length || !overlayFc.features.length) return result;

  // Pre-compute parcel bboxes for a cheap reject step before turf.intersect
  // (which is comparatively expensive). Same idea as the inner loop of
  // get_multiple_by_area but without an explicit spatial index — at our
  // result-set sizes (≤1000 parcels × ~10-50 overlays each) the O(P×O)
  // bbox check is fast enough.
  const overlayBboxes = overlayFc.features.map((f) => {
    try { return bbox(f); } catch { return null; }
  });

  for (const parcel of parcelFc.features) {
    const oid = parcel.properties?.OBJECTID;
    if (oid == null) continue;
    let parcelBbox;
    let parcelArea;
    try {
      parcelBbox = bbox(parcel);
      parcelArea = area(parcel);
    } catch (err) {
      console.warn('parcel bbox/area failed', oid, err);
      continue;
    }
    if (!Number.isFinite(parcelArea) || parcelArea <= 0) continue;

    const matches = [];
    for (let i = 0; i < overlayFc.features.length; i++) {
      const ob = overlayBboxes[i];
      if (!ob) continue;
      if (!bboxesOverlap(parcelBbox, ob)) continue;
      const overlay = overlayFc.features[i];
      let inter;
      try {
        // turf 7.x takes a FeatureCollection of exactly two polygon Features.
        inter = intersect({ type: 'FeatureCollection', features: [parcel, overlay] });
      } catch (err) {
        // Topology errors are common on real-world data; skip and move on.
        continue;
      }
      if (!inter) continue;
      let interArea;
      try { interArea = area(inter); } catch { continue; }
      if (!Number.isFinite(interArea) || interArea <= 0) continue;
      matches.push({
        feature: overlay,
        ratio: Math.min(1, interArea / parcelArea),
      });
    }

    matches.sort((a, b) => b.ratio - a.ratio);
    if (matches.length > n) matches.length = n;
    result.set(oid, matches);
  }
  return result;
}

/**
 * One-shot fetch of every distinct Muni_Name_With_Typ value in Roll_Entry,
 * sorted alphabetically. Cached in sessionStorage for the life of the tab
 * — the list barely changes year to year and the request is ~50 KB.
 */
export async function fetchMunicipalityList() {
  return fetchDistinctValues(ROLL_URL, 'Muni_Name_With_Typ', 'mb_munis_v1');
}

export async function fetchZoneCategoryList(municipality = null) {
  const where = municipalityToWhere(municipality, 'ZONE_CATEGORY');
  // Cache key is per-muni (or 'all') so switching back to a previously-seen
  // muni is instant. Province-wide list is the default startup case.
  const cacheKey = `mb_zone_categories_v1_${municipality || 'all'}`;
  return fetchDistinctValues(ZONING_URL, 'ZONE_CATEGORY', cacheKey, where);
}

export async function fetchDevPlanCategoryList(municipality = null) {
  const where = municipalityToWhere(municipality, 'DES_CATEGORY');
  const cacheKey = `mb_devplan_categories_v1_${municipality || 'all'}`;
  return fetchDistinctValues(DEVPLAN_URL, 'DES_CATEGORY', cacheKey, where);
}

// ---------- Auxiliary overlays (contaminated sites + traffic stations) ----------

// The upstream CSV at manitoba.ca returns 200 OK but does not send
// Access-Control-Allow-Origin, so a direct browser fetch is silently
// CORS-blocked. Both Vercel (vercel.json rewrites) and the Vite dev
// server (vite.config.js proxy) rewrite this same path to the upstream
// URL — same string here works in both environments.
const CONTAM_CSV_URL = '/proxy/contam-sites.csv';
const TRAFFIC_STATIONS_URL  = 'https://services6.arcgis.com/HQUud09zgy3Asw9X/arcgis/rest/services/All_Stations_C_Only/FeatureServer/0';
const TRAFFIC_FLOW_URL      = 'https://services6.arcgis.com/HQUud09zgy3Asw9X/arcgis/rest/services/MHTIS_Traffic_Flow_2019/FeatureServer/0';

/**
 * Fetch the Manitoba Contaminated Sites Registry. Source is a single CSV
 * maintained by Environment, Climate and Parks staff and read by the
 * official ArcGIS web map. Columns:
 *   ID, OPRID, Link, OPERATION NAME, ADDRESS, MUNICIPALITY,
 *   LATITUDE, LONGITUDE, CSGroup
 * CSGroup ∈ { 'Not Designated', 'Designated Impacted Site',
 *             'Designated Contaminated Site' }
 *
 * Returns a GeoJSON FeatureCollection of Points in WGS84. Cached in
 * sessionStorage so toggling on/off doesn't re-fetch.
 */
export async function fetchContaminatedSites() {
  const cacheKey = 'mb_contam_sites_v1';
  const cached = readCache(cacheKey);
  if (cached) return cached;
  const res = await fetch(CONTAM_CSV_URL);
  if (!res.ok) throw new Error(`Contaminated-sites CSV ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  if (rows.length < 2) return makeEmptyFc();
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const iLat   = idx('LATITUDE');
  const iLon   = idx('LONGITUDE');
  const iName  = idx('OPERATION NAME');
  const iAddr  = idx('ADDRESS');
  const iMuni  = idx('MUNICIPALITY');
  const iGroup = idx('CSGroup');
  const iLink  = idx('Link');
  const iOprId = idx('OPRID');
  const features = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const lat = parseFloat(row[iLat]);
    const lon = parseFloat(row[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        OPRID:    row[iOprId],
        NAME:     (row[iName]  || '').trim(),
        ADDRESS:  (row[iAddr]  || '').trim(),
        MUNI:     (row[iMuni]  || '').trim(),
        CSGROUP:  (row[iGroup] || '').trim(),
        LINK:     (row[iLink]  || '').trim(),
      },
    });
  }
  const fc = { type: 'FeatureCollection', features };
  writeCache(cacheKey, fc);
  return fc;
}

/**
 * Fetch the MHTIS traffic-counting station locations. The published
 * FeatureServer carries point geometry and station metadata only — actual
 * AADT values are not in this layer (they live in private MHTIS map
 * services not published as open data). Each station's popup links out
 * to the MHTIS web app for full count history.
 */
export async function fetchTrafficStations() {
  const cacheKey = 'mb_traffic_stations_v1';
  const cached = readCache(cacheKey);
  if (cached) return cached;
  const fc = await fetchAllPages(TRAFFIC_STATIONS_URL, {
    where: '1=1',
    outFields: 'StationNum,HighwayNum,HighwayAlt,LocationDe,Region,FlowDirect,StationTyp',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, 5000);
  writeCache(cacheKey, fc);
  return fc;
}

/**
 * Fetch the MHTIS Traffic Flow 2019 polylines. Each segment carries an
 * AADT value, the highway / road identifier, and the StationNum it was
 * estimated from. Used both as a toggleable map overlay and as the source
 * for inlining AADT into the station-click popup (joined on StationNum).
 */
export async function fetchTrafficFlow() {
  const cacheKey = 'mb_traffic_flow_v1';
  const cached = readCache(cacheKey);
  if (cached) return cached;
  const fc = await fetchAllPages(TRAFFIC_FLOW_URL, {
    where: '1=1',
    outFields: 'StationNum,ROAD_NO,ROAD_IDENT,FlowDirect,AADT,DateOfEsti,START_KM,END_KM,LENGTH_KM,REGION_NO',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, 20000);
  writeCache(cacheKey, fc);
  return fc;
}

/**
 * Fetch every Roll_Entry parcel in a municipality. Used by the "Show All
 * Parcels in Muni" toggle so the user can see the muni's full parcel
 * fabric in grey behind their search results. No-op without a
 * municipality (would otherwise pull 437k+ province-wide).
 *
 * Returned features carry the same lightweight property set the table
 * uses, so a row-level lookup off this overlay is possible later.
 *
 * Cached per-muni in sessionStorage; the cap (50,000) is a defensive
 * upper bound — the largest single MB muni outside Winnipeg has ~30k
 * parcels.
 */
export async function fetchAllParcelsInMunicipality(municipality) {
  if (!municipality) return makeEmptyFc();
  const cacheKey = `mb_muni_parcels_v1_${municipality}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;
  // Pull the same lightweight property set the table uses minus the
  // overlay-derived columns (zoning/dev-plan come from spatial joins, not
  // Roll_Entry). This keeps hover popups informative without ballooning
  // the wire size: a ~30k-parcel rural muni at this output is ~6-10 MB.
  const fc = await fetchAllPages(ROLL_URL, {
    where: `Muni_Name_With_Typ = '${escapeSql(municipality)}'`,
    outFields: 'OBJECTID,Roll_No_Txt,Property_Address,Muni_Name_With_Typ,Asmt_Roll,Dwelling_Units,Frontage_or_Area,Total_Value,Asmt_Rpt_Url',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, 50000);
  // Stamp computed acreage onto each feature so the hover popup can show
  // Land Size without needing the polygon geometry. Same calc as the
  // table (Roll_Entry's Frontage_or_Area is sometimes acres, sometimes
  // frontage-feet — geometry-derived acres is consistent across munis).
  for (const f of fc.features || []) {
    try {
      const sqm = area(f);
      if (Number.isFinite(sqm) && sqm > 0) {
        f.properties._acres = sqm / 4046.8564224;
      }
    } catch { /* topology errors — skip silently */ }
  }
  // Don't cache the truncated flag; if a giant muni hit the cap, we want
  // the user to know each session.
  writeCache(cacheKey, fc);
  return fc;
}

/**
 * Build a Map<StationNum, AADT> from a Traffic Flow FC. When a station has
 * multiple flow segments (different directions / sections of the same
 * highway), keep the maximum AADT — that's the most useful single number
 * for "how busy is the road this station counts." Used to inline AADT
 * into the station popup without needing a per-station network call.
 */
export function buildAadtIndex(trafficFlowFc) {
  const map = new Map();
  for (const f of trafficFlowFc.features || []) {
    const p = f.properties || {};
    const sn = p.StationNum;
    const aadt = Number(p.AADT);
    if (sn == null || !Number.isFinite(aadt)) continue;
    const prev = map.get(sn);
    if (prev == null || aadt > prev) map.set(sn, aadt);
  }
  return map;
}

/**
 * Minimal RFC-4180 CSV parser. Handles quoted fields with embedded commas,
 * escaped double-quotes ("") inside quoted fields, and CRLF or LF line
 * endings. Sufficient for the cs-data.csv format; we don't need a general
 * dependency for one well-formed file.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else if (c === '\r') {
        // CR alone or CRLF — wait for LF; if next isn't LF, treat as line end.
        if (text[i + 1] !== '\n') {
          row.push(field); field = '';
          rows.push(row); row = [];
        }
      } else {
        field += c;
      }
    }
  }
  // Final field/row if file doesn't end with newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Build a where clause that constrains an overlay-layer distinct-values
 * query to a particular municipality. Roll_Entry stores muni names as
 * "STONEWALL (TOWN)" (Muni_Name_With_Typ) but the overlay layers store
 * the bare name "STONEWALL" in MUNI_NAME — strip the trailing typed
 * suffix so the muni filter works across all three datasets.
 */
function municipalityToWhere(muni, valueField) {
  const baseValue = `${valueField} IS NOT NULL`;
  if (!muni) return baseValue;
  const bare = muni.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return `${baseValue} AND UPPER(MUNI_NAME) = '${escapeSql(bare.toUpperCase())}'`;
}

// ---------- Internals ----------

/**
 * Resolve overlay-side filters (category, "changed") to a list of parcel
 * OBJECTIDs in Roll_Entry. Each matching overlay polygon's geometry is
 * sent back to Roll_Entry as a spatial query envelope — we union the
 * per-overlay parcel hits and dedupe by OBJECTID. Multiple filters AND
 * together: a parcel must intersect at least one polygon from each
 * active overlay query.
 *
 * The "changed" predicates capture amendment history:
 *   zoning-changed   : ZBL_A IS NOT NULL AND ZBL_A <> ZBL  OR
 *                      AMENDMENT_DESCRIPTION IS NOT NULL
 *   dev-plan-changed : DPA_BYLAW IS NOT NULL AND DPA_BYLAW <> DP_BYLAW
 *
 * `municipality`, when present, is also pushed into each overlay query
 * (UPPER(MUNI_NAME) = bare-name) so a province-wide "show changes" sweep
 * doesn't fan out to ~3K polygons across the whole map. Without that
 * bound the filter still works but pagination + spatial join time can
 * stretch to 30+ seconds.
 *
 * Returns null if no overlay filters are set; an array of OBJECTIDs
 * otherwise (which may be empty).
 */
async function resolveOverlayFilter({ zoneCategory, devPlanCategory, zoningChanged, devPlanChanged, municipality }) {
  const overlayQueries = [];

  // Zoning-side queries — category and "changed" can both fire and they
  // narrow the same overlay layer, so they AND together within one query.
  const zoningClauses = [];
  if (zoneCategory)   zoningClauses.push(`ZONE_CATEGORY = '${escapeSql(zoneCategory)}'`);
  // The source rows in this layer have several "this is really null"
  // representations: actual NULL, '' (empty), ' ' (single-space, ~385
  // rows), and the literal string '<Null>' (Esri's stringified-null).
  // ArcGIS Online's SQL92 dialect doesn't expose TRIM(), so we list the
  // known sentinels explicitly. Same exclusion applies to ZBL_A.
  const NOT_REAL_VALUE = (col) =>
    `(${col} IS NOT NULL AND ${col} <> '' AND ${col} <> ' ' AND ${col} <> '<Null>')`;
  if (zoningChanged)  zoningClauses.push(
    `((${NOT_REAL_VALUE('ZBL_A')} AND ZBL_A <> ZBL) OR ${NOT_REAL_VALUE('AMENDMENT_DESCRIPTION')})`
  );
  if (zoningClauses.length > 0) {
    overlayQueries.push({ url: ZONING_URL, clauses: zoningClauses });
  }

  // Dev-plan-side queries — same structure.
  const devClauses = [];
  if (devPlanCategory) devClauses.push(`DES_CATEGORY = '${escapeSql(devPlanCategory)}'`);
  // Same null-sentinel handling as the zoning side: '', ' ', '<Null>'
  // are all "really null" in this dataset.
  if (devPlanChanged)  devClauses.push(
    `(DPA_BYLAW IS NOT NULL AND DPA_BYLAW <> '' AND DPA_BYLAW <> ' ' AND DPA_BYLAW <> '<Null>' AND DPA_BYLAW <> DP_BYLAW)`
  );
  if (devClauses.length > 0) {
    overlayQueries.push({ url: DEVPLAN_URL, clauses: devClauses });
  }

  if (overlayQueries.length === 0) return null;

  // Add the muni narrowing to each overlay query when set. Roll Entry's
  // Muni_Name_With_Typ ("STONEWALL (TOWN)") differs from the overlay
  // layers' MUNI_NAME ("Stonewall") — strip the typed suffix and ignore
  // case to match either form.
  const muniClause = municipality
    ? `UPPER(MUNI_NAME) = '${escapeSql(municipality.replace(/\s*\([^)]*\)\s*$/, '').trim().toUpperCase())}'`
    : null;

  const overlayFcs = await Promise.all(
    overlayQueries.map(async ({ url, clauses }) => {
      const all = [...clauses];
      if (muniClause) all.push(muniClause);
      return fetchAllPages(url, {
        where: all.join(' AND '),
        outFields: 'OBJECTID',
        returnGeometry: 'true',
        outSR: '4326',
        f: 'geojson',
      }, 20000);
    })
  );

  // For each overlay set, find Roll_Entry OBJECTIDs that actually
  // intersect the overlay polygon (not just its envelope), via per-overlay
  // queries. Two important changes vs. the earlier version:
  //   1. We send the overlay polygon geometry itself (not its envelope)
  //      so ArcGIS's spatialRel=esriSpatialRelIntersects gives a true
  //      geometric intersection — no bbox false positives that previously
  //      pulled in parcels outside the polygon.
  //   2. We paginate via fetchAllPages instead of a single fetchPage,
  //      since a large polygon can match well past the 2000-row page cap
  //      and silently drop matches.
  const oidSets = await Promise.all(
    overlayFcs.map(async (fc) => {
      const results = await runParallelBatched(
        fc.features,
        SPATIAL_CONCURRENCY,
        async (overlay) => {
          const esriGeom = polygonToEsriGeometry(overlay);
          if (!esriGeom) return [];
          const oidFc = await fetchAllPages(ROLL_URL, {
            where: '1=1',
            geometry: JSON.stringify(esriGeom),
            geometryType: 'esriGeometryPolygon',
            inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            outFields: 'OBJECTID',
            returnGeometry: 'false',
            f: 'json',
          }, 100000);
          return (oidFc.features || [])
            .map((f) => f.attributes?.OBJECTID ?? f.properties?.OBJECTID)
            .filter((v) => v != null);
        }
      );
      return new Set(results.flat());
    })
  );

  // AND the sets together — a parcel only qualifies if it intersects every
  // category filter the user set.
  let intersectionSet = null;
  for (const set of oidSets) {
    if (intersectionSet === null) {
      intersectionSet = set;
    } else {
      const next = new Set();
      for (const v of intersectionSet) if (set.has(v)) next.add(v);
      intersectionSet = next;
    }
  }
  return [...(intersectionSet ?? new Set())];
}

/**
 * Per-parcel envelope query against `baseUrl`. Concurrency-capped, deduped
 * by OBJECTID. Returns a single GeoJSON FeatureCollection.
 */
async function fetchSpatialOverlap(baseUrl, parcelFc, { outFields }) {
  if (!parcelFc.features.length) return makeEmptyFc({ truncated: false });

  const batches = await runParallelBatched(
    parcelFc.features,
    SPATIAL_CONCURRENCY,
    async (parcel) => {
      const env = featureEnvelope(parcel);
      if (!env) return [];
      const fc = await fetchAllPages(baseUrl, {
        where: '1=1',
        geometry: JSON.stringify(env),
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields,
        returnGeometry: 'true',
        outSR: '4326',
        f: 'geojson',
      }, 5000);
      return fc.features;
    }
  );

  const seen = new Set();
  const features = [];
  for (const f of batches.flat()) {
    const oid = f.properties?.OBJECTID;
    if (oid != null && seen.has(oid)) continue;
    if (oid != null) seen.add(oid);
    features.push(f);
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Drive an async fn across `items` with a concurrency cap. Resolves to an
 * array of results in input order. A single failing item degrades to []
 * for that slot — a bad parcel never aborts the whole batch.
 */
async function runParallelBatched(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        console.warn('batched fn failed at index', i, err);
        results[i] = [];
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Walk through `resultOffset`-paginated query results and concatenate. The
 * service caps each page at 2000 (we ask for the page size verbatim). We
 * stop early when the cumulative count hits `cap` or when a page returns
 * fewer features than requested (i.e. the last page).
 *
 * Sets `_truncated: true` on the returned collection if `cap` was reached
 * before the service ran out of features — UI surfaces this so the user
 * can refine.
 */
async function fetchAllPages(baseUrl, params, cap) {
  const all = [];
  let truncated = false;
  for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
    const remaining = cap - offset;
    const page = Math.min(PAGE_SIZE, remaining);
    const fc = await fetchPage(baseUrl, {
      ...params,
      resultOffset: String(offset),
      resultRecordCount: String(page),
    });
    const feats = fc.features || [];
    all.push(...feats);
    // Two end conditions:
    //   - The service told us this isn't the full set: exceededTransferLimit
    //   - The page returned fewer rows than we asked for: last page
    const hasMore = fc.exceededTransferLimit === true || feats.length === page;
    if (feats.length < page) break;
    if (!hasMore) break;
    if (all.length >= cap) {
      // If the service set exceededTransferLimit, we know there's more
      // data left. But the flag is inconsistent across hosted services —
      // a full page at the app-level cap also implies "probably more,"
      // since the alternative (the dataset ending exactly at the cap)
      // is rare. Treat both as truncated so the UI surfaces it.
      truncated = fc.exceededTransferLimit === true || feats.length === page;
      break;
    }
  }
  return {
    type: 'FeatureCollection',
    features: all,
    _truncated: truncated,
  };
}

async function fetchPage(baseUrl, params) {
  // ArcGIS REST expects POST for long queries (the geometry param can push
  // a URL past common 8 KB length limits). POST works for everything
  // including small queries, so we use it unconditionally.
  const usp = new URLSearchParams(params);
  const res = await fetch(`${baseUrl}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: usp.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ArcGIS ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  // ArcGIS returns 200 OK with an `error` body on invalid queries.
  if (json && json.error) {
    throw new Error(`ArcGIS error ${json.error.code}: ${json.error.message}`);
  }
  return json;
}

/**
 * Fetch every distinct value of a categorical column. Used for the muni
 * and category dropdowns. Results cached per browser tab — the list barely
 * changes between deployments and the request is small.
 */
async function fetchDistinctValues(baseUrl, field, cacheKey, where = null) {
  if (cacheKey) {
    const cached = readCache(cacheKey);
    if (cached) return cached;
  }
  const usp = new URLSearchParams({
    where: where || `${field} IS NOT NULL`,
    returnDistinctValues: 'true',
    outFields: field,
    returnGeometry: 'false',
    orderByFields: field,
    f: 'json',
  });
  const res = await fetch(`${baseUrl}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: usp.toString(),
  });
  if (!res.ok) throw new Error(`ArcGIS ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`ArcGIS error ${json.error.code}: ${json.error.message}`);
  const values = (json.features || [])
    .map((f) => f.attributes?.[field])
    .filter((v) => v != null && String(v).trim() !== '');
  if (cacheKey) writeCache(cacheKey, values);
  return values;
}

// Province-published data (Roll Entry, zoning, dev-plan) doesn't change
// hour-to-hour — overnight at most. Caching for a week keeps the typical
// "what changed in this muni" workflow snappy without ever serving data
// that's meaningfully out of sync. localStorage so the cache survives
// across browser tabs / sessions; sessionStorage was the old choice and
// re-fetched on every tab restart.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_NS_PREFIX = 'mbpsCache.';

function readCache(key) {
  // Accept any of the shapes we cache here:
  //   - Array<string>          — distinct-values dropdowns (munis, categories)
  //   - FeatureCollection      — overlay datasets (contam, traffic, flow, muni parcels)
  //   - { walk, transit, ... } — Walk Score score lookup (legacy; harmless)
  // Wrapped with { v, t } envelope where t is the unix-ms timestamp; if
  // it's older than CACHE_TTL_MS we treat the entry as missing (and the
  // caller refetches and rewrites). Unwrapped legacy entries (from the
  // sessionStorage era) are tolerated for one read then ignored.
  try {
    const namespaced = `${CACHE_NS_PREFIX}${key}`;
    const raw = localStorage.getItem(namespaced) || sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed == null) return null;
    // Envelope: { v: <value>, t: <writtenAtMs> }
    if (typeof parsed === 'object' && !Array.isArray(parsed) && 't' in parsed && 'v' in parsed) {
      if (Date.now() - parsed.t > CACHE_TTL_MS) return null;
      const v = parsed.v;
      if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return v;
      return null;
    }
    // Legacy unwrapped value (older code wrote the value directly).
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'object') return parsed;
    return null;
  } catch { return null; }
}
function writeCache(key, value) {
  const namespaced = `${CACHE_NS_PREFIX}${key}`;
  const envelope = JSON.stringify({ v: value, t: Date.now() });
  try {
    localStorage.setItem(namespaced, envelope);
  } catch (err) {
    // localStorage may be full (browser quota typically 5 MB); evict
    // any of our older namespaced entries first, then retry once.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_NS_PREFIX) && k !== namespaced) localStorage.removeItem(k);
      }
      localStorage.setItem(namespaced, envelope);
    } catch { /* still no room — fall back silently */ }
  }
}

/**
 * Build an Esri envelope object from a GeoJSON feature's bbox in 4326.
 * Returns null on failure. We don't pad — ArcGIS's intersects test is true
 * intersection, not Socrata-style containment, so the exact bbox is fine.
 */
function featureEnvelope(feature) {
  try {
    const [minLon, minLat, maxLon, maxLat] = bbox(feature);
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;
    return {
      xmin: minLon,
      ymin: minLat,
      xmax: maxLon,
      ymax: maxLat,
      spatialReference: { wkid: 4326 },
    };
  } catch {
    return null;
  }
}

function bboxesOverlap(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Convert a GeoJSON Polygon or MultiPolygon Feature to an Esri-shaped
 * polygon for `geometry=...` query params: { rings: [[...]], spatialReference }.
 * ArcGIS Online's intersects test accepts rings in either winding order,
 * so we don't reverse them. Returns null for unsupported geometries.
 */
function polygonToEsriGeometry(feature) {
  const g = feature?.geometry;
  if (!g) return null;
  let rings;
  if (g.type === 'Polygon') {
    rings = g.coordinates;
  } else if (g.type === 'MultiPolygon') {
    // Flatten all polygons' rings into one rings list — Esri's polygon
    // type accepts arbitrary ring counts (interpreted via winding rules).
    rings = [];
    for (const poly of g.coordinates) for (const ring of poly) rings.push(ring);
  } else {
    return null;
  }
  if (!rings || rings.length === 0) return null;
  return { rings, spatialReference: { wkid: 4326 } };
}

function makeEmptyFc({ truncated = false } = {}) {
  return { type: 'FeatureCollection', features: [], _truncated: truncated };
}

// SQL string literal escape: double any single quotes per Esri SQL92 dialect.
function escapeSql(s) {
  return String(s).replace(/'/g, "''");
}
