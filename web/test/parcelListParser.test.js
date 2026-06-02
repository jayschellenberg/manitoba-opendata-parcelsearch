// Unit tests for lib/parcelListParser.js.
//
// The parser is pure (no I/O, no module state), so node can exercise
// the full surface without bundling. Run: cd web && node
// test/parcelListParser.test.js

import assert from 'node:assert/strict';
import {
  parseLegalToken,
  gridNeedle,
  parseParcelList,
  applyMapping,
  validateMapping,
  cleanCell,
} from '../src/lib/parcelListParser.js';

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

// ---- A canonicalRoll shim mirroring arcgis.js exactly so the
//      mapping tests can verify the canonical-form output. ----
function canonicalRoll(input) {
  if (input == null) return '';
  const s = String(input).trim();
  if (s === '') return '';
  const m = s.match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return s;
  const whole = m[1];
  const frac  = (m[2] || '').padEnd(3, '0').slice(0, 3);
  return `${whole}.${frac}`;
}

// ---------- parseLegalToken ----------

console.log('parseLegalToken');

await test('grid form: NW26-2-13E', () => {
  const t = parseLegalToken('NW26-2-13E');
  assert.equal(t.kind, 'grid');
  assert.equal(t.qq, 'NW');
  assert.equal(t.sec, 26);
  assert.equal(t.twp, 2);
  assert.equal(t.rng, 13);
  assert.equal(t.dir, 'E');
});

await test('grid form: SW25-13-2W', () => {
  const t = parseLegalToken('SW25-13-2W');
  assert.equal(t.kind, 'grid');
  assert.equal(t.dir, 'W');
  assert.equal(t.twp, 13);
  assert.equal(t.rng, 2);
});

await test('grid form: lowercase passes', () => {
  const t = parseLegalToken('nw26-2-13e');
  assert.equal(t.kind, 'grid');
  assert.equal(t.qq, 'NW');
});

await test('grid form: surrounding whitespace + quotes stripped', () => {
  const t = parseLegalToken('  "  NE3-1-11E  "  ');
  assert.equal(t.kind, 'grid');
  assert.equal(t.qq, 'NE');
});

await test('LBP form: 5-2-31654', () => {
  const t = parseLegalToken('5-2-31654');
  assert.equal(t.kind, 'lbp');
  assert.equal(t.lot, 5);
  assert.equal(t.block, 2);
  assert.equal(t.plan, 31654);
});

await test('unparseable: junk', () => {
  const t = parseLegalToken('hello world');
  assert.equal(t.kind, 'unparseable');
  assert.equal(t.raw, 'hello world');
});

await test('unparseable: empty', () => {
  const t = parseLegalToken('');
  assert.equal(t.kind, 'unparseable');
});

await test('unparseable: missing direction', () => {
  const t = parseLegalToken('NW26-2-13');
  assert.equal(t.kind, 'unparseable');
});

// ---------- gridNeedle ----------

console.log('\ngridNeedle');

await test('matches normalizeLegalText: NW26-2-13E → NW26213E', () => {
  const n = gridNeedle(parseLegalToken('NW26-2-13E'));
  assert.equal(n, 'NW26213E');
});

await test('empty for LBP and unparseable', () => {
  assert.equal(gridNeedle(parseLegalToken('5-2-31654')), '');
  assert.equal(gridNeedle(parseLegalToken('junk')), '');
});

// ---------- parseParcelList: tokenizer + detection ----------

console.log('\nparseParcelList');

await test('TSV with header: Legal Desc / Roll No.', () => {
  const text = [
    'Legal Desc\tRoll No.',
    'NW26-2-13E\t218600',
    'NW27-2-13E\t219000',
  ].join('\n');
  const p = parseParcelList(text);
  assert.deepEqual(p.headers, ['Legal Desc', 'Roll No.']);
  assert.equal(p.columns.length, 2);
  assert.deepEqual(p.guesses, ['legal', 'roll']);
  assert.equal(p.columns[0][0], 'NW26-2-13E');
  assert.equal(p.columns[1][0], '218600');
});

await test('TSV without header (data starts row 1)', () => {
  const text = [
    'NW26-2-13E\t218600',
    'NW27-2-13E\t219000',
  ].join('\n');
  const p = parseParcelList(text);
  assert.equal(p.headers, null);
  assert.equal(p.columns[0].length, 2);
  assert.deepEqual(p.guesses, ['legal', 'roll']);
});

await test('CSV form', () => {
  const text = [
    'Legal Desc,Roll No.',
    'NW26-2-13E,218600',
    'NW27-2-13E,219000',
  ].join('\n');
  const p = parseParcelList(text);
  assert.deepEqual(p.headers, ['Legal Desc', 'Roll No.']);
  assert.equal(p.columns[1][1], '219000');
});

await test('quoted cell with embedded tab decodes correctly', () => {
  // Mirror the real user-data oddity: '"\t45000"' as a single TSV cell.
  const text = 'NW19-1-12E\t"\t45000"';
  const p = parseParcelList(text);
  assert.equal(p.headers, null);
  assert.equal(p.columns[0][0], 'NW19-1-12E');
  assert.equal(p.columns[1][0], '45000');
});

await test('3-column with muni #', () => {
  const text = [
    'Legal Desc\tRoll No.\tMuni #',
    'NW26-2-13E\t218600\t275',
    'NW27-2-13E\t219000\t275',
  ].join('\n');
  const p = parseParcelList(text);
  assert.deepEqual(p.guesses, ['legal', 'roll', 'muni']);
});

await test('4-column with title #', () => {
  const text = [
    'Legal\tRoll #\tMuni\tTitle #',
    'NW26-2-13E\t218600\t275\t2476500',
    'NW27-2-13E\t219000\t275\t2476501',
  ].join('\n');
  const p = parseParcelList(text);
  assert.deepEqual(p.guesses, ['legal', 'roll', 'muni', 'title']);
});

await test('LBP row classifies as legal column', () => {
  const text = [
    'Legal\tRoll #',
    '5-2-31654\t93075',
  ].join('\n');
  const p = parseParcelList(text);
  assert.equal(p.guesses[0], 'legal');
  assert.equal(p.guesses[1], 'roll');
});

await test('full user-sample: 45 rows, mixed quoting and whitespace', () => {
  const text = `Legal Desc\tRoll No.
NW26-2-13E\t218600
NW27-2-13E\t219000
NE27-2-13E\t218900
NE10-1-14E\t79500
NW23-2-14E\t233000
SW23-2-14E\t233200
NW2-2-11E\t169700
SW11-2-11E\t173800
NW12-1-11E\t22800
NE13-1-11E\t23100
SW34-1-11E\t33925
NE2-2-11E\t169600
NW26-2-14E\t234600
SW26-2-14E\t234900
SW30-1-12E\t51550
NE24-1-11E\t27700
SW13-1-11E\t23550
NE14-1-11E\t23600
NW19-1-12E\t"\t45000"
NW2-1-11E\t18300
"\tNE3-1-11E"\t18600
SW3-1-11E\t19000
SE3-1-11E\t18900
SE2-1-11E\t18400
SW2-1-11E\t18500
SE25-1-11E\t30100
SE25-1-11E\t30150
NW21-13-3E\t129300
SE25-13-2W\t47100
SW25-13-2W\t47200
SE22-14-2E\t179800
NW1-14-2E\t163300
SW1-14-2E\t"\t163500"
SE2-14-2E\t"\t164000"
SE7-14-3E\t190600
SW35-13-2E\t"\t113100"
NW35-13-2E\t112900
SW2-14-2E\t"\t164200"
SW2-14-2E\t"\t164100"
SW22-14-1E\t155600
SW5-14-3E\t"\t189800"
SW5-14-3E\t"\t189700"
NW24-13-2E\t98400
SW25-13-2E\t"\t99200"
"\tNW32-13-3E"\t132300
5-2-31654\t93075`;
  const p = parseParcelList(text);
  assert.deepEqual(p.headers, ['Legal Desc', 'Roll No.']);
  // 46 rows including the LBP one + 1 header → 46 body rows.
  assert.equal(p.columns[0].length, 46);
  assert.deepEqual(p.guesses, ['legal', 'roll']);
  // Spot-check quoted-cell decode.
  const idxOf45k = p.columns[1].findIndex((v) => v === '45000');
  assert.ok(idxOf45k >= 0, 'expected 45000 to appear in roll column');
  // Spot-check the LBP row.
  const lbpIdx = p.columns[0].findIndex((v) => v === '5-2-31654');
  assert.ok(lbpIdx >= 0);
  assert.equal(p.columns[1][lbpIdx], '93075');
});

await test('header detection skipped when first row contains a legal token', () => {
  const text = 'NW26-2-13E\t218600\nNW27-2-13E\t219000';
  const p = parseParcelList(text);
  assert.equal(p.headers, null);
  assert.equal(p.columns[0].length, 2);
});

await test('empty input yields empty result', () => {
  const p = parseParcelList('');
  assert.equal(p.columns.length, 0);
  assert.deepEqual(p.guesses, []);
});

// ---------- applyMapping ----------

console.log('\napplyMapping');

await test('basic 2-column mapping yields canonical rolls + parsed legals', () => {
  const text = 'NW26-2-13E\t218600\nNW27-2-13E\t219000';
  const p = parseParcelList(text);
  const m = applyMapping(p, ['legal', 'roll'], { canonicalRoll });
  assert.equal(m.rows.length, 2);
  assert.equal(m.rows[0].roll, '218600.000');
  assert.equal(m.rows[0].legal.kind, 'grid');
  assert.equal(m.rows[0].muniNo, null);
  assert.equal(m.rows[0].title, '');
});

await test('muni column populated as number', () => {
  const text = 'NW26-2-13E\t218600\t275\nNW27-2-13E\t219000\t275';
  const p = parseParcelList(text);
  const m = applyMapping(p, ['legal', 'roll', 'muni'], { canonicalRoll });
  assert.equal(m.rows[0].muniNo, 275);
});

await test('title column trimmed and preserved as string', () => {
  const text = 'NW26-2-13E\t218600\t2476500\nNW27-2-13E\t219000\tCT 2476501';
  const p = parseParcelList(text);
  const m = applyMapping(p, ['legal', 'roll', 'title'], { canonicalRoll });
  assert.equal(m.rows[0].title, '2476500');
  assert.equal(m.rows[1].title, 'CT 2476501');
});

await test('ignore column drops cell from mapping', () => {
  const text = 'NW26-2-13E\tSKIP\t218600';
  const p = parseParcelList(text);
  const m = applyMapping(p, ['legal', 'ignore', 'roll'], { canonicalRoll });
  assert.equal(m.rows[0].roll, '218600.000');
  assert.equal(m.rows[0].title, '');
});

await test('duplicate field mapping flagged as issue', () => {
  const text = '218600\t218700';
  const p = parseParcelList(text);
  const m = applyMapping(p, ['roll', 'roll'], { canonicalRoll });
  assert.equal(m.issues.length, 1);
  assert.equal(m.issues[0].kind, 'duplicateField');
});

await test('lineNo accounts for header offset', () => {
  const text = 'Legal\tRoll\nNW26-2-13E\t218600\nNW27-2-13E\t219000';
  const p = parseParcelList(text);
  const m = applyMapping(p, ['legal', 'roll'], { canonicalRoll });
  assert.equal(m.rows[0].lineNo, 2);
  assert.equal(m.rows[1].lineNo, 3);
});

// ---------- validateMapping ----------

console.log('\nvalidateMapping');

await test('passes when at least one identifier mapped', () => {
  assert.equal(validateMapping(['roll', 'legal']), null);
  assert.equal(validateMapping(['roll', 'muni']), null);
  assert.equal(validateMapping(['roll', 'title']), null);
});

await test('fails when no identifier mapped (roll alone)', () => {
  const msg = validateMapping(['roll', 'ignore']);
  assert.ok(msg && msg.includes('Muni'), `expected an error, got: ${msg}`);
});

await test('fails on empty mapping', () => {
  assert.ok(validateMapping(['ignore', 'ignore']) != null);
});

// ---------- cleanCell ----------

console.log('\ncleanCell');

await test('strips surrounding double-quotes', () => {
  assert.equal(cleanCell('"foo"'), 'foo');
});

await test('strips NBSPs', () => {
  assert.equal(cleanCell('foo bar'), 'foo bar');
});

await test('collapses internal whitespace', () => {
  assert.equal(cleanCell('NW   26'), 'NW 26');
});

// ---------- summary ----------

const fails = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - fails.length}/${results.length} passed`);
if (fails.length > 0) {
  console.log('Failures:');
  for (const f of fails) console.log(`  - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
