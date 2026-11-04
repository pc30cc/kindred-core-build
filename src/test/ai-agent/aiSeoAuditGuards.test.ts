/**
 * The AI Agent router's guards after the 2026-11-04 audit (AI and SEO),
 * through the real router:
 *   - ai-1: aiAgentPlatformGuard judges the workspace the handler acts on.
 *     A resource named by id decides (a named workspace must be its), and
 *     every workspace id the request names must be the same one, so a
 *     workspace whose plan has `ai_assistant` cannot open a handler that
 *     acts on another workspace's conversation or body;
 *   - ai-2: steering the AI in a conversation (ai-say-now, ai-reply-now,
 *     guidance) and reading its drafts (suggestions) is the Inbox's: staff
 *     roles without it are refused `inbox_not_allowed`, and a conversation
 *     the plan locked is refused as conversations.ts refuses it;
 *   - ai-8: suggest-reply is open to every Inbox role (shared/chatRoles.ts),
 *     not only owner/admin/agent.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const WS_PAID = '11111111-1111-4111-8111-111111111111'; // plan with ai_assistant
const WS_FREE = '22222222-2222-4222-8222-222222222222'; // plan without it
const CONV_PAID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CONV_FREE = 'bbbbbbbb-0000-4000-8000-00000000000b';
const CONV_LOCKED = 'cccccccc-0000-4000-8000-00000000000c';
const SOURCE_FREE = 'dddddddd-0000-4000-8000-00000000000d';
const GUIDANCE_FREE = 'eeeeeeee-0000-4000-8000-00000000000e';

const PLANS: Record<string, boolean> = { [WS_PAID]: true, [WS_FREE]: false };
let lockedConversations = new Set<string>();

type Row = Record<string, unknown>;
const TABLES: Record<string, Row[]> = {
  workspace_members: [
    { workspace_id: WS_PAID, user_id: 'owner-paid', role: 'owner', suspended_at: null },
    { workspace_id: WS_PAID, user_id: 'viewer-paid', role: 'viewer', suspended_at: null },
    { workspace_id: WS_PAID, user_id: 'billing-paid', role: 'billing', suspended_at: null },
    { workspace_id: WS_PAID, user_id: 'support-paid', role: 'support_agent', suspended_at: null },
    { workspace_id: WS_PAID, user_id: 'lead-paid', role: 'team_lead', suspended_at: null },
    { workspace_id: WS_FREE, user_id: 'owner-free', role: 'owner', suspended_at: null },
    { workspace_id: WS_PAID, user_id: 'owner-free', role: 'agent', suspended_at: null },
  ],
  ai_agent_settings: [],
  conversations: [
    { id: CONV_PAID, workspace_id: WS_PAID, created_at: '2026-11-01', updated_at: '2026-11-01' },
    { id: CONV_FREE, workspace_id: WS_FREE, created_at: '2026-11-01', updated_at: '2026-11-01' },
    { id: CONV_LOCKED, workspace_id: WS_PAID, created_at: '2020-01-01', updated_at: '2020-01-01' },
  ],
  ai_data_sources: [{ id: SOURCE_FREE, workspace_id: WS_FREE, source_type: 'website' }],
  ai_agent_guidance_rules: [],
  ai_agent_guidance: [{ id: GUIDANCE_FREE, workspace_id: WS_FREE, conversation_id: CONV_FREE }],
  ai_agent_suggestions: [],
  profiles: [],
};

function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => (TABLES[table] || []).filter((r) => filters.every((f) => f(r)));
      const q = {
        select: () => q,
        order: () => q,
        limit: () => q,
        neq: () => q,
        update: () => q,
        insert: () => q,
        eq: (col: string, val: unknown) => {
          filters.push((r) => String(r[col]).toLowerCase() === String(val).toLowerCase());
          return q;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return q;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null; count: number }) => unknown) =>
          resolve({ data: rows(), error: null, count: rows().length }),
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) =>
    token ? { sessionId: 's', userId: token, email: `${token}@example.com` } : null,
  verifyOriginForMutation: () => true,
  renewMobileSessionIfDue: async () => {},
}));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => false,
  logGateBypass: async () => {},
}));

vi.mock('../../../server/services/ai-agent/platformSettings.js', () => ({
  getPlatformAiAgentSettings: async () => ({
    ai_agent_enabled: true,
    customer_ai_agent_visible: true,
    operator_assist_enabled: true,
    websites_enabled: true,
    files_enabled: true,
    qna_enabled: true,
    learning_enabled: true,
    kb_enabled: true,
    auto_answer_enabled: true,
    metadata: {},
  }),
  updatePlatformAiAgentSettings: async () => {
    throw new Error('forbidden');
  },
  isPlatformSettingsLookupFailed: () => false,
}));

vi.mock('../../../server/middleware/featureGating.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/middleware/featureGating.js')>()),
  checkEntitlementFromDB: async () => ({ allowed: false, reason: 'registry_default' }),
  checkModuleAccess: async (_u: string, _k: string, workspaceId: string) =>
    ({ allowed: PLANS[workspaceId] === true, plan: PLANS[workspaceId] ? 'pro' : 'free' }),
}));

vi.mock('../../../server/services/billing/locks/state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => ({}),
}));
vi.mock('../../../server/services/billing/locks/predicates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/locks/predicates.js')>()),
  isMemberLocked: () => false,
}));

vi.mock('../../../server/services/contactChatLocks.js', () => ({
  conversationLockedNow: async (_c: unknown, _w: string, row: { created_at?: string }) => ({
    locked: [...lockedConversations].some((id) => TABLES.conversations.find((c) => c.id === id)?.created_at === row.created_at),
    state: {},
  }),
  conversationLockedBody: () => ({ error: 'conversation_locked', upgrade_required: true }),
}));

const sayNowCalls: Array<{ workspaceId: string; conversationId: string }> = [];
vi.mock('../../../server/services/ai-agent/sayNow.js', () => ({
  MAX_SAY_NOW_BODY: 2000,
  operatorSayNow: async (_config: unknown, args: { workspaceId: string; conversationId: string }) => {
    sayNowCalls.push({ workspaceId: args.workspaceId, conversationId: args.conversationId });
    return { ok: true, messageId: 'm1', text: 'hi', runId: 'r1' };
  },
}));

vi.mock('../../../server/services/observability/collector/index.js', () => ({
  getMonitoringCollector: () => ({ queryRealtimeCount: () => 0 }),
}));

const { aiAgentRouter } = await import('../../../server/routes/ai-agent/index.js');
const { e7_isOperator } = await import('../../../server/routes/ai-agent/operatorAssist.js');

const CONFIG = { supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' };

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig?: unknown }).serverConfig = CONFIG;
  next();
});
app.use(express.json());
app.use('/api/ai-agent', aiAgentRouter);
const server = http.createServer(app).listen(0);

afterAll(() => {
  server.close();
});

beforeEach(() => {
  sayNowCalls.length = 0;
  lockedConversations = new Set();
});

function call(userId: string | null, method: string, path: string, body?: unknown) {
  const port = (server.address() as AddressInfo).port;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (userId) headers.authorization = `Bearer ${userId}`;
  if (payload) headers['content-type'] = 'application/json';
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = d ? JSON.parse(d) : {}; } catch { parsed = { raw: d }; }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('ai-1: the platform guard judges the workspace the handler acts on', () => {
  it('another workspace named in the query does not open a conversation of a workspace without ai_assistant', async () => {
    const r = await call('owner-free', 'POST', `/api/ai-agent/conversations/${CONV_FREE}/ai-say-now?workspaceId=${WS_PAID}`, { body: 'hello' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('workspace_id_mismatch');
    expect(sayNowCalls).toEqual([]);
  });

  it('the conversation itself, without a workspace id, is judged by its own plan', async () => {
    const r = await call('owner-free', 'POST', `/api/ai-agent/conversations/${CONV_FREE}/ai-say-now`, { body: 'hello' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('ai_assistant_plan_required');
    expect(sayNowCalls).toEqual([]);
  });

  it('a data source of another workspace cannot be synced under a paid workspace id', async () => {
    const r = await call('owner-free', 'POST', `/api/ai-agent/data-sources/${SOURCE_FREE}/sync?workspaceId=${WS_PAID}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('workspace_id_mismatch');
  });

  it('an operator guidance row is read for its own workspace (not the automation rules)', async () => {
    const r = await call('owner-free', 'DELETE', `/api/ai-agent/guidance/${GUIDANCE_FREE}?workspaceId=${WS_PAID}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('workspace_id_mismatch');
  });

  it('a query and a body naming two workspaces are refused before any handler', async () => {
    const r = await call('owner-free', 'POST', `/api/ai-agent/qna?workspaceId=${WS_PAID}`, {
      workspaceId: WS_FREE, question: 'q', answer: 'a',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('workspace_id_mismatch');
  });

  it('a workspace id given as a list is refused', async () => {
    const r = await call('owner-free', 'GET', `/api/ai-agent/qna?workspaceId=${WS_PAID}&workspaceId=${WS_FREE}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_workspace_id');
  });

  it('the paid workspace, consistently named, still reaches its handler', async () => {
    const r = await call('owner-paid', 'POST', `/api/ai-agent/conversations/${CONV_PAID}/ai-say-now?workspaceId=${WS_PAID}`, { body: 'hello' });
    expect(r.status).toBe(200);
    expect(sayNowCalls).toEqual([{ workspaceId: WS_PAID, conversationId: CONV_PAID }]);
  });
});

describe('ai-2: steering the AI and reading its drafts is the Inbox’s', () => {
  it.each(['viewer-paid', 'billing-paid'])('%s cannot make the AI say something to a visitor', async (user) => {
    const r = await call(user, 'POST', `/api/ai-agent/conversations/${CONV_PAID}/ai-say-now`, { body: 'hello' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('inbox_not_allowed');
    expect(sayNowCalls).toEqual([]);
  });

  it.each([
    ['GET', 'guidance'],
    ['POST', 'guidance'],
    ['POST', 'ai-reply-now'],
    ['GET', 'ai-reply-now/eligibility'],
    ['GET', 'suggestions'],
  ])('a viewer is refused %s /conversations/:id/%s', async (method, tail) => {
    const r = await call('viewer-paid', method, `/api/ai-agent/conversations/${CONV_PAID}/${tail}`, method === 'POST' ? { body: 'x' } : undefined);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('inbox_not_allowed');
  });

  it.each(['support-paid', 'lead-paid', 'owner-paid'])('%s (an Inbox role) may', async (user) => {
    const r = await call(user, 'POST', `/api/ai-agent/conversations/${CONV_PAID}/ai-say-now`, { body: 'hello' });
    expect(r.status).toBe(200);
  });

  it('a conversation the plan locked is refused', async () => {
    lockedConversations = new Set([CONV_LOCKED]);
    const say = await call('owner-paid', 'POST', `/api/ai-agent/conversations/${CONV_LOCKED}/ai-say-now`, { body: 'hello' });
    expect(say.status).toBe(403);
    expect(say.body.error).toBe('conversation_locked');
    const drafts = await call('owner-paid', 'GET', `/api/ai-agent/conversations/${CONV_LOCKED}/suggestions`);
    expect(drafts.status).toBe(403);
    expect(drafts.body.error).toBe('conversation_locked');
    expect(sayNowCalls).toEqual([]);
  });
});

describe('ai-8: suggest-reply follows the Inbox roles', () => {
  it.each(['owner', 'admin', 'agent', 'team_lead', 'support_agent', 'sales_agent'])('%s is an operator', (role) => {
    expect(e7_isOperator(role, false)).toBe(true);
  });
  it.each(['viewer', 'billing', 'analyst', 'seo_manager', 'developer', 'marketing_manager', null])(
    '%s is not',
    (role) => {
      expect(e7_isOperator(role, false)).toBe(false);
    },
  );
  it('a platform admin is', () => {
    expect(e7_isOperator(null, true)).toBe(true);
  });
});
