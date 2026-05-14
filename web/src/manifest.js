// Client-side reader for /data/manifest.json — a tiny ~2 KB file
// (built by web/scripts/build-manifest.js) carrying generated-at
// timestamps, row counts, and file sizes for every data asset the
// app ships.
//
// The footer reads ONLY the manifest to surface "Data refreshed
// YYYY-MM-DD" — no more loading the 136 MB legal-index just to read
// its metadata block. Each data module can also consult the manifest
// to discover its asset's url and schema_version, falling back to
// hardcoded defaults if the manifest is missing or stale.

const MANIFEST_URL = `${import.meta.env?.BASE_URL || '/'}data/manifest.json`;

let manifestPromise = null;

/**
 * Fetch the manifest. Cached at module scope so multiple callers
 * share a single in-flight request. Resolves to the parsed manifest,
 * or null on fetch/parse failure (callers should fall back to their
 * hardcoded defaults).
 */
export async function getManifest() {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json || typeof json !== 'object' || !json.datasets) return null;
      return json;
    } catch {
      return null;
    }
  })();
  return manifestPromise;
}

/**
 * Resolve a dataset entry by name (e.g. 'legal_index',
 * 'assessment_index'). Returns the entry object or null when the
 * manifest is unavailable or doesn't mention the dataset.
 */
export async function getDataset(name) {
  const m = await getManifest();
  return m?.datasets?.[name] || null;
}

/**
 * Convenience accessor for the manifest's own freshness — returns
 * the most-recent generated_at across all listed datasets, or
 * manifest.generated_at when no dataset carries its own. Useful for
 * footer copy like "Data refreshed YYYY-MM-DD" without picking a
 * single dataset to prioritise.
 */
export async function getOverallFreshness() {
  const m = await getManifest();
  if (!m) return null;
  let latest = null;
  for (const entry of Object.values(m.datasets || {})) {
    const ts = entry.generated_at || entry.modified_at;
    if (!ts) continue;
    if (latest == null || ts > latest) latest = ts;
  }
  return latest || m.generated_at || null;
}

// Test-only reset hook so the cache between tests doesn't carry over.
export function _resetManifestCache() { manifestPromise = null; }
