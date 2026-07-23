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
//   centroid(feature) → {lng,lat}|null (lib/geometryText: parcelCentrePoint)
//   distanceKm(a, b)  → number         (main.js: haversineKm)
//
// Parcels are grouped by `properties._saleGroupId`. The sale price is a
// group-level consideration shared by every member, so it's read once
// from the first-seen parcel in each group (matching the original).

const SQFT_PER_ACRE = 43560;

/**
 * How far apart the parcels in one sale actually are: the greatest
 * distance between any two member centroids, in km.
 *
 * This is the signal behind flagging "far-flung" sales — a portfolio or
 * estate transaction that sweeps up land across half the province, whose
 * blended $/acre is meaningless as a local comp. Measuring the widest
 * internal gap (rather than counting municipalities) is what separates
 * those from a legitimate farm assembly that merely straddles one RM
 * boundary: adjacent-RM assemblies stay small, portfolio deals don't.
 *
 * O(n²) in group size, which is fine — sale groups run to ~18 parcels at
 * the very top end, so worst case is ~150 distance calculations.
 *
 * Purely the spread of the points handed in: null with fewer than two of
 * them, because one centroid says nothing about how far apart a group's
 * parcels are. Deciding that a SINGLE-PARCEL sale spans 0 km is the
 * caller's job — it's the only one that knows whether one usable
 * centroid means "one parcel" or "three parcels, two missing geometry".
 */
export function maxPairwiseKm(points, distanceKm) {
  if (!Array.isArray(points) || points.length < 2) return null;
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = distanceKm(points[i], points[j]);
      if (Number.isFinite(d) && d > max) max = d;
    }
  }
  return max;
}

/** Default far-flung cutoff, in km. Calibrated against a 556-row MAO
 *  export: ordinary multi-parcel farm assemblies topped out at 8.4 km
 *  and the portfolio sales started at 48.4 km, with nothing in between,
 *  so anything from 10 to 40 selects the same sales. 30 sits mid-gap.
 *  The user can override it; this is only where the input starts. */
export const DEFAULT_FAR_FLUNG_KM = 30;

/**
 * Is this sale's parcel spread wide enough to treat it as a portfolio
 * or estate transaction rather than a local comp?
 *
 * Fails OPEN on unknown spread (null span — a multi-parcel sale whose
 * members' geometry didn't resolve). This filter's job is to REMOVE
 * comps, so treating "we couldn't measure it" as "it's far-flung" would
 * silently discard good evidence. An incomplete-but-computable span is
 * still judged, since it can only understate the true spread — if the
 * part we CAN see already exceeds the threshold, the whole certainly
 * does.
 */
export function isFarFlungSale(props, thresholdKm) {
  const span = props?._saleGroupSpanKm;
  if (span == null || !Number.isFinite(span)) return false;
  if (!Number.isFinite(thresholdKm) || thresholdKm <= 0) return false;
  return span > thresholdKm;
}

/**
 * Human-readable reason string for the grid badge's tooltip and the map
 * popup, or '' when the sale isn't far-flung. Names the threshold that
 * produced the verdict so the user isn't left guessing why this sale
 * was singled out.
 */
export function farFlungReason(props, thresholdKm) {
  if (!isFarFlungSale(props, thresholdKm)) return '';
  const span = Math.round(props._saleGroupSpanKm);
  const munis = Number(props?._saleGroupMuniCount);
  const muniPart = Number.isFinite(munis) && munis > 1
    ? ` across ${munis} municipalities`
    : '';
  const caveat = props?._saleGroupSpanIncomplete
    ? ' (at least — some parcels had no geometry)'
    : '';
  return `Far-flung sale: parcels span ${span} km${muniPart}${caveat}. `
       + `Threshold ${thresholdKm} km.`;
}

/**
 * Compute per-group rollups for an array of GeoJSON-ish features.
 * Returns Map<saleGroupId, stamp>, where `stamp` is an object of the
 * `_saleGroup*` properties to copy onto every member feature. Features
 * with no `_saleGroupId` are skipped.
 */
export function computeSaleGroups(
  features,
  { parsePrice, displayRoll, isVacant, centroid, distanceKm },
) {
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
        // Geographic spread — member centroids, and the distinct
        // municipalities they fall in. See maxPairwiseKm().
        points: [],
        munis: new Set(),
        geomMissing: false,
      });
    }
    const g = groups.get(gid);
    g.oids.push(f.properties?.OBJECTID);
    g.rolls.push(displayRoll(f.properties?.Roll_No_Txt));

    // Spread inputs. A member without usable geometry can't contribute a
    // point, so the group's span is flagged incomplete rather than being
    // quietly computed from whichever parcels happen to have coordinates.
    const pt = centroid ? centroid(f) : null;
    if (pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lng)) g.points.push(pt);
    else g.geomMissing = true;
    // Municipality is reported alongside the span for context in the
    // export — the span is the signal, the muni list explains it.
    const muni = f.properties?.Municipality;
    if (muni) g.munis.add(String(muni).trim());

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
    // Span, with the single-parcel case resolved here rather than in
    // maxPairwiseKm: a one-parcel sale spans 0 km by definition, but a
    // multi-parcel sale that yielded only one usable centroid spans an
    // UNKNOWN distance, and the two must not collapse to the same value.
    // Unknown stays null so the eventual far-flung filter can fail open
    // — dropping a comp because its geometry didn't load would silently
    // lose good evidence.
    const spanKm = g.oids.length === 1
      ? 0
      : (distanceKm ? maxPairwiseKm(g.points, distanceKm) : null);
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
      // Geographic spread of the sale. `SpanIncomplete` means at least
      // one member had no usable geometry, so the span understates the
      // true spread and shouldn't be trusted as a hard cutoff.
      _saleGroupSpanKm: spanKm,
      _saleGroupSpanIncomplete: g.geomMissing,
      _saleGroupMuniCount: g.munis.size,
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
