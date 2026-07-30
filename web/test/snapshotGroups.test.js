// Unit tests for lib/snapshotGroups.js — the grouping + naming rules that
// decide how many frames the Parcel Snapshots export captures and what the
// files are called.
//
// Pure module (no map / no DOM), so node exercises it directly.
// Run: cd web && node test/snapshotGroups.test.js

import assert from 'node:assert/strict';
import {
  snapshotGroupKey,
  groupParcelsForSnapshots,
  countSnapshotFrames,
  snapshotBaseName,
  siteLabel,
} from '../src/lib/snapshotGroups.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

/** Minimal parcel feature — only the properties the module reads. */
function parcel(props, geometry = { type: 'Point', coordinates: [0, 0] }) {
  return { type: 'Feature', geometry, properties: props };
}

// ---------- snapshotGroupKey ----------

console.log('snapshotGroupKey');

await test('_saleGroupId wins over _siteNo', () => {
  assert.equal(snapshotGroupKey({ _saleGroupId: 3, _siteNo: '24' }), 'g:3');
});

await test('falls back to _siteNo', () => {
  assert.equal(snapshotGroupKey({ _siteNo: '24' }), 's:24');
});

await test('no group stamps → null', () => {
  assert.equal(snapshotGroupKey({ Roll_No_Txt: '225600.000' }), null);
  assert.equal(snapshotGroupKey({ _saleGroupId: '', _siteNo: '  ' }), null);
  assert.equal(snapshotGroupKey(undefined), null);
});

await test('site and group keys cannot collide', () => {
  assert.notEqual(snapshotGroupKey({ _saleGroupId: 7 }), snapshotGroupKey({ _siteNo: '7' }));
});

// ---------- groupParcelsForSnapshots ----------

console.log('\ngroupParcelsForSnapshots');

await test('a 6-roll comp is ONE frame, not six', () => {
  const rolls = ['83100', '83200', '85200', '86400', '86300', '93000'];
  const features = rolls.map((r) => parcel({
    Roll_No_Txt: `${r}.000`,
    Municipality: '610 - PINEY (RM)',
    Muni_Name_With_Typ: 'PINEY (RM)',
    _saleGroupId: 1,
    _siteNo: '24',
  }));
  const groups = groupParcelsForSnapshots(features);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.length, 6);
  // Members come back in roll order, so the group's identity is stable.
  assert.equal(groups[0].members[0].properties.Roll_No_Txt, '83100.000');
  assert.deepEqual(groups[0].muniNames, ['PINEY (RM)']);
});

await test('ungrouped parcels are frames of one', () => {
  const features = [
    parcel({ Roll_No_Txt: '225600.000', Municipality: '610 - PINEY (RM)' }),
    parcel({ Roll_No_Txt: '18000.000', Municipality: '610 - PINEY (RM)' }),
  ];
  const groups = groupParcelsForSnapshots(features);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.members.length === 1));
});

await test('mixed set: two comps + two singles → 4 frames', () => {
  const features = [
    parcel({ Roll_No_Txt: '83100.000', Municipality: '610 - PINEY (RM)', _saleGroupId: 1 }),
    parcel({ Roll_No_Txt: '83200.000', Municipality: '610 - PINEY (RM)', _saleGroupId: 1 }),
    parcel({ Roll_No_Txt: '196550.000', Municipality: '612 - STUARTBURN (RM)', _saleGroupId: 2 }),
    parcel({ Roll_No_Txt: '196800.000', Municipality: '612 - STUARTBURN (RM)', _saleGroupId: 2 }),
    parcel({ Roll_No_Txt: '225600.000', Municipality: '610 - PINEY (RM)' }),
    parcel({ Roll_No_Txt: '171650.000', Municipality: '612 - STUARTBURN (RM)' }),
  ];
  assert.equal(groupParcelsForSnapshots(features).length, 4);
});

await test('ordered by muni code then first roll, so each muni is contiguous', () => {
  const features = [
    parcel({ Roll_No_Txt: '171650.000', Municipality: '612 - STUARTBURN (RM)' }),
    parcel({ Roll_No_Txt: '225600.000', Municipality: '610 - PINEY (RM)' }),
    parcel({ Roll_No_Txt: '18000.000', Municipality: '610 - PINEY (RM)' }),
    parcel({ Roll_No_Txt: '96100.000', Municipality: '612 - STUARTBURN (RM)' }),
  ];
  const order = groupParcelsForSnapshots(features)
    .map((g) => `${g.muniCode}/${g.members[0].properties.Roll_No_Txt}`);
  assert.deepEqual(order, ['610/18000.000', '610/225600.000', '612/96100.000', '612/171650.000']);
});

await test('parcels with no geometry are dropped (nothing to frame)', () => {
  const features = [
    parcel({ Roll_No_Txt: '1.000', Municipality: '610 - PINEY (RM)' }, null),
    parcel({ Roll_No_Txt: '2.000', Municipality: '610 - PINEY (RM)' }),
  ];
  assert.equal(groupParcelsForSnapshots(features).length, 1);
});

await test('a comp straddling a boundary reports both munis', () => {
  const features = [
    parcel({ Roll_No_Txt: '100.000', Municipality: '610 - PINEY (RM)', Muni_Name_With_Typ: 'PINEY (RM)', _saleGroupId: 5 }),
    parcel({ Roll_No_Txt: '200.000', Municipality: '612 - STUARTBURN (RM)', Muni_Name_With_Typ: 'STUARTBURN (RM)', _saleGroupId: 5 }),
  ];
  const groups = groupParcelsForSnapshots(features);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].muniNames, ['PINEY (RM)', 'STUARTBURN (RM)']);
});

await test('missing muni / roll sort last without corrupting the sort', () => {
  const features = [
    parcel({ Roll_No_Txt: 'n/a', Municipality: 'PINEY' }),
    parcel({ Roll_No_Txt: '18000.000', Municipality: '610 - PINEY (RM)' }),
  ];
  const groups = groupParcelsForSnapshots(features);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].members[0].properties.Roll_No_Txt, '18000.000');
});

await test('empty / missing input', () => {
  assert.deepEqual(groupParcelsForSnapshots([]), []);
  assert.deepEqual(groupParcelsForSnapshots(undefined), []);
});

// ---------- countSnapshotFrames ----------

console.log('\ncountSnapshotFrames');

await test('counts frames, not parcels', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      parcel({ Roll_No_Txt: '83100.000', Municipality: '610 - PINEY (RM)', _saleGroupId: 1 }),
      parcel({ Roll_No_Txt: '83200.000', Municipality: '610 - PINEY (RM)', _saleGroupId: 1 }),
      parcel({ Roll_No_Txt: '225600.000', Municipality: '610 - PINEY (RM)' }),
    ],
  };
  assert.equal(fc.features.length, 3);
  assert.equal(countSnapshotFrames(fc), 2);
});

await test('empty FC → 0 (button stays disabled)', () => {
  assert.equal(countSnapshotFrames({ type: 'FeatureCollection', features: [] }), 0);
  assert.equal(countSnapshotFrames(null), 0);
});

// ---------- snapshotBaseName ----------

console.log('\nsnapshotBaseName');

await test('no site column keeps the muniCode-roll name', () => {
  const members = [parcel({ Roll_No_Txt: '225600.000', Municipality: '610 - PINEY (RM)' })];
  assert.equal(snapshotBaseName(members, 'jpg'), '610-225600.jpg');
});

await test('site column leads the name so files sort in report order', () => {
  const members = [parcel({ Roll_No_Txt: '225600.000', Municipality: '610 - PINEY (RM)', _siteNo: '10' })];
  assert.equal(snapshotBaseName(members, 'jpg'), '10-610-225600.jpg');
});

await test('a 2-parcel comp names both rolls and the count', () => {
  const members = ['196550.000', '196800.000'].map((r) => parcel({
    Roll_No_Txt: r, Municipality: '612 - STUARTBURN (RM)', _siteNo: '64',
  }));
  assert.equal(snapshotBaseName(members, 'jpg'), '64-612-196550_196800-2p.jpg');
});

await test('a 6-parcel comp names the first 3 rolls and the full count', () => {
  const members = ['83100.000', '83200.000', '85200.000', '86300.000', '86400.000', '93000.000']
    .map((r) => parcel({ Roll_No_Txt: r, Municipality: '610 - PINEY (RM)', _siteNo: '24' }));
  assert.equal(snapshotBaseName(members, 'jpg'), '24-610-83100_83200_85200-6p.jpg');
});

await test('exactly 3 parcels: every roll named, count still appended', () => {
  const members = ['100.000', '200.000', '300.000']
    .map((r) => parcel({ Roll_No_Txt: r, Municipality: '610 - PINEY (RM)' }));
  assert.equal(snapshotBaseName(members, 'jpg'), '610-100_200_300-3p.jpg');
});

await test('a single-parcel frame carries no count suffix', () => {
  const members = [parcel({ Roll_No_Txt: '83100.000', Municipality: '610 - PINEY (RM)', _siteNo: '24' })];
  assert.equal(snapshotBaseName(members, 'jpg'), '24-610-83100.jpg');
});

await test('named rolls follow member order, which the grouper sorts by roll', () => {
  const features = ['93000.000', '83100.000', '85200.000', '83200.000'].map((r) => parcel({
    Roll_No_Txt: r, Municipality: '610 - PINEY (RM)', _saleGroupId: 1, _siteNo: '24',
  }));
  const [group] = groupParcelsForSnapshots(features);
  assert.equal(snapshotBaseName(group.members, 'jpg'), '24-610-83100_83200_85200-4p.jpg');
});

await test('sub-roll suffixes other than .000 are kept', () => {
  const members = [parcel({ Roll_No_Txt: '123456.010', Municipality: '187 - DE SALABERRY (RM)' })];
  assert.equal(snapshotBaseName(members, 'jpg'), '187-123456.010.jpg');
});

await test('missing municipality / roll fall back to NA', () => {
  assert.equal(snapshotBaseName([parcel({})], 'jpg'), 'NA-NA.jpg');
  assert.equal(snapshotBaseName([], 'jpg'), 'NA-NA.jpg');
});

await test('path-hostile characters are sanitized out of each segment', () => {
  const members = [parcel({ Roll_No_Txt: '900.000', Municipality: '610 - PINEY (RM)', _siteNo: 'A/B 1' })];
  assert.equal(snapshotBaseName(members, 'jpg'), 'A_B_1-610-900.jpg');
});

// ---------- siteLabel ----------

console.log('\nsiteLabel');

await test('reads the first member that carries a site #', () => {
  const members = [parcel({ Roll_No_Txt: '1.000' }), parcel({ Roll_No_Txt: '2.000', _siteNo: '24' })];
  assert.equal(siteLabel(members), '24');
  assert.equal(siteLabel([parcel({ Roll_No_Txt: '1.000' })]), '');
});

// ---------- summary ----------

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) {
  console.log('Failures:');
  for (const f of fails) console.log(`  - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
