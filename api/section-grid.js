// Vercel Edge Function — streams the GitHub Release-hosted Manitoba
// Sec-Twp section-grid GeoJSON back to the browser with the CORS
// header the client needs.
//
// Mirrors api/legal-index.js: section-grid.json is ~40 MB, well past
// the shard CDN's comfort zone (the rest of the bulk data lives in the
// mb-parcel-data repo and serves via raw.githubusercontent pinned commits) and
// also too large for vercel.json static rewrites. Edge Functions
// stream the body straight through with no buffering, so a single
// large file flows fine.
//
// Why not fetch the GitHub URL from the browser directly? The release-
// asset chain redirects from github.com to
// release-assets.githubusercontent.com without sending
// Access-Control-Allow-Origin on either hop, so cross-origin fetches
// are blocked. This function adds the header.
//
// To roll a new grid:
//   Rscript r/build_section_grid.R   # writes web/public/data/section-grid.json
//   gh release create data-section-grid-YYYY-MM-DD web/public/data/section-grid.json --title "..."
// Then update RELEASE_URL below.

export const config = {
  runtime: 'edge',
};

const RELEASE_URL =
  'https://github.com/jayschellenberg/manitoba-opendata-parcelsearch/releases/download/data-section-grid-2026-05-06/section-grid.json';

export default async function handler() {
  let upstream;
  try {
    upstream = await fetch(RELEASE_URL, { redirect: 'follow' });
  } catch (err) {
    return new Response(
      `Upstream fetch failed: ${err.message}`,
      {
        status: 502,
        headers: corsHeaders('text/plain'),
      },
    );
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(
      `Upstream returned ${upstream.status} ${upstream.statusText}`,
      {
        status: upstream.status || 502,
        headers: corsHeaders('text/plain'),
      },
    );
  }

  // Stream the upstream body through the edge — no buffering. Cache
  // 30 days at edge + browser; the grid only changes when
  // build_section_grid.R re-runs (section geometry doesn't change),
  // which we'd accompany with a RELEASE_URL bump (cache key changes
  // implicitly via the new URL).
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders('application/json'),
      'Cache-Control': 'public, max-age=2592000, immutable',
    },
  });
}

function corsHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
  };
}
