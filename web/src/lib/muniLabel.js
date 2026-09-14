/*
 * How a municipality READS on screen: "ARBORG (TOWN) - 300".
 *
 * The MAO municipality number is how a municipality is identified
 * everywhere off this app — MAO itself, roll lists, the assessment and
 * legal shards, every conversation with an assessor — so both places that
 * list municipalities show it beside the name (Jason, 2026-09-14).
 *
 * Two lists, one module, because they must agree: the Property Search
 * picker (a <select>, numbers looked up from the Roll Entry snapshot
 * manifest) and the Sales tab's municipality checkboxes (built from the
 * sales manifest, which is already keyed BY muni number). Same separator,
 * same order, same fallback when the number is unknown.
 *
 * Display only. Neither list's underlying value changes: the picker's
 * option value stays the muni name every query and URL read, and the
 * checkbox value stays the muni_no the sales shards are keyed on.
 *
 * Pure (no DOM) so node can exercise it.
 */

/**
 * Name and number as one string, number last: "ARBORG (TOWN) - 300".
 *
 * Appended, not prefixed. The name is what both lists are sorted by, what
 * the user is scanning for, and — in the <select> — what the browser's own
 * type-ahead matches, so a leading number would break all three.
 *
 * A missing or unusable number gives the bare name. A list reading
 * "ARBORG (TOWN) - undefined" would be worse than one that stays quiet
 * about the number.
 *
 * @param {string} name
 * @param {number|string|null|undefined} number
 */
export function formatMuniWithNumber(name, number) {
  const label = String(name ?? '');
  if (number == null || number === '') return label;
  const no = Number(number);
  if (!Number.isFinite(no)) return label;
  return `${label} - ${no}`;
}

/**
 * Municipality name → MAO municipality number, read off the Roll Entry
 * snapshot manifest ({ munis: { "ARBORG (TOWN)": { muni_no: 300, … } } }).
 *
 * The manifest is the only list the Property Search picker can get the
 * number from: the live Roll_Entry probe asks for distinct
 * Muni_Name_With_Typ and gets names alone. That is fine — the number is
 * decoration on the label, never the option's value — so a boot where the
 * manifest never lands just shows bare names rather than holding the
 * picker back for it. (The Sales tab needs none of this: its own manifest
 * is keyed by muni_no already.)
 *
 * @param {object|null} manifest the snapshot manifest, or null
 * @returns {Map<string, number>} empty when the manifest is absent or shaped
 *   unexpectedly
 */
export function muniNumberIndex(manifest) {
  const out = new Map();
  const munis = manifest?.munis;
  if (!munis || typeof munis !== 'object') return out;
  for (const [name, entry] of Object.entries(munis)) {
    const no = Number(entry?.muni_no);
    if (name && Number.isFinite(no)) out.set(name, no);
  }
  return out;
}

/**
 * One option's label in the Property Search municipality picker.
 *
 * @param {string} name
 * @param {Map<string, number>|null} numbers from muniNumberIndex()
 */
export function muniOptionLabel(name, numbers) {
  const no = numbers instanceof Map ? numbers.get(name) : undefined;
  return formatMuniWithNumber(name, no);
}

/**
 * Does a municipality answer the Sales tab's filter box?
 *
 * Name OR number. The number is on screen in every row now, so typing
 * "300" has to find Arborg — a visible identifier the filter ignores reads
 * as a broken filter. Matching the number is a substring match like the
 * name: "30" finds 300, 301 and 630, which is the same leading-edge
 * behaviour the name half has always had.
 *
 * @param {string} query raw contents of the filter box
 * @param {{label?: string, no?: string|number}} muni
 */
export function muniMatchesFilter(query, muni) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const name = String(muni?.label ?? '').toLowerCase();
  if (name.includes(q)) return true;
  return String(muni?.no ?? '').includes(q);
}
