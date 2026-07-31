/*
 * What each boot dropdown gets to show, given four probes that can fail
 * independently.
 *
 * Extracted from main.js's populateDropdowns because the interesting part
 * isn't the fetching, it's the degradation, and that had a bug worth
 * pinning: the four probes ran under one Promise.all, so a blip on the
 * ZONING service — which feeds nothing but the zone-category dropdown —
 * rejected the whole batch and left the municipality picker reading
 * "Failed to load" for the rest of the session.
 *
 * Three rules come out of that:
 *   1. A failed zone-category probe affects the zoning dropdown ONLY.
 *   2. When the live muni list doesn't come back, fall back to the snapshot
 *      manifest's muni names — it resolved in the same batch and names
 *      every municipality, so there is no reason to show an error.
 *   3. Falling back that way must NOT flip the app into snapshot mode. One
 *      failed dropdown query is no evidence that parcel queries are broken,
 *      and routing a whole session to static shards off a single blip would
 *      be worse than the blip. Snapshot mode stays driven by `incomplete`,
 *      the partial-republish signal main.js computes from live counts.
 *
 * Pure (no DOM, no network) so node can exercise every combination.
 */

export const MUNI_FAILED_PLACEHOLDER =
  'Failed to load — type to filter parcels another way';
export const MUNI_PLACEHOLDER = 'Any municipality';
export const ZONE_PLACEHOLDER = 'Any zoning category';
export const ZONE_FAILED_PLACEHOLDER =
  'Zoning categories unavailable — reload to retry';

/**
 * @param {Object} probes
 * @param {string[]|null} probes.liveMunis      live Roll_Entry muni list, null if it failed
 * @param {string[]|null} probes.zoneCats       live zone categories, null if it failed
 * @param {string[]} probes.snapshotMunis       muni names from the snapshot manifest ([] if none)
 * @param {boolean} probes.incomplete           live Roll_Entry looks partially published
 * @returns {{
 *   munis: string[], muniPlaceholder: string, muniSource: 'live'|'snapshot'|'snapshot-fallback'|'none',
 *   zoneCats: string[], zonePlaceholder: string,
 *   useSnapshot: boolean,
 * }}
 */
export function resolveDropdownSources({
  liveMunis,
  zoneCats,
  snapshotMunis = [],
  incomplete = false,
} = {}) {
  const live = Array.isArray(liveMunis) ? liveMunis : null;
  const snapshot = Array.isArray(snapshotMunis) ? snapshotMunis : [];
  const haveSnapshot = snapshot.length > 0;

  let munis = live || [];
  let muniSource = live ? 'live' : 'none';
  let useSnapshot = false;

  if (incomplete && haveSnapshot) {
    // Partial republish: the snapshot's full list is the right truth source.
    // Listing 18 live munis when the snapshot has all 186 would leave the
    // user unable to even SELECT most of Manitoba.
    munis = snapshot;
    muniSource = 'snapshot';
    useSnapshot = true;
  } else if (!live?.length && haveSnapshot) {
    // Rule 2 + 3: borrow the names, don't change how parcels are queried.
    munis = snapshot;
    muniSource = 'snapshot-fallback';
  }

  return {
    munis,
    muniSource,
    muniPlaceholder: munis.length ? MUNI_PLACEHOLDER : MUNI_FAILED_PLACEHOLDER,
    zoneCats: Array.isArray(zoneCats) ? zoneCats : [],
    zonePlaceholder: Array.isArray(zoneCats) ? ZONE_PLACEHOLDER : ZONE_FAILED_PLACEHOLDER,
    useSnapshot,
  };
}
