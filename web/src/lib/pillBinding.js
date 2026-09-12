// Segmented pills backed by hidden checkboxes.
//
// The sidebar's on/off search filters (Waterfront / Near water, Licensed
// tile drainage / irrigation) and the parcel-numbering pair were plain
// checkboxes. They are now segmented pills, but every handler behind them —
// the water-influence re-search, the WALLAS roll pre-filter, the numbering
// sort and callouts, the URL-state writer, the overlay-group badge — still
// reads the original <input type="checkbox"> elements. So the inputs stay in
// the DOM, hidden, and each pill is a VIEW of them: clicking a segment sets
// the backing inputs and fires `change` on the ones that flipped; any
// `change` on an input (user or programmatic) repaints the pill. One mode
// maps to one combination of checked states, and the tables below are the
// whole contract.
//
// Pure: no DOM here, so the mapping is unit-tested (test/pillBinding.test.js)
// and main.js only owns the wiring.

export const PILL_SPECS = {
  // Waterfront and Near water are OR'd with each other (both = any water
  // influence), so the pill has an explicit Any segment rather than
  // pretending the two are exclusive.
  water: {
    inputs: ['waterfront-only', 'near-water-only'],
    modes: { off: [false, false], waterfront: [true, false], near: [false, true], any: [true, true] },
  },
  // Tile drainage and irrigation AND together (a parcel must have both), so
  // they stay two independent on/off pills.
  tile:       { inputs: ['tile-only'],       modes: { off: [false], on: [true] } },
  irrigation: { inputs: ['irrigation-only'], modes: { off: [false], on: [true] } },
  // Entry order only means anything while numbering is on, so it is the
  // third segment of one pill rather than a dependent checkbox.
  numbering: {
    inputs: ['numbering-toggle', 'numbering-order-toggle'],
    modes: { off: [false, false], muni: [true, false], entry: [true, true] },
  },
};

const same = (a, b) => a.length === b.length && a.every((v, i) => !!v === !!b[i]);

/** The mode whose checked pattern matches `checked` exactly; the first
 *  mode (Off) when nothing matches — e.g. numbering [false, true], an
 *  "entry order without numbering" state the UI never offers. */
export function modeFromChecked(spec, checked) {
  const names = Object.keys(spec.modes);
  return names.find((m) => same(spec.modes[m], checked)) || names[0];
}

/** Checked pattern for `mode`; an unknown mode reads as the first (Off). */
export function checkedFromMode(spec, mode) {
  return spec.modes[mode] || spec.modes[Object.keys(spec.modes)[0]];
}
