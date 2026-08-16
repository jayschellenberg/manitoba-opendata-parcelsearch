/*
 * Primary Property — a two-layer filter over MAO's primary-structure
 * descriptor.
 *
 *   Layer 1, FAMILY: Residential / ICI / Farm / Uncategorized.
 *   Layer 2, SUBCATEGORY: the kind of structure within that family —
 *     One storey, Bi-level, Cottage, Warehouse, Grain storage...
 *
 * WHY TWO LAYERS AND NOT A FLAT LIST. The descriptor is free text with 565
 * distinct values province-wide (median 100 per municipality, 215 in
 * Brandon). A flat checkbox list at that length is unusable, and the
 * distinctions it draws are mostly irrelevant to comp selection: "1 STY RES
 * AVG QUALITY" and "1 STY RES AVG QUALITY 2X6" differ by wall framing.
 * The subcategory is the unit an appraiser actually reaches for.
 *
 * WHY THE FAMILY COMES FROM Sale Type Group, NOT FROM THE DESCRIPTOR.
 * MAO already classifies every sale, that column is 100% populated, and
 * the app already filters on it at load time (#sales-db-type). Parsing the
 * descriptor instead would contradict it: apartment blocks are the largest
 * ICI descriptor group (34.7% of non-blank ICI) but read "residential" to
 * the eye, while GARAGE and WOOD FRAME STORAGE SHED sit under Residential.
 * The Sale Type Group always wins where it exists.
 *
 * WHY THERE IS A FALLBACK ANYWAY. A hand-pasted MAO comp set is the
 * seven-column grid — Sale Date … Primary Property — with no type column
 * at all, so layer 1 would have no source on the paste path.
 * inferFamily() covers it, and it can afford to: measured against all
 * 239,011 archived sales that carry both columns, it agrees with MAO's own
 * classification 99.836% of the time. That works because the descriptor
 * vocabulary is partitioned by family — of 567 distinct descriptors,
 * exactly ONE ("STG - SHIPPING CONTAINER", 10 sales) appears under more
 * than one. The 0.16% residue is MAO's own catch-alls ("OTHER",
 * "CODE/TYPE NO LONGER USED", "UNIQUE ICI STRUCTURE"), which no string
 * rule can place; they land in Uncategorized rather than guessing.
 *
 * WHY BLANK IS A SUBCATEGORY, NOT A DROPPED ROW. 56.4% of archived sales
 * carry NO descriptor — they are bare land. The app's usual "missing =
 * exclude" rule would silently discard more than half the archive and give
 * no way to select FOR bare land. And the blank share swings hard by
 * family (45% Residential, 71% ICI, 96% Farm), so one global blank bucket
 * would merge populations that have nothing to do with each other. Hence
 * NO_STRUCTURE lives inside each family.
 *
 * Figures above are from the 2026-08-16 archive, 545,146 sales across 111
 * municipality shards.
 *
 * Pure (no DOM / no network) so the taxonomy can be unit-tested in node.
 */

/** Family shown for a sale whose type is neither Residential, ICI nor Farm. */
export const UNCATEGORIZED = 'Uncategorized';

/**
 * The subcategory for a sale carrying no descriptor at all. Sorted last
 * within its family, the same way zoneCategory.js sorts "(no category)"
 * behind the real types.
 */
export const NO_STRUCTURE = '(no primary structure)';

/** Display order of the families. Anything unrecognised sorts to the end. */
export const FAMILY_ORDER = ['Residential', 'ICI', 'Farm', UNCATEGORIZED];

/**
 * Subcategory rules, per family. ORDERED — first match wins, and the order
 * is load-bearing:
 *
 *   "1 STY AVG Q 2X6 ROW HSG" matches both the row-housing and the
 *   one-storey rule. Row housing runs first because it is the more
 *   specific claim; reversed, the townhouse rows would vanish into One
 *   storey and the Row housing entry would never fire.
 *
 * Patterns are matched against the UPPERCASED descriptor, so they carry no
 * /i flag — the source data is already uppercase and normalising once is
 * cheaper than a flag on every test.
 *
 * Coverage against every non-blank descriptor in the 2026-08-16 archive:
 * Residential 99.98%, Farm 100%, ICI 97.2%. The ICI residue is honest
 * rather than a gap — it is largely MAO's own OTHER and CODE/TYPE NO
 * LONGER USED.
 */
export const SUBCATEGORY_RULES = {
  Residential: [
    // Townhouse/row markers, in every abbreviation MAO ships. Must precede
    // the storey rules, which would otherwise claim these rows.
    ['Row housing / townhouse',   /ROW HSG|ROW HOUSING|ROW HS|RO HS|RH$/],
    ['Mobile / manufactured',     /MOBILE HOME|MOBILE HM|TRAILER/],
    ['Cottage / seasonal',        /COTTAGE|COT AVG|COT LOW|COT GOOD|GUEST HOUSE|SEASONAL/],
    ['Garage / outbuilding',      /GARAGE|STORAGE SHED|\bSHED\b|CARPORT|GAZEBO/],
    ['Bi-level',                  /BI LEVEL|BI-LEVEL|BI LEV/],
    ['Split level (3/4 level)',   /\d LEVEL RES/],
    // The storey rules anchor at the start so "MULTI STY ... " (an ICI
    // shape) can never be dragged in here by a bare STY.
    ['Storey and a half / 1 3/4', /^1 ?1\/2 STY|^1 3\/4 STY/],
    ['Two storey',                /^2 STY|^1 ?STY\/2 ?STY|^2 STOREY/],
    ['One storey',                /^1 ?STY|^1 STOREY/],
  ],
  ICI: [
    ['Apartment / multi-res',     /\bAPT\b|APARTMENT/],
    ['Warehouse / storage',       /WAREHOUSE|WHSE|\bWHS\b|HANGAR/],
    // MAO ships the truncations "RESTAURNT", "RESTAURAN" and "RESTAUR";
    // a strict /RESTAURANT/ drops 100-odd sales, so match the stem.
    ['Restaurant / food',         /RESTAUR|LOUNGE|FAST FOOD/],
    // STORE(?!Y) so "1 STOREY FRAME WORKSHOP" is not read as a store.
    ['Store / retail',            /STORE(?!Y)|STRIP MALL|RETAIL|GROCERY|SUPERMARKET|DEALERSHIP|\bS\/O\b|STR\/OFF/],
    ['Office / bank',             /OFFICE|BANK/],
    ['Hotel / motel',             /HOTEL|MOTEL/],
    ['Shop / industrial',         /MACHINE SHOP|MACH SHOP|RIGID STEEL|LIGHT STEEL|ARCH RIB|QUONSET|\bSHOP\b|TOWER|ELEVATOR|BULK PLANT/],
    ['Service / automotive',      /SERVICE STATION|CAR WASH|CONV\/GAS|SERVICE CENTRE|GAS\b/],
    ['Institutional / community', /CHURCH|COMMUNITY HALL|GOLF|SCHOOL|ARENA|VETERINARY|CLINIC|THEATRE|FUNERAL/],
    ['Mobile home park',          /MOBILE HOME PARK/],
  ],
  Farm: [
    ['Grain storage',             /GRAIN|GRANARY|GRNARY|FEED TANK|SILO/],
    ['Livestock barn',            /BARN|HOG|POULTRY|DAIRY|HORSE|PIGGERY|LOOSE HOUSING|MILKHOUSE/],
    ['Machine shed / shop',       /MACH|WORKSHOP|SHED|SHELTER/],
    ['Other farm structure',      /POTATO|SLURRY|GREENHOUSE|POLYDOME|FERTILIZER|TANK/],
  ],
};

/** The bucket for a descriptor none of a family's rules claim. */
export const OTHER_SUBCATEGORY = 'Other';

/**
 * Family markers for the paste path, where no Sale Type Group exists.
 * ORDERED, and the order encodes MAO's conventions rather than intuition:
 *
 *   1. Apartments are ICI in MAO's classification, and they carry "STY"
 *      ("2-3 STY FRAME APT"), so they must be claimed before the
 *      residential storey markers.
 *   2. Farm livestock/grain markers next: "1 STOREY HOG BARN" reads as
 *      residential to a naive storey match.
 *   3. Farm machine buildings, spelled out rather than matched on a bare
 *      MACH — ICI has "POLE TYPE MACHINE SHOP" while Farm has "ARCH RIB
 *      MACHINE SHOP" and "POLE MACH SHOP OR SHELTER".
 *   4. ICI markers.
 *   5. Residential last, as the broad catch.
 */
const FAMILY_MARKERS = [
  ['ICI',   /\bAPT\b|APARTMENT|MOBILE HOME PARK/],
  ['Farm',  /BARN|\bHOG|POULTRY|DAIRY|PIGGERY|LOOSE HOUSING|MILKHOUSE|HORSE|GRAIN|GRANARY|GRNARY|SILO|SLURRY|POLYDOME|POTATO|HAY |FEED TANK|TRENCH|LIQUID FERT/],
  ['Farm',  /MACH SHED|MACH STG|MACH SHOP OR|ARCH RIB MACHINE SHOP|STL MACH|QUONSET MACH|MACH, DAIRY|POLE OR POST MACH|MACHINE SHED|FRAME WORKSHOP/],
  ['ICI',   /WAREHOUSE|WHSE|\bWHS\b|STORE(?!Y)|\bS\/O\b|STR\/OFF|OFFICE|BANK|RESTAUR|LOUNGE|FAST FOOD|HOTEL|MOTEL|CHURCH|COMMUNITY HALL|GOLF|MALL|RETAIL|GROCERY|SUPERMARKET|DEALERSHIP|SERVICE STATION|CAR WASH|CONV\/GAS|MACHINE SHOP|RIGID STEEL|LIGHT STEEL|ARCH RIB|QUONSET|TOWER|HANGAR|SERVICE CENTRE|GAS\b|VETERINARY|CLINIC|ELEVATOR|BULK PLANT|\bEPH\b|THEATRE|BOWLING|FUNERAL|LAUNDR|DAY CARE/],
  ['Residential', /STY|STOREY|\bSTG\b|LEVEL|BI LEV|COTTAGE|\bCOT\b|MOBILE HOME|MOBILE HM|TRAILER|GARAGE|SHED|SHELTER|ROW HSG|ROW HOUSING|GUEST HOUSE|GAZEBO|LEAN-TO|BOATHOUSE|VERANDAH|CARPORT|DUPLEX|WORKSHOP/],
];

/** Uppercase + collapse whitespace, so every rule sees one shape. */
function norm(value) {
  return String(value ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Family implied by the descriptor alone. Exported for testing; callers
 * should use familyOf(), which prefers the authoritative column.
 */
export function inferFamily(primaryProperty) {
  const v = norm(primaryProperty);
  if (!v) return UNCATEGORIZED;
  for (const [family, pattern] of FAMILY_MARKERS) {
    if (pattern.test(v)) return family;
  }
  return UNCATEGORIZED;
}

/**
 * The family a sale belongs to.
 *
 * Sale Type Group is authoritative when present — its first token is the
 * family ("RESIDENTIAL LAND AND BUILDINGS" -> Residential, "ICI BARE LAND"
 * -> ICI). Only when the column is absent, as on the paste path, does the
 * descriptor get a vote.
 *
 * A sale with NEITHER (no type column and no descriptor — a bare-land row
 * in a pasted set) is Uncategorized, which is honest: nothing in the data
 * says what it was.
 */
export function familyOf(saleTypeGroup, primaryProperty) {
  const type = norm(saleTypeGroup);
  if (type) {
    const head = type.split(' ')[0];
    if (head === 'RESIDENTIAL') return 'Residential';
    if (head === 'ICI') return 'ICI';
    if (head === 'FARM') return 'Farm';
    return UNCATEGORIZED;
  }
  return inferFamily(primaryProperty);
}

/**
 * The subcategory within a family. A blank descriptor is NO_STRUCTURE —
 * bare land, which is 56.4% of the archive and a thing you filter FOR, not
 * a row to drop.
 */
export function subcategoryOf(family, primaryProperty) {
  const v = norm(primaryProperty);
  if (!v) return NO_STRUCTURE;
  for (const [name, pattern] of SUBCATEGORY_RULES[family] || []) {
    if (pattern.test(v)) return name;
  }
  return OTHER_SUBCATEGORY;
}

/**
 * Stable key for one tickable subcategory.
 *
 * Composite, because subcategory names are NOT unique across families —
 * "Other" exists under both Residential and ICI, and ticking one must not
 * silently tick the other. The separator is a character MAO never emits in
 * either half.
 */
export function optionKey(family, subcategory) {
  return `${family}|${subcategory}`;
}

/** The key a row would be filtered by. */
export function rowOptionKey(saleTypeGroup, primaryProperty) {
  const family = familyOf(saleTypeGroup, primaryProperty);
  return optionKey(family, subcategoryOf(family, primaryProperty));
}

/**
 * Sort subcategories for display: real structures alphabetically, then
 * "Other", then "(no primary structure)". The two catch-alls go last
 * because they are where you look when the real ones did not answer.
 */
function subcategoryRank(name) {
  if (name === NO_STRUCTURE) return 2;
  if (name === OTHER_SUBCATEGORY) return 1;
  return 0;
}

/**
 * The family/subcategory tree offered by a row set.
 *
 * Built from the FULL row set, never the filtered one: a list that shrank
 * as you ticked boxes would strand you with no way back (the same rule
 * zoningCodesInRows follows). Families and subcategories with no rows are
 * omitted entirely, so every option on screen is guaranteed to keep at
 * least one sale.
 *
 * Counts are PARCEL rows, matching what the grid shows. On a multi-parcel
 * sale that is more than one row, while the filter itself works on whole
 * sales — see matchingSaleGroupIds.
 *
 * `saleTypeOf` / `primaryOf` extract the two fields, keeping this module
 * free of the caller's row shape.
 *
 * @returns {Array<{family: string, count: number,
 *                  options: Array<{value: string, label: string, count: number}>}>}
 */
export function primaryPropertyTree(rows, { saleTypeOf, primaryOf } = {}) {
  const byFamily = new Map();
  for (const row of rows || []) {
    const type = saleTypeOf ? saleTypeOf(row) : row?.saleTypeGroup;
    const desc = primaryOf ? primaryOf(row) : row?.primaryProperty;
    const family = familyOf(type, desc);
    const sub = subcategoryOf(family, desc);
    if (!byFamily.has(family)) byFamily.set(family, new Map());
    const subs = byFamily.get(family);
    subs.set(sub, (subs.get(sub) || 0) + 1);
  }

  const families = [...byFamily.keys()].sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a), ib = FAMILY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  return families.map((family) => {
    const subs = byFamily.get(family);
    const options = [...subs.entries()]
      .sort((a, b) => subcategoryRank(a[0]) - subcategoryRank(b[0]) || a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ value: optionKey(family, label), label, count }));
    return {
      family,
      count: options.reduce((s, o) => s + o.count, 0),
      options,
    };
  });
}

/**
 * Sale groups with at least one parcel matching the ticked subcategories.
 *
 * GROUP semantics, deliberately — the same rule the far-flung, size and
 * price filters use. A multi-parcel sale passes or fails as one
 * transaction, because dropping half of one would leave its group $/acre
 * and $/sf describing parcels no longer on screen.
 *
 * Returns null when nothing is ticked, which callers read as "no filter"
 * rather than "nothing matches".
 *
 * A row with no group id keys on its own identity, so an ungrouped row
 * still filters correctly instead of joining a phantom group.
 */
export function matchingSaleGroupIds(rows, selected, { saleTypeOf, primaryOf, groupIdOf } = {}) {
  if (!selected || selected.size === 0) return null;
  const out = new Set();
  for (const row of rows || []) {
    const type = saleTypeOf ? saleTypeOf(row) : row?.saleTypeGroup;
    const desc = primaryOf ? primaryOf(row) : row?.primaryProperty;
    if (!selected.has(rowOptionKey(type, desc))) continue;
    const id = groupIdOf ? groupIdOf(row) : row?.groupId;
    out.add(id == null ? row : id);
  }
  return out;
}

/** Does this row belong to one of the matching sale groups? */
export function rowPassesPrimaryProperty(row, matching, { groupIdOf } = {}) {
  if (!matching) return true;
  const id = groupIdOf ? groupIdOf(row) : row?.groupId;
  return matching.has(id == null ? row : id);
}
