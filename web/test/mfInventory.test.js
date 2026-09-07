// The standing multi-family inventory — the threshold rules, the shared
// colour ramp, and agreement between lib/mfInventory.js and the built shards.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MFINV_MIN_DU,
  MFINV_DEFAULT_MIN,
  readMfInv,
  mfInvFillColor,
  mfInvPasses,
  mfInvTooltip,
  mfInvLegendSteps,
  clampMinDu,
} from '../src/lib/mfInventory.js';
import { UNITS_RAMP } from '../src/lib/mfNewbuild.js';

const small = { du: 4, cl: 'R2', ad: '10 FIRST AVE' };
const block = { du: 128, cl: 'R2', ad: '2200 PACIFIC AVE' };

// --- readMfInv --------------------------------------------------------------
assert.equal(readMfInv(null), null);
assert.equal(readMfInv({ cl: 'R2' }), null, 'no unit count is not a stamp');
assert.equal(readMfInv({ du: 'lots' }), null, 'a non-numeric count is not a stamp');
assert.ok(readMfInv(small));
assert.ok(readMfInv({ du: 0 }), 'zero is a number and parses; the threshold is what excludes it');

// --- colour is New Multi-Family's, not a second palette ---------------------
// The two layers are read against each other constantly. A 24-unit building
// changing colour between them would be a bug the eye cannot diagnose.
assert.equal(mfInvFillColor(small), UNITS_RAMP.find((s) => 4 <= s.max).color);
assert.equal(mfInvFillColor(block), UNITS_RAMP[UNITS_RAMP.length - 1].color);
assert.equal(mfInvFillColor(null), null);
assert.equal(mfInvFillColor({ du: 999999 }), UNITS_RAMP[UNITS_RAMP.length - 1].color,
             'a count past the last break still paints');

// --- the threshold ----------------------------------------------------------
assert.equal(mfInvPasses(small, 3), true);
assert.equal(mfInvPasses(small, 4), true, 'the bar is inclusive');
assert.equal(mfInvPasses(small, 5), false);
assert.equal(mfInvPasses(block, 100), true);
assert.equal(mfInvPasses(null, 3), false);
// A missing or unparseable threshold must fall back to the floor, never to 0 —
// showing rolls the shard never published would be a lie about coverage.
assert.equal(mfInvPasses(small, undefined), true);
assert.equal(mfInvPasses({ du: 1 }, undefined), false, 'below the floor stays out');

// --- clampMinDu -------------------------------------------------------------
assert.equal(clampMinDu(20), 20);
assert.equal(clampMinDu('20'), 20);
assert.equal(clampMinDu(20.7), 20, 'fractional units are meaningless; floor it');
assert.equal(clampMinDu(1), MFINV_MIN_DU, 'cannot go below the shard floor');
assert.equal(clampMinDu(0), MFINV_MIN_DU);
assert.equal(clampMinDu(-5), MFINV_MIN_DU);
assert.equal(clampMinDu(''), MFINV_MIN_DU, 'an emptied box falls back, not to NaN');
assert.equal(clampMinDu('abc'), MFINV_MIN_DU);
assert.equal(clampMinDu(null), MFINV_MIN_DU);
assert.equal(clampMinDu(1e9), 9999, 'clamped at the top too');
assert.equal(MFINV_DEFAULT_MIN, MFINV_MIN_DU);

// --- legend tracks the threshold -------------------------------------------
// Bands entirely below the bar cannot appear on screen, so showing them would
// promise colours the map will never draw.
assert.equal(mfInvLegendSteps(3).length, UNITS_RAMP.length);
const at50 = mfInvLegendSteps(50);
assert.ok(at50.length < UNITS_RAMP.length, 'a raised bar drops the low bands');
assert.ok(at50.every((b) => UNITS_RAMP.some((s) => s.color === b.color)));
assert.equal(mfInvLegendSteps(undefined).length, UNITS_RAMP.length);
assert.ok(mfInvLegendSteps(1e9).length >= 1, 'never renders an empty legend');

// --- tooltip ----------------------------------------------------------------
const tip = mfInvTooltip(block);
assert.ok(tip.includes('128 dwelling units'));
assert.ok(tip.includes('R2'));
assert.ok(tip.toLowerCase().includes('colonies'), 'the exclusion is stated where the number is');
assert.equal(mfInvTooltip({ du: 1, cl: 'R1' }).includes('1 dwelling unit'), true, 'singular');
assert.equal(mfInvTooltip(null), '');

// --- drift against the built shards ----------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const idxPath = join(here, '..', '..', '..', 'mb-parcel-data', 'mf-inventory', '_index.json');
if (existsSync(idxPath)) {
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  const meta = idx._meta || {};
  assert.equal(meta.min_du, MFINV_MIN_DU, 'MIN_DU drifted from r/build_mf_newbuild.R');

  // The inventory and the new-build family must describe the same universe —
  // that is the entire reason they ship from one script. Every roll in
  // mf-newbuild has to be present in mf-inventory.
  const nbIdx = join(here, '..', '..', '..', 'mb-parcel-data', 'mf-newbuild', '_index.json');
  if (existsSync(nbIdx)) {
    const nb = JSON.parse(readFileSync(nbIdx, 'utf8'));
    const muni = Object.keys(nb).find((k) => !k.startsWith('_') && idx[k]);
    if (muni) {
      const nbRolls = JSON.parse(readFileSync(join(dirname(nbIdx), nb[muni].file), 'utf8'));
      const invRolls = JSON.parse(readFileSync(join(dirname(idxPath), idx[muni].file), 'utf8'));
      for (const roll of Object.keys(nbRolls)) {
        assert.ok(invRolls[roll],
          `${muni} roll ${roll} is in mf-newbuild but missing from mf-inventory — the two families have diverged`);
      }
    }
  }

  const shard = Object.entries(idx).find(([k]) => !k.startsWith('_'));
  if (shard) {
    const rolls = JSON.parse(readFileSync(join(dirname(idxPath), shard[1].file), 'utf8'));
    for (const rec of Object.values(rolls)) {
      assert.ok(readMfInv(rec), 'a shipped record must read as a stamp');
      assert.ok(Number(rec.du) >= MFINV_MIN_DU, `shipped roll below the floor: ${rec.du}`);
      assert.ok(mfInvFillColor(rec), 'a shipped record must paint');
      assert.ok(mfInvPasses(rec, MFINV_MIN_DU), 'a shipped record must clear its own floor');
    }
  }
  console.log(`mfInventory: checked against ${idxPath}`);
} else {
  console.log('mfInventory: no local mb-parcel-data clone; drift check skipped');
}

console.log('mfInventory tests passed');
