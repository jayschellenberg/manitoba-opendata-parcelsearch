// Fit a line of exhibit text into a width: wrap first, shrink only if
// wrapping alone is not enough (Jason, 2026-11-05). The Addenda zoning
// map's corner label ran off the image once it had to name a regulation
// ("Zoning Map — Inland Port Special Planning Area (CentrePort), Manitoba
// Regulation 48/2016 (registered March 8, 2016), as amended by 10/2021"),
// because the corner label was drawn as one unbounded line.
//
// Wrapping beats shrinking for a report exhibit: the type stays the size
// of every other exhibit's label. So a label that is only slightly too
// long gives up a little size and stays on one line; anything longer
// wraps into balanced lines (no one-word orphan on the last line) at the
// full size; and only a label that would need more than `maxLines` at the
// full size is shrunk, down to `floorScale`.
//
// Pure: `measure(text, fontPx)` is the canvas' measureText at that size,
// injected so the layout can be tested without a canvas.

/** Greedy word wrap at `width`. Words longer than the width stand alone. */
export function greedyWrap(words, width, measure, font) {
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || measure(candidate, font) <= width) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/** Balanced wrap over pre-split tokens (words, or whole phrases). */
function balancedTokens(tokens, maxWidth, measure, font) {
  if (tokens.length === 0) return [];
  const base = greedyWrap(tokens, maxWidth, measure, font);
  if (base.length <= 1) return base;
  let lo = 0;
  let hi = maxWidth;
  let best = base;
  for (let i = 0; i < 20 && hi - lo > 1; i++) {
    const mid = (lo + hi) / 2;
    const trial = greedyWrap(tokens, mid, measure, font);
    const fits = trial.length <= base.length && trial.every((l) => measure(l, font) <= maxWidth);
    if (fits) { hi = mid; best = trial; } else lo = mid;
  }
  return best;
}

/** Wrap into the fewest lines greedy wrapping needs at `maxWidth`, then
 *  narrow the width as far as possible without adding a line, so the
 *  lines come out about even instead of long-long-short. */
export function balancedWrap(text, maxWidth, measure, font) {
  return balancedTokens(String(text ?? '').split(/\s+/).filter(Boolean), maxWidth, measure, font);
}

/** Phrases a label may break between: after a comma that ends a clause
 *  ("(CentrePort), Manitoba …", "2016), as amended …" — not "March 8, 2016")
 *  and before an em dash. */
export function phrases(text) {
  return String(text ?? '').split(/(?<=,)\s+(?=[A-Za-z])|\s+(?=—)/).map((p) => p.trim()).filter(Boolean);
}

/** Wrap at phrase breaks when that fits in `maxLines` lines no wider than
 *  `maxWidth` and needs no more lines than wrapping word by word ("Zoning Map — Inland Port … (CentrePort)," / "Manitoba
 *  Regulation 48/2016 …" rather than splitting "Manitoba Regulation");
 *  otherwise word by word. */
export function phraseWrap(text, maxWidth, measure, font, maxLines = Infinity) {
  const byWord = balancedWrap(text, maxWidth, measure, font);
  const parts = phrases(text);
  if (parts.length > 1) {
    // Only when it costs no extra line: two tidy lines beat three.
    const lines = balancedTokens(parts, maxWidth, measure, font);
    if (lines.length <= Math.min(maxLines, byWord.length)
        && lines.every((l) => measure(l, font) <= maxWidth)) return lines;
  }
  return byWord;
}

/**
 * Lay `text` out within `maxWidth`.
 *
 * @param {string} text
 * @param {object} o
 * @param {number} o.font        preferred font size in px
 * @param {number} o.maxWidth    widest a line may be, in px
 * @param {number} [o.wrapWidth=maxWidth]  narrower target once it has to
 *        wrap, so a wrapped label is a compact block rather than two
 *        full-width bars across the map
 * @param {(text:string, fontPx:number) => number} o.measure
 * @param {number} [o.maxLines=3]
 * @param {number} [o.oneLineScale=0.9]  shrink this far to stay on one line
 * @param {number} [o.floorScale=0.7]    never smaller than this
 * @returns {{ font: number, lines: string[], fits: boolean }}
 *   `fits` is false only when even the floor size needs more than
 *   maxLines (or a single word is wider than maxWidth); callers then draw
 *   with fillText's maxWidth so nothing is cut off.
 */
export function fitText(text, { font, maxWidth, wrapWidth = maxWidth, measure, maxLines = 3, oneLineScale = 0.9, floorScale = 0.7 }) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return { font, lines: [], fits: true };
  if (measure(t, font) <= maxWidth) return { font, lines: [t], fits: true };

  const oneLine = Math.max(1, Math.floor(font * oneLineScale));
  if (measure(t, oneLine) <= maxWidth) return { font: oneLine, lines: [t], fits: true };

  // Full size first, then 5% steps down to the floor.
  const floor = Math.max(1, Math.floor(font * floorScale));
  const step = Math.max(1, Math.round(font * 0.05));
  const sizes = [];
  for (let f = font; f > floor; f -= step) sizes.push(f);
  sizes.push(floor);

  const target = Math.min(maxWidth, wrapWidth);
  let last = null;
  for (const f of sizes) {
    const lines = phraseWrap(t, target, measure, f, maxLines);
    const fits = lines.length <= maxLines && lines.every((l) => measure(l, f) <= target);
    last = { font: f, lines, fits };
    if (fits) return last;
  }
  return last;
}
