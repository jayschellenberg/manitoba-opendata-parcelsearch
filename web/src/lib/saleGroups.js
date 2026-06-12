// Sale-group rollups + adjacency position — pure logic extracted from
// main.js's computeSaleGroupTotals (which now just stamps the result
// onto feature properties). These compute the appraisal-facing numbers
// for multi-parcel sales (price/acre, price/sf, price/lot, sale-to-
// assessed ratio) and the group vacancy roll-up, so the math is worth
// testing in isolation.
//
// All app-state dependencies are injected so this stays pure:
//   parsePrice(raw)   → number|null   (main.js: parseTotalValue)
//   displayRoll(raw)  → string        (main.js: displayRoll)
//   isVacant(props)   → true|false|null (main.js: parcelIsVacantDynamic)
//
// Parcels are grouped by `properties._saleGroupId`. The sale price is a
// group-level consideration shared by every member, so it's read once
// from the first-seen parcel in each group (matching the original).

const SQFT_PER_ACRE = 43560;

/**
 * Compute per-group rollups for an array of GeoJSON-ish features.
 * Returns Map<saleGroupId, stamp>, where `stamp` is an object of the
 * `_saleGroup*` properties to copy onto every member feature. Features
 * with no `_saleGroupId` are skipped.
 */
export function computeSaleGroups(features, { parsePrice, displayRoll, isVacant }) {
  const groups = new Map();

  // Pass 1: accumulate members + running totals.
  for (const f of features || []) {
    const gid = f?.properties?._saleGroupId;
    if (gid == null) continue;
    if (!groups.has(gid)) {
      groups.set(gid, {
        oids: [],
        rolls: [],
        totalAcres: 0,
        asmtTotal: 0,
        asmtIncomplete: false,
        priceNum: parsePrice(f.properties?._salePrice),
        acresIncomplete: false,
        // Strict group vacancy: stays true only while every member
        // passes the vacancy predicate with data present.
        allVacant: true,
        vacantUnknown: false,
      });
    }
    const g = groups.get(gid);
    g.oids.push(f.properties?.OBJECTID);
    g.rolls.push(displayRoll(f.properties?.Roll_No_Txt));

    const ac = Number(f.properties?._acres);
    if (Number.isFinite(ac) && ac > 0) g.totalAcres += ac;
    else g.acresIncomplete = true;

    const at = Number(f.properties?._asmtTotal);
    if (Number.isFinite(at) && at > 0) g.asmtTotal += at;
    else g.asmtIncomplete = true;

    const v = isVacant(f.properties);
    if (v === true) {
      // pass — keep allVacant as-is
    } else if (v === false) {
      g.allVacant = false;
    } else {
      // Missing data → group is 'unknown' so the strict filter excludes it.
      g.allVacant = false;
      g.vacantUnknown = true;
    }
  }

  // Pass 2: derive the per-group stamp (same value for every member).
  const stamps = new Map();
  for (const [gid, g] of groups) {
    const priceFinite = g.priceNum != null && Number.isFinite(g.priceNum) && g.priceNum > 0;
    stamps.set(gid, {
      _saleGroupSize: g.oids.length,
      _saleGroupRollIds: g.oids,
      _saleGroupRolls: g.rolls,
      _saleGroupTotalPriceNum: g.priceNum,
      _saleGroupTotalAcres: g.totalAcres,
      _saleGroupAcresIncomplete: g.acresIncomplete,
      _saleGroupAsmtTotal: g.asmtTotal,
      _saleGroupAsmtIncomplete: g.asmtIncomplete,
      _saleGroupSaleToAsmt:
        priceFinite && Number.isFinite(g.asmtTotal) && g.asmtTotal > 0 && !g.asmtIncomplete
          ? g.priceNum / g.asmtTotal
          : null,
      _saleGroupAllVacant: g.allVacant,
      _saleGroupVacantUnknown: g.vacantUnknown,
      _saleGroupPpa:
        priceFinite && g.totalAcres > 0 && !g.acresIncomplete
          ? g.priceNum / g.totalAcres
          : null,
      _saleGroupPpsf:
        priceFinite && g.totalAcres > 0 && !g.acresIncomplete
          ? g.priceNum / (g.totalAcres * SQFT_PER_ACRE)
          : null,
      _saleGroupPpl:
        priceFinite && g.oids.length > 0 ? g.priceNum / g.oids.length : null,
    });
  }
  return stamps;
}

/**
 * Adjacency position of a row within its sale group, given the group
 * ids of the previous and next rows in the current sort order. Used to
 * draw the connecting stripe/tint only when sibling rows are adjacent.
 * 'solo' = part of a multi-parcel group but with non-sibling neighbours.
 */
export function groupPosition(prevGid, gid, nextGid) {
  const prevSame = prevGid === gid;
  const nextSame = nextGid === gid;
  if (!prevSame && nextSame) return 'first';
  if (prevSame && nextSame) return 'middle';
  if (prevSame && !nextSame) return 'last';
  return 'solo';
}
