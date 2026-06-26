import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// Resolve the build's git commit + timestamp once, baked in at build time so
// evidence exports (lib/provenance.js) can cite the exact app version that
// produced them. On Vercel, VERCEL_GIT_COMMIT_SHA is provided; locally we ask
// git. Either may be absent (shallow CI checkout, no git) — fall back to
// 'unknown' rather than failing the build.
function resolveCommit() {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
const APP_COMMIT = resolveCommit();
const APP_BUILD_TIME = new Date().toISOString();

export default defineConfig({
  // Plain static site. The only framework plugin is Tailwind v4's
  // Vite integration, which scans source files for utility classes
  // and emits the generated stylesheet for the `tailwind.css` entry.
  plugins: [tailwindcss()],
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
  // Escape hatch: VITE_SKIP_PUBLIC=1 disables the public/ → dist/ asset copy.
  // Useful for a code-only compile check on Windows/Dropbox, where copying the
  // large public/data tree into a Dropbox-synced dist/ can EPERM mid-sync.
  ...(process.env.VITE_SKIP_PUBLIC ? { publicDir: false } : {}),
  // Bake the build identity in for evidence-export provenance. Stringified so
  // they substitute as string literals; lib/provenance.js reads them through a
  // typeof guard so dev/test runs without `define` still work.
  define: {
    __APP_COMMIT__: JSON.stringify(APP_COMMIT),
    __APP_BUILD_TIME__: JSON.stringify(APP_BUILD_TIME),
  },
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
        // change in our app code doesn't bust their browser cache,
        // keeping the main bundle warning ceiling under 500 kB.
        // maplibre is by far the heaviest (~700 kB minified); the
        // @turf/* helpers add ~50 kB.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('maplibre-gl')) return 'maplibre';
          // mapbox-gl-draw imports several @turf/* helpers; keep them
          // co-located in the turf chunk so we don't create a
          // vendor → turf → vendor cycle.
          if (id.includes('@turf/') || id.includes('mapbox-gl-draw')) return 'turf';
          // Everything else stays in the default vendor chunk.
          return 'vendor';
        },
      },
    },
  },
  server: {
    // Honour an externally-assigned port. Tooling that launches the dev
    // server (e.g. the preview harness, which sets PORT when it needs to
    // dodge a busy 5173) expects Vite to bind exactly that port; Vite
    // doesn't read PORT on its own. strictPort makes it fail loudly
    // rather than silently auto-incrementing (which would desync the
    // harness's proxy). A plain `npm run dev` leaves PORT unset and keeps
    // Vite's default 5173 behaviour.
    ...(process.env.PORT
      ? { port: Number(process.env.PORT), strictPort: true }
      : {}),
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
