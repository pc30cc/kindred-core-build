/**
 * Startup and health checks for the database connection.
 */
import { dataDriver, directPool } from './index.js';
import { databaseMode, ignoredSupabaseVars, type DatabaseMode } from './mode.js';
import { databaseSettings } from './pool.js';

export interface DatabaseStatus {
  driver: 'postgres' | 'supabase-rest';
  /** Whether any Supabase service may be used (DATABASE_MODE). */
  mode: DatabaseMode;
  ok: boolean;
  /** postgres only: server major version, the role queries run as, round-trip ms. */
  serverVersion?: string;
  role?: string;
  latencyMs?: number;
  error?: string;
}

/** Host and database name of DATABASE_URL — never the credentials. */
export function describeDatabaseTarget(env: NodeJS.ProcessEnv = process.env): string {
  if (dataDriver(env) !== 'postgres') {
    const url = env.SUPABASE_URL ?? '';
    try {
      return `supabase-rest ${new URL(url).host}`;
    } catch {
      return 'supabase-rest (SUPABASE_URL unset)';
    }
  }
  const settings = databaseSettings(env)!;
  const u = new URL(settings.connectionString);
  return `postgres ${u.hostname}:${u.port || '5432'}${u.pathname} (ssl ${settings.ssl ? 'on' : 'off'})`;
}

export async function databaseStatus(): Promise<DatabaseStatus> {
  const mode = databaseMode();
  if (dataDriver() !== 'postgres') return { driver: 'supabase-rest', mode, ok: true };
  const started = Date.now();
  try {
    const { rows } = await directPool().query<{ version: string; role: string }>(
      `SELECT current_setting('server_version_num') AS version, current_user AS role`,
    );
    return {
      driver: 'postgres',
      mode,
      ok: true,
      serverVersion: String(Math.floor(Number(rows[0].version) / 10000)),
      role: rows[0].role,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { driver: 'postgres', mode, ok: false, error: (err as Error).message };
  }
}

/**
 * Waits for the database at boot. A container started next to its database
 * (docker compose, Coolify) can come up first; this gives it time instead of
 * failing on the first query, and turns a wrong DATABASE_URL into one clear
 * line instead of a stack trace from whichever query ran first.
 */
export async function waitForDatabase(label: string, attempts = Number(process.env.DATABASE_CONNECT_ATTEMPTS || 30)): Promise<void> {
  if (dataDriver() !== 'postgres') return;
  const target = describeDatabaseTarget();
  for (let i = 1; ; i++) {
    const status = await databaseStatus();
    if (status.ok) {
      console.log(`[${label}] database: ${target}, PostgreSQL ${status.serverVersion}, role ${status.role}, mode ${status.mode}`);
      const ignored = ignoredSupabaseVars();
      if (ignored.length) {
        console.warn(
          `[${label}] DATABASE_MODE=postgres-only: ignoring ${ignored.join(', ')} — no Supabase service is used. ` +
            'Remove them, or set DATABASE_MODE=postgres+supabase-services to use the optional Supabase Realtime.',
        );
      }
      if (Number(status.serverVersion) < 15) {
        console.warn(`[${label}] PostgreSQL ${status.serverVersion} is older than 15, the oldest version the migrations are tested on`);
      }
      return;
    }
    if (i >= attempts) {
      throw new Error(`[${label}] cannot reach the database (${target}): ${status.error}`);
    }
    console.warn(`[${label}] waiting for the database (${target}): ${status.error} — attempt ${i}/${attempts}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
