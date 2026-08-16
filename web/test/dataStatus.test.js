// Unit tests for lib/dataStatus.js — the Data Status tab's row assembly.
// The cases that matter: month-precision rendering (never invent a day),
// ArcGIS epoch-ms edit dates, newest-snapshot selection, and publishedRows
// keeping a row (vintage null) for every source a fetch failed on.
//
// Run: cd web && node test/dataStatus.test.js

import assert from 'node:assert/strict';
import {
  monthLabel, datePart, vintageRows, serviceEditDate, newestSnapshot, publishedRows,
} from '../src/lib/dataStatus.js';

// ---- monthLabel ------------------------------------------------------------
assert.equal(monthLabel('2026-07'), 'July 2026');
assert.equal(monthLabel('2026-01'), 'January 2026');
assert.equal(monthLabel('2026-12'), 'December 2026');
assert.equal(monthLabel('2026-13'), '2026-13');       // nonsense passes through
assert.equal(monthLabel('2026-07-15'), '2026-07-15'); // full dates untouched
assert.equal(monthLabel(null), null);

// ---- datePart --------------------------------------------------------------
assert.equal(datePart('2026-08-15T09:30:43Z'), '2026-08-15');
assert.equal(datePart(null), null);

// ---- vintageRows -----------------------------------------------------------
{
  const rows = vintageRows({
    rows: [
      { muni_no: '500', name: 'BRANDON (CITY)', region: 'West & Parkland', last_refreshed: '2026-07' },
      { muni_no: '101', name: 'ALTONA (TOWN)', region: 'South-Central / Central Plains', last_refreshed: '2026-06' },
      { muni_no: '999' },   // degenerate row: still renders, nothing invented
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'ALTONA (TOWN)');            // sorted by name
  assert.equal(rows[0].label, 'June 2026');
  assert.equal(rows[1].label, 'July 2026');
  assert.equal(rows[2].name, 'Muni 999');
  assert.equal(rows[2].label, null);

  assert.equal(vintageRows(null), null);
  assert.equal(vintageRows({ rows: [] }), null);
}

// ---- serviceEditDate -------------------------------------------------------
assert.equal(serviceEditDate({ editingInfo: { dataLastEditDate: Date.UTC(2026, 7, 5, 12) } }),
  '2026-08-05');
assert.equal(serviceEditDate({ editingInfo: {} }), null);
assert.equal(serviceEditDate(null), null);
assert.equal(serviceEditDate({ editingInfo: { dataLastEditDate: 0 } }), null);

// ---- newestSnapshot --------------------------------------------------------
{
  const snap = newestSnapshot({
    snapshots: {
      '2025-02-12': { layers: { zoning: { source_date: '2025-02-12' } } },
      '2026-07-01': { layers: { zoning: { source_date: '2026-07-01' } } },
    },
  });
  assert.equal(snap.id, '2026-07-01');
  assert.equal(snap.layers.zoning.source_date, '2026-07-01');
  assert.equal(newestSnapshot(null), null);
  assert.equal(newestSnapshot({ snapshots: {} }), null);
}

// ---- publishedRows ---------------------------------------------------------
{
  const rows = publishedRows({
    manifest: {
      datasets: {
        legal_index: { generated_at: '2026-08-15T09:30:43Z', row_count: 437778 },
        assessment_index: { generated_at: '2026-08-15T09:32:45Z', row_count: 437981 },
      },
    },
    rollSnap: { snapshot_date: '2026-08-11', source: 'RollEntry_20260811.gpkg' },
    histIndex: {
      snapshots: {
        '2026-07-01': {
          layers: {
            parcels: { source_date: '2026-07-01' },
            zoning: { source_date: '2026-07-01' },
            devplan: { source_date: '2026-07-01' },
          },
        },
      },
    },
    revision: '28bab05c3be2d12b1c0104f209fac54bf93cf051',
  });
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  assert.equal(byLabel.get('Legal descriptions index').vintage, '2026-08-15');
  assert.equal(byLabel.get('Legal descriptions index').detail, '437,778 rows');
  assert.equal(byLabel.get('Roll Entry snapshot (offline fallback)').vintage, '2026-08-11');
  assert.equal(byLabel.get('Zoning by-laws (archived snapshot)').vintage, '2026-07-01');
  assert.equal(byLabel.get('Zoning by-laws (archived snapshot)').detail, 'snapshot 2026-07-01');
  assert.equal(byLabel.get('MASC ratings, land cover & water shards (CDN)').detail,
    'pinned at revision 28bab05');

  // Every fetch failing still yields a full table — vintages null, rows kept.
  const empty = publishedRows({});
  assert.equal(empty.length, rows.length);
  assert.ok(empty.every((r) => r.vintage == null));
}

console.log('dataStatus: all assertions passed');
