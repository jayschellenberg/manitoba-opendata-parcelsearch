/*
 * Where the province-wide parcel vector tiles live (web/public/parcels.pmtiles
 * by default; VITE_PARCEL_TILES_URL moves them to an absolute origin, which
 * must then also be in vercel.json's connect-src). Shared by the main map and
 * the Sales Charts maps (sale outlines, 2026-10-07) so the two cannot point at
 * different archives.
 */
export const PARCEL_TILES_URL =
  import.meta.env?.VITE_PARCEL_TILES_URL || '/parcels.pmtiles';
