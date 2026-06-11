// MAO scrape staleness banner — pure decision logic.
//
// The MAO scrape is a multi-week, deliberately throttled run (paced to
// avoid triggering upstream blocking), refreshed roughly semiannually —
// NOT monthly. A scrape that is one or two months old is normal, not a
// slip, so the banner must stay hidden well past the old 35/60-day
// thresholds that wrongly assumed a monthly cadence.
//
// The thresholds tie to the two conventions already in the project:
//   - the operator dashboard (dashboard/server.js) declares the MAO
//     legal+assessment refresh "Semiannual" (cadenceDays: 180);
//   - archive_snapshot.R and build_historical_shards.R both treat
//     "> 12 months" as the STALE line.
//
//   <= 180 days   → fresh, banner hidden (within the semiannual cadence)
//   181-365 days  → amber nudge (past the semiannual mark — plan a scrape)
//   > 365 days    → red (12-month rule; refresh before relying on it)

export const STALE_FRESH_MAX_DAYS = 180;  // hide at/below this
export const STALE_RED_MIN_DAYS   = 365;  // red above this

/**
 * Decide the staleness banner state for the oldest MAO-derived dataset.
 *
 * @param {number|null} oldestDays  age in days of the oldest of the
 *   legal/assessment source timestamps; null/non-finite → hidden.
 * @returns {{ show: boolean, tone: string|null, lead: string, tail: string }}
 *   `tone` is the CSS class to apply; `lead`/`tail` are the two text
 *   spans (lead is bolded by the caller). Empty strings when hidden.
 */
export function stalenessBannerState(oldestDays) {
  if (oldestDays == null || !Number.isFinite(oldestDays) || oldestDays <= STALE_FRESH_MAX_DAYS) {
    return { show: false, tone: null, lead: '', tail: '' };
  }
  const isRed = oldestDays > STALE_RED_MIN_DAYS;
  return {
    show: true,
    tone: isRed ? 'data-staleness-red' : 'data-staleness-amber',
    lead: `MAO scrape is ${oldestDays} days old.`,
    tail: isRed
      ? ' Past the 12-month freshness rule — re-run the scrape to refresh legal descriptions and assessment values before relying on this data.'
      : ' Past the usual semiannual refresh — plan the next MAO scrape when convenient.',
  };
}
