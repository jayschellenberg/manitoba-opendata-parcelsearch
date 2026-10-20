/*
 * Geocoding, drive-time matrix and route geometry for the Route Optimizer.
 *
 * OSM:    Nominatim (1 request/second usage policy) + the public OSRM demo
 *         server, both called straight from the browser (both send CORS
 *         headers).
 * Google: Geocoding API + Routes API (computeRouteMatrix / computeRoutes).
 *         Google's web services don't answer browser (CORS) requests, so
 *         these go through the same-origin edge function api/route-google.js,
 *         which forwards them unchanged. The key is the USER's, typed into
 *         the page and sent with each request; the server never stores it.
 *
 * Every host fetched here must be in vercel.json's connect-src
 * (test/csp.test.js checks the *_URL constants below).
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OSRM_URL = 'https://router.project-osrm.org';
const GOOGLE_PROXY = '/api/route-google';

export class ProviderError extends Error {}

let lastNominatim = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- geocoding

/** {lat, lon, matched, quality} or null when nothing matched. */
export async function geocode(provider, query, { country = '', key = '' } = {}) {
  return provider === 'google' ? geocodeGoogle(query, country, key) : geocodeOsm(query, country);
}

async function geocodeOsm(query, country) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  const u = new URL(NOMINATIM_URL);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '1');
  if (country) u.searchParams.set('countrycodes', country);
  let r;
  try {
    r = await fetch(u);
  } finally {
    lastNominatim = Date.now();
  }
  if (!r.ok) throw new ProviderError(`OpenStreetMap geocoding failed (HTTP ${r.status}). Try again in a minute.`);
  const data = await r.json();
  if (!data.length) return null;
  const d = data[0];
  return { lat: Number(d.lat), lon: Number(d.lon), matched: d.display_name || '', quality: d.addresstype || d.type || '' };
}

async function google(op, key, payload) {
  let r;
  try {
    r = await fetch(GOOGLE_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, key, ...payload }),
    });
  } catch (err) {
    throw new ProviderError(`Couldn't reach Google: ${err.message}`);
  }
  let data;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) {
    const err = Array.isArray(data) ? data[0]?.error : data?.error;
    throw new ProviderError(`Google: ${err?.message || err || `HTTP ${r.status}`}`);
  }
  return data;
}

async function geocodeGoogle(query, country, key) {
  const data = await google('geocode', key, { address: query, region: country });
  if (data.status === 'ZERO_RESULTS') return null;
  if (data.status !== 'OK') {
    throw new ProviderError(`Google Geocoding: ${data.status} ${data.error_message || ''}`.trim());
  }
  const res = data.results[0];
  let quality = res.geometry.location_type || '';
  if (res.partial_match) quality += ' (partial match)';
  return { lat: res.geometry.location.lat, lon: res.geometry.location.lng, matched: res.formatted_address, quality };
}

// ---------------------------------------------------------------- matrix

/** Driving {durations (s), distances (m)} between every pair of [lat, lon]
 *  points. Unroutable pairs are null. */
export async function matrix(provider, points, { key = '' } = {}) {
  return provider === 'google' ? matrixGoogle(points, key) : matrixOsrm(points);
}

const osrmCoords = (points) => points.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');

async function matrixOsrm(points) {
  let data;
  try {
    const r = await fetch(`${OSRM_URL}/table/v1/driving/${osrmCoords(points)}?annotations=duration,distance`);
    data = await r.json();
  } catch (err) {
    throw new ProviderError(`OpenStreetMap drive times failed: ${err.message}. Try again in a minute.`);
  }
  if (data.code !== 'Ok') throw new ProviderError(`OpenStreetMap drive times failed: ${data.message || data.code}`);
  return { durations: data.durations, distances: data.distances };
}

const latLng = ([lat, lon]) => ({ location: { latLng: { latitude: lat, longitude: lon } } });

async function matrixGoogle(points, key) {
  const n = points.length;
  const durations = Array.from({ length: n }, () => new Array(n).fill(null));
  const distances = Array.from({ length: n }, () => new Array(n).fill(null));
  const B = 25; // 25 x 25 = 625 elements, the per-request maximum
  for (let oi = 0; oi < n; oi += B) {
    for (let di = 0; di < n; di += B) {
      const els = await google('matrix', key, {
        body: {
          origins: points.slice(oi, oi + B).map((p) => ({ waypoint: latLng(p) })),
          destinations: points.slice(di, di + B).map((p) => ({ waypoint: latLng(p) })),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
        },
      });
      for (const el of els) {
        // proto3 JSON omits zero values, so a missing index means 0
        const i = oi + (el.originIndex || 0);
        const j = di + (el.destinationIndex || 0);
        if (el.condition === 'ROUTE_EXISTS') {
          durations[i][j] = parseFloat(String(el.duration || '0s'));
          distances[i][j] = Number(el.distanceMeters || 0);
        }
      }
    }
  }
  for (let i = 0; i < n; i++) { durations[i][i] = 0; distances[i][i] = 0; }
  return { durations, distances };
}

// ---------------------------------------------------------------- geometry

/** Road-following line [[lat, lon], ...] through the ordered points, or
 *  null (the caller then draws straight lines). */
export async function routeGeometry(provider, points, { key = '' } = {}) {
  try {
    return provider === 'google' ? await geometryGoogle(points, key) : await geometryOsrm(points);
  } catch {
    return null;
  }
}

async function geometryOsrm(points) {
  const r = await fetch(`${OSRM_URL}/route/v1/driving/${osrmCoords(points)}?overview=full&geometries=geojson`);
  const data = await r.json();
  if (data.code !== 'Ok') return null;
  return data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
}

async function geometryGoogle(points, key) {
  const line = [];
  const step = 26; // origin + 25 intermediates + destination per request
  for (let s = 0; s < points.length - 1; s += step) {
    const chunk = points.slice(s, s + step + 1);
    const data = await google('routes', key, {
      body: {
        origin: latLng(chunk[0]),
        destination: latLng(chunk[chunk.length - 1]),
        intermediates: chunk.slice(1, -1).map(latLng),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
      },
    });
    line.push(...decodePolyline(data.routes[0].polyline.encodedPolyline));
  }
  return line;
}

/** Google encoded polyline -> [[lat, lon], ...]. */
export function decodePolyline(s) {
  const out = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < s.length) {
    const vals = [];
    for (let k = 0; k < 2; k++) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        b = s.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      vals.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    lat += vals[0];
    lon += vals[1];
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}
