// Vercel Edge Function — same-origin pass-through to Google's Geocoding and
// Routes APIs for the Route Optimizer page (web/route.html).
//
// Why a proxy at all: Google's web-service endpoints don't send CORS
// headers, so the browser can't call them directly. This function forwards
// exactly three operations and nothing else:
//
//   POST /api/route-google  {op: 'geocode', key, address, region}
//   POST /api/route-google  {op: 'matrix',  key, body}   -> computeRouteMatrix
//   POST /api/route-google  {op: 'routes',  key, body}   -> computeRoutes
//
// The key is the USER's own Google key, typed into the page and sent with
// each request. It is never stored or logged here, and there is deliberately
// no server-side fallback key: the site is public, and a key held here would
// let anyone run up the bill.

export const config = {
  runtime: 'edge',
};

const GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';
const MATRIX = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const MATRIX_FIELDS = 'originIndex,destinationIndex,duration,distanceMeters,condition';
const ROUTES_FIELDS = 'routes.polyline.encodedPolyline';
const MAX_BODY = 200_000; // bytes; a 50-stop request is ~10 kB

function reply(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default async function handler(request) {
  if (request.method !== 'POST') return reply(405, { error: 'POST only' });
  const text = await request.text();
  if (text.length > MAX_BODY) return reply(413, { error: 'Request too large' });
  let req;
  try { req = JSON.parse(text); } catch { return reply(400, { error: 'Bad JSON' }); }
  const key = typeof req.key === 'string' ? req.key.trim() : '';
  if (!key || key.length > 200) return reply(400, { error: 'Missing Google API key' });

  let upstream;
  try {
    if (req.op === 'geocode') {
      if (typeof req.address !== 'string' || !req.address.trim()) return reply(400, { error: 'Missing address' });
      const u = new URL(GEOCODE);
      u.searchParams.set('address', req.address.slice(0, 500));
      if (typeof req.region === 'string' && /^[a-z]{2}$/i.test(req.region)) u.searchParams.set('region', req.region);
      u.searchParams.set('key', key);
      upstream = await fetch(u);
    } else if (req.op === 'matrix' || req.op === 'routes') {
      if (!req.body || typeof req.body !== 'object') return reply(400, { error: 'Missing body' });
      upstream = await fetch(req.op === 'matrix' ? MATRIX : ROUTES, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': req.op === 'matrix' ? MATRIX_FIELDS : ROUTES_FIELDS,
        },
        body: JSON.stringify(req.body),
      });
    } else {
      return reply(400, { error: 'Unknown op' });
    }
  } catch (err) {
    return reply(502, { error: `Google request failed: ${err.message}` });
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
