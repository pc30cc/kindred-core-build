// @vitest-environment node
/**
 * Acceptance: the product's main paths with DATABASE_URL and nothing of
 * Supabase — DATABASE_MODE=postgres-only, the old SUPABASE_URL and keys still
 * set (they must change nothing), and every outbound request to anything but
 * this machine refused and recorded. The database is reached directly; the
 * plan policy is the real one (SELF_HOST_BILLING_MODE is NOT unlimited).
 *
 * A database of its own is built by the whole chain, 251 included. The real
 * Express routers run on it through the real data layer (server/db: the
 * in-process PostgREST engine over a pg pool) and the real loadConfig(). The
 * only stand-ins are what lies outside this repository: e-mail delivery
 * (captured), Centrifugo's HTTP API and the AI runtime's embedding endpoint
 * (both a local fake server that records what reaches it). Files go to the
 * local-disk storage provider.
 *
 * The plan policy is production's: trial signups, production's trial limits.
 *
 *   login and session · workspace creation under the plan's limit · chat with
 *   realtime over Centrifugo · an AI-credit invoice · a file upload read back
 *   · AI knowledge retrieval over pgvector embeddings · the invitations
 *   worker · no request leaving the machine.
 *
 * Driven by TEST_DATABASE_URL on a server with pgvector; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

interface CapturedEmail { to: string; templateSlug?: string; actionUrl: string | null }
interface EmailRequest { to: string; templateSlug?: string; templateData?: { action_url?: string } }
const captured = vi.hoisted(() => ({ emails: [] as CapturedEmail[] }));

// Outbound e-mail is the one service stubbed outright: its content is read back.
vi.mock('../../../server/services/email/index.js', () => {
  const send = async (_config: unknown, req: EmailRequest) => {
    captured.emails.push({ to: req.to, templateSlug: req.templateSlug, actionUrl: req.templateData?.action_url ?? null });
    return { success: true, provider: 'test-capture', id: `m-${captured.emails.length}` };
  };
  return { sendEmail: send, sendPlatformEmail: send };
});
// The per-IP auth limiter is a process-wide singleton; this file makes more
// auth calls a minute than it allows. Its own coverage lives elsewhere.
vi.mock('../../../server/middleware/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/middleware/security.js')>();
  return { ...actual, authRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next() };
});

// Billing v2's customer mutations answer 410 while v2 is retired
// (server/middleware/billingV2Retired.ts); this suite covers them with v2 on.
vi.mock('../../../shared/billingMode.js', () => ({ LEGACY_BILLING_ENABLED: true }));

// ── nothing may leave this machine ─────────────────────────────────────────
const egress = { blocked: [] as string[] };
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function guard(target: string): void {
  let host = 'localhost';
  try { host = new URL(target).hostname; } catch { /* a bare path: local */ }
  if (!LOCAL_HOSTS.has(host)) {
    egress.blocked.push(target);
    throw new Error(`outbound request refused by the test: ${host}`);
  }
}
type RequestFn = typeof http.request;
const originals = { fetch: globalThis.fetch, http: http.request, https: https.request, httpGet: http.get, httpsGet: https.get };
function targetOf(arg: unknown): string {
  if (typeof arg === 'string' || arg instanceof URL) return String(arg);
  const o = (arg ?? {}) as { protocol?: string; hostname?: string; host?: string; path?: string };
  return `${o.protocol ?? 'http:'}//${o.hostname ?? o.host ?? 'localhost'}${o.path ?? '/'}`;
}
function guardRequest(original: RequestFn): RequestFn {
  return ((...args: Parameters<RequestFn>) => {
    guard(targetOf(args[0]));
    return original(...args);
  }) as RequestFn;
}
function installEgressGuard(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    guard(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return originals.fetch(input, init);
  }) as typeof fetch;
  http.request = guardRequest(originals.http);
  https.request = guardRequest(originals.https);
  http.get = guardRequest(originals.httpGet);
  https.get = guardRequest(originals.httpsGet);
}
function removeEgressGuard(): void {
  globalThis.fetch = originals.fetch;
  http.request = originals.http;
  https.request = originals.https;
  http.get = originals.httpGet;
  https.get = originals.httpsGet;
}

// ── the fake services outside this repository ─────────────────────────────
interface Recorded { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
const outside = { requests: [] as Recorded[], queryVector: [] as number[] };
const DIM = 1536;
const unit = (i: number): number[] => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));

suite('postgres-only acceptance: the main paths with nothing of Supabase', () => {
  let chain: FullChainDatabase;
  let app: http.Server;
  let fake: http.Server;
  let base = '';
  let fakeBase = '';
  let storageDir = '';
  let config: import('../../../server/config.js').ServerConfig;
  const SECRET = 'signing-secret-for-this-test-only-0123456789';
  const ORIGIN = 'http://127.0.0.1';
  const state = { cookie: '', userId: '', workspaceId: '', accountId: '' };

  function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; raw: string; setCookie: string[] }> {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      const req = originals.http(`${base}${path}`, {
        method,
        headers: {
          ...(state.cookie ? { cookie: state.cookie } : {}),
          ...(method !== 'GET' ? { origin: ORIGIN } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(raw || '{}'); } catch { json = {}; }
          resolve({ status: res.statusCode ?? 0, json, raw, setCookie: (res.headers['set-cookie'] as string[]) ?? [] });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `pgonly_acceptance_${Date.now()}`);
    const vec = await chain.db.query(`SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'public.ai_knowledge_chunks'::regclass AND attname = 'embedding' AND NOT attisdropped`);
    if (vec.rows[0].n !== 1) throw new Error('this suite needs a server with pgvector (ai_knowledge_chunks.embedding)');

    // The fake Centrifugo API and AI runtime.
    fake = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        outside.requests.push({ path: req.url ?? '', headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/internal/ai/embed') {
          const texts = (body.texts as string[] | undefined) ?? [];
          res.end(JSON.stringify({ ok: true, vectors: texts.map(() => outside.queryVector) }));
          return;
        }
        res.end(JSON.stringify({ result: {} }));
      });
    }).listen(0, '127.0.0.1');
    await new Promise<void>((r) => fake.once('listening', () => r()));
    fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    storageDir = mkdtempSync(join(tmpdir(), 'pgonly-storage-'));

    // The environment of an install that moved: DATABASE_URL, a signing
    // secret, and the old Supabase variables still lying around.
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: SECRET,
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: ORIGIN,
      APP_BASE_URL: 'http://127.0.0.1:5173',
      AI_RUNTIME_URL: fakeBase,
      AI_RUNTIME_INTERNAL_SECRET: 'ai-runtime-secret-for-this-test-0123456789',
      INVITATION_LINK_SECRET: 'test-invitation-link-secret-value-32b!!',
      INVITATION_OTP_PEPPER: 'test-invitation-otp-pepper-value-32bytes',
    });
    delete process.env.DATABASE_MODE;
    delete process.env.SELF_HOST_BILLING_MODE;

    // The plan policy production runs (read there, read-only, 2026-10-05): a
    // signup starts on the trial plan, which allows one workspace, two agents
    // and 1 GB. Plans are data — a move brings production's rows — so the
    // seeded rows are set to production's values rather than tested as seeded.
    await chain.db.query(`UPDATE public.platform_settings SET signup_default_plan_mode = 'trial'`);
    // This is WebYar's install, the Iranian edition (shared/edition.ts): its
    // Rial wallet and AI-credit top-ups exist only there.
    await chain.db.query(`UPDATE public.platform_settings SET region_mode = 'iran'`);
    await chain.db.query(
      `UPDATE public.billing_plans SET limits = coalesce(limits, '{}'::jsonb) || '{"max_workspaces": 1, "max_agents": 2, "storage_gb": 1}'::jsonb
        WHERE slug = 'trial'`,
    );
    await chain.db.query(
      `INSERT INTO public.app_runtime_config (key, value) VALUES
         ('default_realtime_provider', $1::jsonb),
         ('default_storage_provider', $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({ vendor: 'centrifugo', enabled: true, centrifugo: { ws_url: 'ws://127.0.0.1:1/connection/websocket', api_url: `${fakeBase}/centrifugo/api`, api_key: 'centrifugo-api-key', token_hmac_secret: 'centrifugo-token-secret-0123456789' } }),
        JSON.stringify({ provider_name: 'local', config: { local_path: storageDir, public_url: 'http://127.0.0.1:1/files' } }),
      ],
    );

    installEgressGuard();
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig();
    const routes = {
      auth: (await import('../../../server/routes/auth.js')).authSecurityRouter,
      authEmail: (await import('../../../server/routes/auth-email.js')).authEmailRouter,
      workspaces: (await import('../../../server/routes/workspaces.js')).workspacesRouter,
      invitations: (await import('../../../server/routes/workspaceInvitations.js')).workspaceInvitationsRouter,
      departments: (await import('../../../server/routes/workspaceDepartments.js')).workspaceDepartmentsRouter,
      billing: (await import('../../../server/routes/billingCustomer.js')).billingCustomerRouter,
      realtime: (await import('../../../server/routes/realtime.js')).realtimeRouter,
      conversations: (await import('../../../server/routes/conversations.js')).conversationsRouter,
      attachments: (await import('../../../server/routes/conversationAttachments.js')).conversationAttachmentsRouter,
    };
    const server = express();
    server.use((req, _res, next) => { (req as unknown as { serverConfig: typeof config }).serverConfig = config; next(); });
    server.use(express.json({ limit: '5mb' }));
    server.use(cookieParser());
    server.use('/api/auth', routes.auth);
    server.use('/api/auth-email', routes.authEmail);
    server.use('/api/workspaces', routes.workspaces);
    server.use('/api/workspace-invitations', routes.invitations);
    server.use('/api/workspace-departments', routes.departments);
    server.use('/api/billing', routes.billing);
    server.use('/api/realtime', routes.realtime);
    server.use('/api/conversations', routes.conversations);
    server.use('/api/conversation-attachments', routes.attachments);
    app = server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => app.once('listening', () => r()));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  }, 600_000);

  afterAll(async () => {
    removeEgressGuard();
    await new Promise<void>((r) => (app ? app.close(() => r()) : r()));
    await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  it('is postgres-only: no Supabase service, whatever SUPABASE_* is left set', async () => {
    const db = await import('../../../server/db/index.js');
    expect(db.databaseMode()).toBe('postgres-only');
    expect(db.ignoredSupabaseVars()).toEqual(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
    expect(db.supabaseServicesClient()).toBeNull();
    expect(config.supabaseUrl).toBe(db.DIRECT_DATABASE_BASE_URL);
    expect(config.supabaseAnonKey).toBe('');
    expect(config.selfHostBillingUnlimited).toBe(false);
    // The browser is offered no Supabase Realtime.
    expect((await call('GET', '/api/realtime/supabase-config')).status).toBe(404);
  });

  it('signs up, verifies the e-mail, logs in, and the session cookie identifies the user', async () => {
    const email = `owner-${Date.now()}@example.test`;
    const signup = await call('POST', '/api/auth/signup', { email, password: 'correct horse battery 9', fullName: 'Owner' });
    expect(signup.status).toBe(200);
    const link = captured.emails.find((e) => e.to === email && e.templateSlug === 'email_verify')?.actionUrl;
    expect(link).toBeTruthy();
    const verify = await call('POST', '/api/auth-email/verify-email', { token: new URL(link!).searchParams.get('token') });
    expect(verify.status).toBe(200);
    const login = await call('POST', '/api/auth/login', { email, password: 'correct horse battery 9' });
    expect(login.status).toBe(200);
    state.cookie = login.setCookie.find((c) => c.startsWith('gs_session='))!.split(';')[0];
    const session = await call('GET', '/api/auth/session');
    expect(session.status).toBe(200);
    const user = session.json.user as { id: string; email: string; emailVerified: boolean };
    expect(user).toMatchObject({ email, emailVerified: true });
    state.userId = user.id;
    const rows = await chain.db.query('SELECT count(*)::int AS n FROM public.auth_sessions WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
    expect(rows.rows[0].n).toBeGreaterThan(0);
  });

  it('creates the first workspace on the trial plan, which refuses a second until an override allows it', async () => {
    expect((await call('POST', '/api/workspaces/provision-account')).status).toBe(200);
    const list = await call('GET', '/api/workspaces');
    const workspaces = list.json.workspaces as Array<{ id: string }>;
    expect(workspaces).toHaveLength(1);
    state.workspaceId = workspaces[0].id;
    state.accountId = ((await call('GET', '/api/workspaces/account')).json.account as { id: string }).id;
    const sub = await chain.db.query(
      `SELECT s.status, p.slug FROM public.workspace_subscriptions s JOIN public.billing_plans p ON p.id = s.plan_id WHERE s.workspace_id = $1`,
      [state.workspaceId],
    );
    expect(sub.rows).toEqual([{ status: 'trialing', slug: 'trial' }]);

    const refused = await call('POST', '/api/workspaces', { accountId: state.accountId, name: 'Second' });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ error: 'workspace_limit_reached', feature: 'max_workspaces', limit: 1, plan: 'trial' });

    await chain.db.query(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_workspaces', 2)`, [state.workspaceId]);
    const { clearEntitlementCache } = await import('../../../server/middleware/featureGating.js');
    clearEntitlementCache();
    const allowed = await call('POST', '/api/workspaces', { accountId: state.accountId, name: 'Second' });
    expect(allowed.status).toBe(200);
    expect((await call('GET', '/api/workspaces')).json.workspaces).toHaveLength(2);
  });

  it('an operator message is stored, counted, and published through Centrifugo', async () => {
    const conv = await chain.db.query(`INSERT INTO public.conversations (workspace_id) VALUES ($1) RETURNING id`, [state.workspaceId]);
    const conversationId = conv.rows[0].id as string;
    const before = outside.requests.length;
    const sent = await call('POST', '/api/conversations/send-message', { conversation_id: conversationId, workspace_id: state.workspaceId, body: 'سلام، چطور کمک کنم؟' });
    expect(sent.status).toBe(200);
    expect(sent.json.realtime).toMatchObject({ published: true });
    const stored = await chain.db.query(`SELECT sender_type, sender_id, body FROM public.conversation_messages WHERE conversation_id = $1`, [conversationId]);
    expect(stored.rows).toEqual([{ sender_type: 'agent', sender_id: state.userId, body: 'سلام، چطور کمک کنم؟' }]);
    const counted = await chain.db.query(`SELECT coalesce(sum(messages_count), 0)::int AS n FROM public.workspace_usage_counters WHERE workspace_id = $1`, [state.workspaceId]);
    expect(counted.rows[0].n).toBeGreaterThan(0);

    const published = outside.requests.slice(before).filter((r) => r.path === '/centrifugo/api');
    expect(published.length).toBeGreaterThan(0);
    expect(published[0].headers['x-api-key']).toBe('centrifugo-api-key');
    const channels = published.map((r) => (r.body.params as { channel: string }).channel);
    expect(channels).toContain(`ws:${state.workspaceId}:conv:${conversationId}`);
  });

  it('issues an AI-credit invoice within the top-up limits and refuses one outside them', async () => {
    const ok = await call('POST', `/api/billing/workspaces/${state.workspaceId}/ai-credit/invoice`, { amountIrr: 1_000_000 });
    expect(ok.status).toBe(200);
    const invoice = await chain.db.query(`SELECT status, invoice_type, total_irr FROM public.billing_invoices WHERE id = $1`, [ok.json.invoiceId]);
    expect(invoice.rows[0]).toMatchObject({ status: 'open', invoice_type: 'ai_credit_purchase' });
    expect(Number(invoice.rows[0].total_irr)).toBeGreaterThanOrEqual(1_000_000);
    const lines = await chain.db.query(`SELECT count(*)::int AS n FROM public.billing_invoice_lines WHERE invoice_id = $1 AND line_type = 'ai_credit'`, [ok.json.invoiceId]);
    expect(lines.rows[0].n).toBe(1);
    const tooSmall = await call('POST', `/api/billing/workspaces/${state.workspaceId}/ai-credit/invoice`, { amountIrr: 10 });
    expect(tooSmall.status).toBe(400);
  });

  it('uploads a file to local storage, under the plan\'s storage limit, and reads it back', async () => {
    const content = Buffer.from('hello from a database-only install\n');
    const init = await call('POST', '/api/conversation-attachments/init', { workspace_id: state.workspaceId, file_name: 'note.txt', mime_type: 'text/plain', size_bytes: content.length });
    expect(init.status).toBe(200);
    const id = init.json.attachment_id as string;
    const up = await call('POST', `/api/conversation-attachments/${id}/upload`, { workspace_id: state.workspaceId, data: content.toString('base64') });
    expect(up.status).toBe(200);
    const row = await chain.db.query(`SELECT status FROM public.conversation_attachments WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe('uploaded');
    const back = await call('GET', `/api/conversation-attachments/${id}/file`);
    expect(back.status).toBe(200);
    expect(back.raw).toBe(content.toString());
    const usage = await chain.db.query(`SELECT count(*)::int AS n FROM public.storage_usage_logs WHERE workspace_id = $1`, [state.workspaceId]);
    expect(usage.rows[0].n).toBeGreaterThan(0);
  });

  it('retrieves AI knowledge over pgvector embeddings, nearest first', async () => {
    await chain.db.query(
      `INSERT INTO public.provider_configs (workspace_id, provider_type, provider_name, config, is_active)
       VALUES ($1, 'ai', 'openai', '{"api_key": "not-a-real-key"}', true)`,
      [state.workspaceId],
    );
    const chunks = [
      { id: 'kb-shipping', content: 'Shipping takes three to five working days.', vector: unit(0) },
      { id: 'kb-refunds', content: 'Refunds are paid back within ten days of the return.', vector: unit(1) },
      { id: 'kb-hours', content: 'Support is open from nine to five.', vector: unit(2) },
    ];
    for (const c of chunks) {
      await chain.db.query(
        `INSERT INTO public.ai_knowledge_chunks (workspace_id, source_type, source_id, title, content, content_hash, status, embedding)
         VALUES ($1, 'business_profile', $2, $2, $3, md5($3), 'active', $4::vector)`,
        [state.workspaceId, c.id, c.content, `[${c.vector.join(',')}]`],
      );
    }
    // The question lies closest to the refunds chunk, a little toward hours.
    outside.queryVector = Array.from({ length: DIM }, (_, k) => (k === 1 ? 0.9 : k === 2 ? 0.3 : 0));
    const { retrieveHybridSources } = await import('../../../server/services/ai-agent/retrievalHybrid.js');
    const result = await retrieveHybridSources(config, {
      workspaceId: state.workspaceId,
      originalMessage: 'When do I get my money back?',
      retrievalQuery: 'When do I get my money back?',
      responseLanguage: 'en',
      limit: 3,
    });
    expect(result.vectorUsed).toBe(true);
    const byVector = [...result.sources].sort((a, b) => b.vector_score - a.vector_score);
    expect(byVector[0].source_id).toBe('kb-refunds');
    expect(byVector[0].vector_score).toBeGreaterThan(byVector[byVector.length - 1].vector_score);
    expect(outside.requests.some((r) => r.path === '/internal/ai/embed')).toBe(true);
  });

  it('the invitations worker delivers a queued invitation in one pass', async () => {
    // An agent is a customer-facing member and joins at least one department
    // (workspace_invitations_v2_role_pairing_chk, create_workspace_invitation_v2).
    const department = await call('POST', `/api/workspace-departments/${state.workspaceId}`, { name: 'Support' });
    expect(department.status).toBe(201);
    const email = `agent-${Date.now()}@example.test`;
    const invited = await call('POST', '/api/workspace-invitations', {
      workspaceId: state.workspaceId, firstName: 'Sara', lastName: 'Agent', email,
      memberType: 'customer_facing', role: 'agent', departmentIds: [(department.json.department as { id: string }).id],
      requestId: randomUUID(), locale: 'en',
    });
    expect(invited.status).toBe(201);
    const queued = await chain.db.query(`SELECT count(*)::int AS n FROM public.workspace_invitation_jobs WHERE status IN ('queued', 'retrying')`);
    expect(queued.rows[0].n).toBeGreaterThan(0);
    const { drainInvitationJobs } = await import('../../../server/services/invitations/worker.js');
    await drainInvitationJobs(config);
    expect(captured.emails.some((e) => e.to === email && e.templateSlug === 'invite_member')).toBe(true);
    const delivered = await chain.db.query(`SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries d JOIN public.workspace_invitations i ON i.id = d.invitation_id WHERE i.workspace_id = $1`, [state.workspaceId]);
    expect(delivered.rows[0].n).toBeGreaterThan(0);
  });

  it('no request left this machine — nothing to Supabase or anywhere else', () => {
    expect(egress.blocked).toEqual([]);
  });
});
