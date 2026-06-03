/*
 * Shared raster-output settings for the saved map images — the parcel
 * snapshots (snapshotExport.js) and the on-screen "Generate Map" static
 * image (main.js composeWithAttribution). Kept in one place so both stay
 * in sync.
 *
 * JPEG, not PNG: these frames are almost entirely satellite imagery, which
 * is photographic. PNG stores it losslessly and a single 1920×1080 frame
 * lands around 3 MB; the same frame as JPEG is ~250–400 KB with no visible
 * loss, which matters for dropping dozens into a (possibly printed) digital
 * report. The longest side is capped to keep documents light while staying
 * sharp enough for typical printed report figures (~150–200 DPI at half-
 * page width). Retune QUALITY / dimensions here to trade size vs fidelity.
 */

export const OUTPUT_MIME = 'image/jpeg';
export const OUTPUT_QUALITY = 0.85;
export const OUTPUT_EXT = 'jpg';

// Parcel snapshots render to this fixed 16:9 frame.
export const SNAPSHOT_W = 1600;
export const SNAPSHOT_H = 900;

// Generate Map captures the (variable-size) visible view; its longest side
// is downscaled to at most this so the saved image matches the snapshots'
// resolution band. Never upscales a smaller view.
export const MAX_OUTPUT_DIM = 1600;
