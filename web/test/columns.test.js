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
  setColumnVisible,
} = await import('../src/lib/columns.js');

assert.ok(DEFAULT_VISIBLE.has('soil'), 'regular default should include MASC Rating');
assert.ok(!DEFAULT_VISIBLE.has('zbl'), 'regular default should make room by hiding ZBL');
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

console.log('column preset tests passed');
