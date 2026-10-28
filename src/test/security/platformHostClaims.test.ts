// @vitest-environment node
/**
 * Platform hosts are never a customer's (server/services/platformHosts.ts).
 *
 * The finding: the account owner's free-text website is verified for every
 * new workspace (trg_workspaces_auto_register_owner_domain), and an exact
 * verified row beats the platform workspace's suffix match on its apex, so a
 * signup whose website was `api.webyar.ai` took over the help center that
 * `GET /api/widget/kb/help-host` (and the SSR /help pages) resolve by the API
 * request's Host. Here such rows are put straight into the domain table, as
 * an old signup, an import or SQL would leave them, and the resolver must
 * still hand every platform host to the platform's own workspace only, while
 * customer domains resolve exactly as before.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase/Express test doubles are intentionally untyped. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

type DomainRow = { workspace_id: string; normalized_domain: string; verified: boolean };
type SettingsRow = { workspace_id: string; allow_subdomains: boolean };

const db = vi.hoisted(() => ({
  platform_domains: [] as Array<Record<string, unknown>>,
  widget_platform_settings: [] as Array<Record<string, unknown>>,
  workspace_domains: [] as DomainRow[],
  widget_settings: [] as SettingsRow[],
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: keyof typeof db) {
      const filters: Array<(row: any) => boolean> = [];
      const builder: any = {
        select: () => builder,
        limit: () => builder,
        eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return builder; },
        in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return builder; },
        maybeSingle: () => builder.then((r: any) => ({ data: r.data[0] ?? null, error: null })),
        then: (resolve: any, reject?: any) =>
          Promise.resolve({ data: (db[table] as any[]).filter((r) => filters.every((f) => f(r))), error: null })
            .then(resolve, reject),
      };
      return builder;
    },
  }),
}));

const { resolveWorkspaceIdFromOrigin, __resetWidgetOriginCaches } = await import('../../../server/services/widget/public.js');
const { __resetPlatformHostsCache } = await import('../../../server/services/platformHosts.js');
const { widgetKbRouter } = await import('../../../server/routes/kb.js');

const config = { corsOrigins: ['*'] } as any;

const PLATFORM = '00000000-0000-4000-8000-00000000000a';
const ATTACKER = '00000000-0000-4000-8000-0000000000bb';
const CUSTOMER = '00000000-0000-4000-8000-0000000000cc';

function verified(workspaceId: string, domain: string) {
  db.workspace_domains.push({ workspace_id: workspaceId, normalized_domain: domain, verified: true });
}
function subdomains(workspaceId: string, on: boolean) {
  db.widget_settings = db.widget_settings.filter((r) => r.workspace_id !== workspaceId);
  db.widget_settings.push({ workspace_id: workspaceId, allow_subdomains: on });
}

const app = express();
app.use((req, _res, next) => { (req as any).serverConfig = config; next(); });
app.use('/api/widget/kb', widgetKbRouter);

/** The help-host probe as the platform API host receives it. */
const helpHost = (host: string) => request(app).get('/api/widget/kb/help-host').set('Host', host);

describe.each([
  ['WebYar', 'webyar.ai'],
  ['RESPOK', 'respok.app'],
])('%s', (_brand, apex) => {
  beforeEach(() => {
    db.platform_domains = [{
      primary_domain: apex,
      canonical_base_url: `https://${apex}`,
      public_base_url: `https://${apex}`,
      app_base_url: `https://app.${apex}`,
      api_base_url: `https://api.${apex}`,
    }];
    db.widget_platform_settings = [];
    db.workspace_domains = [];
    db.widget_settings = [];
    // Production's shape: the platform's own workspace holds the apex, and
    // the customers hold their own sites.
    verified(PLATFORM, apex);
    subdomains(PLATFORM, true);
    verified(CUSTOMER, 'ninisite.com');
    subdomains(CUSTOMER, true);
    __resetWidgetOriginCaches();
    __resetPlatformHostsCache();
  });

  it(`help-host on api.${apex} answers the platform's own workspace, as today`, async () => {
    const res = await helpHost(`api.${apex}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workspace_id: PLATFORM });
  });

  it(`a customer's verified api.${apex} or app.${apex} row does not take it over`, async () => {
    verified(ATTACKER, `api.${apex}`);
    verified(ATTACKER, `app.${apex}`);
    verified(ATTACKER, `deep.api.${apex}`);
    subdomains(ATTACKER, true);

    expect((await helpHost(`api.${apex}`)).body).toEqual({ workspace_id: PLATFORM });
    expect((await helpHost(`API.${apex.toUpperCase()}:443`)).body).toEqual({ workspace_id: PLATFORM });
    for (const origin of [`https://app.${apex}`, `https://x.api.${apex}`, `https://deep.api.${apex}`, `https://www.api.${apex}`]) {
      expect(await resolveWorkspaceIdFromOrigin(config, origin)).toBe(PLATFORM);
    }
  });

  it('with the platform not answering for its subdomains, a claim gains nothing either', async () => {
    subdomains(PLATFORM, false);
    verified(ATTACKER, `api.${apex}`);
    subdomains(ATTACKER, true);
    const res = await helpHost(`api.${apex}`);
    expect(res.status).toBe(404);
    expect(await resolveWorkspaceIdFromOrigin(config, `https://app.${apex}`)).toBeNull();
  });

  it('a claim on a configured host off the apex is ignored too', async () => {
    db.platform_domains[0].api_base_url = 'https://edge-api.example.net';
    verified(ATTACKER, 'edge-api.example.net');
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://edge-api.example.net')).toBeNull();
  });

  it('the platform workspace keeps its own platform hosts', async () => {
    subdomains(PLATFORM, false);
    verified(PLATFORM, `help.${apex}`);
    expect(await resolveWorkspaceIdFromOrigin(config, `https://help.${apex}`)).toBe(PLATFORM);
    expect(await resolveWorkspaceIdFromOrigin(config, `https://${apex}`)).toBe(PLATFORM);
  });

  it('customer domains resolve exactly as before', async () => {
    verified(ATTACKER, `api.${apex}`);
    verified(ATTACKER, 'shop.example');
    subdomains(ATTACKER, false);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://ninisite.com')).toBe(CUSTOMER);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://blog.ninisite.com')).toBe(CUSTOMER);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://www.shop.example')).toBe(ATTACKER);
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://store.shop.example')).toBeNull();
    // A name that only contains the brand is a customer's.
    verified(CUSTOMER, `${apex}.ninisite.com`);
    expect(await resolveWorkspaceIdFromOrigin(config, `https://${apex}.ninisite.com`)).toBe(CUSTOMER);
  });
});

describe('a deployment that names no platform domain', () => {
  beforeEach(() => {
    db.platform_domains = [];
    db.widget_platform_settings = [];
    db.workspace_domains = [];
    db.widget_settings = [];
    __resetWidgetOriginCaches();
    __resetPlatformHostsCache();
  });

  it('resolves every verified row as before (nothing is known to be the platform)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    verified(CUSTOMER, 'api.webyar.ai');
    expect(await resolveWorkspaceIdFromOrigin(config, 'https://api.webyar.ai')).toBe(CUSTOMER);
    warn.mockRestore();
  });
});
