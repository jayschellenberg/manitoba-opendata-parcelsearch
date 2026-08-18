// Regression test for the explicit-list result caps.
//
// The bug (found 2026-08-17): searchParcels' two "the caller named every record
// it wants" paths — the chunked roll-list path and the parcel-key path — both
// shared the muni-wide MAX_RESULTS ceiling of 1,000 features. A sales load
// naming more rolls than that (Niverville's RESIDENTIAL LAND AND BUILDINGS
// history spans 1,720 distinct rolls) resolved only the first 1,000 to arrive.
// The rest were then reported as "Roll # not found in Roll_Entry", blaming the
// source data for a client-side stop.
//
// Each path failed in its own way, so both are covered here:
//   - roll list   four workers race, so WHICH rolls survived varied run to run
//   - parcel keys `truncated` was seeded from the INPUT length, so a 1,200-key
//                 import declared itself short before a single fetch had run
//
// Offline by design: fetch is stubbed, so this pins the accumulation logic
// rather than the service. The stub answers each chunk with exactly one feature
// per roll the WHERE clause asked for, which makes the invariant simple — every
// roll queried comes back, and nothing silently evaporates in the accumulator.

import assert from 'node:assert/strict';

// arcgis.js reaches for browser storage at import time; the cache layer falls
// back to localStorage in Node. Same shim arcgis-cache.test.js installs.
if (typeof globalThis.localStorage === 'undefined') {
  const map = new Map();
  globalThis.localStorage = {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}

// Every roll the stub was asked about, across all chunks. Compared against the
// features handed back so each assertion holds whatever the canonicalisation
// step does to the input — it is "all of what was queried", not a hard-coded
// number.
let requested = new Set();
let oid = 0;

globalThis.fetch = async (_url, opts) => {
  const body = new URLSearchParams(opts?.body || '');
  const where = body.get('where') || '';
  // Both paths put the rolls in Roll_No_Txt IN-lists; the key path wraps each
  // in a per-muni clause. Collect every list in the WHERE so one stub serves
  // both shapes.
  const rolls = [...where.matchAll(/Roll_No_Txt IN \(([^)]*)\)/g)]
    .flatMap((m) => m[1].split(','))
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  for (const r of rolls) requested.add(r);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      type: 'FeatureCollection',
      features: rolls.map((r) => ({
        type: 'Feature',
        geometry: null,
        properties: { OBJECTID: ++oid, Roll_No_Txt: r, Municipality: '340 - NIVERVILLE (TOWN)' },
      })),
      exceededTransferLimit: false,
    }),
  };
};

const { searchParcels } = await import('../src/arcgis.js');

// 1,720 rolls — the real Niverville residential figure, and comfortably past the
// old 1,000 ceiling and both chunk sizes (50 roll-list, 80 parcel-key).
const ROLL_COUNT = 1720;
const rolls = Array.from({ length: ROLL_COUNT }, (_, i) => String(340000000 + i));

async function check(label, args) {
  requested = new Set();
  const fc = await searchParcels(args);

  assert.ok(requested.size > 1000,
    `${label}: the list must reach the service intact — only ${requested.size} rolls were queried`);

  assert.equal(fc.features.length, requested.size,
    `${label}: every queried roll must survive the accumulator — asked about ${requested.size}, kept ${fc.features.length}`);

  assert.equal(fc._truncated, false,
    `${label}: a fully-resolved list must not report truncation`);

  // The specific old failure, stated on its own so a regression names itself
  // rather than showing up as an off-by-a-lot count mismatch.
  assert.notEqual(fc.features.length, 1000,
    `${label}: results are capped at MAX_RESULTS again (1,000) — see ROLL_LIST_MAX_RESULTS in arcgis.js`);

  return fc.features.length;
}

const viaRolls = await check('roll list', {
  municipality: 'NIVERVILLE (TOWN)',
  roll: rolls.join(','),
});

const viaKeys = await check('parcel keys', {
  parcelKeys: rolls.map((r) => ({ muni_no: 340, roll_no_txt: r })),
});

console.log(`explicit-list cap test passed — roll list ${viaRolls}/${ROLL_COUNT}, parcel keys ${viaKeys}/${ROLL_COUNT}, both uncapped`);
