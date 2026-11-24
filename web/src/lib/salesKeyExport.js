// "Key fields" sales export — a short CSV of the ~35 columns an appraiser
// reaches for first, picked BY NAME out of the full export.
//
// Why by name and not a second hand-written header/cell list: exportCsv's two
// parallel arrays are already the riskiest code in the export (see
// test/csvColumns.test.js). A third list would be one more place for a cell to
// drift under the wrong heading. Picking indexes out of the full header means
// the key file can only ever contain cells the full file carries under the
// same name.
//
// The list is Jason's (2026-11-18), one list for farm and urban sales alike.
// Condo Plan / Condo Unit joined it 2026-11-24: without them a Condo units
// search exported at the default scope lost which unit each sale was.
// Farm and urban lots will want different lists later; that is a second array
// here plus a third option in the export choice, not a change to the picker.

/** Matches the full export's assessment header, whose year is dynamic. */
const ASSESSMENT_RE = /^(Assess-\d{4}|Assessment) \(\$\)$/;

export const KEY_SALES_COLUMNS = [
  'Map #', 'Roll #', 'Municipality', 'Address', 'Legal Description',
  'Condo Plan', 'Condo Unit',
  'Sale Date', 'Sale Price', 'Sale Type Group', 'Primary Property',
  'Parcels in Sale', 'Group Rolls', 'Group Total Sale Price', 'Group Total Acres',
  'Group $/Acre', 'Group $/SF', 'Group $/FF', 'Sale/Asmt',
  'Zoning 1 Code', 'Zoning 1 Category',
  'DU', 'Roll Frontage/Area', 'Acres', 'SF',
  ASSESSMENT_RE, 'Asmt Class', 'Asmt Report URL',
  'CLI', 'Cult %', 'Water', 'Flood Zone', 'Dist (km)', 'Lat', 'Lon',
];

/**
 * Indexes into `header` for the key columns, in KEY_SALES_COLUMNS order.
 * A name the header lacks is skipped (Map # is absent when numbering is off),
 * so the result is always a valid subset; `missing` lists the skipped names
 * other than Map # so a renamed full-export column shows up in the console
 * and in the test, rather than as a column quietly dropping out of the file.
 */
export function keyColumnIndexes(header, wanted = KEY_SALES_COLUMNS) {
  const idx = [];
  const missing = [];
  for (const w of wanted) {
    const i = typeof w === 'string' ? header.indexOf(w) : header.findIndex((h) => w.test(h));
    if (i >= 0) idx.push(i);
    else if (w !== 'Map #') missing.push(String(w));
  }
  return { idx, missing };
}

/** Pick `idx` out of one row (header or cells). */
export function pickColumns(row, idx) {
  return idx.map((i) => row[i]);
}
