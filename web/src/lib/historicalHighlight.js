/*
 * As-of-date geometry for the search-result highlight (Historical compare view).
 *
 * The Historical overlay paints a whole municipality's as-of parcels in dashed
 * amber. This module answers the neighbouring question: while an as-of date is
 * active, whose boundary should the YELLOW search-result highlight trace?
 *
 * It has to be the parcel as it stood at the snapshot date. Brandon roll 562264
 * (1501 BRAECREST DR) is the reported case — 12.23 acres on 2025-02-12, 3.78
 * acres today after roll 562314 was carved off it. Highlighting today's remnant
 * under a banner reading "HISTORICAL as of 2025-02-12" asserts the wrong
 * boundary for the date on screen, and the camera fits to the wrong extent on
 * top of it.
 *
 * Roll numbers are unique only WITHIN a municipality, so every lookup is keyed
 * by (muni, roll): a result set spanning several munis — an imported parcel
 * list, a sales upload — must never pick up another muni's parcel that happens
 * to share a roll number.
 *
 * The as-of geometry comes from the CDN display shards, which are simplified to
 * ~2-3 m for visualization. It answers "where was the lot line", not "what does
 * it measure" — callers surface that caveat (DOCUMENTATION.md §5).
 *
 * Pure + dependency-free (GeoJSON in, GeoJSON out) so it unit-tests without
 * MapLibre or the DOM. Roll canonicalization is injected — arcgis.js owns it.
 */

const identityRoll = (v) => String(v ?? '').trim();

/**
 * Comparable (muni, roll) key. Both sides of every lookup carry Roll Entry's
 * own `Muni_Name_With_Typ` — the historical shards are built from the archived
 * Roll Entry download — so case/whitespace folding is all the reconciliation
 * this needs. Returns '' when either half is missing, which callers treat as
 * "not matchable" rather than as a key.
 */
export function muniRollKey(muni, roll, canonicalRoll = identityRoll) {
  const m = String(muni ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  const r = canonicalRoll(roll);
  return m && r ? `${m}|${r}` : '';
}

/**
 * Index a historical parcels shard by (muni, roll) → geometry.
 *
 * A roll can arrive as several features (a parcel split across the shard, or a
 * genuine multi-part lot); they are merged into one MultiPolygon so the whole
 * as-of parcel highlights rather than an arbitrary first part.
 *
 * @param {object} fc  historical parcels FeatureCollection for one muni
 * @param {{canonicalRoll?: Function}} opts
 * @returns {Map<string, object>}  key → GeoJSON Polygon | MultiPolygon
 */
export function indexHistoricalGeometry(fc, { canonicalRoll = identityRoll } = {}) {
  const parts = new Map();
  for (const f of fc?.features || []) {
    const p = f?.properties;
    const g = f?.geometry;
    if (!p || !g || !Array.isArray(g.coordinates)) continue;
    const key = muniRollKey(p.Muni_Name_With_Typ, p.Roll_No_Txt, canonicalRoll);
    if (!key) continue;
    let list = parts.get(key);
    if (!list) { list = []; parts.set(key, list); }
    if (g.type === 'Polygon') list.push(g.coordinates);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) list.push(poly);
  }
  const out = new Map();
  for (const [key, list] of parts) {
    if (!list.length) continue;
    out.set(key, list.length === 1
      ? { type: 'Polygon', coordinates: list[0] }
      : { type: 'MultiPolygon', coordinates: list });
  }
  return out;
}

/**
 * Swap each result parcel's geometry for its as-of geometry.
 *
 * Properties are carried through untouched apart from two stamps, so the popup,
 * the results table, feature-state (starred / group hover, promoted from
 * OBJECTID) and the numbering `_seq` all keep working:
 *   `_asOfGeom`  true  — this outline is the snapshot's, not today's
 *   `_asOfDate`  the snapshot_id, for the popup's "boundary as of" line
 *
 * Features whose roll had no parcel at that date (created since, or in a muni
 * the overlay isn't holding) are returned UNCHANGED — today's boundary is the
 * only one there is — and counted in `missing` so the caller can say so rather
 * than let the user assume every outline moved.
 *
 * Never mutates the input: unmatched features are passed through by reference,
 * matched ones are shallow copies. When nothing matches, the original
 * FeatureCollection object comes straight back.
 *
 * @param {object} fc            result parcels (today's geometry)
 * @param {Map<string,object>} geomByKey  from indexHistoricalGeometry
 * @param {{snapshot?: string|null, canonicalRoll?: Function}} opts
 * @returns {{fc: object, swapped: number, missing: number, missingRolls: string[]}}
 *   `swapped`/`missing` count FEATURES; `missingRolls` lists the distinct rolls
 *   behind `missing` (display form, muni prefix stripped) for the status line.
 */
export function applyHistoricalGeometry(fc, geomByKey, { snapshot = null, canonicalRoll = identityRoll } = {}) {
  const features = fc?.features || [];
  const empty = { fc: fc || { type: 'FeatureCollection', features: [] }, swapped: 0, missing: 0, missingRolls: [] };
  if (!features.length || !geomByKey || geomByKey.size === 0) return empty;

  let swapped = 0;
  let missing = 0;
  const missingRolls = [];
  const seenMissing = new Set();

  const out = features.map((f) => {
    const p = f?.properties;
    const key = p ? muniRollKey(p.Muni_Name_With_Typ, p.Roll_No_Txt, canonicalRoll) : '';
    const geometry = key ? geomByKey.get(key) : null;
    if (!geometry) {
      // Only parcels in the muni the overlay is holding are candidates; a
      // result from any other muni is out of scope, not "missing".
      if (key && hasMuniOf(geomByKey, key)) {
        missing++;
        if (!seenMissing.has(key)) {
          seenMissing.add(key);
          missingRolls.push(key.slice(key.indexOf('|') + 1));
        }
      }
      return f;
    }
    swapped++;
    return { ...f, geometry, properties: { ...p, _asOfGeom: true, _asOfDate: snapshot || null } };
  });

  if (swapped === 0) return { ...empty, missing, missingRolls };
  return { fc: { ...fc, features: out }, swapped, missing, missingRolls };
}

/**
 * Does the index hold ANY parcel for this key's municipality? Distinguishes
 * "this roll did not exist at the snapshot date" (report it) from "this parcel
 * belongs to a muni the overlay isn't loaded for" (silently out of scope).
 * Computed once per index and cached on it — result sets can run to hundreds of
 * features and the index to tens of thousands.
 */
function hasMuniOf(geomByKey, key) {
  let munis = geomByKey._muniSet;
  if (!munis) {
    munis = new Set();
    for (const k of geomByKey.keys()) munis.add(k.slice(0, k.indexOf('|')));
    Object.defineProperty(geomByKey, '_muniSet', { value: munis, enumerable: false });
  }
  return munis.has(key.slice(0, key.indexOf('|')));
}
