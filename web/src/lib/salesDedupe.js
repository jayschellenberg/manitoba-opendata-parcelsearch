/*
 * Sales-CSV row reconciliation — pure logic behind the sales upload's
 * "N of M sales plotted" line.
 *
 * A MAO sales export has three kinds of many-rows-to-one-parcel:
 *
 *   1. Multi-parcel sales — one sale, several DIFFERENT rolls. Already
 *      handled upstream by parseSalesCsv's `groupId`; nothing to do here.
 *   2. Exact re-listings — the same (muni, roll, date, price) appearing
 *      more than once because the export repeats a portfolio sale block
 *      once per member. These are ONE sale and must collapse.
 *   3. Repeat sales — the same (muni, roll) sold on different dates
 *      and/or for different prices. These are SEPARATE comps and must
 *      each survive as their own row.
 *
 * Before this module the upload keyed sales into a plain
 * `Map<roll, record>`, so 2 and 3 both collapsed and the last row won —
 * silently discarding every earlier sale of a repeat-sold parcel.
 *
 * Municipality is part of the identity: roll "300.000" exists in most
 * RMs, so a bare roll key would merge unrelated parcels. The caller
 * already groups by normalized muni, but the key includes it anyway so
 * the function is correct on any list handed to it.
 *
 * Pure (no DOM / no network) so the reconciliation math can be
 * unit-tested; main.js owns turning the result into features.
 *
 * KEPT IN STEP WITH THE MATCHER. mao-scrape's n1_mao_for_matching()
 * (scripts/n1_lib.R) collapses the same archive for the N1 crosswalk, and
 * as of 2026-08-19 both apply the same rule: consideration is part of the
 * sale's identity, the Sale Type Group is not. That direction was settled
 * from the archive — 847 identities hold two considerations under one type
 * label and all of them arrived in a single scrape, so MAO listed two
 * sales; while the 95 identities holding one consideration under two
 * labels are one transaction filed in two type slices. The R side used to
 * key on the label instead and threw 897 rows away; this module always had
 * it right.
 *
 * Two differences remain, both deliberate:
 *   - The matcher groups on the archive's VERBATIM roll cell and explodes
 *     afterwards, so a stacked multi-parcel row and its per-roll twins stay
 *     separate (it needs to stamp the N1 ID on every representation).
 *     parseSalesCsv has already exploded stacked cells before this runs, so
 *     here they collapse — one comp, not two, which is what a table wants.
 *   - The matcher drops rows superseded by a later scrape of the same sale.
 *     The export ships no scraped_at column, so this module cannot tell an
 *     amendment from its stale predecessor and keeps whichever it met
 *     first. Affects ~15 sales province-wide, all of them revisions to a
 *     legal description or primary-property descriptor rather than a price.
 */

/**
 * Length-prefixed join, so composing keys out of free-text CSV cells
 * can't produce a collision. A plain `a|b` join makes
 * ("x", "y|z") and ("x|y", "z") the same string; here they can't be.
 * These cells are user-supplied and a false collision silently merges
 * two different sales, which is exactly the class of bug this module
 * exists to fix.
 */
function joinKey(...parts) {
  return parts.map((p) => `${p.length}:${p}`).join('');
}

/**
 * Identity of a single sale event, independent of which parcel it
 * touched: the date and the consideration exactly as the CSV wrote
 * them. Blank-on-blank (a continuation row whose group carried no
 * date or price) is a legitimate signature — such rows still collapse
 * against each other, which is what the repeated-block case needs.
 */
export function saleSignature(rec) {
  const date = String(rec?.saleDate ?? '').trim().toUpperCase();
  const price = String(rec?.consideration ?? '').trim().toUpperCase();
  return joinKey(date, price);
}

/**
 * MAO's "not classified yet" Sale Type Group. Deliberately not part of any
 * key — it only breaks ties between copies of one sale (see
 * dedupeSalesByRoll). Blank is NOT uncategorized: a shard that predates the
 * column has no label at all, and treating that as the loser would hand the
 * decision to whichever copy happened to be parsed by a newer export.
 */
function isUncategorized(rec) {
  return String(rec?.saleTypeGroup ?? '').trim().toUpperCase() === 'UNCATEGORIZED';
}

/**
 * Full parcel identity — municipality AND roll. Municipality is
 * normalized case/whitespace-insensitively; the roll goes through the
 * caller-supplied canonicalRoll so "3600", "3600.0" and "3600.000" are
 * one parcel.
 */
export function parcelKey(rec, canonicalRoll) {
  const muni = String(rec?.municipality ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  return joinKey(muni, canonicalRoll(rec?.rollNumber));
}

/**
 * Collapse exact re-listings and order each parcel's genuine sales
 * newest-first.
 *
 * `records` are parseSalesCsv output rows for ONE municipality (the
 * caller's byMuni bucket). Injected helpers keep this pure:
 *   canonicalRoll(raw)  → string   (arcgis.js)
 *   saleDateValue(raw)  → Date|null (main.js: parseSaleDate)
 *
 * Returns:
 *   salesByRoll   Map<canonicalRoll, record[]>  — distinct sales,
 *                 newest-first, for each roll present in `records`.
 *   duplicateRows record[] — the rows dropped as exact re-listings,
 *                 in the order encountered, each carrying `_dupeOf`
 *                 (the row it collapsed into) for reporting.
 *   saleCount     total distinct sales across every roll.
 *
 * Rolls that canonicalize to '' (blank / junk) are skipped entirely —
 * the caller has already bucketed those as unmatched.
 */
export function dedupeSalesByRoll(records, { canonicalRoll, saleDateValue }) {
  const salesByRoll = new Map();
  const seen = new Map();          // `${parcelKey}|${saleSignature}` → slot
  const duplicateRows = [];

  for (const rec of records || []) {
    const roll = canonicalRoll(rec?.rollNumber);
    if (!roll) continue;
    const sig = joinKey(parcelKey(rec, canonicalRoll), saleSignature(rec));
    const slot = seen.get(sig);
    if (slot) {
      // Which copy survives only matters when they disagree, and the one
      // way they do is the Sale Type Group: the scrape unions MAO's typed
      // passes with an undated "ANY" pass, and the overlap leaks a second
      // copy labelled UNCATEGORIZED. Every such row in the archive (39 of
      // them) duplicates a typed row, so the typed label is the true one
      // and must win however the CSV happened to order them. Same
      // preference as n1_mao_for_matching()'s first filter.
      if (isUncategorized(slot.rec) && !isUncategorized(rec)) {
        const displaced = slot.rec;
        if (displaced.n1Id && !rec.n1Id) rec.n1Id = displaced.n1Id;
        salesByRoll.get(slot.roll)[slot.idx] = rec;
        slot.rec = rec;
        duplicateRows.push({ ...displaced, _dupeOf: rec });
        continue;
      }
      // The N1 crosswalk stamps its ID on specific archive rows; when an
      // exact re-listing collapses, the surviving record must not lose the
      // ID just because the un-stamped copy happened to come first.
      if (rec?.n1Id && !slot.rec.n1Id) slot.rec.n1Id = rec.n1Id;
      duplicateRows.push({ ...rec, _dupeOf: slot.rec });
      continue;
    }
    if (!salesByRoll.has(roll)) salesByRoll.set(roll, []);
    const list = salesByRoll.get(roll);
    seen.set(sig, { rec, roll, idx: list.length });
    list.push(rec);
  }

  // Newest sale first, so the parcel's most recent transaction is the
  // one the map popup and the primary table row show. Undated sales
  // sort last (they're continuation rows of a group with no date, or a
  // malformed cell — either way they shouldn't outrank a real date).
  // Ties keep CSV order, which `sort` guarantees (stable since ES2019).
  let saleCount = 0;
  for (const list of salesByRoll.values()) {
    list.sort((a, b) => {
      const da = saleDateValue(a?.saleDate);
      const db = saleDateValue(b?.saleDate);
      if (da && db) return db - da;
      if (da) return -1;
      if (db) return 1;
      return 0;
    });
    saleCount += list.length;
  }

  return { salesByRoll, duplicateRows, saleCount };
}

/**
 * Expand a municipality's queried parcels into ONE FEATURE PER SALE.
 *
 * A parcel with N distinct sales yields N features: the queried one plus
 * N-1 clones that share its geometry by reference (same polygon, never
 * mutated downstream — copying ~500 parcel rings per repeat sale would
 * be pure waste). Each carries `_saleSeq`, its parcel-local index with 0
 * = most recent, and `_saleCount`.
 *
 * `stamp(featureProperties, saleRecord, saleSeq, sales)` is where the
 * caller writes its app-specific sale properties — `sales` is the
 * parcel's full newest-first list, so a stamp can summarise the whole
 * history. This function owns only the cloning and the sequencing.
 *
 * Returns:
 *   features        the expanded list, parcels in query order and each
 *                   parcel's sales newest-first
 *   matchedRolls    Set of Roll_No_Txt values that found a sale
 *   matchedSales    total features emitted — i.e. sales plotted
 *
 * Parcels the CSV didn't ask about are dropped rather than passed
 * through: this is a sales result set, and a row with no sale has no
 * meaning in it. (The roll-list query can't return one in practice —
 * it selects on exactly these rolls.)
 */
export function expandFeaturesBySale(features, salesByRoll, stamp) {
  const out = [];
  const matchedRolls = new Set();
  for (const f of features || []) {
    const roll = f?.properties?.Roll_No_Txt;
    const sales = roll ? salesByRoll.get(roll) : null;
    if (!sales || sales.length === 0) continue;
    matchedRolls.add(roll);
    sales.forEach((sale, saleSeq) => {
      const feat = saleSeq === 0 ? f : { ...f, properties: { ...f.properties } };
      feat.properties._saleSeq = saleSeq;
      feat.properties._saleCount = sales.length;
      stamp(feat.properties, sale, saleSeq, sales);
      out.push(feat);
    });
  }
  return { features: out, matchedRolls, matchedSales: out.length };
}

/**
 * One feature per parcel, in first-seen order. `expandFeaturesBySale`
 * emits one feature per SALE, so a parcel that sold twice appears twice
 * in the result set — right for the table (two comps, two rows) but
 * wrong for anything geometric: stacked polygons compound the parcel
 * fill's 0.40 opacity into a visibly darker patch, the numbered callout
 * draws two badges on the same centroid, and the snapshot export renders
 * the same parcel twice.
 *
 * Returns the SAME feature objects (never copies) so the enrichment
 * passes that mutate `properties` afterwards are still seen through it.
 * Features with no OBJECTID pass through untouched — they can't be
 * identified as duplicates, and dropping them would lose data.
 */
export function uniqueParcelFeatures(features) {
  const out = [];
  const seen = new Set();
  for (const f of features || []) {
    const oid = f?.properties?.OBJECTID;
    if (oid == null) { out.push(f); continue; }
    if (seen.has(oid)) continue;
    seen.add(oid);
    out.push(f);
  }
  return out;
}

/**
 * `uniqueParcelFeatures` lifted to a FeatureCollection. Returns the
 * original collection by reference when nothing is duplicated — the
 * case for every non-sales search, so this stays free on the hot path.
 */
export function dedupeParcelFeaturesForMap(fc) {
  const features = fc?.features || [];
  const unique = uniqueParcelFeatures(features);
  return unique.length === features.length ? fc : { ...fc, features: unique };
}

/**
 * The sales whose roll never came back from Roll_Entry, counted in
 * distinct SALES rather than raw CSV rows so matched + unmatched adds
 * back up to the deduped sale total.
 */
export function unmatchedSales(salesByRoll, matchedRolls, reason) {
  const out = [];
  for (const [roll, sales] of salesByRoll) {
    if (matchedRolls.has(roll)) continue;
    for (const rec of sales) out.push({ ...rec, reason });
  }
  return out;
}
