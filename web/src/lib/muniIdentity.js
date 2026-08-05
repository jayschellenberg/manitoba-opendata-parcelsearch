// Municipality-identity matching for the MASC river-lot overlay.
//
// Manitoba municipality names arrive in many forms across data sources
// — "DE SALABERRY (RM)", "RM OF DE SALABERRY", "De Salaberry", dotted
// "ST." vs "STE", accented "St-Francois" — and split-boundary parish
// river lots are often tagged to an enclave Town while the MASC source
// or Roll Entry parcel sits with the surrounding RM (the De Salaberry /
// St-Pierre-Jolys case). This module normalizes both sides to
// a comparable {name, type} identity and decides whether two refer to
// the same municipality, with an optional type-agnostic fallback for
// those enclave cases. Pure string logic — extracted from main.js for
// isolated testing.

/** Canonicalize a municipality type token ("RURAL MUNICIPALITY" -> "RM"). */
export function normalizeMuniType(value) {
  const t = String(value || '').toUpperCase().trim();
  if (t === 'RURAL MUNICIPALITY') return 'RM';
  return t;
}

/**
 * Spelling reconciliations for Manitoba municipality names — cases where two
 * sources spell the same place differently and no amount of punctuation
 * stripping closes the gap.
 *
 * Shared deliberately. This list also drives the shard-lookup key builder in
 * arcgis.js, which keeps a compact no-separator form and so cannot reuse
 * parseMuniIdentity() wholesale. The two used to carry their own copies of
 * these four rules, which meant adding a fifth alias in one place silently
 * left the other unable to match it. Applied to an already-uppercased,
 * accent- and punctuation-stripped string.
 */
export const MUNI_NAME_RECONCILIATIONS = [
  [/\bMTN\b/g, 'MOUNTAIN'],
  [/\bFRANCOIS\b/g, 'FRANCIS'],
  [/\bDESALABERRY\b/g, 'DE SALABERRY'],
  [/\bSAINTE\b/g, 'STE'],
];

/** Apply MUNI_NAME_RECONCILIATIONS in order. */
export function reconcileMuniSpelling(value) {
  let s = String(value ?? '');
  for (const [pattern, replacement] of MUNI_NAME_RECONCILIATIONS) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

/**
 * Parse a raw municipality string into { name, type }. Strips accents,
 * punctuation, and the type token (whether parenthetical "(RM)", "RM OF
 * ...", or a trailing "... RM"), and applies a handful of spelling
 * reconciliations (MTN->MOUNTAIN, FRANCOIS->FRANCIS, DESALABERRY->DE
 * SALABERRY, SAINTE->STE). `type` is null when no type token is present.
 */
export function parseMuniIdentity(value) {
  let s = String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\./g, '')
    .replace(/_/g, ' ')
    .replace(/&/g, ' AND ')
    .replace(/\s+/g, ' ')
    .trim();
  let type = null;

  const parenthetical = s.match(/\((RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE)\)\s*$/);
  if (parenthetical) {
    type = normalizeMuniType(parenthetical[1]);
    s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  s = s.replace(
    /\b(RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE)\s+OF\b/g,
    (_, t) => {
      type ||= normalizeMuniType(t);
      return '';
    },
  );
  s = s.replace(/\s+(RM|RURAL MUNICIPALITY|MUNICIPALITY|TOWN|CITY|VILLAGE)$/g, (_, t) => {
    type ||= normalizeMuniType(t);
    return '';
  });
  s = reconcileMuniSpelling(s)
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { name: s, type };
}

/**
 * True when two municipality strings refer to the same place. Names
 * must match after normalization. Types must match too, UNLESS
 * `allowTypeFallback` is set — then a same-name/different-type pair
 * still matches (the enclave-Town vs surrounding-RM case).
 */
export function muniIdentitiesMatch(sourceMuni, selectedMuni, { allowTypeFallback = false } = {}) {
  const source = parseMuniIdentity(sourceMuni);
  const selected = parseMuniIdentity(selectedMuni);
  if (!source.name || !selected.name || source.name !== selected.name) return false;
  if (!source.type || !selected.type || source.type === selected.type) return true;
  return allowTypeFallback;
}

/** The distinct municipality strings a MASC river-lot feature carries. */
export function featureMascMunis(feature) {
  const p = feature?.properties || {};
  return [
    p.muni,
    p.rating_muni,
    p.ratingMuni,
    p.source_muni,
  ].filter((value, idx, values) => value && values.indexOf(value) === idx);
}

/**
 * Filter rated river-lot features to those belonging to the selected
 * municipality. Prefers exact typed matches; only when none exist does
 * it fall back to the shared bare name so split-boundary parish lots
 * (boundary-tagged to an enclave Town) still surface for RM users.
 */
export function filterMascRiverlotsForMuni(features, selectedMuni) {
  const exact = features.filter((f) => featureMascMunis(f).some((muni) => (
    muniIdentitiesMatch(muni, selectedMuni, { allowTypeFallback: false })
  )));
  if (exact.length > 0) return exact;

  // Some long parish lots are boundary-tagged to an enclave Town while
  // the MASC source or Roll Entry parcel sits with the surrounding RM.
  // If there is no exact typed match, fall back to the shared bare
  // muni name so those rated river lots still surface for parcel users.
  return features.filter((f) => featureMascMunis(f).some((muni) => (
    muniIdentitiesMatch(muni, selectedMuni, { allowTypeFallback: true })
  )));
}
