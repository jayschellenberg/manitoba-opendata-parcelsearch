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
    },
  },
});
