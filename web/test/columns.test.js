import assert from 'node:assert/strict';

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
};
globalThis.document = {
  querySelectorAll: () => [],
};

const {
  DEFAULT_VISIBLE,
  PRESETS,
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

console.log('column preset tests passed');
