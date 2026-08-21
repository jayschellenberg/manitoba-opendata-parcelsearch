// saleSize.js — the parcel's size AS AT THE SALE, and how far to trust the
// boundary currently drawn for it.
//
// THE PROBLEM. A comparable's price is fixed at the sale date; its size and
// shape are read from today's assessment roll. When the parcel was subdivided,
// consolidated or re-surveyed in between, those two describe different pieces
// of land — a 160-acre parcel split four ways since 2019 measures 40 acres
// today, so price-per-acre comes out four times too high and looks entirely
// ordinary on screen.
//
// THIS MODULE DOES NOT DECIDE WHICH SIZE IS RIGHT. mao-scrape's
// flag_parcel_changes.R already did, per sale, against sources the browser
// cannot see: the "LIST OF PROPERTY SALES" PDFs — the only record of at-sale
// size that exists — and the current assessment roll. export_sales_for_web.R
// ships its verdict in every shard as three columns:
//
//   Parcel Size / Parcel Size Unit  the size to analyse from. The PDF's
//                                   at-sale figure where one exists; today's
//                                   figure where the parcel is VERIFIED
//                                   unchanged; and BLANK where the parcel
//                                   changed and the at-sale size could not be
//                                   recovered.
//   Parcel Change                   change_signal — what evidence exists that
//                                   this parcel is or is not what sold.
//
// So the rule enforced here is narrow and absolute: **if Parcel Size carries a
// value, use it and never recompute; if it is blank, report nothing.**
// Substituting today's acreage into that blank is exactly the error the
// upstream pipeline exists to prevent, and the result would be a plausible
// wrong number rather than a visible gap.
//
// ABSENT IS NOT BLANK. A hand-pasted MAO comp set is the seven-column grid and
// carries none of these columns; salesCsvParse.js omits the keys entirely
// rather than emitting empty strings. That path has no at-sale information at
// all, so it keeps the legacy behaviour (today's acreage) — blanking every rate
// on a workflow that never claimed to be verified would be a regression, not a
// correction. `_saleSizeKnown` is what separates the two, and every accessor
// below branches on it.
//
// A FRONTAGE IS NOT AN AREA. Frontage_or_Area is a hybrid: roughly 63% of
// Manitoba parcels state an area and 37% a width, and `Parcel Size Unit`
// carries that distinction through from the PDF (A/F) or the roll. A FEET row
// yields a frontage and NO acreage — converting one to the other would
// fabricate an assessor statement that does not exist, the same refusal
// parseRollFrontageFeet already makes. Hectares and any other unit are refused
// for the same reason.
//
// Pure apart from acres.js, so it unit-tests without turf or the DOM.

import { parseRollFrontageFeet } from './acres.js';

// Units the export can state. `unit_for_analysis` is "ACRES"/"FEET" when it
// came from the PDF (mapped from the report's A/F), or whatever trailing word
// the roll string carried when it came from the current record — which is the
// same two words, occasionally singular.
const ACRE_UNITS = new Set(['ACRE', 'ACRES', 'AC']);
const FOOT_UNITS = new Set(['FEET', 'FOOT', 'FT']);

// Some service and export paths stringify a null as this literal; treat it as
// the blank it means rather than as a unit we don't recognise.
const NULL_LITERAL = '<NULL>';

const NO_SIZE = Object.freeze({ value: null, unit: null, acres: null, frontageFt: null });

const posOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const blankToNull = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return !s || s.toUpperCase() === NULL_LITERAL ? null : s;
};

/**
 * Read the export's `Parcel Size` + `Parcel Size Unit` pair into a size that
 * says what KIND of measurement it is.
 *
 * Returns acres XOR frontageFt — never both, never a conversion between them.
 * An unreadable value, a non-positive one, a missing unit or an unrecognised
 * unit all yield the empty result: the pair only means something together, and
 * a number whose unit we cannot name is not a size.
 *
 * @param {string|number|null} rawValue  the Parcel Size cell
 * @param {string|null} rawUnit          the Parcel Size Unit cell
 * @returns {{value:number|null, unit:'ACRES'|'FEET'|null,
 *            acres:number|null, frontageFt:number|null}}
 */
export function resolveSaleSize(rawValue, rawUnit) {
  const vs = blankToNull(rawValue);
  const us = blankToNull(rawUnit);
  if (!vs || !us) return NO_SIZE;
  const n = posOrNull(vs.replace(/,/g, ''));
  if (n == null) return NO_SIZE;
  const unit = us.toUpperCase();
  if (ACRE_UNITS.has(unit)) return { value: n, unit: 'ACRES', acres: n, frontageFt: null };
  if (FOOT_UNITS.has(unit)) return { value: n, unit: 'FEET', acres: null, frontageFt: n };
  return NO_SIZE;
}

/**
 * How much of the currently-drawn boundary this sale's evidence supports.
 *
 * Three states rather than two, for the same reason frontageRateState has
 * three: "we know it changed" and "we could not check" are different claims and
 * must not render identically.
 *
 *   confirmed    the at-sale size was measured and matches today — the polygon
 *                on screen is the parcel that sold.
 *   provisional  the legal description matches but no at-sale size existed to
 *                check it against. Real evidence, but partial: measured over
 *                148,874 comparable sales only 57.2% of size changes came with
 *                a legal change, so a matching legal misses ~43% of them.
 *   withheld     the parcel demonstrably changed, or nothing could be checked
 *                at all. Today's boundary is not what sold and must not be
 *                drawn as though it were.
 *   unknown      no signal available (a hand-pasted comp set). No claim is
 *                being made either way, so the renderer keeps legacy behaviour.
 *
 * An unrecognised non-empty signal fails SAFE to `withheld`: a verdict this
 * build does not understand is not evidence that the parcel is unchanged.
 *
 * @param {string|null} changeSignal  the Parcel Change cell
 * @returns {'confirmed'|'provisional'|'withheld'|'unknown'}
 */
export function geometryTrust(changeSignal) {
  const s = blankToNull(changeSignal);
  if (!s) return 'unknown';
  switch (s) {
    case 'verified_unchanged':           return 'confirmed';
    case 'legal_matches_size_unchecked': return 'provisional';
    case 'legal_changed_size_same':
    case 'legal_changed_size_unchecked':
    case 'size_changed':
    case 'unverifiable':                 return 'withheld';
    default:                             return 'withheld';
  }
}

/**
 * The Boundary column's cell text, from a stamped `_geomTrust`.
 *
 * Four states, not two, and deliberately not collapsed to a Yes/No. `unknown`
 * means no signal exists at all — a hand-pasted comp set carries none of the
 * Parcel Change data — and rendering that as "not changed" would assert
 * something nobody checked. It reads as an em-dash for the same reason a
 * missing at-sale size does: an honest gap beats a plausible wrong answer.
 *
 * `provisional` is its own word because the underlying signal
 * (legal_matches_size_unchecked) says the legal description still matches but
 * the size was never re-verified — likelier unchanged than not, but not
 * evidence of it.
 *
 * @param {string|null|undefined} trust  a `_geomTrust` value
 * @returns {string|null} cell text, or null for "no claim"
 */
export function boundaryTrustLabel(trust) {
  switch (trust) {
    case 'confirmed':   return 'Same';
    case 'provisional': return 'Likely same';
    case 'withheld':    return 'Changed';
    default:            return null;
  }
}

/** Sort rank for the Boundary column: most-changed first, no-claim last. */
export function boundaryTrustRank(trust) {
  switch (trust) {
    case 'withheld':    return 0;
    case 'provisional': return 1;
    case 'confirmed':   return 2;
    default:            return 3;
  }
}

/**
 * The `_sale*` properties to merge onto a matched parcel feature, given the
 * sale record it was matched to.
 *
 * Keyed on whether the record CARRIES `parcelSize` at all, not on whether the
 * value is empty — see the "absent is not blank" note at the top.
 *
 * @param {object|null} sale  a record from parseSalesCsv
 * @returns {object} properties to Object.assign onto the feature
 */
export function saleSizeStamp(sale) {
  if (!sale || !('parcelSize' in sale)) {
    return { _saleSizeKnown: false, _geomTrust: 'unknown' };
  }
  const size = resolveSaleSize(sale.parcelSize, sale.parcelSizeUnit);
  return {
    _saleSizeKnown:    true,
    _saleSizeUnit:     size.unit,
    _acresAtSale:      size.acres,
    _frontageAtSaleFt: size.frontageFt,
    _saleSizeBasis:    blankToNull(sale.sizeBasis),
    _saleChangeSignal: blankToNull(sale.parcelChange),
    _geomTrust:        geometryTrust(sale.parcelChange),
  };
}

/**
 * The acreage to analyse this row from, or null when there isn't one.
 *
 * On an export row that is the pipeline's figure and nothing else — a blank
 * stays blank. On a pasted row it falls back to today's acreage, which is all
 * that path has ever had.
 */
export function saleAcres(props) {
  if (props?._saleSizeKnown) return posOrNull(props._acresAtSale);
  return posOrNull(props?._acres);
}

/**
 * The frontage in feet to analyse this row from, or null.
 *
 * Same split as saleAcres. The legacy branch reads the roll string directly
 * rather than a stamped property so an area row ("160.00 ACRES") can never be
 * mistaken for a zero-foot frontage — see parseRollFrontageFeet.
 */
export function saleFrontageFeet(props) {
  if (props?._saleSizeKnown) return posOrNull(props._frontageAtSaleFt);
  return parseRollFrontageFeet(props?.Frontage_or_Area);
}

/**
 * What the row's size cell should SAY — three outcomes, not two.
 *
 *   legacy    no at-sale information exists for this row (regular search, or a
 *             pasted comp set). Show today's figure, unannotated.
 *   resolved  the pipeline supplied a size that is safe to analyse from.
 *   withheld  the pipeline deliberately supplied none. The cell must say so
 *             rather than fall back to a figure that would read as an answer.
 *
 * @returns {'legacy'|'resolved'|'withheld'}
 */
export function saleSizeState(props) {
  if (!props?._saleSizeKnown) return 'legacy';
  const hasSize = posOrNull(props._acresAtSale) != null
               || posOrNull(props._frontageAtSaleFt) != null;
  return hasSize ? 'resolved' : 'withheld';
}

/**
 * Plain-language source for the size this row displays, or '' when there is
 * nothing to attribute (a regular search or a pasted comp set, where the
 * acreage is simply today's and always has been).
 *
 * Naming the source is not decoration. "160 acres" from the property-sales
 * report and "160 acres" from today's roll are different claims — the first is
 * what sold, the second is what is there now and happens to match — and an
 * appraisal that quotes one has to be able to say which. Before size_basis was
 * exported the app could only say "sale-resolved" and lump the two together.
 *
 * Falls back to that vaguer wording when the column is absent, which is what an
 * older shard (exported before size_basis was added) still ships.
 */
export function sizeSourceLabel(props) {
  const state = saleSizeState(props);
  if (state === 'legacy') return '';
  switch (props?._saleSizeBasis) {
    case 'at_sale_pdf':       return 'at sale (property-sales report)';
    case 'current_unchanged': return 'current, verified unchanged since sale';
    case 'unknown_changed':   return 'withheld (parcel changed since sale)';
    case 'no_current_record': return 'withheld (no current parcel record)';
    default:
      return state === 'withheld'
        ? 'withheld (parcel changed since sale)'
        : 'sale-resolved (MAO sales export)';
  }
}

/**
 * Is the size on screen today's roll figure?
 *
 * Decides whether the roll-vs-polygon area check still applies to the cell it
 * decorates. That check compares two CURRENT figures, so on a row showing the
 * at-sale size it warns about numbers that appear nowhere — and on a withheld
 * row there is no size to warn about at all.
 */
export function showsCurrentRollSize(props) {
  const state = saleSizeState(props);
  if (state === 'legacy') return true;
  if (state === 'withheld') return false;
  // An older shard without size_basis can't distinguish the two resolved
  // cases. Keep the marker: on current_unchanged it is right, and on
  // at_sale_pdf it is merely imprecisely targeted — losing a real warning is
  // the worse error of the two.
  return props?._saleSizeBasis !== 'at_sale_pdf';
}

/**
 * Why this row's shape-derived values describe something other than what sold,
 * or '' when they don't.
 *
 * Soil composition, land cover, cultivated share, slope, CLI class and the
 * MASC rating are all computed by intersecting overlay layers with the
 * parcel's CURRENT polygon. On a parcel reconfigured after its sale that
 * polygon is a different piece of land — so those figures are wrong for the
 * comp in exactly the way the acreage was, just more quietly, because nothing
 * about a soil percentage looks like a size.
 *
 * They are NOT suppressed. Unlike the size, there is no at-sale substitute to
 * fall back to — no historical soil sampling of the old boundary exists — and
 * the figures remain true of the land that is there now, which is worth
 * knowing. What they need is their referent named, so the number is read as a
 * fact about today's parcel rather than about the transaction.
 *
 * Silent unless the boundary was actually withheld: on a confirmed or
 * provisional row the polygon IS (or plausibly is) what sold, and on a pasted
 * comp set no claim is being made either way.
 */
export function shapeDerivedNote(props) {
  return props?._geomTrust === 'withheld'
    ? 'current parcel — reconfigured since the sale'
    : '';
}
