// Assessment history block for the Manitoba preliminary report: a land /
// buildings chart by tax year and a table of the years the value changed.
// Renders nothing when the assessment-history family is not published or
// has no row for the roll, so the report never shows an empty chart.

import { fetchAssessmentHistoryForMuni } from '../arcgis.js';
import { expandHistory, changeRows, historySvg, historySummary } from '../lib/assessmentHistory.js';
import { fmtMoney } from '../lib/reportData.js';

export async function renderAssessmentHistory(el, { muniNo, roll, cite }) {
  if (!el) return;
  const shard = await fetchAssessmentHistoryForMuni(muniNo);
  const series = expandHistory(shard?.rolls?.[roll]);
  if (series.length < 2) return;
  const rows = changeRows(series);
  const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
  el.innerHTML = `
    <h3>Assessed value by tax year, ${series[0].year}-${series.at(-1).year}</h3>
    <div class="rp-chart">${historySvg(series)}</div>
    <p class="rp-note">${historySummary(series)}. Values change at reassessments (and when the property changes) and are held in between.</p>
    ${rows.length ? `<table class="rp-table"><thead><tr><th>Tax year</th><th>Land</th><th>Buildings</th><th>Total</th><th>Change</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td>${r.year}</td><td>${fmtMoney(r.land)}</td><td>${fmtMoney(r.buildings)}</td><td>${fmtMoney(r.total)}</td><td>${pct(r.pct)}</td></tr>`).join('')
    }</tbody></table>` : ''}`;
  cite?.('Assessment history', `Manitoba Assessment Online public summaries, tax years ${series[0].year}-${series.at(-1).year}, summable classes summed. Assessed values, not taxes.`);
}
