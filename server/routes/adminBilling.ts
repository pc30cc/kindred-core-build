// ============================================================
// SUPER-ADMIN FINANCE API (/api/admin/billing): payment gateways
//
// Finance -> Gateways (which gateways are on, their currencies and display)
// and the Providers screen (each gateway's platform-wide credentials). Every
// route re-verifies platform admin identity from the first-party session
// before touching service-role data.
//
// Billing v2's finance routes (currencies, exchange rates, tax, coupons,
// metered items, its invoices, payments, customers, audit and reset) were
// removed in phase 7 (docs/billing/SIMPLE_BILLING.md). The simple billing's
// Super Admin routes are in adminSimpleBilling.ts and adminBillingLocks.ts.
// ============================================================

import { Router, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import {
  BillingConfigError,
  listGateways, upsertGateway,
  getProviderCredentials, upsertProviderCredentials,
} from '../services/billing/config/index.js';
import {
  assertCurrencyAllowed,
  assertProviderAllowed,
  editionErrorResponse,
  getPlatformEdition,
} from '../services/billing/edition.js';
import { isProviderAllowedInEdition, isRialCurrency } from '../../shared/edition.js';
import { getProvider, resolveNamedBillingConfig } from '../services/billing/index.js';
import { resolveAppBaseUrl } from '../services/auth-email.js';

export const adminBillingRouter = Router();

function cfg(req: object): ServerConfig {
  return (req as { serverConfig?: ServerConfig }).serverConfig as ServerConfig;
}

function fail(res: Response, e: unknown) {
  const editionError = editionErrorResponse(e);
  if (editionError) return res.status(editionError.status).json(editionError.body);
  if (e instanceof BillingConfigError) {
    return res.status(e.status).json({ error: e.code, message: e.message });
  }
  if (e instanceof z.ZodError) {
    return res.status(400).json({ error: 'invalid_input', details: e.flatten().fieldErrors });
  }
  return res.status(500).json({ error: 'internal_error', message: e instanceof Error ? e.message : String(e) });
}

// ─── Gateways ──────────────────────────────────────────────────────────────

adminBillingRouter.get('/gateways', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    // No Iranian gateway is listed (or switchable on) in the International edition.
    const edition = await getPlatformEdition(cfg(req));
    const gateways = await listGateways(cfg(req));
    res.json({
      gateways: gateways
        .filter((g) => isProviderAllowedInEdition(g.provider_name, edition))
        .map((g) => edition === 'iran' ? g : { ...g, currencies: (g.currencies || []).filter((c) => !isRialCurrency(c)) }),
    });
  } catch (e) { fail(res, e); }
});

// Operational state ONLY — no `config`/credentials. Finance -> Gateways
// governs enabled/disabled, test marker, currencies and display; provider
// connection settings belong exclusively to the Providers screen below.
adminBillingRouter.put('/gateways', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const body = z
      .object({
        provider_name: z.string().min(2),
        display_name: z.record(z.string()).optional(),
        is_active: z.boolean().optional(),
        is_test: z.boolean().optional(),
        currencies: z.array(z.string().length(3)).optional(),
        countries: z.array(z.string().length(2)).optional(),
        sort_order: z.number().int().optional(),
      })
      .parse(req.body);
    const edition = await getPlatformEdition(cfg(req));
    assertProviderAllowed(edition, body.provider_name);
    for (const code of body.currencies ?? []) assertCurrencyAllowed(edition, code);
    res.json({ gateway: await upsertGateway(cfg(req), body as Parameters<typeof upsertGateway>[1]) });
  } catch (e) { fail(res, e); }
});

// ─── Providers (the ONE canonical credential source, keyed by provider_name) ──
//
// Platform-wide connection settings (Merchant ID, API key, ...) for a
// billing provider — independent of Finance -> Gateways' operational state
// and independent of which provider is currently the default. See
// database/migrations/137_billing_provider_credentials.sql.

adminBillingRouter.get('/providers/:providerName', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    assertProviderAllowed(await getPlatformEdition(cfg(req)), req.params.providerName);
    const credentials = await getProviderCredentials(cfg(req), req.params.providerName);
    res.json({ provider_name: req.params.providerName, config: credentials?.config ?? {} });
  } catch (e) { fail(res, e); }
});

adminBillingRouter.put('/providers/:providerName', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const body = z.object({ config: z.record(z.unknown()) }).parse(req.body);
    assertProviderAllowed(await getPlatformEdition(cfg(req)), req.params.providerName);
    // Credentials of the wrong environment (a live Paddle key on the sandbox
    // gateway, a sandbox key on the live one) are refused with a message the
    // Super Admin can act on; `error` is what the Providers screen shows.
    const problem = getProvider(req.params.providerName)?.validateConfig?.({
      ...body.config,
      provider: req.params.providerName,
    });
    if (problem) return res.status(400).json({ error: problem, code: 'invalid_provider_credentials' });
    const credentials = await upsertProviderCredentials(cfg(req), req.params.providerName, body.config);
    res.json({ provider_name: credentials.provider_name, config: credentials.config });
  } catch (e) { fail(res, e); }
});

/** Platform-wide settings are read for this placeholder workspace (no workspace override applies). */
const NO_WORKSPACE = '00000000-0000-0000-0000-000000000000';

/**
 * The Providers screen's Test button for a billing gateway: runs the
 * gateway's own connection test (testConnection) with the SAVED settings,
 * exactly as a checkout would resolve them. Answers { success, error }; the
 * error is the gateway's own message (a wrong merchant id, a key without a
 * permission), never a secret. ZarinPal's probe uses this platform's app
 * address as the callback, so a domain the terminal does not allow fails here.
 */
adminBillingRouter.post('/providers/:providerName/test', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const config = cfg(req);
    assertProviderAllowed(await getPlatformEdition(config), req.params.providerName);
    const resolved = await resolveNamedBillingConfig(config.supabaseUrl, config.supabaseServiceRoleKey, NO_WORKSPACE, req.params.providerName);
    if (!resolved) return res.status(404).json({ error: 'Unknown provider' });
    const appBase = await resolveAppBaseUrl(config).catch(() => '');
    const probe = /^https:\/\//i.test(appBase) ? { probe_callback_url: `${appBase}/billing` } : {};
    const result = await resolved.provider.testConnection({ ...resolved.config, ...probe, provider: req.params.providerName });
    res.json({ success: result.success, latency_ms: result.latencyMs, ...(result.error ? { error: result.error } : {}) });
  } catch (e) { fail(res, e); }
});
