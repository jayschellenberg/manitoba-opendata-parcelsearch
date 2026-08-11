/*
 * Delimited-text row tokenizers, shared by every paste/upload path.
 *
 * Two tokenizers, because pasted table data comes in two shapes:
 *
 *   tokenizeRows           — the ordinary quote-aware CSV/TSV parse. A
 *                            newline always ends the row unless it sits
 *                            inside a quoted cell.
 *   tokenizeRowsFixedWidth — the same, but told how many columns a row
 *                            has, so an UNQUOTED newline inside a cell
 *                            (what a browser table copy produces when a
 *                            cell stacks several values) stays part of
 *                            that cell instead of fracturing the row.
 *
 * Both were previously duplicated in lib/parcelListParser.js and
 * main.js (as parseCsvRows); the sales-import path only ever had the
 * naive one, which is why a stacked multi-parcel sale silently vanished
 * from a Sales Analysis paste. Keeping one copy means a fix to the
 * quote handling can't drift between the importers.
 */

/**
 * How many DATA rows does this CSV text hold (header excluded)?
 *
 * Quote-aware, and that is the entire point. The obvious version —
 * `text.split('\n').filter((l) => l.trim()).length - 1` — counts every
 * physical line, but the MAO sales export deliberately stacks a
 * multi-parcel sale's per-parcel values inside QUOTED cells separated by
 * newlines (see salesCsvParse shape 2). Each stacked parcel therefore
 * read as another sale: the 48-shard export reported 292,039 sales
 * against its true 228,957 — 63,082 phantom rows, and the error grew
 * with the share of multi-parcel sales rather than staying a fixed
 * offset. Counted here without materializing fields, so it stays cheap
 * on a 46 MB import.
 *
 * Blank lines are not rows. A file with only a header returns 0.
 */
export function countDataRows(text) {
  const src = String(text || '');
  let rows = 0;
  let inQuotes = false;
  let seen = false;      // has the current logical row any non-whitespace?
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      // "" is an escaped quote INSIDE the field, not the end of it.
      if (c === '"') {
        if (src[i + 1] === '"') i++;
        else inQuotes = false;
      }
      seen = true;
      continue;
    }
    if (c === '"') { inQuotes = true; seen = true; continue; }
    if (c === '\n' || c === '\r') {
      if (seen) rows++;
      seen = false;
      if (c === '\r' && src[i + 1] === '\n') i++;
      continue;
    }
    if (!seen && c.trim() !== '') seen = true;
  }
  if (seen) rows++;                 // last row, no trailing newline
  return Math.max(0, rows - 1);     // drop the header
}

/**
 * Walk a CSV's LOGICAL rows (quote-aware) without tokenizing them.
 *
 * `cb(rowText, index)` receives the raw row string, header first at index
 * 0. Returning false stops the walk immediately — and that early exit is
 * the whole point: the MAO shards are written newest-sale-first, so a
 * date-windowed load can stop at the first row older than the window
 * instead of scanning a 1.4 MB shard to its 1987 tail. Blank lines are
 * skipped, so indexes count data rows, not physical lines.
 *
 * Splitting without tokenizing keeps this ~free next to the per-row
 * field parse the caller only pays for rows it actually keeps.
 */
export function forEachCsvRow(text, cb) {
  const src = String(text || '');
  let start = 0, inQuotes = false, index = 0;
  const emit = (end) => {
    const row = src.slice(start, end);
    if (row.trim() === '') return true;      // blank line: not a row
    return cb(row, index++) !== false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') i++;         // "" is an escaped quote
        else inQuotes = false;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === '\n' || c === '\r') {
      if (!emit(i)) return;
      if (c === '\r' && src[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (start < src.length) emit(src.length);   // last row, no trailing newline
}

/**
 * Quote-aware row tokenizer parameterized on delimiter. Handles quoted
 * fields with embedded delimiters, escaped double-quotes (""), and
 * \r\n / \n / \r line endings.
 *
 * `delimiter` is either a literal character ('\t' or ',') or a RegExp
 * (whitespace splitting, used when no delimiter is found). Whitespace
 * mode bypasses the quote handling — pasted single-line input never
 * embeds delimiters in quoted cells.
 *
 * Returns an array of arrays. Completely empty rows are dropped.
 */
export function tokenizeRows(text, delimiter = ',') {
  const src = String(text || '');
  // Whitespace-only delimiter: simple split per line.
  if (delimiter instanceof RegExp) {
    return src
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.split(delimiter).map((c) => c.trim()).filter((c) => c !== ''));
  }
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => {
    // Drop completely empty rows. A row with one empty cell still
    // counts as a row of one cell — callers filter further.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += c; i++; }
    } else if (c === '"') {
      inQuotes = true; i++;
    } else if (c === delimiter) {
      pushField(); i++;
    } else if (c === '\r' || c === '\n') {
      pushField(); pushRow();
      if (c === '\r' && src[i + 1] === '\n') i += 2; else i++;
    } else {
      field += c; i++;
    }
  }
  if (field !== '' || row.length > 0) { pushField(); pushRow(); }
  return rows;
}

/**
 * Column-count-aware tokenizer for the unquoted-multi-line-cell case.
 *
 * Some spreadsheet/table copies stack a multi-parcel sale into a single
 * logical row where the Municipality / Roll / Legal cells each carry
 * several newline-separated values — but the source doesn't quote those
 * cells, so a naive tokenization breaks every embedded newline into its
 * own (ragged) physical row. Knowing the expected column count `N` (from
 * the header), we can reconstruct the logical rows: a newline is treated
 * as *intra-cell* until `N-1` delimiters have been seen, then it
 * terminates the row. Embedded newlines are preserved in the field so
 * the caller's expansion pass can split them back into one row per value.
 *
 * Quote handling matches tokenizeRows, so a properly-quoted CSV export
 * (Excel wraps multi-line cells in quotes) flows through unchanged.
 * Clean rows (already N fields) come out identical to the naive parse.
 *
 * Callers must guard this: on input that is ragged for the OTHER reason
 * — trailing empty columns omitted from a real CSV — it merges rows that
 * should have stayed apart. See parseSalesCsv, which runs both parses
 * and keeps whichever recovers more parcels.
 */
export function tokenizeRowsFixedWidth(text, delimiter, N) {
  const src = String(text || '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => {
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += c; i++; }
    } else if (c === '"') {
      inQuotes = true; i++;
    } else if (c === delimiter) {
      pushField(); i++;
    } else if (c === '\r' || c === '\n') {
      const nl = (c === '\r' && src[i + 1] === '\n') ? 2 : 1;
      if (row.length === 0 && field === '') {
        i += nl;                       // blank line — skip
      } else if (row.length >= N - 1) {
        pushField(); pushRow(); i += nl; // last field done → end row
      } else {
        field += '\n'; i += nl;        // non-last cell spans physical lines
      }
    } else {
      field += c; i++;
    }
  }
  if (field !== '' || row.length > 0) { pushField(); pushRow(); }
  return rows;
}
