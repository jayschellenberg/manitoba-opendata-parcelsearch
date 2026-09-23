/*
 * Filter waterfall for the Sales Analysis — how many SALES each filter took
 * out, in the order the filters run, from the loaded set down to what the
 * charts plot. The land template draws the same thing for its CMS
 * (land_apply_cms_filters records each step), and it answers the question a
 * thin comp set always raises: which control removed the sales I expected?
 *
 * The filter pass itself is row-level (one row per parcel per sale) and stops
 * at the FIRST failing test, so each row carries the index of the step that
 * dropped it. Counting in sales rather than rows needs one more rule: a sale
 * is gone after step k once none of its rows survive past k, so a sale's
 * removal step is the LATEST step at which any of its rows fell. For the
 * group-level filters (price, size, date...) every member falls at the same
 * step and this is exact; for the row-level ones (a drawn shape clipping one
 * parcel of an assembly) it credits the sale to the step that removed its
 * last surviving parcel, which is when it actually left the set.
 *
 * Pure: no DOM, no app imports.
 */

/**
 * @param rows        the rows the filter pass saw
 * @param stepOf      row index → index into `labels` of the step that dropped
 *                    it, or -1 / null when the row passed every step
 * @param labels      step names, in evaluation order
 * @param groupIdOf   row → sale id; rows without one count as their own sale
 * @returns {{loaded, steps:[{label, removed, remaining}], remaining}}
 *          Only steps that removed something are listed.
 */
export function buildSalesWaterfall(rows, stepOf, labels, groupIdOf) {
  const list = rows || [];
  const PASS = Infinity;
  // sale id → the latest step any of its rows fell at (PASS when a row
  // survived everything, which keeps the whole sale).
  const fellAt = new Map();
  list.forEach((row, i) => {
    const gid = groupIdOf ? groupIdOf(row) : null;
    const id = gid == null ? `row:${i}` : `sale:${gid}`;
    const raw = stepOf(i);
    const step = raw == null || raw < 0 ? PASS : raw;
    const prev = fellAt.get(id);
    fellAt.set(id, prev === undefined ? step : Math.max(prev, step));
  });

  const removedAt = new Array(labels.length).fill(0);
  let remaining = 0;
  for (const step of fellAt.values()) {
    if (step === PASS) remaining += 1;
    else if (step >= 0 && step < labels.length) removedAt[step] += 1;
  }

  const loaded = fellAt.size;
  const steps = [];
  let left = loaded;
  labels.forEach((label, i) => {
    if (!removedAt[i]) return;
    left -= removedAt[i];
    steps.push({ label, removed: removedAt[i], remaining: left });
  });
  return { loaded, steps, remaining };
}
