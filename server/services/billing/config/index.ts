// ============================================================
// UNIFIED BILLING — PLATFORM CONFIGURATION
//
// The app-wide payment gateway configuration: each gateway's operational
// state (`billing_gateways`) and the canonical provider credentials
// (`billing_provider_credentials`). Everything is server-authoritative and
// edited from the super-admin finance panel. Nothing here is per-workspace.
//
// Billing v2's currencies, exchange rates, tax rates, coupons and usage items
// were retired in phase 7 (migration 267); simple billing keeps prices per
// currency on the plan and never converts.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getAllProviders } from '../index.js';
import { getPlatformEdition, isCurrencyAllowedInEdition, isProviderAllowedInEdition } from '../edition.js';
import { PADDLE_SANDBOX_PROVIDER, isAlwaysTestGateway } from '../../../../shared/testGateways.js';

export class BillingConfigError extends Error {
  constructor(
    public code: string,
    public status = 400,
    message?: string,
  ) {
    super(message || code);
    this.name = 'BillingConfigError';
  }
}

function db(config: ServerConfig) {
  return getServiceClient(config);
}

function ok<T>(res: { data: T | null; error: { message: string } | null }, code: string): T {
  if (res.error) throw new BillingConfigError(code, 500, res.error.message);
  return res.data as T;
}

// ─── Gateways ──────────────────────────────────────────────────────────────

export interface Gateway {
  id: string;
  provider_name: string;
  display_name: Record<string, string>;
  is_active: boolean;
  is_test: boolean;
  currencies: string[];
  countries: string[];
  sort_order: number;
  config: Record<string, unknown>;
}

/** Display names of shipped gateways that have no seeded `billing_gateways` row. */
const DEFAULT_DISPLAY_NAMES: Record<string, Record<string, string>> = {
  [PADDLE_SANDBOX_PROVIDER]: {
    en: 'Paddle — Sandbox (test)',
    fa: 'Paddle — سندباکس (تست)',
    tr: 'Paddle — Sandbox (test)',
  },
  zibal_test: {
    en: 'Zibal (test)',
    fa: 'زیبال (تست)',
    tr: 'Zibal (test)',
  },
};

function hasDisplayName(name: unknown): boolean {
  return typeof name === 'object' && name !== null && Object.values(name).some((v) => typeof v === 'string' && v.trim() !== '');
}

/** Registered gateways joined with the capabilities of the shipped handler. */
export async function listGateways(config: ServerConfig): Promise<
  (Gateway & { implemented: boolean; capabilities?: unknown })[]
> {
  const rows = (ok(
    await db(config).from('billing_gateways').select('*').order('sort_order'),
    'gateways_read_failed',
  ) || []) as Gateway[];
  const handlers = getAllProviders();
  const listed = rows.map((g) => ({
    ...g,
    // A row created by switching the gateway on has no name yet.
    display_name: hasDisplayName(g.display_name) ? g.display_name : DEFAULT_DISPLAY_NAMES[g.provider_name] ?? g.display_name,
    // A sandbox-only gateway is a test gateway whatever its row says.
    is_test: g.is_test || isAlwaysTestGateway(g.provider_name),
    implemented: g.provider_name === 'manual' || Boolean(handlers[g.provider_name]),
    capabilities: handlers[g.provider_name]?.capabilities,
  }));
  // A registered handler with no configuration row still has to be visible in
  // the admin gateway list, otherwise it can never be switched on.
  const known = new Set(listed.map((g) => g.provider_name));
  const maxSort = listed.reduce((m, g) => Math.max(m, g.sort_order ?? 0), 0);
  let extra = 0;
  for (const name of Object.keys(handlers)) {
    if (known.has(name)) continue;
    extra += 1;
    listed.push({
      id: `unconfigured:${name}`,
      provider_name: name,
      display_name: DEFAULT_DISPLAY_NAMES[name] ?? { fa: name, en: name, tr: name },
      is_active: false,
      is_test: isAlwaysTestGateway(name),
      currencies: [] as string[],
      countries: [] as string[],
      sort_order: maxSort + extra,
      config: {},
      implemented: true,
      capabilities: handlers[name]?.capabilities,
    } as (typeof listed)[number]);

  }
  return listed;
}


/**
 * Gateways a customer may actually pay this currency with. In the
 * International edition no Iranian gateway is ever payable and nothing can
 * be paid in Rial; the Iranian edition is unchanged.
 */
export async function listPayableGateways(
  config: ServerConfig,
  currency: string,
): Promise<Gateway[]> {
  const edition = await getPlatformEdition(config);
  if (!isCurrencyAllowedInEdition(currency, edition)) return [];
  const rows = await listGateways(config);
  return rows.filter(
    (g) =>
      g.is_active &&
      g.implemented &&
      isProviderAllowedInEdition(g.provider_name, edition) &&
      (g.currencies.length === 0 || g.currencies.includes(currency)),
  );
}

/**
 * Finance -> Gateways owns only OPERATIONAL state (enabled/disabled, test
 * marker, currencies, display, order) — never credentials. `config` is
 * deliberately excluded from what this write accepts: the canonical
 * credential source is `billing_provider_credentials` (see
 * upsertProviderCredentials below). A pre-migration `billing_gateways.config`
 * value is still READ as a legacy fallback (see resolveNamedBillingConfig /
 * resolveBillingConfig in ../index.ts) but is never written to again.
 */
export async function upsertGateway(
  config: ServerConfig,
  input: Partial<Gateway> & { provider_name: string },
): Promise<Gateway> {
  const payload: Record<string, unknown> = { provider_name: input.provider_name };
  for (const k of ['display_name', 'is_active', 'is_test', 'currencies', 'countries', 'sort_order'] as const) {
    if (input[k] !== undefined) payload[k] = input[k];
  }
  // A gateway shipped without a seeded row (zibal_test, paddle_sandbox) gets
  // one on its first switch or currency change. It stores the name the list
  // showed, since a receipt copies the STORED name (the settle SQL), and
  // takes a place after the others (the column default 0 would put a test
  // gateway first, preselected ahead of the live ones).
  const fallbackName = DEFAULT_DISPLAY_NAMES[input.provider_name];
  if ((payload.display_name === undefined && fallbackName) || payload.sort_order === undefined) {
    const rows = (ok(
      await db(config).from('billing_gateways').select('provider_name, display_name, sort_order'),
      'gateways_read_failed',
    ) || []) as Pick<Gateway, 'provider_name' | 'display_name' | 'sort_order'>[];
    const stored = rows.find((g) => g.provider_name === input.provider_name);
    if (payload.display_name === undefined && fallbackName && !hasDisplayName(stored?.display_name)) {
      payload.display_name = fallbackName;
    }
    if (payload.sort_order === undefined && !stored) {
      payload.sort_order = rows.reduce((m, g) => Math.max(m, g.sort_order ?? 0), 0) + 1;
    }
  }
  return ok(
    await db(config).from('billing_gateways').upsert(payload, { onConflict: 'provider_name' }).select().single(),
    'gateway_write_failed',
  ) as Gateway;
}

// ─── Provider credentials (the ONE canonical Providers-screen source) ──────
//
// Keyed only by provider_name — this is the platform-wide credential store
// for every billing gateway, independent of which one is currently the
// default and independent of Finance -> Gateways' operational state.

export interface ProviderCredentials {
  provider_name: string;
  config: Record<string, unknown>;
  updated_at: string;
}

export async function getProviderCredentials(
  config: ServerConfig,
  providerName: string,
): Promise<ProviderCredentials | null> {
  const res = await db(config)
    .from('billing_provider_credentials')
    .select('*')
    .eq('provider_name', providerName)
    .maybeSingle();
  return ok(res, 'provider_credentials_read_failed') as ProviderCredentials | null;
}

export async function upsertProviderCredentials(
  config: ServerConfig,
  providerName: string,
  credentialConfig: Record<string, unknown>,
): Promise<ProviderCredentials> {
  return ok(
    await db(config)
      .from('billing_provider_credentials')
      .upsert(
        { provider_name: providerName, config: credentialConfig, updated_at: new Date().toISOString() },
        { onConflict: 'provider_name' },
      )
      .select()
      .single(),
    'provider_credentials_write_failed',
  ) as ProviderCredentials;
}
