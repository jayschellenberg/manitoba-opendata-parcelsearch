/*
 * Parser for the sales-export format the Sales Analysis tab consumes,
 * from either the dropzone (a real CSV file) or the "Paste data…" modal
 * (a block copied straight out of MAO / Excel):
 *
 *   Sale Date, Consideration, Municipality, Roll Number,
 *   Street Address, Legal Description, Primary Property
 *
 * Returns one record PER PARCEL. A multi-parcel sale contributes several
 * records sharing a `groupId`, with the group's date + price copied onto
 * every member and `isPrimary` marking the one that carried them, so
 * downstream code never has to hunt the primary.
 *
 * Three input shapes all have to land on the same records, because all
 * three turn up in practice:
 *
 *   1. One row per parcel. The first row of a sale carries the date and
 *      price; continuation rows leave both blank and inherit them.
 *   2. One row per SALE, with the per-parcel cells QUOTED and stacked:
 *        …,"CITY OF FLIN FLON\nCITY OF FLIN FLON","27800.000\n33100.000",…
 *      (Excel's CSV export of a merged/multi-line cell.)
 *   3. The same stacked shape UNQUOTED — what the clipboard holds when
 *      the source is an HTML table whose cells stack several values.
 *      This is the shape that used to be dropped entirely: nothing
 *      quotes the embedded newlines, so a naive tokenizer fractured each
 *      sale into ragged 1-3 field rows, none of which had a Roll Number
 *      in the roll column, and the roll/muni guard below discarded the
 *      lot. A 9-sale Flin Flon paste plotted 4 sales — exactly the four
 *      that happened to be single-parcel. See salesCsvParse.test.js.
 *
 * Pure (no DOM / no network) so the row reconstruction can be unit
 * tested; main.js owns turning the records into features.
 */

import { tokenizeRows, tokenizeRowsFixedWidth } from './delimitedRows.js';

/**
 * Header aliases per field — both human-readable ("Sale Date") and
 * no-space ("SaleDate") variants, plus a few common short forms.
 * Headers are lowercased before comparison, so matching is
 * case-insensitive across all variants.
 */
const HEADER_ALIASES = {
  saleDate:         ['sale date', 'saledate', 'date'],
  consideration:    ['consideration', 'sale price', 'saleprice', 'price'],
  municipality:     ['municipality', 'muni'],
  rollNumber:       ['roll number', 'rollnumber', 'roll #', 'roll'],
  streetAddress:    ['street address', 'streetaddress', 'address'],
  legalDescription: ['legal description', 'legaldesc', 'legaldescription', 'legal'],
  primaryProperty:  ['primary property', 'primaryprop', 'primaryproperty'],
};

/**
 * Sniff the row delimiter. Tab wins when the first non-empty line
 * carries one (the Excel / assessment-table copy-paste workflow),
 * otherwise comma (a genuine CSV file). Separate from the tokenizer so
 * the paste and file paths share exactly one detection rule.
 */
export function detectSalesDelimiter(text) {
  const firstLine = String(text || '').split(/\r\n|\r|\n/).find((l) => l.trim()) || '';
  return firstLine.includes('\t') ? '\t' : ',';
}

/**
 * Locate each field's column from the header row. Returns null when the
 * two required columns (Roll Number, Municipality) aren't both present —
 * without them no row can be resolved to a parcel.
 */
function mapSalesColumns(headerRow) {
  const header = (headerRow || []).map((c) => String(c || '').trim().toLowerCase());
  const idx = (names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const cols = {};
  for (const [field, names] of Object.entries(HEADER_ALIASES)) cols[field] = idx(names);
  if (cols.rollNumber < 0 || cols.municipality < 0) return null;
  return cols;
}

/**
 * Split one cell into the values it carries, one per parcel.
 *
 * Only newlines separate — deliberately NOT the pipe, which the Roll #
 * search box treats as a JOINER meaning "one property spanning several
 * rolls" (see ROLL_JOINERS in arcgis.js). Trailing blank values are
 * dropped so a cell that merely ends in a newline still reads as one
 * value; interior blanks are kept, because position is what aligns the
 * roll column against the address and legal columns.
 */
export function splitStackedCell(cell) {
  const parts = String(cell ?? '').split(/\r\n|\r|\n/).map((s) => s.trim());
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * The k-th parcel's value from a split cell. A cell holding a single
 * value applies to every parcel in the sale (the Municipality column of
 * a stacked sale is often written once); a stacked cell is positional.
 */
function pickValue(values, k) {
  if (values.length <= 1) return values[0] ?? '';
  return values[k] ?? '';
}

/**
 * Turn tokenized rows into per-parcel records. Shared by both the naive
 * and the reassembled tokenization so parseSalesCsv can score them
 * against each other.
 */
function recordsFromRows(rows, cols) {
  const out = [];
  let groupCounter = 0;
  let currentGroup = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const valuesAt = (col) => (col >= 0 ? splitStackedCell(row[col]) : []);

    // Sale-level cells. Stacked or not, the sale has one date and one
    // price; take the first value and let the group copy handle the rest.
    const saleDate      = valuesAt(cols.saleDate)[0]      || '';
    const consideration = valuesAt(cols.consideration)[0] || '';

    // Per-parcel cells. The roll column decides how many parcels this
    // row describes — it's the one field every parcel must have, and the
    // one that can't wrap (rolls are digits, never free text).
    const rolls     = valuesAt(cols.rollNumber);
    const munis     = valuesAt(cols.municipality);
    const addresses = valuesAt(cols.streetAddress);
    const legals    = valuesAt(cols.legalDescription);
    const primaries = valuesAt(cols.primaryProperty);

    const parcels = [];
    for (let k = 0; k < rolls.length; k++) {
      const rollNumber  = rolls[k] || '';
      const municipality = pickValue(munis, k);
      // Same guard as before the multi-parcel work: a record with no
      // roll or no municipality can't be resolved, so it never enters
      // the record list.
      if (!rollNumber || !municipality) continue;
      parcels.push({
        municipality,
        rollNumber,
        streetAddress:    pickValue(addresses, k),
        legalDescription: pickValue(legals, k),
        primaryProperty:  pickValue(primaries, k),
      });
    }
    if (parcels.length === 0) continue;

    // Multi-parcel sales: a row carrying a Sale Date or Consideration
    // starts a new sale group; a row with BOTH blank is a continuation
    // parcel of the sale above it (shape 1). A stacked row (shapes 2
    // and 3) is a whole group on its own.
    const hasSaleData = saleDate !== '' || consideration !== '';
    if (hasSaleData || currentGroup == null) {
      groupCounter++;
      currentGroup = { id: groupCounter, saleDate, consideration };
    }
    parcels.forEach((p, k) => {
      out.push({
        saleDate:      currentGroup.saleDate,
        consideration: currentGroup.consideration,
        ...p,
        groupId:   currentGroup.id,
        isPrimary: hasSaleData && k === 0,
      });
    });
  }
  return out;
}

/**
 * Parse a sales CSV / paste into per-parcel records.
 *
 * Returns an array of `{saleDate, consideration, municipality,
 * rollNumber, streetAddress, legalDescription, primaryProperty,
 * groupId, isPrimary}`. Rows missing Roll Number or Municipality are
 * silently dropped, as is the whole input when either column is absent.
 */
export function parseSalesCsv(text) {
  const delimiter = detectSalesDelimiter(text);
  const naiveRows = tokenizeRows(text, delimiter);
  if (naiveRows.length < 2) return [];
  const cols = mapSalesColumns(naiveRows[0]);
  if (!cols) return [];

  let records = recordsFromRows(naiveRows, cols);

  // Ragged output — some row narrower than the header — has two possible
  // causes, and they want opposite fixes:
  //
  //   a) unquoted multi-line cells, where the reassembly below is the
  //      whole point (it recovers sales the naive parse threw away);
  //   b) a real CSV that simply omits trailing empty columns, where the
  //      reassembly is actively wrong — it would splice consecutive
  //      records into one.
  //
  // Rather than guess from the text, parse it both ways and keep the one
  // that recovers MORE parcels. Case (a) gains rows (every stacked sale
  // reappears); case (b) can only lose them (rows merge), so the naive
  // parse wins and short CSV rows keep behaving exactly as they did.
  const width = naiveRows[0].length;
  if (width >= 2 && naiveRows.some((r) => r.length < width)) {
    const wideRows = tokenizeRowsFixedWidth(text, delimiter, width);
    if (wideRows.length >= 2) {
      const reassembled = recordsFromRows(wideRows, cols);
      if (reassembled.length > records.length) records = reassembled;
    }
  }

  return records;
}
