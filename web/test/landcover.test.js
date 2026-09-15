// Land cover — which of two sources is the headline, and the disagreement
// flag between them.
//
// Two stamps carry the same five fractions: `_landfacts.mix` (the crop
// inventory read per pixel over 2021-2025) and `_landCover` (the StatCan
// Land Cover Register, 2020). headlineCover() picks the mix whenever it is
// present and keeps the register as the cross-check; where the two are far
// apart the parcel is flagged rather than silently trusting either.
//
// The second half is a wiring check in the style of overlayWiring.test.js:
// every place that used to read `_landCover` directly must now go through
// headlineCover(), or the grid, a popup and the map overlay can name
// different dominant buckets for one parcel. That is exactly the kind of
// bug unit tests miss — each reader is individually correct — so the
// source text is checked for the call.
//
// Run: cd web && node test/landcover.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAND_COVER_MIN_ACRES, LAND_COVER_BUCKETS, LAND_COVER_SOURCES, COVER_DISAGREE_MIN,
  dominantBucket, cultFraction, readLandCover, coverDisagreement, headlineCover,
} from '../src/lib/landcover.js';

const lcr = { cult: 0.7266, past: 0.0196, bush: 0.1195, wet: 0.111, other: 0.0234 };
const lf = {
  cp: Array(17).fill(50), dom: Array(17).fill(153),
  mix: { cult: 0.8301, past: 0.0301, bush: 0.1196, wet: 0, other: 0.0202 },
  cc: [16, 9, 13, 46, 15, 1], cn: [8, 12, 46, 15, 1], obs: 1,
};
const lfNoMix = { cp: Array(17).fill(50), dom: Array(17).fill(153) };

// --- coercion ---------------------------------------------------------------
assert.deepEqual(readLandCover(lcr), lcr);
assert.deepEqual(readLandCover(JSON.stringify(lcr)), lcr);
assert.equal(readLandCover('not json'), null);
assert.equal(readLandCover(null), null);

// --- disagreement ----------------------------------------------------------
assert.equal(coverDisagreement(lf.mix, null), null);
const d = coverDisagreement(lf.mix, lcr);
assert.equal(d.key, 'wet', 'the largest gap is the flagged bucket, not the first');
assert.ok(Math.abs(d.diff - 0.111) < 1e-9);
assert.equal(d.label, LAND_COVER_BUCKETS.find((b) => b.key === 'wet').label);
assert.ok(COVER_DISAGREE_MIN > 0.1 && COVER_DISAGREE_MIN <= 0.3);

// --- headline choice --------------------------------------------------------
// Mix present: it leads, the register is the cross-check.
let hc = headlineCover(lf, lcr, 160);
assert.equal(hc.source, 'aci');
assert.deepEqual(hc.lc, lf.mix);
assert.deepEqual(hc.other, lcr);
assert.equal(hc.flagged, false, '11 pp on wetland is under the flag line');
assert.equal(dominantBucket(hc.lc).key, 'cult');
assert.ok(Math.abs(cultFraction(hc.lc) - 0.8301) < 1e-9);
assert.ok(LAND_COVER_SOURCES[hc.source].label);

// Flagged when any bucket is COVER_DISAGREE_MIN or more apart — the Hanover
// 300.000 case, 79% cultivated now against the register's 38%.
hc = headlineCover({ ...lf, mix: { cult: 0.7867, past: 0.0733, bush: 0.1166, wet: 0, other: 0.0235 } },
                   { cult: 0.376, past: 0.4532, bush: 0.1192, wet: 0.0107, other: 0.0408 }, 160);
assert.equal(hc.flagged, true);
assert.equal(hc.disagreement.key, 'cult');

// No mix (pre-2026-09-15 shard, or under the farmland gate): the register
// leads and there is no cross-check to flag against.
hc = headlineCover(lfNoMix, lcr, 160);
assert.equal(hc.source, 'lcr');
assert.deepEqual(hc.lc, lcr);
assert.equal(hc.other, null);
assert.equal(hc.flagged, false);

// The register keeps its own acreage gate; the mix does not need one.
assert.equal(headlineCover(lfNoMix, lcr, LAND_COVER_MIN_ACRES), null, 'at the line is not over it');
assert.equal(headlineCover(lf, lcr, 5).source, 'aci', 'mix still shows under the register gate');
assert.equal(headlineCover(lf, lcr, 5).other, null, 'but the register is withheld there');
// An unknown acreage (fabric features carry none) does not gate — the shard
// was built above the line already.
assert.equal(headlineCover(null, lcr, undefined)?.source, 'lcr');
assert.equal(headlineCover(null, lcr, null)?.source, 'lcr');

// Nothing usable: null, not an empty object.
assert.equal(headlineCover(null, null, 160), null);
assert.equal(headlineCover(lfNoMix, { cult: 'x' }, 160), null);
// Strings (the popup path) coerce on both sides.
assert.equal(headlineCover(JSON.stringify(lf), JSON.stringify(lcr), 160).source, 'aci');

// --- wiring: every reader goes through headlineCover() ----------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // strip comments first
const main = src('main.js');
const map = src('map.js');

const mainCalls = (main.match(/headlineCover\(/g) || []).length;
assert.ok(mainCalls >= 6, `main.js calls headlineCover ${mainCalls} times; expected the two sort keys, the row render, the cell, the CSV, the landfacts stamp and the fabric stamp`);
assert.ok(/function stampLandCoverOnFabric[\s\S]*?headlineCover\(/.test(main), 'the fabric overlay stamp must colour by the headline');
assert.ok(/async function stampLandfacts[\s\S]*?headlineCover\(/.test(main), 'stampLandfacts must recolour _lcColor once the mix lands');
assert.ok(/function landCoverCsvCells[\s\S]*?headlineCover\(/.test(main), 'the CSV must export the headline, not the register');
assert.ok(/export function landCoverParcelHtml[\s\S]*?headlineCover\(/.test(map), 'the result popup must read the headline');
assert.ok(/export function landCoverTopTwoLine[\s\S]*?headlineCover\(/.test(map), 'the fabric popup must read the headline');
// No reader may bypass it: a bare dominantBucket(<something>._landCover) is
// the old path and would silently show the register beside a mix headline.
assert.doesNotMatch(main, /dominantBucket\([^)]*_landCover\)/, 'main.js reads _landCover directly for a dominant bucket');
assert.doesNotMatch(main, /cultFraction\([^)]*_landCover\)/, 'main.js reads _landCover directly for Cult %');
assert.doesNotMatch(map, /landCoverBreakdown\(readLandCover\(/, 'map.js bypasses headlineCover');
// The CSV header list and cell list must agree on the three new columns.
assert.match(main, /'Land Cover Source', 'LCR 2020 Cult %', 'Cover Disagreement pp'/);

console.log('landcover.test.js: all assertions passed');
