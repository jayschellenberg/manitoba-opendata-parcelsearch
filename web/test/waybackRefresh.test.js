// Unit tests for the pure helpers in scripts/refresh-wayback.mjs — the
// auto-refresh detector. The networked detection is verified by running
// the script live; here we lock down the tile math, config parsing, and
// (critically) the union/merge that must never drop a curated date.
//
// Run: cd web && node test/waybackRefresh.test.js

import assert from 'node:assert/strict';
import {
  lngLatToTile,
  parseReleases,
  parseVersionsLiteral,
  formatVersionsLiteral,
  mergeVersions,
} from '../scripts/refresh-wayback.mjs';

// ---- lngLatToTile (standard slippy-tile math) ----------------------
{
  // z0 = one tile.
  assert.deepEqual(lngLatToTile(-45, 45, 0), { z: 0, x: 0, y: 0 });
  // Null Island at z1 sits at the 4-tile seam -> x=1, y=1.
  assert.deepEqual(lngLatToTile(0, 0, 1), { z: 1, x: 1, y: 1 });
  // Winnipeg at z12.
  assert.deepEqual(lngLatToTile(-97.14, 49.9, 12), { z: 12, x: 942, y: 1390 });
}

// ---- parseReleases (config -> newest-first list) -------------------
{
  const config = {
    10: { itemTitle: 'World Imagery (Wayback 2014-02-20)' },
    7110: { itemTitle: 'World Imagery (Wayback 2022-11-02)' },
    645: { itemTitle: 'World Imagery (Wayback 2019-06-26)' },
    999: { itemTitle: 'No date here' }, // ignored
  };
  const rel = parseReleases(config);
  assert.deepEqual(rel, [
    { release: 7110, date: '2022-11-02' },
    { release: 645, date: '2019-06-26' },
    { release: 10, date: '2014-02-20' },
  ]);
}

// ---- parseVersionsLiteral / formatVersionsLiteral round-trip -------
{
  const literal = formatVersionsLiteral([
    { date: '2022-11-02', release: 7110 },
    { date: '2014-02-20', release: 10 },
  ]);
  assert.ok(literal.startsWith('export const WAYBACK_VERSIONS = ['));
  assert.deepEqual(parseVersionsLiteral(literal), [
    { date: '2022-11-02', release: 7110 },
    { date: '2014-02-20', release: 10 },
  ]);
}

// ---- mergeVersions: union, add-only, never drop --------------------
{
  const existing = [
    { date: '2022-11-02', release: 7110 },
    { date: '2015-12-16', release: 28163 }, // curated, NOT in detected
    { date: '2014-02-20', release: 10 },
  ];
  const detected = [
    { date: '2022-11-02', release: 7110 },
    { date: '2018-01-18', release: 13045 }, // new
    { date: '2014-02-20', release: 10 },
  ];
  const merged = mergeVersions(existing, detected);
  const dates = merged.map((v) => v.date);
  // Newest-first, includes the new date, and STILL includes the curated
  // 2015-12-16 that detection missed.
  assert.deepEqual(dates, ['2022-11-02', '2018-01-18', '2015-12-16', '2014-02-20']);
  // Existing release wins for a shared date.
  assert.equal(merged.find((v) => v.date === '2022-11-02').release, 7110);
}

// ---- mergeVersions: existing release wins on a date collision ------
{
  const merged = mergeVersions(
    [{ date: '2020-05-20', release: 32645 }],
    [{ date: '2020-05-20', release: 99999 }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].release, 32645);
}

console.log('waybackRefresh.test.js: all assertions passed');
