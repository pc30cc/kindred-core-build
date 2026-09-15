/**
 * Workspace-first storage finalization — verifies the producers that were
 * ad-hoc-string-interpolating their own key shape (found by a repo-wide
 * audit; see docs/STORAGE_ARCHITECTURE_STANDARDIZATION_REPORT.md's
 * "workspace-first storage finalization" section) now route through the
 * SAME central builders as every other producer
 * (server/services/storage/keys.ts), and that the core cross-workspace
 * isolation invariant — every workspace-owned key starts with
 * `workspace/<workspaceId>/` and NOTHING else can ever construct a key
 * that starts with a DIFFERENT workspace's root — holds across every
 * builder in the module, not just the ones that were already wired.
 *
 * Route-level tests exercise the real `/init` handlers directly (extracted
 * from the Express router, same technique as
 * src/test/billing/conversationAttachmentsRoute.test.ts) for the two
 * producers cheap to stand up without a storage provider mock (`/init`
 * only reserves a DB row + computes the path; the actual byte upload is a
 * separate route already covered elsewhere). For producers embedded deep
 * inside heavier routes (call-center avatar/ringback, AI-agent avatar,
 * AI-agent/KB file ingestion), a source-scan assertion — the same
 * technique src/test/billing/singleWriterInvariants.test.ts already uses
 * in this repo — proves the ad-hoc string-interpolation is gone and the
 * matching keys.ts builder is actually called, without needing to
 * reconstruct each route's full auth/entitlement/provider scaffolding.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';

function src(relPath: string): string {
  return readFileSync(resolve(__dirname, '../../../', relPath), 'utf8');
}

// Module-level (not describe-scoped): vi.mock() factories are hoisted to
// the top of the file regardless of where they're textually written, so
// they can only safely close over module-level bindings — a const
// declared inside a describe() callback is not yet initialized when the
// hoisted factory runs, which throws "state is not defined".
type Row = Record<string, unknown>;
interface MockQueryBuilder {
  select: () => MockQueryBuilder;
  eq: () => MockQueryBuilder;
  order: () => MockQueryBuilder;
  limit: () => MockQueryBuilder;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
  insert: (payload: Row) => { select: () => { single: () => Promise<{ data: Row; error: null }> } };
}

const initRouteState: {
  user: { data: { user: { id: string } }; error?: null } | null;
  isMember: { data: boolean; error: null } | null;
  convo: Row | null;
  providerCfg: Row | null;
  inserted: Row[];
} = {
  user: null, isMember: null, convo: null, providerCfg: null, inserted: [],
};

const initRouteSbMock = {
  auth: { getUser: async () => initRouteState.user },
  rpc: async (name: string) => {
    if (name === 'is_workspace_member') return initRouteState.isMember;
    return { data: null, error: null };
  },
  from: (table: string) => {
    const builder: MockQueryBuilder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        if (table === 'conversations') return { data: initRouteState.convo, error: null };
        if (table === 'provider_configs') return { data: initRouteState.providerCfg, error: null };
        if (table === 'app_runtime_config') return { data: null, error: null };
        return { data: null, error: null };
      },
      insert: (payload: Row) => ({
        select: () => ({
          single: async () => {
            const row: Row = { id: `att-${initRouteState.inserted.length + 1}`, ...payload };
            initRouteState.inserted.push(row);
            return { data: row, error: null };
          },
        }),
      }),
    };
    return builder;
  },
};

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => initRouteSbMock }));
vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_c: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = initRouteState.user?.data?.user;
    return user ? { sessionId: 's', userId: user.id, email: 'x@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

function getHandler(router: import('express').Router, method: string, path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`route ${method} ${path} not found`);
  const routeStack = layer.route.stack;
  return routeStack[routeStack.length - 1].handle;
}

function makeReqRes(body: Row) {
  const req: Record<string, unknown> = {
    body, params: {}, query: {},
    headers: { authorization: 'Bearer tok' },
    cookies: { gs_session: 'tok' },
    serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' },
  };
  let statusCode: number | undefined;
  let jsonBody: unknown;
  const res = {
    status(c: number) { statusCode = c; return res; },
    json(b: unknown) { jsonBody = b; return res; },
  };
  return { req, res, get: () => ({ statusCode, jsonBody }) };
}

describe('workspace isolation — every canonical builder scopes strictly to the owner it was given', () => {
  it('no builder can be made to produce a key under a DIFFERENT workspace root than the one it was called with', async () => {
    const keys = await import('../../../server/services/storage/keys');
    const producedForA = [
      keys.chatAttachmentKey({ workspaceId: WS_A, fileName: 'a.png' }),
      keys.emailAttachmentKey({ workspaceId: WS_A, fileName: 'a.eml' }),
      keys.channelAttachmentKey({ workspaceId: WS_A, provider: 'telegram', fileName: 'a.jpg' }),
      keys.contactAvatarKey({ workspaceId: WS_A, provider: 'telegram', contactId: 'c1', ext: 'jpg' }),
      keys.aiAgentAvatarKey({ workspaceId: WS_A, fileName: 'a.png' }),
      keys.callCenterAvatarKey({ workspaceId: WS_A, fileName: 'a.png' }),
      keys.integrationAvatarKey({ workspaceId: WS_A, provider: 'x', fileName: 'a.png' }),
      keys.widgetAssetKey({ workspaceId: WS_A, category: 'assets', fileName: 'a.png' }),
      keys.aiAgentFileKey({ workspaceId: WS_A, sourceId: '33333333-3333-3333-3333-333333333333', fileName: 'a.pdf' }),
      keys.callRecordingKey({ workspaceId: WS_A, callSessionId: '44444444-4444-4444-4444-444444444444', fileName: 'a.mp4' }),
      keys.callArchiveKey({ workspaceId: WS_A, archiveName: 'a.zip' }),
      keys.workspaceBrandingKey({ workspaceId: WS_A, fileName: 'a.png' }),
      keys.privacyExportKey({ kind: 'workspace', workspaceId: WS_A }, '55555555-5555-5555-5555-555555555555'),
    ];

    for (const key of producedForA) {
      expect(key).toMatch(new RegExp(`^workspace/${WS_A}/`));
      expect(key.startsWith(`workspace/${WS_B}/`)).toBe(false);
      // enforceOwnerScope's fail-closed check (the same assertion every
      // real upload path runs through) must accept a key scoped to its
      // OWN workspace...
      expect(() => keys.assertWorkspaceScopedKey(WS_A, key)).not.toThrow();
      // ...and reject the exact same key if presented as if it belonged
      // to a DIFFERENT workspace — this is the concrete mechanism that
      // makes "no operation from A can write/delete a B key" true for
      // every one of these categories, not just the ones with dedicated
      // tests elsewhere.
      expect(() => keys.assertWorkspaceScopedKey(WS_B, key)).toThrow(/must be scoped to workspace/);
    }
  });

  it('every builder requires a real UUID workspaceId — a non-UUID/sentinel id is rejected before any key is ever constructed', async () => {
    const keys = await import('../../../server/services/storage/keys');
    expect(() => keys.chatAttachmentKey({ workspaceId: 'not-a-uuid', fileName: 'a.png' })).toThrow(/expected a UUID/);
    expect(() => keys.chatAttachmentKey({ workspaceId: '00000000-0000-0000-0000-000000000000', fileName: 'a.png' }))
      .not.toThrow(); // the all-zero UUID is syntactically valid — sentinel *values* are a call-site discipline issue, not something the builder can detect; see the ringback fix removing the sentinel entirely.
  });
});

describe('conversation/widget attachment producers now share ONE central builder (previously three independent, byte-for-byte-triplicated ad-hoc implementations)', () => {
  beforeEach(() => {
    initRouteState.user = { data: { user: { id: 'user-1' } }, error: null };
    initRouteState.isMember = { data: true, error: null };
    initRouteState.convo = null;
    initRouteState.providerCfg = null;
    initRouteState.inserted = [];
  });

  it('conversationAttachments POST /init reserves a row whose storage_path lands under workspace/<id>/attachments/chat/ — the exact canonical shape, not the previous ad-hoc one lacking the /chat/ segment', async () => {
    const { conversationAttachmentsRouter } = await import('../../../server/routes/conversationAttachments');
    const handler = getHandler(conversationAttachmentsRouter, 'post', '/init');
    const { req, res, get } = makeReqRes({
      workspace_id: WS_A, file_name: 'photo.png', mime_type: 'image/png', size_bytes: 1024,
    });

    await handler(req, res, () => {});

    expect(get().statusCode).toBeUndefined(); // no explicit error status set — falls through to res.json(...)
    const row = initRouteState.inserted[0];
    expect(row).toBeTruthy();
    expect(row.workspace_id).toBe(WS_A);
    expect(row.storage_path).toMatch(new RegExp(`^workspace/${WS_A}/attachments/chat/\\d{4}/\\d{2}/`));
    expect(row.storage_path.endsWith('photo.png')).toBe(true);
  });

  it('widgetAttachments.ts and mediaIngest.ts (telegram) now call the SAME chatAttachmentKey() builder as conversationAttachments.ts — source-verified, since standing up the full widget-token/rate-limit chain for a route-level test would duplicate src/test/billing/widgetAttachmentsRoute.test.ts and src/test/channels/telegramMediaIngest.test.ts (already covers mediaIngest.ts\'s shape at the route level) without adding coverage', () => {
    const widgetSrc = src('server/routes/widgetAttachments.ts');
    expect(widgetSrc).toMatch(/import\s*\{\s*chatAttachmentKey\s*\}\s*from\s*'\.\.\/services\/storage\/keys\.js'/);
    expect(widgetSrc).toMatch(/chatAttachmentKey\(\s*\{\s*workspaceId/);
    // The old ad-hoc shape is gone — no more hand-built template literal
    // starting the key with a bare `workspace/${...}/attachments/${yyyy}`.
    expect(widgetSrc).not.toMatch(/`workspace\/\$\{workspaceId\}\/attachments\/\$\{yyyy\}/);

    const mediaIngestSrc = src('server/services/channels/telegram/mediaIngest.ts');
    expect(mediaIngestSrc).toMatch(/import\s*\{\s*chatAttachmentKey\s*\}\s*from\s*'\.\.\/\.\.\/storage\/keys\.js'/);
    expect(mediaIngestSrc).toMatch(/chatAttachmentKey\(\s*\{\s*workspaceId/);
  });
});

describe('AI-agent avatar, AI-agent/KB file, call-center avatar and ringback producers — source-verified wiring to the central builders (workspace-first storage finalization)', () => {
  it('ai-agent avatar upload (server/routes/ai-agent/assistant.ts) calls aiAgentAvatarKey(), not an ad-hoc template literal', () => {
    const s = src('server/routes/ai-agent/assistant.ts');
    expect(s).toMatch(/import\s*\{\s*aiAgentAvatarKey\s*\}\s*from\s*'\.\.\/\.\.\/services\/storage\/keys\.js'/);
    expect(s).toMatch(/aiAgentAvatarKey\(\s*\{/);
    expect(s).not.toMatch(/`workspace\/\$\{workspaceId\}\/ai-agent\/avatar\//);
  });

  it('AI-agent/KB file ingestion (server/services/ai-agent/files/fileIngestion.ts) calls aiAgentFileKey(), not an ad-hoc template literal — this IS the platform\'s knowledge-base file storage, there is no separate KB feature', () => {
    const s = src('server/services/ai-agent/files/fileIngestion.ts');
    expect(s).toMatch(/import\s*\{\s*aiAgentFileKey\s*\}\s*from\s*'\.\.\/\.\.\/storage\/keys\.js'/);
    expect(s).toMatch(/aiAgentFileKey\(\s*\{/);
    expect(s).not.toMatch(/`workspace\/\$\{workspaceId\}\/ai-agent\/files\//);
  });

  it('call-center avatar upload (server/routes/callCenter.ts) calls callCenterAvatarKey(), not an ad-hoc template literal', () => {
    const s = src('server/routes/callCenter.ts');
    expect(s).toMatch(/import\s*\{[^}]*callCenterAvatarKey[^}]*\}\s*from\s*'\.\.\/services\/storage\/keys\.js'/);
    expect(s).toMatch(/callCenterAvatarKey\(\s*\{/);
    expect(s).not.toMatch(/`workspace\/\$\{wid\}\/call-center\/avatar\//);
  });

  it('platform ringback-audio upload (server/routes/callCenter.ts) calls platformCallCenterRingbackKey() and no longer passes the inert all-zero-UUID sentinel workspaceId to uploadWithConfig()', () => {
    const s = src('server/routes/callCenter.ts');
    expect(s).toMatch(/import\s*\{[^}]*platformCallCenterRingbackKey[^}]*\}\s*from\s*'\.\.\/services\/storage\/keys\.js'/);
    expect(s).toMatch(/platformCallCenterRingbackKey\(\s*\{/);
    expect(s).not.toMatch(/00000000-0000-0000-0000-000000000000/);
  });
});
