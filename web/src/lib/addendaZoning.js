// The Addenda Pack's zoning map: how wide it is framed for the subject's
// size, and the text of its top-left label (Jason, 2026-10-14).
//
// Pure functions — main.js finds the zone under the subject and draws the
// label; this module decides the numbers and the words.

import { realStr } from './cellFormat.js';
import { ZONING_BYLAW_DATES } from './zoningBylawDates.js';

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
export function addendaZoningLabelText({ muni, bylaw, date } = {}) {
  const base = realStr(bylaw);
  const where = realStr(muni);
  const when = formatBylawDate(date);
  if (!base) return where ? `Zoning Map — ${where}` : 'Zoning Map';
  const law = /by-?law/i.test(base) ? base : `By-law ${base}`;
  const text = `Zoning Map — ${where ? `${where} ` : ''}${law}`;
  return when ? `${text} (effective ${when})` : text;
}
