// External-URL allowlist — the single guard between untrusted open-data
// URL fields and anchor hrefs / window.open. Manitoba Assessment Online
// report links, the contaminated-sites registry CSV, and other sources
// we don't control feed values straight into links; this rejects
// anything that isn't http(s) so a javascript: / data: / vbscript: URL
// can't ride in. Previously duplicated verbatim in main.js and map.js.

/**
 * Validate an external URL and return it only when its protocol is one
 * we trust (http / https). Relative inputs resolve against the current
 * origin. Returns null for empty, unparseable, or non-http(s) URLs.
 */
export function safeExternalUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw), window.location.origin);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch { /* not a parseable URL */ }
  return null;
}
