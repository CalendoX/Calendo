/**
 * Applies database migrations (Drizzle SQL migrations in /drizzle) and installs/updates the
 * pg-boss job-queue schema and queue definitions. Safe to run repeatedly; run on every deploy.
 */
import { config } from 'dotenv';
config({ quiet: true });

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from '../src/server/db/client';
import { createBoss, ensureQueues } from '../src/server/jobs/queue';

async function main() {
  console.log('→ Applying database migrations…');
  await migrate(getDb(), { migrationsFolder: './drizzle' });
  console.log('✓ Database schema up to date');

  console.log('→ Installing job queue schema…');
  const boss = createBoss({ worker: true });
  await boss.start();
  await ensureQueues(boss);
  await boss.stop({ graceful: false });
  console.log('✓ Job queues ready');

  await closeDb();
}

main().catch(async (err) => {
  console.error('✗ Migration failed:', err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
