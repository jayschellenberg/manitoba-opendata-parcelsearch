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
// @turf/intersect moved to lib/overlayJoinCore.js with the area join.
// Persistent cache lives in its own module so the storage backend
// (IndexedDB primary, localStorage fallback) can evolve without
// touching every call site. readCache + writeCache are async — every
// caller in this file already runs inside an async function.
import { readCache, writeCache } from './cache.js';
// Owns the "MAO splits the rural grid number at the thousands mark"
// convention — see lib/civicRange.js. The street clause below and the
// snapshot filter both expand the search term through it so they agree.
import {
  addressSearchVariants,
  addressMatchesVariants,
  civicSearchMode,
} from './lib/civicRange.js';
// The area join's compute lives in its own module so this file and the
// Web Worker in overlayJoin.worker.js share one implementation.
import { computeTopNMatches } from './lib/overlayJoinCore.js';
// One acreage rule for the whole app: the Roll-Layer hover below and the
// results grid (main.js parcelAcres) both resolve through this, so the same
// parcel can't read differently depending on where you look at it.
import { resolveParcelAcres } from './lib/acres.js';
import { reconcileMuniSpelling } from './lib/muniIdentity.js';
// Manitoba Water Rights Licensing (WALLAS) lives on a different host and
// a different ArcGIS flavour (a 10.51 MapServer, not an AGOL hosted
// FeatureServer), so its client is its own module. What this file needs
// from it is the licensed tile-drainage and irrigation footprints, which
// back the two water-rights search filters below.
import { fetchTileDrainageAreas, fetchIrrigationLicences } from './wallas.js';

const BASE = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services';
const ROLL_URL    = `${BASE}/ROLL_ENTRY/FeatureServer/0`;
const ZONING_URL  = `${BASE}/Manitoba_Zoning_By_Laws/FeatureServer/0`;
const DEVPLAN_URL = `${BASE}/Manitoba_Development_Plan_Designations/FeatureServer/0`;
// Exported for the Data Status tab's live-service list.
export const MASC_RISK_AREAS_URL = `${BASE}/MASC_Risk_Areas/FeatureServer/0`;

// Live provincial FeatureServers the results grid is sourced from, as a
// citable list for evidence-export provenance (lib/provenance.js). These are
// the authoritative live endpoints queried at search time — keep in lock-step
// with the consts above. `label` is the column family it feeds in the grid.
export const SERVICE_SOURCES = [
  { label: 'Parcels (Roll Entry)',          url: ROLL_URL },
  { label: 'Zoning By-Laws',                url: ZONING_URL },
  { label: 'Development Plan Designations', url: DEVPLAN_URL },
];

// How long to sit on the provincial roll layer's publish date. It moves a
// couple of times a month at most, and a stale reading here is harmless (it
// only ever understates freshness), so a day is plenty.
const ROLL_PUBLISHED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * When the province last re-published the ROLL_ENTRY layer.
 *
 * This is NOT the same thing as "how current the roll data is", and the
 * difference is the whole reason this exists. The layer's editingInfo moves
 * whenever the province pushes a new extract, but the extract itself trails
 * Manitoba Assessment Online by an unknown margin: on 2026-08-05 the layer
 * reported an edit date of the previous day while still serving RM of Ste
 * Anne roll 126910 at its pre-subdivision 17.22 ac, against a matching
 * pre-subdivision polygon, when MAO's map already showed the ±2.3 ac child
 * parcel. Quoting this date alone would therefore raise confidence exactly
 * where it should fall — callers must pair it with the standing caveat that
 * an individual roll can be older than the publish date implies.
 *
 * @returns {string|null} ISO date (YYYY-MM-DD), or null if unavailable.
 */
export async function fetchRollLayerPublishedDate() {
  const cacheKey = 'mb_roll_layer_published_v1';
  const cached = await readCache(cacheKey, ROLL_PUBLISHED_TTL_MS);
  if (cached?.date) return cached.date;
  try {
    const res = await fetch(`${ROLL_URL}?f=json`);
    if (!res.ok) return null;
    const meta = await res.json();
    const ms = meta?.editingInfo?.dataLastEditDate;
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    if (!Number.isFinite(d.valueOf())) return null;
    const date = d.toISOString().slice(0, 10);
    await writeCache(cacheKey, { date });
    return date;
  } catch {
    return null;
  }
}

// ArcGIS Online hosted services cap any single page at 2000 features.
const PAGE_SIZE = 2000;
// Maximum total parcels we'll surface in one search. Beyond this the user
// needs to refine. Roll_Entry has ~437k features province-wide so a
// hard cap is essential for both server etiquette and browser sanity.
const MAX_RESULTS = 1000;
// Keep legal-index lookups as short POST bodies. Each chunk becomes one
// grouped (muni_no + roll IN (...)) clause against Roll_Entry.
const ROLL_KEY_CHUNK_SIZE = 80;
// Bulk roll-number searches (sales-CSV upload, paste-list) split the
// Roll_No_Txt IN-list into chunks before querying Roll_Entry. ArcGIS
// hosted services silently return incomplete results for large IN-lists
// without setting exceededTransferLimit — observed empirically: a single
// 192-roll IN-list returned 62 features instead of the expected ~149.
// Chunking sidesteps that, and the per-chunk queries run concurrently
// so total latency is roughly unchanged.
const ROLL_LIST_CHUNK_SIZE = 50;
// How many roll-list chunks we fire in parallel. ArcGIS hosted services
// rate-limit at 6000 request-units / minute; keep concurrency modest so
// a multi-muni upload doesn't trip the cap.
const ROLL_LIST_CONCURRENCY = 4;
// How many per-feature spatial queries we run in parallel. ArcGIS hosted
// services tolerate this comfortably; staying conservative keeps us off
// any rate-limit radar.
const SPATIAL_CONCURRENCY = 16;
// Licensed WALLAS footprints per spatial query in the water-rights search
// filters. Each batch becomes one multi-ring polygon, so this is the
// divisor on request count: RM of Portage la Prairie's several hundred
// irrigation footprints drop from hundreds of requests to a handful.
// Kept at 25 so the POST body stays small (~15 KB worst case) and one
// slow batch can't stall the whole filter.
const WALLAS_FILTER_BATCH_SIZE = 25;
// Only the fields the table/map/popup actually use. Drops Shape__Area,
// Shape__Length, FID, and a couple of internal fields that older
// outFields:'*' requests pulled in unread.
const PARCEL_OUTFIELDS = 'OBJECTID,Roll_No_Txt,Property_Address,Municipality,Muni_Name_With_Typ,Asmt_Roll,Dwelling_Units,Frontage_or_Area,Total_Value,Asmt_Rpt_Url';

// ---------- Roll Entry snapshot fallback ----------
// When the upstream provincial ROLL_ENTRY FeatureServer is in a partial
// state (observed 2026-06-03 with only 18 of ~180 munis published mid-
// rebuild), main.js flips the webapp into snapshot mode via
// setRollEntrySnapshot(manifest). While that's set, parcel queries route
// to per-muni GeoJSON shards from the mb-parcel-data CDN repo
// produced by r/build_rollentry_snapshot.R. The shards mirror the live
// FeatureCollection shape (same 10 fields, EPSG:4326), so the rest of
// the app is none the wiser.
//
// Shard cache is in-memory only (per session) — each muni's shard is
// ~1-10 MB and gzipped on the wire; a quick reload to pick up live data
// after the upstream rebuild is the supported recovery path.
//
// Per-muni shards (rollentry-snapshot, parcel-masc, assessment, masc,
// landcover), the small standalone files (river-lots, masc-riverlots),
// and the landcover-tiles raster pyramid all live in the mb-parcel-data
// repo on jsDelivr, pinned to an IMMUTABLE commit (same rationale as
// HISTORICAL_CDN below: jsDelivr's view of @main lags and is
// inconsistent per-file). Pulling these out of web/public/data/ trimmed
// ~430 MB of generated assets from this repo/deploy. MAINTENANCE: after
// rebuilding any of these datasets (the r/build_*.R scripts write into
// the local mb-parcel-data clone), commit + push that repo and update
// this SHA — see MAINTENANCE.md. section-grid.json is NOT one of them: at
// 40 MB it is over jsDelivr's per-file cap, so it ships from a GitHub
// Release through the /api/section-grid edge function (see
// fetchProvinceSectionGrid below). Corrected 2026-08-12 — this used to say
// it "stays local", which stopped being true when that fetch moved off
// web/public/data/ (the local path is gitignored now). A stale, unread
// 40 MB copy is still git-tracked in mb-parcel-data; nothing here points
// at it.
export const MB_PARCEL_DATA_REVISION =
  '85d0203094aad5ecc61ae4e86b7b69a84371788e';
export const MB_PARCEL_DATA_CDN =
  `https://cdn.jsdelivr.net/gh/jayschellenberg/mb-parcel-data@${MB_PARCEL_DATA_REVISION}`;
const SNAPSHOT_BASE_URL = `${MB_PARCEL_DATA_CDN}/rollentry-snapshot/`;
let rollEntrySnapshot = null;
const snapshotShardCache = new Map();

/** Set (or clear, with null) the active Roll Entry snapshot manifest.
 *  Once set, searchParcels and fetchAllParcelsInMunicipality route to
 *  the per-muni shards instead of hitting the live FeatureServer. */
export function setRollEntrySnapshot(manifest) {
  rollEntrySnapshot = manifest || null;
  // Drop the per-muni cache when toggling modes — otherwise switching
  // back to live mid-session would still serve stale snapshot data
  // until the cache evicted naturally.
  snapshotShardCache.clear();
}

/** Read the active snapshot manifest (or null). main.js reads this for
 *  the muni dropdown source and the banner's snapshot_date. */
export function getRollEntrySnapshot() {
  return rollEntrySnapshot;
}

async function fetchSnapshotShard(muniName) {
  if (!muniName) return makeEmptyFc({ truncated: false });
  if (snapshotShardCache.has(muniName)) return snapshotShardCache.get(muniName);
  const entry = rollEntrySnapshot?.munis?.[muniName];
  if (!entry?.file) return makeEmptyFc({ truncated: false });
  try {
    const res = await fetch(`${SNAPSHOT_BASE_URL}${entry.file}`);
    if (!res.ok) {
      console.warn(`Snapshot shard ${entry.file} returned ${res.status}`);
      return makeEmptyFc({ truncated: false });
    }
    const fc = await res.json();
    // Ensure the FC has the shape downstream code expects (defensive —
    // a malformed shard shouldn't break the whole search path).
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
      return makeEmptyFc({ truncated: false });
    }
    snapshotShardCache.set(muniName, fc);
    return fc;
  } catch (err) {
    console.warn(`Snapshot shard ${entry.file} fetch failed`, err);
    return makeEmptyFc({ truncated: false });
  }
}

/** Apply the same attribute filters searchParcels applies SQL-side,
 *  but to an in-memory FC. Skips zoning/dev-plan category filters
 *  (those depend on OBJECTID lists from the overlay services, and
 *  OBJECTIDs don't survive a server republish — so cross-mode
 *  filtering is unsafe). Also skips buildParcelClauses' civic-number
 *  clause: that one only exists to beat the live query's row cap, and a
 *  snapshot shard is already the whole muni — main.js's
 *  applyCivicNumberFilter decides the number either way.
 *  The remaining filters mirror buildParcelClauses. */
function filterSnapshotFeatures(features, args) {
  const { roll, addressStreet, duMode, duMin } = args || {};
  let out = features;
  const rollList = canonicalRollList(roll);
  if (rollList.length > 0) {
    const rollSet = new Set(rollList);
    out = out.filter((f) => rollSet.has(f.properties?.Roll_No_Txt));
  }
  if (addressStreet) {
    const variants = addressSearchVariants(addressStreet);
    out = out.filter((f) => addressMatchesVariants(f.properties?.Property_Address, variants));
  }
  if (duMode === 'zero') {
    out = out.filter((f) => Number(f.properties?.Dwelling_Units) === 0);
  } else if (duMode === 'min') {
    const n = Math.max(1, Math.floor(Number(duMin) || 1));
    out = out.filter((f) => Number(f.properties?.Dwelling_Units) >= n);
  }
  return out;
}

async function searchParcelsFromSnapshot(args) {
  const { municipality, parcelKeys } = args || {};
  // List-import path: parcelKeys is [{muni_no, roll_no_txt}, ...].
  // Group by muni_no, resolve each muni_no to its shard via the manifest's
  // muni_no field, then filter each shard for the requested rolls.
  if (hasParcelKeys(parcelKeys)) {
    const byMuni = new Map();
    for (const k of parcelKeys) {
      const code = Number(k.muni_no);
      if (!Number.isFinite(code)) continue;
      const roll = canonicalRoll(k.roll_no_txt);
      if (!roll) continue;
      if (!byMuni.has(code)) byMuni.set(code, new Set());
      byMuni.get(code).add(roll);
    }
    const codeToName = new Map();
    for (const [name, entry] of Object.entries(rollEntrySnapshot?.munis || {})) {
      if (entry?.muni_no != null) codeToName.set(Number(entry.muni_no), name);
    }
    const all = [];
    for (const [code, rolls] of byMuni) {
      const muniName = codeToName.get(code);
      if (!muniName) continue;
      const shard = await fetchSnapshotShard(muniName);
      for (const f of shard.features) {
        if (rolls.has(f.properties?.Roll_No_Txt)) all.push(f);
      }
    }
    // Apply the same attribute filters the live path ANDs onto a
    // parcelKeys query. searchParcels hands fetchRollEntryByKeyChunks the
    // buildParcelClauses output alongside the key clause, so address and
    // dwelling-units narrow an imported list in live mode; skipping them
    // here quietly broke that promise in snapshot mode. `roll` is left
    // out on purpose — buildParcelClauses excludes it too (the key match
    // above already identifies each row).
    const filtered = filterSnapshotFeatures(all, { ...args, roll: null });
    return { type: 'FeatureCollection', features: filtered, _truncated: false };
  }
  // Muni-scoped path: load that muni's shard, apply other filters.
  if (municipality) {
    const shard = await fetchSnapshotShard(municipality);
    const features = filterSnapshotFeatures(shard.features, args);
    return { type: 'FeatureCollection', features, _truncated: false };
  }
  // Without a muni (or parcelKeys) the snapshot can't usefully search —
  // we'd have to load all 186 shards. Return empty rather than burn
  // hundreds of MB on what's almost certainly an unintended path.
  return makeEmptyFc({ truncated: false });
}

async function fetchAllParcelsInMunicipalityFromSnapshot(municipality) {
  if (!municipality) return makeEmptyFc();
  const shard = await fetchSnapshotShard(municipality);
  return { type: 'FeatureCollection', features: shard.features.slice() };
}

// ---------- Public API ----------

/**
 * Search Roll Entry parcels by attribute. Each provided field becomes a
 * SQL clause ANDed with the others. Returns a GeoJSON FeatureCollection
 * (already paginated to MAX_RESULTS, with `_truncated` set true on the
 * collection if the cap was reached).
 */
export async function searchParcels(args) {
  // Snapshot fallback — see SNAPSHOT_BASE_URL section above. While the
  // snapshot manifest is set we route to the per-muni shards instead of
  // hitting the live FeatureServer; the returned FC has the same shape
  // so the rest of the search pipeline is unchanged. Zone/dev-plan
  // category filters are skipped in snapshot mode (the OBJECTID lists
  // those filters produce don't survive a server republish).
  if (rollEntrySnapshot) return searchParcelsFromSnapshot(args);

  const {
    zoneCategory,
    devPlanCategory,
    zoningChanged,
    devPlanChanged,
    tileDrainageOnly,
    irrigationOnly,
    municipality,
    parcelKeys,
  } = args || {};
  const clauses = buildParcelClauses(args || {});
  const rollList = canonicalRollList(args?.roll);

  // Zone / Dev-Plan category aren't fields on Roll_Entry — they live on the
  // overlay layers. We resolve them to a list of parcel OBJECTIDs by spatial
  // query against the matching overlay first, then add an `OBJECTID IN (...)`
  // clause to the parcel query. Done up front so the result row cap respects
  // the category filter.
  let oidFilter = null;
  if (zoneCategory || devPlanCategory || zoningChanged || devPlanChanged
      || tileDrainageOnly || irrigationOnly) {
    oidFilter = await resolveOverlayFilter({
      zoneCategory, devPlanCategory, zoningChanged, devPlanChanged,
      tileDrainageOnly, irrigationOnly, municipality,
    });
    // Empty result set on the overlay side → empty parcel result.
    if (oidFilter !== null && oidFilter.length === 0) {
      return makeEmptyFc({ truncated: false });
    }
  }

  if (
    clauses.length === 0 &&
    !oidFilter &&
    !hasParcelKeys(parcelKeys) &&
    rollList.length === 0
  ) {
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

  // Roll-list path: when the user supplied a roll list (single value, comma
  // paste, or bulk sales-CSV upload), split into chunks before joining the
  // IN-list into the WHERE clause. Large IN-lists silently truncate at the
  // service side — see ROLL_LIST_CHUNK_SIZE comment for the empirical case.
  if (rollList.length > 0) {
    if (rollList.length <= ROLL_LIST_CHUNK_SIZE) {
      const inList = rollList.map((v) => `'${escapeSql(v)}'`).join(',');
      const where = [...clauses, `Roll_No_Txt IN (${inList})`].join(' AND ');
      return fetchRollEntryWhere(where, MAX_RESULTS);
    }
    return fetchRollListChunked(clauses, rollList);
  }

  const where = clauses.join(' AND ');
  return fetchRollEntryWhere(where, MAX_RESULTS);
}

/**
 * OR a term's civic-number spacing variants into one LIKE clause, so
 * "1106" still reaches Rosser's "1 106 E ROAD 71 N" (and "1 106" reaches
 * a muni that writes it closed up). `anchored` drops the leading % for a
 * civic number, which an address always starts with.
 *
 * Single-variant terms — anything without a 4-digit run or an internal
 * digit space, i.e. nearly every street name — emit exactly the one
 * clause they always have. Multiple variants are parenthesized so the OR
 * can't leak past the AND joining it to the muni / DU clauses.
 */
function addressLikeClause(term, { anchored = false } = {}) {
  const lead = anchored ? '' : '%';
  const likes = addressSearchVariants(term)
    .map((v) => `UPPER(Property_Address) LIKE '${lead}${escapeSql(v)}%'`);
  if (likes.length === 0) return null;
  return likes.length === 1 ? likes[0] : `(${likes.join(' OR ')})`;
}

/**
 * Server-side narrowing for the From/To civic-number boxes. Mirrors
 * civicSearchMode: a lone box is a contains, From == To is an anchored
 * prefix, and a true range returns null — a prefix LIKE can't express
 * one, so ranges still lean on applyCivicNumberFilter's post-filter.
 *
 * Why it exists: From/To were otherwise pure post-filters, so the number
 * only ever saw the first MAX_RESULTS rows the muni query returned. 122
 * of Manitoba's 186 munis hold more parcels than that cap (Macdonald has
 * ~6200), which silently put most of a muni out of reach of a number
 * search.
 *
 * The exact form is deliberately a SUPERSET of the real predicate:
 * '100%' also drags in "1000 MAIN", and a prefix can't express the
 * letter-suffix span. That is fine — applyCivicNumberFilter still runs
 * client-side and makes the exact call. This clause exists to beat the
 * row cap, not to decide.
 */
function civicNumberClause(addressFrom, addressTo) {
  const { mode, term } = civicSearchMode(addressFrom, addressTo);
  if (mode === 'exact')    return addressLikeClause(term, { anchored: true });
  if (mode === 'contains') return addressLikeClause(term);
  return null;  // 'range' | 'none'
}

function buildParcelClauses({ addressStreet, addressFrom, addressTo, municipality, duMode, duMin }) {
  const clauses = [];
  // Street-name substring match against Property_Address.
  if (addressStreet) {
    const streetClause = addressLikeClause(addressStreet);
    if (streetClause) clauses.push(streetClause);
  }
  // From/To narrow server-side where they can, so the row cap can't hide
  // the match — see civicNumberClause. Deciding the number still happens
  // client-side in main.js's applyCivicNumberFilter (ArcGIS SQL can't
  // cleanly cast the leading digits), and a true range narrows there
  // alone.
  const civicClause = civicNumberClause(addressFrom, addressTo);
  if (civicClause) clauses.push(civicClause);
  // Muni dropdown delivers the exact stored form, e.g. "STONEWALL (TOWN)";
  // exact equality is faster than LIKE and avoids surprise partial-matches.
  if (municipality)    clauses.push(`Muni_Name_With_Typ = '${escapeSql(municipality)}'`);
  // Roll # handling moved into searchParcels() — large IN-lists need to
  // be chunked across multiple queries (see ROLL_LIST_CHUNK_SIZE).
  // canonicalRollList() builds the deduped, normalized list searchParcels
  // then splits.

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

/**
 * Run a chunked Roll_No_Txt IN-list search. The user-supplied roll list
 * (parseRollList + canonicalRoll'd) is split into ROLL_LIST_CHUNK_SIZE
 * chunks; each chunk fires as an independent fetchRollEntryWhere with
 * the rest of the WHERE intact. Up to ROLL_LIST_CONCURRENCY chunks run
 * concurrently. Results merge into a single FeatureCollection with
 * OBJECTID-keyed dedupe (defensive — chunks don't overlap).
 *
 * Worker-pool concurrency rather than a fire-all Promise.all keeps the
 * rate-limit footprint bounded even for large lists (an 800-roll upload
 * is 16 chunks; we keep at most 4 in flight).
 */
async function fetchRollListChunked(baseClauses, canonicalRolls) {
  const chunks = [];
  for (let i = 0; i < canonicalRolls.length; i += ROLL_LIST_CHUNK_SIZE) {
    chunks.push(canonicalRolls.slice(i, i + ROLL_LIST_CHUNK_SIZE));
  }
  if (chunks.length === 0) return makeEmptyFc({ truncated: false });

  const features = [];
  const seen = new Set();
  let truncated = false;
  let firstErr = null;

  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= chunks.length) return;
      if (firstErr) return;
      const chunk = chunks[idx];
      const inList = chunk.map((v) => `'${escapeSql(v)}'`).join(',');
      const where = [...baseClauses, `Roll_No_Txt IN (${inList})`].join(' AND ');
      const remaining = MAX_RESULTS - features.length;
      if (remaining <= 0) { truncated = true; return; }
      let fc;
      try {
        fc = await fetchRollEntryWhere(where, remaining);
      } catch (e) {
        firstErr = e;
        return;
      }
      truncated = truncated || fc._truncated === true;
      for (const f of fc.features || []) {
        const oid = f.properties?.OBJECTID;
        const key = oid == null
          ? `${f.properties?.Municipality || ''}|${f.properties?.Roll_No_Txt || ''}`
          : `oid:${oid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        features.push(f);
        if (features.length >= MAX_RESULTS) { truncated = true; return; }
      }
    }
  }

  const workerCount = Math.min(ROLL_LIST_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstErr) throw firstErr;

  return {
    type: 'FeatureCollection',
    features,
    _truncated: truncated,
  };
}

/**
 * Parse a free-form roll-list input (single value, comma/whitespace/newline
 * separated, paste from a spreadsheet) into the canonical, deduplicated
 * form Roll_Entry stores: <digits>.<3 digits>. Inputs that don't shape
 * into a roll are passed through unchanged so the missing-rolls
 * diagnostic in main.js can still surface them by input form.
 */
function canonicalRollList(roll) {
  const parsed = parseRollList(roll);
  if (parsed.length === 0) return [];
  const expanded = new Set();
  for (const r of parsed) expanded.add(canonicalRoll(r));
  return [...expanded];
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

export async function fetchZoningOverlap(parcelFc, { municipality, municipalities } = {}) {
  if (municipality) return fetchOverlayByMunicipality(ZONING_URL, municipality, ZONING_OUTFIELDS);
  if (Array.isArray(municipalities) && municipalities.length > 0) {
    return fetchOverlayByMunicipalities(ZONING_URL, municipalities, ZONING_OUTFIELDS);
  }
  return fetchSpatialOverlap(ZONING_URL, parcelFc, { outFields: ZONING_OUTFIELDS });
}

/**
 * Per-parcel envelope query against the Development Plan Designations layer.
 * Same shape as fetchZoningOverlap. When a municipality (or array of
 * municipalities) is set, takes the fast bulk path — one query for the
 * whole muni — instead of fanning out one envelope query per parcel.
 */
export async function fetchDevPlanOverlap(parcelFc, { municipality, municipalities } = {}) {
  if (municipality) return fetchOverlayByMunicipality(DEVPLAN_URL, municipality, DEVPLAN_OUTFIELDS);
  if (Array.isArray(municipalities) && municipalities.length > 0) {
    return fetchOverlayByMunicipalities(DEVPLAN_URL, municipalities, DEVPLAN_OUTFIELDS);
  }
  return fetchSpatialOverlap(DEVPLAN_URL, parcelFc, { outFields: DEVPLAN_OUTFIELDS });
}

/**
 * Multi-muni bulk fetch: fire one fetchOverlayByMunicipality per
 * muni in parallel, then merge the results into a single FC,
 * deduping by OBJECTID. Sales-CSV uploads matched against 10-30
 * munis used to fall into the per-parcel envelope path (1 fetch
 * per parcel × 2000+ parcels = 30+ seconds with concurrency cap);
 * this path collapses to one fetch per muni (~20 fetches
 * total) — generally under 5 seconds.
 */
async function fetchOverlayByMunicipalities(baseUrl, municipalities, outFields) {
  const unique = [...new Set(municipalities.filter(Boolean))];
  if (unique.length === 0) return { type: 'FeatureCollection', features: [] };
  const fcs = await Promise.all(
    unique.map((m) => fetchOverlayByMunicipality(baseUrl, m, outFields))
  );
  const seen = new Set();
  const merged = [];
  for (const fc of fcs) {
    for (const f of fc?.features || []) {
      const oid = f.properties?.OBJECTID;
      const key = oid != null ? `oid:${oid}` : `m:${f.properties?.MUNI_NAME || ''}|${merged.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(f);
    }
  }
  return { type: 'FeatureCollection', features: merged };
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
  const cacheKey = overlayCacheKey(baseUrl, municipality);
  if (cacheKey) {
    const cached = await readCache(cacheKey, CACHE_TTL_MS);
    if (cached?.features?.length) return cached;
  }
  const fc = await fetchAllPages(baseUrl, {
    where: muniNameMatchClause(municipality),
    outFields,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, 20000);
  // Only a non-empty result is worth remembering. An empty one is
  // ambiguous — a municipality with genuinely no coverage looks exactly
  // like a name that failed to match or a request that came back short —
  // and caching that for a week would pin a parcel set to blank zoning
  // with no obvious way for the user to tell why. Re-fetching the
  // genuinely-empty munis costs one request each.
  if (cacheKey && fc?.features?.length) {
    await writeCache(cacheKey, fc);
  }
  return fc;
}

/**
 * Cache key for one municipality's overlay polygons.
 *
 * Municipal zoning and development-plan layers change on a by-law
 * cadence — months to years — while a multi-municipality sales import
 * re-fetches all of them every single time. On a 15-muni upload that
 * was 46 paged requests before a single polygon could be clipped, and
 * it dominated the wall-clock the user actually waits through.
 *
 * Keyed by layer AND municipality so the two overlays never collide.
 * The `v1` suffix is tied to the outFields lists: widening those means
 * bumping it, or a cached entry would be silently missing a column.
 */
function overlayCacheKey(baseUrl, municipality) {
  const layer = baseUrl === ZONING_URL ? 'zoning'
    : baseUrl === DEVPLAN_URL ? 'devplan'
      : null;
  if (!layer) return null;
  const muni = String(municipality || '').trim().toUpperCase();
  if (!muni) return null;
  // Non-alphanumerics collapsed so "STE. ANNE (TOWN)" can't produce a
  // key that collides with a differently-punctuated spelling of itself.
  return `mb_overlay_${layer}_${muni.replace(/[^A-Z0-9]+/g, '_')}_v1`;
}

/**
 * Build a `MUNI_NAME` WHERE clause that copes with the Zoning +
 * Dev-Plan layers' wildly inconsistent muni naming. Roll_Entry stores
 * "WEST ST PAUL (RM)" / "STONEWALL (TOWN)" — but the overlay layers
 * use a half-dozen different conventions for the same muni:
 *
 *   "Stonewall"               (bare)
 *   "Town of Stonewall"       (type-prefixed)
 *   "City of Selkirk"         (type-prefixed)
 *   "West St. Paul"           (bare with St. dot)
 *   "Ste. Anne (Town)"        (dotted + parens-typed)
 *   "Portage la Prairie (RM)" (parens-typed)
 *
 * The previous single-equals comparison ("UPPER(MUNI_NAME) = bare")
 * only matched the bare form — so Stonewall, Selkirk, West St Paul,
 * Ste. Anne, Portage la Prairie, and any other muni whose overlay-
 * side spelling included a type prefix, parens-suffix, OR a period
 * on St/Ste all silently returned zero features. This builds the
 * full cross-product of (bare ± type-prefix ± parens-suffix) × (with
 * dot ± without dot), wraps it in a UPPER(MUNI_NAME) IN-list, and
 * lets the source pick whichever form it happens to use.
 */
function muniNameMatchClause(municipality) {
  const upper = municipality.trim().toUpperCase();
  const bareMatch = upper.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const bare = (bareMatch ? bareMatch[1] : upper).trim();
  const type = (bareMatch ? bareMatch[2] : '').trim();

  // Type → list of prefix candidates (e.g. "TOWN" → "TOWN OF").
  // Multi-expansion for types that have both short + long forms in
  // open-data layers ("RM" appears as both "RM OF" and "RURAL
  // MUNICIPALITY OF" across different layers).
  const PREFIX_MAP = {
    'TOWN':               ['TOWN OF'],
    'CITY':               ['CITY OF'],
    'VILLAGE':            ['VILLAGE OF'],
    'RM':                 ['RM OF', 'RURAL MUNICIPALITY OF'],
    'MUNICIPALITY':       ['MUNICIPALITY OF'],
    'LGD':                ['LGD OF', 'LOCAL GOVERNMENT DISTRICT OF'],
    'NORTHERN COMMUNITY': ['NORTHERN COMMUNITY OF'],
  };
  const prefixes = PREFIX_MAP[type] || [];

  // Type → list of parens-suffix candidates (matches the Manitoba
  // Zoning layer's "Portage la Prairie (RM)" convention). Some munis
  // shorten the type (e.g. "Souris-Glenwood (M)" for Municipality).
  const SUFFIX_MAP = {
    'TOWN':               ['Town', 'TOWN'],
    'CITY':               ['City', 'CITY'],
    'VILLAGE':            ['Village', 'VILLAGE'],
    'RM':                 ['RM'],
    'MUNICIPALITY':       ['Municipality', 'M'],
    'LGD':                ['LGD'],
    'NORTHERN COMMUNITY': ['NC', 'Northern Community'],
  };
  const suffixes = SUFFIX_MAP[type] || [];

  // Build the bare/prefix/suffix cross-product first, then expand
  // each into its with-dot and without-dot variants. Set de-dupes
  // any overlaps (bare names without "St" produce identical dot
  // variants).
  // Per-muni accent + hyphenation overrides. The Manitoba Zoning and
  // Dev-Plan layers store a handful of names with diacritics that
  // Roll_Entry doesn't carry (its Muni_Name_With_Typ is uppercase + no
  // accents), or with hyphens between words that Roll_Entry separates
  // by space. Found via the audit-muni-names.js cross-reference: any
  // bare name in this map is replaced with (or augmented by) the
  // canonical layer-side spellings when building the variant set.
  // Add a new entry whenever the audit surfaces another mismatch.
  const ACCENT_HYPHEN_ALIASES = {
    'TACHE':                      ['TACHÉ'],
    'ST FRANCOIS XAVIER':         ['ST FRANÇOIS XAVIER'],
    'KILLARNEY TURTLE MOUNTAIN':  ['KILLARNEY-TURTLE MOUNTAIN'],
  };
  // Start with the bare name and any layer-side aliases for it. The
  // alias loop walks every stem we'd otherwise generate so the
  // accent/hyphen variant goes through the same prefix/suffix/dot
  // expansion as the canonical form.
  const baseForms = new Set([bare]);
  for (const alias of ACCENT_HYPHEN_ALIASES[bare] || []) baseForms.add(alias);

  const stems = new Set();
  for (const baseForm of baseForms) {
    stems.add(baseForm);
    for (const p of prefixes) stems.add(`${p} ${baseForm}`);
    for (const s of suffixes) stems.add(`${baseForm} (${s.toUpperCase()})`);
  }

  const variants = new Set();
  for (const stem of stems) {
    variants.add(stem);
    variants.add(stem.replace(/\bST\b/g, 'ST.'));
    variants.add(stem.replace(/\bSTE\b/g, 'STE.'));
    variants.add(stem.replace(/\bST\./g, 'ST'));
    variants.add(stem.replace(/\bSTE\./g, 'STE'));
  }
  const list = [...variants].map((v) => `'${escapeSql(v)}'`).join(',');
  return `UPPER(MUNI_NAME) IN (${list})`;
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
/**
 * Overlay bboxes + grid, memoised per FeatureCollection object.
 *
 * enrichOverlays calls joinTopNByArea four times per search, and the
 * zoning FC it passes twice (full, then again inside the changed-polygon
 * pass when nothing was filtered out) is the same object. Computing
 * turf.bbox over tens of thousands of overlay polygons more than once
 * for the same collection is pure waste.
 *
 * Keyed weakly on the FC, so the entry disappears when the collection
 * does — no cache invalidation to get wrong, and no retention of a
 * province-worth of geometry after a new search replaces it. Mutating
 * an FC's features in place after a join would serve a stale index, but
 * nothing in this codebase does that: overlay FCs are built by a fetch
 * and then only read.
 */
const overlayIndexCache = new WeakMap();

/**
 * Turn the core's index-based result into the {feature, ratio} shape
 * every caller expects. The core deals in indices so its output can
 * cross a worker boundary cheaply; the features are re-attached here,
 * on whichever side holds the real objects.
 */
function attachOverlayFeatures(pairs, overlayFeatures) {
  const result = new Map();
  for (const [oid, matches] of pairs) {
    result.set(oid, matches.map((m) => ({
      feature: overlayFeatures[m.i],
      ratio: m.ratio,
    })));
  }
  return result;
}

/**
 * For each parcel, clip every candidate overlay polygon to it and keep
 * the top `n` by share of parcel area. Synchronous — blocks until done.
 *
 * The compute lives in lib/overlayJoinCore.js so this and the worker
 * path below run the exact same code. Prefer joinTopNByAreaAsync for
 * anything large enough to be felt; this remains for small joins and as
 * the fallback when a worker isn't available.
 */
export function joinTopNByArea(parcelFc, overlayFc, n = 2) {
  if (!parcelFc.features.length || !overlayFc.features.length) return new Map();
  const pairs = computeTopNMatches(parcelFc.features, overlayFc.features, n);
  return attachOverlayFeatures(pairs, overlayFc.features);
}

// ---- Worker-backed join -------------------------------------------
//
// The join is the app's heaviest synchronous block; on a multi-muni
// sales import it froze the tab for tens of seconds. Running it in a
// worker doesn't reduce total CPU — tiling did that — it just stops the
// UI from locking up while the work happens.

let joinWorker = null;
let joinWorkerBroken = false;
let joinSeq = 0;
const joinPending = new Map();

/** Lazily start the worker. Returns null when workers aren't usable, so
 *  every caller degrades to the synchronous path rather than failing. */
function getJoinWorker() {
  if (joinWorkerBroken) return null;
  if (joinWorker) return joinWorker;
  try {
    joinWorker = new Worker(
      new URL('./overlayJoin.worker.js', import.meta.url),
      { type: 'module' },
    );
    joinWorker.onmessage = (event) => {
      const { id, ok, result, error } = event.data || {};
      const entry = joinPending.get(id);
      if (!entry) return;
      joinPending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error || 'overlay join failed in worker'));
    };
    joinWorker.onerror = (err) => {
      // A worker-level failure (module load, out of memory) can't be
      // attributed to one request, so fail them all and stop using it.
      console.warn('overlay join worker failed; falling back to main thread', err);
      joinWorkerBroken = true;
      for (const [, entry] of joinPending) entry.reject(new Error('worker error'));
      joinPending.clear();
      try { joinWorker.terminate(); } catch { /* already gone */ }
      joinWorker = null;
    };
  } catch (err) {
    console.warn('overlay join worker unavailable; using main thread', err);
    joinWorkerBroken = true;
    joinWorker = null;
  }
  return joinWorker;
}

/**
 * Same contract as joinTopNByArea, computed off the main thread when a
 * worker is available. Falls back to the synchronous path — same code,
 * same results — if the worker can't start, errors, or the payload
 * can't be cloned.
 *
 * Only geometry is sent, and only indices come back, so the transfer
 * stays small relative to the work it displaces.
 */
export async function joinTopNByAreaAsync(parcelFc, overlayFc, n = 2) {
  if (!parcelFc.features.length || !overlayFc.features.length) return new Map();
  const worker = getJoinWorker();
  if (!worker) return joinTopNByArea(parcelFc, overlayFc, n);

  const id = ++joinSeq;
  try {
    const pairs = await new Promise((resolve, reject) => {
      joinPending.set(id, { resolve, reject });
      worker.postMessage({
        id,
        n,
        // Strip properties: the core only reads OBJECTID, and parcel
        // property bags carry the full enrichment payload by this point.
        parcels: parcelFc.features.map((f) => ({
          oid: f.properties?.OBJECTID,
          geometry: f.geometry,
        })),
        overlays: overlayFc.features.map((f) => f.geometry),
      });
    });
    return attachOverlayFeatures(pairs, overlayFc.features);
  } catch (err) {
    joinPending.delete(id);
    console.warn('overlay join worker failed; recomputing on main thread', err);
    return joinTopNByArea(parcelFc, overlayFc, n);
  }
}

/**
 * Bbox-only fallback to joinTopNByArea. For each parcel, return overlay
 * features whose bbox overlaps the parcel's bbox — no @turf/intersect,
 * no area computation. Used by the "Changes" column when the
 * area-weighted join returned empty: ArcGIS server-side spatial
 * intersect counts edge-touching polygons as a match (so the parcel
 * lands in the Zoning-Changed result set), but @turf/intersect requires
 * actual area overlap and silently returns null. Bbox overlap mirrors
 * the server's looser semantics so the Changes cell shows the candidate
 * amendment that triggered the filter match.
 *
 * Less accurate than joinTopNByArea — a parcel's bbox can overlap an
 * overlay's bbox without actual geometric intersection. Caller should
 * prefer joinTopNByArea results and only fall back here when those are
 * empty.
 */
export function bboxOverlapJoin(parcelFc, overlayFc, n = 3) {
  const result = new Map();
  if (!parcelFc.features.length || !overlayFc.features.length) return result;

  const overlayBboxes = overlayFc.features.map((f) => {
    try { return bbox(f); } catch { return null; }
  });

  for (const parcel of parcelFc.features) {
    const oid = parcel.properties?.OBJECTID;
    if (oid == null) continue;
    let pBbox;
    try { pBbox = bbox(parcel); } catch { continue; }

    const matches = [];
    for (let i = 0; i < overlayFc.features.length; i++) {
      const ob = overlayBboxes[i];
      if (!ob) continue;
      if (!bboxesOverlap(pBbox, ob)) continue;
      matches.push({ feature: overlayFc.features[i], ratio: null });
      if (matches.length >= n) break;
    }
    if (matches.length) result.set(oid, matches);
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

/**
 * Total live Roll_Entry record count via returnCountOnly — one cheap
 * request. Used by the boot health check to detect a partial upstream
 * state (record count far below the snapshot's total) even when the muni
 * list looks complete. ALWAYS hits the live FeatureServer (never the
 * snapshot route) since its whole purpose is judging live health.
 * Returns null on failure so the caller can fall back to the muni-count
 * signal alone. Not cached — it's a freshness probe.
 */
export async function fetchRollEntryCount() {
  try {
    const usp = new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' });
    const res = await fetch(`${ROLL_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: usp.toString(),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error) return null;
    return Number.isFinite(json.count) ? json.count : null;
  } catch {
    return null;
  }
}

// ---------- Auxiliary overlays (contaminated sites + traffic stations) ----------

// The upstream CSV at manitoba.ca returns 200 OK but does not send
// Access-Control-Allow-Origin, so a direct browser fetch is silently
// CORS-blocked. Both Vercel (vercel.json rewrites) and the Vite dev
// server (vite.config.js proxy) rewrite this same path to the upstream
// URL — same string here works in both environments.
const CONTAM_CSV_URL = '/proxy/contam-sites.csv';
const TRAFFIC_STATIONS_URL  = 'https://services6.arcgis.com/HQUud09zgy3Asw9X/arcgis/rest/services/All_Stations_C_Only/FeatureServer/0';
// MHTIS Traffic Flow. The service name is year-stamped, so it does NOT roll
// forward on its own — the app sat on the 2019 layer until 2026-08-05 while
// a 2023 one had been published and was 15 months fresher (last edited
// 2026-02-10 vs 2024-11-21). Same 2,067 segments, so it is a drop-in.
//
// READ AADT_2023, NOT AADT. The new service keeps `AADT` as the carried-forward
// PRIOR estimate — byte-identical to what the 2019 layer served — and puts the
// current count in `AADT_2023`. Station 73 reads AADT 1040 / AADT_2023 1020;
// station 533 reads 540 / 400. Swapping the URL alone would therefore have
// changed nothing at all, which is the kind of "upgrade" that looks done and
// isn't. `DateOfEsti` is the year of the NEW estimate (2023/2024); `EYear` is
// the year of the old one.
//
// When a 2027-ish layer lands, expect the same shape: a new AADT_<year> column
// beside a stale `AADT`. Check the field list before assuming a URL bump is enough.
const TRAFFIC_FLOW_URL      = 'https://services6.arcgis.com/HQUud09zgy3Asw9X/arcgis/rest/services/MHTIS_Traffic_Flow_2023_(new)/FeatureServer/0';
// Current-count field on the layer above, in preference order: the first one
// present on a feature wins, so an older cached FC (or a future republish that
// renames the column) still resolves to something sane.
const AADT_FIELDS = ['AADT_2023', 'AADT'];

/**
 * The current AADT for a traffic-flow feature's attributes.
 *
 * Exported so the overlay, the popup and the station join all agree on which
 * column is authoritative — picking the wrong one silently reports counts that
 * are several years out of date but perfectly plausible.
 */
export function currentAadt(props) {
  for (const f of AADT_FIELDS) {
    const v = Number(props?.[f]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}
const MB_ROAD_NETWORK_URL   = 'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Manitoba_Road_Network_2023/FeatureServer/0';
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
const MASC_INDEX_URL = `${MB_PARCEL_DATA_CDN}/masc/_index.json`;

export async function fetchMascIndex() {
  const cacheKey = `mb_masc_index_v4_${MB_PARCEL_DATA_REVISION}`;
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  try {
    const res = await fetch(MASC_INDEX_URL);
    if (!res.ok) return null;
    const idx = await res.json();
    await writeCache(cacheKey, idx);
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
  const cacheKey = `mb_masc_${file}_v4_${MB_PARCEL_DATA_REVISION}`;
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (Array.isArray(cached) && cached.length > 0) return cached;
  try {
    const res = await fetch(`${MB_PARCEL_DATA_CDN}/masc/${file}`);
    if (!res.ok) return null;
    const rows = await res.json();
    await writeCache(cacheKey, rows);
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
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  const fc = await fetchAllPages(MASC_RISK_AREAS_URL, {
    where: "Risk_Area IS NOT NULL AND Risk_Area <> '' AND Risk_Area <> ' '",
    outFields: 'OBJECTID,Risk_Area',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, PAGE_SIZE);
  await writeCache(cacheKey, fc);
  return fc;
}

/**
 * CLI Soil Capability for Agriculture — sourced from Manitoba's
 * provincial Soil_Survey_MB FeatureServer (the same layer Manitoba's
 * AgriMaps app draws on). The AGCAP_CLS{1-3} fields carry the
 * CLI-style 1-7 agricultural-capability class with organic
 * ("O3"-"O7") and special ("$ML"/"$UL"/"$UR"/"$ZZ") variants, plus
 * AGRI_CAP{1-3} which appends the subclass limitation letter (e.g.
 * "2W" = Class 2 with excess-water limitation).
 *
 * Source switch (2026-05): originally fetched from AAFC's federal
 * cli_agr_cap_250k service (open.canada.ca/data/en/dataset/
 * 0c113e2c-e20e-4b64-be6f-496b1be834ee) at 1:250,000 scale. The
 * provincial Soil_Survey_MB layer is what AgriMaps treats as the
 * authoritative capability source — finer 1:50,000-scale polygons,
 * Manitoba-curated, and three soils per polygon with extent
 * percentages so mixed-capability landscapes (Class 2 main soil +
 * Class 3 subordinate) read accurately.
 *
 * Class scale (1 = best, 7 = worst):
 *   1 — no significant limitations
 *   2 — minor limitations
 *   3 — moderate limitations
 *   4 — severe limitations, marginal for sustained cultivation
 *   5 — only suitable for hay/perennial crops
 *   6 — only suitable for native pasture
 *   7 — no agricultural capability
 *   O3-O7 — organic soils (capability class implied by the digit)
 *   $ML/$UL/$UR/$ZZ — mineral landscape / urban / urban-residential /
 *                     water (no agricultural rating)
 *
 * Subclass letters (suffix on AGRI_CAP, e.g. "2W"):
 *   C climate, T topography, W excess water, M moisture deficiency,
 *   F low fertility, N salinity, I inundation, E erosion, P stoniness,
 *   R shallowness over rock, D dense soil
 *
 * Live-fetched per-muni with the muni boundary polygon as the spatial
 * filter (same pattern as the Sec-Twp Grid). Cached 30 days because
 * the underlying dataset is essentially static. Returns a
 * FeatureCollection of polygons each carrying AGCAP_CLS1 as the
 * stable dominant-class field for map paint.
 */
// Exported for the Data Status tab's live-service list.
export const CLI_AGR_CAP_URL =
  'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Soil_Survey_MB/FeatureServer/0';

// Parcel composition needs Manitoba's original survey boundaries. Keeping
// the geometry settings in one object prevents either soil fetch path from
// quietly reintroducing maxAllowableOffset server-side generalization.
export const SOIL_SURVEY_GEOMETRY_QUERY = Object.freeze({
  returnGeometry: 'true',
  outSR: '4326',
});

const CLI_AGR_CAP_OUTFIELDS = [
  'OBJECTID', 'MAPUNITNOM',
  // Same SOIL_{1-3} composition shape the Soil Survey overlay reads, so
  // the per-parcel `_soilComposition` stamp can use the CLI-fetched
  // polygons interchangeably with the Soil Survey ones (both source
  // from Soil_Survey_MB anyway). SURFTEXT included so the popup row's
  // surface-texture line renders when the CLI overlay is the one
  // driving the stamp.
  'SOILNAME1', 'SOIL_CODE1', 'EXTENT1', 'SURFTEXT1', 'AGCAP_CLS1', 'AGRI_CAP1',
  'SOILNAME2', 'SOIL_CODE2', 'EXTENT2', 'SURFTEXT2', 'AGCAP_CLS2', 'AGRI_CAP2',
  'SOILNAME3', 'SOIL_CODE3', 'EXTENT3', 'SURFTEXT3', 'AGCAP_CLS3', 'AGRI_CAP3',
  // Per-soil-component Manitoba Soil Survey descriptors. These power
  // the "Land features" lines in the hover/click popups (per slot,
  // decoded via map.js's TOPO_LABELS / STONE_LABELS / etc.) and the
  // dominant-soil descriptor columns in the CSV export.
  //
  //   TOPO       — slope class (a-j + level/marsh/urban/water specials)
  //   STONE      — stoniness (Non-stony … Excessively stony)
  //   SALINITY   — non-saline through strongly saline (mS/cm bands)
  //   EROSION    — non-eroded through severely eroded / overwash
  //   DRAINAGE   — rapid / well / imperfect / poor / very poor
  //   SURFTEXTM  — surface-texture modifier (gravelly, mucky, woody)
  //   MANCON     — rolled-up management-considerations code
  //   GEN_RATIN  — irrigation suitability rating
  //   SPUD_RTNG  — potato-irrigation suitability class
  'TOPO1', 'TOPO2', 'TOPO3',
  'STONE1', 'STONE2', 'STONE3',
  'SALINITY1', 'SALINITY2', 'SALINITY3',
  'EROSION1', 'EROSION2', 'EROSION3',
  'DRAINAGE1', 'DRAINAGE2', 'DRAINAGE3',
  'SURFTEXTM1', 'SURFTEXTM2', 'SURFTEXTM3',
  'MANCON1', 'MANCON2', 'MANCON3',
  'GEN_RATIN1', 'GEN_RATIN2', 'GEN_RATIN3',
  'SPUD_RTNG1', 'SPUD_RTNG2', 'SPUD_RTNG3',
  // Server-precomputed polygon area in metres² (Shape__Area is the
  // ArcGIS Online auto-field). Lets the Soil Type palette ranking and
  // the per-parcel composition stamp skip the per-feature turfArea
  // fallback that used to spin for several seconds on busy munis.
  'Shape__Area',
].join(',');

export async function fetchCliAgrForMuni(muniNameWithTyp, muniBoundaryFeature) {
  if (!muniNameWithTyp || !muniBoundaryFeature?.geometry) return null;
  // v8 (2026-07-20): fetches the complete matching OBJECTID set before
  //   loading polygons in batches. This invalidates incomplete v7 payloads
  //   cached for municipalities such as Rockwood that exceed 2,000 polygons.
  //   v7 (2026-07-15): restored Manitoba's full source geometry for
  //   parcel-scale area composition. v6 (2026-05-21): added per-slot
  //   Manitoba Soil Survey descriptors
  //   (TOPO, STONE, SALINITY, EROSION, DRAINAGE, SURFTEXTM, MANCON,
  //   GEN_RATIN, SPUD_RTNG × 3 slots) so the soil popups can render
  //   "Land features" lines and the CSV can carry dominant-soil
  //   descriptor columns. v5 (2026-05-21): added Shape__Area to
  //   outFields so the Soil Type palette can rank by server-
  //   precomputed area instead of the slow turfArea fallback.
  //   v4 (2026-05-20): added maxAllowableOffset for smaller payloads;
  //   v7 removes it because it materially altered some small polygons.
  const cacheKey = `mb_cli_agr_${muniNameWithTyp}_v8`;
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;

  const esriGeom = polygonToEsriGeometry(muniBoundaryFeature);
  if (!esriGeom) return null;

  const fc = await fetchCompleteFeatureSet(CLI_AGR_CAP_URL, {
    where: '1=1',
    geometry: JSON.stringify(esriGeom),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: CLI_AGR_CAP_OUTFIELDS,
    ...SOIL_SURVEY_GEOMETRY_QUERY,
    f: 'geojson',
  }, `Soil Survey for ${muniNameWithTyp}`);
  await writeCache(cacheKey, fc);
  return fc;
}

/**
 * Manitoba Soil Survey (Soil_Survey_MB) — provincial soil-association
 * polygons published by Manitoba Open Data, hosted on the same Esri
 * org as ROLL_ENTRY. Each polygon stamps the dominant 3 soils with
 * SOILNAME{1-3}, SOIL_CODE{1-3}, CLASS{1-3} (CLI-style capability
 * class with subclass, e.g. "3w2x"), EXTENT{1-3} (percent), the map-
 * unit symbol MAPUNITNOM, and survey-report metadata (REPORT_NAME,
 * SCALE, DATE).
 *
 * Coloured on the map by the FIRST character of CLASS1 — that's the
 * agricultural-capability class (1=prime → 7=no capability, plus 'o'
 * organic and 'x' unclassified). Same scale as the CLI Soil overlay,
 * but at finer resolution and with the full soil-association record
 * attached.
 *
 * Source layer carries 149 fields; we only pull what the popup +
 * paint need so the GeoJSON payload stays small. Live-fetched per
 * muni via the muni-boundary polygon as the spatial filter (same
 * shape as fetchCliAgrForMuni). Cached 30 days; the soil survey is
 * essentially static between revisions.
 *
 * Source: Open Manitoba — Manitoba Soil Survey.
 */
const SOIL_SURVEY_URL =
  'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Soil_Survey_MB/FeatureServer/0';
const SOIL_SURVEY_LABELS_URL =
  'https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Soil_Survey_Data_MB_Labels/FeatureServer/0';
// The Esri layer schema truncates several field names to 10 characters
// (a legacy of the Shapefile origin). The metadata lists each truncated
// name plus an `alias` like "REPORT_NAME" — but outFields= only accepts
// the truncated form. Using the alias returns HTTP 400 with no useful
// error body.
//
// CLASS{1-3} is the soil-survey internal code (e.g. "xxxx") — it is
// almost always unhelpful for agricultural rating; many fertile soils
// have CLASS = "xxxx" because the survey didn't carry the class
// inline. Painting + the popup rating chip both use AGCAP_CLS{1-3}
// (clean "1"-"7", "O3"-"O7", "$ML"/"$UL"/"$UR"/"$ZZ" special codes)
// and AGRI_CAP{1-3} (class + subclass like "2W") instead.
const SOIL_SURVEY_OUTFIELDS = [
  'OBJECTID', 'MAPUNITNOM',
  // Shape__Area is server-precomputed (source-SR square metres) and
  // travels with every feature for free. applySoilSurveyPalette uses
  // it for the area-ranking pass so we skip ~3000 turfArea() calls
  // on the main thread when the user opens Soil Survey for a busy
  // muni like St Clements (~3000 polygons). Property name is
  // case-sensitive — ArcGIS GeoJSON returns it as "Shape__Area".
  'Shape__Area',
  // CLASS{1-3} dropped 2026-05-20: the field is the soil-survey
  // INTERNAL code (e.g. "xxxx"), almost never useful, never read
  // by the popup or paint. Saves ~5% of the per-feature attribute
  // payload across ~3000 polygons.
  'SOILNAME1', 'SOIL_CODE1', 'EXTENT1', 'SURFTEXT1', 'AGCAP_CLS1', 'AGRI_CAP1',
  'SOILNAME2', 'SOIL_CODE2', 'EXTENT2', 'SURFTEXT2', 'AGCAP_CLS2', 'AGRI_CAP2',
  'SOILNAME3', 'SOIL_CODE3', 'EXTENT3', 'SURFTEXT3', 'AGCAP_CLS3', 'AGRI_CAP3',
  'REPORT_NAM', 'SCALE', 'DATE',
].join(',');

export async function fetchSoilSurveyForMuni(muniNameWithTyp, muniBoundaryFeature) {
  if (!muniNameWithTyp || !muniBoundaryFeature?.geometry) return null;
  // v7 (2026-07-20): complete OBJECTID-first retrieval. v6 restored full
  // source geometry; this bump also clears any legacy partial payload.
  const cacheKey = `mb_soil_survey_${muniNameWithTyp}_v7`;
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;

  const esriGeom = polygonToEsriGeometry(muniBoundaryFeature);
  if (!esriGeom) return null;

  const fc = await fetchCompleteFeatureSet(SOIL_SURVEY_URL, {
    where: '1=1',
    geometry: JSON.stringify(esriGeom),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: SOIL_SURVEY_OUTFIELDS,
    ...SOIL_SURVEY_GEOMETRY_QUERY,
    f: 'geojson',
  }, `Soil Survey for ${muniNameWithTyp}`);
  await writeCache(cacheKey, fc);
  return fc;
}

/**
 * Companion point layer carrying the soil map-unit symbols for label
 * placement on the map. Same field shape as Soil_Survey_MB but as
 * points at the polygon centroid. Used by map.js's soil-survey-label
 * symbol layer; rendered alongside the fill so the user can read
 * the unit symbol (e.g. "ALMv-S2") at zoom ≥ 11 without clicking.
 */
export async function fetchSoilSurveyLabelsForMuni(muniNameWithTyp, muniBoundaryFeature) {
  if (!muniNameWithTyp || !muniBoundaryFeature?.geometry) return null;
  // v3 (2026-07-20): complete OBJECTID-first retrieval. v2 raised the old
  // fixed cap, but could still have cached a partial future municipality.
  const cacheKey = `mb_soil_survey_labels_${muniNameWithTyp}_v3`;
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;

  const esriGeom = polygonToEsriGeometry(muniBoundaryFeature);
  if (!esriGeom) return null;

  const fc = await fetchCompleteFeatureSet(SOIL_SURVEY_LABELS_URL, {
    where: '1=1',
    geometry: JSON.stringify(esriGeom),
    geometryType: 'esriGeometryPolygon',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID,MAPUNITNOM,CLASS1',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, `Soil Survey labels for ${muniNameWithTyp}`);
  await writeCache(cacheKey, fc);
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
 * doesn't change, so the file ships through a GitHub Release and
 * the /api/section-grid edge function streams it with CORS (same
 * pattern as legal-index / assessment-index).
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
  // v3: source URL moved from a local /data/section-grid.json file to
  // the /api/section-grid edge function (which streams the same
  // GeoJSON from a GitHub Release — same pattern as legal-index /
  // assessment-index). Bumping the cache key forces clients off the
  // old in-localStorage entry on first load.
  const cacheKey = 'mb_section_grid_province_v3';
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  // Edge function URL — no cache-bust query param needed: the edge
  // function URL is stable and a re-release just changes RELEASE_URL
  // inside api/section-grid.js, which arrives with the next deploy.
  const url = `${import.meta.env?.BASE_URL || '/'}api/section-grid`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Province-wide section grid not found at ${url} (status ${res.status}). ` +
      `Run \`Rscript r/build_section_grid.R\` to regenerate, then publish ` +
      `a new GitHub Release and bump RELEASE_URL in api/section-grid.js.`
    );
  }
  const fc = await res.json();
  await writeCache(cacheKey, fc);
  return fc;
}

/**
 * Fetch the pre-baked dominant MASC soil rating for every parcel in a
 * single municipality. Built by r/build_parcel_masc.R from a spatial
 * intersection of ROLL_ENTRY parcels × MASC quarter-section polygons.
 *
 * Per-muni shards live in mb-parcel-data/parcel-masc/<MUNI_KEY>.json.
 * Shape: a flat dictionary keyed by Roll_No_Txt:
 *   { "3600.000": { rating: "C", ra: 32, q: "NE", s: 1, t: 12, r: 5, d: "E" }, ... }
 * Manifest at mb-parcel-data/parcel-masc/_index.json maps the original
 * Muni_Name_With_Typ values to shard filenames + counts.
 *
 * Returns a {rollNoTxt → ratingObj} map, or null when the muni isn't
 * in the index (urban munis with no farmland — Winnipeg, Brandon centre,
 * etc. — typically drop out of the build).
 *
 * Cached in localStorage with the same 30-day TTL as MASC overlay shards.
 */
const PARCEL_MASC_INDEX_URL = `${MB_PARCEL_DATA_CDN}/parcel-masc/_index.json`;

let parcelMascIndexPromise = null;

async function fetchParcelMascIndex() {
  if (parcelMascIndexPromise) return parcelMascIndexPromise;
  parcelMascIndexPromise = (async () => {
    const cacheKey = `mb_parcel_masc_index_v5_${MB_PARCEL_DATA_REVISION}`;
    const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
    if (cached) return cached;
    try {
      const res = await fetch(PARCEL_MASC_INDEX_URL);
      if (!res.ok) return null;
      const idx = await res.json();
      await writeCache(cacheKey, idx);
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
  const cacheKey = `mb_parcel_masc_${file}_v5_${MB_PARCEL_DATA_REVISION}`;
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  try {
    const res = await fetch(`${MB_PARCEL_DATA_CDN}/parcel-masc/${file}`);
    if (!res.ok) return null;
    const dict = await res.json();
    await writeCache(cacheKey, dict);
    return dict;
  } catch {
    return null;
  }
}

/**
 * Fetch the pre-baked land-cover summary for every farmland parcel
 * (over LAND_COVER_MIN_ACRES acres) in a single municipality. Built by r/build_landcover.R,
 * which bridges the mao-assembly land-cover Parquet (per-parcel
 * percentages of the 12 LCR_RCT_2020 raster classes) into the same
 * per-muni shard format as parcel-masc.
 *
 * Per-muni shards live at web/public/data/landcover/<MUNI_KEY>.json.
 * Shape: a flat dictionary keyed by Roll_No_Txt, each value the five
 * farmland buckets as fractions (0-1) that sum to ~1:
 *   { "100.000": { cult: 0.78, past: 0.10, bush: 0.08, wet: 0.03, other: 0.01 }, ... }
 *     cult = cultivated/cropland · past = pasture/grass · bush = bush/treed
 *     wet  = wetland/water       · other = built-up/barren/etc.
 * Manifest at web/public/data/landcover/_index.json maps the original
 * Muni_Name_With_Typ values to shard filenames + counts.
 *
 * Returns a {rollNoTxt → bucketObj} map, or null when the muni isn't in
 * the index (urban munis with no farmland-scale parcels drop out of the
 * build). Cached in localStorage with the same 30-day TTL as the MASC
 * and parcel-masc shards.
 */
const LANDCOVER_INDEX_URL = `${MB_PARCEL_DATA_CDN}/landcover/_index.json`;

let landCoverIndexPromise = null;

// Exported for the Data Status dialog, which reads the index's `_meta`
// vintage stamp; muni lookups go through fetchLandCoverForMuni below.
export async function fetchLandCoverIndex() {
  if (landCoverIndexPromise) return landCoverIndexPromise;
  landCoverIndexPromise = (async () => {
    // Revision in the key (same fix as the water keys): bumping the pinned
    // data commit must invalidate cached shards, or a browser keeps serving
    // old land cover for up to the 30-day TTL after a publish.
    const cacheKey = `mb_landcover_index_v1_${MB_PARCEL_DATA_REVISION}`;
    const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
    if (cached) return cached;
    try {
      const res = await fetch(LANDCOVER_INDEX_URL);
      if (!res.ok) return null;
      const idx = await res.json();
      await writeCache(cacheKey, idx);
      return idx;
    } catch {
      return null;
    }
  })();
  return landCoverIndexPromise;
}

export async function fetchLandCoverForMuni(muniNameWithTyp) {
  if (!muniNameWithTyp) return null;
  const idx = await fetchLandCoverIndex();
  const entry = lookupMuniManifestEntry(idx, muniNameWithTyp, { stripType: false });
  if (!entry) return null;
  const file = entry.file;
  const cacheKey = `mb_landcover_${file}_v1_${MB_PARCEL_DATA_REVISION}`;
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  try {
    const res = await fetch(`${MB_PARCEL_DATA_CDN}/landcover/${file}`);
    if (!res.ok) return null;
    const dict = await res.json();
    await writeCache(cacheKey, dict);
    return dict;
  } catch {
    return null;
  }
}

/**
 * Fetch the pre-baked water-influence classification for every parcel in one
 * municipality. Built by r/build_water.R from the V6.1 waterfront detection.
 *
 * Per-muni shards live at mb-parcel-data/water/<MUNI_KEY>.json. Shape: a flat
 * dictionary keyed by Roll_No_Txt, each value a compact stamp:
 *   { "3600.000": { "i":"Yes", "c":"Direct", "t":"Lake", "b":"Lake Winnipeg" } }
 * Manifest at mb-parcel-data/water/_index.json maps Muni_Name_With_Typ to
 * shard filenames plus counts.
 *
 * ONLY parcels with a non-"None" classification are in the shards — 370k of
 * 437k parcels have no water within 50 m, and shipping them would inflate the
 * payload sixfold to say nothing. So a roll ABSENT from a shard that loaded
 * means "no water", which is a different state from "shard never loaded".
 * Callers must track which munis actually resolved (see `_waterLoaded` in
 * main.js) rather than treating a missing stamp as "No".
 *
 * Returns null when the muni isn't in the index. Cached in localStorage with
 * the same 30-day TTL as the MASC and land-cover shards.
 */
const WATER_INDEX_URL = `${MB_PARCEL_DATA_CDN}/water/_index.json`;

let waterIndexPromise = null;

// Exported for the Data Status dialog, same as fetchLandCoverIndex.
export async function fetchWaterIndex() {
  if (waterIndexPromise) return waterIndexPromise;
  waterIndexPromise = (async () => {
    // Revision in the key, matching the MASC pattern: bumping the pinned
    // data commit must invalidate cached shards, or a browser keeps serving
    // old verdicts for up to the 30-day TTL after a publish.
    const cacheKey = `mb_water_index_v1_${MB_PARCEL_DATA_REVISION}`;
    const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
    if (cached) return cached;
    try {
      const res = await fetch(WATER_INDEX_URL);
      if (!res.ok) return null;
      const idx = await res.json();
      await writeCache(cacheKey, idx);
      return idx;
    } catch {
      return null;
    }
  })();
  return waterIndexPromise;
}

export async function fetchWaterForMuni(muniNameWithTyp) {
  if (!muniNameWithTyp) return null;
  const idx = await fetchWaterIndex();
  const entry = lookupMuniManifestEntry(idx, muniNameWithTyp, { stripType: false });
  if (!entry) return null;
  const file = entry.file;
  const cacheKey = `mb_water_${file}_v1_${MB_PARCEL_DATA_REVISION}`;
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  try {
    const res = await fetch(`${MB_PARCEL_DATA_CDN}/water/${file}`);
    if (!res.ok) return null;
    const dict = await res.json();
    await writeCache(cacheKey, dict);
    return dict;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Historical (as-of-year) snapshots — served from the separate
// mb-parcel-history repo via the jsDelivr CDN. Self-contained: the app
// discovers available years + each year's muni list/dates from the published
// manifests, so adding a year needs NO app code change. Generated by
// r/build_historical_shards.R; see DATA-ARCHIVE-PLAN.md for the original
// design rationale (superseded — for cadence read MAINTENANCE.md §2-4).
// ---------------------------------------------------------------------------
// Pinned to an IMMUTABLE commit, not @main. jsDelivr's view of a branch HEAD
// lags and is inconsistent per-file, so @main kept serving stale geometry for
// some munis even after a purge (Steinbach showed 36% triangles while Hanover
// was clean — both fixed in the same commit). A commit SHA is immutable on
// jsDelivr: it serves that exact tree immediately, no lag, no purge needed.
// MAINTENANCE: when you republish mb-parcel-history (new snapshot or a data
// fix), update this SHA to the new commit — see MAINTENANCE.md.
const HISTORICAL_CDN =
  'https://cdn.jsdelivr.net/gh/jayschellenberg/mb-parcel-history@7e736813060449f20cf80095f49c7d4b4966867c';
const HISTORICAL_INDEX_TTL_MS = 24 * 60 * 60 * 1000;        // 1 day — so new years surface
const HISTORICAL_MANIFEST_TTL_MS = 6 * 60 * 60 * 1000;     // 6 h — gates the shard version token, keep fresh
const HISTORICAL_SHARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days — safe: the key is version-stamped, so a rebuild changes it

let historicalIndexPromise = null;

/** Root discovery index: { years: { "2026": { layers:{parcels:{date},...} } } }. */
export async function fetchHistoricalIndex() {
  if (historicalIndexPromise) return historicalIndexPromise;
  historicalIndexPromise = (async () => {
    // v3: bumped when 2026-06-05 was RETIRED (2026-08-13). The 1-day TTL is
    // sized for snapshots being ADDED, where a day's lag costs nothing. A
    // REMOVAL is the opposite case: a stale index keeps offering a date whose
    // shards now 404, so the picker lists an option that fails when chosen.
    // Bump this key on every retirement — it invalidates on the next load.
    const cacheKey = 'mb_historical_index_v3';
    const cached = await readCache(cacheKey, HISTORICAL_INDEX_TTL_MS);
    if (cached) return cached;
    try {
      const res = await fetch(`${HISTORICAL_CDN}/index.json`);
      if (!res.ok) return null;
      const idx = await res.json();
      await writeCache(cacheKey, idx);
      return idx;
    } catch { return null; }
  })();
  return historicalIndexPromise;
}

/** Per-year manifest: layer dates + munis { "<muni_no>": { name, parcels } }. */
export async function fetchHistoricalManifest(year) {
  if (!year) return null;
  // v3: short TTL + bumped so a republished snapshot's NEW `generated` stamp is
  // picked up promptly — that stamp version-keys the shard cache below.
  const cacheKey = `mb_historical_manifest_${year}_v3`;
  const cached = await readCache(cacheKey, HISTORICAL_MANIFEST_TTL_MS);
  if (cached) return cached;
  try {
    const res = await fetch(`${HISTORICAL_CDN}/${year}/manifest.json`);
    if (!res.ok) return null;
    const m = await res.json();
    await writeCache(cacheKey, m);
    return m;
  } catch { return null; }
}

// Build-version token from a manifest's `generated` timestamp (digits only).
// Used to version-key the shard cache so a republish auto-invalidates it.
function manifestVersionToken(manifest) {
  const g = manifest?.generated;
  return g ? String(g).replace(/\D/g, '').slice(0, 14) : 'v4';
}

/**
 * One layer's GeoJSON FeatureCollection for a year + muni number.
 * `layer` is 'parcels' | 'zoning' | 'devplan'. Returns null on a miss
 * (e.g. a muni with no zoning/dev-plan shard) — callers skip that layer.
 */
export async function fetchHistoricalShard(year, layer, muniNo) {
  if (!year || !layer || muniNo == null || muniNo === '') return null;
  // Self-invalidating cache: the key embeds the snapshot manifest's build
  // timestamp, so ANY republish (e.g. the geometry-fix rebuild that stopped
  // small lots collapsing into triangles) changes the key and the client
  // re-fetches — no manual version bumps, and a stale 30-day entry from an
  // earlier build is never served.
  const manifest = await fetchHistoricalManifest(year);
  const ver = manifestVersionToken(manifest);
  const cacheKey = `mb_historical_${year}_${layer}_${muniNo}_${ver}`;
  const cached = await readCache(cacheKey, HISTORICAL_SHARD_TTL_MS);
  if (cached) return cached;
  try {
    const res = await fetch(`${HISTORICAL_CDN}/${year}/${layer}/${muniNo}.json`);
    if (!res.ok) return null;
    const fc = await res.json();
    await writeCache(cacheKey, fc);
    return fc;
  } catch { return null; }
}

/**
 * Inferred parcel lineage for a muni: { by_roll: { "<roll>": { predecessors,
 * successors, type, confidence } }, events, disclaimer }. Built by
 * r/build_lineage.R from geometry overlap of consecutive UNSIMPLIFIED
 * snapshots. Null when the muni has no lineage shard (no detected changes).
 */
export async function fetchHistoricalLineage(muniNo) {
  if (muniNo == null || muniNo === '') return null;
  const cacheKey = `mb_lineage_${muniNo}_v1`;
  const cached = await readCache(cacheKey, HISTORICAL_INDEX_TTL_MS);
  if (cached) return cached;
  try {
    const res = await fetch(`${HISTORICAL_CDN}/lineage/${muniNo}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    await writeCache(cacheKey, data);
    return data;
  } catch { return null; }
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
  let type = '';
  let s = normalizeMuniLookupKey(name, { stripType: false });
  if (stripType) {
    s = s.replace(/\s*\([^)]*\)\s*$/, '');
  } else {
    const parenthetical = s.match(/\((RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE)\)\s*$/);
    if (parenthetical) {
      type = normalizeMuniLookupType(parenthetical[1]);
      s = s.replace(/\s*\([^)]*\)\s*$/, '');
    }
    s = s.replace(
      /\b(RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE)\s+OF\b/g,
      (_, t) => {
        type ||= normalizeMuniLookupType(t);
        return '';
      },
    );
    s = s.replace(/\s+(RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE)$/g, (_, t) => {
      type ||= normalizeMuniLookupType(t);
      return '';
    });
  }
  // Same reconciliation list the identity matcher uses — imported rather than
  // repeated so a new alias lands in both. Only the final separator handling
  // differs: this builds a compact no-separator shard key.
  const compact = reconcileMuniSpelling(s.replace(/&/g, ' AND '))
    .replace(/[^A-Z0-9]+/g, '');
  return stripType ? compact : `${compact}${type}`;
}

function normalizeMuniLookupType(value) {
  const t = String(value || '').toUpperCase().trim();
  if (t === 'RURAL MUNICIPALITY') return 'RM';
  return t;
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
  const cacheKey = `mb_masc_riverlots_v4_${MB_PARCEL_DATA_REVISION}`;
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  const url = `${MB_PARCEL_DATA_CDN}/masc-riverlots.json`;
  let res;
  try { res = await fetch(url); } catch { return null; }
  if (!res.ok) return null;
  const fc = await res.json();
  await writeCache(cacheKey, fc);
  return fc;
}

export async function fetchRiverLots() {
  // v3: labels now pretty-printed at build time by r/build_river_lots.R
  // (no JS-side transform needed). Bump invalidates v2 cache entries
  // that still carry the JS-prettified or raw-concatenated form.
  const cacheKey = 'mb_river_lots_v3';
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  const url = `${MB_PARCEL_DATA_CDN}/river-lots.json`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const fc = await res.json();
  await writeCache(cacheKey, fc);
  return fc;
}

export async function fetchSurveyGridForMuni(muniNameWithTyp, muniBoundaryFeature) {
  if (!muniNameWithTyp || !muniBoundaryFeature?.geometry) return null;
  // v3: matches the section-grid province-cache bump; pairs with the
  // sectionLinesFromRows meridian-normalization fix.
  const cacheKey = `mb_survey_grid_${muniNameWithTyp}_v3`;
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
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
    // MB_LegalDesc's identity column is OBJECTID_1, not OBJECTID — the
    // default orderByFields fetchAllPages applies would 400 on this
    // service. Pass the correct field explicitly so pagination stays
    // ordered and the survey-grid fetch actually returns rows.
    orderByFields: 'OBJECTID_1 ASC',
  }, 50000);
  await writeCache(cacheKey, fc);
  return fc;
}

export async function fetchMunicipalBoundaries() {
  const cacheKey = 'mb_muni_boundaries_v2';
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
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
  await writeCache(cacheKey, fc);
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
  const cached = await readCache(cacheKey);
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
  await writeCache(cacheKey, fc);
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
  const cached = await readCache(cacheKey);
  if (cached) return cached;
  const fc = await fetchAllPages(TRAFFIC_STATIONS_URL, {
    where: '1=1',
    outFields: 'StationNum,HighwayNum,HighwayAlt,LocationDe,Region,FlowDirect,StationTyp',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  }, 5000);
  await writeCache(cacheKey, fc);
  return fc;
}

/**
 * Fetch the MHTIS Traffic Flow polylines. Each segment carries an AADT value,
 * the highway / road identifier, and the StationNum it was estimated from.
 * Used both as a toggleable map overlay and as the source for inlining AADT
 * into the station-click popup (joined on StationNum).
 */
export async function fetchTrafficFlow() {
  // v2: moved from the 2019 layer to the 2023 one and started reading
  // AADT_2023. The key bump is essential — a v1 entry holds 2019-vintage
  // counts under the old field, and those would otherwise sit in browsers
  // until the cache aged out, hiding the upgrade behind stale data.
  const cacheKey = 'mb_traffic_flow_v2';
  const cached = await readCache(cacheKey);
  if (cached) return cached;
  // The MHTIS Traffic Flow layer's OID field is `FID`, not OBJECTID,
  // so fetchAllPages's default `orderByFields: 'OBJECTID ASC'` returns
  // HTTP 400 "Invalid field: OBJECTID" — pass the right field name
  // explicitly so paging works.
  const fc = await fetchAllPages(TRAFFIC_FLOW_URL, {
    where: '1=1',
    outFields: 'StationNum,ROAD_NO,ROAD_IDENT,FlowDirect,AADT,AADT_2023,DateOfEsti,START_KM,END_KM,LENGTH_KM,REGION_NO',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    orderByFields: 'FID ASC',
  }, 20000);
  await writeCache(cacheKey, fc);
  return fc;
}

/**
 * Fetch the complete Manitoba Road Network 2023. The provincial service has
 * fewer than 2,000 features, but this still uses the shared paginator so a
 * future republish can grow without silently truncating the overlay.
 */
export async function fetchManitobaHighways() {
  const cacheKey = 'mb_road_network_2023_v1';
  const cached = await readCache(cacheKey, MUNI_BOUNDARIES_TTL_MS);
  if (cached) return cached;
  const fc = await fetchAllPages(MB_ROAD_NETWORK_URL, {
    where: '1=1',
    outFields: 'RteType,RteName,RteDesignation,CommonRoadName_003,CommonRoadName_004',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '5',
    returnZ: 'false',
    returnM: 'false',
    f: 'geojson',
  }, 10000);
  await writeCache(cacheKey, fc);
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
/**
 * Distill Roll_Entry's Property_Address field into a real civic
 * address or the empty string. The field is a hybrid in source: some
 * parcels carry an actual address ("60 SILVERSIDE DR"), others carry
 * a legal reference ("1--24134", "NE34-2-4W", "DESC NE34-2-4W"). The
 * civic-label symbol layer reads the empty-string output and just
 * doesn't render — so the user sees civic addresses at zoom 16 only
 * for parcels that actually have one.
 *
 * Exclusions (returns '' for any of these):
 *   - empty / whitespace
 *   - starts with "DESC " (legal-description marker)
 *   - only digits + dashes / slashes / spaces / dots — covers
 *     "1--24134", "7-1-2246", "8-7-32457"
 *   - section-township-range pattern with optional direction prefix
 *     and meridian suffix — covers "NE34-2-4W", "NW4-3-1E", "S17-10-5"
 */
const RE_DESC_PREFIX = /^DESC\b/i;
const RE_NUMERIC_REFERENCE = /^[\d\s\-./]+$/;
const RE_SEC_TWP_RNG = /^[NSEW]{0,2}\d+-\d+-\d+[NSEW]?$/i;
function civicAddressOrEmpty(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (RE_DESC_PREFIX.test(s))      return '';
  if (RE_NUMERIC_REFERENCE.test(s)) return '';
  if (RE_SEC_TWP_RNG.test(s))      return '';
  return s;
}

export async function fetchAllParcelsInMunicipality(municipality) {
  if (rollEntrySnapshot) return fetchAllParcelsInMunicipalityFromSnapshot(municipality);
  if (!municipality) return makeEmptyFc();
  // v5: dedupe pass by OBJECTID after pagination so the same Roll
  // Layer label can't render multiple times for the same feature when
  // an upstream cache (or transient ArcGIS pagination glitch) emitted
  // a duplicate row. Reported case: roll 187640 in DE SALABERRY (RM)
  // rendering its label 6× on a single polygon.
  // v4: per-feature _civicAddress stamping (civicAddressOrEmpty()
  // distills Property_Address down to actual addresses or '' for
  // the new muni-parcels-civic-label symbol layer). v3 entries
  // don't carry the field — so a cached v3 response would render
  // zero civic labels until a manual cache bust.
  // v3: _acres prefers Roll_Entry's Frontage_or_Area when the
  // assessor recorded an actual area (vs frontage feet); falls back
  // to turf-area on the polygon when the field is in feet or
  // missing.
  const cacheKey = `mb_muni_parcels_v5_${municipality}`;
  const cached = await readCache(cacheKey);
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
  // OBJECTID dedupe (defensive — see v5 comment above). Drops any
  // accidentally-paginated dups, falling back to a Roll_No_Txt+Address
  // composite key if OBJECTID is missing on a particular feature.
  const seenIds = new Set();
  fc.features = (fc.features || []).filter((f) => {
    const oid = f.properties?.OBJECTID;
    const key = oid != null
      ? `oid:${oid}`
      : `roll:${f.properties?.Roll_No_Txt || ''}|${f.properties?.Property_Address || ''}`;
    if (seenIds.has(key)) return false;
    seenIds.add(key);
    return true;
  });
  // Stamp acreage onto each feature so the hover popup can show Land Size
  // without recomputing. Resolution goes through the shared resolver so this
  // path applies the same nominal-roll guard and roll-vs-polygon cross-check
  // as the results grid — before, a crown parcel could read "0.01 ac" here
  // and "357 ac" in the grid because only the grid ran the guard.
  for (const f of fc.features || []) {
    const rollAcres = acresFromFrontageField(f.properties?.Frontage_or_Area);
    let geomAcres = null;
    try {
      const sqm = area(f);
      if (Number.isFinite(sqm) && sqm > 0) geomAcres = sqm / 4046.8564224;
    } catch { /* topology errors — leave geometry out of the decision */ }
    const resolved = resolveParcelAcres(rollAcres, geomAcres);
    if (resolved.acres != null) {
      f.properties._acres = resolved.acres;
      f.properties._acresSource = resolved.source;
      if (resolved.rollNominal) {
        f.properties._acresRollNominal = true;
        f.properties._rollNominalAcres = resolved.rollValue;
      }
      if (resolved.areaMismatch) {
        f.properties._acresMismatch = true;
        f.properties._acresVariancePct = resolved.variancePct;
        f.properties._acresGeomValue = resolved.geomValue;
      }
    }
    // Pre-strip the .000 sub from Roll_No_Txt for display contexts
    // (the muni-parcels-label paint expression in map.js reads
    // _rollDisplay). Keeps the raw Roll_No_Txt around for search
    // and join keys; this is purely cosmetic.
    const r = f.properties?.Roll_No_Txt;
    if (typeof r === 'string') {
      f.properties._rollDisplay = r.endsWith('.000') ? r.slice(0, -4) : r;
    }
    // Civic-address pass: Property_Address is a hybrid field — for
    // urban / serviced parcels it holds an actual civic address
    // ("60 SILVERSIDE DR"); for rural / unimproved / legal-description-
    // only entries it holds non-address content like "DESC NE34-2-4W",
    // "1--24134", "NE34-2-4W", or "DESC 8-7-32457". The
    // muni-parcels-civic-label symbol layer reads _civicAddress and
    // skips any feature whose value is empty, so this lets non-address
    // entries silently drop out of the on-map civic labels while
    // staying available in the hover popup as Property_Address.
    f.properties._civicAddress = civicAddressOrEmpty(f.properties?.Property_Address);
  }
  // Don't cache the truncated flag; if a giant muni hit the cap, we want
  // the user to know each session.
  await writeCache(cacheKey, fc);
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
    const aadt = currentAadt(p);
    if (sn == null || aadt == null) continue;
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
  // Reuse the same dot-variant clause the layer fetcher uses so the
  // category dropdown and the per-muni overlay fetch agree on what
  // matches. Without this, the dropdown finds the right zones but
  // the layer query returns zero polygons for "St."-prefix munis.
  return `${baseValue} AND ${muniNameMatchClause(muni)}`;
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
async function resolveOverlayFilter({ zoneCategory, devPlanCategory, zoningChanged, devPlanChanged, tileDrainageOnly, irrigationOnly, municipality }) {
  const overlayQueries = [];
  // The water-rights filters resolve to their own OBJECTID sets rather
  // than joining `overlayQueries`: their polygons come from a different
  // service (WALLAS, see wallas.js) that shares no WHERE-clause
  // vocabulary with the zoning / dev-plan layers, and they're already in
  // hand as GeoJSON rather than fetched here.
  //
  // Run in parallel — with both ticked these are two independent walks of
  // Roll_Entry, and sequencing them would double the wait for no reason.
  const [tileOidSet, irrigationOidSet] = await Promise.all([
    tileDrainageOnly ? resolveTileDrainageOids(municipality) : null,
    irrigationOnly ? resolveIrrigationOids(municipality) : null,
  ]);
  // An explicit empty set is a real answer — "nothing licensed in scope" —
  // and must short-circuit to zero results rather than fall through to an
  // unfiltered query.
  if (tileOidSet !== null && tileOidSet.size === 0) return [];
  if (irrigationOidSet !== null && irrigationOidSet.size === 0) return [];

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

  // Water-rights filters only, with no zoning / dev-plan narrowing
  // alongside them. Both ticked means both must hold.
  if (overlayQueries.length === 0) {
    const sets = [tileOidSet, irrigationOidSet].filter((s) => s !== null);
    if (sets.length === 0) return null;
    return [...intersectSets(sets)];
  }

  // Add the muni narrowing to each overlay query when set. Roll Entry's
  // Muni_Name_With_Typ ("STONEWALL (TOWN)") differs from the overlay
  // layers' MUNI_NAME ("Stonewall") — and some overlay-side names
  // carry inconsistent dots on "St"/"Ste" abbreviations. muniNameMatchClause
  // handles both differences via a UPPER(MUNI_NAME) IN-list.
  const muniClause = municipality ? muniNameMatchClause(municipality) : null;

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
  // category filter the user set. The water-rights filters join the same
  // AND: a parcel has to satisfy them *and* the zoning / dev-plan
  // narrowing.
  if (tileOidSet !== null) oidSets.push(tileOidSet);
  if (irrigationOidSet !== null) oidSets.push(irrigationOidSet);
  return [...intersectSets(oidSets)];
}

/** Intersection of an array of Sets. Empty array → empty Set, so callers
 *  never have to special-case "no filters resolved". */
function intersectSets(sets) {
  let out = null;
  for (const set of sets) {
    if (out === null) {
      out = set;
      continue;
    }
    const next = new Set();
    for (const v of out) if (set.has(v)) next.add(v);
    out = next;
  }
  return out ?? new Set();
}

/** Roll_Entry OBJECTIDs covered by a licensed tile-drainage area. */
async function resolveTileDrainageOids(municipality) {
  return resolveWallasOids(fetchTileDrainageAreas, municipality, 'tile-drainage');
}

/**
 * Roll_Entry OBJECTIDs covered by a licensed irrigation POINT OF USE.
 *
 * Points of diversion are excluded on purpose. A diversion is an intake
 * or a well — water is taken from there, not applied to it — so it says
 * nothing about whether a parcel is irrigated, and the Irrigation column
 * doesn't report it either. Including them here would hand back parcels
 * that the column then labels "No record", which is precisely the
 * filter/column disagreement worth avoiding.
 *
 * It also halves the work: ~2,500 points of use province-wide instead of
 * ~5,300 footprints across both kinds.
 */
async function resolveIrrigationOids(municipality) {
  return resolveWallasOids(fetchIrrigationPointsOfUse, municipality, 'irrigation');
}

/** The point-of-use half of the cached irrigation collection. Shares the
 *  single cached fetch — wallas.js tags each feature with `_wallasKind`
 *  precisely so the two can be separated without a second round-trip. */
async function fetchIrrigationPointsOfUse() {
  const fc = await fetchIrrigationLicences();
  if (!fc || fc._failed) return fc;
  return {
    type: 'FeatureCollection',
    features: (fc.features || []).filter((f) => f.properties?._wallasKind === 'use'),
  };
}

/**
 * Roll_Entry OBJECTIDs intersecting a set of WALLAS footprints, as a Set.
 *
 * Why this isn't a client-side post-filter: 122 of Manitoba's 186 munis
 * hold more parcels than MAX_RESULTS, so filtering the returned page
 * would hide matches behind the row cap — the same trap civicNumberClause
 * exists to avoid. Resolving to OBJECTIDs first means the cap applies to
 * the already-filtered set.
 *
 * The cost driver is one spatial query per footprint, so the polygon set
 * gets narrowed first. With a municipality selected we ask Roll_Entry for
 * that muni's extent (one cheap returnExtentOnly request) and drop every
 * footprint outside it — taking ~1,580 tile / ~6,000 irrigation polygons
 * province-wide down to tens or low hundreds. Without a municipality
 * there's nothing to narrow by and all of them run; that's slow but
 * correct, and both tips steer the user to pick a muni first.
 *
 * @param {Function} fetchFc   the wallas.js fetcher for this layer
 * @param {string} municipality  Muni_Name_With_Typ, or '' for province-wide
 * @param {string} label       used in the unreachable-service message
 */
async function resolveWallasOids(fetchFc, municipality, label) {
  const fc = await fetchFc();
  // A failed WALLAS fetch is not the same as "nothing licensed anywhere".
  // Returning an empty set would silently produce zero results and read as
  // a confident answer, so surface it instead.
  if (fc?._failed) {
    throw new Error(`Water Rights Licensing (WALLAS) is unreachable — ${label} filter unavailable.`);
  }
  let footprints = fc?.features || [];
  if (footprints.length === 0) return new Set();

  if (municipality) {
    const extent = await fetchMuniExtent(municipality);
    if (extent) {
      footprints = footprints.filter((f) => {
        let b;
        try { b = bbox(f); } catch { return false; }
        return bboxesOverlap(b, extent);
      });
    }
  }
  if (footprints.length === 0) return new Set();

  const muniClause = municipality
    ? `Muni_Name_With_Typ = '${escapeSql(municipality)}'`
    : '1=1';
  // Footprints go out in batches as one multi-ring polygon each — see
  // polygonsToEsriGeometry. One request per footprint is what made this
  // filter slow enough to feel broken on an irrigation-heavy muni.
  const batches = [];
  for (let i = 0; i < footprints.length; i += WALLAS_FILTER_BATCH_SIZE) {
    batches.push(footprints.slice(i, i + WALLAS_FILTER_BATCH_SIZE));
  }
  const results = await runParallelBatched(batches, SPATIAL_CONCURRENCY, async (batch) => {
    const esriGeom = polygonsToEsriGeometry(batch);
    if (!esriGeom) return [];
    const oidFc = await fetchAllPages(ROLL_URL, {
      where: muniClause,
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
  });
  return new Set(results.flat());
}

/**
 * Bounding box of every Roll_Entry parcel in one municipality, as
 * [minLon, minLat, maxLon, maxLat]. One returnExtentOnly request — the
 * service computes it server-side, so nothing but the box comes back.
 * Cached for a week: a municipality's footprint only changes on
 * amalgamation. Returns null on failure so callers degrade to "no
 * narrowing" rather than to "no results".
 */
async function fetchMuniExtent(municipality) {
  const cacheKey = `mb_muni_extent_${String(municipality).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_v1`;
  const cached = await readCache(cacheKey, CACHE_TTL_MS);
  if (Array.isArray(cached) && cached.length === 4) return cached;
  try {
    const usp = new URLSearchParams({
      where: `Muni_Name_With_Typ = '${escapeSql(municipality)}'`,
      returnExtentOnly: 'true',
      outSR: '4326',
      f: 'json',
    });
    const res = await fetch(`${ROLL_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: usp.toString(),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const e = json?.extent;
    if (!e) return null;
    const box = [e.xmin, e.ymin, e.xmax, e.ymax];
    if (!box.every(Number.isFinite)) return null;
    await writeCache(cacheKey, box);
    return box;
  } catch {
    return null;
  }
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
 * Fetch a provably complete FeatureServer result set.
 *
 * ArcGIS caps normal feature responses at maxRecordCount, but its ID-only
 * query returns the full matching OBJECTID set. Capture that set first, fetch
 * those exact IDs in server-sized batches, then verify that every requested
 * ID arrived exactly once. Callers may safely cache the result only after this
 * function returns; any partial or inconsistent response throws instead of
 * becoming plausible-looking missing data.
 */
export async function fetchCompleteFeatureSet(baseUrl, params, label = 'ArcGIS dataset') {
  const idParams = {
    ...params,
    returnIdsOnly: 'true',
    returnGeometry: 'false',
    f: 'json',
  };
  delete idParams.outFields;
  delete idParams.outSR;
  delete idParams.orderByFields;
  delete idParams.resultOffset;
  delete idParams.resultRecordCount;
  delete idParams.objectIds;

  const idResponse = await fetchPage(baseUrl, idParams);
  if (!Array.isArray(idResponse?.objectIds)) {
    throw new Error(`${label} did not return an OBJECTID list; refusing an unverifiable load.`);
  }

  const objectIdFieldName = idResponse.objectIdFieldName || 'OBJECTID';
  const ids = idResponse.objectIds.slice().sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb)
      ? na - nb
      : String(a).localeCompare(String(b));
  });
  const expected = new Set(ids.map((id) => String(id)));
  if (expected.size !== ids.length) {
    throw new Error(`${label} returned duplicate OBJECTIDs; refusing an unverifiable load.`);
  }
  if (ids.length === 0) {
    return {
      type: 'FeatureCollection',
      features: [],
      _truncated: false,
      _expectedCount: 0,
    };
  }

  const features = [];
  for (let i = 0; i < ids.length; i += PAGE_SIZE) {
    const chunk = ids.slice(i, i + PAGE_SIZE);
    const batchParams = {
      ...params,
      where: '1=1',
      objectIds: chunk.join(','),
      orderByFields: `${objectIdFieldName} ASC`,
    };
    // The ID snapshot already expresses the spatial filter. Omitting the
    // municipal boundary from each batch keeps POST bodies smaller and avoids
    // a layer edit between requests changing which features qualify.
    delete batchParams.geometry;
    delete batchParams.geometryType;
    delete batchParams.inSR;
    delete batchParams.spatialRel;
    delete batchParams.returnIdsOnly;
    delete batchParams.resultOffset;
    delete batchParams.resultRecordCount;
    const fc = await fetchPage(baseUrl, batchParams);
    features.push(...(fc?.features || []));
  }

  const received = new Set();
  const unexpected = [];
  for (const feature of features) {
    const properties = feature?.properties || feature?.attributes || {};
    let oid = properties[objectIdFieldName];
    if (oid == null) {
      const actualKey = Object.keys(properties).find(
        (key) => key.toLowerCase() === objectIdFieldName.toLowerCase(),
      );
      if (actualKey) oid = properties[actualKey];
    }
    const key = oid == null ? '' : String(oid);
    if (!key || !expected.has(key) || received.has(key)) unexpected.push(key || '(missing)');
    else received.add(key);
  }
  const missing = ids.filter((id) => !received.has(String(id)));
  if (missing.length > 0 || unexpected.length > 0 || features.length !== ids.length) {
    const detail = [
      missing.length ? `${missing.length} missing` : '',
      unexpected.length ? `${unexpected.length} unexpected/duplicate` : '',
    ].filter(Boolean).join(', ');
    throw new Error(
      `${label} was incomplete (${features.length}/${ids.length} polygons; ${detail || 'count mismatch'}). `
      + 'Nothing was cached; retry the load.',
    );
  }

  return {
    type: 'FeatureCollection',
    features,
    _truncated: false,
    _expectedCount: ids.length,
  };
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
  // ArcGIS REST best-practice: when paginating via resultOffset/
  // resultRecordCount the service does NOT guarantee a stable row
  // order across requests unless orderByFields is specified. Without
  // it, two consecutive page fetches can return overlapping or missing
  // rows — which surfaces as silent dups (e.g. the same parcel label
  // rendered multiple times on the Roll Layer) or silent gaps. Caller-
  // supplied orderByFields wins so query-specific ordering still works.
  const pagedParams = params.orderByFields
    ? params
    : { ...params, orderByFields: 'OBJECTID ASC' };
  for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
    const remaining = cap - offset;
    const page = Math.min(PAGE_SIZE, remaining);
    const fc = await fetchPage(baseUrl, {
      ...pagedParams,
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
  //
  // Rate-limit handling: Esri's hosted FeatureServer caps requests at
  // 6000 request-units / minute. A heavy session (multi-muni Roll
  // Layer + Zoning + DevPlan + MASC + assessment-index warm-up + the
  // bulk sales-CSV query) can blow past that and the server returns
  // either HTTP 429 OR a 200 OK with {error:{code:429}} body. Without
  // explicit handling, the caller's silent try/catch (in
  // handleSalesUpload's per-muni fetch loop) turned a transient
  // rate-limit into "all records unmatched" with no signal to the
  // user. We now retry up to 3 times with exponential backoff,
  // honouring the Retry-After header when present.
  const usp = new URLSearchParams(params);
  const body = usp.toString();
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(`${baseUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        // Hard ceiling per attempt — without it a stalled upstream holds
        // the request open for the browser default (~2 min per attempt)
        // with no signal to the user. A timed-out attempt falls into the
        // catch below and retries like any other network error.
        signal: fetchTimeoutSignal(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      lastErr = timedOut
        ? new Error(`ArcGIS request timed out after ${FETCH_TIMEOUT_MS / 1000}s`)
        : e;
      // Network/timeout error — short backoff then retry.
      if (attempt < MAX_ATTEMPTS - 1) { await sleep(500 * (attempt + 1)); continue; }
      throw lastErr;
    }
    // 429 on the HTTP layer — back off then retry.
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
      // Honour Retry-After but cap it — a malformed or hostile header
      // shouldn't be able to park the UI for minutes between attempts.
      const waitMs = Number.isFinite(retryAfter)
        ? Math.min(Math.max(retryAfter, 0) * 1000, RETRY_AFTER_CAP_MS)
        : 2000 * (attempt + 1);
      lastErr = new Error(`ArcGIS rate-limited (429); retrying after ${waitMs}ms`);
      if (attempt < MAX_ATTEMPTS - 1) { await sleep(waitMs); continue; }
      throw new Error(`ArcGIS service is rate-limited (HTTP 429). Retried ${MAX_ATTEMPTS}× without success. Wait a minute and re-upload.`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ArcGIS ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    // ArcGIS REST sometimes returns 200 OK with an `error` body. Code
    // 429 here is the "request quota exceeded" form — same backoff.
    if (json && json.error) {
      if (json.error.code === 429) {
        const waitMs = 2000 * (attempt + 1);
        lastErr = new Error(`ArcGIS rate-limited (200/error 429); retrying after ${waitMs}ms`);
        if (attempt < MAX_ATTEMPTS - 1) { await sleep(waitMs); continue; }
        throw new Error(`ArcGIS service is rate-limited (quota exceeded). Retried ${MAX_ATTEMPTS}× without success. Wait a minute and re-upload.`);
      }
      throw new Error(`ArcGIS error ${json.error.code}: ${json.error.message}`);
    }
    return json;
  }
  // Unreachable in practice (every loop iteration either returns or
  // throws), but keeps the type checker / linter happy.
  throw lastErr || new Error('ArcGIS fetch failed after retries');
}

/** Tiny promise-based sleep helper for the retry/backoff path. */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Per-attempt fetch timeout (ms) for ArcGIS queries. */
const FETCH_TIMEOUT_MS = 60_000;
/** Ceiling on a server-supplied Retry-After wait (ms). */
const RETRY_AFTER_CAP_MS = 5_000;

// AbortSignal.timeout exists in every browser we target and in Node 18+;
// guard anyway so an exotic embedder just loses the timeout instead of
// crashing the whole query path.
function fetchTimeoutSignal(ms) {
  try { return AbortSignal.timeout(ms); } catch { return undefined; }
}

/**
 * Fetch every distinct value of a categorical column. Used for the muni
 * and category dropdowns. Results cached per browser tab — the list barely
 * changes between deployments and the request is small.
 */
async function fetchDistinctValues(baseUrl, field, cacheKey, where = null) {
  if (cacheKey) {
    const cached = await readCache(cacheKey);
    if (cached) return cached;
  }
  // Routed through fetchPage so these inherit its retry / backoff / timeout
  // handling. This used to be a bare fetch that threw on the FIRST non-200,
  // which made it the most fragile request in the app despite being one of
  // the most important: the municipality and zone-category dropdowns both
  // come through here, they fire at boot against two different provincial
  // services, and there is no cache to fall back on for a first-time
  // visitor. A single transient 429 or 502 was enough to leave the
  // municipality picker reading "Failed to load" for the whole session.
  const json = await fetchPage(baseUrl, {
    where: where || `${field} IS NOT NULL`,
    returnDistinctValues: 'true',
    outFields: field,
    returnGeometry: 'false',
    orderByFields: field,
    f: 'json',
  });
  const values = (json.features || [])
    .map((f) => f.attributes?.[field])
    .filter((v) => v != null && String(v).trim() !== '');
  if (cacheKey) await writeCache(cacheKey, values);
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
// readCache / writeCache moved to ./cache.js — they're now async,
// IDB-primary with a localStorage fallback. Every call site below
// already lives in an async function and awaits accordingly.

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

/**
 * Merge many GeoJSON polygon Features into ONE Esri polygon whose rings
 * are all the inputs' rings. Lets a single spatialRel query stand in for
 * N separate ones — the water-rights filters would otherwise fire one
 * request per licensed footprint (RM of Portage la Prairie alone has
 * hundreds of irrigation footprints, which took ~48 s end to end).
 *
 * Winding order is the catch, and it's why this can't just concatenate
 * what polygonToEsriGeometry produces. A single-polygon query tolerates
 * either direction, but Esri disambiguates a MULTI-ring polygon by
 * winding: clockwise rings are outer, counter-clockwise are holes. Merge
 * naively and some footprints silently become holes punched in their
 * neighbours. So every exterior ring is forced clockwise and every
 * interior ring counter-clockwise before merging.
 *
 * Verified against the live service: batching 20 irrigation footprints
 * returned exactly the OBJECTID set that the 20 individual queries
 * produced between them — no misses, no extras.
 */
function polygonsToEsriGeometry(features) {
  const rings = [];
  for (const feature of features) {
    const g = feature?.geometry;
    if (!g) continue;
    const polygons = g.type === 'Polygon' ? [g.coordinates]
      : g.type === 'MultiPolygon' ? g.coordinates
        : null;
    if (!polygons) continue;
    for (const poly of polygons) {
      poly.forEach((ring, i) => {
        if (!Array.isArray(ring) || ring.length < 4) return;
        const wantClockwise = i === 0;      // ring 0 is the exterior in GeoJSON
        rings.push(orientRing(ring, wantClockwise));
      });
    }
  }
  if (rings.length === 0) return null;
  return { rings, spatialReference: { wkid: 4326 } };
}

/** Return `ring` wound the requested way, reversing only when needed.
 *  Shoelace sign in lon/lat order: positive is counter-clockwise. */
function orientRing(ring, clockwise) {
  let twiceArea = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    twiceArea += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  const isClockwise = twiceArea < 0;
  return isClockwise === clockwise ? ring : [...ring].reverse();
}

function makeEmptyFc({ truncated = false } = {}) {
  return { type: 'FeatureCollection', features: [], _truncated: truncated };
}

/**
 * Parse a Roll # input that may be a single value or a list. Every
 * punctuation form people put between rolls separates them — see
 * ROLL_SEPARATORS. Trims each entry, drops empties and pure-junk values,
 * dedupes, returns an array preserving first-seen order. Empty array for
 * empty input.
 *
 * Exported so the bulk-search "missing rolls" diagnostic in main.js
 * can reuse the same parser the SQL clause builds against — keeps
 * the user-facing list of "not found" rolls aligned with what
 * actually got queried.
 */
export function parseRollList(input) {
  if (!input) return [];
  const out = [];
  const seen = new Set();
  for (const raw of String(input).split(ROLL_SEPARATORS)) {
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Roll entries are SEPARATED — "these are different properties" — by
 * whitespace, comma, semicolon, `&`, `+` or `|`. Comma is the preferred form
 * in tooltips; whitespace covers a column pasted straight out of a
 * spreadsheet; `&`, `+` and `|` cover the "Roll A & Roll B" and "83100+83200"
 * listing styles people type from memory or paste out of a multi-parcel row.
 * None appears in a valid roll number (\d+(\.\d{3})?), so every form is
 * unambiguous, and spacing never matters — "284950&373300" and
 * "284950 & 373300" parse identically.
 *
 * There is deliberately NO joiner. `+`, `&` and `|` briefly merged their
 * rolls into a single subject that shared one map badge and produced one
 * combined Parcel Snapshot; collapsing typed rolls into one number is never
 * the wanted behaviour, so each roll highlights as its own parcel — its own
 * badge, its own snapshot — whichever separator was typed between them.
 *
 * (The parcel-list import is a separate path: a row there can still carry
 * several parcels for one comp — see lib/parcelListParser.js — because that
 * grouping comes from the imported data, not from punctuation typed here.)
 */
const ROLL_SEPARATORS = /[\s,;&+|]+/;

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
/**
 * Parse the assessor-supplied Frontage_or_Area string. ROLL_ENTRY
 * stores this as either a frontage measurement (e.g. "120.5 Feet")
 * or an area (e.g. "5.000 Acres"). When it's already an area in
 * acres we use that directly — it's the assessor's official value
 * and trumps a geometry-derived calculation. When it's a frontage
 * measurement we can't reverse-derive area, so callers fall back
 * to turf area on the polygon.
 *
 * Returns the acreage as a finite number when the input is in
 * acres or hectares, otherwise null. Unrecognised units / malformed
 * strings / null/empty all return null.
 */
export function acresFromFrontageField(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(acres?|ac|hectares?|ha)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('ac')) return n;
  if (unit.startsWith('ha')) return n * 2.471053814671653;  // hectares → acres
  return null;
}

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

// ---------- Test-only exports ----------
// Internal query-builder helpers exposed for unit tests
// (web/test/whereClause.test.js). Not part of the public API surface —
// app code should keep calling searchParcels() and friends.
export const _internals = {
  escapeSql,
  buildParcelClauses,
  canonicalRollList,
  rollKeyWhereClause,
  chunkRollKeys,
  overlayCacheKey,
  polygonsToEsriGeometry,
  orientRing,
  intersectSets,
  ZONING_URL,
  DEVPLAN_URL,
};
