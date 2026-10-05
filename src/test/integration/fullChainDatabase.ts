/**
 * A database of its own, built by every file of database/migrations in byte
 * order — as scripts/migrate-database.sh builds one — on the server
 * TEST_DATABASE_URL points at. For suites that need the whole chain, 251
 * included, which the shared integration database cannot hold
 * (authStubSchema.ts re-applies 024+ for every suite).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

export interface FullChainDatabase {
  /** Connection string of the new database. */
  url: string;
  /** A client on it, for fixtures and assertions. */
  db: pg.Client;
  /** Drops the database. */
  drop(): Promise<void>;
}

export async function createFullChainDatabase(dsn: string, name: string): Promise<FullChainDatabase> {
  const adminUrl = new URL(dsn);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(dsn);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query('SET client_min_messages = warning');
  const dir = resolve(process.cwd(), 'database/migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await applyMigrationSql(db, readFileSync(resolve(dir, file), 'utf8'));
  }
  return {
    url: url.toString(),
    db,
    async drop() {
      await db.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
