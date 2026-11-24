// condoUnit.js — is this roll a condominium unit? (2026-11-24)
//
// MAO's sales export carries a short legal ("4--66600") that reads the same
// for a condo unit as for a lot on a plan, and its Sale Type Group marks
// almost no commercial condos. The legal index's DETAIL field does tell them
// apart: a unit's detail opens with a single-dash `plan-unit` pair
// ("39000-1 …"), the signature legalIndex.core.js already parses for the
// Property Search condo search. It sits on about 99% of the rolls assessed as
// Residential 3 (condominium), and on the commercial units that no assessment
// class or sale type separates out — which is what the Sales tab's Condo
// units filter is for (Jason, 2026-11-24).
//
// What it cannot say: a bare-land condominium plan carries the same
// signature, so "condo unit" here means "a unit on a condominium plan",
// built or not. And a roll the legal index has no record for is simply not
// known to be one.

import { deriveCondoTokens } from '../legalIndex.core.js';

/** The Condo units filter's values, in menu order. */
export const CONDO_FILTER_MODES = Object.freeze(['any', 'only', 'exclude']);

/**
 * The condo plan and unit(s) a legal names, or null when it is not a unit.
 * @param {string} description legal_description from the legal index
 * @param {string} detail      legal_detail from the legal index
 * @returns {{plan:string, units:string[]}|null}
 */
export function condoUnitOf(description, detail) {
  const tokens = deriveCondoTokens(description, detail);
  if (!tokens) return null;
  let plan = '';
  const units = [];
  for (const tok of tokens.split(';')) {
    if (!tok) continue;
    const [p, u] = tok.split('|');
    if (!plan) plan = p;
    if (p === plan && u && !units.includes(u)) units.push(u);
  }
  return plan ? { plan, units } : null;
}

const MAX_UNITS_SHOWN = 4;

/** Grid text: "39000 - 1", "39000 - 1, 2, 3", "39000 - 1, 2, 3, 4 +6". '' when none. */
export function condoUnitLabel(plan, units) {
  if (!plan) return '';
  const list = Array.isArray(units) ? units : String(units || '').split(',').filter(Boolean);
  if (!list.length) return String(plan);
  const shown = list.slice(0, MAX_UNITS_SHOWN).join(', ');
  const more = list.length - MAX_UNITS_SHOWN;
  return `${plan} - ${shown}${more > 0 ? ` +${more}` : ''}`;
}

/**
 * Sort key: by plan, then by first unit, so the units of one building sit
 * together. Rows that are not units sort after every unit.
 */
export function condoSortKey(plan, units) {
  const p = Number(plan);
  if (!plan || !Number.isFinite(p)) return Number.MAX_SAFE_INTEGER;
  const first = Array.isArray(units) ? units[0] : String(units || '').split(',')[0];
  const u = Number(first);
  return p * 100000 + (Number.isFinite(u) ? Math.min(u, 99999) : 0);
}

/** The key condoSaleKeys files a row's sale under. */
export function saleKeyOf(p, rowIdx) {
  return p?._saleGroupId != null ? `g:${p._saleGroupId}` : `r:${rowIdx}`;
}

/**
 * Which sales include a condo unit. A sale is read across all its parcels,
 * like the Outline filter: it counts as a condo sale when ANY parcel is a
 * unit, so an assembly is kept or dropped whole and its group rates keep
 * describing everything the price bought.
 *
 * @param {Array} rows grid rows ({ parcel: { properties } })
 * @returns {Set<string>} sale keys — `g:<group id>` or `r:<row index>`
 */
export function condoSaleKeys(rows) {
  const keys = new Set();
  (rows || []).forEach((r, i) => {
    const p = r?.parcel?.properties || {};
    if (p._condoPlan) keys.add(saleKeyOf(p, i));
  });
  return keys;
}

/** Does a sale pass the filter? `isCondoSale` from condoSaleKeys. */
export function passesCondoFilter(mode, isCondoSale) {
  if (mode === 'only') return !!isCondoSale;
  if (mode === 'exclude') return !isCondoSale;
  return true;
}
