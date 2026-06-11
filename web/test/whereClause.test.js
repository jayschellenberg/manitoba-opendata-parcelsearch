// Unit tests for the ArcGIS query-builder internals — the SQL-ish
// WHERE-clause construction every live search flows through. These run
// entirely offline: the builders are pure string functions exposed
// through arcgis.js's test-only _internals export.
//
// The escaping contract matters more than usual here: Esri's SQL92
// dialect has no parameterized queries, so doubled single quotes are
// the ONLY thing standing between user input and the WHERE clause.
//
// Run: cd web && node test/whereClause.test.js

import assert from 'node:assert/strict';

// arcgis.js imports the cache layer, which expects browser storage —
// shim it in-memory exactly like arcgis-cache.test.js does.
function makeFakeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
}
globalThis.localStorage = makeFakeStorage();
globalThis.sessionStorage = makeFakeStorage();

const { _internals, canonicalRoll } = await import('../src/arcgis.js');
const { escapeSql, buildParcelClauses, canonicalRollList, rollKeyWhereClause, chunkRollKeys } = _internals;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'pass' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, status: 'fail', err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('escapeSql');

test('doubles a single quote', () => {
  assert.equal(escapeSql("O'Brien"), "O''Brien");
});

test('doubles every quote, not just the first', () => {
  assert.equal(escapeSql("d'Arcy's"), "d''Arcy''s");
});

test('passes quote-free strings through unchanged', () => {
  assert.equal(escapeSql('STONEWALL (TOWN)'), 'STONEWALL (TOWN)');
});

test('coerces non-strings', () => {
  assert.equal(escapeSql(42), '42');
});

test('leaves SQL wildcards alone (LIKE semantics are intentional)', () => {
  assert.equal(escapeSql('%MAIN_ST%'), '%MAIN_ST%');
});

console.log('\nbuildParcelClauses');

test('address becomes an upper-cased, escaped LIKE clause', () => {
  const clauses = buildParcelClauses({ addressStreet: "o'hara" });
  assert.deepEqual(clauses, [`UPPER(Property_Address) LIKE '%O''HARA%'`]);
});

test('municipality becomes an exact-equality clause with escaping', () => {
  const clauses = buildParcelClauses({ municipality: "ST. O'NEIL (RM)" });
  assert.deepEqual(clauses, [`Muni_Name_With_Typ = 'ST. O''NEIL (RM)'`]);
});

test('duMode zero filters Dwelling_Units = 0', () => {
  assert.deepEqual(buildParcelClauses({ duMode: 'zero' }), ['Dwelling_Units = 0']);
});

test('duMode min uses the floor of duMin', () => {
  assert.deepEqual(buildParcelClauses({ duMode: 'min', duMin: '3' }), ['Dwelling_Units >= 3']);
  assert.deepEqual(buildParcelClauses({ duMode: 'min', duMin: 2.9 }), ['Dwelling_Units >= 2']);
});

test('duMode min clamps junk and negatives to 1', () => {
  assert.deepEqual(buildParcelClauses({ duMode: 'min', duMin: 'abc' }), ['Dwelling_Units >= 1']);
  assert.deepEqual(buildParcelClauses({ duMode: 'min', duMin: -5 }), ['Dwelling_Units >= 1']);
});

test('empty args produce no clauses', () => {
  assert.deepEqual(buildParcelClauses({}), []);
});

test('all filters combine in declaration order', () => {
  const clauses = buildParcelClauses({
    addressStreet: 'main', municipality: 'BRANDON (CITY)', duMode: 'zero',
  });
  assert.equal(clauses.length, 3);
  assert.ok(clauses[0].startsWith('UPPER(Property_Address)'));
  assert.ok(clauses[1].startsWith('Muni_Name_With_Typ'));
  assert.equal(clauses[2], 'Dwelling_Units = 0');
});

console.log('\ncanonicalRoll / canonicalRollList');

test('canonicalRoll pads to three fraction digits', () => {
  assert.equal(canonicalRoll('3600'), '3600.000');
  assert.equal(canonicalRoll('3600.1'), '3600.100');
  assert.equal(canonicalRoll('3600.01'), '3600.010');
  assert.equal(canonicalRoll('3600.5000'), '3600.500'); // defensive truncation
});

test('canonicalRoll passes junk through for the missing-rolls diagnostic', () => {
  assert.equal(canonicalRoll('abc'), 'abc');
  assert.equal(canonicalRoll(''), '');
});

test('canonicalRollList dedupes across input forms', () => {
  // '3600' and '3600.000' canonicalize to the same roll.
  assert.deepEqual(canonicalRollList('3600, 3600.000'), ['3600.000']);
});

test('canonicalRollList accepts comma / ampersand / whitespace separators', () => {
  assert.deepEqual(canonicalRollList('28410&970 966,1000.5'),
    ['28410.000', '970.000', '966.000', '1000.500']);
});

test('canonicalRollList returns [] for empty input', () => {
  assert.deepEqual(canonicalRollList(''), []);
  assert.deepEqual(canonicalRollList(null), []);
});

console.log('\nchunkRollKeys / rollKeyWhereClause');

test('chunkRollKeys splits at the chunk size and dedupes', () => {
  const keys = [
    { muni_no: 302, roll_no_txt: '1.000' },
    { muni_no: 302, roll_no_txt: '2.000' },
    { muni_no: 302, roll_no_txt: '1.000' },  // dupe
    { muni_no: 401, roll_no_txt: '3.000' },
  ];
  const chunks = chunkRollKeys(keys, 2);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], [{ muniNo: 302, roll: '1.000' }, { muniNo: 302, roll: '2.000' }]);
  assert.deepEqual(chunks[1], [{ muniNo: 401, roll: '3.000' }]);
});

test('chunkRollKeys skips malformed keys and accepts camelCase', () => {
  const chunks = chunkRollKeys([
    { muni_no: 'not-a-number', roll_no_txt: '1.000' }, // bad muni
    { muni_no: 302 },                                  // missing roll
    { muniNo: 302.9, rollNoTxt: '5.000' },             // camelCase + truncation
  ], 50);
  assert.deepEqual(chunks, [[{ muniNo: 302, roll: '5.000' }]]);
});

test('rollKeyWhereClause scopes each roll list to its municipality', () => {
  const [chunk] = chunkRollKeys([{ muni_no: 302, roll_no_txt: '123.000' }], 50);
  assert.equal(
    rollKeyWhereClause(chunk),
    `((Municipality LIKE '302 - %' AND Roll_No_Txt IN ('123.000')))`,
  );
});

test('rollKeyWhereClause ORs across municipalities and dedupes rolls', () => {
  const [chunk] = chunkRollKeys([
    { muni_no: 302, roll_no_txt: '1.000' },
    { muni_no: 401, roll_no_txt: '2.000' },
    { muni_no: 401, roll_no_txt: '2.000' },
  ], 50);
  assert.equal(
    rollKeyWhereClause(chunk),
    `((Municipality LIKE '302 - %' AND Roll_No_Txt IN ('1.000')) OR ` +
    `(Municipality LIKE '401 - %' AND Roll_No_Txt IN ('2.000')))`,
  );
});

test('rollKeyWhereClause escapes quotes inside roll text', () => {
  const clause = rollKeyWhereClause([{ muniNo: 302, roll: "1'); DROP--" }]);
  assert.ok(clause.includes("'1''); DROP--'"), `expected doubled quote, got: ${clause}`);
});

test('rollKeyWhereClause returns null for an empty chunk', () => {
  assert.equal(rollKeyWhereClause([]), null);
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
