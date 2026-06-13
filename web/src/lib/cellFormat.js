// Pure cell/value formatters extracted from main.js's results-table
// rendering. Each maps parcel properties (or a raw field) to a display
// value — no DOM, no module state — so the renderTable monolith keeps
// only the DOM assembly and these stay independently testable.

/**
 * Normalize a raw field to a real string or null. Manitoba's services
 * stringify nulls inconsistently — `null`, '', a lone '<Null>', or the
 * literal text 'null' all mean "no value". Returns the trimmed string
 * when there's real content, otherwise null. This is the app's core
 * sentinel filter; many table cells gate on it.
 */
export function realStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '<Null>' || s.toLowerCase() === 'null') return null;
  return s;
}

/**
 * Brief legal description for the Legal column. Prefers the full
 * `_legalDescription`; falls back to a "L x · B y · P z" lot/block/plan
 * summary; then the raw `_legalDetail`. Null when nothing usable.
 */
export function legalDisplay(p = {}) {
  if (realStr(p._legalDescription)) return realStr(p._legalDescription);
  const parts = [];
  if (realStr(p._lot)) parts.push(`L ${realStr(p._lot)}`);
  if (realStr(p._block)) parts.push(`B ${realStr(p._block)}`);
  if (realStr(p._plan)) parts.push(`P ${realStr(p._plan)}`);
  if (parts.length) return parts.join(' · ');
  return realStr(p._legalDetail);
}

/**
 * Split a `'X / CITY; Y / CITY'` certificates_of_title string into just
 * the number tokens. Robust against extra whitespace and the
 * alphanumeric prefix-letter forms (D15630, etc.).
 */
export function parseTitleNumbers(raw) {
  const out = [];
  for (const part of String(raw || '').split(/\s*;\s*/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Take everything up to the first ' / ' (or end of string).
    const num = trimmed.split(/\s*\/\s*/)[0].trim();
    if (num) out.push(num);
  }
  return out;
}

/**
 * Dominant CLI agricultural-capability label for the parcel — from the
 * top-share soil of the stamped `_soilComposition`. Null when no Soil
 * Survey / CLI overlay has been loaded.
 */
export function dominantCliLabel(p) {
  const top = Array.isArray(p?._soilComposition) ? p._soilComposition[0] : null;
  if (!top) return null;
  return top.agriCap || top.agcapCls || null;
}

/**
 * Dominant soil association name for the parcel — SOILNAME1 of the
 * top-share soil (e.g. "Red River"). Null when no overlay loaded.
 */
export function dominantSoilTypeLabel(p) {
  const top = Array.isArray(p?._soilComposition) ? p._soilComposition[0] : null;
  if (!top) return null;
  return top.soilName || top.soilCode || null;
}
