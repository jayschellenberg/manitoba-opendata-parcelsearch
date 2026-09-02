// Land facts — derivations over the per-year crop series, the null-vs-zero
// rule, and agreement between lib/landfacts.js and the built shards.
//
// The drift check is the one that earns its keep: if r/build_landfacts.R
// changes MIN_ACRES or the year range and this module is not updated, the
// grid silently mislabels every year by one. The built index's `_meta`
// carries both, so when a local mb-parcel-data clone is present the two
// are compared.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  LANDFACTS_MIN_ACRES,
  LANDFACTS_YEARS,
  ACI_CLASS,
  coverGroup,
  readLandfacts,
  yearRecords,
  observedYears,
  croppedYears,
  lastObserved,
  lastThree,
  coverString,
  wetlandClassNames,
  landfactsCellText,
  landfactsSortRank,
  landfactsCsvCells,
  landfactsCsvHeaders,
} from '../src/lib/landfacts.js';

const N = LANDFACTS_YEARS.length;
const fill = (v) => Array.from({ length: N }, () => v);

// A cropland quarter: canola last, cropped every observed year, one cloudy year.
const cropland = {
  cp: [98, 99, 99, 56, 84, 99, 95, 60, 61, 99, 100, 94, 99, 97, 98, null, 86],
  dom: [140, 133, 158, 158, 140, 133, 147, 133, 133, 147, 146, 133, 147, 133, 147, null, 153],
  rel: 1.4, slp: 0.12, z: [270, 271], wet: 0.6, wc: '', gsw: 0, gsi: 0,
};
// A bush quarter: grassland giving way to conifer, never cropped.
const bush = {
  cp: fill(0), dom: [110, 110, 110, 122, 110, 110, 110, 110, 110, 110, 110, 110, 110, 210, 210, 210, 110],
  rel: 5.9, slp: 0.63, z: [345, 351], wet: 0.19, wc: '1', gsw: 0, gsi: 0,
};

// --- year range and codes ------------------------------------------------
assert.equal(LANDFACTS_YEARS[0], 2009);
assert.equal(LANDFACTS_YEARS[N - 1], 2025);
assert.equal(N, 17);
assert.equal(ACI_CLASS[153], 'Canola/rapeseed');
assert.equal(ACI_CLASS[110], 'Grassland');
assert.equal(ACI_CLASS[80], 'Wetland');

// --- cover groups: crop is 130-199, forest sits above it ------------------
assert.equal(coverGroup(153), 'C');
assert.equal(coverGroup(130), 'C');
assert.equal(coverGroup(199), 'C');
assert.equal(coverGroup(200), 'T', 'forest 200 is not crop');
assert.equal(coverGroup(210), 'T');
assert.equal(coverGroup(110), 'G');
assert.equal(coverGroup(122), 'G');
assert.equal(coverGroup(80), 'W');
assert.equal(coverGroup(30), 'O');
assert.equal(coverGroup(null), '-');

// --- null is "not seen", never "nothing grew" ------------------------------
const recs = yearRecords(cropland);
assert.equal(recs.length, N);
assert.equal(recs[15].year, 2024);
assert.equal(recs[15].crop, null);
assert.equal(recs[15].group, '-');
assert.equal(observedYears(cropland), 16);
assert.equal(croppedYears(cropland), 16);
assert.equal(observedYears(bush), 17);
assert.equal(croppedYears(bush), 0);

// --- last year / last three -------------------------------------------------
const last = lastObserved(cropland);
assert.equal(last.year, 2025);
assert.equal(last.label, 'Canola/rapeseed');
assert.equal(last.crop, 86);
const l3 = lastThree(cropland);
assert.deepEqual(l3.map((r) => r.year), [2025, 2023, 2022], 'skips the unobserved 2024');
assert.equal(lastObserved({ cp: fill(null), dom: fill(null) }), null);

// --- cover string ------------------------------------------------------------
assert.equal(coverString(bush), 'GGGGGGGGGGGGGTTTG');
assert.equal(coverString(cropland).length, N);
assert.equal(coverString(cropland)[15], '-');

// --- cell text, sort, tooltip inputs ---------------------------------------
assert.equal(landfactsCellText(cropland), 'Canola/rapeseed 2025 · 16/16');
assert.equal(landfactsCellText(bush), 'Grassland 2025 · 0/17');
assert.equal(landfactsCellText(null), '');
assert.ok(landfactsSortRank(cropland) < landfactsSortRank(bush), 'more-cropped sorts first');
assert.equal(landfactsSortRank(null), Number.POSITIVE_INFINITY, 'unstamped last');
assert.equal(wetlandClassNames('124'), 'Bog, Fen, Marsh');
assert.equal(wetlandClassNames(''), '');

// --- MapLibre string round-trip ---------------------------------------------
assert.deepEqual(readLandfacts(JSON.stringify(bush)), bush);
assert.equal(readLandfacts('not json'), null);
assert.equal(readLandfacts({ cp: 'x' }), null);

// --- CSV -------------------------------------------------------------------
assert.equal(landfactsCsvCells(cropland, true).length, landfactsCsvHeaders().length);
assert.deepEqual(landfactsCsvCells(null, false), landfactsCsvHeaders().map(() => ''));
assert.deepEqual(landfactsCsvCells(null, true), landfactsCsvHeaders().map(() => 'n/a'));

// --- drift against the built shard index, when a local clone is present ----
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(here, '..', '..', '..', 'mb-parcel-data', 'landfacts', '_index.json'),
];
const idxPath = candidates.find((p) => existsSync(p));
if (idxPath) {
  const meta = JSON.parse(readFileSync(idxPath, 'utf8'))._meta || {};
  assert.equal(meta.min_acres, LANDFACTS_MIN_ACRES, 'MIN_ACRES drifted from r/build_landfacts.R');
  assert.deepEqual(meta.years, LANDFACTS_YEARS, 'year range drifted from r/build_landfacts.R');
  console.log(`landfacts: checked against ${idxPath}`);
} else {
  console.log('landfacts: no local mb-parcel-data clone; drift check skipped');
}

console.log('landfacts.test.js: all assertions passed');
