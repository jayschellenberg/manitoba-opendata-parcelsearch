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

// Mapbox API caps. The Matrix v1 limit for driving is 25×25; if you
// upgrade to a paid plan with the v2 endpoint you can go higher — the
// code below chunks regardless so a higher cap is purely a win.
const MATRIX_CHUNK = 25;
const DIRECTIONS_CHUNK = 25;

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
 * distances (metres). Splits into per-destination-block calls when
 * N > MATRIX_CHUNK so we stay within Mapbox's 25×25 per-request cap.
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

  // Build empty NxN matrices we'll fill column-block by column-block.
  const duration = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  const distance = Array.from({ length: n }, () => new Array(n).fill(Infinity));
  for (let i = 0; i < n; i++) { duration[i][i] = 0; distance[i][i] = 0; }

  // For N ≤ 25 we can fetch the whole matrix in one call. For larger
  // N we hold sources = full list and rotate the destinations block
  // through ceil(N / chunk) sub-calls. Mapbox bills sources × dests,
  // so this is the minimum-cost shape — N calls of 25xN would cost
  // many times more.
  for (let dStart = 0; dStart < n; dStart += MATRIX_CHUNK) {
    const dEnd = Math.min(dStart + MATRIX_CHUNK, n);
    // Sources also have to obey the cap. For now we send all sources
    // when N ≤ 25; otherwise we make a square of chunked sources too.
    for (let sStart = 0; sStart < n; sStart += MATRIX_CHUNK) {
      const sEnd = Math.min(sStart + MATRIX_CHUNK, n);
      const blockIndices = [];
      const srcRange = range(sStart, sEnd);
      const dstRange = range(dStart, dEnd);
      // Mapbox needs all coordinates in one path; sources/destinations
      // are positional indexes INTO that coordinate list. We
      // concatenate the source range and the destination range,
      // dedupe overlaps so the coords list stays minimal.
      const seen = new Map();
      const coordList = [];
      for (const idx of [...srcRange, ...dstRange]) {
        if (seen.has(idx)) continue;
        seen.set(idx, coordList.length);
        coordList.push(points[idx]);
        blockIndices.push(idx);
      }
      const sources      = srcRange.map((idx) => seen.get(idx)).join(';');
      const destinations = dstRange.map((idx) => seen.get(idx)).join(';');
      const coords = coordList.map((p) => `${p.lng},${p.lat}`).join(';');
      const url = `${MAPBOX_ROOT}/directions-matrix/v1/mapbox/${MATRIX_PROFILE}/${coords}` +
                  `?annotations=duration,distance` +
                  `&sources=${sources}&destinations=${destinations}` +
                  `&access_token=${TOKEN}`;
      const data = await fetchJson(url);
      // Mapbox shape: { durations: rowsxcols, distances: rowsxcols, ... }
      const dur = data?.durations || [];
      const dis = data?.distances || [];
      srcRange.forEach((srcIdx, r) => {
        dstRange.forEach((dstIdx, c) => {
          if (dur[r] && dur[r][c] != null) duration[srcIdx][dstIdx] = dur[r][c];
          if (dis[r] && dis[r][c] != null) distance[srcIdx][dstIdx] = dis[r][c];
        });
      });
    }
  }
  return { duration, distance };
}

// -----------------------------------------------------------------
// Directions API — driving polyline through an ordered waypoint list.
// -----------------------------------------------------------------

/**
 * Fetch the driving route through the given ordered waypoints.
 * Splits into overlapping ≤25-point segments and concatenates the
 * geometry when the list is longer.
 *
 * Returns the geometry both as a GeoJSON LineString (consumed by
 * setRouteData on the map) AND as an encoded polyline string (used
 * by the Static Images URL — far shorter than a GeoJSON literal, so
 * the URL stays under Mapbox's ~8 KB cap even on a 50-stop route).
 *
 * @param {Array<{lng:number,lat:number}>} orderedPoints
 * @returns {Promise<{
 *   geometry: { type:'LineString', coordinates: [lng,lat][] },
 *   polyline: string,
 *   distanceMeters: number,
 *   durationSeconds: number,
 * }>}
 */
export async function fetchDrivingRoute(orderedPoints) {
  requireToken();
  if (orderedPoints.length < 2) {
    return { geometry: { type: 'LineString', coordinates: [] }, polyline: '', distanceMeters: 0, durationSeconds: 0 };
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
      // duplicates the last coord of the prior segment (the overlap
      // waypoint we asked for).
      combinedCoords = combinedCoords.concat(segCoords.slice(1));
    }
    totalDist += route.distance || 0;
    totalDur  += route.duration || 0;
  }
  return {
    geometry: { type: 'LineString', coordinates: combinedCoords },
    polyline: encodePolyline(combinedCoords),
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

function range(a, b) {
  const out = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}
