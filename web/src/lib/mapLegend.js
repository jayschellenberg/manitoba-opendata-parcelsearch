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

/** Share of image height the whole stack may occupy before rows start
 *  collapsing into a "+N more" line. Past this the legend is hiding more
 *  of the map than it is explaining. */
export const LEGEND_MAX_HEIGHT_RATIO = 0.62;

/** Widest a single legend box may get, as a share of image width. */
export const LEGEND_MAX_WIDTH_RATIO = 0.42;

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
          return {
            color: sw && computed ? computed(sw).backgroundColor : null,
            label: li.textContent.replace(/\s+/g, ' ').trim(),
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
 * @param {(text:string, weight:'body'|'title') => number} o.measure
 *        text width in px — the canvas' measureText, injectable for tests
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

  for (const legend of legends || []) {
    if (!legend?.items?.length) continue;
    const titleH = legend.title ? rowH : 0;
    const fullH = padY * 2 + titleH + legend.items.length * rowH;

    let items = legend.items;
    let overflow = 0;
    let boxH = fullH;
    if (fullH > available) {
      const room = Math.floor((available - padY * 2 - titleH) / rowH);
      // One row is reserved for the "+N more" line, so below two rows
      // there's nothing worth showing — stop rather than emit a stub.
      if (room < 2) break;
      items = legend.items.slice(0, room - 1);
      overflow = legend.items.length - items.length;
      boxH = padY * 2 + titleH + (items.length + 1) * rowH;
    }

    let boxW = legend.title ? measure(legend.title, 'title') : 0;
    for (const item of items) boxW = Math.max(boxW, labelX + measure(item.label, 'body'));
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
export function paintMapLegends(ctx, boxes, { font, bodyFont, titleFont } = {}) {
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
      if (item.color) {
        const top = Math.round(mid - swatch / 2);
        ctx.fillStyle = item.color;
        ctx.fillRect(box.x + padX, top, swatch, swatch);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.strokeRect(box.x + padX + 0.5, top + 0.5, swatch - 1, swatch - 1);
      }
      ctx.fillStyle = '#1a1a1a';
      ctx.fillText(item.label, box.x + padX + labelX, mid);
      rowY += rowH;
    }
    if (box.overflow) {
      ctx.fillStyle = '#6b7280';
      ctx.fillText(`+${box.overflow} more`, box.x + padX + labelX, rowY + rowH / 2);
    }
    void font;
  }
}
