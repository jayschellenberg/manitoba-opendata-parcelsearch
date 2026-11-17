// The Addenda Pack's zoning map: how wide it is framed for the subject's
// size, and the text of its top-left label (Jason, 2026-10-14).
//
// Pure functions — main.js finds the zone under the subject and draws the
// label; this module decides the numbers and the words.

import area from '@turf/area';
import bbox from '@turf/bbox';
import intersect from '@turf/intersect';
import { realStr } from './cellFormat.js';
import { ZONING_BYLAW_DATES } from './zoningBylawDates.js';
import { spaLongName } from './specialPlanningAreas.js';

// Minimum frame width by subject size. At 1,500 m a town lot was a speck
// among the neighbouring blocks (2026-10-12), and 1,000 m was still loose
// (2026-10-14), so small parcels step in closer.
export const ZONING_FRAME_TIERS = [
  { underAcres: 1, minWidthM: 750 },
  { underAcres: 5, minWidthM: 1000 },
];
export const ZONING_FRAME_DEFAULT_M = 1500;

/** Minimum zoning-map width in metres for a subject of `acres` (null when
 *  the area could not be read — the full 1.5 km frame). */
export function zoningMinWidthM(acres) {
  if (acres == null || !Number.isFinite(acres)) return ZONING_FRAME_DEFAULT_M;
  const tier = ZONING_FRAME_TIERS.find((t) => acres < t.underAcres);
  return tier ? tier.minWidthM : ZONING_FRAME_DEFAULT_M;
}

/** The by-law's effective date from ZONING_BYLAW_DATES, as 'YYYY-MM-DD',
 *  or null. Keyed on the zoning layer's own ZBL, with "ZBL|MUNI_NAME"
 *  taking precedence for the few numbers two municipalities share. */
export function zoningBylawDate(props = {}, table = ZONING_BYLAW_DATES) {
  const zbl = realStr(props.ZBL);
  if (!zbl) return null;
  const muni = realStr(props.MUNI_NAME);
  return (muni && table[`${zbl}|${muni}`]) || table[zbl] || null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** '2019-03-04' -> 'March 4, 2019'; null for anything else. */
export function formatBylawDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || day < 1 || day > 31) return null;
  return `${month} ${day}, ${m[1]}`;
}

/**
 * "Zoning Map — Rural Municipality of Piney By-law 7-2019 (effective
 * March 4, 2019)". The jurisdiction is the subject's municipality (Jason's
 * call: always the municipality, even for a planning-district by-law);
 * each part drops out when unknown, down to plain "Zoning Map".
 */
export function addendaZoningLabelText({ muni, bylaw, date, spa, amendedBy } = {}) {
  if (spa) return addendaSpaLabelText(spa, amendedBy);
  const base = realStr(bylaw);
  const where = realStr(muni);
  const when = formatBylawDate(date);
  if (!base) return where ? `Zoning Map — ${where}` : 'Zoning Map';
  const law = /by-?law/i.test(base) ? base : `By-law ${base}`;
  const text = `Zoning Map — ${where ? `${where} ` : ''}${law}`;
  return when ? `${text} (effective ${when})` : text;
}

/**
 * Inside a Special Planning Area the regulation governs, not the host
 * municipality (Jason, 2026-11-05): "Zoning Map — Inland Port Special
 * Planning Area (CentrePort), Manitoba Regulation 48/2016 (registered
 * March 8, 2016), as amended by 10/2021". "Registered", not "effective":
 * the regulation came into force with S.M. 2015 c. 26, on its own date.
 */
export function addendaSpaLabelText(spa, amendedBy) {
  const when = formatBylawDate(spa?.registered);
  const amend = realStr(amendedBy);
  let text = `Zoning Map — ${spaLongName(spa)}`;
  if (when) text += ` (registered ${when})`;
  if (amend && amend !== spa.regulation) text += `, as amended by ${amend}`;
  return text;
}

/** The zoning map's source line, under the scale bar. The date is the
 *  layer's last edit anywhere in Manitoba, hence "layer updated" rather
 *  than a claim about this municipality's zoning. */
export function addendaZoningSourceNote(updatedIso) {
  const when = formatBylawDate(updatedIso);
  const src = 'Source: Manitoba Zoning By-laws, Province of Manitoba (DataMB)';
  return when ? `${src}, layer updated ${when}` : src;
}

/** A zone counts as one of the subject's zones on the zoning map when it
 *  covers more than this share of the subject's land (Jason, 2026-11-17:
 *  Steinbach roll 1400 fronts on C3 with DR-1 behind, and only DR-1, the
 *  zone under the centre, was highlighted). */
export const SUBJECT_ZONE_MIN_SHARE = 0.05;

/**
 * The zone codes covering more than `minShare` of the subject parcels'
 * combined area, measured by overlaying each parcel on the zoning polygons.
 * `fallback` (the codes under the parcels' centre points) is returned when
 * no overlap could be measured (bad geometry, a parcel outside the layer),
 * so the legend never loses the highlight it had before.
 */
export function subjectZoneCodesByArea(zoningFeatures, parcelFeatures,
  { minShare = SUBJECT_ZONE_MIN_SHARE, fallback = [] } = {}) {
  const zones = [];
  for (const z of zoningFeatures || []) {
    const code = (z?.properties?.ZONE || '').trim();
    if (!code || !z.geometry) continue;
    try { zones.push({ code, z, box: bbox(z) }); } catch { /* skip unreadable */ }
  }
  let total = 0;
  const byCode = new Map();
  for (const p of parcelFeatures || []) {
    if (!p?.geometry) continue;
    let pa; let pb;
    try { pa = area(p); pb = bbox(p); } catch { continue; }
    if (!(pa > 0)) continue;
    total += pa;
    for (const { code, z, box } of zones) {
      if (box[0] > pb[2] || box[2] < pb[0] || box[1] > pb[3] || box[3] < pb[1]) continue;
      let a = 0;
      try {
        const inter = intersect({ type: 'FeatureCollection', features: [p, z] });
        a = inter ? area(inter) : 0;
      } catch { a = 0; }
      if (a > 0) byCode.set(code, (byCode.get(code) || 0) + a);
    }
  }
  const out = new Set();
  if (total > 0) {
    for (const [code, a] of byCode) if (a / total > minShare) out.add(code);
  }
  if (out.size === 0) for (const c of fallback) out.add(c);
  return out;
}
