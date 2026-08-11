// Unit tests for lib/delimitedRows.js — countDataRows().
//
// Regression cover for the inflated import count. salesStore counted a
// shard's rows by splitting the raw CSV on newlines, but the MAO sales export
// stacks a multi-parcel sale's per-parcel values on newlines INSIDE quoted
// cells, so every extra parcel line read as another sale. The 48-shard export
// reported 292,039 sales against its true 228,957 — and the gap grew with the
// share of multi-parcel sales rather than being a fixed offset, so it could
// not be spotted as an obvious constant.
//
// Run: cd web && node test/delimitedRows.test.js

import assert from 'node:assert/strict';
import { countDataRows, tokenizeRows } from '../src/lib/delimitedRows.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(1);
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push(0);
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const HEADER = 'Sale Date,Consideration,Municipality,Roll Number';

test('counts plain rows, excluding the header', () => {
  assert.equal(countDataRows(`${HEADER}\na,b,c,d\ne,f,g,h\n`), 2);
});

test('a header-only file has no data rows, and empty input is 0 (not -1)', () => {
  assert.equal(countDataRows(`${HEADER}\n`), 0);
  assert.equal(countDataRows(HEADER), 0);
  assert.equal(countDataRows(''), 0);
  assert.equal(countDataRows(null), 0);
});

test('THE BUG: newlines inside quoted cells are not new rows', () => {
  // One multi-parcel sale, three parcels stacked in two quoted cells.
  const csv = `${HEADER}\n"Jun 02, 2026",$1,"RM A\nRM A\nRM A","24400.000\n24500.000\n24700.000"\n`;
  assert.equal(countDataRows(csv), 1, 'one sale, not three');
  // ...and it agrees with the real tokenizer, which is the parser's own view.
  assert.equal(tokenizeRows(csv, ',').length - 1, 1);
});

test('mixed single- and multi-parcel rows count as one row each', () => {
  const csv = [
    HEADER,
    '"Jul 21, 2026",$250000,TOWN OF ALTONA,123456.000',
    '"Jun 02, 2026",$1,"RM A\nRM A","24400.000\n24500.000"',
    '"May 15, 2026",$98700,TOWN OF ALTONA,654321.000',
  ].join('\n') + '\n';
  assert.equal(countDataRows(csv), 3);
  assert.equal(tokenizeRows(csv, ',').length - 1, 3);
});

test('escaped "" inside a quoted cell does not end the quoted run', () => {
  // The "" is literal, so the newline after it is still inside the cell.
  const csv = `${HEADER}\na,b,"say ""hi""\nsecond line",d\n`;
  assert.equal(countDataRows(csv), 1);
});

test('blank lines are not rows; a missing trailing newline still counts', () => {
  assert.equal(countDataRows(`${HEADER}\na,b,c,d\n\n\ne,f,g,h`), 2);
  assert.equal(countDataRows(`${HEADER}\na,b,c,d`), 1);
});

test('\\r\\n and bare \\r line endings count once, not twice', () => {
  assert.equal(countDataRows(`${HEADER}\r\na,b,c,d\r\ne,f,g,h\r\n`), 2);
  assert.equal(countDataRows(`${HEADER}\ra,b,c,d\re,f,g,h`), 2);
});

test('a quoted cell containing \\r\\n stays one row', () => {
  assert.equal(countDataRows(`${HEADER}\r\na,b,"x\r\ny",d\r\n`), 1);
});

test('agrees with the tokenizer across a shard-shaped sample', () => {
  // Belt and braces: whatever the tokenizer thinks the row count is, the
  // cheap counter must agree — it exists only to avoid materializing fields.
  const rows = [HEADER];
  for (let i = 0; i < 50; i++) {
    rows.push(i % 3 === 0
      ? `"Jan 0${(i % 9) + 1}, 2026",$1,"RM A\nRM A","1${i}.000\n2${i}.000"`
      : `"Jan 0${(i % 9) + 1}, 2026",$2,TOWN,3${i}.000`);
  }
  const csv = rows.join('\n') + '\n';
  assert.equal(countDataRows(csv), 50);
  assert.equal(tokenizeRows(csv, ',').length - 1, 50);
});

const passed = results.reduce((a, b) => a + b, 0);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
