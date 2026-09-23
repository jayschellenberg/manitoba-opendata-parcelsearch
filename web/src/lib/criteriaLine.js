/*
 * The chart subtitle's criteria line, in the land template's form
 * (land_subtitles): "CMS; 0-35 km from Subject; 1-10 acres; Jan-2021 to Sep-2026".
 *
 * Each part states the Sales Analysis FILTER SETTING when one is set (Jason,
 * 2026-09-22), as the template states its CMS bounds. Where a filter is left
 * open there is no setting to state, so that part falls back to the span of
 * the sales the chart actually fits — still true, and still the evidence the
 * line describes.
 *
 * Pure: formatters are passed in.
 */

const SQFT_PER_ACRE = 43560;

/** A finite positive number from an input value, or null. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 'YYYY-MM-DD' → epoch ms at UTC midnight, or null. */
function isoMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * Convert a filter size bound to the chart's size unit, or null when the
 * two cannot be compared: acres and square feet convert, but frontage feet
 * is a width, not an area, so an area filter says nothing about a frontage
 * chart and vice versa.
 */
function convertSize(v, fromUom, toUom) {
  if (v == null) return null;
  if (fromUom === toUom) return v;
  if (fromUom === 'acres' && toUom === 'sf') return v * SQFT_PER_ACRE;
  if (fromUom === 'sf' && toUom === 'acres') return v / SQFT_PER_ACRE;
  return null;
}

/**
 * @param o.adjusted      charts carrying rates to the effective date say so
 * @param o.criteria      {dateFrom, dateTo, sizeUom, sizeLow, sizeHigh, distanceMax}
 *                        from the main window, or null
 * @param o.unitKey       the chart's size unit: 'acres' | 'sf' | 'ff'
 * @param o.unitWord      how that unit reads in the line: 'acres' | 'sq ft' | 'ft frontage'
 * @param o.refTitle      'Subject' | 'Winnipeg'
 * @param o.refIsSubject  whether distances are measured from the subject
 * @param o.span          {dist:[lo,hi]|null, size:[lo,hi]|null, date:[msLo,msHi]|null}
 *                        of the fitted sales, for the parts no filter sets
 * @param o.fmtMonYear    ms → "Jan-2024"
 * @param o.fmtNum        number → "12" / "0.35"
 */
export function criteriaText(o) {
  const c = o.criteria || {};
  const parts = [o.adjusted ? 'CMS (Time-Adjusted)' : 'CMS'];

  // Distance. The main window's distance filter measures from the SUBJECT,
  // so it can only be stated when the charts measure from the subject too.
  const dMax = num(c.distanceMax);
  if (dMax != null && dMax > 0 && o.refIsSubject) {
    parts.push(`0-${o.fmtNum(dMax)} km from Subject`);
  } else if (o.span?.dist) {
    parts.push(`${o.fmtNum(o.span.dist[0])}-${o.fmtNum(o.span.dist[1])} km from ${o.refTitle}`);
  }

  // Size.
  const lo = convertSize(num(c.sizeLow), c.sizeUom, o.unitKey);
  const hi = convertSize(num(c.sizeHigh), c.sizeUom, o.unitKey);
  if (lo != null && hi != null) parts.push(`${o.fmtNum(lo)}-${o.fmtNum(hi)} ${o.unitWord}`);
  else if (lo != null) parts.push(`${o.fmtNum(lo)}+ ${o.unitWord}`);
  else if (hi != null) parts.push(`0-${o.fmtNum(hi)} ${o.unitWord}`);
  else if (o.span?.size) parts.push(`${o.fmtNum(o.span.size[0])}-${o.fmtNum(o.span.size[1])} ${o.unitWord}`);

  // Dates: each end from the filter when set, else from the sales.
  const from = isoMs(c.dateFrom) ?? o.span?.date?.[0] ?? null;
  const to = isoMs(c.dateTo) ?? o.span?.date?.[1] ?? null;
  if (from != null && to != null) parts.push(`${o.fmtMonYear(from)} to ${o.fmtMonYear(to)}`);
  else if (from != null) parts.push(`from ${o.fmtMonYear(from)}`);
  else if (to != null) parts.push(`to ${o.fmtMonYear(to)}`);

  return parts.join('; ');
}
