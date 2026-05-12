import { defineConfig } from 'vite';

export default defineConfig({
  // Plain static site, no framework plugins needed.
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
  build: {
    target: 'es2020',
    // MapLibre is fundamentally ~800 kB minified (~217 kB gzipped) and
    // there's no good way to split it further without dynamic imports
    // that defer the map render. Lift the warning ceiling so the
    // legitimate vendor chunk doesn't trip the noise; everything else
    // is comfortably under 500 kB.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Split heavy third-party deps into named vendor chunks so a
        // change in our app code doesn't bust their browser cache, and
        // the warning ceiling on the main bundle drops back under
        // 500 kB. maplibre is by far the heaviest (~700 kB minified);
        // the @turf/* helpers + papaparse together are ~150 kB.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('maplibre-gl')) return 'maplibre';
          // mapbox-gl-draw imports several @turf/* helpers; keep them
          // co-located in the turf chunk so we don't create a
          // vendor → turf → vendor cycle.
          if (id.includes('@turf/') || id.includes('mapbox-gl-draw')) return 'turf';
          if (id.includes('papaparse'))   return 'papaparse';
          // Everything else stays in the default vendor chunk.
          return 'vendor';
        },
      },
    },
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
