/*
 * The Sales Charts work file (charts Phase 1, Jason 2026-10-06): one zip
 * holding the charts and maps he ticks as PNGs, the comparable set as CSV,
 * and a self-contained summary.html for the appraisal work file — the
 * website's lighter path to what the R land template's exports give.
 *
 * Everything here is pure (strings in, strings out) so it runs under node
 * in test/workFile.test.js. The page (charts/main.js) gathers the data and
 * renders the images; this module only formats.
 *
 * Every value that reaches the HTML goes through escapeHtml: addresses,
 * zone codes and municipality names all originate in a pasted CSV.
 */

/** HTML-escape a value for text or a double-quoted attribute. */
export function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * One CSV cell, RFC 4180 quoted. Numbers go out raw so Excel reads them as
 * numbers. A TEXT cell that opens with = + - @ (or a tab / CR) is prefixed
 * with an apostrophe: the text came from a pasted export, and Excel would
 * otherwise evaluate it as a formula.
 */
export function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * A CSV document: a header row of labels, then the rows. CRLF line ends
 * and a UTF-8 byte-order mark, so Excel opens it with accents intact
 * (Île-des-Chênes) instead of guessing a code page.
 */
export function toCsv(labels, rows) {
  const lines = [labels.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** A file-name-safe stem: lower case, dashes, no leading/trailing dash. */
export function fileStem(str, fallback = 'file') {
  return String(str ?? '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

/**
 * Zip entry names for the selected figures, numbered in page order so the
 * folder sorts the way the page reads: "charts/03-map-cms-heatmap.png".
 */
export function figureFileName(index, tabLabel, title, ext) {
  const n = String(index + 1).padStart(2, '0');
  return `${n}-${fileStem(tabLabel, 'tab')}-${fileStem(title, 'chart')}.${ext}`;
}

/** The zip's own name: the subject roll when there is one, then the date. */
export function workFileName(subjectRoll, dateText) {
  const who = subjectRoll ? fileStem(subjectRoll, 'sales') : 'sales';
  return `work-file-${who}-${dateText}.zip`;
}

const STYLE = `
  :root { color-scheme: light; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; background: #ffffff;
         margin: 0 auto; max-width: 1000px; padding: 24px 16px 48px; line-height: 1.4; }
  h1 { color: #8B0000; font-size: 24px; margin: 0 0 4px; }
  h2 { color: #8B0000; font-size: 18px; margin: 32px 0 8px; border-bottom: 1px solid #d3d3d3; padding-bottom: 4px; }
  h3 { color: #8B0000; font-size: 15px; margin: 0 0 2px; }
  .meta { color: #52514e; font-size: 13px; margin: 0; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 8px 0; }
  th, td { border-bottom: 1px solid #e1e0d9; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f4f3ef; font-weight: 700; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; font-size: 13px; margin: 8px 0; }
  dl.facts dt { color: #52514e; }
  dl.facts dd { margin: 0; }
  .wrap { overflow-x: auto; }
  figure { margin: 20px 0; break-inside: avoid; page-break-inside: avoid; }
  figure img { width: 100%; height: auto; border: 1px solid #e1e0d9; display: block; }
  figcaption.sub { color: #333333; font-size: 12px; margin: 0 0 6px; }
  .note { color: #898781; font-size: 12px; }
  .tab-head { color: #52514e; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; margin: 28px 0 0; }
  @media print { body { max-width: none; padding: 0; } h2 { break-after: avoid; } }
`;

function tableHtml({ columns = [], rows = [] }, empty = 'None.') {
  if (!rows.length) return `<p class="note">${escapeHtml(empty)}</p>`;
  const head = columns.map((c) => `<th${c.num ? ' class="num"' : ''}>${escapeHtml(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((v, i) => `<td${columns[i]?.num ? ' class="num"' : ''}>${escapeHtml(v)}</td>`).join('')}</tr>`).join('\n');
  return `<div class="wrap"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

function factsHtml(pairs) {
  const items = (pairs || []).filter(([, v]) => v != null && v !== '');
  if (!items.length) return '';
  return `<dl class="facts">${items.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;
}

/**
 * The summary page. `model`:
 *   title, company, generated (text), build (text)
 *   subject   [[label, value], …]      — omitted rows are skipped
 *   settings  [[label, value], …]
 *   rates     {columns, rows}          — CMS1 / CMS2 figures
 *   waterfall {columns, rows}
 *   tagged    [{title, columns, rows}] — the numbered comps and Land Sets
 *   comps     {columns, rows}          — the ticked sales (the CMS)
 *   excluded  {columns, rows}          — the unticked ones
 *   figures   [{tabLabel, title, kind: 'image', src} |
 *              {tabLabel, title, kind: 'table', subtitle, note, columns, rows}]
 *
 * Images arrive as data: URLs, so the one file opens anywhere, offline,
 * with nothing beside it.
 */
export function buildSummaryHtml(model) {
  const m = model || {};
  const parts = [];
  parts.push('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push(`<title>${escapeHtml(m.title || 'Sales work file')}</title>`);
  parts.push(`<style>${STYLE}</style>\n</head>\n<body>`);
  parts.push(`<h1>${escapeHtml(m.title || 'Sales work file')}</h1>`);
  const byline = [m.company, m.generated && `Generated ${m.generated}`, m.build && `Manitoba Parcel Search ${m.build}`]
    .filter(Boolean).map(escapeHtml).join(' · ');
  if (byline) parts.push(`<p class="meta">${byline}</p>`);

  const subj = factsHtml(m.subject);
  parts.push('<h2>Subject</h2>');
  parts.push(subj || '<p class="note">No subject roll was set in the main window.</p>');

  const settings = factsHtml(m.settings);
  if (settings) parts.push('<h2>Analysis settings</h2>', settings);

  if (m.rates) parts.push('<h2>Market conditions</h2>', tableHtml(m.rates, 'Too few dated sales to measure a trend.'));
  if (m.waterfall) parts.push('<h2>Filter waterfall</h2>', tableHtml(m.waterfall));
  // The tagged lists (charts Phase 2) lead: the numbered comparables, then
  // the Land Sets. The CMS — every ticked sale — follows as the market.
  for (const t of m.tagged || []) {
    parts.push(`<h2>${escapeHtml(t.title)} (${t.rows.length})</h2>`, tableHtml(t));
  }
  if (m.comps) {
    const title = (m.tagged || []).length ? 'CMS — ticked sales' : 'Comparable sales';
    parts.push(`<h2>${title} (${m.comps.rows.length})</h2>`, tableHtml(m.comps, 'No sales are ticked.'));
  }
  if (m.excluded && m.excluded.rows.length) {
    parts.push(`<h2>Excluded sales (${m.excluded.rows.length})</h2>`, tableHtml(m.excluded));
  }

  const figures = m.figures || [];
  if (figures.length) {
    parts.push('<h2>Charts and maps</h2>');
    let lastTab = null;
    for (const f of figures) {
      if (f.tabLabel !== lastTab) {
        parts.push(`<p class="tab-head">${escapeHtml(f.tabLabel)}</p>`);
        lastTab = f.tabLabel;
      }
      if (f.kind === 'image') {
        // The PNG carries its own title, subtitle and caption; alt repeats
        // the title for a reader that cannot see it.
        parts.push(`<figure><img src="${escapeHtml(f.src)}" alt="${escapeHtml(f.title)}"></figure>`);
      } else if (f.kind === 'table') {
        parts.push('<figure>', `<h3>${escapeHtml(f.title)}</h3>`);
        if (f.subtitle) parts.push(`<figcaption class="sub">${escapeHtml(f.subtitle)}</figcaption>`);
        parts.push(tableHtml(f));
        if (f.note) parts.push(`<p class="note">${escapeHtml(f.note)}</p>`);
        parts.push('</figure>');
      }
    }
  }
  parts.push('</body>\n</html>\n');
  return parts.join('\n');
}
