// Vercel Edge Function — streams the GitHub Release-hosted
// legal-search index back to the browser with the CORS header
// the client needs.
//
// The index is ~130 MB, well past Vercel's static-asset rewrite
// ceiling (~4-5 MB), which is why a vercel.json `rewrites` entry
// pointing at the GitHub URL was returning 502. Edge Functions
// support streaming responses with no upstream buffering, so a
// 130 MB body flows straight through.
//
// Why not fetch the GitHub URL from the browser directly? The
// release-asset chain redirects from github.com to
// release-assets.githubusercontent.com without sending
// Access-Control-Allow-Origin on either hop, so cross-origin
// fetches are blocked. This function adds the header.
//
// To roll a new index: upload the regenerated JSON to a new
// release tag on GitHub, then update RELEASE_URL below. No
// other deployment plumbing needs to change.

export const config = {
  runtime: 'edge',
};

const RELEASE_URL =
  'https://github.com/jayschellenberg/manitoba-opendata-parcelsearch/releases/download/data-2026-07-15/legal-index.json';

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

  // Stream the upstream body through the edge — no buffering.
  // Cache for 7 days at the edge / browser; the index changes
  // only when build_legal_index.R is run and uploaded as a
  // fresh release, which we'd accompany with a RELEASE_URL bump
  // (cache key changes implicitly via the new URL).
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders('application/json'),
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  });
}

function corsHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
  };
}
