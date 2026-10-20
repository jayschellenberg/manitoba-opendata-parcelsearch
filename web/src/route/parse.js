/*
 * Stop parsing and geocode-quality checks for the Route Optimizer page.
 *
 * Port of the parsing in D:\Dropbox\ClaudeCode\route-optimizer\app.py.
 * Pure functions, no DOM: unit-tested in test/routeParse.test.js.
 *
 * Accepted input (the Stops box):
 * - Rows pasted from Excel WITH a header row (Address, City, Province/State,
 *   Notes, Name, Lat, Lon ...): read by column name.
 * - The same rows WITHOUT a header: cells up to and including a province
 *   (MB, Manitoba ...) are the address, the rest are notes.
 * - Typed lines: one address or "lat, lon" per line, optional
 *   "Label | address".
 */

const COORD_RE = /^\s*\(?\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*\)?\s*$/;

/** [lat, lon] if text is a coordinate pair, else null. A lon-first pair
 *  (e.g. -97.1, 49.9) is swapped when unambiguous. */
export function parseCoords(text) {
  const m = COORD_RE.exec(text || '');
  if (!m) return null;
  let a = Number(m[1]);
  let b = Number(m[2]);
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [a, b];
  return null;
}

const HEADER_WORDS = new Set(['address', 'addr', 'street', 'city', 'town', 'province', 'prov', 'state',
  'lat', 'latitude', 'lon', 'lng', 'longitude', 'name', 'notes', 'note']);

export const PROVINCES = new Set([
  'ab', 'bc', 'mb', 'nb', 'nl', 'ns', 'nt', 'nu', 'on', 'pe', 'qc', 'sk', 'yt',
  'alberta', 'british columbia', 'manitoba', 'new brunswick', 'newfoundland and labrador',
  'nova scotia', 'northwest territories', 'nunavut', 'ontario', 'prince edward island',
  'quebec', 'saskatchewan', 'yukon',
]);

/** Spreadsheet paste: tabs, or 2+ spaces when the tabs were lost. */
function splitRow(line) {
  return (line.includes('\t') ? line.split('\t') : line.split(/\s{2,}/)).map((c) => c.trim());
}

function pick(cols, ...names) {
  for (const n of names) if (cols.has(n)) return cols.get(n);
  return -1;
}

/**
 * Stops from a header row + data rows (paste or CSV).
 * @param {string[]} header
 * @param {string[][]} rows
 */
export function parseTable(header, rows) {
  const cols = new Map(header.map((h, i) => [String(h).toLowerCase().trim(), i]));
  const cName = pick(cols, 'name', 'label', 'stop', 'id');
  const cAddr = pick(cols, 'address', 'addr', 'location', 'full address', 'street');
  const cCity = pick(cols, 'city', 'town', 'municipality');
  const cProv = pick(cols, 'province', 'prov', 'state');
  const cLat = pick(cols, 'lat', 'latitude', 'y');
  const cLon = pick(cols, 'lon', 'lng', 'long', 'longitude', 'x');
  const cNote = pick(cols, 'notes', 'note', 'comments', 'comment', 'description');
  if (cAddr < 0 && !(cLat >= 0 && cLon >= 0)) {
    throw new Error("Needs an 'Address' column or 'Lat' + 'Lon' columns.");
  }
  const val = (row, c) => (c >= 0 && row[c] != null ? String(row[c]).trim() : '');
  const stops = [];
  for (const row of rows) {
    let query;
    const lat = val(row, cLat);
    const lon = val(row, cLon);
    if (lat && lon && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
      query = `${Number(lat)}, ${Number(lon)}`;
    } else if (val(row, cAddr)) {
      query = [val(row, cAddr), val(row, cCity), val(row, cProv)].filter(Boolean).join(', ');
    } else {
      continue;
    }
    stops.push({ label: val(row, cName), query, notes: val(row, cNote) });
  }
  return stops;
}

/** Headerless row of cells -> stop (see module comment). */
export function guessCells(cells) {
  const xy = parseCoords(`${cells[0]}, ${cells[1]}`);
  if (xy) return { label: '', query: `${xy[0]}, ${xy[1]}`, notes: cells.slice(2).join('; ') };
  const prov = cells.findIndex((c) => PROVINCES.has(c.toLowerCase().replace(/\.$/, '')));
  const cut = prov >= 0 ? prov + 1 : Math.min(2, cells.length);
  return { label: '', query: cells.slice(0, cut).join(', '), notes: cells.slice(cut).join('; ') };
}

/** Everything typed or pasted into the Stops box -> [{label, query, notes}]. */
export function parseStops(text) {
  const lines = String(text || '').split(/\r\n?|\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return [];
  const headCells = splitRow(lines[0]);
  const head = new Set(headCells.map((c) => c.toLowerCase()));
  if (head.size > 1 && [...head].some((c) => HEADER_WORDS.has(c))) {
    const rows = lines.slice(1).map((l) => splitRow(l));
    return parseTable(headCells, rows);
  }
  const stops = [];
  for (let line of lines) {
    line = line.trim();
    const cells = line.includes('|') ? [] : splitRow(line).filter(Boolean);
    if (cells.length > 1) {
      stops.push(guessCells(cells));
      continue;
    }
    const bar = line.indexOf('|');
    const label = bar >= 0 ? line.slice(0, bar).trim() : '';
    const where = bar >= 0 ? line.slice(bar + 1).trim() : line;
    stops.push({ label, query: where, notes: '' });
  }
  return stops;
}

/** Minimal CSV -> rows (quoted cells, "" escapes). */
export function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------- addresses

const RANGE_RE = /^\s*(\d+[A-Za-z]?)\s*(?:-|&|and|,)\s*\d+[A-Za-z]?\b/i;
export const NUMBER_RE = /^\s*\d+[A-Za-z]?\s+/;

/** '215 & 223 Cree Rd' -> '215 Cree Rd'; '32-48 Seal/88 Severen, X' -> '32 Seal, X'. */
export function cleanAddress(q) {
  const comma = q.indexOf(',');
  let street = comma >= 0 ? q.slice(0, comma) : q;
  const rest = comma >= 0 ? q.slice(comma) : '';
  if (street.includes('/')) street = street.split('/')[0];
  street = street.replace(RANGE_RE, '$1');
  return (street.trim() + rest).trim();
}

const STREET_TYPES = {
  rd: 'road', road: 'road', dr: 'drive', drive: 'drive', ave: 'avenue', av: 'avenue', avenue: 'avenue',
  st: 'street', street: 'street', cr: 'crescent', cres: 'crescent', cresc: 'crescent', crescent: 'crescent',
  pl: 'place', place: 'place', bay: 'bay', blvd: 'boulevard', boulevard: 'boulevard', ln: 'lane',
  lane: 'lane', ct: 'court', crt: 'court', court: 'court', hwy: 'highway', highway: 'highway',
  trl: 'trail', trail: 'trail', cir: 'circle', circle: 'circle', ter: 'terrace', terr: 'terrace',
  terrace: 'terrace', way: 'way', pkwy: 'parkway', parkway: 'parkway', cove: 'cove', gate: 'gate',
  grove: 'grove', close: 'close', row: 'row', point: 'point', pt: 'point',
};

function streetType(street) {
  const words = street.toLowerCase().match(/[a-z]+/g) || [];
  // skip the name's first word ("Bay Rd" is a road named Bay)
  const types = words.slice(1).filter((w) => STREET_TYPES[w]).map((w) => STREET_TYPES[w]);
  return types.length ? types[types.length - 1] : null;
}

/** True when the geocoder swapped in a different street type, e.g. we asked
 *  for Cree Crescent and OSM returned Cree Road. */
export function streetMismatch(query, matched) {
  const want = streetType(query.split(',')[0].replace(NUMBER_RE, ''));
  const comp = (matched || '').split(',').find((c) => /[A-Za-z]/.test(c)) || '';
  const got = streetType(comp);
  return Boolean(want && got && want !== got);
}

/** True when the geocoder matched the street or area, not the house number. */
export function isApproximate(provider, query, res) {
  if (provider === 'google') {
    return !/^(ROOFTOP|RANGE_INTERPOLATED)/.test(res.quality || '') || /partial/.test(res.quality || '');
  }
  const m = NUMBER_RE.exec(query);
  if (!m) return false;
  const num = m[0].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !new RegExp(`(^|\\D)${num}(\\D|$)`).test(res.matched || '');
}
