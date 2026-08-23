// Deliberately minimal. This is not a style linter — Vite already builds,
// the tests already run, and this project has stayed lean on tooling on
// purpose. It exists for one bug class that everything else misses.
//
// Rollup treats an unresolved identifier as a global rather than an error,
// so `npm run build` passes clean on code that throws ReferenceError the
// moment it runs. That happened here: a refactor moved rollDisplay() into
// lib/parcelLabelFields.js, map.js kept calling it without importing it,
// and the production build was green. Every Assessment Parcels popup
// would have thrown.
//
// So: no-undef and no-unused-vars, and nothing else. Add rules only when
// they catch something a green build and a green test run would not.

import globals from 'globals';

export default [
  {
    files: ['**/*.js'],
    ignores: ['dist/**', 'node_modules/**', 'public/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.worker,
        // Injected by vite.config.js `define` for the evidence-export
        // provenance stamp — real at runtime, invisible to static analysis.
        __APP_COMMIT__: 'readonly',
        __APP_BUILD_TIME__: 'readonly',
      },
    },
    linterOptions: {
      // An inline disable that no longer suppresses anything is a stale
      // claim about the code; surface it rather than let it rot.
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // The one rule this config exists for. Errors, so it fails the build.
      'no-undef': 'error',
      // Hygiene, not correctness — and the project carries a pre-existing
      // backlog of these (21 at the time this config was added). A warning
      // keeps them visible without making `npm test` red on day one, which
      // would just train everyone to skip the linter. Promote to 'error'
      // once the backlog is cleared.
      //
      // Args are frequently positional-only in callbacks and layer
      // handlers, so only flag unused *variables*, and let a leading
      // underscore mark a deliberate discard.
      'no-unused-vars': ['warn', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
    },
  },
  {
    // Build scripts and tests run in Node, not the browser.
    files: ['scripts/**/*.js', 'test/**/*.js', 'eslint.config.js', 'vite.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
