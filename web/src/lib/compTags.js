/*
 * Comparable-sale tags for the Sales Charts page (charts Phase 2, Jason
 * 2026-10-06): the R land template's three ordered lists —
 * CompetitiveSales (the numbered comparables), CompetitiveSales1 (Land Set 1)
 * and CompetitiveSales2 (Land Set 2). A sale's place in its list is its
 * number: Comp #1 is the first comparable, "L1-2" the second sale of Land
 * Set 1.
 *
 * A tag is keyed on the sale's ROLL NUMBERS and SALE DATE, never its sale id:
 * MAO renumbers the Sale Group ID run to run, so an id-keyed tag would land
 * on a different sale (or none) after the next export. Rolls + date names
 * the same transaction in every export.
 *
 * Pure: the page loads and saves the state (localStorage) and passes it in.
 */

export const TAG_LISTS = ['comps', 'set1', 'set2'];

/**
 * Where the tags and the exclusion reasons are kept. The charts page and the
 * main window's grid share an origin, so both read and write these same keys
 * and follow each other through the storage event (2026-10-06).
 */
export const COMP_TAGS_KEY = 'mbps_charts_comp_tags_v1';
export const EXCL_REASONS_KEY = 'mbps_charts_excl_reasons_v1';
/** The suggested exclusion reasons; any other text is accepted too. */
export const EXCLUSION_REASONS = [
  'Nominal transfer', "Non-arm's length", 'Assembly', 'Outlier', 'Not comparable',
  'Includes improvements', 'Forced sale',
];

/** Read the reasons map out of storage text, dropping anything malformed. */
export function normalizeReasons(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw)
    .filter(([k, r]) => k && typeof r === 'string' && r.trim())
    .map(([k, r]) => [k, r.trim().slice(0, 200)]));
}
export const TAG_LIST_NAMES = { comps: 'Comparable sales', set1: 'Land Set 1', set2: 'Land Set 2' };

/** A fresh, empty tag state. `info` remembers enough to name a tag whose sale is filtered out. */
export function emptyTags() {
  return { comps: [], set1: [], set2: [], info: {} };
}

/** Coerce whatever came out of storage into a valid state; junk becomes empty. */
export function normalizeTags(raw) {
  const out = emptyTags();
  if (!raw || typeof raw !== 'object') return out;
  for (const list of TAG_LISTS) {
    const seen = new Set();
    for (const k of Array.isArray(raw[list]) ? raw[list] : []) {
      if (typeof k === 'string' && k && !seen.has(k)) { seen.add(k); out[list].push(k); }
    }
  }
  if (raw.info && typeof raw.info === 'object') {
    for (const [k, v] of Object.entries(raw.info)) {
      if (v && typeof v === 'object') out.info[k] = { address: String(v.address ?? ''), date: String(v.date ?? ''), muni: String(v.muni ?? '') };
    }
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** The sale date as YYYY-MM-DD (local), or the raw text when there is no parsed date. */
function dateKey(rec) {
  if (Number.isFinite(rec?.dateMs)) {
    const d = new Date(rec.dateMs);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return String(rec?.dateText ?? '').trim();
}

/**
 * One spelling per roll. The same roll reaches the page as "100.000" from a
 * CSV and "100" once the grid's sale grouping stamps the display form
 * (measured 2026-10-06: the key changed under a live grid between the two
 * renders), so a numeric roll loses leading zeros and a zero fraction —
 * "0100.000" and "100" are one roll, while "3200.100" keeps its ".1".
 */
export function canonicalRoll(r) {
  const s = String(r ?? '').trim().replace(/\s+/g, '');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return s;
  const whole = m[1].replace(/^0+(?=\d)/, '');
  const frac = (m[2] || '').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * The tag key of a sale: its roll numbers, sorted and trimmed, joined with
 * "+", then "@" and the sale date. Null when the sale has no roll — there is
 * nothing stable to key on.
 */
export function saleTagKey(rec) {
  const rolls = (rec?.rolls || []).map(canonicalRoll).filter(Boolean).sort();
  if (!rolls.length) return null;
  return `${rolls.join('+')}@${dateKey(rec)}`;
}

/** What to show for a tag whose sale is not in the current data. */
export function tagInfo(rec) {
  return { address: rec?.address || '', date: dateKey(rec), muni: rec?.muni || '' };
}

function withInfo(state, key, rec) {
  return rec ? { ...state.info, [key]: tagInfo(rec) } : state.info;
}

/** Drop info for keys no list holds any more, so storage does not grow forever. */
function pruneInfo(state) {
  const live = new Set(TAG_LISTS.flatMap((l) => state[l]));
  const info = {};
  for (const [k, v] of Object.entries(state.info)) if (live.has(k)) info[k] = v;
  return { ...state, info };
}

/** Add `key` to the end of `list`, or remove it if already there. Returns a new state. */
export function toggleTag(state, list, key, rec = null) {
  if (!key || !TAG_LISTS.includes(list)) return state;
  const has = state[list].includes(key);
  const next = {
    ...state,
    [list]: has ? state[list].filter((k) => k !== key) : [...state[list], key],
    info: has ? state.info : withInfo(state, key, rec),
  };
  return pruneInfo(next);
}

/** Remove `key` from `list`. */
export function removeTag(state, list, key) {
  if (!state[list]?.includes(key)) return state;
  return pruneInfo({ ...state, [list]: state[list].filter((k) => k !== key) });
}

/** Move `key` one place up (-1) or down (+1) in `list`, renumbering it. */
export function moveTag(state, list, key, dir) {
  const arr = state[list] ? state[list].slice() : [];
  const i = arr.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return state;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return { ...state, [list]: arr };
}

/** Empty one list, or every list. */
export function clearTags(state, list = null) {
  if (!list) return emptyTags();
  return pruneInfo({ ...state, [list]: [] });
}

/** 1-based place of `key` in `list`, or null. */
export function tagNumber(state, list, key) {
  const i = key ? state[list]?.indexOf(key) ?? -1 : -1;
  return i >= 0 ? i + 1 : null;
}

/**
 * The label a sale carries on charts and maps: its comp number ("3") if it
 * is a comparable, else its Land Set place ("L1-2", "L2-1"), else null.
 */
export function tagLabel(state, key) {
  if (!key) return null;
  const c = tagNumber(state, 'comps', key);
  if (c) return String(c);
  const a = tagNumber(state, 'set1', key);
  if (a) return `L1-${a}`;
  const b = tagNumber(state, 'set2', key);
  if (b) return `L2-${b}`;
  return null;
}

/** "Comp #3", "Land Set 1 #2" — every list a sale is in, for tooltips and the CSV. */
export function tagDescriptions(state, key) {
  const out = [];
  const c = tagNumber(state, 'comps', key);
  if (c) out.push(`Comp #${c}`);
  const a = tagNumber(state, 'set1', key);
  if (a) out.push(`Land Set 1 #${a}`);
  const b = tagNumber(state, 'set2', key);
  if (b) out.push(`Land Set 2 #${b}`);
  return out;
}
