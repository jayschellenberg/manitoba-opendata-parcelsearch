/*
 * Convert each `<span class="tip">` inside a `.field` into an
 * info-icon affordance: a small "i" button that, on hover OR
 * click, reveals the existing tip text as a popover. The original
 * `.tip` markup is preserved (it becomes the popover body), so the
 * existing per-field micro-copy stays verbatim and no caller needs
 * to rewrite their tip strings.
 *
 * UX:
 *   - Hover on the icon -> popover shows
 *   - Click on the icon -> popover pins (stays open until next
 *     click, escape, or outside click). Click again unpins.
 *   - Touch tap = same as click (mobile-friendly).
 *   - Keyboard focus on the icon -> popover shows; blur hides
 *     unless pinned.
 *
 * Idempotent — re-running on an already-processed field is a
 * no-op. Skips fields whose `.tip` is empty or which already
 * contain an info-icon.
 */

function ensureClickAwayHandler() {
  if (document.body.dataset.infoIconClickAway === '1') return;
  document.body.dataset.infoIconClickAway = '1';
  document.addEventListener('click', (e) => {
    // Unpin any pinned popovers outside the clicked field.
    for (const f of document.querySelectorAll('.field.popover-pinned')) {
      if (!f.contains(e.target)) f.classList.remove('popover-pinned');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      for (const f of document.querySelectorAll('.field.popover-pinned')) {
        f.classList.remove('popover-pinned');
      }
    }
  });
}

/**
 * Widen a sidebar popover to the full sidebar column.
 *
 * The `.tip` is absolutely positioned inside its `.field`, and an
 * abspos box with `left:0; width:auto` shrink-to-fits against its
 * containing block — so a tip inherits the width of whatever field it
 * hangs off. That is fine under a text input and unreadable under a
 * checkbox: the Far-Flung "Exclude" field is 96px, which wrapped a
 * paragraph of help text into a ~15-character ribbon.
 *
 * Rather than widen every field, measure at open time and pin the tip
 * to the sidebar's content box — one comfortable, consistent column
 * for every sidebar popover regardless of how wide its control is.
 * The arrow is re-aimed at the icon it belongs to, since it can no
 * longer assume the tip's right edge sits near the icon.
 *
 * No-ops outside the sidebar, where the CSS behaviour is already fine.
 */
function widenTipToSidebar(field, tip) {
  const host = field.closest('.sidebar');
  if (!host) return;
  const hostBox = host.getBoundingClientRect();
  const cs = getComputedStyle(host);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const borderL = parseFloat(cs.borderLeftWidth) || 0;
  // clientWidth excludes the scrollbar, which getBoundingClientRect
  // would count — the sidebar scrolls, so that difference is real.
  const contentWidth = host.clientWidth - padL - padR;
  if (!(contentWidth > 0)) return;
  const contentLeft = hostBox.left + borderL + padL;
  const fieldLeft = field.getBoundingClientRect().left;
  tip.classList.add('tip-wide');
  tip.style.width = `${Math.round(contentWidth)}px`;
  tip.style.left = `${Math.round(contentLeft - fieldLeft)}px`;
  // Aim the arrow at the icon: its centre, expressed relative to the
  // tip's own left edge. Clamped so it stays on the tip's rounded
  // corners rather than hanging off the end.
  const icon = field.querySelector(':scope > .info-icon');
  if (icon) {
    const iconBox = icon.getBoundingClientRect();
    const centre = iconBox.left + iconBox.width / 2 - contentLeft;
    const clamped = Math.max(10, Math.min(contentWidth - 15, centre - 5));
    tip.style.setProperty('--tip-arrow-left', `${Math.round(clamped)}px`);
  }
}

function wireField(field) {
  if (!field || field.dataset.infoIconWired === '1') return;
  const tip = field.querySelector(':scope > .tip');
  if (!tip || !tip.textContent.trim()) return;
  // Don't add an icon to chip-input fields' inner text input —
  // those are not standalone form fields. The chip-input wrapper
  // can be wired separately by the caller.
  field.dataset.infoIconWired = '1';

  // Native title attribute on the icon doubles as the OS-level
  // tooltip in case the JS popover is blocked. Keep it short by
  // using the raw text content (no HTML).
  const titleText = tip.textContent.trim();

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'info-icon';
  btn.setAttribute('aria-label', `More info: ${titleText.slice(0, 80)}`);
  btn.setAttribute('title', titleText);
  // Skip the icon when tabbing through form fields — appraisers
  // tab from input to input and don't want to land on every
  // helper icon. Click + hover still open the popover.
  btn.tabIndex = -1;
  // Inline SVG "i" — sharper than a Unicode character and styles
  // cleanly with currentColor. 12 × 12 viewport.
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<rect x="7.25" y="6.75" width="1.5" height="5" fill="currentColor"/>' +
    '<circle cx="8" cy="4.5" r="0.95" fill="currentColor"/>' +
    '</svg>';

  // Insert the icon right before the tip element so the popover
  // anchors against the icon's right edge.
  tip.parentNode.insertBefore(btn, tip);

  // Mark the field so CSS can use it as a popover-positioning hook.
  field.classList.add('has-info-icon');

  // Re-measure on every open rather than once at wire time: the
  // sidebar scrolls and its rows reflow (the Additional-filters
  // disclosure alone moves everything below it), so a width and
  // offset cached at startup would drift.
  const open = (cls) => { widenTipToSidebar(field, tip); field.classList.add(cls); };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (field.classList.contains('popover-pinned')) field.classList.remove('popover-pinned');
    else open('popover-pinned');
  });
  btn.addEventListener('mouseenter', () => open('popover-hover'));
  btn.addEventListener('mouseleave', () => field.classList.remove('popover-hover'));
  btn.addEventListener('focus', () => open('popover-hover'));
  btn.addEventListener('blur', () => field.classList.remove('popover-hover'));

  // Prevent the popover from closing when the user mouses over it
  // (e.g. to read a long sentence).
  tip.addEventListener('mouseenter', () => field.classList.add('popover-hover'));
  tip.addEventListener('mouseleave', () => field.classList.remove('popover-hover'));
}

/**
 * Wire every `.field` under `root` (default: document). Idempotent;
 * safe to call multiple times if new fields appear via JS.
 */
export function initInfoIcons(root = document) {
  ensureClickAwayHandler();
  for (const f of root.querySelectorAll('.field')) wireField(f);
}
