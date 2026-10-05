/**
 * GoTrue-off closure (item 11) — proof that the dashboard's API client
 * modules never reach Supabase Auth, or Supabase at all.
 *
 * The browser no longer has a Supabase client: `@/integrations/supabase/client`
 * and `@/lib/supabase` are gone, every read goes through the server API, and
 * the server reaches the database through DATABASE_URL. So the proof is two
 * parts:
 *   1. static — no browser module imports a Supabase client, except the
 *      optional Supabase Realtime transport, which builds one on demand from
 *      the server-provided project URL + anon key (supabaseConnection.ts) and
 *      configures it with Supabase Auth switched off;
 *   2. runtime — a representative function from each migrated client module
 *      completes with nothing but a mocked `fetch`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'test') continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

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
    const anyMod = mod as unknown as Record<string, unknown>;
    const fn = (anyMod.listPrivacyJobs || anyMod.fetchPrivacyJobs || Object.values(anyMod).find((v) => typeof v === 'function')) as (
      workspaceId: string,
    ) => Promise<unknown>;
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

  it('no browser module imports a Supabase client except the optional Realtime connection', () => {
    const offenders = sourceFiles(join(process.cwd(), 'src')).filter((f) => {
      if (f.endsWith(join('realtime', 'providers', 'supabaseConnection.ts'))) return false;
      const src = readFileSync(f, 'utf8');
      return /@supabase\/supabase-js|integrations\/supabase\/client|@\/lib\/supabase['"]/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('the optional Realtime connection never enables Supabase Auth', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'realtime', 'providers', 'supabaseConnection.ts'), 'utf8');
    expect(src).toMatch(/persistSession:\s*false/);
    expect(src).toMatch(/autoRefreshToken:\s*false/);
    expect(src).toMatch(/detectSessionInUrl:\s*false/);
    expect(src).not.toMatch(/\.auth\./);
    // Configured only from the server — never a project compiled in.
    expect(src).toContain('/api/realtime/supabase-config');
    expect(src).not.toMatch(/https:\/\/[a-z0-9]+\.supabase\.co/);
  });
});
