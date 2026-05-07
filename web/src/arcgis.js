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
//   MASC_Risk_Areas                 risk areas  geometry: polygon
//     Risk_Area
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
const MASC_RISK_AREAS_URL = `${BASE}/MASC_Risk_Areas/FeatureServer/0`;

// ArcGIS Online hosted services cap any single page at 2000 features.
const PAGE_SIZE = 2000;
// Maximum total parcels we'll surface in one search. Beyond this the user
// needs to refine. Roll_Entry has ~437k features province-wide so a
// hard cap is essential for both server etiquette and browser sanity.
const MAX_RESULTS = 1000;
// Keep legal-index lookups as short POST bodies. Each chunk becomes one
// grouped (muni_no + roll IN (...)) clause against Roll_Entry.
const ROLL_KEY_CHUNK_SIZE = 80;
// How many per-feature spatial queries we run in parallel. ArcGIS hosted
// services tolerate this comfortably; staying conservative keeps us off
// any rate-limit radar.
const SPATIAL_CONCURRENCY = 16;
// Only the fields the table/map/popup actually use. Drops Shape__Area,
// Shape__Length, FID, and a couple of internal fields that older
// outFields:'*' requests pulled in unread.
const PARCEL_OUTFIELDS = 'OBJECTID,Roll_No_Txt,Property_Address,Municipality,Muni_Name_With_Typ,Asmt_Roll,Dwelling_Units,Frontage_or_Area,Total_Value,Asmt_Rpt_Url';

// ---------- Public API ----------

/**
 * Search Roll Entry parcels by attribute. Each provided field becomes a
 * SQL clause ANDed with the others. Returns a GeoJSON FeatureCollection
 * (already paginated to MAX_RESULTS, with `_truncated` set true on the
 * collection if the cap was reached).
 */
export async function searchParcels(args) {
  const {
    zoneCategory,
    devPlanCategory,
    zoningChanged,
    devPlanChanged,
    municipality,
    parcelKeys,
  } = args || {};
  const clauses = buildParcelClauses(args || {});

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

  if (clauses.length === 0 && !oidFilter && !hasParcelKeys(parcelKeys)) {
    return makeEmptyFc({ truncated: false });
  }

  if (oidFilter && oidFilter.length > 0) {
    // Esri SQL `IN (a, b, c)` clause. ArcGIS Online services tolerate
    // very long IN-lists (we cap at MAX_RESULTS so worst-case ~12 KB).
    clauses.push(`OBJECTID IN (${oidFilter.join(',')})`);
  }

  if (hasParcelKeys(parcelKeys)) {
    return fetchRollEntryByKeyChunks(parcelKeys, clauses);
  }

  const where = clauses.join(' AND ');
  return fetchRollEntryWhere(where, MAX_RESULTS);
}

function buildParcelClauses({ address, municipality, roll, duMode, duMin }) {
  const clauses = [];
  if (address)         clauses.push(`UPPER(Property_Address) LIKE '%${escapeSql(address.toUpperCase())}%'`);
  // Muni dropdown delivers the exact stored form, e.g. "STONEWALL (TOWN)";
  // exact equality is faster than LIKE and avoids surprise partial-matches.
  if (municipality)    clauses.push(`Muni_Name_With_Typ = '${escapeSql(municipality)}'`);
  // Roll # accepts either a single value or a comma- / whitespace- /
  // newline-separated list (paste from a spreadsheet). Source data
  // always stores Roll_No_Txt as <digits>.<3 digits> — e.g. "3600.000",
  // "3600.001", "3600.500". canonicalRoll() turns whatever shorthand
  // the user typed into that canonical form so the IN-list matches:
  //   "3600"      → "3600.000"
  //   "3600.0"    → "3600.000"
  //   "3600.01"   → "3600.010"
  //   "3600.1"    → "3600.100"
  //   "3600.500"  → "3600.500"
  // Inputs that don't shape into a roll (pure junk) are left as-is so
  // the missing-rolls diagnostic in main.js can still flag them by
  // input form, rather than silently dropping bogus entries.
  const rollList = parseRollList(roll);
  if (rollList.length > 0) {
    const expanded = new Set();
    for (const r of rollList) expanded.add(canonicalRoll(r));
    const inList = [...expanded].map((v) => `'${escapeSql(v)}'`).join(',');
    clauses.push(`Roll_No_Txt IN (${inList})`);
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
  return clauses;
}

function fetchRollEntryWhere(where, cap) {
  return fetchAllPages(ROLL_URL, {
    where,
    outFields: PARCEL_OUTFIELDS,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, cap);
}

async function fetchRollEntryByKeyChunks(parcelKeys, clauses) {
  const chunks = chunkRollKeys(parcelKeys, ROLL_KEY_CHUNK_SIZE);
  if (chunks.length === 0) return makeEmptyFc({ truncated: false });

  const features = [];
  const seenOids = new Set();
  let truncated = parcelKeys.length > MAX_RESULTS;

  for (const chunk of chunks) {
    const keyClause = rollKeyWhereClause(chunk);
    if (!keyClause) continue;
    const where = [...clauses, keyClause].join(' AND ');
    const remaining = MAX_RESULTS - features.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const fc = await fetchRollEntryWhere(where, remaining);
    truncated = truncated || fc._truncated === true;
    for (const f of fc.features || []) {
      const oid = f.properties?.OBJECTID;
      const dedupeKey = oid == null
        ? `${f.properties?.Municipality || ''}|${f.properties?.Roll_No_Txt || ''}`
        : `oid:${oid}`;
      if (seenOids.has(dedupeKey)) continue;
      seenOids.add(dedupeKey);
      features.push(f);
      if (features.length >= MAX_RESULTS) {
        truncated = true;
        break;
      }
    }
    if (features.length >= MAX_RESULTS) break;
  }

  return {
    type: 'FeatureCollection',
    features,
    _truncated: truncated,
  };
}

function hasParcelKeys(parcelKeys) {
  return Array.isArray(parcelKeys) && parcelKeys.length > 0;
}

function chunkRollKeys(parcelKeys, chunkSize) {
  const normalized = [];
  const seen = new Set();
  for (const key of parcelKeys || []) {
    const muniNo = Number(key.muni_no ?? key.muniNo);
    const roll = String(key.roll_no_txt ?? key.rollNoTxt ?? '').trim();
    if (!Number.isFinite(muniNo) || !roll) continue;
    const dedupe = `${muniNo}|${roll}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    normalized.push({ muniNo: Math.trunc(muniNo), roll });
  }

  const chunks = [];
  for (let i = 0; i < normalized.length; i += chunkSize) {
    chunks.push(normalized.slice(i, i + chunkSize));
  }
  return chunks;
}

function rollKeyWhereClause(keys) {
  const byMuni = new Map();
  for (const { muniNo, roll } of keys) {
    if (!byMuni.has(muniNo)) byMuni.set(muniNo, []);
    byMuni.get(muniNo).push(roll);
  }
  const parts = [];
  for (const [muniNo, rolls] of byMuni) {
    const rollList = [...new Set(rolls)]
      .map((r) => `'${escapeSql(r)}'`)
      .join(',');
    if (!rollList) continue;
    parts.push(`(Municipality LIKE '${escapeSql(String(muniNo))} - %' AND Roll_No_Txt IN (${rollList}))`);
  }
  return parts.length ? `(${parts.join(' OR ')})` : null;
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
const MUNICIPALITY_URL      = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/MUNICIPALITY/FeatureServer/0';

/**
 * Province-wide municipal boundaries — a stable reference layer that's
 * shown by default. Pulled at simplified resolution to keep the payload
 * small without sacrificing visible accuracy:
 *
 *   - maxAllowableOffset=0.0005 — units match outSR (degrees here), so
 *     0.0005° ≈ 50 m at Manitoba latitude. Faithful to the boundary at
 *     every zoom where this layer is meant to be useful (province-wide
 *     to muni-overview); imperceptible drift only kicks in past zoom 16
 *     where the parcel-detail layers take over anyway.
 *
 *   - geometryPrecision=4 — 4 decimal places (~11 m) of coordinate
 *     precision per vertex, smaller wire payload without changing
 *     vertex count.
 *
 * Combined payload: ~298 KB vs ~7.1 MB at full resolution. (An earlier
 * attempt with maxAllowableOffset=100 returned a 58 KB payload but
 * collapsed polygons to absurd minimum shapes — the unit is degrees
 * with outSR=4326, not metres. Don't repeat that mistake.)
 *
 * Cached for 30 days — boundaries change on a multi-year cadence
 * (amalgamations) so a month is comfortable. Loaded async on page open
 * so it never blocks the first paint of the search controls or map.
 */
/**
 * MASC soil-rating shards. Built by r/build_masc_shards.R from the
 * province's masc_soil_ratings_with_latlon.csv into per-muni JSON
 * files at web/public/data/masc/<MUNI>.json plus an _index.json
 * manifest mapping normalized muni keys → { file, count }.
 *
 * The frontend fetches the manifest once (cached 30 days), then
 * fetches each muni's shard on demand when the MASC overlay is
 * toggled on. Each shard caches per-muni in localStorage with the
 * same 30-day TTL — they're build-time artifacts that only change
 * when MASC publishes new ratings.
 *
 * Returns null when no shard exists for the requested muni (the
 * registered manifest doesn't include it). Caller should treat that
 * as "no MASC data for this area" rather than an error.
 */
const MASC_INDEX_URL = `${import.meta.env?.BASE_URL || '/'}data/masc/_index.json`;

export async function fetchMascIndex() {
  const cacheKey = 'mb_masc_index_v3';
  const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  try {
    const res = await fetch(MASC_INDEX_URL);
    if (!res.ok) return null;
    const idx = await res.json();
    writeCache(cacheKey, idx);
    return idx;
  } catch {
    return null;
  }
}

export async function fetchMascRatingsForMuni(muniNameWithTyp) {
  if (!muniNameWithTyp) return null;
  const idx = await fetchMascIndex();
  const entry = lookupMuniManifestEntry(idx, muniNameWithTyp, { stripType: true });
  if (!entry) return null;
  const file = entry.file;
  const cacheKey = `mb_masc_${file}_v3`;
  const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (Array.isArray(cached) && cached.length > 0) return cached;
  try {
    const res = await fetch(`${import.meta.env?.BASE_URL || '/'}data/masc/${file}`);
    if (!res.ok) return null;
    const rows = await res.json();
    writeCache(cacheKey, rows);
    return rows;
  } catch {
    return null;
  }
}

/**
 * Official MASC Risk Areas polygon layer. This is the authoritative
 * source for risk-area numbers; do not use the MASC soil-rating CSV's
 * compact `ra` field for map labels or parcel table risk areas.
 *
 * Source: Open Canada package 739cb8ed-b661-5a60-7a26-eb60cd06541f,
 * exposed by Manitoba Maps as MASC_Risk_Areas/FeatureServer/0.
 */
export async function fetchMascRiskAreas() {
  const cacheKey = 'mb_masc_risk_areas_v1';
  const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  const fc = await fetchAllPages(MASC_RISK_AREAS_URL, {
    where: "Risk_Area IS NOT NULL AND Risk_Area <> '' AND Risk_Area <> ' '",
    outFields: 'OBJECTID,Risk_Area',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, PAGE_SIZE);
  writeCache(cacheKey, fc);
  return fc;
}

/**
 * Canada Land Inventory — Soil Capability for Agriculture, 1:250,000
 * scale. Federal AAFC dataset hosted on Esri's hosted feature service
 * (NOT the Manitoba Open Data host; lives at services.arcgis.com/
 * lGOekm0RsNxYnT3j). Polygons carry up to six classes (CLASS_A through
 * CLASS_F) with their percentages and subclass codes — most polygons
 * have a single dominant class, but mixed-rating polygons happen near
 * transition zones.
 *
 * Class scale (1 = best, 7 = worst):
 *   1 — no significant limitations
 *   2 — minor limitations
 *   3 — moderate limitations
 *   4 — severe limitations, marginal for sustained cultivation
 *   5 — only suitable for hay/perennial crops
 *   6 — only suitable for native pasture
 *   7 — no agricultural capability
 *
 * Subclass letters (one per class slot, e.g. SUBCLAS_A1):
 *   C climate, T topography, W excess water, M moisture deficiency,
 *   F low fertility, N salinity, I inundation, E erosion, P stoniness,
 *   R shallowness over rock, D dense soil
 *
 * Source: open.canada.ca/data/en/dataset/0c113e2c-e20e-4b64-be6f-496b1be834ee
 *
 * Live-fetched per-muni with the muni boundary polygon as the spatial
 * filter (same pattern as the Sec-Twp Grid). Cached 30 days because
 * the underlying dataset is essentially static. Returns a
 * FeatureCollection of polygons each carrying CLASS_A as a stable
 * dominant-class field for map paint.
 */
const CLI_AGR_CAP_URL =
  'https://services.arcgis.com/lGOekm0RsNxYnT3j/arcgis/rest/services/cli_agr_cap_250k/FeatureServer/0';

export async function fetchCliAgrForMuni(muniNameWithTyp, muniBoundaryFeature) {
  if (!muniNameWithTyp || !muniBoundaryFeature?.geometry) return null;
  const cacheKey = `mb_cli_agr_${muniNameWithTyp}_v1`;
  const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;

  const esriGeom = polygonToEsriGeometry(muniBoundaryFeature);
  if (!esriGeom) return null;

  const fc = await fetchAllPages(CLI_AGR_CAP_URL, {
    where: '1=1',
    geometry: JSON.stringify(esriGeom),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: [
      'OBJECTID',
      'CLASS_A','CLASS_B','CLASS_C','CLASS_D','CLASS_E','CLASS_F',
      'PERCENT_A','PERCENT_B','PERCENT_C','PERCENT_D','PERCENT_E','PERCENT_F',
      'SUBCLAS_A1','SUBCLAS_A2','SUBCLAS_B1','SUBCLAS_B2',
      'SUBCLAS_C1','SUBCLAS_C2','SUBCLAS_D1','SUBCLAS_D2',
    ].join(','),
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, 20000);
  writeCache(cacheKey, fc);
  return fc;
}

/**
 * Manitoba Original Survey Legal Descriptions — point layer with
 * QUARTER, SECTION, TOWNSHIP, RANGE, MERIDIAN attributes at each
 * quarter-section centroid (and parish lots, river lots, etc; we
 * filter to D.L.S. quarter sections only). Used to render the
 * section-township grid as derived line/polygon features in
 * map.js.
 *
 * No muni name on this layer, so we scope spatially using the
 * municipal-boundary polygon as the geometry filter. Cached 30
 * days (the survey grid is stable).
 */
const SURVEY_GRID_URL = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/MB_LegalDesc/FeatureServer/0';

/**
 * Fetch the pre-baked province-wide Sec-Twp grid as a single static
 * GeoJSON file. Built by r/build_section_grid.R — section geometry
 * doesn't change, so the file is committed to source control and
 * served from web/public/data/section-grid.json.
 *
 * Cached in localStorage with the same 30-day TTL as muni boundaries
 * (ample, since the grid never actually changes — TTL just prevents
 * unbounded staleness if the file is ever rebuilt). First load is
 * a single ~2 MB gzipped fetch; subsequent loads come from the cache.
 *
 * Returns a FeatureCollection of polygon features, the same shape
 * sectionLinesFromRows() produces. main.js can drop it straight onto
 * the survey-grid map source.
 */
export async function fetchProvinceSectionGrid() {
  const cacheKey = 'mb_section_grid_province_v1';
  const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  const url = `${import.meta.env?.BASE_URL || '/'}data/section-grid.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Province-wide section grid not found at ${url} (status ${res.status}). ` +
      `Run \`Rscript r/build_section_grid.R\` to generate it.`
    );
  }
  const fc = await res.json();
  writeCache(cacheKey, fc);
  return fc;
}

/**
 * Fetch the pre-baked dominant MASC soil rating for every parcel in a
 * single municipality. Built by r/build_parcel_masc.R from a spatial
 * intersection of ROLL_ENTRY parcels × MASC quarter-section polygons.
 *
 * Per-muni shards live at web/public/data/parcel-masc/<MUNI_KEY>.json.
 * Shape: a flat dictionary keyed by Roll_No_Txt:
 *   { "3600.000": { rating: "C", ra: 32, q: "NE", s: 1, t: 12, r: 5, d: "E" }, ... }
 * Manifest at web/public/data/parcel-masc/_index.json maps the original
 * Muni_Name_With_Typ values to shard filenames + counts.
 *
 * Returns a {rollNoTxt → ratingObj} map, or null when the muni isn't
 * in the index (urban munis with no farmland — Winnipeg, Brandon centre,
 * etc. — typically drop out of the build).
 *
 * Cached in localStorage with the same 30-day TTL as MASC overlay shards.
 */
const PARCEL_MASC_INDEX_URL = `${import.meta.env?.BASE_URL || '/'}data/parcel-masc/_index.json`;

let parcelMascIndexPromise = null;

async function fetchParcelMascIndex() {
  if (parcelMascIndexPromise) return parcelMascIndexPromise;
  parcelMascIndexPromise = (async () => {
    const cacheKey = 'mb_parcel_masc_index_v2';
    const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
    if (cached) return cached;
    try {
      const res = await fetch(PARCEL_MASC_INDEX_URL);
      if (!res.ok) return null;
      const idx = await res.json();
      writeCache(cacheKey, idx);
      return idx;
    } catch {
      return null;
    }
  })();
  return parcelMascIndexPromise;
}

export async function fetchParcelMascForMuni(muniNameWithTyp) {
  if (!muniNameWithTyp) return null;
  const idx = await fetchParcelMascIndex();
  const entry = lookupMuniManifestEntry(idx, muniNameWithTyp, { stripType: false });
  if (!entry) return null;
  const file = entry.file;
  const cacheKey = `mb_parcel_masc_${file}_v2`;
  const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  try {
    const res = await fetch(`${import.meta.env?.BASE_URL || '/'}data/parcel-masc/${file}`);
    if (!res.ok) return null;
    const dict = await res.json();
    writeCache(cacheKey, dict);
    return dict;
  } catch {
    return null;
  }
}

function lookupMuniManifestEntry(index, muniName, { stripType }) {
  if (!index || !muniName) return null;

  const direct = String(muniName).trim();
  if (index[direct]) return index[direct];

  const normalized = normalizeMuniLookupKey(muniName, { stripType });
  if (index[normalized]) return index[normalized];

  const requestedCompact = compactMuniLookupKey(muniName, { stripType });
  for (const [key, entry] of Object.entries(index)) {
    if (compactMuniLookupKey(key, { stripType: false }) === requestedCompact) {
      return entry;
    }
  }
  return null;
}

function normalizeMuniLookupKey(name, { stripType = false } = {}) {
  let s = String(name || '');
  if (stripType) s = s.replace(/\s*\([^)]*\)\s*$/, '');
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactMuniLookupKey(name, { stripType = false } = {}) {
  return normalizeMuniLookupKey(name, { stripType })
    .replace(/&/g, ' AND ')
    .replace(/\bMTN\b/g, 'MOUNTAIN')
    .replace(/\bFRANCOIS\b/g, 'FRANCIS')
    .replace(/\bSAINTE\b/g, 'STE')
    .replace(/[^A-Z0-9]+/g, '');
}

/**
 * Fetch the pre-baked Manitoba river-lots polygon overlay. Built by
 * r/build_river_lots.R from MB-RIVER-LOTS.kmz. Same load pattern as
 * fetchProvinceSectionGrid — committed to source control, cached
 * 30 days. Returns a FeatureCollection of polygons each with
 * properties.kind = 'riverlot' and properties.label = lot identifier.
 *
 * Returns null (not an error) if the static file is missing — river
 * lots are an optional reference layer; the section grid still works
 * without them.
 */
/**
 * Fetch the pre-baked rated MASC river-lot polygons. Built by
 * r/build_parcel_masc.R from the join of MB-RIVER-LOTS.kmz and
 * masc_soil_ratings_riverlots.csv. Single static file (~3-4 MB);
 * frontend filters to the active muni at render time.
 *
 * Each feature carries:
 *   geometry: Polygon (the actual river-lot shape, not a centroid square)
 *   properties.rating, properties.ra (risk_area), properties.label
 *     (e.g. "NO-RL-241"), properties.muni (Muni_Name_With_Typ).
 *
 * Returns null on missing file (returned by older builds) — caller
 * just renders the quarter-section overlay alone.
 */
export async function fetchMascRiverlots() {
  const cacheKey = 'mb_masc_riverlots_v1';
  const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  const url = `${import.meta.env?.BASE_URL || '/'}data/masc-riverlots.json`;
  let res;
  try { res = await fetch(url); } catch { return null; }
  if (!res.ok) return null;
  const fc = await res.json();
  writeCache(cacheKey, fc);
  return fc;
}

export async function fetchRiverLots() {
  // v3: labels now pretty-printed at build time by r/build_river_lots.R
  // (no JS-side transform needed). Bump invalidates v2 cache entries
  // that still carry the JS-prettified or raw-concatenated form.
  const cacheKey = 'mb_river_lots_v3';
  const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  const url = `${import.meta.env?.BASE_URL || '/'}data/river-lots.json`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const fc = await res.json();
  writeCache(cacheKey, fc);
  return fc;
}

export async function fetchSurveyGridForMuni(muniNameWithTyp, muniBoundaryFeature) {
  if (!muniNameWithTyp || !muniBoundaryFeature?.geometry) return null;
  const cacheKey = `mb_survey_grid_${muniNameWithTyp}_v2`;
  const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;

  const esriGeom = polygonToEsriGeometry(muniBoundaryFeature);
  if (!esriGeom) return null;

  const fc = await fetchAllPages(SURVEY_GRID_URL, {
    // MB_LegalDesc TYPE vocabulary: Lot, OT, PL, Quarter, RL, SL, WL.
    // Quarter rows (~970k province-wide) are the only ones that carry
    // SECTION+TOWNSHIP+RANGE values useful for the township grid;
    // everything else drops out. Match the exact literal — hosted
    // ArcGIS LIKE is case-sensitive, so '%QUARTER%' missed every row.
    where: "TYPE = 'Quarter'",
    geometry: JSON.stringify(esriGeom),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID_1,QUARTER,SECTION,TOWNSHIP,RANGE,MERIDIAN,TYPE',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, 50000);
  writeCache(cacheKey, fc);
  return fc;
}

export async function fetchMunicipalBoundaries() {
  const cacheKey = 'mb_muni_boundaries_v2';
  const cached = readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  const fc = await fetchAllPages(MUNICIPALITY_URL, {
    where: '1=1',
    outFields: 'OBJECTID,MUNI_NAME,MUNI_TYPE,MUNI_LIST_NAME_WITH_TYPE',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '4',
    maxAllowableOffset: '0.0005',
    f: 'geojson',
  }, 1000);
  writeCache(cacheKey, fc);
  return fc;
}

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
// Municipal boundaries are a stable reference layer — amalgamations
// happen on a multi-year cadence — so they get a longer 30-day TTL.
const MUNI_BOUNDARIES_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_NS_PREFIX = 'mbpsCache.';

function readCache(key, ttlMs = CACHE_TTL_MS) {
  // Accept any of the shapes we cache here:
  //   - Array<string>          — distinct-values dropdowns (munis, categories)
  //   - FeatureCollection      — overlay datasets (contam, traffic, flow, muni parcels)
  //   - { walk, transit, ... } — Walk Score score lookup (legacy; harmless)
  // Wrapped with { v, t } envelope where t is the unix-ms timestamp; if
  // it's older than the caller-provided ttlMs (defaults to CACHE_TTL_MS)
  // we treat the entry as missing. Unwrapped legacy entries (from the
  // sessionStorage era) are tolerated for one read then ignored.
  try {
    const namespaced = `${CACHE_NS_PREFIX}${key}`;
    const raw = localStorage.getItem(namespaced) || sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed == null) return null;
    // Envelope: { v: <value>, t: <writtenAtMs> }
    if (typeof parsed === 'object' && !Array.isArray(parsed) && 't' in parsed && 'v' in parsed) {
      if (Date.now() - parsed.t > ttlMs) return null;
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

/**
 * Parse a Roll # input that may be a single value or a list (commas,
 * whitespace, newlines, semicolons all work as separators). Trims
 * each entry, drops empties and pure-junk values, dedupes, returns an
 * array preserving first-seen order. Empty array for empty input.
 *
 * Exported so the bulk-search "missing rolls" diagnostic in main.js
 * can reuse the same parser the SQL clause builds against — keeps
 * the user-facing list of "not found" rolls aligned with what
 * actually got queried.
 */
export function parseRollList(input) {
  if (!input) return [];
  const seen = new Set();
  const out = [];
  for (const raw of String(input).split(/[\s,;]+/)) {
    const v = raw.trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Canonicalize a single roll-number input to the source's stored form
 * — `<digits>.<3 digits>`. Any dot-suffix the user types is padded
 * (or truncated, defensively) to exactly three digits; an input
 * without a dot gets `.000` appended. Pure-junk inputs that don't
 * match the digits[.digits] shape are returned unchanged, so the
 * missing-rolls diagnostic can flag them with the same text the user
 * typed.
 *
 * Examples:
 *   "3600"      → "3600.000"
 *   "3600.0"    → "3600.000"
 *   "3600.01"   → "3600.010"
 *   "3600.1"    → "3600.100"
 *   "3600.500"  → "3600.500"
 *   "3600.5000" → "3600.500"   (defensive truncation; won't normally fire)
 *   "abc"       → "abc"        (passthrough so it surfaces as missing)
 */
export function canonicalRoll(input) {
  if (input == null) return '';
  const s = String(input).trim();
  if (s === '') return '';
  const m = s.match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return s;
  const whole = m[1];
  const frac  = (m[2] || '').padEnd(3, '0').slice(0, 3);
  return `${whole}.${frac}`;
}

/**
 * Given the Roll # input the user typed and the FeatureCollection of
 * matching parcels, return the list of input rolls that didn't match
 * any returned parcel. Both sides are normalized through canonicalRoll
 * so a user typing `3600.01` correctly matches a stored `3600.010`,
 * and any junk input that doesn't shape into a roll is reported back
 * exactly as the user typed it. Order preserves the user's input
 * order so the UI lists them in the same sequence they pasted.
 */
export function missingRollsFromResults(input, parcelFc) {
  const wanted = parseRollList(input);
  if (wanted.length === 0) return [];
  const have = new Set();
  for (const f of parcelFc?.features || []) {
    const r = f.properties?.Roll_No_Txt;
    if (r != null) have.add(canonicalRoll(r));
  }
  const missing = [];
  for (const r of wanted) {
    if (!have.has(canonicalRoll(r))) missing.push(r);
  }
  return missing;
}

// SQL string literal escape: double any single quotes per Esri SQL92 dialect.
function escapeSql(s) {
  return String(s).replace(/'/g, "''");
}
