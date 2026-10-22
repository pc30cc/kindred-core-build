/**
 * S-05: when the Super Admin switches off the chat widget template a
 * workspace chose, its owner is told: the alerts bell
 * (server/routes/workspaceAlerts.ts) shows 'widget_template_unavailable'
 * (a dismissible warning linking to the Widget page) to the workspace's
 * owner and admins, never to other members; it is gone once the template is
 * enabled again, and never raised without a choice, before migration 275 or
 * when the settings cannot be read. The rule is the one the Widget page's
 * warning uses (isChosenTemplateUnavailable).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import { resolveChatTemplateCatalog, type ChatTemplateCatalog } from '../../../shared/chatTemplateCatalog';

const state = vi.hoisted(() => ({
  role: 'owner' as string | null,
  isAdmin: false,
  templateId: 't1' as string | null,
  readError: null as { message: string } | null,
  catalog: null as unknown as ChatTemplateCatalog,
  ready: true,
}));

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: state.isAdmin, role: state.role }),
  serverConfigOf: () => ({}),
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  getWorkspacePlanInfo: async () => ({ plan: { name: 'Pro' }, subscription: null, limits: {} }),
}));
vi.mock('../../../server/services/auth/identity.js', () => ({
  findIdentityById: async () => ({ emailVerifiedAt: '2026-01-01T00:00:00Z' }),
}));
vi.mock('../../../server/services/phoneVerification/index.js', () => ({
  getPhoneVerificationState: async () => ({ verified: true }),
}));
vi.mock('../../../server/services/billing/account/renewalNotice.js', () => ({
  renewalDueNotice: async () => null,
}));
vi.mock('../../../server/services/widget/configSnapshot.js', () => ({
  getChatTemplateCatalog: async () => ({ catalog: state.catalog, edition: 'iran', ready: state.ready }),
}));
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
      b.maybeSingle = async () => (table === 'widget_settings'
        ? { data: state.readError ? null : { widget_template_id: state.templateId }, error: state.readError }
        : { data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
      return b;
    },
  }),
}));

const { workspaceAlertsRouter } = await import('../../../server/routes/workspaceAlerts.js');

const app = express();
app.use('/api/workspace-alerts', workspaceAlertsRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function alerts(): Promise<Array<Record<string, unknown>>> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/workspace-alerts/w1' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body).alerts));
      })
      .on('error', reject);
  });
}

const t1 = (enabled: boolean) => resolveChatTemplateCatalog('iran', { default: 'default', items: { t1: { enabled } } });
const templateAlert = async () => (await alerts()).find((a) => a.kind === 'widget_template_unavailable');

beforeEach(() => {
  state.role = 'owner';
  state.isAdmin = false;
  state.templateId = 't1';
  state.readError = null;
  state.catalog = t1(false);
  state.ready = true;
});

describe('widget_template_unavailable alert', () => {
  it('tells the owner that the template they chose is switched off, linking to the Widget page', async () => {
    expect(await templateAlert()).toMatchObject({
      id: 'widget_template_unavailable',
      severity: 'warning',
      action: '/widget',
      dismissible: true,
    });
  });

  it('workspace admins and platform admins get it; other members do not', async () => {
    state.role = 'admin';
    expect(await templateAlert()).toBeDefined();
    state.role = null;
    state.isAdmin = true;
    expect(await templateAlert()).toBeDefined();
    state.isAdmin = false;
    for (const role of ['agent', 'support_agent', 'viewer']) {
      state.role = role;
      expect(await templateAlert(), role).toBeUndefined();
    }
  });

  it('clears once the template is enabled again', async () => {
    state.catalog = t1(true);
    expect(await templateAlert()).toBeUndefined();
  });

  it('never without a choice, before migration 275, or when the settings cannot be read', async () => {
    state.templateId = null;
    expect(await templateAlert()).toBeUndefined();
    state.templateId = 't1';
    state.ready = false;
    expect(await templateAlert()).toBeUndefined();
    state.ready = true;
    state.readError = { message: 'column widget_settings.widget_template_id does not exist' };
    expect(await templateAlert()).toBeUndefined();
  });

  it('a choice of the default itself is never unavailable', async () => {
    state.templateId = 'default';
    expect(await templateAlert()).toBeUndefined();
  });
});
