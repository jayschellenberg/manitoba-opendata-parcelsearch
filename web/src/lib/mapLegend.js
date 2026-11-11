/*
 * Legend capture for the Generate Map image.
 *
 * The on-screen legends are HTML overlaid on the map pane, so they never
 * appear in map.getCanvas() — the static export has to redraw them. Split
 * three ways so the fiddly part is testable on its own:
 *
 *   readMapLegends(root)          DOM → plain data
 *   layoutMapLegends(legends, …)  data → positioned boxes   ← pure
 *   paintMapLegends(ctx, boxes)   boxes → pixels
 *
 * The layout step is where the judgement lives: legends stack upward from
 * just above the credit pill, and a tall one (zoning can run to a dozen
 * categories) has to give up rows rather than cover the map it is meant to
 * explain.
 */

import { balancedWrap } from './textFit.js';

/** Share of image height the whole stack may occupy before rows start
 *  collapsing into a "+N more" line. Past this the legend is hiding more
 *  of the map than it is explaining. */
export const LEGEND_MAX_HEIGHT_RATIO = 0.62;

/** Widest a single legend box may get, as a share of image width. */
export const LEGEND_MAX_WIDTH_RATIO = 0.42;

/** A label longer than the box wraps onto at most this many rows. */
export const LEGEND_MAX_LABEL_LINES = 2;

/** Gap left between two on-screen legends stacked in the same corner. */
export const LEGEND_STACK_GAP_PX = 8;

/**
 * Where to anchor a legend stacked directly above another one.
 *
 * The on-screen legends are absolutely positioned by `bottom`, several of
 * them in the same corner. Stacking one over another by hardcoding an offset
 * does not hold: the AADT legend's height moves with how its vintage note
 * wraps, which depends on the map pane's width — it measured 390 px where a
 * hand-picked 250 px had been assumed, so the two overlapped.
 *
 * Returns null when there is nothing to stack over (the lower legend is
 * hidden, or has not been laid out yet), meaning "leave the stylesheet's own
 * value alone".
 *
 * @param {number} baseBottom  the lower legend's own computed `bottom`, px
 * @param {number} height      the lower legend's rendered height, px
 * @param {number} [gap]
 * @returns {number|null} px for the upper legend's `bottom`
 */
export function stackedLegendBottom(baseBottom, height, gap = LEGEND_STACK_GAP_PX) {
  const base = Number(baseBottom);
  const h = Number(height);
  if (!Number.isFinite(h) || h <= 0) return null;
  return Math.round((Number.isFinite(base) ? base : 0) + h + gap);
}

/**
 * Read whatever legends are on screen inside `root`.
 *
 * Every legend — zoning, MASC, CLI, land cover, traffic flow — is built as
 * `<strong>title</strong><ul><li><span class="swatch">…` whether its markup
 * is static in index.html or generated at runtime, so one reader covers all
 * of them plus any future one that follows the shape. Extras that aren't
 * list items (the land-cover opacity slider, the italic acreage footnote)
 * have no <li> and are skipped for free.
 *
 * Swatch colours are read through getComputedStyle rather than the inline
 * style attribute so a colour set from a stylesheet works too; the rgb()
 * string it returns is a valid canvas fillStyle as-is.
 */
export function readMapLegends(root, opts = {}) {
  if (!root) return [];
  const computed = opts.getComputedStyle
    || (typeof globalThis !== 'undefined' && globalThis.getComputedStyle)
    || null;
  return [...root.querySelectorAll('.map-legend')]
    .filter((el) => !el.hidden && el.offsetParent !== null)
    .map((el) => ({
      title: el.querySelector('strong')?.textContent.trim() || '',
      items: [...el.querySelectorAll('li')]
        .map((li) => {
          const sw = li.querySelector('.swatch');
          // data-line="dashed": an outline overlay (the CentrePort SPA), keyed
          // by a dashed square in its border colour rather than a fill.
          const line = sw?.dataset?.line || null;
          const style = sw && computed ? computed(sw) : null;
          return {
            color: style ? (line ? style.borderTopColor : style.backgroundColor) : null,
            label: li.textContent.replace(/\s+/g, ' ').trim(),
            ...(line ? { line } : {}),
            // data-subject: a zone the subject parcel is in (the Addenda
            // Pack zoning map) — drawn bold in an outline box.
            ...(li.dataset?.subject ? { emphasis: true } : {}),
          };
        })
        .filter((item) => item.label),
    }))
    .filter((legend) => legend.items.length > 0);
}

/**
 * Position each legend as a box, stacking upward from `bottomY` so the
 * first one ends up nearest the credit pill.
 *
 * @param {Array} legends            from readMapLegends
 * @param {Object} o
 * @param {number} o.width           output image width
 * @param {number} o.height          output image height
 * @param {number} o.bottomY         y to stack up from (above the credit pill)
 * @param {number} o.font            body font size in px
 * @param {(text:string, weight:'body'|'title'|'strong') => number} o.measure
 *        text width in px — the canvas' measureText, injectable for tests;
 *        'strong' is the bold body font of an emphasised row
 * @returns {Array<{x,y,w,h,title,items,overflow,metrics}>}
 */
export function layoutMapLegends(legends, o) {
  const { width, height, bottomY, font, measure } = o;
  const rowH = Math.round(font * 1.45);
  const swatch = Math.round(font * 0.95);
  const padX = Math.round(font * 0.8);
  const padY = Math.round(font * 0.6);
  const gap = Math.round(font * 0.6);
  const labelX = swatch + Math.round(padX * 0.6);
  const metrics = { rowH, swatch, padX, padY, labelX };

  const ceiling = Math.round(height * (1 - LEGEND_MAX_HEIGHT_RATIO));
  let available = Math.max(0, bottomY - ceiling);
  let y = bottomY;
  const boxes = [];

  // Widest a label may run inside a box at the width cap. Longer labels
  // (a 60-character zone name, the CentrePort SPA row) wrap onto a second
  // row instead of running past the box and off the image (2026-11-05).
  const labelMax = Math.max(40, width * LEGEND_MAX_WIDTH_RATIO - padX * 2 - labelX);
  const itemMeasure = (item) => (t) => measure(t, item.emphasis ? 'strong' : 'body');

  for (const legend of legends || []) {
    if (!legend?.items?.length) continue;
    const titleH = legend.title ? rowH : 0;
    const wrapped = legend.items.map((item) => {
      const m = itemMeasure(item);
      if (m(item.label) <= labelMax) return item;
      const lines = balancedWrap(item.label, labelMax, m, 0).slice(0, LEGEND_MAX_LABEL_LINES);
      return lines.length > 1 ? { ...item, lines } : item;
    });
    const rowsOf = (item) => item.lines?.length || 1;
    const fullH = padY * 2 + titleH + wrapped.reduce((n, it) => n + rowsOf(it), 0) * rowH;

    let items = wrapped;
    let overflow = 0;
    let boxH = fullH;
    if (fullH > available) {
      const room = Math.floor((available - padY * 2 - titleH) / rowH);
      // One row is reserved for the "+N more" line, so below two rows
      // there's nothing worth showing — stop rather than emit a stub.
      if (room < 2) break;
      // Emphasised rows (the subject's zones) are kept first, then the
      // rest in order while they fit; the list keeps its original order.
      const keep = new Set();
      let used = 0;
      for (const pass of [true, false]) {
        for (const it of wrapped) {
          if (!!it.emphasis !== pass || keep.has(it)) continue;
          if (used + rowsOf(it) > room - 1) { if (pass) continue; else break; }
          keep.add(it);
          used += rowsOf(it);
        }
      }
      items = wrapped.filter((it) => keep.has(it));
      overflow = legend.items.length - items.length;
      boxH = padY * 2 + titleH + (used + 1) * rowH;
    }

    let boxW = legend.title ? measure(legend.title, 'title') : 0;
    for (const item of items) {
      for (const line of item.lines || [item.label]) boxW = Math.max(boxW, labelX + itemMeasure(item)(line));
    }
    if (overflow) boxW = Math.max(boxW, labelX + measure(`+${overflow} more`, 'body'));
    boxW = Math.ceil(Math.min(boxW + padX * 2, width * LEGEND_MAX_WIDTH_RATIO));

    boxes.push({
      x: width - boxW - 6,
      y: y - boxH,
      w: boxW,
      h: boxH,
      title: legend.title,
      items,
      overflow,
      metrics,
    });

    available -= boxH + gap;
    y = y - boxH - gap;
    if (available <= 0) break;
  }
  return boxes;
}

/** Paint laid-out legend boxes. Styling mirrors the credit pill so the two
 *  overlays read as one family. */
export function paintMapLegends(ctx, boxes, { font, bodyFont, titleFont, strongFont = `600 ${bodyFont}` } = {}) {
  for (const box of boxes) {
    const { rowH, swatch, padX, padY, labelX } = box.metrics;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);

    ctx.textBaseline = 'middle';
    let rowY = box.y + padY;
    if (box.title) {
      ctx.font = titleFont;
      ctx.fillStyle = '#1a1a1a';
      ctx.fillText(box.title, box.x + padX, rowY + rowH / 2);
      rowY += rowH;
    }
    ctx.font = bodyFont;
    for (const item of box.items) {
      const mid = rowY + rowH / 2;
      if (item.color && item.line) {
        const top = Math.round(mid - swatch / 2);
        ctx.save();
        ctx.strokeStyle = item.color;
        ctx.lineWidth = Math.max(2, Math.round(swatch / 6));
        if (item.line === 'dashed' && ctx.setLineDash) ctx.setLineDash([Math.max(3, swatch / 4), Math.max(2, swatch / 6)]);
        const inset = ctx.lineWidth / 2;
        ctx.strokeRect(box.x + padX + inset, top + inset, swatch - inset * 2, swatch - inset * 2);
        ctx.restore();
      } else if (item.color) {
        const top = Math.round(mid - swatch / 2);
        ctx.fillStyle = item.color;
        ctx.fillRect(box.x + padX, top, swatch, swatch);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.strokeRect(box.x + padX + 0.5, top + 0.5, swatch - 1, swatch - 1);
      }
      ctx.fillStyle = '#1a1a1a';
      // maxWidth keeps a line inside the box: a word too long to wrap is
      // condensed rather than cut off at the image edge.
      const textMax = Math.max(1, box.w - padX * 2 - labelX);
      const lines = item.lines || [item.label];
      if (item.emphasis) {
        // The subject's zone: bold, in a dark outline box around the row.
        ctx.font = strongFont;
        const pad = Math.max(2, Math.round(padX * 0.35));
        ctx.save();
        ctx.strokeStyle = '#1a1a1a';
        ctx.lineWidth = Math.max(1.5, font / 9);
        ctx.strokeRect(box.x + padX - pad, rowY + 1, box.w - (padX - pad) * 2, rowH * lines.length - 2);
        ctx.restore();
      }
      lines.forEach((line, i) => ctx.fillText(line, box.x + padX + labelX, mid + i * rowH, textMax));
      if (item.emphasis) ctx.font = bodyFont;
      rowY += rowH * lines.length;
    }
    if (box.overflow) {
      ctx.fillStyle = '#6b7280';
      ctx.fillText(`+${box.overflow} more`, box.x + padX + labelX, rowY + rowH / 2);
    }
    void font;
  }
}
