// Water influence — class semantics, cell text and sorting.
//
// The distinction under test throughout is frontage vs near-water-without-
// frontage. Collapsing those two into one "near water" flag would make a lot
// fronting the Red River look comparable to a lot across the road from it, so
// these assertions exist to stop a future simplification doing exactly that.
import assert from 'node:assert/strict';
import {
  WATER_CLASSES,
  waterClass,
  waterColor,
  waterCellText,
  waterSortRank,
  waterTooltip,
  isWaterfront,
  isNearWater,
} from '../src/lib/water.js';

const stamp = (c, extra = {}) => ({ i: 'Yes', c, ...extra });

// ---- the three frontage classes are exactly the detection's "Yes" ----------
// Direct / Waterfront / Reserve Separated are what the R pipeline records as
// WaterInfluence = "Yes". If this drifts, the grid and the R output disagree
// about what "waterfront" means.
const FRONTAGE = ['Direct', 'Waterfront', 'Reserve Separated'];
const NO_FRONTAGE = ['Road Separated', 'Corridor Blocked', 'No Corroboration'];

for (const c of FRONTAGE) {
  assert.equal(isWaterfront(stamp(c)), true, `${c} should be waterfront`);
  assert.equal(isNearWater(stamp(c)), false, `${c} is frontage, not near-water`);
}
for (const c of NO_FRONTAGE) {
  assert.equal(isWaterfront(stamp(c)), false, `${c} must NOT be waterfront`);
}

// Reserve Separated is waterfront even though something sits between the lot
// and the water — a municipal reserve strip is normal in Manitoba lake
// communities and does not remove frontage value.
assert.equal(isWaterfront(stamp('Reserve Separated')), true);

// ---- near-water excludes No Corroboration ---------------------------------
// "No Corroboration" means the water feature itself could not be confirmed,
// not that access is blocked. Counting it as near-water would put unverified
// sloughs in the same bucket as a lot across the road from a river.
assert.equal(isNearWater(stamp('Road Separated')), true);
assert.equal(isNearWater(stamp('Corridor Blocked')), true);
assert.equal(isNearWater(stamp('No Corroboration')), false);

// ---- every class is classified one way or the other -----------------------
for (const c of WATER_CLASSES) {
  assert.equal(typeof c.color, 'string');
  assert.ok(/^#[0-9a-f]{6}$/i.test(c.color), `${c.key} needs a hex colour`);
  assert.equal(isWaterfront(stamp(c.key)), c.frontage);
}

// Frontage and non-frontage must not share a colour, or the map legend stops
// distinguishing the two cohorts.
const frontColors = new Set(WATER_CLASSES.filter((c) => c.frontage).map((c) => c.color));
const nearColors = new Set(WATER_CLASSES.filter((c) => !c.frontage).map((c) => c.color));
for (const col of nearColors) {
  assert.equal(frontColors.has(col), false, `colour ${col} used by both cohorts`);
}

// ---- absent / malformed stamps -------------------------------------------
// A missing stamp must be inert everywhere, never "waterfront by default".
for (const bad of [null, undefined, {}, { c: 'Nonsense' }, 'Direct', 42]) {
  assert.equal(waterClass(bad), null);
  assert.equal(isWaterfront(bad), false);
  assert.equal(isNearWater(bad), false);
  assert.equal(waterColor(bad), null);
  assert.equal(waterCellText(bad), '');
  assert.equal(waterTooltip(bad), '');
}
// "None" is a real pipeline value but is deliberately absent from
// WATER_CLASSES — those parcels are never shipped in the shards.
assert.equal(waterClass(stamp('None')), null);

// ---- cell text prefers the water body name -------------------------------
// An appraiser reads "Red River", not "Direct frontage".
assert.equal(
  waterCellText({ c: 'Direct', t: 'Watercourse', b: 'Red River' }),
  'Red River',
);
assert.equal(
  waterCellText({ c: 'Road Separated', t: 'Lake', b: 'Lake Manitoba' }),
  'Lake Manitoba',
);
// Retention ponds carry the literal body name "Retention Pond"; show the
// friendlier form rather than echoing it verbatim.
assert.equal(
  waterCellText({ c: 'Direct', t: 'Retention Pond', b: 'Retention Pond' }),
  'Retention pond',
);
// A named retention pond keeps its name.
assert.equal(
  waterCellText({ c: 'Direct', t: 'Retention Pond', b: 'Creekside Pond' }),
  'Creekside Pond',
);
// No body name at all falls back to the class label.
assert.equal(waterCellText({ c: 'Corridor Blocked' }), 'Corridor blocked');

// ---- sorting groups frontage first ---------------------------------------
// Sorting by class rank (not alphabetically by water body) keeps every
// frontage parcel above every near-water one.
const ranks = WATER_CLASSES.map((c) => waterSortRank(stamp(c.key)));
assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'ranks must be ordered');
const worstFrontage = Math.max(...WATER_CLASSES.filter((c) => c.frontage)
  .map((c) => waterSortRank(stamp(c.key))));
const bestNear = Math.min(...WATER_CLASSES.filter((c) => !c.frontage)
  .map((c) => waterSortRank(stamp(c.key))));
assert.ok(worstFrontage < bestNear, 'all frontage classes must sort above near-water');
// Unstamped parcels sort last.
assert.ok(waterSortRank(null) > waterSortRank(stamp('No Corroboration')));

// ---- tooltip carries the caveat ------------------------------------------
// Every rendered tooltip must say this is a screening aid, not a survey.
for (const c of WATER_CLASSES) {
  const tip = waterTooltip(stamp(c.key, { b: 'Test Lake', t: 'Lake' }));
  assert.ok(tip.includes('not a survey'), `${c.key} tooltip missing the caveat`);
  assert.ok(tip.includes('Test Lake'), `${c.key} tooltip missing the water body`);
}
// Non-frontage tooltips explain WHY there is no frontage.
assert.ok(waterTooltip(stamp('Road Separated')).includes('without frontage'));
assert.ok(waterTooltip(stamp('No Corroboration')).includes('could not be confirmed'));

console.log('water.test.js: all assertions passed');
