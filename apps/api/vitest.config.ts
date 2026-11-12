import { defineConfig } from 'vitest/config';

// Isolated PGlite instance for tests: same PostgreSQL engine, separate data dir.
// Secrets are intentionally NOT committed: dev/test mode generates them once into
// the git-ignored .data/dev-secrets.json.
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 240_000,
    env: {
      NODE_ENV: 'test',
      DB_MODE: 'pglite',
      PGLITE_DIR: '.data/test-pglite',
      SEED_DEMO: 'true',
      COOKIE_SECURE: 'false',
      WEB_DIR: '.data/does-not-exist',
      RATE_LIMIT_MAX: '10000',
      AUTH_RATE_LIMIT_MAX: '50',
    },
  },
});
