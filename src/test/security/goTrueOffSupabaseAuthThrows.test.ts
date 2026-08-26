/**
 * GoTrue-off closure (item 11) — hard requirement: proof that the
 * migrated frontend API client modules (item 8's cleanup target) never
 * call supabase.auth.* at all, not merely that they degrade gracefully
 * if it's unavailable.
 *
 * Approach: mock BOTH browser Supabase client import paths
 * (`@/integrations/supabase/client`, the source of truth — `@/lib/supabase`
 * just re-exports the same singleton, see that file's own header comment)
 * so that `.auth` is a Proxy that throws synchronously on ANY property
 * access — get, call, everything. Then call a representative function
 * from each migrated client module with a mocked `fetch`. If any of them
 * still touch `supabase.auth.getSession()`/`getUser()`/`refreshSession()`/
 * `signInWithPassword()`/`onAuthStateChange()` etc., the call throws and
 * the test fails loudly instead of silently passing.
 *
 * This deliberately does NOT stub `.from()`/`.rpc()` — a handful of these
 * modules still use direct Supabase table reads for non-auth reasons
 * (documented in the item-8 commit as a separate, out-of-scope finding);
 * touching `.auth` must throw regardless of whether `.from()` is used
 * elsewhere in the same module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function throwingAuthProxy(): any {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`supabase.auth.${String(prop)} was called — GoTrue/Supabase Auth must not be reachable`);
      },
    },
  );
}

const supabaseStub = {
  auth: throwingAuthProxy(),
  from: () => { throw new Error('unexpected supabase.from() call in this test'); },
  channel: () => { throw new Error('unexpected supabase.channel() call in this test'); },
  rpc: () => { throw new Error('unexpected supabase.rpc() call in this test'); },
};

vi.mock('@/integrations/supabase/client', () => ({ supabase: supabaseStub }));
vi.mock('@/lib/supabase', () => ({ supabase: supabaseStub }));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '{}',
    statusText: 'OK',
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('migrated frontend API modules never touch supabase.auth.*', () => {
  it('account-api.ts: fetchAccountMe / fetchSecuritySessions / revokeSecuritySession', async () => {
    const mod = await import('@/lib/account-api');
    await expect(mod.fetchAccountMe()).resolves.toBeDefined();
    await expect(mod.fetchSecuritySessions()).resolves.toBeDefined();
    await expect(mod.revokeSecuritySession('sess-1')).resolves.toBeDefined();
  });

  it('privacy-api.ts: no longer throws "Not signed in" — dead bearer() removed', async () => {
    const mod = await import('@/lib/privacy-api');
    // Whatever the shape of the export, calling into it must reach fetch
    // (auth-throwing proxy would surface as a rejection with our marker
    // message; the old bug threw "Not signed in" before ever touching
    // fetch at all).
    const anyMod = mod as any;
    const fn = anyMod.listPrivacyJobs || anyMod.fetchPrivacyJobs || Object.values(anyMod).find((v) => typeof v === 'function');
    expect(typeof fn).toBe('function');
    await expect(fn('ws_1')).resolves.toBeDefined();
  });

  it('calls-api.ts: callsApi.state', async () => {
    const { callsApi } = await import('@/lib/calls-api');
    await expect(callsApi.state('call_1')).resolves.toBeDefined();
  });

  it('contacts-api.ts: contactsApi.list', async () => {
    const { contactsApi } = await import('@/lib/contacts-api');
    await expect(contactsApi.list('ws_1')).resolves.toBeUndefined(); // json() stub has no .contacts key
  });

  it('conversations-api.ts: conversationsApi.list', async () => {
    const { conversationsApi } = await import('@/lib/conversations-api');
    await expect(conversationsApi.list({ workspace_id: 'ws_1' })).resolves.toBeDefined();
  });

  it('canned-responses-api.ts: cannedResponsesApi.list', async () => {
    const { cannedResponsesApi } = await import('@/lib/canned-responses-api');
    await expect(cannedResponsesApi.list({ workspace_id: 'ws_1', locale: 'en' })).resolves.toBeDefined();
  });

  it('entitlements-api.ts: fetchWorkspaceEffective', async () => {
    const mod = await import('@/lib/entitlements-api');
    await expect(mod.fetchWorkspaceEffective('ws_1')).resolves.toBeDefined();
  });

  it('notifications-api.ts: fetchNotificationPrefs', async () => {
    const mod = await import('@/lib/notifications-api');
    await expect(mod.fetchNotificationPrefs()).resolves.toBeDefined();
  });

  it('widget-admin-api.ts: testWidgetUrl — no longer throws "Not authenticated"', async () => {
    const mod = await import('@/lib/widget-admin-api');
    await expect(mod.testWidgetUrl({ kind: 'loader', url: 'https://x.test/loader.js' })).resolves.toBeDefined();
  });

  it('admin-reliability-api.ts: fetchSla', async () => {
    const mod = await import('@/lib/admin-reliability-api');
    await expect(mod.fetchSla()).resolves.toBeDefined();
  });

  it('call-invitations-api.ts: callInvitationsApi.listForConversation', async () => {
    const { callInvitationsApi } = await import('@/lib/call-invitations-api');
    await expect(callInvitationsApi.listForConversation('conv_1')).resolves.toBeDefined();
  });

  it('ai-agent/client.ts: jsonFetch', async () => {
    const { jsonFetch } = await import('@/lib/ai-agent/client');
    await expect(jsonFetch('/api/ai-agent/status')).resolves.toBeDefined();
  });

  it('api.ts: billingGetPlans / resendMyVerificationEmail (userAuthHeaders()/getAdminAuthHeaders() deleted)', async () => {
    const mod = await import('@/lib/api');
    await expect(mod.billingGetPlans()).resolves.toBeDefined();
    await expect(mod.resendMyVerificationEmail()).resolves.toBeDefined();
  });

  it('accessing supabase.auth directly still throws — proves the mock itself is a valid negative control', async () => {
    const { supabase } = await import('@/integrations/supabase/client');
    expect(() => (supabase as any).auth.getSession()).toThrow(/must not be reachable/);
  });
});
