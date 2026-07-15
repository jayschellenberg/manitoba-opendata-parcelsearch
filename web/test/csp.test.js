import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
const mapSource = readFileSync(new URL('../src/map.js', import.meta.url), 'utf8');
const csp = vercel.headers
  .flatMap((entry) => entry.headers || [])
  .find((header) => header.key.toLowerCase() === 'content-security-policy')
  ?.value || '';

const glyphUrl = mapSource.match(/glyphs:\s*['"](https:\/\/[^/'"]+)/)?.[1];

assert.equal(glyphUrl, 'https://demotiles.maplibre.org');
assert.match(csp, /connect-src[^;]*https:\/\/demotiles\.maplibre\.org(?:\s|;)/);
assert.doesNotMatch(csp, /script-src[^;]*'unsafe-eval'/);

console.log('csp.test.js: MapLibre glyph host is allowed without unsafe-eval');
