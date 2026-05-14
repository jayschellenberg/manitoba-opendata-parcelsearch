// Web Worker that owns the parsed legal-index in module scope and
// handles search / lookup / metadata requests via postMessage. Moving
// the 136 MB JSON.parse off the main thread eliminates the multi-
// hundred-millisecond freeze that used to land on every first-search
// after page load. Match-set results are small (≤1000 records, mostly
// short strings), so structured-clone back to the main thread is
// cheap.
//
// All real logic lives in legalIndex.core.js so the same code paths
// run in node tests (where Workers aren't available) via the
// fallback in legalIndex.js. This file is just the transport.

import {
  parseLegalIndex,
  searchLegalIndex,
  lookupLegalRecordsByParcelKeys,
} from '../legalIndex.core.js';

let parsed = null;

self.addEventListener('message', async (ev) => {
  const { id, type, payload } = ev.data || {};
  try {
    let result;
    if (type === 'load')         result = await loadFromUrls(payload);
    else if (type === 'metadata') result = parsed?.metadata || null;
    else if (type === 'search')   result = searchLegalIndex(parsed, payload);
    else if (type === 'lookup')   result = lookupLegalRecordsByParcelKeys(parsed, payload?.keys || []);
    else throw new Error(`Unknown message type: ${type}`);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});

async function loadFromUrls({ localUrl, proxyUrl }) {
  if (parsed) return parsed.metadata;
  let json = null;
  try {
    const res = await fetch(localUrl);
    if (res.ok) json = await res.json();
  } catch { /* fall through to proxy */ }
  if (!json && proxyUrl) {
    const res = await fetch(proxyUrl);
    if (!res.ok) {
      throw new Error(
        `Legal index unavailable: ${localUrl} failed and ${proxyUrl} returned ${res.status}.`
      );
    }
    json = await res.json();
  }
  parsed = parseLegalIndex(json);
  return parsed.metadata;
}
