// Unit tests for the printable route checklist (map fit + sheet HTML).
// Pure logic. Run:
//   cd web && node test/routeChecklist.test.js

import assert from 'node:assert/strict';
import {
  planMapView,
  spreadMarkers,
  chunkRows,
  buildChecklistHtml,
  mapBoxes,
  MARKER_R,
  ROWS_PER_PAGE,
} from '../src/lib/routeChecklist.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

function inside(view, pts) {
  return pts.map((p) => view.project(p.lng, p.lat))
    .every((q) => q.x >= MARKER_R && q.x <= view.width - MARKER_R && q.y >= MARKER_R && q.y <= view.height - MARKER_R);
}

await test('map boxes stay within the Static Images 1280 px cap', () => {
  for (const b of Object.values(mapBoxes())) {
    assert.ok(b.width <= 1280 && b.height <= 1280);
    assert.ok(Math.max(b.width, b.height) === 1280);
  }
});

await test('tall route picks portrait, wide route picks landscape', () => {
  const tall = [{ lng: -97.1, lat: 49.5 }, { lng: -97.12, lat: 50.2 }];
  const wide = [{ lng: -98.5, lat: 49.8 }, { lng: -96.9, lat: 49.85 }];
  assert.equal(planMapView(tall).orientation, 'portrait');
  assert.equal(planMapView(wide).orientation, 'landscape');
});

await test('outermost stops sit just inside the image edge', () => {
  const pts = [
    { lng: -97.3, lat: 49.7 }, { lng: -96.8, lat: 49.95 },
    { lng: -97.0, lat: 49.8 }, { lng: -97.1, lat: 49.72 },
  ];
  const v = planMapView(pts);
  assert.ok(inside(v, pts), 'all markers inside');
  const q = pts.map((p) => v.project(p.lng, p.lat));
  const minX = Math.min(...q.map((p) => p.x));
  const maxX = Math.max(...q.map((p) => p.x));
  const minY = Math.min(...q.map((p) => p.y));
  const maxY = Math.max(...q.map((p) => p.y));
  // The binding axis is filled to within ~25 px of each edge.
  const slackX = Math.min(minX, v.width - maxX);
  const slackY = Math.min(minY, v.height - maxY);
  assert.ok(Math.min(slackX, slackY) < 25, `slack ${slackX.toFixed(1)} / ${slackY.toFixed(1)}`);
  // And the centre is the bbox centre.
  assert.ok(Math.abs((minX + maxX) / 2 - v.width / 2) < 0.5);
  assert.ok(Math.abs((minY + maxY) / 2 - v.height / 2) < 0.5);
  // Zoom is rounded down to 2 decimals for the Static URL.
  assert.equal(Math.round(v.zoom * 100) / 100, v.zoom);
});

await test('single point caps zoom instead of going infinite', () => {
  const v = planMapView([{ lng: -97.1, lat: 49.9 }]);
  assert.ok(Number.isFinite(v.zoom) && v.zoom <= 17);
  const p = v.project(-97.1, 49.9);
  assert.ok(Math.abs(p.x - v.width / 2) < 1e-6 && Math.abs(p.y - v.height / 2) < 1e-6);
});

await test('stacked markers fan out and stay in frame', () => {
  const xy = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 300, y: 300 }];
  const out = spreadMarkers(xy, 400, 400);
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      assert.ok(Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y) >= 2 * MARKER_R - 2);
    }
    assert.ok(out[i].x >= MARKER_R && out[i].y >= MARKER_R);
  }
  assert.deepEqual(out[3], { x: 300, y: 300 });
});

await test('rows chunk into pages of 25', () => {
  const rows = Array.from({ length: 51 }, (_, i) => i);
  assert.deepEqual(chunkRows(rows).map((p) => p.length), [25, 25, 1]);
  assert.equal(ROWS_PER_PAGE, 25);
  assert.deepEqual(chunkRows([]), [[]]);
});

await test('sheet: map page + one list page per 25 stops, escaped text, start row', () => {
  const markers = [{ lng: -97.1, lat: 49.9, text: 'S', kind: 'start' }];
  const rows = [{ num: 'S', start: true, address: 'Start <b>', notes: '' }];
  for (let i = 1; i <= 30; i++) {
    markers.push({ lng: -97.1 - i * 0.01, lat: 49.9, text: String(i), kind: 'stop' });
    rows.push({ num: String(i), address: `${i} Main & Co`, notes: 'Roll 1', approx: i === 4 });
  }
  const view = planMapView(markers);
  const html = buildChecklistHtml({ title: 'T "x"', summary: 's', view, mapImageUrl: 'https://x/y?a=1&b=2', markers, line: [], rows });
  assert.equal((html.match(/class="sheet /g) || []).length, 3);   // map + 2 list pages
  assert.equal((html.match(/<tr( class="start")?><td><span class="box">/g) || []).length, 31);
  assert.ok(html.includes('Start &lt;b&gt;'));
  assert.ok(html.includes('1 Main &amp; Co'));
  assert.ok(html.includes('4 Main &amp; Co *'));
  assert.ok(html.includes('stops 26–30 of 30 · page 2 of 2'));
  assert.ok(html.includes('src="https://x/y?a=1&amp;b=2"'));
  assert.ok(!/<script/i.test(html), 'no inline script (CSP script-src self)');
  assert.ok(!/ on[a-z]+=/i.test(html), 'no inline handlers');
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
