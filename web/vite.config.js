import { defineConfig } from 'vite';

export default defineConfig({
  // Plain static site, no framework plugins needed.
  build: {
    target: 'es2020',
  },
  server: {
    // Proxy the Manitoba Contaminated Sites Registry CSV in dev — the
    // origin doesn't send Access-Control-Allow-Origin, so a direct browser
    // fetch fails CORS. Vercel's vercel.json rewrites handle this in
    // production. The path matches the production rewrite source.
    proxy: {
      '/proxy/contam-sites.csv': {
        target: 'https://manitoba.ca',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/proxy\/contam-sites\.csv$/, '/sd/waste_management/contaminated_sites/registry/cs-data.csv'),
      },
      // Mirrors the production rewrite in vercel.json so the dev
      // server can also proxy the GitHub Release-hosted legal-index.
      // The in-tree copy in web/public/data/legal-index.json is
      // tried first by legalIndex.js, so this proxy only fires when
      // the local file is absent (e.g. on a fresh clone before
      // running r/build_legal_index.R).
      '/proxy/legal-index.json': {
        target: 'https://github.com',
        changeOrigin: true,
        followRedirects: true,
        rewrite: (p) => p.replace(
          /^\/proxy\/legal-index\.json$/,
          '/jayschellenberg/manitoba-opendata-parcelsearch/releases/download/data-2026-05-06/legal-index.json'
        ),
      },
    },
  },
});
