// Result cards — the phone face of the results table.
//
// The table is built positionally: renderTable() in main.js appends one
// td per <th>, enrichment passes patch cells in place afterwards, and
// columns.js hides columns by toggling a class on th and td alike. None
// of that is a data model a second renderer could consume. So the cards
// are read FROM the rendered table: each <tr> becomes one card whose
// headline fields are picked by column key and whose expandable detail
// is every other column the table would show. A MutationObserver on the
// table rebuilds the cards whenever it changes — a new search, a sort,
// a page, an enrichment pass landing, a column toggled in the gear —
// so main.js needs no second call site and nothing can drift.
//
// Tapping a card forwards the click to its <tr>, which is the one place
// that knows how to fly the map to the parcel. The card's checkbox
// forwards to the row's, so selection stays one Set in main.js.

/** Column keys shown as the card's fact strip, in this order. */
export const FACT_KEYS = ['value', 'zone1', 'saledate', 'saleprice', 'acres', 'du'];
/** Keys the headline already covers, so the detail list skips them. */
const HEADLINE_KEYS = new Set(['address', 'roll', 'muniname', 'zone1pct', 'seq', 'select', 'favorite', ...FACT_KEYS]);

/**
 * Pure: from one row's columns build what the card shows.
 *   columns  [{ key, label, text, hidden, empty }]  in table order
 * Returns { title, sub, seq, facts: [{key,label,text}], rest: [column] }.
 * Headline fields ignore `hidden` (they are the phone's fixed summary);
 * the detail list honours it, so the column gear still governs the
 * expanded view.
 */
export function cardModel(columns) {
  const by = new Map();
  for (const c of columns) if (c.key && !by.has(c.key)) by.set(c.key, c);
  const filled = (k) => {
    const c = by.get(k);
    return c && !c.empty ? c : null;
  };
  const address = filled('address');
  const legal = filled('legal');
  const roll = filled('roll');
  const title = address?.text || legal?.text || (roll ? `Roll ${roll.text}` : 'Parcel');
  const sub = [
    roll && title !== `Roll ${roll.text}` ? `Roll ${roll.text}` : null,
    filled('muniname')?.text || null,
  ].filter(Boolean).join(' · ');
  const seqCol = by.get('seq');
  const seq = seqCol && !seqCol.hidden && !seqCol.empty ? seqCol.text : null;
  const facts = [];
  for (const k of FACT_KEYS) {
    const c = filled(k);
    if (!c) continue;
    let text = c.text;
    if (k === 'zone1') {
      const pct = filled('zone1pct');
      if (pct) text = `${text} (${pct.text})`;
    }
    // The Assessment cell links to the parcel's MAO report; a fact keeps
    // that link, it is the one thing a field lookup most often opens.
    facts.push({ key: k, label: c.label, text, href: c.href || null, linkText: c.href ? text : null });
  }
  const rest = columns.filter((c) =>
    c.key && !c.hidden && !c.empty && !HEADLINE_KEYS.has(c.key)
    && (title !== c.text || c.key !== 'legal'));
  return { title, sub, seq, facts, rest };
}

function readHeads(table) {
  return [...table.querySelectorAll('thead th')].map((th) => ({
    key: th.dataset.col || '',
    label: th.textContent.replace(/[⇅▲▼]/g, '').trim() || th.dataset.col || '',
    hidden: th.classList.contains('col-hidden') || getComputedStyle(th).display === 'none',
  }));
}

function readRow(tr, heads) {
  const cols = [];
  const cells = tr.cells;
  for (let i = 0; i < cells.length && i < heads.length; i++) {
    const td = cells[i];
    const text = td.textContent.replace(/\s+/g, ' ').trim();
    const link = td.querySelector('a[href]');
    cols.push({
      ...heads[i],
      text,
      empty: td.classList.contains('empty') || text === '' || text === '—',
      hidden: heads[i].hidden || td.classList.contains('col-hidden'),
      href: link ? link.href : null,
      linkText: link ? link.textContent.trim() : null,
    });
  }
  return cols;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function valueNode(col) {
  if (!col.href) return document.createTextNode(col.text);
  const a = el('a', null, col.linkText || col.text);
  a.href = col.href;
  a.target = '_blank';
  a.rel = 'noreferrer';
  return a;
}

/**
 * Wire the cards.
 *   table      the results <table>
 *   container  where the cards render (inside #results-wrap)
 *   isPhone()  cards only render while it returns true
 *   onTap()    called after a card forwards its click to the row
 * Returns { render } so phone-mode changes can force a rebuild.
 */
export function initResultCards({ table, container, isPhone, onTap }) {
  if (!table || !container || typeof MutationObserver === 'undefined') return null;
  const open = new Set();   // rowKeys whose detail is expanded
  let queued = 0;

  const buildCard = (tr, heads) => {
    const cols = readRow(tr, heads);
    const m = cardModel(cols);
    const key = tr.dataset.rowKey || '';
    const card = el('article', 'result-card');
    if (key) card.dataset.rowKey = key;
    for (const cls of ['starred', 'deselected', 'outlier']) {
      if (tr.classList.contains(cls)) card.classList.add(cls);
    }
    if (open.has(key)) card.classList.add('open');

    const head = el('div', 'result-card-head');
    const rowBox = tr.querySelector('input.row-select');
    if (rowBox) {
      const box = el('input', 'result-card-check');
      box.type = 'checkbox';
      box.checked = rowBox.checked;
      box.title = rowBox.title;
      box.setAttribute('aria-label', 'Include this row');
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => { rowBox.click(); });
      head.appendChild(box);
    }
    const text = el('div', 'result-card-text');
    const title = el('h4', 'result-card-title', m.title);
    if (m.seq) title.prepend(el('span', 'result-card-seq', m.seq));
    text.appendChild(title);
    if (m.sub) text.appendChild(el('p', 'result-card-sub', m.sub));
    head.appendChild(text);
    card.appendChild(head);

    if (m.facts.length) {
      const ul = el('ul', 'result-card-facts');
      for (const f of m.facts) {
        const li = el('li');
        li.appendChild(el('b', null, f.label));
        li.appendChild(valueNode(f));
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    if (m.rest.length) {
      const more = el('button', 'result-card-more', open.has(key) ? 'Less' : 'Details');
      more.type = 'button';
      more.setAttribute('aria-expanded', String(open.has(key)));
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        const now = !card.classList.contains('open');
        card.classList.toggle('open', now);
        more.textContent = now ? 'Less' : 'Details';
        more.setAttribute('aria-expanded', String(now));
        if (now) open.add(key); else open.delete(key);
      });
      card.appendChild(more);
      const dl = el('dl', 'result-card-detail');
      for (const c of m.rest) {
        dl.appendChild(el('dt', null, c.label));
        const dd = el('dd');
        dd.appendChild(valueNode(c));
        dl.appendChild(dd);
      }
      card.appendChild(dl);
    }

    card.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, label')) return;
      tr.click();
      if (typeof onTap === 'function') onTap(tr);
    });
    return card;
  };

  const render = () => {
    queued = 0;
    if (!isPhone()) {
      if (container.childElementCount) container.replaceChildren();
      return;
    }
    const heads = readHeads(table);
    const frag = document.createDocumentFragment();
    const body = table.tBodies[0];
    if (body) for (const tr of body.rows) frag.appendChild(buildCard(tr, heads));
    container.replaceChildren(frag);
  };

  const schedule = () => {
    if (queued) return;
    queued = requestAnimationFrame(render);
  };

  /**
   * Open and scroll to the card for a row key — a parcel tapped on the
   * map. Returns false when there is no such card (another page, or a
   * parcel outside the results) so the caller can fall back to a popup.
   */
  const reveal = (key) => {
    if (!isPhone() || key == null) return false;
    if (queued) { cancelAnimationFrame(queued); render(); }
    const esc = window.CSS?.escape ? CSS.escape(String(key)) : String(key).replace(/["\\]/g, '\\$&');
    const card = container.querySelector(`.result-card[data-row-key="${esc}"]`);
    if (!card) return false;
    if (!card.classList.contains('open')) card.querySelector('.result-card-more')?.click();
    for (const prev of container.querySelectorAll('.result-card.card-highlight')) {
      prev.classList.remove('card-highlight');
    }
    void card.offsetWidth;
    card.classList.add('card-highlight');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  };

  new MutationObserver(schedule).observe(table, {
    childList: true, subtree: true, attributes: true, characterData: true,
  });
  schedule();
  return { render: schedule, reveal };
}
