/*
 * Soil facts — the parcel x Manitoba Soil Survey overlap, pre-baked per
 * municipality by r/build_soilfacts.R into mb-parcel-data/soilfacts/.
 *
 * WHAT A SHARD HOLDS, AND WHY IT HOLDS SO LITTLE.
 *
 *   { _meta: { built, muni, source, min_acres, parcels, polygons },
 *     soils: { "29049": { u, n1,c1,e1,t1,g1,a1, n2,…, n3,… } },
 *     rolls: { "100.000": [[29049, 0.635], [29112, 0.365]] } }
 *
 * `rolls` is the OVERLAP RATIO of each soil polygon over that parcel, and
 * `soils` is the matched polygons' attributes with no geometry. That is all.
 * The shard deliberately does NOT carry the composition rows, the "Other
 * mapped soils" remainder or the CLI class rollup — the things actually
 * shown — because those rules live in soilSurvey.js and cliRollup.js, and a
 * second copy baked into a data file would drift the moment either was
 * touched, silently and only for parcels that happen to have a shard.
 *
 * So this module's whole job is to hand the SAME `{ feature, ratio }` pairs
 * to soilSurveyComponentsFromMatches that the live join produces. Same
 * function, same numbers, same answer — which is also what makes the two
 * paths comparable in a test rather than merely both plausible.
 *
 * WHY IT EXISTS AT ALL. The clip is the one cost that would not tune away:
 * ~30 ms per parcel, and a 1,141-sale multi-municipality run spent ~34 s in
 * it (measured 2026-09-22). Finer tiling was slower, simplifying the soil
 * traded real accuracy for 1.28x, and the spatial index was already doing
 * its job. The work does not get cheaper — it has to happen earlier.
 *
 * COVERAGE IS PARTIAL ON PURPOSE. The builder covers rural parcels at or
 * above its MIN_ACRES, which is where soil is the question being asked. A
 * parcel with no entry is not an error: the caller falls back to the live
 * scoped fetch and join for those, so a mixed result set gets shard speed
 * for the farmland and correct answers for the rest.
 */

/** The per-slot attribute names the rollup reads, in ArcGIS's spelling. */
const SLOT_FIELDS = [
  ['n', 'SOILNAME'], ['c', 'SOIL_CODE'], ['e', 'EXTENT'],
  ['t', 'SURFTEXT'], ['g', 'AGCAP_CLS'], ['a', 'AGRI_CAP'],
];

/**
 * Rebuild one soil polygon's properties from its shard entry, in the shape
 * componentsForFeature expects. Geometry is null and stays null — nothing
 * downstream of the ratio needs it, which is the point of shipping ratios.
 */
export function soilFeatureFromShard(oid, attrs) {
  const p = { OBJECTID: oid, MAPUNITNOM: attrs?.u ?? null };
  for (const slot of [1, 2, 3]) {
    for (const [short, field] of SLOT_FIELDS) {
      const v = attrs?.[`${short}${slot}`];
      p[`${field}${slot}`] = v === undefined ? null : v;
    }
  }
  return { type: 'Feature', properties: p, geometry: null };
}

/**
 * The `{ feature, ratio }` matches for one roll, or null when this shard has
 * no entry for it — which the caller must treat as "not covered, go and
 * join", never as "no soil here". Those are different answers and only one
 * of them is safe to show.
 */
export function soilMatchesFromShard(shard, rollText) {
  if (!shard || !rollText) return null;
  const rows = shard.rolls?.[rollText];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const out = [];
  for (const row of rows) {
    const oid = Array.isArray(row) ? row[0] : row?.oid;
    const ratio = Number(Array.isArray(row) ? row[1] : row?.r);
    if (oid == null || !Number.isFinite(ratio) || ratio <= 0) continue;
    out.push({ feature: soilFeatureFromShard(oid, shard.soils?.[String(oid)]), ratio });
  }
  return out.length ? out : null;
}

/**
 * The roll key a shard is indexed by: the roll number to three decimals,
 * which is what Roll_No_Txt already is on a parcel from the live service.
 * Normalised here rather than trusted, because an imported list can carry
 * "100" or "100.0" for the same parcel and a near-miss key reads as "no
 * soil" with nothing to say why.
 */
export function soilRollKey(props) {
  const raw = props?.Roll_No_Txt ?? props?.Roll_No ?? props?.TaxID;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n.toFixed(3) : null;
}
