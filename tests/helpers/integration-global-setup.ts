/**
 * Runs once before the integration suite: creates the test database if needed, wipes it, applies
 * every Drizzle migration and installs the pg-boss queue schema — the same steps as
 * `npm run db:migrate`, so the suite also verifies that migrations apply cleanly from scratch.
 */
import pg from 'pg';
import { applyTestEnv, assertTestDatabase, TEST_DATABASE_URL } from './test-env';

async function ensureDatabaseExists(url: string, name: string) {
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}

export default async function setup() {
  applyTestEnv();
  const name = assertTestDatabase(TEST_DATABASE_URL);
  await ensureDatabaseExists(TEST_DATABASE_URL, name);

  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.query('DROP SCHEMA IF EXISTS pgboss CASCADE');
  } finally {
    await client.end();
  }

  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const { closeDb, getDb } = await import('../../src/server/db/client');
  const { createBoss, ensureQueues } = await import('../../src/server/jobs/queue');

  await migrate(getDb(), { migrationsFolder: './drizzle' });
  const boss = createBoss({ worker: true });
  await boss.start();
  await ensureQueues(boss);
  await boss.stop({ graceful: false });
  await closeDb();
}
