/**
 * Provider credential resolution precedence — the ONE canonical source
 * (item 4 of the billing callback/config audit).
 *
 * billing_provider_credentials (new, keyed by provider_name) must win over
 * any legacy value still carried on billing_gateways.config or
 * app_runtime_config.default_billing_provider.config (pre-migration data,
 * kept only as a read fallback — see database/migrations/
 * 137_billing_provider_credentials.sql). A workspace-specific provider_configs
 * override must still win over the platform-wide canonical value.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
let tableErrors: Record<string, { code: string; message: string }> = {};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      let rows = [...(tables[table] || [])];
      const forcedError = tableErrors[table] || null;
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        in: (col: string, vals: unknown[]) => {
          rows = rows.filter((r) => vals.includes(r[col]));
          return builder;
        },
        order: () => builder,
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return builder;
        },
        maybeSingle: async () => (forcedError ? { data: null, error: forcedError } : { data: rows[0] ?? null, error: null }),
        then: (resolve: any) => resolve(forcedError ? { data: null, error: forcedError } : { data: rows, error: null }),
      };
      return builder;
    },
  }),
}));

const { resolveNamedBillingConfig, resolveBillingConfig } = await import(
  '../../../server/services/billing/index.js'
);

const WORKSPACE_ID = 'ws-1';

beforeEach(() => {
  tables = {
    billing_gateways: [],
    provider_configs: [],
    app_runtime_config: [],
    billing_provider_credentials: [],
    platform_domains: [],
  };
  tableErrors = {};
});

describe('withCanonicalCredentials — deploy-ordering resilience', () => {
  it('degrades to legacy sources when billing_provider_credentials does not exist yet (migration 137 not applied)', async () => {
    tables.billing_gateways = [{ provider_name: 'zarinpal', config: { merchant_id: 'legacy-value' } }];
    tableErrors.billing_provider_credentials = { code: '42P01', message: 'relation "billing_provider_credentials" does not exist' };

    const resolved = await resolveNamedBillingConfig('url', 'key', WORKSPACE_ID, 'zarinpal');
    expect(resolved?.config.merchant_id).toBe('legacy-value');
  });

  it('still fails loud on a real (non-missing-table) error', async () => {
    tables.billing_gateways = [{ provider_name: 'zarinpal', config: { merchant_id: 'legacy-value' } }];
    tableErrors.billing_provider_credentials = { code: '42501', message: 'permission denied for table billing_provider_credentials' };

    await expect(resolveNamedBillingConfig('url', 'key', WORKSPACE_ID, 'zarinpal')).rejects.toThrow(
      /billing provider credentials read failed/,
    );
  });
});

describe('resolveNamedBillingConfig — canonical credential precedence', () => {
  it('canonical billing_provider_credentials wins over a stale billing_gateways.config value', async () => {
    tables.billing_gateways = [{ provider_name: 'zarinpal', config: { merchant_id: 'stale-legacy-value' } }];
    tables.billing_provider_credentials = [{ provider_name: 'zarinpal', config: { merchant_id: 'canonical-value' } }];

    const resolved = await resolveNamedBillingConfig('url', 'key', WORKSPACE_ID, 'zarinpal');
    expect(resolved?.config.merchant_id).toBe('canonical-value');
  });

  it('falls back to legacy billing_gateways.config when no canonical row exists yet (pre-migration)', async () => {
    tables.billing_gateways = [{ provider_name: 'zarinpal', config: { merchant_id: 'only-legacy-value' } }];

    const resolved = await resolveNamedBillingConfig('url', 'key', WORKSPACE_ID, 'zarinpal');
    expect(resolved?.config.merchant_id).toBe('only-legacy-value');
  });

  it('a workspace-specific provider_configs override still wins over the canonical platform value', async () => {
    tables.billing_provider_credentials = [{ provider_name: 'zarinpal', config: { merchant_id: 'canonical-platform-value' } }];
    tables.provider_configs = [{
      workspace_id: WORKSPACE_ID, provider_type: 'billing', provider_name: 'zarinpal',
      is_active: true, config: { merchant_id: 'workspace-override-value' }, updated_at: new Date().toISOString(),
    }];

    const resolved = await resolveNamedBillingConfig('url', 'key', WORKSPACE_ID, 'zarinpal');
    expect(resolved?.config.merchant_id).toBe('workspace-override-value');
  });

  it('a legacy app_runtime_config .config value never wins over canonical credentials', async () => {
    tables.app_runtime_config = [{
      key: 'default_billing_provider',
      value: { provider_name: 'zarinpal', config: { merchant_id: 'stale-runtime-config-value' } },
    }];
    tables.billing_provider_credentials = [{ provider_name: 'zarinpal', config: { merchant_id: 'canonical-value' } }];

    const resolved = await resolveNamedBillingConfig('url', 'key', WORKSPACE_ID, 'zarinpal');
    expect(resolved?.config.merchant_id).toBe('canonical-value');
  });

  it('an empty canonical config never overrides a real legacy value', async () => {
    tables.billing_gateways = [{ provider_name: 'zarinpal', config: { merchant_id: 'legacy-value' } }];
    tables.billing_provider_credentials = [{ provider_name: 'zarinpal', config: {} }];

    const resolved = await resolveNamedBillingConfig('url', 'key', WORKSPACE_ID, 'zarinpal');
    expect(resolved?.config.merchant_id).toBe('legacy-value');
  });
});

describe('resolveBillingConfig — global default branch', () => {
  it('canonical credentials win over the default-pointer\'s own legacy .config', async () => {
    tables.app_runtime_config = [{
      key: 'default_billing_provider', updated_at: new Date().toISOString(),
      value: { provider_name: 'zibal', config: { merchant_id: 'stale-pointer-value' } },
    }];
    tables.billing_provider_credentials = [{ provider_name: 'zibal', config: { merchant_id: 'canonical-value' } }];

    const resolved = await resolveBillingConfig('url', 'key', WORKSPACE_ID);
    expect(resolved?.provider.name).toBe('zibal');
    expect(resolved?.config.merchant_id).toBe('canonical-value');
  });

  it('a name-only default pointer (post-migration shape) still resolves full credentials from canonical', async () => {
    tables.app_runtime_config = [{
      key: 'default_billing_provider', updated_at: new Date().toISOString(),
      value: { provider_name: 'zibal' },
    }];
    tables.billing_provider_credentials = [{ provider_name: 'zibal', config: { merchant_id: 'canonical-value' } }];

    const resolved = await resolveBillingConfig('url', 'key', WORKSPACE_ID);
    expect(resolved?.config.merchant_id).toBe('canonical-value');
  });
});

describe('resolveBillingConfig — workspace override branch', () => {
  it('canonical credentials fill in the base config; the workspace row\'s own fields still win', async () => {
    const now = new Date().toISOString();
    tables.provider_configs = [{
      id: 'pc-1', workspace_id: WORKSPACE_ID, provider_type: 'billing', provider_name: 'zibal',
      is_active: true, config: { extra_field: 'workspace-only' }, updated_at: now,
    }];
    tables.billing_provider_credentials = [{ provider_name: 'zibal', config: { merchant_id: 'canonical-value' } }];

    const resolved = await resolveBillingConfig('url', 'key', WORKSPACE_ID);
    expect(resolved?.config.merchant_id).toBe('canonical-value');
    expect(resolved?.config.extra_field).toBe('workspace-only');
  });
});
