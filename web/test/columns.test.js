import assert from 'node:assert/strict';

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
};
globalThis.document = {
  querySelectorAll: () => [],
};

const {
  DEFAULT_VISIBLE,
  PRESETS,
  PRESET_ORDER,
  columnPermutation,
  applyParcelImportDefaults,
  applyPreset,
  isColumnVisible,
  onPresetApply,
  setColumnVisible,
} = await import('../src/lib/columns.js');

assert.ok(DEFAULT_VISIBLE.has('soil'), 'regular default should include MASC Rating');
assert.ok(!DEFAULT_VISIBLE.has('zbl'), 'regular default should make room by hiding ZBL');

// Parcel identity / size / legal. These are unclassed columns, so they are
// what a fresh Property Search actually renders — the tab has no sales
// context to fall back on. Pinned because they were re-ticked by hand on
// every visit before they joined the default.
for (const key of ['roll', 'address', 'zone1', 'legal', 'title', 'du', 'acres', 'sf', 'value']) {
  assert.ok(DEFAULT_VISIBLE.has(key), `Property Search default should include ${key}`);
}
assert.ok(PRESETS.Agricultural.has('soil'), 'Agricultural preset should include MASC Rating');
assert.ok(!PRESETS.Agricultural.has('zbl'), 'Agricultural preset should hide ZBL');

setColumnVisible('soil', false);
setColumnVisible('zbl', true);
applyParcelImportDefaults();
assert.equal(isColumnVisible('soil'), true, 'parcel import should reveal MASC Rating');
assert.equal(isColumnVisible('zbl'), false, 'parcel import should hide ZBL');

applyPreset('Full detail');
applyParcelImportDefaults();
assert.equal(isColumnVisible('soil'), true, 'Full detail should retain MASC Rating');
assert.equal(isColumnVisible('zbl'), true, 'Full detail should remain complete');

// Risk Area is stamped by ordinary enrichment (no overlay needed), so the
// ag view is expected to carry it.
assert.ok(PRESETS.Agricultural.has('riskarea'), 'Agricultural preset should include Risk Area');

// applyPreset notifies preset listeners — that hook is how main.js knows to
// run the soil-survey join behind the Agricultural preset's CLI / Soil Type
// columns, which no search stamps on its own.
const seenPresets = [];
const stopListening = onPresetApply((name) => seenPresets.push(name));
// The throwing listener is deliberate — silence the warning it logs so the
// suite output stays clean.
const realWarn = console.warn;
console.warn = () => {};
const stopThrower = onPresetApply(() => { throw new Error('listener blew up'); });
applyPreset('Agricultural');
console.warn = realWarn;
stopThrower();
assert.deepEqual(seenPresets, ['Agricultural'], 'applyPreset should notify listeners by name');
assert.equal(isColumnVisible('clicls'), true, 'a throwing listener must not abort the preset');

applyPreset('Nope, not a preset');
assert.deepEqual(seenPresets, ['Agricultural'], 'an unknown preset should notify nobody');

stopListening();
applyPreset('Sales analysis');
assert.deepEqual(seenPresets, ['Agricultural'], 'unsubscribing should stop notifications');

// The roll's own frontage/area is the primary size source, so no preset may
// show a derived acreage while hiding the figure it came from. On the ~37% of
// Manitoba parcels stating frontage feet, hiding it would drop the ONLY
// assessor-stated size the row has and leave a polygon estimate looking
// authoritative. Enforced across every preset rather than spot-checked, so a
// future preset can't quietly reintroduce the gap.
for (const [name, set] of Object.entries(PRESETS)) {
  if (set === null) continue;               // 'Full detail' shows everything
  if (!set.has('acres')) continue;
  assert.ok(set.has('rollsize'),
    `preset '${name}' shows Acres but hides Roll Frontage/Area — the roll's own figure must travel with the derived one`);
}
assert.ok(DEFAULT_VISIBLE.has('rollsize'), 'Roll Frontage/Area should be visible by default');

// ---------------------------------------------------------------------------
// Per-preset column ORDER (PRESET_ORDER + columnPermutation).
// ---------------------------------------------------------------------------

// The natural thead order, abridged to the columns the rules below turn on.
// `seq` is the data-no-gear map-# column; `rollsize` and `acres` appear twice
// because the thead really does carry a .sales-only and a .basic-only twin of
// each, and any ordering rule has to survive that.
const NATURAL = [
  { key: 'seq', pinned: true },
  { key: 'favorite' }, { key: 'roll' }, { key: 'saledate' }, { key: 'saleprice' },
  { key: 'address' }, { key: 'rollsize' }, { key: 'acres' }, { key: 'groupacres' },
  { key: 'grouppriceac' }, { key: 'legal' },
  { key: 'rollsize' }, { key: 'acres' },
];
const keysOf = (perm) => perm.map((i) => NATURAL[i].key);

// No order declared = the thead's own sequence, untouched. This is what every
// preset without a PRESET_ORDER entry gets, so it has to be exactly identity.
assert.deepEqual(columnPermutation(NATURAL, null), NATURAL.map((_, i) => i),
  'no declared order should leave the natural sequence alone');
assert.deepEqual(columnPermutation(NATURAL, []), NATURAL.map((_, i) => i),
  'an empty order list should leave the natural sequence alone');

// The headline behaviour: a listed key comes forward, and everything the list
// never mentions follows in natural order rather than being dropped.
const moved = keysOf(columnPermutation(NATURAL, ['favorite', 'roll', 'grouppriceac']));
assert.equal(moved[0], 'seq', 'the data-no-gear map-# column must stay pinned in front');
assert.deepEqual(moved.slice(0, 4), ['seq', 'favorite', 'roll', 'grouppriceac'],
  'listed keys should render in the order the preset declares');
assert.ok(moved.includes('legal'), 'unlisted columns must survive, not vanish');
assert.deepEqual(moved.slice().sort(), keysOf(NATURAL.map((_, i) => i)).sort(),
  'a permutation must be exactly the natural columns rearranged — none added, none lost');

// A key naming two physical columns moves BOTH. Only the mode-appropriate twin
// ever renders, so leaving one behind would strand a live column at the far end
// of the table the moment the tab (and so the mode class) changed.
const twins = keysOf(columnPermutation(NATURAL, ['acres']));
assert.deepEqual(twins.slice(0, 3), ['seq', 'acres', 'acres'],
  'a duplicated key should bring both of its physical columns forward');

// Land Sales is the reason the mechanism exists: $/Acre has to arrive early,
// not 13th. Anchored to Address because that is where Jason put it — identity
// and the sale first, then the rate.
const LAND = PRESET_ORDER['Land Sales'];
assert.ok(Array.isArray(LAND), 'Land Sales should declare a column order');
assert.equal(LAND[LAND.indexOf('address') + 1], 'grouppriceac',
  '$/Acre should lead the rates, immediately after Address');
// Stronger than a bare index bound, and the reason the bound kept drifting as
// columns joined: what must hold is that NOTHING but identity-and-sale reaches
// the eye before the rate. A new column can join that block; it cannot push
// $/Acre behind a size, zoning or assessment column.
const IDENTITY_AND_SALE = new Set([
  'favorite', 'roll', 'n1id', 'muniname', 'saledate', 'saleprice', 'saletype', 'address',
]);
for (const key of LAND.slice(0, LAND.indexOf('grouppriceac'))) {
  assert.ok(IDENTITY_AND_SALE.has(key),
    `'${key}' precedes $/Acre in Land Sales but is not part of the identity/sale block`);
}
assert.ok(LAND.indexOf('grouppriceac') <= IDENTITY_AND_SALE.size,
  '$/Acre should be one of the first columns, not buried mid-table');

// Every rate is followed by the denominator it was divided by. A rate shown
// without it cannot be read on a multi-parcel sale, which is the whole reason
// the pairing is a rule and not a preference.
for (const [rate, denom] of [
  ['grouppriceac', 'groupacres'],
  ['grouppricesf', 'groupsf'],
  ['grouppricelot', 'groupsize'],
]) {
  assert.equal(LAND[LAND.indexOf(rate) + 1], denom,
    `${rate} should be followed immediately by its denominator ${denom}`);
}
// Roll Frontage/Area is $/FF's denominator AND the primary size source that
// has to ride ahead of Acres. It can only be in one place, and this is the
// one the PRESETS invariant already requires.
assert.equal(LAND[LAND.indexOf('rollsize') + 1], 'acres',
  "Roll Frontage/Area must stay immediately ahead of Acres");

// The trap this mechanism nearly shipped with: columnPermutation must always
// be fed the NATURAL column list. Feeding it a list already in preset order
// returns identity — which looks like success on the thead (already correct)
// while leaving freshly rendered rows unmoved beneath a reordered header, i.e.
// every cell under the wrong column. Pinned here so the "sort by data-nat
// first" step in applyOrder can't be simplified away.
const landOrder = ['favorite', 'roll', 'grouppriceac'];
const permuted = columnPermutation(NATURAL, landOrder).map((i) => NATURAL[i]);
assert.deepEqual(columnPermutation(permuted, landOrder), permuted.map((_, i) => i),
  'a list already in preset order permutes to identity — proof the input must be natural order');
assert.notDeepEqual(columnPermutation(NATURAL, landOrder), NATURAL.map((_, i) => i),
  'the same order against the natural list must NOT be identity');

// An order may only name columns the preset actually shows — otherwise the
// list would be silently reserving slots for columns that never render.
for (const [name, order] of Object.entries(PRESET_ORDER)) {
  const set = PRESETS[name];
  assert.ok(set, `PRESET_ORDER names '${name}', which is not a preset`);
  for (const key of order) {
    assert.ok(set.has(key),
      `PRESET_ORDER['${name}'] orders '${key}', which the preset does not show`);
  }
}

console.log('column preset tests passed');
