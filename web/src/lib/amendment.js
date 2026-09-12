// By-law + amendment text for the zoning and development-plan overlays.
//
// The province's layers carry the change on the polygon itself: a zoning
// polygon has its parent by-law (ZBL), the by-law that amended it into its
// current zone (ZBL_A) and, usually, a from→to description
// (AMENDMENT_DESCRIPTION, e.g. "AG to CH"). A dev-plan polygon has the
// parent plan by-law (DP_BYLAW) and the amending by-law (DPA_BYLAW). No
// date is published, so a polygon can be reported as rezoned and by which
// by-law, but not when.
//
// A polygon counts as amended when the amending by-law differs from the
// parent, or (zoning only) when a description is present — the same rule
// the results table's "Changes" column and the "Zoning changed" search
// filter use (main.js isZoningChanged / isDevPlanChanged), so the map and
// the table can never disagree about which polygons changed.
//
// Pure text; callers escape for HTML. `bylaw` is the parent by-law line
// (null when the source has none) and `amendment` is the change line
// (null when the polygon is not amended); `base` is the bare parent
// by-law number for callers that label it themselves.

import { realStr } from './cellFormat.js';

/** @returns {{ base: string|null, bylaw: string|null, amendment: string|null }} */
export function zoningBylawText(p = {}) {
  const base   = realStr(p.ZBL);
  const amendA = realStr(p.ZBL_A);
  const desc   = realStr(p.AMENDMENT_DESCRIPTION);
  const amendedBy = amendA && amendA !== base ? amendA : null;
  return {
    base,
    bylaw: base ? `By-law ${base}` : null,
    amendment: amendmentText(amendedBy, desc),
  };
}

/** @returns {{ base: string|null, bylaw: string|null, amendment: string|null }} */
export function devPlanBylawText(p = {}) {
  const base   = realStr(p.DP_BYLAW);
  const amendA = realStr(p.DPA_BYLAW);
  const amendedBy = amendA && amendA !== base ? amendA : null;
  return {
    base,
    bylaw: base ? `By-law ${base}` : null,
    amendment: amendmentText(amendedBy, null),
  };
}

function amendmentText(amendedBy, desc) {
  if (!amendedBy && !desc) return null;
  const head = amendedBy ? `Amended by ${amendedBy}` : 'Amended';
  return desc ? `${head} (${desc})` : head;
}
