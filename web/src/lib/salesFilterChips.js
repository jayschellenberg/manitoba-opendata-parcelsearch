/**
 * Which "Additional filters" controls on the Sales Analysis tab are set.
 *
 * The disclosure is collapsed by default, and two of its controls (the
 * Far-Flung threshold and its Exclude toggle) persist between sessions,
 * so a filter set there can drop comps with nothing on screen to say so
 * (Jason, 2026-09-05). main.js snapshots the controls into a plain object
 * and this turns it into chips — one per control that is away from its
 * default — for the warning badge in the disclosure's summary and the
 * note on the count line above the results table.
 *
 * Pure so it can be tested without a DOM. "Set" means the control is
 * away from its default, which is what the badge reports; a chip's
 * `active` flag says whether the control is narrowing results RIGHT NOW
 * (a Bldg Threshold with All Sales selected is set but idle), and the
 * `detail` says the same in words for the tooltip.
 *
 * The snapshot's fields mirror the controls, top to bottom:
 *   plan, streetName                      text inputs
 *   sizeUom ('acres'|'sf'|'ff'), sizeLow, sizeHigh
 *   ppaLow, ppaHigh, priceLow, priceHigh  number inputs (strings from the DOM)
 *   zoning, zoneCat                       arrays of ticked values
 *   groupSize ('any'|'single'|'multi'), n1 ('any'|'matched'|'unmatched')
 *   vacantImproved ('all'|'vacant'|'improved')  — the selector OUTSIDE the
 *                                         disclosure that the two below tune
 *   vacantThreshold, vacantMode ('pct'|'dollar'), saleAsmtMax
 *   farFlungKm, farFlungExclude (boolean)
 *   subjectRoll, hasSubject (boolean), distanceMax
 */

/** The Bldg Threshold input's default: 5 (%), matching index.html. */
export const VACANT_THRESHOLD_DEFAULT_PCT = 5;

const UNIT_LABEL = { acres: 'ac', sf: 'SF', ff: 'ft' };

function text(v) {
  return v == null ? '' : String(v).trim();
}

/** A finite number from a DOM value, or null for blank / junk. */
function num(v) {
  const s = text(v);
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function list(v) {
  return Array.isArray(v) ? v.map(text).filter(Boolean) : [];
}

const money = (n) => `$${Math.round(n).toLocaleString('en-CA')}`;

/** "10–20 ac", "≥ 10 ac", "≤ 20 ac", or '' when neither bound is set. */
export function rangeLabel(lo, hi, unit = '', fmt = String) {
  const u = unit ? ` ${unit}` : '';
  if (lo != null && hi != null) return `${fmt(lo)}–${fmt(hi)}${u}`;
  if (lo != null) return `≥ ${fmt(lo)}${u}`;
  if (hi != null) return `≤ ${fmt(hi)}${u}`;
  return '';
}

/** First few values, then "+N": a chip must stay a chip. */
function fewOf(values, max = 3) {
  if (values.length <= max) return values.join(', ');
  return `${values.slice(0, max).join(', ')} +${values.length - max}`;
}

/**
 * One chip per Additional-filters control that is away from its default.
 * @returns {Array<{key: string, label: string, detail: string, active: boolean}>}
 */
export function salesFilterChips(s = {}) {
  const chips = [];
  const push = (key, label, detail, active = true) => chips.push({ key, label, detail, active });

  const plan = text(s.plan);
  if (plan) push('plan', `Plan ${plan}`, `Plan # contains "${plan}"`);

  const street = text(s.streetName);
  if (street) push('street', `Street ${street}`, `Property address contains "${street}"`);

  // Size. Ac and SF are only units for the two boxes, so with both empty
  // they filter nothing. FF is a cohort as well as a unit — it drops every
  // parcel whose roll states an area instead of a frontage (about 63%) the
  // moment it is selected — so FF counts as set on its own.
  const uom = UNIT_LABEL[s.sizeUom] ? s.sizeUom : 'acres';
  const sizeLo = num(s.sizeLow);
  const sizeHi = num(s.sizeHigh);
  if (uom === 'ff') {
    const range = rangeLabel(sizeLo, sizeHi, 'ft');
    push('size',
      range ? `Frontage ${range}` : 'Frontage (FF) only',
      'Size unit is FF: parcels whose roll states an area instead of a frontage '
        + '(about 63%) are dropped'
        + (range ? `; frontage ${range}` : ''));
  } else if (sizeLo != null || sizeHi != null) {
    const range = rangeLabel(sizeLo, sizeHi, UNIT_LABEL[uom]);
    push('size', `Size ${range}`,
      `Sale-group size ${range} (${uom === 'sf' ? 'square feet' : 'acres'})`);
  }

  const ppaLo = num(s.ppaLow);
  const ppaHi = num(s.ppaHigh);
  if (ppaLo != null || ppaHi != null) {
    const range = rangeLabel(ppaLo, ppaHi, '', money);
    push('ppa', `$/Ac ${range}`, `$/Acre (sale-group rate) ${range}`);
  }

  const priceLo = num(s.priceLow);
  const priceHi = num(s.priceHigh);
  if (priceLo != null || priceHi != null) {
    const range = rangeLabel(priceLo, priceHi, '', money);
    push('price', `Price ${range}`, `Total sale price ${range}`);
  }

  const zoning = list(s.zoning);
  if (zoning.length) push('zoning', `Zoning ${fewOf(zoning)}`, `Zoning code: ${zoning.join(', ')}`);

  const zoneCat = list(s.zoneCat);
  if (zoneCat.length) {
    push('zoneCat', `Zoning type ${fewOf(zoneCat)}`, `Zoning type: ${zoneCat.join(', ')}`);
  }

  const groupSize = text(s.groupSize);
  if (groupSize === 'single') {
    push('groupSize', 'Single parcel', 'Parcels per sale: single-parcel sales only');
  } else if (groupSize === 'multi') {
    push('groupSize', 'Multi-parcel', 'Parcels per sale: multi-parcel sales only');
  }

  const n1 = text(s.n1);
  if (n1 === 'matched') push('n1', 'N1 matched', 'N1 crosswalk: matched sales only');
  else if (n1 === 'unmatched') push('n1', 'N1 unmatched', 'N1 crosswalk: unmatched sales only');

  // Bldg Threshold tunes the Vacant/Improved selector, which lives OUTSIDE
  // the disclosure. Away from its default it is set — and worth naming,
  // since a 10% left over from an earlier job changes which sales read as
  // vacant — but it is only narrowing results while that selector is not
  // on All Sales; the detail says which.
  const vi = text(s.vacantImproved) || 'all';
  const mode = s.vacantMode === 'dollar' ? 'dollar' : 'pct';
  const thr = num(s.vacantThreshold);
  const thresholdSet = mode === 'dollar'
    || (thr != null && thr !== VACANT_THRESHOLD_DEFAULT_PCT);
  if (thresholdSet) {
    const idle = vi === 'all';
    const bound = mode === 'dollar' ? money(thr ?? 0) : `${thr}%`;
    push('vacantThreshold', `Bldg < ${bound}`,
      `Vacant-land threshold: buildings under ${bound}${mode === 'pct' ? ' of total' : ''}`
        + (idle
          ? ' — no effect until Vacant Land Only or Improved Only is selected'
          : ` (tunes ${vi === 'vacant' ? 'Vacant Land Only' : 'Improved Only'})`),
      !idle);
  }

  // Max Sale/Asmt is gated by Vacant Land Only in the filter pass.
  const cap = num(s.saleAsmtMax);
  if (cap != null && cap > 0) {
    const idle = vi !== 'vacant';
    push('saleAsmtMax', `Sale/Asmt ≤ ${cap}`,
      `Max Sale/Asmt ratio ${cap}`
        + (idle ? ' — applied only while Vacant Land Only is selected' : ''),
      !idle);
  }

  // Far-Flung marking is on by default and removes nothing; the read-out
  // beside All Sales already reports it. The persisted Exclude toggle is
  // the state that drops sales, so that is the one this names.
  const km = num(s.farFlungKm);
  if (s.farFlungExclude && km != null && km > 0) {
    push('farFlung', `Far-Flung > ${km} km excluded`,
      `Multi-parcel sales whose parcels lie more than ${km} km apart are removed`);
  }

  // Max km only bites once a subject has been Set. Typed without one it
  // is still something the user set and then lost behind the disclosure.
  const dist = num(s.distanceMax);
  if (dist != null && dist > 0) {
    const roll = text(s.subjectRoll);
    if (s.hasSubject) {
      push('distance', `Within ${dist} km of ${roll || 'subject'}`,
        `Only sales within ${dist} km of the subject${roll ? ` (roll ${roll})` : ''}`);
    } else {
      push('distance', `Max ${dist} km (no subject)`,
        `Max km is ${dist} but no subject is set — press Set on a subject roll # for it to apply`,
        false);
    }
  }

  return chips;
}

/** "Plan 66600 · Street MAIN" — the chips' labels, for the badge and the count line. */
export function salesFilterChipText(chips) {
  return (chips || []).map((c) => c.label).join(' · ');
}
