// Web Worker that owns the parsed assessment-index. Mirrors
// legalIndex.worker.js — see that file's comment for the full
// rationale.

import { versionedDatasetUrl } from '../manifest.js';
import {
  parseAssessmentIndex,
  lookupAssessment as lookupAssessmentCore,
} from '../assessmentIndex.core.js';

let parsed = null;

self.addEventListener('message', async (ev) => {
  const { id, type, payload } = ev.data || {};
  try {
    let result;
    if (type === 'load')         result = await loadFromUrls(payload);
    else if (type === 'metadata') result = parsed?.metadata || null;
    else if (type === 'lookup')   result = lookupAssessmentCore(parsed, payload);
    else throw new Error(`Unknown message type: ${type}`);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});

async function loadFromUrls({ localUrl, r2Url, proxyUrl }) {
  if (parsed) return parsed.metadata;
  let json = null;
  try {
    const res = await fetch(localUrl);
    if (res.ok) json = await res.json();
  } catch { /* fall through to R2 */ }
  if (!json && r2Url) {
    // R2 copy, gzip at rest; the proxy below is only the fallback.
    try {
      const res = await fetch(await versionedDatasetUrl(r2Url, 'assessment_index'));
      if (res.ok) json = await res.json();
    } catch { /* fall through to proxy */ }
  }
  if (!json && proxyUrl) {
    // Versioned by the manifest's build stamp: see versionedUrl in ../manifest.js.
    const res = await fetch(await versionedDatasetUrl(proxyUrl, 'assessment_index'));
    if (!res.ok) {
      throw new Error(
        `Assessment-index unavailable: ${localUrl} failed and ${proxyUrl} returned ${res.status}.`
      );
    }
    json = await res.json();
  }
  parsed = parseAssessmentIndex(json);
  return parsed.metadata;
}
