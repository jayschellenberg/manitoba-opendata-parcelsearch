// Tests for the Route Optimizer page (route.html, src/route/): the stop-order
// solver against brute force, stop parsing (Excel paste with and without a
// header, typed lines, CSV), address cleanup, the geocode-quality checks,
// marker fan-out on the print map, Google Maps link chunking, and the
// Google pass-through edge function.
//
// Run: cd web && node test/routeOptimizer.test.js

import assert from 'node:assert/strict';
import { solve, pathCost, EXACT_MAX, heldKarp } from '../src/route/optimize.js';
import {
  parseStops, parseCoords, cleanAddress, streetMismatch, isApproximate, csvRows, parseTable,
} from '../src/route/parse.js';
import { spreadMarkers } from '../src/route/markerSpread.js';
import { mapsLinks, fmtDur, routeCsv } from '../src/route/sheet.js';
import { decodePolyline } from '../src/route/providers.js';
import handler from '../../api/route-google.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------- solver

function rand(seed) {
  let a = seed;
  return () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; };
}
function randomMatrix(n, r) {
  const pts = Array.from({ length: n }, () => [r(), r()]);
  // asymmetric: each direction gets its own 0-30% detour
  return pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) * (1 + 0.3 * r())));
}
function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

await test('exact for small routes in all three finish modes (vs brute force)', () => {
  const r = rand(7);
  for (let trial = 0; trial < 40; trial++) {
    const n = 3 + Math.floor(r() * 5); // 3..7 stops
    const C = randomMatrix(n + 2, r);
    const nodes = Array.from({ length: n }, (_, i) => i + 1);
    for (const end of [0, n + 1, null]) {
      const order = solve(C, 0, nodes, end);
      assert.deepEqual([...order].sort((a, b) => a - b), nodes);
      const cost = (o) => pathCost([0, ...o, ...(end === null ? [] : [end])], C);
      const best = Math.min(...permutations(nodes).map(cost));
      assert.ok(cost(order) <= best + 1e-9, `trial ${trial} end=${end}: ${cost(order)} > ${best}`);
    }
  }
});

await test('heuristic above the exact limit matches the exact answer at 13-14 stops', () => {
  const r = rand(11);
  for (let trial = 0; trial < 4; trial++) {
    const n = EXACT_MAX + 1 + (trial % 2);
    const C = randomMatrix(n + 1, r);
    const nodes = Array.from({ length: n }, (_, i) => i + 1);
    const heur = solve(C, 0, nodes, 0, { timeLimitMs: 1500 });
    const exact = heldKarp(C, 0, nodes, 0);
    assert.deepEqual([...heur].sort((a, b) => a - b), nodes);
    assert.ok(pathCost([0, ...heur, 0], C) <= pathCost([0, ...exact, 0], C) + 1e-9, `trial ${trial}`);
  }
});

await test('50 stops solve within the time limit and visit every stop once', () => {
  const C = randomMatrix(52, rand(3));
  const nodes = Array.from({ length: 50 }, (_, i) => i + 1);
  const t = Date.now();
  const order = solve(C, 0, nodes, null, { timeLimitMs: 1500 });
  assert.ok(Date.now() - t < 4000);
  assert.deepEqual([...order].sort((a, b) => a - b), nodes);
});

// ---------------------------------------------------------------- parsing

const ROWS = [
  'Address\tCity\tState\tNotes',
  '215 & 223 Cree Rd\tThompson\tMB\tTwo apartments (have 2014)',
  '52-56 Waterloo Ave\tThompson\tMB\tApartments',
  '32-48 Seal/88 Severen\tThompson\tMB\tTwo shops',
].join('\n');

await test('Excel paste with a header row reads columns by name', () => {
  const s = parseStops(ROWS);
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], { label: '', query: '215 & 223 Cree Rd, Thompson, MB', notes: 'Two apartments (have 2014)' });
});

await test('the same rows without a header give the same stops', () => {
  const withHeader = parseStops(ROWS);
  const without = parseStops(ROWS.split('\n').slice(1).join('\n'));
  assert.deepEqual(without, withHeader);
});

await test('headerless row without a province: address + city, rest is notes', () => {
  assert.deepEqual(parseStops('Waterloo Ave\tThompson\tApartments'),
    [{ label: '', query: 'Waterloo Ave, Thompson', notes: 'Apartments' }]);
});

await test('typed lines, labels and coordinates', () => {
  assert.deepEqual(parseStops('123 Main St, Steinbach\nSmith farm | 49.54, -96.68\n# comment\n49.9, -97.1'), [
    { label: '', query: '123 Main St, Steinbach', notes: '' },
    { label: 'Smith farm', query: '49.54, -96.68', notes: '' },
    { label: '', query: '49.9, -97.1', notes: '' },
  ]);
});

await test('coordinates: lat-first, lon-first swap, rejects nonsense', () => {
  assert.deepEqual(parseCoords('49.8951, -97.1384'), [49.8951, -97.1384]);
  assert.deepEqual(parseCoords('-97.1384, 49.8951'), [49.8951, -97.1384]);
  assert.equal(parseCoords('300 Mystery Lake Rd'), null);
  assert.equal(parseCoords('200, 200'), null);
});

await test('CSV upload with quoted cells and lat/lon columns', () => {
  const rows = csvRows('Name,Lat,Lon,Notes\r\n"Farm, north",49.5,-96.7,"say ""hi"""\r\n');
  assert.deepEqual(parseTable(rows[0], rows.slice(1)), [{ label: 'Farm, north', query: '49.5, -96.7', notes: 'say "hi"' }]);
});

await test('address cleanup takes the first address of a range or pair', () => {
  assert.equal(cleanAddress('215 & 223 Cree Rd, Thompson, MB'), '215 Cree Rd, Thompson, MB');
  assert.equal(cleanAddress('52-56 Waterloo Ave, Thompson'), '52 Waterloo Ave, Thompson');
  assert.equal(cleanAddress('25&39 Laval Pl'), '25 Laval Pl');
  assert.equal(cleanAddress('32-48 Seal/88 Severen, Thompson, MB'), '32 Seal, Thompson, MB');
  assert.equal(cleanAddress('300 Mystery Lake Rd, Thompson'), '300 Mystery Lake Rd, Thompson');
});

await test('a different street type counts as not found (Cree Cr vs Cree Road)', () => {
  assert.equal(streetMismatch('111 Cree Cr, Thompson, MB', 'Cree Road, Thompson, Manitoba, R8N 1P1, Canada'), true);
  assert.equal(streetMismatch('37 Centennial Dr E, Thompson', 'Centennial Drive East, Thompson, Manitoba'), false);
  assert.equal(streetMismatch('300 Mystery Lake Rd', '300, Mystery Lake Road, Thompson'), false);
  assert.equal(streetMismatch('3 Fox Bay, Thompson', 'Fox Bay, Thompson, Manitoba'), false);
});

await test('approximate = house number missing from the OSM match, or a non-rooftop Google match', () => {
  assert.equal(isApproximate('osm', '17 Waterloo Ave, Thompson', { matched: 'Waterloo Avenue, Thompson' }), true);
  assert.equal(isApproximate('osm', '300 Mystery Lake Rd', { matched: '300, Mystery Lake Road, Thompson' }), false);
  assert.equal(isApproximate('osm', 'Morden, Manitoba', { matched: 'Morden, Manitoba, Canada' }), false);
  assert.equal(isApproximate('google', 'x', { quality: 'ROOFTOP' }), false);
  assert.equal(isApproximate('google', 'x', { quality: 'GEOMETRIC_CENTER' }), true);
  assert.equal(isApproximate('google', 'x', { quality: 'ROOFTOP (partial match)' }), true);
});

// ---------------------------------------------------------------- outputs

await test('stacked markers fan out and stay inside the frame', () => {
  const out = spreadMarkers([[100, 100], [100, 100], [300, 595]], 600, 600, 12);
  assert.ok(Math.hypot(out[0][0] - out[1][0], out[0][1] - out[1][1]) >= 24);
  assert.deepEqual(out[2], [300, 595]); // alone: untouched
  const edge = spreadMarkers([[300, 598], [300, 598]], 600, 600, 12);
  for (const [x, y] of edge) assert.ok(x >= 15 && x <= 585 && y >= 15 && y <= 585, `${x},${y}`);
});

await test('Google Maps links: at most 9 waypoints, legs overlap at their ends', () => {
  const seq = Array.from({ length: 23 }, (_, i) => ({ lat: 49 + i / 100, lon: -97 }));
  const links = mapsLinks(seq);
  assert.deepEqual(links.map((l) => [l.a, l.b]), [[0, 10], [10, 20], [20, 22]]);
  for (const l of links) {
    const wp = new URL(l.url).searchParams.get('waypoints');
    assert.ok(!wp || wp.split('|').length <= 9);
  }
});

await test('durations and CSV', () => {
  assert.equal(fmtDur(59 * 60), '59 min');
  assert.equal(fmtDur(17.5 * 3600), '17h 30m');
  const csv = routeCsv([{ num: 'S', p: { label: '', query: 'A, "B"', notes: 'n', lat: 1, lon: 2 }, legT: 0, legD: 0, cumT: 0, cumD: 0, first: true }]);
  assert.match(csv, /^#,Stop,Notes/);
  assert.match(csv, /"A, ""B"""/);
});

await test('polyline decoding (Google reference example)', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

// ---------------------------------------------------------------- Google pass-through

await test('api/route-google rejects anything but the three operations', async () => {
  const call = (body, method = 'POST') => handler(new Request('http://x/api/route-google', {
    method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined,
  }));
  assert.equal((await call({}, 'GET')).status, 405);
  assert.equal((await call({ op: 'geocode', address: 'x' })).status, 400); // no key
  assert.equal((await call({ op: 'delete', key: 'k' })).status, 400);
  assert.equal((await call({ op: 'matrix', key: 'k' })).status, 400); // no body
});

await test('api/route-google forwards a geocode with the key and no server-side key', async () => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url) => { seen = String(url); return new Response('{"status":"OK","results":[]}'); };
  try {
    const r = await handler(new Request('http://x/api/route-google', {
      method: 'POST', body: JSON.stringify({ op: 'geocode', key: 'user-key', address: '1 Main St', region: 'ca' }),
    }));
    assert.equal(r.status, 200);
    assert.match(seen, /^https:\/\/maps\.googleapis\.com\/maps\/api\/geocode\/json\?/);
    assert.match(seen, /key=user-key/);
    assert.match(seen, /region=ca/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`routeOptimizer.test.js: ${passed} passed`);
