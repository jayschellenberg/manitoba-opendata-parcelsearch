// New condo developments — the derivations over a development stamp, the
// unknown-vs-none rule, and agreement between lib/condoDev.js and the built
// shards.
//
// The drift check earns its keep the same way landfacts' does: if
// r/build_condo_dev.R changes MIN_UNITS or FROM_YEAR and this module is not
// updated, the legend and the column footnote state a gate the data no longer
// uses. The built index's `_meta` carries both.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CONDO_MIN_UNITS,
  CONDO_FROM_YEAR,
  CONDO_TYPES,
  CONDO_YEAR_RAMP,
  CONDO_MODES,
  readCondoDev,
  condoType,
  condoFillColor,
  condoCellText,
  condoSortRank,
  condoTooltip,
  condoCsvHeaders,
  condoCsvCells,
  condoLegendSteps,
} from '../src/lib/condoDev.js';

// Brandon plan 57857 — the largest new row-housing development, and the case
// that shows why `kn` matters: typed off 4 of its 122 rolls.
const row = { p: '57857', y: 2017, u: 122, k: 'row', kn: 4, b: 30128400, ad: '123 COBALT CRES' };
// An apartment condo where every unit sold with a descriptor.
const apt = { p: '70642', y: 2024, u: 40, k: 'apt', kn: 40, b: 17859800, ad: 'Unit 105 - 3400 MCDONALD AVE' };
// A development no unit has sold from — the honest blank.
const unk = { p: '74173', y: 2026, u: 38, k: 'unknown', kn: 0, b: 10891000, ad: '49 WHEATGRASS BAY' };

// --- readCondoDev -----------------------------------------------------------
assert.equal(readCondoDev(null), null);
assert.equal(readCondoDev('57857'), null);
assert.equal(readCondoDev({ y: 2017, u: 3 }), null, 'no plan is not a stamp');
assert.ok(readCondoDev(row));

// --- type -------------------------------------------------------------------
assert.equal(condoType(row), 'row');
assert.equal(condoType(apt), 'apt');
assert.equal(condoType(unk), 'unknown');
assert.equal(condoType(null), null);
// A type the shard ships but this build does not know must degrade to unknown,
// not to a crash on CONDO_TYPES[undefined].
assert.equal(condoType({ ...row, k: 'duplex-of-the-future' }), 'unknown');

// Every type the builder can emit needs a label, a colour and prose.
for (const k of ['row', 'apt', 'mixed', 'unknown']) {
  assert.ok(CONDO_TYPES[k], `no entry for type ${k}`);
  assert.ok(CONDO_TYPES[k].label && CONDO_TYPES[k].color && CONDO_TYPES[k].blurb,
            `type ${k} is missing a label, colour or blurb`);
}
// The four colours must be distinct, or the map cannot be read.
const colors = Object.values(CONDO_TYPES).map((t) => t.color);
assert.equal(new Set(colors).size, colors.length, 'type colours must all differ');

// --- colour -----------------------------------------------------------------
assert.equal(condoFillColor(row, 'type'), CONDO_TYPES.row.color);
assert.equal(condoFillColor(apt, 'type'), CONDO_TYPES.apt.color);
assert.equal(condoFillColor(unk, 'type'), CONDO_TYPES.unknown.color);
assert.equal(condoFillColor(row, 'year'), '#f2f0f7', '2017 is the first year bucket');
assert.equal(condoFillColor(unk, 'year'), '#54278f', '2026 is the open-ended top bucket');
assert.equal(condoFillColor(null, 'type'), null);
// An unknown mode falls back to type rather than painting nothing.
assert.equal(condoFillColor(row, 'nonsense'), CONDO_TYPES.row.color);
// The year ramp must terminate open, or a future year paints nothing and the
// development silently vanishes from the overlay.
assert.equal(CONDO_YEAR_RAMP[CONDO_YEAR_RAMP.length - 1].max, Infinity);
for (let i = 1; i < CONDO_YEAR_RAMP.length; i += 1) {
  assert.ok(CONDO_YEAR_RAMP[i].max > CONDO_YEAR_RAMP[i - 1].max, 'year breaks must ascend');
}
assert.ok(CONDO_YEAR_RAMP[0].max >= CONDO_FROM_YEAR, 'year ramp starts after the shipped window');

// The condo palette must not collide with the multi-family one — the two
// overlays can be on together and must not read as one dataset.
const mf = await import('../src/lib/mfNewbuild.js');
const mfColors = new Set([...mf.YEAR_RAMP, ...mf.UNITS_RAMP].map((s) => s.color));
for (const c of colors) assert.ok(!mfColors.has(c), `type colour ${c} collides with New Multi-Family`);

// --- cell text, sort, tooltip ----------------------------------------------
assert.equal(condoCellText(row), '2017 · Row housing · 122 units');
assert.equal(condoCellText({ ...row, u: 1 }), '2017 · Row housing · 1 unit', 'singular unit');
assert.equal(condoCellText(unk), '2026 · Not typed · 38 units');
assert.equal(condoCellText(null), '');

// Typed developments outrank untyped ones even when the untyped one is newer:
// "we know what this is" is the more useful row.
assert.ok(condoSortRank(row) > condoSortRank(unk), 'typed sorts ahead of untyped');
assert.ok(condoSortRank(apt) > condoSortRank(row), 'within typed, newer first');
assert.ok(condoSortRank(unk) > condoSortRank(null), 'untyped still outranks unstamped');
assert.equal(condoSortRank(null), -Infinity);

const tipRow = condoTooltip(row);
assert.ok(tipRow.includes('57857') && tipRow.includes('122 units'));
assert.ok(tipRow.includes('4 of 122'), 'tooltip surfaces the evidence count');
assert.ok(tipRow.includes('trail completion'), 'tooltip carries the assessment-lag caveat');
const tipUnk = condoTooltip(unk);
assert.ok(!tipUnk.includes('Typed from'), 'an untyped development claims no evidence');
assert.ok(tipUnk.includes('guessed') || tipUnk.includes('unknown'),
          'the untyped tooltip explains why it is blank');

// --- CSV: unknown is blank, none is "None" ---------------------------------
assert.equal(condoCsvHeaders().length, condoCsvCells(row, true).length,
             'header and cell counts must match or the export shifts columns');
assert.equal(condoCsvCells(null, true)[0], 'None');
assert.equal(condoCsvCells(null, false)[0], '', 'an unloaded shard is unknown, never "None"');
assert.equal(condoCsvCells(null, true).length, condoCsvCells(null, false).length);
const cells = condoCsvCells(row, true);
assert.equal(cells[0], '57857');
assert.equal(cells[1], '2017');
assert.equal(cells[2], '122');
assert.equal(cells[3], 'Row housing');
assert.equal(cells[4], '4');
// An untyped development must export no evidence count — a "0" there would
// read as a measurement rather than as an absence.
assert.equal(condoCsvCells(unk, true)[4], '');

// --- legend -----------------------------------------------------------------
assert.equal(condoLegendSteps('year').length, CONDO_YEAR_RAMP.length);
assert.equal(condoLegendSteps('type').length, Object.keys(CONDO_TYPES).length);
assert.equal(condoLegendSteps('nonsense').length, Object.keys(CONDO_TYPES).length);
for (const m of Object.keys(CONDO_MODES)) {
  assert.ok(CONDO_MODES[m].label && CONDO_MODES[m].legend, `mode ${m} needs a label and legend`);
}

// --- drift against the built shard index ------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const idxPath = join(here, '..', '..', '..', 'mb-parcel-data', 'condo-dev', '_index.json');
if (existsSync(idxPath)) {
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  const meta = idx._meta || {};
  assert.equal(meta.min_units, CONDO_MIN_UNITS, 'MIN_UNITS drifted from r/build_condo_dev.R');
  assert.ok(Array.isArray(meta.window), '_meta.window missing');
  assert.equal(meta.window[0], CONDO_FROM_YEAR, 'FROM_YEAR drifted from r/build_condo_dev.R');
  assert.ok(meta.typed && typeof meta.typed === 'object', '_meta.typed missing');
  for (const k of Object.keys(meta.typed)) {
    assert.ok(CONDO_TYPES[k], `shard _meta reports type "${k}" with no entry in lib/condoDev.js`);
  }

  // Every shipped record must read as a stamp, paint, and use a known type.
  const shard = Object.entries(idx).find(([k]) => !k.startsWith('_'));
  if (shard) {
    const file = join(dirname(idxPath), shard[1].file);
    if (existsSync(file)) {
      const rolls = JSON.parse(readFileSync(file, 'utf8'));
      for (const rec of Object.values(rolls)) {
        assert.ok(readCondoDev(rec), 'a shipped record must read as a stamp');
        assert.ok(CONDO_TYPES[rec.k], `shard uses type "${rec.k}" with no entry here`);
        assert.ok(condoFillColor(rec, 'type'), 'a shipped record must paint by type');
        assert.ok(condoFillColor(rec, 'year'), 'a shipped record must paint by year');
        assert.ok(rec.u >= CONDO_MIN_UNITS, 'a shipped development is under MIN_UNITS');
        assert.ok(rec.y >= CONDO_FROM_YEAR, 'a shipped development predates the window');
        // kn must never exceed the unit count it is drawn from.
        assert.ok(rec.kn <= rec.u, `evidence count ${rec.kn} exceeds ${rec.u} units`);
        if (rec.k === 'unknown') assert.equal(rec.kn, 0, 'an untyped development cannot have evidence');
        else assert.ok(rec.kn > 0, 'a typed development must have at least one labelled roll');
      }
    }
  }
  console.log(`condoDev: checked against ${idxPath}`);
} else {
  console.log('condoDev: no local mb-parcel-data clone; drift check skipped');
}

console.log('condoDev tests passed');
