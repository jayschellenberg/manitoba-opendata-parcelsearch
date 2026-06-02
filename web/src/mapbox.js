/*
 * Mapbox API client. Three endpoints used by the route planner:
 *
 *   Matrix     — driving-time and driving-distance matrices between N stops.
 *                Capped at 25 sources × 25 destinations per call, so we
 *                chunk by destination block and stitch the result.
 *
 *   Directions — driving polyline through an ordered list of waypoints.
 *                Capped at 25 waypoints/call, so we split long routes
 *                into overlapping segments and concatenate the geometry.
 *
 *   Static     — PNG of the optimised route with numbered pins. Used for
 *                the print-itinerary image; we hit it as a plain <img> URL
 *                so no fetch is needed.
 *
 * The token is read once at module load from Vite's import.meta.env.
 * In node tests (no Vite), the import fails silently and `hasToken()`
 * reports false; the route panel guards on that to disable itself.
 */

const TOKEN = readToken();
const MAPBOX_ROOT = 'https://api.mapbox.com';
const MATRIX_PROFILE = 'driving';
const DIRECTIONS_PROFILE = 'driving';

// Mapbox API caps.
// Matrix v1 driving: 25 TOTAL coordinates per call (not 25×25). Past
// that we throw MatrixTooManyCoordsError; main.js catches it and
// falls through to the haversine fallback for the TSP ordering, then
// still hits Directions API on the solved order to get a real km /
// drive-time / polyline. In Manitoba's mostly-grid road network the
// haversine ordering is within a few percent of road-optimal.
export const MATRIX_MAX_COORDS = 25;
const DIRECTIONS_CHUNK = 25;

export class MatrixTooManyCoordsError extends Error {
  constructor(count) {
    super(`Mapbox Matrix v1 driving profile caps at ${MATRIX_MAX_COORDS} coordinates per call (got ${count}).`);
    this.name = 'MatrixTooManyCoordsError';
    this.count = count;
    this.cap = MATRIX_MAX_COORDS;
  }
}

function readToken() {
  try {
    return import.meta.env?.VITE_MAPBOX_TOKEN || '';
  } catch {
    return '';
  }
}

/** True iff a Mapbox token was configured at build time. */
export function hasToken() { return !!TOKEN && TOKEN.length > 0 && !TOKEN.startsWith('pk.eyJ1...replace-me'); }

/** Throw a helpful error when the caller tries to use Mapbox APIs
 *  without a token. The UI guards before reaching this; the throw is
 *  the safety net for programmer errors. */
function requireToken() {
  if (!hasToken()) {
    throw new Error('Mapbox token missing. Set VITE_MAPBOX_TOKEN in web/.env.local (see .env.example).');
  }
}

// -----------------------------------------------------------------
// Matrix API — N×N distance + duration between an array of points.
// -----------------------------------------------------------------

/**
 * Fetch a full N×N driving matrix of durations (seconds) and
 * distances (metres) in a single Matrix API call.
 *
 * Throws MatrixTooManyCoordsError when N > MATRIX_MAX_COORDS so the
 * caller can fall back to haversine ordering (see main.js's
 * handleCalculateRoute). Chunking across multiple Matrix calls would
 * either miss cross-chunk pairs or burn the free-tier quota — neither
 * is acceptable, so the fallback is the right shape.
 *
 * @param {Array<{lng:number,lat:number}>} points
 * @returns {Promise<{ duration: number[][], distance: number[][] }>}
 *   Both matrices are NxN with zeros on the diagonal. Infinity marks
 *   any pair Mapbox failed to route (rare; usually a coord on the
 *   wrong side of a river / off-road).
 */
export async function fetchDrivingMatrix(points) {
  requireToken();
  const n = points.length;
  if (n === 0) return { duration: [], distance: [] };
  if (n === 1) return { duration: [[0]], distance: [[0]] };
  if (n > MATRIX_MAX_COORDS) throw new MatrixTooManyCoordsError(n);

  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${MAPBOX_ROOT}/directions-matrix/v1/mapbox/${MATRIX_PROFILE}/${coords}` +
              `?annotations=duration,distance&access_token=${TOKEN}`;
  const data = await fetchJson(url);
  const dur = data?.durations || [];
  const dis = data?.distances || [];

  // Initialize NxN with Infinity (unreachable) on off-diagonals,
  // zeros on the diagonal. Then copy whatever Mapbox returned.
  const duration = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  const distance = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) {
    duration[i][i] = 0;
    distance[i][i] = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (dur[i] && dur[i][j] != null) duration[i][j] = dur[i][j];
      if (dis[i] && dis[i][j] != null) distance[i][j] = dis[i][j];
    }
  }
  return { duration, distance };
}

/**
 * Cluster-aware variant for lists too big to fit in one Matrix call
 * (N > MATRIX_MAX_COORDS). The caller groups points into clusters
 * (typically by muni); we fetch real driving costs for every pair
 * within a cluster, and fall back to haversine (great-circle ×
 * average rural speed) for cross-cluster pairs.
 *
 * Justification: clusters separated by tens of km (here: by muni)
 * link via highways where great-circle distance is within ~10–15 %
 * of real road distance. Within-cluster pairs are where the road
 * grid matters — that's exactly where we spend real Matrix calls.
 *
 * Chunking inside a large cluster: split into 12-point sub-chunks
 * so any pair of sub-chunks (12 + 12 = 24 coords) fits in a single
 * Matrix call. For each ordered (chunk_a, chunk_b) pair we issue
 * one call that fills the rectangular submatrix.
 *
 * @param {Object} args
 * @param {Array<{lng,lat}>} args.points
 * @param {Array<number|string>} args.clusterIds - same length as
 *   points; identifies which cluster each point belongs to. The
 *   start point usually inherits the nearest cluster's id.
 * @param {number} [args.kmhFallback=75] - average road speed used
 *   to derive haversine durations for cross-cluster pairs.
 * @returns {Promise<{
 *   duration: number[][],
 *   distance: number[][],
 *   realCalls: number,
 *   crossClusterCount: number,
 *   anyCallFailed: boolean,
 * }>}
 */
export async function fetchDrivingMatrixClustered({ points, clusterIds, kmhFallback = 75 }) {
  requireToken();
  const n = points.length;
  if (n === 0) return { duration: [], distance: [], realCalls: 0, crossClusterCount: 0, anyCallFailed: false };
  if (n === 1) return { duration: [[0]], distance: [[0]], realCalls: 0, crossClusterCount: 0, anyCallFailed: false };

  // 1. Seed both matrices with haversine values. Anything we don't
  //    fetch real data for stays at this estimate.
  const distance = Array.from({ length: n }, () => new Array(n).fill(0));
  const duration = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const km = haversineKmInternal(points[i], points[j]);
      distance[i][j] = km * 1000;
      duration[i][j] = km / kmhFallback * 3600;
    }
  }

  // 2. Group indices by cluster id, then for each cluster fetch the
  //    within-cluster submatrix. Sub-chunk into 12-point pieces so
  //    every Matrix call stays under the 25-coord cap.
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const c = clusterIds[i];
    if (!clusters.has(c)) clusters.set(c, []);
    clusters.get(c).push(i);
  }

  // Track per-cluster cross-cluster pair count so the caller can
  // report how much of the matrix is real vs haversine.
  let crossClusterCount = 0;
  let realCalls = 0;
  let anyCallFailed = false;

  const tasks = [];
  for (const [, indices] of clusters) {
    if (indices.length < 2) continue;
    const SUB_CHUNK = Math.min(12, indices.length);
    const subChunks = [];
    for (let i = 0; i < indices.length; i += SUB_CHUNK) {
      subChunks.push(indices.slice(i, i + SUB_CHUNK));
    }
    for (let a = 0; a < subChunks.length; a++) {
      for (let b = 0; b < subChunks.length; b++) {
        tasks.push(
          fillSubmatrixCall(subChunks[a], subChunks[b], points, duration, distance)
            .then(() => { realCalls++; })
            .catch((err) => {
              console.warn('Matrix sub-call failed, falling back to haversine for this submatrix:', err.message || err);
              anyCallFailed = true;
            })
        );
      }
    }
  }
  // Cross-cluster pair count (for the summary message).
  const clusterSizes = [...clusters.values()].map((arr) => arr.length);
  for (let i = 0; i < clusterSizes.length; i++) {
    for (let j = i + 1; j < clusterSizes.length; j++) {
      crossClusterCount += clusterSizes[i] * clusterSizes[j] * 2; // both directions
    }
  }

  await Promise.all(tasks);
  return { duration, distance, realCalls, crossClusterCount, anyCallFailed };
}

/**
 * Fetch ONE rectangular submatrix: srcIndices × dstIndices, both
 * referencing positions in the global `points` array. Stamps the
 * results into the shared duration/distance matrices in place.
 */
async function fillSubmatrixCall(srcIndices, dstIndices, points, durationMat, distanceMat) {
  // Build the coord list as the union of sources and destinations.
  const positionOf = new Map();
  const coordList = [];
  for (const idx of srcIndices) {
    if (positionOf.has(idx)) continue;
    positionOf.set(idx, coordList.length);
    coordList.push(points[idx]);
  }
  for (const idx of dstIndices) {
    if (positionOf.has(idx)) continue;
    positionOf.set(idx, coordList.length);
    coordList.push(points[idx]);
  }
  if (coordList.length > MATRIX_MAX_COORDS) {
    // Shouldn't happen — caller chunked too aggressively. Defensive
    // throw so the bug surfaces immediately.
    throw new Error(`Submatrix coord count ${coordList.length} exceeds ${MATRIX_MAX_COORDS}`);
  }
  const sources = srcIndices.map((idx) => positionOf.get(idx)).join(';');
  const destinations = dstIndices.map((idx) => positionOf.get(idx)).join(';');
  const coords = coordList.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${MAPBOX_ROOT}/directions-matrix/v1/mapbox/${MATRIX_PROFILE}/${coords}` +
              `?annotations=duration,distance&sources=${sources}&destinations=${destinations}` +
              `&access_token=${TOKEN}`;
  const data = await fetchJson(url);
  const dur = data?.durations || [];
  const dis = data?.distances || [];
  srcIndices.forEach((srcIdx, r) => {
    dstIndices.forEach((dstIdx, c) => {
      if (dur[r] && dur[r][c] != null) durationMat[srcIdx][dstIdx] = dur[r][c];
      if (dis[r] && dis[r][c] != null) distanceMat[srcIdx][dstIdx] = dis[r][c];
    });
  });
}

/** Inline haversine so this module stays free of routeSolver imports. */
function haversineKmInternal(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// -----------------------------------------------------------------
// Directions API — driving polyline through an ordered waypoint list.
// -----------------------------------------------------------------

/**
 * Fetch the driving route through the given ordered waypoints.
 * Splits into overlapping ≤25-point segments and concatenates the
 * geometry when the list is longer.
 *
 * Returns:
 *   geometry  – GeoJSON LineString for setRouteData on the map
 *   polyline  – Google-encoded polyline for static-image URLs
 *   legs      – per-waypoint-pair { distanceMeters, durationSeconds }
 *               array. Length === orderedPoints.length - 1. Lets the
 *               result panel show real road km/time per leg so the
 *               cumulative sum matches the API-reported total.
 *   distanceMeters / durationSeconds – API-reported totals
 *
 * @param {Array<{lng:number,lat:number}>} orderedPoints
 * @returns {Promise<{
 *   geometry: { type:'LineString', coordinates: [lng,lat][] },
 *   polyline: string,
 *   legs: Array<{ distanceMeters: number, durationSeconds: number }>,
 *   distanceMeters: number,
 *   durationSeconds: number,
 * }>}
 */
export async function fetchDrivingRoute(orderedPoints) {
  requireToken();
  if (orderedPoints.length < 2) {
    return {
      geometry: { type: 'LineString', coordinates: [] },
      polyline: '',
      legs: [],
      distanceMeters: 0,
      durationSeconds: 0,
    };
  }

  const segments = [];
  let cursor = 0;
  while (cursor < orderedPoints.length - 1) {
    const end = Math.min(cursor + DIRECTIONS_CHUNK, orderedPoints.length);
    segments.push(orderedPoints.slice(cursor, end));
    // Overlap by one so the next segment starts where this one
    // ended — keeps the polyline contiguous.
    cursor = end - 1;
  }

  let combinedCoords = [];
  const legs = [];
  let totalDist = 0;
  let totalDur = 0;
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const coords = seg.map((p) => `${p.lng},${p.lat}`).join(';');
    const url = `${MAPBOX_ROOT}/directions/v5/mapbox/${DIRECTIONS_PROFILE}/${coords}` +
                `?geometries=geojson&overview=full&access_token=${TOKEN}`;
    const data = await fetchJson(url);
    const route = data?.routes?.[0];
    if (!route) continue;
    const segCoords = route.geometry?.coordinates || [];
    if (s === 0) {
      combinedCoords = combinedCoords.concat(segCoords);
    } else {
      // Skip the first coordinate of subsequent segments — it
      // duplicates the last coord of the prior segment.
      combinedCoords = combinedCoords.concat(segCoords.slice(1));
    }
    // Each Directions response carries a `legs` array — one entry
    // per consecutive waypoint pair in this segment. Concatenating
    // these across segments rebuilds a per-leg array aligned to the
    // original orderedPoints.
    for (const leg of route.legs || []) {
      legs.push({
        distanceMeters: leg.distance || 0,
        durationSeconds: leg.duration || 0,
      });
    }
    totalDist += route.distance || 0;
    totalDur  += route.duration || 0;
  }
  return {
    geometry: { type: 'LineString', coordinates: combinedCoords },
    polyline: encodePolyline(combinedCoords),
    legs,
    distanceMeters: totalDist,
    durationSeconds: totalDur,
  };
}

/**
 * Encode a [lng, lat] coordinate array into Google's polyline format
 * (precision 5). Used to keep the Static Images URL compact — a 200-
 * point GeoJSON literal can blow past the 8 KB URL cap, but the
 * equivalent polyline string is ~1 KB.
 *
 * Spec: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function encodePolyline(coords) {
  let prevLat = 0;
  let prevLng = 0;
  let out = '';
  for (const [lng, lat] of coords) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += encodeVarint(iLat - prevLat);
    out += encodeVarint(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}

function encodeVarint(v) {
  // Two's-complement-style: left-shift by 1; if negative, invert.
  let x = v < 0 ? ~(v << 1) : (v << 1);
  let s = '';
  while (x >= 0x20) {
    s += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
    x >>>= 5;
  }
  s += String.fromCharCode(x + 63);
  return s;
}

// -----------------------------------------------------------------
// Static Images API — PNG with numbered pins for the print itinerary.
// -----------------------------------------------------------------

/**
 * Build a Static Images API URL for the print itinerary. Each stop
 * gets a numbered pin (1..99); the route line is overlaid as an
 * encoded polyline (`path-{width}+{color}-{opacity}({polyline})`),
 * which keeps the URL well under Mapbox's 8 KB limit.
 *
 * @param {Object} opts
 * @param {{lng:number,lat:number}}        opts.start    — start point (S pin / green).
 * @param {Array<{lng:number,lat:number}>} opts.stops    — ordered stops AFTER start
 *                                                          (each gets pin 1..N).
 * @param {string}                         opts.polyline — Google polyline-encoded
 *                                                          route geometry (precision 5).
 *                                                          Empty string = no line.
 * @param {number} [opts.width=900]                       PNG width in px (max 1280).
 * @param {number} [opts.height=600]                      PNG height in px (max 1280).
 * @param {boolean} [opts.retina=true]                    `@2x` suffix for sharper print.
 * @returns {string} URL ready to drop into an <img src> attribute.
 */
export function staticRouteImageUrl({ start, stops, polyline, width = 900, height = 600, retina = true }) {
  requireToken();
  const overlays = [];
  // Path overlay first so pins land on top. The polyline already
  // encodes precision-5 deltas, so URL-encoding it is essentially
  // its own length — well within the 8 KB cap even for 100 stops.
  if (polyline) {
    overlays.push(`path-4+1d4ed8-0.85(${encodeURIComponent(polyline)})`);
  }
  // Start gets a green S-labelled pin (S for Start).
  if (start && Number.isFinite(start.lng) && Number.isFinite(start.lat)) {
    overlays.push(`pin-l-s+16a34a(${start.lng},${start.lat})`);
  }
  // Numbered stops, 1..99. Past 99, Mapbox falls back to dot
  // markers without numbers — accepted limit (you confirmed
  // 100 stops is plenty for this workflow).
  stops.forEach((p, i) => {
    const label = Math.min(99, i + 1);
    overlays.push(`pin-l-${label}+2563eb(${p.lng},${p.lat})`);
  });
  const overlayPath = overlays.join(',');
  const sizeSuffix = retina ? `@2x` : '';
  // 'auto' lets Mapbox fit the bounds to whatever overlays land.
  return `${MAPBOX_ROOT}/styles/v1/mapbox/streets-v12/static/${overlayPath}/auto/${width}x${height}${sizeSuffix}?access_token=${TOKEN}`;
}

// -----------------------------------------------------------------
// internals
// -----------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch {}
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Mapbox auth failed (${res.status}). Check VITE_MAPBOX_TOKEN.`);
    }
    if (res.status === 422) {
      throw new Error(`Mapbox refused the request (422). Check that the coordinates are valid and within limits. Details: ${body}`);
    }
    if (res.status === 429) {
      throw new Error(`Mapbox rate-limit hit (429). Wait a moment and retry. ${body}`);
    }
    throw new Error(`Mapbox request failed: ${res.status} ${res.statusText}. ${body}`);
  }
  return res.json();
}

