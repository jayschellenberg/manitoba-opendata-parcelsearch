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
  landfactsTooltip,
  landfactsCsvCells,
  landfactsCsvHeaders,
  CROP_RAMP,
  cropShare,
  cropRampStep,
  cropRampColor,
  landUseStep,
  landUseColor,
  landfactsFillColor,
  LANDFACTS_MODES,
  LANDFACTS_WINDOW,
  CULT_MIN_YEARS,
  CULT_RECENT_OVERRIDE,
  MIX_OBS_CAVEAT,
  landMix,
  mixObserved,
  cultivatedShare,
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

// --- years-cropped ramp ------------------------------------------------------
assert.equal(cropShare(cropland), 1, '16 cropped of 16 observed');
assert.equal(cropShare(bush), 0);
assert.equal(cropShare({ cp: fill(null), dom: fill(null) }), null, 'nothing observed -> null, not 0');
assert.equal(cropRampStep(bush).label, 'Never cropped');
assert.equal(cropRampStep(cropland).label, 'Cropped >75% of Years');
assert.equal(cropRampColor({ cp: fill(null), dom: fill(null) }), null);
// share, not count: 3 cropped of 6 observed is exactly half, same bin as 8 of 16
const half = { cp: [90, 90, 90, 0, 0, 0, null, null, null, null, null, null, null, null, null, null, null],
               dom: [140, 140, 140, 110, 110, 110, null, null, null, null, null, null, null, null, null, null, null] };
assert.equal(cropRampStep(half).label, 'Cropped 50-75% of Years');
// bin edges follow the labels: exactly a quarter is "25-50%", exactly
// three-quarters is "50-75%"
const series = (cropped, observed) => ({
  cp: Array.from({ length: N }, (_, i) => (i < observed ? (i < cropped ? 90 : 0) : null)),
  dom: Array.from({ length: N }, (_, i) => (i < observed ? (i < cropped ? 140 : 110) : null)),
});
assert.equal(cropShare(series(4, 16)), 0.25);
assert.equal(cropRampStep(series(4, 16)).label, 'Cropped 25-50% of Years');
assert.equal(cropRampStep(series(3, 16)).label, 'Cropped <25% of Years');
assert.equal(cropRampStep(series(12, 16)).label, 'Cropped 50-75% of Years');
assert.equal(cropRampStep(series(13, 16)).label, 'Cropped >75% of Years');
assert.equal(cropRampStep(series(8, 16)).label, 'Cropped 50-75% of Years', 'exactly half is the upper bin');

// --- land-use view: cover group of the last observed year -------------------
assert.equal(landUseStep(cropland).label, 'Annual crop', 'canola in 2025');
assert.equal(landUseStep(bush).label, 'Grass / pasture', 'grassland in 2025, not the conifer years before');
assert.equal(landUseColor(bush), landUseStep(bush).color);
assert.equal(landUseStep({ cp: fill(null), dom: fill(null) }), null);
assert.equal(landfactsFillColor(cropland, 'landuse'), landUseColor(cropland));
assert.equal(landfactsFillColor(cropland, 'years'), cropRampColor(cropland));
assert.equal(landfactsFillColor(cropland, null), cropRampColor(cropland), 'no mode = years cropped');
assert.deepEqual(Object.keys(LANDFACTS_MODES), ['years', 'landuse']);
// lightness is monotone light -> dark: check the ramp never gets lighter
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
for (let i = 1; i < CROP_RAMP.length; i++) {
  assert.ok(lum(CROP_RAMP[i].color) < lum(CROP_RAMP[i - 1].color), `ramp step ${i} is not darker than ${i - 1}`);
}

// --- land mix: the per-pixel window rule --------------------------------------
// A real Hanover parcel from the 2026-09-15 trial build: 83% crop in 2025
// after years of pasture, so the recent-year override is what makes it 83%
// cultivated rather than the 2-of-5 count alone.
const mixed = {
  ...cropland,
  mix: { cult: 0.8301, past: 0.0301, bush: 0.1196, wet: 0, other: 0.0202 },
  cc: [16, 9, 13, 46, 15, 1], cn: [8, 12, 46, 15, 1], obs: 1,
};
assert.equal(LANDFACTS_WINDOW.length, 5);
assert.equal(LANDFACTS_WINDOW[LANDFACTS_WINDOW.length - 1], LANDFACTS_YEARS[N - 1], 'window ends on the latest year');
assert.deepEqual(landMix(mixed), mixed.mix);
assert.equal(landMix(cropland), null, 'a pre-mix shard has no mix, not a zero mix');
assert.equal(landMix({ ...cropland, mix: { cult: 0.5 } }), null, 'a partial mix is no mix');
assert.equal(mixObserved(mixed), 1);
assert.equal(mixObserved(cropland), null);
assert.ok(MIX_OBS_CAVEAT > 0 && MIX_OBS_CAVEAT < 1);
// The builder's own rule reproduces mix.cult from the counts: cc[2..5] plus
// the part of cc[1] cropped in the latest year (cn[0]).
assert.equal(CULT_MIN_YEARS, 2); assert.equal(CULT_RECENT_OVERRIDE, true);
assert.ok(Math.abs(cultivatedShare(mixed) - mixed.mix.cult) < 0.015, 'default rule matches the baked cult');
// Other rules read straight off the counts, no rebuild.
assert.equal(cultivatedShare(mixed, { minYears: 1, recentOverride: false }), (9 + 13 + 46 + 15 + 1) / 100);
assert.equal(cultivatedShare(mixed, { minYears: 3, recentOverride: false }), (46 + 15 + 1) / 100);
assert.equal(cultivatedShare(mixed, { minYears: 3, recentOverride: true }), (46 + 15 + 1 + 8 + 12) / 100);
assert.equal(cultivatedShare(cropland), null, 'no counts, no share');
assert.equal(cultivatedShare({ ...mixed, cc: [1, 2, 3] }), null, 'counts must span the window');
// The mix rides through the MapLibre string round-trip like the rest.
assert.deepEqual(landMix(JSON.stringify(mixed)), mixed.mix);
// The tooltip leads with the mix when there is one, and the caveat only
// when the window saw too little of the parcel.
assert.match(landfactsTooltip(mixed), /^Land mix 2021–2025, per pixel: cultivated 83%/);
assert.doesNotMatch(landfactsTooltip(mixed), /read with care/);
assert.match(landfactsTooltip({ ...mixed, obs: 0.5 }), /only 50% of pixel-years observed/);
assert.doesNotMatch(landfactsTooltip(cropland), /Land mix/);

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
  // The land-mix rule is recorded in the index from the first build that
  // carries it; an index built before that has no `window` and is left
  // alone, so this check does not block until the shards are rebuilt.
  if (meta.window) {
    assert.deepEqual(meta.window, LANDFACTS_WINDOW, 'land-mix window drifted from r/build_landfacts.R');
    assert.equal(meta.cult_rule?.min_years, CULT_MIN_YEARS, 'CULT_MIN_YEARS drifted from r/build_landfacts.R');
    assert.equal(!!meta.cult_rule?.recent_override, CULT_RECENT_OVERRIDE, 'CULT_RECENT_OVERRIDE drifted from r/build_landfacts.R');
    console.log(`landfacts: checked against ${idxPath} (with land-mix rule)`);
  } else {
    console.log(`landfacts: checked against ${idxPath} (index predates the land mix)`);
  }
} else {
  console.log('landfacts: no local mb-parcel-data clone; drift check skipped');
}

console.log('landfacts.test.js: all assertions passed');
