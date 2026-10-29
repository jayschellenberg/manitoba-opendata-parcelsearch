/*
 * Street-name list behind the Street typeahead (Property Search and the
 * Sales Analysis Street name filter).
 *
 * MAO's civic address is one free-text field — the provincial Roll Entry
 * layer's Property_Address and the scrape's civic_address carry the same
 * text, with no street-name / type / direction columns. So the street is
 * parsed OUT of the address: the civic number and unit come off the front,
 * a direction suffix comes off the back, and what is left is the street.
 *
 * One rule decides every parsing call here: A SUGGESTION MUST SEARCH AS
 * THE STREET IT NAMES. Both searches are substring matches against the
 * address text ("%MAIN ST%"), so the name kept is a verbatim run of the
 * address's own tokens — "GRAND BEACH RD." keeps its period, "ROAD 93N"
 * keeps its glued N (Road 93N and Road 93W are different roads), and a
 * prefix direction stays put ("E ROAD 71" from "1 106 E ROAD 71 N"). Only
 * a trailing, standalone direction is split off, into `d`, because the
 * Dir box already handles it and one row per street is what Jason asked
 * for (2026-10-22).
 *
 * Built monthly by web/scripts/build-street-index.mjs from the Roll Entry
 * snapshot into mb-parcel-data/streets/, one file per municipality.
 */

const DIRECTIONS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
const DIRECTION_WORDS = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
};
// Street types that can't stand as a street on their own: if stripping the
// civic number leaves only one of these, the number was the street's
// ("30075E 59 HWY" is Highway 59, not "HWY").
const BARE_TYPES = new Set([
  'AVE', 'AVENUE', 'BAY', 'BL', 'BLVD', 'CL', 'CR', 'CRES', 'DR', 'HW', 'HWY',
  'HIGHWAY', 'LANE', 'PL', 'RD', 'ROAD', 'ST', 'STREET', 'TRL', 'WAY',
]);
const UNIT_WORDS = new Set(['UNIT', 'APT', 'SUITE', 'STE']);

// A civic-number token: "161", "30075E", "E1" (unit), "#4", compound
// forms ("36F-20", "8-10", "124/130", "1&2"), or the separators of a
// range / unit prefix ("-", "&", "+").
const CIVIC_TOKEN = /^[#+]?[A-Z]?\d+[A-Z]?([-/&][A-Z]?\d*[A-Z]?)*\+?$/;
const CIVIC_SEP = /^(-+|&|\+|\/)$/;
// "27100 AND - 27110 31 RD": AND joins two civic numbers, never a street.
const CIVIC_AND = 'AND';
// A quarter-section legal standing in for an address ("NE 25-10-19-1").
const QUARTER_LEGAL = /^\d+-\d+-\d+/;

/** Upper-case, whitespace-collapsed, the form both searches compare in. */
export function normalizeAddress(raw) {
  return String(raw ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * True when `address` sits on exactly the street `name` — the test for a
 * street PICKED from the typeahead. Both searches are substring matches,
 * so picking CHARLES ST would also return ST CHARLES ST; parsing the
 * address with the same streetOfAddress that built the list makes a pick
 * mean that one street. The trailing direction is not compared: it was
 * split off into `d`, and the Dir box decides it.
 */
export function addressOnStreet(address, name) {
  const want = normalizeAddress(name);
  return !!want && streetOfAddress(address)?.name === want;
}

/**
 * The street an address sits on, or null when there isn't one to offer.
 * @returns {{ name: string, dir: string }|null}  dir is '' when the
 *   address carries no trailing direction.
 */
export function streetOfAddress(address) {
  const tokens = normalizeAddress(address).split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  if (DIRECTIONS.has(tokens[0]) && QUARTER_LEGAL.test(tokens[1] || '')) return null;

  let start = 0;
  if (UNIT_WORDS.has(tokens[0])) start = 1;
  // A lone letter is part of the civic only beside a separator ("A & B
  // ROAD 110NE", "A - B TRAVERSE BAY RD"); "1 106 E ROAD 71" keeps its E.
  const isCivic = (i) => {
    const t = tokens[i];
    if (CIVIC_TOKEN.test(t) || CIVIC_SEP.test(t)) return true;
    if (t === CIVIC_AND) return i > 0 && CIVIC_TOKEN.test(tokens[i - 1]);
    return /^[A-Z]$/.test(t)
      && (CIVIC_SEP.test(tokens[i + 1] || '') || CIVIC_SEP.test(tokens[i - 1] || ''));
  };
  while (start < tokens.length && isCivic(start)) start++;
  // Leaving only a bare type means the last number belonged to the street.
  if (start > 0 && tokens.length - start === 1 && BARE_TYPES.has(tokens[start])) start--;

  let end = tokens.length;
  // A trailing unit ("100 MAIN ST UNIT 4") is not part of the street.
  if (end - start >= 3 && UNIT_WORDS.has(tokens[end - 2])) end -= 2;
  let dir = '';
  const last = tokens[end - 1];
  if (end - start >= 2 && last) {
    const bare = last.replace(/\.$/, '');
    if (DIRECTIONS.has(bare)) dir = bare;
    else if (DIRECTION_WORDS[bare]) dir = DIRECTION_WORDS[bare];
    if (dir) end -= 1;
  }

  const street = tokens.slice(start, end);
  if (street.length === 0) return null;
  // Legal descriptions sitting in the address field are not streets:
  // "DESC E--12211", "SE4-29-8W", "DESC NW15-27-9W", "4-7-445" — every
  // one carries "DESC", a double dash or a number-dash-number run. Nor is
  // anything with no word in it at all.
  if (street[0] === 'DESC') return null;
  if (street.some((t) => t.includes('--') || /\d-\d/.test(t))) return null;
  if (!street.some((t) => /[A-Z]{2,}/.test(t))) return null;
  return { name: street.join(' '), dir };
}

/**
 * Fold one municipality's addresses into its street list:
 * [{ n: name, c: parcel count, d: [directions, most common first] }],
 * sorted by name. Compact keys because 187 of these ship as files.
 */
export function buildMuniStreets(addresses) {
  const byName = new Map();
  for (const a of addresses || []) {
    const s = streetOfAddress(a);
    if (!s) continue;
    let e = byName.get(s.name);
    if (!e) { e = { n: s.name, c: 0, _d: new Map() }; byName.set(s.name, e); }
    e.c += 1;
    if (s.dir) e._d.set(s.dir, (e._d.get(s.dir) || 0) + 1);
  }
  const out = [];
  for (const e of byName.values()) {
    const d = [...e._d.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k]) => k);
    out.push(d.length ? { n: e.n, c: e.c, d } : { n: e.n, c: e.c });
  }
  out.sort((x, y) => x.n.localeCompare(y.n));
  return out;
}

/** Rows shown at once — Winnipeg's figure; it fills the sidebar without
 *  covering much below the field. */
export const STREET_SUGGEST_LIMIT = 8;
/** One character matches half a muni; two is where the top of the list
 *  starts being the street meant. */
export const STREET_SUGGEST_MIN_QUERY = 2;

/** Matching key: upper-case, punctuation off, hyphens as spaces, so
 *  "grand beach rd" finds "GRAND BEACH RD." and "eau claire" finds
 *  "EAU-CLAIRE". Only the matching folds — accepting a row inserts the
 *  street's own spelling. */
export function suggestKey(raw) {
  return normalizeAddress(String(raw ?? '').replace(/-/g, ' ').replace(/[.,'#]/g, ''));
}

/**
 * Rank a municipality's street list against what has been typed. Tiers,
 * best first: the whole name, a prefix of it, the start of a word in it,
 * anywhere in it; within a tier the street with more parcels wins, so MAIN
 * offers MAIN ST above MAINLAND DR (Winnipeg's rule).
 */
export function suggestStreets(list, query, limit = STREET_SUGGEST_LIMIT) {
  const q = suggestKey(query);
  if (q.length < STREET_SUGGEST_MIN_QUERY) return [];
  const hits = [];
  for (const entry of list || []) {
    const k = entry._k ?? (entry._k = suggestKey(entry.n));
    let tier = -1;
    if (k === q) tier = 0;
    else if (k.startsWith(q)) tier = 1;
    else if (k.includes(` ${q}`)) tier = 2;
    else if (k.includes(q)) tier = 3;
    if (tier >= 0) hits.push({ tier, entry });
  }
  hits.sort((a, b) => a.tier - b.tier || b.entry.c - a.entry.c || a.entry.n.localeCompare(b.entry.n));
  return hits.slice(0, limit).map((h) => h.entry);
}

/** The grey half of a row: "N · NE · 36 parcels". */
export function suggestHint(entry) {
  const parts = [];
  if (entry?.d?.length) parts.push(entry.d.join(' · '));
  const c = Number(entry?.c) || 0;
  parts.push(`${c.toLocaleString()} parcel${c === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
