import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run queries: the root database handle or an open transaction. */
export type Executor = Database | Transaction;

declare global {
  // Survive Next.js dev-server module reloads without leaking connection pools.
  var __slatePool: pg.Pool | undefined;
  var __slateDb: Database | undefined;
}

export function getPool(): pg.Pool {
  if (!globalThis.__slatePool) {
    const e = env();
    globalThis.__slatePool = new pg.Pool({
      connectionString: e.DATABASE_URL,
      max: e.DATABASE_POOL_MAX,
      ssl: e.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
      application_name: 'slate',
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Guard rail: no statement may hold locks indefinitely.
      statement_timeout: 30_000,
    });
    globalThis.__slatePool.on('error', (err) => {
      console.error('[db] idle client error', err);
    });
  }
  return globalThis.__slatePool;
}

export function getDb(): Database {
  if (!globalThis.__slateDb) {
    globalThis.__slateDb = drizzle(getPool(), { schema, casing: 'snake_case' });
  }
  return globalThis.__slateDb;
}

/**
 * Lazily-initialised database handle. Importing this module never opens a connection;
 * the pool is created on first use.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === 'function' ? value.bind(real) : value;
  },
});

export async function closeDb() {
  if (globalThis.__slatePool) {
    await globalThis.__slatePool.end();
    globalThis.__slatePool = undefined;
    globalThis.__slateDb = undefined;
  }
}

/** Postgres SQLSTATE codes we translate into domain errors. */
export const PG_ERRORS = {
  UNIQUE_VIOLATION: '23505',
  EXCLUSION_VIOLATION: '23P01',
  FOREIGN_KEY_VIOLATION: '23503',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  // Drizzle wraps driver errors; walk the cause chain.
  for (let i = 0; i < 5 && current; i++) {
    if (typeof current === 'object' && current !== null && 'code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = typeof current === 'object' && current !== null && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export function pgConstraintName(err: unknown): string | undefined {
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i++) {
    if (typeof current === 'object' && current !== null && 'constraint' in current && typeof current.constraint === 'string') {
      return current.constraint;
    }
    current = typeof current === 'object' && current !== null && 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
