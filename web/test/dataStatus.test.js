// Unit tests for lib/dataStatus.js — the Data Status tab's row assembly.
// The cases that matter: month-precision rendering (never invent a day),
// ArcGIS epoch-ms edit dates, newest-snapshot selection, and publishedRows
// keeping a row (vintage null) for every source a fetch failed on.
//
// Run: cd web && node test/dataStatus.test.js

import assert from 'node:assert/strict';
import {
  monthLabel, datePart, vintageRows, serviceEditDate, newestSnapshot, publishedRows,
  mascRunDate, assemblyRunDate, statMaxDate,
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
  assert.equal(rows[3].label, '2026-08-09');

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
    landcoverMeta: { generated_at: '2026-08-17T02:00:00Z',
                     source: 'MAOParcelOutputAg20260804.parquet' },
    waterMeta: { generated_at: '2026-08-17T02:05:00Z',
                 source: 'MAOParcelOutput20260801.parquet' },
  });
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  assert.equal(byLabel.get('Legal descriptions index').vintage, '2026-08-15');
  assert.equal(byLabel.get('Legal descriptions index').detail, '437,778 rows');
  assert.equal(byLabel.get('Roll Entry snapshot (offline fallback)').vintage, '2026-08-11');
  assert.equal(byLabel.get('Zoning by-laws (archived snapshot)').vintage, '2026-07-01');
  assert.equal(byLabel.get('Zoning by-laws (archived snapshot)').detail, 'snapshot 2026-07-01');
  // The MASC scrape-run date beats generated_at (a rebuild day says nothing
  // about the data's age).
  assert.equal(byLabel.get('MASC soil productivity ratings').vintage, '2026-07-30');
  assert.equal(byLabel.get('MASC soil productivity ratings').detail, 'scrape run_20260730_093059');
  assert.equal(byLabel.get('Land cover & water shards (CDN)').detail,
    'pinned at revision fcbaa29');
  // Vintage is the OLDER of the two families' assembly-run dates (the row
  // covers both, and the data is only as current as its stalest half); the
  // date embedded in the source parquet name beats generated_at.
  assert.equal(byLabel.get('Land cover & water shards (CDN)').vintage, '2026-08-01');

  // Every fetch failing still yields a full table — vintages null, rows kept.
  const empty = publishedRows({});
  assert.equal(empty.length, rows.length);
  assert.ok(empty.every((r) => r.vintage == null));
}

// ---- mascRunDate -----------------------------------------------------------
assert.equal(mascRunDate({ run: 'run_20260730_093059' }), '2026-07-30');
assert.equal(mascRunDate({ generated_at: '2026-08-17T00:00:00Z' }), null);
assert.equal(mascRunDate(null), null);

// ---- assemblyRunDate -------------------------------------------------------
assert.equal(assemblyRunDate({ source: 'MAOParcelOutputAg20260804.parquet' }), '2026-08-04');
assert.equal(assemblyRunDate({ source: 'MAOParcelOutput20260801.parquet' }), '2026-08-01');
assert.equal(assemblyRunDate({ source: 'something-else.csv' }), null);
assert.equal(assemblyRunDate(null), null);
// A meta with no run date in the source falls back to generated_at day.
{
  const rows = publishedRows({
    waterMeta: { generated_at: '2026-08-17T02:05:00Z', source: 'handmade.parquet' },
  });
  const row = rows.find((r) => r.label === 'Land cover & water shards (CDN)');
  assert.equal(row.vintage, '2026-08-17');
}

// ---- statMaxDate (WALLAS newest-record proxy) ------------------------------
assert.equal(statMaxDate({ features: [{ attributes: { newest: Date.UTC(2026, 7, 10, 12) } }] }),
  '2026-08-10');
assert.equal(statMaxDate({ features: [] }), null);
assert.equal(statMaxDate(null), null);

console.log('dataStatus: all assertions passed');
