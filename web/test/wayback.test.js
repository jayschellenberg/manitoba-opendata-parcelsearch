// Unit tests for lib/wayback.js — the curated Esri Wayback release list
// and the tile-URL builder. Guards the URL shape (the {z}/{y}/{x} =
// {level}/{row}/{col} mapping the whole feature relies on) and the
// integrity of the curated MB date list.
//
// Run: cd web && node test/wayback.test.js

import assert from 'node:assert/strict';
import { WAYBACK_VERSIONS, waybackTileUrl } from '../src/lib/wayback.js';

// ---- tile URL shape ------------------------------------------------
{
  const url = waybackTileUrl(7110);
  assert.equal(
    url,
    'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/7110/{z}/{y}/{x}',
  );
  // Must carry MapLibre's XYZ placeholders (not the WMTS level/row/col).
  assert.ok(url.includes('/tile/7110/{z}/{y}/{x}'));
  assert.ok(!/\{level\}|\{row\}|\{col\}/.test(url));
}

// ---- curated list integrity ----------------------------------------
{
  assert.ok(WAYBACK_VERSIONS.length >= 1);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const seenDates = new Set();
  const seenReleases = new Set();
  for (const v of WAYBACK_VERSIONS) {
    assert.match(v.date, dateRe, `bad date: ${v.date}`);
    assert.ok(Number.isInteger(v.release) && v.release > 0, `bad release: ${v.release}`);
    assert.ok(!seenDates.has(v.date), `duplicate date: ${v.date}`);
    assert.ok(!seenReleases.has(v.release), `duplicate release: ${v.release}`);
    seenDates.add(v.date);
    seenReleases.add(v.release);
  }
  // Newest-first ordering, so the default (index 0) is the most recent.
  for (let i = 1; i < WAYBACK_VERSIONS.length; i++) {
    assert.ok(
      WAYBACK_VERSIONS[i - 1].date > WAYBACK_VERSIONS[i].date,
      `not sorted newest-first at ${i}: ${WAYBACK_VERSIONS[i - 1].date} !> ${WAYBACK_VERSIONS[i].date}`,
    );
  }
}

console.log('wayback.test.js: all assertions passed');
