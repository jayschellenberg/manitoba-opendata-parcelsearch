/*
 * saleDate.js — parsing the sales-CSV Sale Date cell, and the sort key
 * the results grid orders that column by.
 *
 * Extracted from main.js so the parse and the ordering can be unit-tested
 * without the DOM. Pure and dependency-free.
 *
 * WHY THE SORT KEY IS SEPARATE FROM THE PARSE. The grid used to sort the
 * Sale Date column as the raw string it displays — "30-Jan-26". That is
 * `DD-Mmm-YY`, so a lexical sort orders by DAY first and then compares
 * month NAMES alphabetically: 1-Apr-19 < 1-Aug-24 < 1-Dec-21, and every
 * year lands wherever its day-of-month put it. The column looked sorted
 * and was not, which on a comp grid is worse than an obviously broken
 * one. Sorting on the parsed instant fixes it for both directions.
 */

// Two month-name forms reach this parser, and BOTH sort alphabetically by
// month name as raw strings, which is the bug this module exists to end:
//
//   `Mmm DD, YYYY`  "Aug 06, 2026" — what export_sales_for_web.R writes into
//                   the Sale Date column, so it is what the great majority of
//                   rows actually carry.
//   `DD-Mmm-YY`     "30-Jan-26" — the older two-digit-year convention, still
//                   what a hand-pasted MAO block can arrive as.
//
// Both are matched explicitly rather than left to `new Date(str)`. The
// month-name-first form does parse in V8, but its handling is
// implementation-defined, and the dominant format in the data should not
// depend on the engine's discretion — nor on whether the engine picks local
// or UTC midnight for it.
const SALE_DATE_RE = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/;
const SALE_DATE_MDY_RE = /^([A-Za-z]{3,})\.?\s+(\d{1,2})\s*,?\s+(\d{4})$/;
const SALE_DATE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

/** Local-midnight Date for a y/m/d triple, or null when any part is unusable. */
function localDate(year, mon, day) {
  if (!Number.isFinite(day) || mon == null || !Number.isFinite(year)) return null;
  const d = new Date(year, mon, day);
  return Number.isFinite(d.valueOf()) ? d : null;
}

/**
 * Parse the sales-CSV Sale Date column into a Date object. Falls back to
 * Date.parse for anything else (so YYYY-MM-DD / ISO strings still work if
 * the upstream CSV format ever shifts, and so the HTML5 date inputs in the
 * sales filters can share this function).
 *
 * The two-digit year disambiguates against a 50-year sliding window:
 * 00-49 → 20xx, 50-99 → 19xx. Manitoba sales data is firmly in the
 * 21st century, so this is just defensive.
 *
 * Dates are built at LOCAL midnight (`new Date(y, m, d)`). charts/main.js
 * parses its effective-date input the same way on purpose — see the note
 * on effectiveMs() there.
 *
 * Returns null when the string can't be parsed — callers treat that
 * as "skip the date check" so a malformed date doesn't drop the row.
 */
export function parseSaleDate(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = str.match(SALE_DATE_RE);
  if (m) {
    let year = parseInt(m[3], 10);
    if (m[3].length === 2) year = (year < 50 ? 2000 : 1900) + year;
    const d = localDate(year, MONTHS[m[2].toLowerCase()], parseInt(m[1], 10));
    if (d) return d;
  }
  // "Aug 06, 2026" / "August 6 2026" — the export's own format. The month is
  // keyed on its first three letters so the full name works too.
  const mdy = str.match(SALE_DATE_MDY_RE);
  if (mdy) {
    const d = localDate(parseInt(mdy[3], 10), MONTHS[mdy[1].slice(0, 3).toLowerCase()],
                        parseInt(mdy[2], 10));
    if (d) return d;
  }
  // 'YYYY-MM-DD' — what the sale-date range inputs hand us, and what the
  // upstream CSV would shift to if it ever went ISO. Built at LOCAL midnight
  // like the two above: `new Date('2026-01-30')` is UTC midnight, which lands
  // on the 29th west of Greenwich, and comparing that against a local-midnight
  // sale date puts the range bounds a day out.
  const iso = str.match(SALE_DATE_ISO_RE);
  if (iso) {
    const d = localDate(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    if (d) return d;
  }
  // Last resort: hand anything else to the engine rather than dropping it.
  const fallback = new Date(str);
  return Number.isFinite(fallback.valueOf()) ? fallback : null;
}

/**
 * Sort key for the grid's Sale Date column: the sale's instant in epoch ms,
 * or -Infinity when there is no readable date.
 *
 * -Infinity is the grid's numeric "blank" sentinel (see sortRows in
 * main.js), which parks undated and unparseable rows at the bottom in BOTH
 * sort directions rather than letting them masquerade as the oldest sales.
 *
 * @param {string|null|undefined} raw  the `_saleDate` cell
 * @returns {number} epoch ms, or -Infinity for "no date"
 */
export function saleDateSortKey(raw) {
  const d = parseSaleDate(raw);
  return d ? d.getTime() : -Infinity;
}
