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

// Sort state lives as `{ col, dir }` in main.js but rides the URL as
// `s=col` (asc) or `s=-col` (desc). The column name allowlist isn't
// known here — main.js owns SORT_KEYS — so we just constrain the
// shape: a leading letter, letters/digits/underscore after, ≤50 chars.
// An unknown col reaching main.js falls through to the default sort.
function parseSortParam(raw) {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s || s.length > 51) return undefined;
  const desc = s.startsWith('-');
  const col = desc ? s.slice(1) : s;
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(col)) return undefined;
  return { col, dir: desc ? 'desc' : 'asc' };
}
function formatSortParam(v) {
  if (!v || typeof v !== 'object') return null;
  const { col, dir } = v;
  if (typeof col !== 'string' || !col) return null;
  return dir === 'desc' ? `-${col}` : col;
}

// Overlays ride as a comma-separated list of stable short codes, e.g.
// `o=zoning,flow`. Each code: lowercase letter then [a-z0-9-]; cap the
// list at 20 entries so a malformed URL can't blow up state. Order and
// duplicates aren't meaningful — we dedupe and keep input order.
function parseOverlaysParam(raw) {
  if (typeof raw !== 'string') return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const valid = parts.filter((p) => /^[a-z][a-z0-9-]{0,30}$/.test(p));
  if (valid.length === 0) return undefined;
  return [...new Set(valid)].slice(0, 20);
}
function formatOverlaysParam(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  // Defensive: re-validate each entry in the formatter too, so a
  // bug in caller state can't smuggle garbage into the URL.
  const valid = v.filter((p) => typeof p === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(p));
  if (valid.length === 0) return null;
  return [...new Set(valid)].slice(0, 20).join(',');
}

// Segmented-pill state, as `name:mode` pairs — `water:near,tile:on`.
//
// These are FILTERS, not decoration: Water Proximity, Tile drainage,
// Irrigation, Nominal sales, Far-flung sales and Adjacent regions each change
// which parcels come back. A shared link that carried the municipality and the
// roll list but silently dropped "Waterfront only" showed the recipient a
// LARGER result set than the sender saw, with nothing on screen to say so —
// the worst kind of wrong, because it looks like it worked.
//
// Deliberately name/mode pairs rather than a fixed key per pill, so a pill
// added later round-trips without touching this file. Same reasoning as
// `overlays` reading every `button.overlay-btn[id$="-toggle"]`.
const PILL_TOKEN = /^[a-z][a-z0-9]{0,20}:[a-z][a-z0-9]{0,20}$/;

function parsePillsParam(raw) {
  if (typeof raw !== 'string') return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = parts.filter((p) => PILL_TOKEN.test(p));
  if (valid.length === 0) return undefined;
  // Last write wins on a duplicated name, so a hand-edited URL cannot make
  // one pill claim two modes.
  const byName = new Map();
  for (const p of valid) {
    const [name, mode] = p.split(':');
    byName.set(name, mode);
  }
  return Object.fromEntries([...byName].slice(0, 20));
}

function formatPillsParam(v) {
  if (!v || typeof v !== 'object') return null;
  // Re-validate in the formatter too, so a bug in caller state cannot
  // smuggle garbage into the URL.
  const pairs = Object.entries(v)
    .map(([name, mode]) => `${name}:${mode}`)
    .filter((p) => PILL_TOKEN.test(p));
  if (pairs.length === 0) return null;
  return pairs.slice(0, 20).join(',');
}

export const SCHEMA = {
  muni:        { param: 'm',  validate: cleanString,           format: (v) => v },
  roll:        { param: 'r',  validate: cleanString,           format: (v) => v },
  addressFrom: { param: 'af', validate: cleanString,           format: (v) => v },
  addressTo:   { param: 'at', validate: cleanString,           format: (v) => v },
  addressStreet: { param: 'as', validate: cleanString,         format: (v) => v },
  addressType: { param: 'ay', validate: cleanString,           format: (v) => v },
  addressDir:  { param: 'ad', validate: oneOf(['E', 'N', 'NE', 'NW', 'S', 'SE', 'SW', 'W']), format: (v) => v },
  legalText:   { param: 'lt', validate: cleanString,           format: (v) => v },
  title:       { param: 'ti', validate: cleanString,           format: (v) => v },
  // Structured legal searches (MAO parity): lot/block/plan, condo
  // plan+unit, parish lot, section-township-range. All free-text —
  // the legal-index matcher normalizes them.
  lot:         { param: 'lo', validate: cleanString,           format: (v) => v },
  block:       { param: 'bk', validate: cleanString,           format: (v) => v },
  plan:        { param: 'pn', validate: cleanString,           format: (v) => v },
  condoPlan:   { param: 'cp', validate: cleanString,           format: (v) => v },
  condoUnit:   { param: 'cu', validate: cleanString,           format: (v) => v },
  parish:      { param: 'ph', validate: cleanString,           format: (v) => v },
  parishLotType: { param: 'py', validate: oneOf(['RL', 'PL', 'SL', 'IT', 'OT', 'PK', 'WL']), format: (v) => v },
  parishLot:   { param: 'pw', validate: cleanString,           format: (v) => v },
  parishPlan:  { param: 'pz', validate: cleanString,           format: (v) => v },
  strSection:  { param: 'ss', validate: cleanString,           format: (v) => v },
  strTownship: { param: 'sw', validate: cleanString,           format: (v) => v },
  strRange:    { param: 'sg', validate: cleanString,           format: (v) => v },
  strQuarter:  { param: 'sq', validate: oneOf(['NE', 'NW', 'SE', 'SW', 'RL']), format: (v) => v },
  zoneCategory: { param: 'zc', validate: cleanString,          format: (v) => v },
  changedStatus: { param: 'cs', validate: oneOf(['zoning', 'devplan', 'both']), format: (v) => v },
  duMode:      { param: 'du', validate: oneOf(['zero', 'min']), format: (v) => v },
  duMin:       { param: 'dn', validate: cleanInt(1, 9999),     format: (v) => String(v) },
  tab:         { param: 't',  validate: oneOf(['property', 'sales']), format: (v) => v },
  selectedRoll: { param: 'sr', validate: cleanString,          format: (v) => v },
  vacantThreshold: { param: 'vt', validate: cleanNumber(0, 1e9), format: (v) => String(v) },
  vacantMode:  { param: 'vd', validate: oneOf(['pct', 'dollar']), format: (v) => v },
  // View state — restores what the recipient of a shared URL was
  // looking at, not just the filters that produced it. sort/page apply
  // to the results table; overlays carry the set of map overlays that
  // were ON (binary aria-pressed=true only — tri-state secondary modes
  // are deliberately NOT round-tripped because restoring them needs
  // multiple click cycles and some depend on per-deploy assets that
  // may not be present).
  sort:        { param: 's',  validate: parseSortParam,        format: formatSortParam },
  page:        { param: 'p',  validate: cleanInt(1, 10000),    format: (v) => String(v) },
  overlays:    { param: 'o',  validate: parseOverlaysParam,    format: formatOverlaysParam },
  pills:       { param: 'pl', validate: parsePillsParam,       format: formatPillsParam },
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
