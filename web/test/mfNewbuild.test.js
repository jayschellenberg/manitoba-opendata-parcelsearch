// Multi-family new construction — the derivations over the event list, the
// unknown-vs-none rule, and agreement between lib/mfNewbuild.js and the built
// shards.
//
// The drift check is the one that earns its keep: if r/build_mf_newbuild.R
// changes MIN_DU or FROM_YEAR and this module is not updated, the legend and
// the column footnote state a gate the data no longer uses. The built index's
// `_meta` carries both, so when a local mb-parcel-data clone is present the
// two are compared.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MFNB_MIN_DU,
  MFNB_FROM_YEAR,
  MFNB_KINDS,
  MFNB_CONFIDENCE,
  YEAR_RAMP,
  UNITS_RAMP,
  MFNB_MODES,
  readMfnb,
  primaryYear,
  primaryEvent,
  bestConfidence,
  mfnbFillColor,
  totalGain,
  mfnbCellText,
  mfnbSortRank,
  mfnbTooltip,
  mfnbCsvHeaders,
  mfnbCsvCells,
  mfnbLegendSteps,
} from '../src/lib/mfNewbuild.js';

// Selkirk 1027 Manitoba Ave — the two-phase case the builder is written
// around. A commercial roll at $163,900 becomes a $16.9M apartment block in
// 2017, then doubles in 2024. Both events are real buildings, seven years
// apart, and `du` is the total of both phases because MAO publishes only a
// current unit count.
const twoPhase = {
  du: 270, ad: '1027 MANITOBA AVE', cl: 'R2', p: 2024,
  e: [
    { y: 2017, k: 'appeared', b: 16897600, bp: 163900, c: 'high' },
    { y: 2024, k: 'expanded', b: 37388400, bp: 17017000, c: 'high' },
  ],
};
// Portage 1120 Dufferin Ave E — a roll created vacant in 2020 that assessed
// at $17.8M in 2027. 2027 is a reassessment boundary year, but no revaluation
// factor turns $0 into $17.8M, so it is high confidence all the same.
const fromEmpty = {
  du: 118, ad: '1120 DUFFERIN AVE E', cl: 'R1|R2', p: 2027,
  e: [{ y: 2027, k: 'appeared', b: 17782300, bp: 0, c: 'high' }],
};
// A soft one: an already-improved roll that outran its municipality's
// revaluation factor across a boundary. A lead, not evidence.
const soft = {
  du: 12, ad: '100 MAIN ST', cl: 'R2', p: 2023,
  e: [{ y: 2023, k: 'expanded', b: 1400000, bp: 800000, c: 'low' }],
  sdu: [[2011, 8], [2019, 12]],
};

// --- readMfnb: what counts as a stamp -------------------------------------
assert.equal(readMfnb(null), null);
assert.equal(readMfnb(undefined), null);
assert.equal(readMfnb('2024'), null);
assert.equal(readMfnb({ du: 12 }), null, 'no event list is not a stamp');
assert.equal(readMfnb({ du: 12, e: [] }), null, 'an empty event list is not a stamp');
assert.ok(readMfnb(twoPhase));

// --- primary event --------------------------------------------------------
assert.equal(primaryYear(twoPhase), 2024);
assert.equal(primaryEvent(twoPhase).b, 37388400);
assert.equal(primaryYear(fromEmpty), 2027);
// Falling back when a shard predates the `p` field: latest event wins.
const noP = { du: 9, e: twoPhase.e };
assert.equal(primaryYear(noP), 2024, 'falls back to the latest event without `p`');
assert.equal(primaryYear(null), null);

// --- confidence: the BEST across events, not the last ---------------------
assert.equal(bestConfidence(twoPhase), 'high');
assert.equal(bestConfidence(soft), 'low');
assert.equal(bestConfidence({
  du: 20, e: [{ y: 2018, k: 'expanded', b: 2e6, bp: 1e6, c: 'low' },
              { y: 2022, k: 'appeared', b: 5e6, bp: 0, c: 'high' }],
}), 'high', 'one certain event makes the roll certain');
assert.equal(bestConfidence(null), null);

// Every confidence and kind the builder can emit has prose here — a shard
// value with no entry would render a bare code in the popup and the tooltip.
for (const c of ['high', 'med', 'low']) assert.ok(MFNB_CONFIDENCE[c], `no prose for confidence ${c}`);
for (const k of ['appeared', 'expanded', 'new_roll']) assert.ok(MFNB_KINDS[k], `no prose for kind ${k}`);

// --- value created: phases add -------------------------------------------
assert.equal(totalGain(twoPhase), (16897600 - 163900) + (37388400 - 17017000));
assert.equal(totalGain(fromEmpty), 17782300);
// A demolition year must not subtract from the total.
assert.equal(totalGain({ du: 4, e: [{ y: 2019, k: 'appeared', b: 500000, bp: 0, c: 'high' },
                                    { y: 2021, k: 'expanded', b: 100000, bp: 500000, c: 'low' }] }),
             500000, 'a value drop contributes zero, never a negative');

// --- colour ---------------------------------------------------------------
assert.equal(mfnbFillColor(twoPhase, 'year'), '#a50f15', '2024 falls in the 2024-25 bucket');
assert.equal(mfnbFillColor(fromEmpty, 'year'), '#67000d', '2027 falls in the open-ended top bucket');
assert.equal(mfnbFillColor(twoPhase, 'units'), '#08306b', '270 units is the 100+ bucket');
assert.equal(mfnbFillColor(soft, 'units'), '#6baed6', '12 units is the 12-23 bucket');
assert.equal(mfnbFillColor(null, 'year'), null);
// Both ramps must terminate at Infinity or a value past the last break paints
// nothing and the parcel silently disappears from the overlay.
for (const [name, ramp] of [['YEAR_RAMP', YEAR_RAMP], ['UNITS_RAMP', UNITS_RAMP]]) {
  assert.equal(ramp[ramp.length - 1].max, Infinity, `${name} must end open`);
  for (let i = 1; i < ramp.length; i += 1) {
    assert.ok(ramp[i].max > ramp[i - 1].max, `${name} breaks must ascend`);
  }
}
// The units ramp must not start above the builder's own gate, or the smallest
// shipped rolls paint nothing.
assert.ok(UNITS_RAMP[0].max >= MFNB_MIN_DU, 'UNITS_RAMP starts below MFNB_MIN_DU');
// The year ramp must reach back to the first year the builder ships.
assert.ok(YEAR_RAMP[0].max >= MFNB_FROM_YEAR, 'YEAR_RAMP starts after MFNB_FROM_YEAR');

// --- cell text, sort, tooltip --------------------------------------------
assert.equal(mfnbCellText(twoPhase), '2024 +1 · 270 DU', 'extra events are counted, not listed');
assert.equal(mfnbCellText(fromEmpty), '2027 · 118 DU');
assert.equal(mfnbCellText(null), '');
// Recency dominates the sort; units break ties inside a year.
assert.ok(mfnbSortRank(fromEmpty) > mfnbSortRank(twoPhase), '2027 sorts ahead of 2024');
assert.ok(mfnbSortRank(twoPhase) > mfnbSortRank({ ...twoPhase, du: 4 }), 'more units sorts first');
assert.equal(mfnbSortRank(null), -Infinity, 'unstamped rows sort last');
const tip = mfnbTooltip(twoPhase);
assert.ok(tip.includes('2017') && tip.includes('2024'), 'tooltip lists every event');
assert.ok(tip.includes('trail completion'), 'tooltip carries the assessment-lag caveat');
assert.ok(mfnbTooltip(soft).includes('at sale'), 'at-sale units surface in the tooltip');

// --- CSV: unknown is blank, none is "None" -------------------------------
assert.equal(mfnbCsvHeaders().length, mfnbCsvCells(twoPhase, true).length,
             'header and cell counts must match or the export shifts columns');
const none = mfnbCsvCells(null, true);
const unknown = mfnbCsvCells(null, false);
assert.equal(none[0], 'None', 'a loaded shard with no hit is a negative finding');
assert.equal(unknown[0], '', 'an unloaded shard is unknown, never "None"');
assert.equal(unknown.length, none.length);
const row = mfnbCsvCells(twoPhase, true);
assert.equal(row[0], '2024');
assert.equal(row[1], '2017 appeared; 2024 expanded');
assert.equal(row[2], '270');
assert.equal(row[4], 'high');
assert.equal(mfnbCsvCells(soft, true)[5], '2011: 8; 2019: 12');

// --- legend ---------------------------------------------------------------
assert.equal(mfnbLegendSteps('year').length, YEAR_RAMP.length);
assert.equal(mfnbLegendSteps('units').length, UNITS_RAMP.length);
assert.equal(mfnbLegendSteps('nonsense').length, YEAR_RAMP.length, 'unknown mode falls back to year');
for (const mode of Object.keys(MFNB_MODES)) {
  assert.ok(MFNB_MODES[mode].label && MFNB_MODES[mode].legend, `mode ${mode} needs a label and a legend title`);
}

// --- drift against the built shard index, when a local clone is present ----
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(here, '..', '..', '..', 'mb-parcel-data', 'mf-newbuild', '_index.json'),
];
const idxPath = candidates.find((p) => existsSync(p));
if (idxPath) {
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  const meta = idx._meta || {};
  assert.equal(meta.min_du, MFNB_MIN_DU, 'MIN_DU drifted from r/build_mf_newbuild.R');
  assert.ok(Array.isArray(meta.window), '_meta.window missing from the shard index');
  assert.equal(meta.window[0], MFNB_FROM_YEAR, 'FROM_YEAR drifted from r/build_mf_newbuild.R');
  // The top year bucket is open-ended, but the ramp must not have gone stale
  // enough that the newest shipped year sits in the same bucket as the oldest.
  assert.ok(meta.window[1] >= MFNB_FROM_YEAR, 'shard window is inverted');

  // Every kind and confidence actually present in a shard must have prose.
  const shard = Object.entries(idx).find(([k]) => !k.startsWith('_'));
  if (shard) {
    const file = join(dirname(idxPath), shard[1].file);
    if (existsSync(file)) {
      const rolls = JSON.parse(readFileSync(file, 'utf8'));
      for (const rec of Object.values(rolls)) {
        assert.ok(readMfnb(rec), 'a shipped shard record must read as a stamp');
        for (const e of rec.e) {
          assert.ok(MFNB_KINDS[e.k], `shard uses kind "${e.k}" with no prose in lib/mfNewbuild.js`);
          assert.ok(MFNB_CONFIDENCE[e.c], `shard uses confidence "${e.c}" with no prose`);
          assert.ok(mfnbFillColor(rec, 'year'), 'a shipped record must paint');
        }
      }
    }
  }
  console.log(`mfNewbuild: checked against ${idxPath}`);
} else {
  console.log('mfNewbuild: no local mb-parcel-data clone; drift check skipped');
}

console.log('mfNewbuild tests passed');
