/*
 * URL state encoding (Phase 6 item 23). Serializes a small,
 * explicit set of form-state keys into the browser's query string
 * so an appraiser can share a session URL and the other person
 * lands on the same muni / filters / selected parcel.
 *
 * Highest-risk change in the refactor plan — every parsed value
 * runs through a validator that rejects out-of-range / malformed
 * input. Unknown query params are ignored. Empty values aren't
 * emitted so a "default" session produces a clean URL.
 *
 * Sales-CSV state is NOT encoded. The CSV is an uploaded file;
 * the URL has no way to reference it without storing the parsed
 * data, which would explode URL length. Sales filters tied to a
 * loaded CSV are skipped automatically (encoder ignores keys with
 * empty values).
 */

/**
 * Schema — each entry declares:
 *   - param: short URL key
 *   - validate(raw): returns the parsed value or undefined when
 *     invalid; raw is always a string from URLSearchParams.
 *   - format(value): returns the URL string form. Returns null when
 *     the value should be omitted entirely (empty / default).
 *
 * The schema is the single source of truth for what gets encoded
 * and what shapes are accepted. New keys add an entry here.
 */
const STRING_MAX = 200;

function cleanString(v) {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > STRING_MAX) return undefined;
  return trimmed;
}

function cleanInt(min, max) {
  return (v) => {
    if (typeof v !== 'string') return undefined;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) return undefined;
    if (n < min || n > max) return undefined;
    return n;
  };
}

function cleanNumber(min, max) {
  return (v) => {
    if (typeof v !== 'string') return undefined;
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n)) return undefined;
    if (n < min || n > max) return undefined;
    return n;
  };
}

function oneOf(allowed) {
  const set = new Set(allowed);
  return (v) => (typeof v === 'string' && set.has(v) ? v : undefined);
}

export const SCHEMA = {
  muni:        { param: 'm',  validate: cleanString,           format: (v) => v },
  roll:        { param: 'r',  validate: cleanString,           format: (v) => v },
  addressFrom: { param: 'af', validate: cleanString,           format: (v) => v },
  addressTo:   { param: 'at', validate: cleanString,           format: (v) => v },
  addressStreet: { param: 'as', validate: cleanString,         format: (v) => v },
  legalText:   { param: 'lt', validate: cleanString,           format: (v) => v },
  title:       { param: 'ti', validate: cleanString,           format: (v) => v },
  zoneCategory: { param: 'zc', validate: cleanString,          format: (v) => v },
  changedStatus: { param: 'cs', validate: oneOf(['zoning', 'devplan', 'both']), format: (v) => v },
  duMode:      { param: 'du', validate: oneOf(['zero', 'min']), format: (v) => v },
  duMin:       { param: 'dn', validate: cleanInt(1, 9999),     format: (v) => String(v) },
  tab:         { param: 't',  validate: oneOf(['property', 'sales']), format: (v) => v },
  selectedRoll: { param: 'sr', validate: cleanString,          format: (v) => v },
  vacantPct:   { param: 'vp', validate: cleanNumber(0, 10),    format: (v) => String(v) },
  vacantMax:   { param: 'vm', validate: cleanInt(0, 1e9),      format: (v) => String(v) },
};

const PARAM_TO_KEY = Object.fromEntries(
  Object.entries(SCHEMA).map(([key, def]) => [def.param, key])
);

/**
 * Encode a state object into a URL query string (no leading `?`).
 * Only keys present in SCHEMA with non-null format() output are
 * emitted; everything else is ignored.
 *
 * Returns '' when nothing should be in the URL (clean default).
 */
export function encodeState(state) {
  if (!state || typeof state !== 'object') return '';
  const usp = new URLSearchParams();
  for (const [key, def] of Object.entries(SCHEMA)) {
    if (!(key in state)) continue;
    const v = state[key];
    if (v == null || v === '') continue;
    const formatted = def.format(v);
    if (formatted == null || formatted === '') continue;
    usp.set(def.param, formatted);
  }
  return usp.toString();
}

/**
 * Decode a URL query string into a state object. Accepts either
 * the leading-`?` form (`?m=Foo&r=123`) or the bare param string.
 * Each parsed value goes through its schema validator; failures
 * are silently dropped so a malformed URL never throws.
 */
export function decodeState(search) {
  const result = {};
  if (search == null) return result;
  const raw = typeof search === 'string' ? search.replace(/^\?/, '') : '';
  if (!raw) return result;
  let usp;
  try { usp = new URLSearchParams(raw); }
  catch { return result; }
  for (const [param, raw] of usp.entries()) {
    const key = PARAM_TO_KEY[param];
    if (!key) continue;
    const def = SCHEMA[key];
    const parsed = def.validate(raw);
    if (parsed === undefined) continue;
    result[key] = parsed;
  }
  return result;
}
