// The three derived properties the Assessment Parcels labels and hover
// popup read off every Roll_Entry parcel: _rollDisplay, _civicAddress
// and (via lib/acres.js) _acres.
//
// Extracted here so there is exactly ONE implementation. Three consumers
// need it and they must not drift:
//   - arcgis.js fetchAllParcelsInMunicipality — the live FeatureServer path
//   - main.js — the search-result and sales-import paths
//   - scripts/build-parcel-tiles.mjs — bakes them into the PMTiles archive
//     at build time, so tiles carry the same values the live path stamps
//     at runtime
//
// The build-time consumer is the reason this is a module rather than three
// copies: a tile archive is rebuilt on a cadence, so a divergence between
// the baked value and the live one would sit there for months looking like
// a data problem rather than a code one.

/** Strip Roll_Entry's `.000` sub-roll suffix for display. Purely
 *  cosmetic — the raw Roll_No_Txt stays the search and join key.
 *  Returns null for a non-string so callers can skip the stamp
 *  entirely rather than write an undefined. */
export function rollDisplay(rollNoTxt) {
  if (typeof rollNoTxt !== 'string') return null;
  return rollNoTxt.endsWith('.000') ? rollNoTxt.slice(0, -4) : rollNoTxt;
}

/**
 * Distill Roll_Entry's Property_Address field into a real civic
 * address or the empty string. The field is a hybrid in source: some
 * parcels carry an actual address ("60 SILVERSIDE DR"), others carry
 * a legal reference ("1--24134", "NE34-2-4W", "DESC NE34-2-4W"). The
 * civic-label symbol layer reads the empty-string output and just
 * doesn't render — so the user sees civic addresses at zoom 16 only
 * for parcels that actually have one.
 *
 * Exclusions (returns '' for any of these):
 *   - empty / whitespace
 *   - starts with "DESC " (legal-description marker)
 *   - only digits + dashes / slashes / spaces / dots — covers
 *     "1--24134", "7-1-2246", "8-7-32457"
 *   - section-township-range pattern with optional direction prefix
 *     and meridian suffix — covers "NE34-2-4W", "NW4-3-1E", "S17-10-5"
 */
const RE_DESC_PREFIX = /^DESC\b/i;
const RE_NUMERIC_REFERENCE = /^[\d\s\-./]+$/;
const RE_SEC_TWP_RNG = /^[NSEW]{0,2}\d+-\d+-\d+[NSEW]?$/i;

export function civicAddressOrEmpty(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (RE_DESC_PREFIX.test(s))       return '';
  if (RE_NUMERIC_REFERENCE.test(s)) return '';
  if (RE_SEC_TWP_RNG.test(s))       return '';
  return s;
}
