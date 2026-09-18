/**
 * Drops ALL application data (public, drizzle and pgboss schemas). Development only.
 */
import { config } from 'dotenv';
config({ quiet: true });

import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '../src/server/db/client';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset the database with NODE_ENV=production');
  }
  const db = getDb();
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS pgboss CASCADE`);
  console.log('✓ Database reset');
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error('✗ Reset failed:', err);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
