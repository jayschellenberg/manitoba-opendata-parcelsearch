/*
 * The Agricultural page's consistency filters (2026-10-07) — the land
 * template's CMSAG1 in its "rate" mode: a cultivated-% band and keep-lists
 * for MASC rating, CLI class and dominant land cover, narrowing the set the
 * Agricultural page fits (its trend and its own time-adjustment rate) while
 * the other pages keep the wide set.
 *
 * As in the template (LandStatic.qmd, CONSISTENCY FILTERS): a sale with NO
 * value for an attribute is KEPT — it was never measured, so it has not
 * failed — and an empty keep-list or an empty band end means "no filter".
 *
 * Pure, for test/agConsistency.test.js; the charts page passes its own MASC
 * key function so "unrated" means exactly what its charts mean by it.
 */

/** Normalise the saved option ({cultLo, cultHi, masc, cli, cover}). */
export function agConsSpec(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  return { cultLo: num(a.cultLo), cultHi: num(a.cultHi), masc: list(a.masc), cli: list(a.cli), cover: list(a.cover) };
}

/** Is any filter set? */
export function agConsActive(spec) {
  return spec.cultLo != null || spec.cultHi != null
    || spec.masc.length > 0 || spec.cli.length > 0 || spec.cover.length > 0;
}

/**
 * Does a sale pass? `mascOf(rec)` returns its MASC key, or `unrated` when it
 * has none.
 */
export function agConsistent(rec, spec, { mascOf, unrated = 'Unrated' } = {}) {
  const cult = Number(rec?.ag?.cover?.cult);
  if (Number.isFinite(cult)) {
    const pct = cult * 100;
    if (spec.cultLo != null && pct < spec.cultLo) return false;
    if (spec.cultHi != null && pct > spec.cultHi) return false;
  }
  if (spec.masc.length) {
    const masc = mascOf ? mascOf(rec) : rec?.ag?.masc;
    if (masc && masc !== unrated && !spec.masc.includes(String(masc))) return false;
  }
  const cli = rec?.ag?.cliClass;
  if (spec.cli.length && cli && !spec.cli.includes(String(cli))) return false;
  const cover = rec?.ag?.coverLabel;
  if (spec.cover.length && cover && !spec.cover.includes(cover)) return false;
  return true;
}

/** "Cultivated 50–100%; MASC A, B; CLI 1, 2; Cover Cropland" ('' when off). */
export function agConsWords(spec) {
  const parts = [];
  if (spec.cultLo != null || spec.cultHi != null) parts.push(`Cultivated ${spec.cultLo ?? 0}–${spec.cultHi ?? 100}%`);
  if (spec.masc.length) parts.push(`MASC ${spec.masc.join(', ')}`);
  if (spec.cli.length) parts.push(`CLI ${spec.cli.join(', ')}`);
  if (spec.cover.length) parts.push(`Cover ${spec.cover.join(', ')}`);
  return parts.join('; ');
}
