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
      // Production reaches the legal-index via a Vercel Edge Function
      // at /api/legal-index (api/legal-index.js). Vite doesn't run
      // Vercel functions — instead, dev relies on the in-tree copy at
      // web/public/data/legal-index.json which legalIndex.js tries
      // first. If a developer wants to test the production path
      // locally without an in-tree copy, run `vercel dev` instead of
      // `npm run dev`.
    },
  },
});
