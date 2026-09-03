/**
 * Boots a REAL authenticated stack for e2e/adminVerification.spec.ts:
 *
 *   Chromium → (proxy :8080, serves dist/ + forwards /api/* same-origin)
 *            → Express (server/index.ts, unmodified, real routes)
 *            → PostgREST (real, downloaded binary)
 *            → PostgreSQL (real, full self-host migration chain)
 *
 * No module is mocked. The only test-only substitutions are: a scratch
 * database instead of production Postgres, and PostgREST instead of a
 * hosted Supabase project — both wired the same way self-host operators
 * wire their own instance (see SELF_HOST_GUIDE.md), just pointed at a
 * throwaway local database.
 *
 * Identities are seeded directly into `auth_sessions`/`user_roles`/
 * `workspace_members` (not via the login UI) — the same shortcut every
 * other integration suite in this repo takes to get a valid session
 * without re-testing login itself, which has its own dedicated coverage.
 *
 * Writes e2e/harness/.runtime.json (gitignored) with ports + tokens for
 * the spec file to read, and PIDs for teardownFullStack.ts to kill.
 */
import { Pool } from 'pg';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { ensureAuthChainInstalled } from '../../src/test/integration/authStubSchema';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RUNTIME_FILE = path.join(__dirname, '.runtime.json');

const PG_SUPERUSER_DSN = process.env.E2E_PG_SUPERUSER_DSN || 'postgres://app_test:app_test@127.0.0.1:5432/postgres';
const DB_NAME = process.env.E2E_DB_NAME || 'gv_e2e_stack';
const JWT_SECRET = 'e2e-local-jwt-secret-not-for-production-use-only-32bytes+';

const POSTGREST_PORT = 34121;
const POSTGREST_GATEWAY_PORT = 34120;
const EXPRESS_PORT = 34122;
const PROXY_PORT = 8080;

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mintJwt(role: 'anon' | 'service_role'): string {
  return jwt.sign({ role, iss: 'e2e-local' }, JWT_SECRET, { expiresIn: '2h' });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastErr}`);
}

export default async function globalSetup() {
  // 1. Fresh scratch database.
  const admin = new Pool({ connectionString: PG_SUPERUSER_DSN, max: 1 });
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB_NAME]);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  const dbDsn = PG_SUPERUSER_DSN.replace(/\/[^/]*$/, `/${DB_NAME}`);
  const db = new Pool({ connectionString: dbDsn, max: 5 });

  // 2. Full self-host migration chain (000..100) + minimal auth-schema stub
  //    (ensureAuthChainInstalled also stubs `public.call_center_settings`,
  //    a genuine self-host/hosted parity gap — see authStubSchema.ts).
  await ensureAuthChainInstalled(db as any);

  // 2b. `public.is_ip_blocked(_ip)` — server/middleware/security.ts's
  // ipBlockMiddleware (mounted on every /api/* route) fails CLOSED (503)
  // when this RPC is missing, which it is: `ip_blocklist`/`is_ip_blocked`
  // only exist in supabase/migrations/ (the hosted-only mirror), never in
  // database/migrations/ (the self-host chain) — a genuine, pre-existing
  // self-host/hosted parity gap, out of scope to fix here. Stubbed the same
  // way authStubSchema.ts stubs the `auth` schema: additive, test-only,
  // scoped to this scratch database only.
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.ip_blocklist (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ip_address text NOT NULL,
      blocked_until timestamptz,
      created_at timestamptz DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION public.is_ip_blocked(_ip text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (
        SELECT 1 FROM public.ip_blocklist
        WHERE ip_address = _ip AND (blocked_until IS NULL OR blocked_until > now())
      )
    $$;
  `);

  // 2c. Baseline Supabase-standard grants. Real hosted Supabase (and the
  // `supabase/postgres` Docker image self-host operators actually run)
  // apply a platform-wide `GRANT ALL ... TO service_role` as part of THEIR
  // OWN image/project bootstrap, outside of any customer migration file —
  // this repo's migrations only ever add narrow, per-table grants on top of
  // that baseline (e.g. 016a's loop), which is why `service_role` has never
  // needed an explicit grant for a base table like `profiles` before now.
  // A bare vanilla-Postgres + bare-PostgREST test harness has no such
  // baseline, so replicate exactly what that image provides — `service_role`
  // already carries BYPASSRLS (000_selfhost_roles_bootstrap.sql), so this
  // grants no capability the role wasn't already designed to have.
  // Function EXECUTE privilege is separate from table grants. Several
  // gv_admin_* helpers (099/100) do `REVOKE ALL ... FROM PUBLIC` and are
  // meant to be reached only via another SECURITY DEFINER function's body
  // (which runs as the definer, not the caller) — except adminSettings.ts
  // calls a few of them (gv_admin_consumer_implemented,
  // gv_admin_deployment_allowlisted) directly over PostgREST as
  // service_role, which needs its own EXECUTE grant same as the table
  // case above. REVOKE ALL FROM PUBLIC never touches a role-specific grant
  // like this one, so applying it after the chain is equivalent to a real
  // Supabase project's platform-level baseline being present from the start.
  await db.query(`
    GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;
  `);

  // 3. Seed two real identities + a workspace the workspace-admin belongs to.
  const SUPER_ADMIN_ID = randomUUID();
  const WORKSPACE_ADMIN_ID = randomUUID();
  const WORKSPACE_ID = randomUUID();

  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,$2), ($3,$4)`, [
    SUPER_ADMIN_ID, 'super-admin@e2e.test',
    WORKSPACE_ADMIN_ID, 'workspace-admin@e2e.test',
  ]);
  await db.query(
    `INSERT INTO public.profiles (id, email, full_name) VALUES ($1,$2,$3), ($4,$5,$6)`,
    [SUPER_ADMIN_ID, 'super-admin@e2e.test', 'E2E Super Admin', WORKSPACE_ADMIN_ID, 'workspace-admin@e2e.test', 'E2E Workspace Admin'],
  );
  await db.query(
    `INSERT INTO public.user_credentials (user_id, email_verified_at) VALUES ($1, now()), ($2, now())`,
    [SUPER_ADMIN_ID, WORKSPACE_ADMIN_ID],
  );
  // Platform Super Admin: has_role(user, 'admin') = true.
  await db.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [SUPER_ADMIN_ID]);
  // Workspace owner/admin: a real workspace membership, but NOT a platform admin.
  await db.query(
    `INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'E2E Workspace', 'e2e-workspace', $2)`,
    [WORKSPACE_ID, WORKSPACE_ADMIN_ID],
  );
  await db.query(
    `INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [WORKSPACE_ID, WORKSPACE_ADMIN_ID],
  );

  // 4. Real opaque session tokens, hashed exactly like server/services/auth/sessions.ts.
  const superAdminToken = randomBytes(32).toString('base64url');
  const workspaceAdminToken = randomBytes(32).toString('base64url');
  const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.query(
    `INSERT INTO public.auth_sessions (user_id, email, token_hash, expires_at) VALUES ($1,$2,$3,$4), ($5,$6,$7,$8)`,
    [
      SUPER_ADMIN_ID, 'super-admin@e2e.test', sha256(superAdminToken), farFuture,
      WORKSPACE_ADMIN_ID, 'workspace-admin@e2e.test', sha256(workspaceAdminToken), farFuture,
    ],
  );

  await db.end();

  // 5. PostgREST, pointed at the scratch database, real HTTP wire protocol.
  const postgrestConfPath = path.join(__dirname, '.postgrest.conf');
  writeFileSync(
    postgrestConfPath,
    [
      `db-uri = "${dbDsn}"`,
      `db-schemas = "public"`,
      `db-anon-role = "anon"`,
      `jwt-secret = "${JWT_SECRET}"`,
      `server-host = "127.0.0.1"`,
      `server-port = ${POSTGREST_PORT}`,
      `log-level = "error"`,
    ].join('\n'),
  );
  const postgrestBin = process.env.E2E_POSTGREST_BIN || '/tmp/postgrest-bin/postgrest';
  const tsxBin = path.join(ROOT, 'node_modules/.bin/tsx');
  const postgrestProc = spawn(postgrestBin, [postgrestConfPath], { stdio: 'ignore', detached: true });
  postgrestProc.unref();
  await waitForHttp(`http://127.0.0.1:${POSTGREST_PORT}/`, 20_000);

  // 5b. `@supabase/supabase-js` always calls `${supabaseUrl}/rest/v1/...`,
  // a prefix real Supabase's Kong gateway strips before it ever reaches
  // PostgREST. Play that part here with a one-file reverse proxy.
  const gatewayProc = spawn(tsxBin, [path.join(__dirname, 'postgrestGateway.ts')], {
    cwd: ROOT,
    env: { ...process.env, E2E_GATEWAY_PORT: String(POSTGREST_GATEWAY_PORT), E2E_POSTGREST_PORT: String(POSTGREST_PORT) },
    stdio: 'ignore',
    detached: true,
  });
  gatewayProc.unref();
  await waitForHttp(`http://127.0.0.1:${POSTGREST_GATEWAY_PORT}/rest/v1/`, 10_000);

  // 6. The REAL, unmodified Express entrypoint — no mocked modules.
  const anonKey = mintJwt('anon');
  const serviceKey = mintJwt('service_role');
  const expressEnv = {
    ...process.env,
    PORT: String(EXPRESS_PORT),
    SUPABASE_URL: `http://127.0.0.1:${POSTGREST_GATEWAY_PORT}`,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    CORS_ORIGINS: `http://localhost:${PROXY_PORT}`,
    SELF_HOST_BILLING_MODE: 'unlimited',
    NODE_ENV: 'development',
  };
  const expressProc = spawn(tsxBin, [path.join(ROOT, 'server/index.ts')], {
    cwd: ROOT,
    env: expressEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  expressProc.unref();
  let expressLog = '';
  expressProc.stdout?.on('data', (d) => { expressLog += d.toString(); });
  expressProc.stderr?.on('data', (d) => { expressLog += d.toString(); });
  try {
    await waitForHttp(`http://127.0.0.1:${EXPRESS_PORT}/api/health`, 30_000);
  } catch (e) {
    throw new Error(`Express server failed to start. Log:\n${expressLog}\n\n${e}`);
  }

  // 6b. A same-origin build of the frontend, into dist-e2e/ (never dist/ —
  // that one bakes in this repo's own VITE_API_BASE_URL, a real external
  // origin, at build time). runtime-config.js's empty apiBaseUrl only
  // wins over the BUILD-TIME value when the build-time value was itself
  // empty (src/lib/apiBase.ts), so the build-time var must be unset here
  // too, or the browser calls the real external API directly instead of
  // this harness's own Express.
  if (process.env.E2E_SKIP_BUILD !== '1') {
    const distE2e = path.join(ROOT, 'dist-e2e');
    const build = spawnSync(process.execPath, ['scripts/build-smart-engine.mjs'], { cwd: ROOT, env: process.env, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('build-smart-engine.mjs failed');
    const viteBuild = spawnSync(
      path.join(ROOT, 'node_modules/.bin/vite'),
      ['build', '--outDir', distE2e],
      { cwd: ROOT, env: { ...process.env, VITE_API_BASE_URL: '' }, stdio: 'inherit' },
    );
    if (viteBuild.status !== 0) throw new Error('vite build (dist-e2e) failed');
  }

  // 7. Static (dist-e2e/) + same-origin /api proxy, matching the documented
  // self-host reverse-proxy topology (SELF_HOST_GUIDE.md) so the browser
  // never sees a cross-origin request and the real Lax session cookie works.
  const proxyServerPath = path.join(__dirname, 'proxyServer.ts');
  const proxyProc = spawn(tsxBin, [proxyServerPath], {
    cwd: ROOT,
    env: { ...process.env, E2E_PROXY_PORT: String(PROXY_PORT), E2E_EXPRESS_PORT: String(EXPRESS_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  proxyProc.unref();
  let proxyLog = '';
  proxyProc.stdout?.on('data', (d) => { proxyLog += d.toString(); });
  proxyProc.stderr?.on('data', (d) => { proxyLog += d.toString(); });
  try {
    await waitForHttp(`http://127.0.0.1:${PROXY_PORT}/`, 15_000);
  } catch (e) {
    throw new Error(`Proxy/static server failed to start. Log:\n${proxyLog}\n\n${e}`);
  }

  if (!existsSync(__dirname)) mkdirSync(__dirname, { recursive: true });
  writeFileSync(
    RUNTIME_FILE,
    JSON.stringify(
      {
        pids: { postgrest: postgrestProc.pid, gateway: gatewayProc.pid, express: expressProc.pid, proxy: proxyProc.pid },
        ports: { postgrest: POSTGREST_PORT, gateway: POSTGREST_GATEWAY_PORT, express: EXPRESS_PORT, proxy: PROXY_PORT },
        baseURL: `http://localhost:${PROXY_PORT}`,
        superAdmin: { userId: SUPER_ADMIN_ID, token: superAdminToken },
        workspaceAdmin: { userId: WORKSPACE_ADMIN_ID, token: workspaceAdminToken, workspaceId: WORKSPACE_ID },
      },
      null,
      2,
    ),
  );

  // eslint-disable-next-line no-console
  console.log(`[e2e-harness] ready: proxy=:${PROXY_PORT} express=:${EXPRESS_PORT} postgrest=:${POSTGREST_PORT}`);
}
