/*
 * Route Optimizer outputs: the printable sheet (map page + check-off list),
 * Google Maps links, the CSV, and duration formatting.
 *
 * The sheet is DOM built into #sheet in route.html and shown only under
 * @media print (route.css), so printing needs no popup or blob: document
 * (the production CSP allows neither inline script nor blob: pages).
 */

export function fmtDur(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
}

/** Address as shown to the user: "Label — address" when a real label was given. */
export function displayAddress(p) {
  return p.label && !['Start', 'Finish'].includes(p.label) ? `${p.label} — ${p.query}` : p.query;
}

/**
 * Google Maps directions links, at most 9 waypoints each (the mobile limit).
 * @param {{lat:number, lon:number}[]} seq  places in driving order
 * @returns {{a:number, b:number, url:string}[]}  a/b = first/last index covered
 */
export function mapsLinks(seq) {
  const out = [];
  const size = 11; // origin + 9 waypoints + destination
  for (let s = 0; s < seq.length - 1; s += size - 1) {
    const chunk = seq.slice(s, s + size);
    const ll = chunk.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`);
    let url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving'
      + `&origin=${ll[0]}&destination=${ll[ll.length - 1]}`;
    if (ll.length > 2) url += `&waypoints=${encodeURIComponent(ll.slice(1, -1).join('|')).replace(/%2C/g, ',')}`;
    out.push({ a: s, b: s + chunk.length - 1, url });
  }
  return out;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** rows from main.js routeRows() -> CSV text. */
export function routeCsv(rows) {
  const head = ['#', 'Stop', 'Notes', 'Input', 'Matched', 'Leg time', 'Leg km', 'Cumulative', 'Cum. km', 'Lat', 'Lon', 'Geocode quality'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.num, displayAddress(r.p), r.p.notes || '', r.p.query, r.p.matched || '',
      r.first ? '' : fmtDur(r.legT), r.first ? '' : (r.legD / 1000).toFixed(1),
      fmtDur(r.cumT), (r.cumD / 1000).toFixed(1),
      r.p.lat.toFixed(6), r.p.lon.toFixed(6), r.p.quality || '',
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * Build the printable sheet into `root`.
 * @param {HTMLElement} root
 * @param {{title:string, rows:object[], skipped:object[], img:{dataUrl:string, orientation:string, widthIn:number, heightIn:number}}} args
 */
export function buildSheet(root, { title, rows, skipped, img }) {
  const places = rows.length - (rows[rows.length - 1]?.num === 'End' ? 1 : 0);
  const last = rows[rows.length - 1];
  const summary = `${places} places · ${fmtDur(last.cumT)} · ${(last.cumD / 1000).toFixed(1)} km driving`;
  const header = (text) => {
    const d = h('div', 'head');
    d.append(h('h1', '', text), h('div', 'sum', summary));
    return d;
  };

  const mapPage = h('div', `mappage ${img.orientation}`);
  const pic = h('img');
  pic.src = img.dataUrl;
  pic.alt = 'Route map';
  pic.style.width = `${img.widthIn}in`;
  pic.style.height = `${img.heightIn}in`;
  mapPage.append(header(title), pic);

  const list = h('div', 'listpage');
  const table = h('table');
  const cg = h('colgroup');
  for (const c of ['c-box', 'c-num', 'c-addr', '', 'c-time']) {
    const col = h('col', c);
    cg.append(col);
  }
  const thead = h('thead');
  const hr = h('tr');
  for (const t of ['', '#', 'Address', 'Notes', 'Time']) hr.append(h('th', '', t));
  thead.append(hr);
  const tbody = h('tbody');
  const row = (cls, num, addr, notes) => {
    const tr = h('tr', cls);
    const box = h('td');
    box.append(h('span', 'box'));
    tr.append(box, h('td', 'num', num), h('td', 'addr', addr), h('td', 'notes', notes || ''), h('td', 'time'));
    return tr;
  };
  for (const r of rows) tbody.append(row('', r.num, displayAddress(r.p) + (r.p.approx ? ' *' : ''), r.p.notes));
  if (skipped.length) {
    const tr = h('tr', 'section');
    const td = h('td', '', 'Not on the map — address not found');
    td.colSpan = 5;
    tr.append(td);
    tbody.append(tr);
    for (const p of skipped) tbody.append(row('skip', '', p.query, p.notes));
  }
  table.append(cg, thead, tbody);
  list.append(header(`${title} — stops`), table);
  if (rows.some((r) => r.p.approx)) {
    list.append(h('div', 'foot', '* Approximate location: matched the street, not the house number.'));
  }
  root.replaceChildren(mapPage, list);
}
