// Content-Security-Policy guards.
//
// The production CSP lives in vercel.json and is NOT applied by the Vite
// dev server, so a host missing from `connect-src` works perfectly on
// localhost and is silently blocked in production. That is exactly how
// the WALLAS water-rights service shipped broken: the overlays toggled
// on, the fetch was refused by the browser, the client's own error
// handling turned that into an empty layer, and nothing was drawn.
//
// The sweep below is the durable fix — every data-service host the app
// hardcodes has to be reachable under the deployed policy.

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

// ---- every hardcoded data-service host must be in connect-src --------

const connectSrc = (csp.match(/connect-src([^;]*)/)?.[1] || '').trim().split(/\s+/);

/** Does `host` satisfy at least one connect-src entry? Handles the
 *  `https://*.example.com` wildcard form, where `*.` stands for one or
 *  more leading labels. */
function allowedByCsp(host) {
  return connectSrc.some((entry) => {
    if (!entry.startsWith('https://')) return false;
    const pattern = entry.slice('https://'.length);
    if (!pattern.includes('*')) return pattern === host;
    const rx = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*\\\./g, '(?:[^.]+\\.)+')}$`);
    return rx.test(host);
  });
}

// Only the modules that hold service endpoints, and only their URL/BASE/
// CDN constants. A blanket sweep of every https:// literal would drown in
// the ~150 municipal website links in main.js, which are navigation
// targets rather than fetch destinations and have no business in
// connect-src.
const SERVICE_MODULES = ['../src/arcgis.js', '../src/wallas.js'];
const URL_CONST = /\b(?:const|let|var)\s+\w*(?:URL|BASE|CDN)\w*\s*=\s*[`'"](https:\/\/([^/`'"]+))/g;

const found = new Map();   // host -> the module that declares it
for (const rel of SERVICE_MODULES) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
  for (const m of src.matchAll(URL_CONST)) {
    if (!found.has(m[2])) found.set(m[2], rel);
  }
}

assert.ok(found.size > 0, 'expected to find service host constants to check');

const blocked = [...found].filter(([host]) => !allowedByCsp(host));
assert.deepEqual(
  blocked,
  [],
  `these service hosts are fetched by the app but missing from the production CSP connect-src, `
  + `so they will be blocked on the deployed site while working fine on localhost: `
  + blocked.map(([host, mod]) => `${host} (${mod})`).join(', '),
);

// The WALLAS host specifically, called out so the regression that
// prompted this test can never come back silently.
assert.ok(
  allowedByCsp('web43.gov.mb.ca'),
  'Manitoba Water Rights Licensing (WALLAS) must be reachable under the deployed CSP',
);

console.log(`csp.test.js: glyph host allowed without unsafe-eval; ${found.size} service hosts reachable under CSP`);
