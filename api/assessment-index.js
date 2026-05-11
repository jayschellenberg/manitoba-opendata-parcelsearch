// Vercel Edge Function — streams the GitHub Release-hosted
// assessment-index shard back to the browser with the CORS header
// the client needs.
//
// Mirrors api/legal-index.js. The assessment shard is ~17 MiB raw /
// ~3.5 MiB gzipped — well below GitHub's 100 MiB single-file ceiling
// and Vercel's static rewrite limit, so we *could* in theory ship it
// as a static asset. We use the Edge Function for two reasons:
//
//   1. Consistency with the legal-index shipping path — both data
//      shards refresh from the same R-script + GitHub Release flow,
//      so admins only need to remember one publishing dance.
//   2. The vercel.json static-asset rewrite path doesn't add the
//      Access-Control-Allow-Origin header on cross-origin responses
//      (the redirect chain to release-assets.githubusercontent.com
//      strips it on every hop). Edge Functions can stream the body
//      AND inject the header.
//
// To roll a new index:
//   npm run assessment:index   (in /web)
//   gh release create data-YYYY-MM-DD web/public/data/assessment-index.json --title "..."
// Then bump RELEASE_URL below. No client-side change needed.

export const config = {
  runtime: 'edge',
};

const RELEASE_URL =
  'https://github.com/jayschellenberg/manitoba-opendata-parcelsearch/releases/download/data-2026-05-11/assessment-index.json';

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
  // for 7 days at the edge / browser; the index changes only when
  // build_assessment_index.R is run and uploaded as a fresh release,
  // which we'd accompany with a RELEASE_URL bump (cache key changes
  // implicitly via the new URL).
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
