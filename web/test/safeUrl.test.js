// Characterization tests for lib/safeUrl.js — the external-URL allowlist
// that keeps javascript:/data:/vbscript: URLs out of links built from
// untrusted open-data fields. Security-relevant; previously untested
// (and duplicated in main.js + map.js).
//
// safeExternalUrl reads window.location.origin to resolve relative
// inputs, so we shim a minimal window — same pattern as the other
// browser-API shims in the test suite.
//
// Run: cd web && node test/safeUrl.test.js

import assert from 'node:assert/strict';

globalThis.window = { location: { origin: 'https://app.example.com' } };

const { safeExternalUrl } = await import('../src/lib/safeUrl.js');

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

console.log('safeExternalUrl');

test('passes absolute http and https URLs through', () => {
  assert.equal(safeExternalUrl('https://www.gov.mb.ca/x'), 'https://www.gov.mb.ca/x');
  assert.equal(safeExternalUrl('http://example.org/a?b=1'), 'http://example.org/a?b=1');
});

test('rejects the dangerous pseudo-protocols', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(safeExternalUrl('JavaScript:alert(1)'), null);   // case-insensitive scheme
  assert.equal(safeExternalUrl('data:text/html,<script>x</script>'), null);
  assert.equal(safeExternalUrl('vbscript:msgbox(1)'), null);
  assert.equal(safeExternalUrl('file:///etc/passwd'), null);
  assert.equal(safeExternalUrl('mailto:a@b.com'), null);
});

test('rejects empty / nullish input', () => {
  assert.equal(safeExternalUrl(''), null);
  assert.equal(safeExternalUrl(null), null);
  assert.equal(safeExternalUrl(undefined), null);
});

test('resolves a relative path against the current origin', () => {
  assert.equal(safeExternalUrl('/api/x'), 'https://app.example.com/api/x');
});

test('a protocol-relative URL inherits the (https) origin scheme', () => {
  // Documented current behaviour: //host resolves to https://host here,
  // which is allowed because the resulting protocol is https.
  assert.equal(safeExternalUrl('//other.example.com/p'), 'https://other.example.com/p');
});

test('coerces a non-string and resolves it as a relative path', () => {
  // String(12345) = "12345" → resolved against the https origin as a
  // relative reference → an allowed https URL. (Characterizes the
  // existing behaviour; nothing here ever produced a non-http scheme.)
  assert.equal(safeExternalUrl(12345), 'https://app.example.com/12345');
});

test('truly unparseable junk returns null, never throws', () => {
  assert.equal(safeExternalUrl('http://['), null);  // malformed → URL throws → null
});

const failed = results.filter((r) => r.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
