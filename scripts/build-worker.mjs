// Bundles the server-side entry points that run outside Next.js into dist/ for production:
//   dist/worker.js   — background worker (src/worker/index.ts)
//   dist/migrate.js  — database + job-queue migrations (scripts/migrate.ts), so deploys don't need tsx
// Application code is bundled (resolving the @/ path alias); npm packages stay external.
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
};

await Promise.all([
  build({ ...shared, entryPoints: ['src/worker/index.ts'], outfile: 'dist/worker.js' }),
  build({ ...shared, entryPoints: ['scripts/migrate.ts'], outfile: 'dist/migrate.js' }),
]);
