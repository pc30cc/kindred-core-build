/**
 * The direct PostgreSQL connection: one pool per process, configured from
 * `DATABASE_URL` and a few optional `DATABASE_*` variables.
 *
 * Each pooled session is set up once, before its first query, to match what
 * PostgREST gives a request on Supabase:
 *   * `SET ROLE service_role` — the role the server used through PostgREST.
 *     It holds the grants every migration hands out and BYPASSRLS, which the
 *     FORCE ROW LEVEL SECURITY tables of 073 need. Skipped (with one warning)
 *     when the login role cannot assume it, unless DATABASE_ROLE named it
 *     explicitly — then the connection is refused instead.
 *   * `search_path = <exposed schemas>, extensions` — PostgREST's search path
 *     on Supabase (`extensions` is ignored where it does not exist).
 *   * `request.jwt.claims = {"role":"service_role"}` — so auth.role() answers
 *     as it did for the service-role key.
 *
 * These are session settings, so the URL must be a direct or session-mode
 * connection. Supabase's transaction pooler (port 6543) hands consecutive
 * statements to different backends; it is refused rather than half-working.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import type { Queryable } from './postgrest/types.js';

export interface DatabaseSettings {
  connectionString: string;
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
  poolMax: number;
  /** Role assumed per session; `null` = stay the login role. */
  role: string | null;
  /** True when DATABASE_ROLE named the role (refuse rather than skip). */
  roleExplicit: boolean;
  schemas: string[];
  maxRows: number;
  statementTimeoutMs: number;
  applicationName: string;
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|[a-z0-9_-]+)$/i;

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  return n;
}

/**
 * libpq's sslmode, applied the libpq way. node-postgres reads `sslmode` from
 * the URL with stricter semantics (require = verify-full), which fails on
 * Supabase's own CA — so it is taken out of the URL and applied here.
 */
function sslFor(url: URL, env: NodeJS.ProcessEnv): DatabaseSettings['ssl'] {
  const mode = (env.DATABASE_SSL?.trim() || url.searchParams.get('sslmode') || '').toLowerCase();
  const caSource = env.DATABASE_SSL_CA?.trim();
  const ca = caSource ? (caSource.includes('-----BEGIN') ? caSource : readFileSync(caSource, 'utf8')) : undefined;
  switch (mode) {
    case 'disable':
    case 'off':
    case 'false':
      return false;
    case 'verify-ca':
    case 'verify-full':
      return { rejectUnauthorized: true, ca };
    case 'require':
    case 'prefer':
    case 'allow':
    case 'no-verify':
    case 'true':
      return { rejectUnauthorized: false, ca };
    case '':
      // A container name or loopback address is a private network: no TLS
      // unless asked for. Anything else (Supabase, a managed Postgres) gets
      // TLS without certificate verification — libpq's `require`.
      return LOCAL_HOST.test(url.hostname) ? false : { rejectUnauthorized: false, ca };
    default:
      throw new Error(`DATABASE_SSL / sslmode "${mode}" is not one of disable, require, verify-ca, verify-full`);
  }
}

export function databaseSettings(env: NodeJS.ProcessEnv = process.env): DatabaseSettings | null {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL is not a valid postgres:// connection string');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must start with postgres:// or postgresql://');
  }
  if (url.port === '6543' && env.DATABASE_ALLOW_TRANSACTION_POOLER !== '1') {
    throw new Error(
      'DATABASE_URL points at a transaction-mode pooler (port 6543). The server keeps per-session settings ' +
        '(role, search_path), which a transaction pooler does not preserve. Use the direct connection or the ' +
        'session pooler (port 5432) instead.',
    );
  }
  const ssl = sslFor(url, env);
  for (const k of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(k);

  const roleEnv = env.DATABASE_ROLE?.trim();
  const role = roleEnv === undefined || roleEnv === '' ? 'service_role' : roleEnv.toLowerCase() === 'none' ? null : roleEnv;
  return {
    connectionString: url.toString(),
    ssl,
    poolMax: Math.max(1, intEnv(env, 'DATABASE_POOL_MAX', 10)),
    role,
    roleExplicit: roleEnv !== undefined && roleEnv !== '' && role !== null,
    schemas: (env.DATABASE_SCHEMAS?.trim() || 'public').split(',').map((s) => s.trim()).filter(Boolean),
    maxRows: intEnv(env, 'DATABASE_MAX_ROWS', 1000),
    statementTimeoutMs: intEnv(env, 'DATABASE_STATEMENT_TIMEOUT_MS', 120_000),
    applicationName: env.DATABASE_APPLICATION_NAME?.trim() || 'webyar',
  };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class DatabasePool implements Queryable {
  readonly pool: pg.Pool;
  private readonly configured = new WeakSet<pg.PoolClient>();
  /** Decided on the first connection: the role to assume, or null. */
  private roleDecision: Promise<string | null> | null = null;

  constructor(readonly settings: DatabaseSettings) {
    this.pool = new pg.Pool({
      connectionString: settings.connectionString,
      ssl: settings.ssl,
      max: settings.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      statement_timeout: settings.statementTimeoutMs || undefined,
      application_name: settings.applicationName,
      keepAlive: true,
    });
    // An idle client that dies (server restart, network blip) is removed by
    // the pool; without a listener the error would crash the process.
    this.pool.on('error', (err) => {
      console.warn('[db] idle connection error:', err.message);
    });
  }

  private decideRole(client: pg.PoolClient): Promise<string | null> {
    if (!this.roleDecision) {
      const role = this.settings.role;
      this.roleDecision = (async () => {
        if (!role) return null;
        const { rows } = await client.query<{ present: boolean; member: boolean | null; login: string }>(
          `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS present,
                  CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1)
                       THEN pg_catalog.pg_has_role(current_user, $1, 'MEMBER') END AS member,
                  current_user AS login`,
          [role],
        );
        const r = rows[0];
        if (r.present && r.member) return role;
        const why = r.present
          ? `login role "${r.login}" is not a member of "${role}" (GRANT ${role} TO ${r.login})`
          : `role "${role}" does not exist (apply database/migrations, which create it)`;
        if (this.settings.roleExplicit) throw new Error(`DATABASE_ROLE: ${why}`);
        console.warn(`[db] running as "${r.login}" instead of "${role}": ${why}`);
        return null;
      })().catch((err) => {
        this.roleDecision = null;
        throw err;
      });
    }
    return this.roleDecision;
  }

  private async setup(client: pg.PoolClient): Promise<void> {
    const role = await this.decideRole(client);
    const path = [...this.settings.schemas, 'extensions'].map(quoteIdent).join(', ');
    const statements = [
      `SET search_path TO ${path}`,
      `SELECT pg_catalog.set_config('request.jwt.claims', ${quoteLiteral(JSON.stringify({ role: role ?? 'service_role' }))}, false)`,
    ];
    if (role) statements.push(`SET ROLE ${quoteIdent(role)}`);
    await client.query(statements.join('; '));
  }

  async query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      if (!this.configured.has(client)) {
        await this.setup(client);
        this.configured.add(client);
      }
      const res = await client.query(text, values);
      return { rows: res.rows as R[], rowCount: res.rowCount };
    } catch (err) {
      // A connection-level failure leaves the session unusable; a SQL error
      // (it has a SQLSTATE) does not.
      const code = (err as { code?: string }).code;
      if (!code || !/^[0-9A-Z]{5}$/.test(code) || code.startsWith('08') || !this.configured.has(client)) {
        broken = err as Error;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}
