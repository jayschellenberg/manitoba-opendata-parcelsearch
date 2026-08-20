/*
 * The results grid's N1 ID cell — the id rendered as a link that COPIES
 * rather than navigates.
 *
 * Styled as an ordinary results-table anchor, the same as Roll #, because the
 * gesture is the same one: this is the number you click to take with you.
 * What it does differs. There is no per-id URL worth putting on a cell that
 * can hold two ids, and pasting the id into N1 is the common action — so the
 * anchor copies, the title says so before you click, and the link text flips
 * to "Copied!" after. The parcel popup's N1 line is the place that also
 * offers an edit → link out to the Report Writer record.
 *
 * Multi-id values copy VERBATIM: the MAO↔N1 crosswalk records "19035; 19036"
 * where one sale matched two N1 records, and that whole string is what you
 * meant to paste. Splitting it would produce something the user never saw.
 *
 * Lives in lib/ so it can be tested at all. main.js cannot load under node —
 * it imports map.js, and that pulls in maplibre, turf and mapbox-gl-draw —
 * and the sales rows that would exercise this in a browser come from shards
 * fetched off raw.githubusercontent, so a dev box without network reaches the
 * grid but never populates it. Same reason lib/muniPicker.js was extracted.
 *
 * `doc` is injected rather than reaching for the global so the tests can pass
 * a stub; `wireCopy(anchor, text)` is injected because the clipboard write
 * and its execCommand fallback belong to map.js, which this cannot import.
 */

/**
 * @param {Document} doc            document (or a stub) to build nodes from
 * @param {string|number|null} value the row's N1 ID, raw
 * @param {object}   [io]
 * @param {Function} [io.wireCopy]  (anchor, text) => void — attaches the copy
 * @returns {HTMLTableCellElement}  the <td>, ready to append
 */
export function buildN1Cell(doc, value, { wireCopy } = {}) {
  const cell = doc.createElement('td');
  cell.classList.add('num');

  const raw = value == null ? '' : String(value).trim();
  // Absence is the normal state — most sales are not entered in N1 yet — so
  // an unmatched row reads as a plain empty cell, exactly like every other
  // column. The Unmatched filter is what works that queue, not this cell.
  if (!raw) {
    cell.textContent = '—';
    cell.classList.add('empty');
    return cell;
  }

  const a = doc.createElement('a');
  // href makes it a real link for styling, focus and keyboard activation;
  // the copy handler preventDefaults so it never navigates. role=button says
  // what it actually does for anyone not reading the title.
  a.href = '#';
  a.setAttribute('role', 'button');
  a.textContent = raw;
  a.title = `Copy N1 ID ${raw} to the clipboard`;
  // The row has its own click handler that moves the map. Copying an id is
  // not a request to go there — same reason rollNumberCell stops the event.
  a.addEventListener('click', (e) => e.stopPropagation());
  wireCopy?.(a, raw);
  cell.appendChild(a);
  return cell;
}
