// Unit tests for lib/dataStatus.js — the Data Status tab's row assembly.
// The cases that matter: month-precision rendering (never invent a day),
// ArcGIS epoch-ms edit dates, newest-snapshot selection, and publishedRows
// keeping a row (vintage null) for every source a fetch failed on.
//
// Run: cd web && node test/dataStatus.test.js

import assert from 'node:assert/strict';
import {
  monthLabel, datePart, vintageRows, serviceEditDate, newestSnapshot, publishedRows,
  mascRunDate, statMaxDate, dateLabel,
} from '../src/lib/dataStatus.js';

// ---- dateLabel -------------------------------------------------------------
assert.equal(dateLabel('2026-08-01'), 'Aug 1, 2026');
assert.equal(dateLabel('2026-12-25'), 'Dec 25, 2026');
assert.equal(dateLabel('2020'), '2020');            // bare years pass through
assert.equal(dateLabel('2026-08'), '2026-08');      // months are monthLabel's job
assert.equal(dateLabel(null), null);

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
      // Exact refresh day recorded — the date wins over the cohort month.
      { muni_no: '447', name: 'SELKIRK (CITY)', region: 'Interlake',
        last_refreshed: '2026-08', last_refreshed_date: '2026-08-09' },
      { muni_no: '999' },   // degenerate row: still renders, nothing invented
    ],
  });
  assert.equal(rows.length, 4);
  // Sorted by name: ALTONA, BRANDON, Muni 999, SELKIRK.
  assert.equal(rows[0].name, 'ALTONA (TOWN)');
  assert.equal(rows[0].label, 'June 2026');
  assert.equal(rows[1].label, 'July 2026');
  assert.equal(rows[2].name, 'Muni 999');
  assert.equal(rows[2].label, null);
  assert.equal(rows[3].name, 'SELKIRK (CITY)');
  assert.equal(rows[3].label, 'Aug 9, 2026');

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
    revision: 'fcbaa29993afd35431373af9b6843aed770f84a3',
    mascMeta: { generated_at: '2026-08-17T00:54:25Z',
                source: 'masc_soil_ratings_square_with_latlon_v2.csv',
                run: 'run_20260730_093059' },
  });
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  assert.equal(byLabel.get('Legal descriptions index').vintage, 'Aug 15, 2026');
  assert.equal(byLabel.get('Legal descriptions index').detail, '437,778 rows');
  assert.equal(byLabel.get('Roll Entry snapshot (offline fallback)').vintage, 'Aug 11, 2026');
  assert.equal(byLabel.get('Zoning by-laws (archived snapshot)').vintage, 'Jul 1, 2026');
  assert.equal(byLabel.get('Zoning by-laws (archived snapshot)').detail, 'snapshot 2026-07-01');
  // The MASC scrape-run date beats generated_at (a rebuild day says nothing
  // about the data's age).
  assert.equal(byLabel.get('MASC soil productivity ratings').vintage, 'Jul 30, 2026');
  assert.equal(byLabel.get('MASC soil productivity ratings').detail, 'scrape run_20260730_093059');
  // Land cover's vintage is the fixed base register, not a pipeline stamp.
  assert.equal(byLabel.get('Land cover').vintage, '2020');
  assert.equal(byLabel.get('Land cover').detail, 'Canada Lands Cover Register 2020 (base file)');
  assert.equal(byLabel.get('Water shards (CDN)').detail, 'pinned at revision fcbaa29');

  // Every fetch failing still yields a full table — vintages null, rows
  // kept. Land cover is the one exception: its vintage is a constant.
  const empty = publishedRows({});
  assert.equal(empty.length, rows.length);
  assert.ok(empty.every((r) => r.label === 'Land cover' || r.vintage == null));
}

// ---- mascRunDate -----------------------------------------------------------
assert.equal(mascRunDate({ run: 'run_20260730_093059' }), '2026-07-30');
assert.equal(mascRunDate({ generated_at: '2026-08-17T00:00:00Z' }), null);
assert.equal(mascRunDate(null), null);

// ---- statMaxDate (WALLAS newest-record proxy) ------------------------------
assert.equal(statMaxDate({ features: [{ attributes: { newest: Date.UTC(2026, 7, 10, 12) } }] }),
  '2026-08-10');
assert.equal(statMaxDate({ features: [] }), null);
assert.equal(statMaxDate(null), null);

console.log('dataStatus: all assertions passed');
