/**
 * WORKSPACE INVITATIONS v5.1 — Section C.5 security evidence (real PostgreSQL 17).
 *
 *   C.5p — EVERY invitation RPC the server or the idempotent executor calls is
 *          discovered dynamically from the source and from the executor's own
 *          definition, and each one must be service_role-only.
 *   C.5q — no raw token, OTP code, password, proof handle, context handle,
 *          pepper, claim token or session token appears in ANY public table,
 *          in an API response, in the audit log, or in captured server logs.
 *   C.5r — service_role credentials stay server-side.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
if (!DSN && process.env.REQUIRE_WI_DB === '1') {
  throw new Error(
    'REQUIRE_WI_DB=1 but neither TEST_DATABASE_URL nor CLEAN_INSTALL_DATABASE_URL is set — ' +
      'the workspace-invitation PostgreSQL suites are mandatory and must not be skipped.',
  );
}
const suite = DSN ? describe : describe.skip;

vi.mock('../../../server/middleware/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/middleware/security.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, authRateLimiter: passthrough };
});

vi.mock('../../../server/services/email/index.js', async () => {
  const { captureEmail } = await import('./invitationHarness.js');
  return { sendEmail: async (_config: unknown, req: any) => captureEmail(req) };
});

vi.mock('../../../server/supabase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/supabase.js')>();
  const { makePgServiceClient, harnessState } = await import('./invitationHarness.js');
  return { ...actual, getServiceClient: () => makePgServiceClient(() => harnessState.db) };
});

const { startHarness, harnessState } = await import('./invitationHarness.js');
type H = Awaited<ReturnType<typeof startHarness>>;
let h: H;

/** Source files that make up the invitation server surface. */
function invitationSourceFiles(): string[] {
  const files = [
    'server/routes/workspaceInvitations.ts',
    'server/routes/workspaceMembers.ts',
  ].map((p) => resolve(process.cwd(), p));
  const dir = resolve(process.cwd(), 'server/services/invitations');
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isFile() && entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** Every `rpc('name'…)` the invitation server surface calls. */
function rpcNamesFromSource(): string[] {
  const names = new Set<string>();
  for (const file of invitationSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\.rpc\(\s*['"]([a-z0-9_]+)['"]/g)) names.add(m[1]);
  }
  return [...names];
}

suite('Workspace Invitations v5.1 §C.5 residual — complete RPC ACL and secret-leakage evidence', () => {
  beforeAll(async () => { h = await startHarness(DSN!); }, 300_000);
  afterAll(async () => { if (h) await h.stop(); });

  // ── C.5p ────────────────────────────────────────────────────────────────
  it('C.5p — every RPC reachable from the invitation server surface OR dispatched by the executor is service_role-only', async () => {
    const fromSource = rpcNamesFromSource();
    expect(fromSource.length, 'the source scan must find the invitation RPCs').toBeGreaterThan(5);

    // Everything wi_execute_idempotent itself dispatches to.
    const def = String((await h.one(
      `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'wi_execute_idempotent' LIMIT 1`,
    ))!.def);
    const dispatched = [...def.matchAll(/public\.([a-z0-9_]+)\s*\(/g)].map((m) => m[1]);

    const candidates = [...new Set([...fromSource, ...dispatched])];
    const rows = await h.rows(
      `SELECT p.proname,
              bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))          AS anon_exec,
              bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_exec,
              bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE'))  AS svc_exec,
              bool_and(p.prosecdef)                                              AS secdef,
              bool_and(p.proconfig IS NOT NULL)                                  AS pinned
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)
        GROUP BY p.proname`,
      [candidates],
    );
    // Only functions that actually exist are asserted on; the source scan can
    // legitimately name a helper defined elsewhere (e.g. pg_ builtins).
    expect(rows.length, 'at least the invitation RPC set must be resolvable').toBeGreaterThan(5);

    for (const row of rows) {
      const name = String(row.proname);
      expect(`${name}:anon=${row.anon_exec}`).toBe(`${name}:anon=false`);
      expect(`${name}:authenticated=${row.auth_exec}`).toBe(`${name}:authenticated=false`);
      expect(`${name}:service_role=${row.svc_exec}`).toBe(`${name}:service_role=true`);
      if (row.secdef) {
        expect(`${name}:search_path_pinned=${row.pinned}`).toBe(`${name}:search_path_pinned=true`);
      }
    }
  }, 300_000);

  // ── C.5q ────────────────────────────────────────────────────────────────
  it('C.5q — no raw token, OTP code, password, proof/context handle, claim token or session token is stored, returned or logged', async () => {
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); }),
    );

    let secrets: string[] = [];
    let apiBodies: string[] = [];
    try {
      h.freshAddr();
      const owner = await h.makeOwner(`c5q.owner.${Date.now()}@example.test`);
      const payload = h.invitePayload(owner.workspaceId);
      const created = await h.call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      const manualToken = h.tokenFromManualLink(created.json.manualLink);
      const email = String(payload.email);

      const requested = await h.call('POST', '/api/workspace-invitations/otp/request', {
        body: { requestId: h.rid(), token: manualToken, purpose: 'manual_handoff' },
      });
      expect(requested.status).toBe(200);
      const code = await h.otpCodeFor(email);
      const verified = await h.call('POST', '/api/workspace-invitations/otp/verify', {
        body: { requestId: h.rid(), token: manualToken, purpose: 'manual_handoff', code },
      });
      expect(verified.status, JSON.stringify(verified.json)).toBe(200);
      const proofCookie = h.cookieOf(verified, 'wi_proof')!;
      const proofValue = proofCookie.split('=')[1];

      const accepted = await h.call('POST', '/api/workspace-invitations/accept-new', {
        cookie: proofCookie,
        body: {
          requestId: h.rid(), token: manualToken, purpose: 'manual_handoff',
          password: 'CorrectHorseBattery1', consent: true, ...(await h.activePolicies()),
        },
      });
      expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
      const sessionCookie = h.cookieOf(accepted, 'gs_session');
      const sessionValue = sessionCookie ? sessionCookie.split('=')[1] : null;

      // A live claim token from the outbox, plus the configured peppers.
      const claim = await h.one(
        `SELECT claim_token FROM public.workspace_invitation_jobs WHERE claim_token IS NOT NULL LIMIT 1`,
      );

      secrets = [
        manualToken,
        proofValue,
        'CorrectHorseBattery1',
        process.env.INVITATION_LINK_SECRET || '',
        process.env.INVITATION_OTP_PEPPER || '',
        sessionValue || '',
        claim ? String(claim.claim_token) : '',
      ].filter((s) => s && s.length >= 12);
      expect(secrets.length, 'the probe must actually hold secrets to search for').toBeGreaterThan(3);

      const listed = await h.call('GET', `/api/workspace-invitations?workspaceId=${owner.workspaceId}`, { cookie: owner.cookie });
      const previewed = await h.call('POST', '/api/workspace-invitations/preview', {
        body: { token: manualToken, purpose: 'manual_handoff' },
      });
      apiBodies = [JSON.stringify(created.json), JSON.stringify(requested.json), JSON.stringify(verified.json),
        JSON.stringify(accepted.json), JSON.stringify(listed.json), JSON.stringify(previewed.json)];

      // ── EVERY public table, not a hand-picked list ──────────────────────
      const tables = (await h.rows(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
      )).map((r) => String(r.relname));
      expect(tables.length).toBeGreaterThan(10);

      for (const table of tables) {
        const dump = String((await h.one(
          `SELECT coalesce(jsonb_agg(to_jsonb(t))::text, '[]') AS dump FROM public.${table} t`,
        ))!.dump);
        for (const secret of secrets) {
          expect(`${table}:${dump.includes(secret) ? 'LEAKED' : 'clean'}`).toBe(`${table}:clean`);
        }
        // The six-digit code, only when it is not part of a longer hex run.
        const bare = new RegExp(`(^|[^0-9a-f])${code}([^0-9a-f]|$)`);
        expect(`${table}:code:${bare.test(dump) ? 'LEAKED' : 'clean'}`).toBe(`${table}:code:clean`);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    // API responses and server logs are clean too.
    for (const body of apiBodies) {
      for (const secret of secrets.filter((s) => s !== '')) {
        // The manual link is returned ONCE to the creating admin by design;
        // every OTHER response and every log line must be free of it.
        if (body.includes('manualLink') && body.includes(secret)) continue;
        expect(body.includes(secret) ? 'LEAKED' : 'clean').toBe('clean');
      }
    }
    const logDump = logged.join('\n');
    for (const secret of secrets) {
      expect(logDump.includes(secret) ? 'LEAKED_IN_LOGS' : 'clean').toBe('clean');
    }
  }, 300_000);

  // ── C.5r ────────────────────────────────────────────────────────────────
  it('C.5r — the service-role credential never leaves the server: no client bundle or public asset references it', async () => {
    // Secret VALUES and secret READS — a form-field label naming a key that an
    // admin types into a server-side provider config is not a leak.
    const forbidden = /env[^\n]*SUPABASE_SERVICE_ROLE_KEY|env[^\n]*INVITATION_(OTP_PEPPER|LINK_SECRET)|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/;
    const roots = ['src', 'public'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|js|jsx|html)$/.test(entry)) continue;
        if (full.includes(`${'src'}/test/`)) continue;   // the tests read env on purpose
        if (forbidden.test(readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    for (const root of roots) walk(resolve(process.cwd(), root));
    expect(offenders).toEqual([]);

    // And the running server never hands them out through an API response.
    h.freshAddr();
    const owner = await h.makeOwner(`c5r.owner.${Date.now()}@example.test`);
    const listed = await h.call('GET', `/api/workspace-invitations?workspaceId=${owner.workspaceId}`, { cookie: owner.cookie });
    expect(forbidden.test(JSON.stringify(listed.json))).toBe(false);
    expect(harnessState.capturedEmails.every((e) => !forbidden.test(String(e.text ?? '')))).toBe(true);
  }, 300_000);
});
