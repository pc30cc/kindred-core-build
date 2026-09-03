/**
 * AI Usage Billing API.
 *
 *  /api/ai-billing/workspaces/:workspaceId/*  — workspace-facing, final numbers
 *      only. Provider cost, FX and the margin multiplier are NEVER exposed.
 *  /api/ai-billing/admin/*                    — platform super admin only,
 *      every mutation audited, gated by router-level middleware.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess, requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { getWorkspacePlanInfo } from '../middleware/featureGating.js';
import * as ledger from '../services/ai-billing/ledger.js';
import { billingCycleId } from '../services/ai-billing/runContext.js';
import { getBillingMode, setBillingMode } from '../services/ai-billing/mode.js';
import { resetRateCache } from '../services/ai-billing/rates.js';
import { runAiBillingRecovery } from '../services/ai-billing/recovery.js';
import { getBillingDegradation } from '../services/ai-billing/degrade.js';
import { getAiBillingRecoveryStatus } from '../services/ai-billing/recoveryTicker.js';
import { resolveBillingConfig, getProvider } from '../services/billing/index.js';
import { createAiCreditTopupIntent, setPaymentIntentProviderRef, markPaymentIntentFailed, IRAN_PROVIDERS } from '../services/billing/paymentIntent.js';
import { requiresReferenceBinding } from '../services/billing/providerBinding.js';

export const aiBillingRouter = Router();

const DEFAULT_TOPUP_PRESETS_TOMAN = [100_000, 250_000, 500_000, 1_000_000];
const DEFAULT_TOPUP_MIN_TOMAN = 10_000;
const DEFAULT_TOPUP_MAX_TOMAN = 50_000_000;
const TOPUP_CONFIG_KEY = 'ai_credit_topup_config';

interface TopupConfig {
  presetsToman: number[];
  minToman: number;
  maxToman: number;
}

async function getTopupConfig(config: ServerConfig): Promise<TopupConfig> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('app_runtime_config').select('value').eq('key', TOPUP_CONFIG_KEY).maybeSingle();
  const v = (data?.value || {}) as Partial<TopupConfig>;
  return {
    presetsToman: Array.isArray(v.presetsToman) && v.presetsToman.length ? v.presetsToman : DEFAULT_TOPUP_PRESETS_TOMAN,
    minToman: Number.isFinite(v.minToman) ? Number(v.minToman) : DEFAULT_TOPUP_MIN_TOMAN,
    maxToman: Number.isFinite(v.maxToman) ? Number(v.maxToman) : DEFAULT_TOPUP_MAX_TOMAN,
  };
}

function cfg(req: any): ServerConfig {
  return req.serverConfig;
}

function cycleEnd(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Grants the plan's AI allowance for the current cycle exactly once
 * (idempotent by (workspace, cycle, source) both in SQL and by command key).
 */
async function ensureCycleAllowance(config: ServerConfig, workspaceId: string): Promise<void> {
  const info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  const amount = Number((info.limits as any)?.included_ai_allowance_irr ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const cycle = billingCycleId();
  await ledger
    .grantAllowance(config, {
      workspaceId,
      amount: String(amount),
      billingCycleId: cycle,
      allowanceSource: 'plan',
      expiresAt: cycleEnd(),
      commandKey: `grant:${workspaceId}:${cycle}:plan`,
    })
    .catch(() => undefined);
}

// ═══════════════════ Workspace surface ═══════════════════

aiBillingRouter.get('/workspaces/:workspaceId/summary', async (req, res) => {
  const config = cfg(req);
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const workspaceId = req.params.workspaceId;
  const sb = getServiceClient(config);

  await ensureCycleAllowance(config, workspaceId);
  const wallet = await ledger.reconcileWallet(config, workspaceId).catch(() => ({ available: 0, reserved: 0 }));
  const cycle = billingCycleId();

  const { data: lots } = await sb
    .from('workspace_ai_balance_lots')
    .select('source_type, original_amount, remaining_amount, expires_at, state')
    .eq('workspace_id', workspaceId)
    .in('state', ['ACTIVE', 'EXPIRING']);

  const planTotal = (lots || [])
    .filter((l: any) => l.source_type === 'PLAN_ALLOWANCE')
    .reduce((s: number, l: any) => s + Number(l.remaining_amount), 0);
  const purchasedTotal = (lots || [])
    .filter((l: any) => l.source_type !== 'PLAN_ALLOWANCE')
    .reduce((s: number, l: any) => s + Number(l.remaining_amount), 0);
  const grantedTotal = (lots || []).reduce((s: number, l: any) => s + Number(l.original_amount), 0);

  const { data: settlements } = await sb
    .from('ai_run_settlements')
    .select('customer_charge_irr')
    .eq('workspace_id', workspaceId)
    .eq('billing_cycle_id', cycle);
  const usedThisCycle = (settlements || []).reduce((s: number, r: any) => s + Number(r.customer_charge_irr), 0);

  const { count: replyCount } = await sb
    .from('ai_runs')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('created_at', `${cycle}-01T00:00:00Z`);

  res.json({
    currency: 'IRR',
    cycleId: cycle,
    renewsAt: cycleEnd(),
    available: Number(wallet.available || 0),
    reserved: Number(wallet.reserved || 0),
    granted: grantedTotal,
    usedThisCycle,
    planRemaining: planTotal,
    purchasedRemaining: purchasedTotal,
    aiReplies: replyCount ?? 0,
    mode: await getBillingMode(config),
  });
});

// ── AI credit top-up: buy purchased credit through the same server-authoritative
// payment-intent flow subscriptions use. Verification happens through the
// shared POST /api/billing/verify-callback route (same intentId contract).

aiBillingRouter.get('/workspaces/:workspaceId/topup/config', async (req, res) => {
  const config = cfg(req);
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const topup = await getTopupConfig(config);
  res.json({ ...topup, currency: 'IRR', displayCurrency: 'TOMAN' });
});

const topupCheckoutSchema = z.object({
  amountToman: z.number().int().positive(),
  callbackUrl: z.string().url(),
  /** Proforma the customer just confirmed (from /topup/preview) — reused instead of issuing a second one. */
  intentId: z.string().uuid().optional(),
});

const topupPreviewSchema = z.object({
  amountToman: z.number().int().positive(),
});

/**
 * Proforma (پیش‌فاکتور) shown BEFORE the customer is handed to the bank.
 * It is a real payment intent with a unique document number, so the amount
 * displayed is exactly the amount charged and an abandoned proforma stays
 * visible in the transaction history.
 */
aiBillingRouter.post('/workspaces/:workspaceId/topup/preview', async (req, res) => {
  const config = cfg(req);
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const workspaceId = req.params.workspaceId;

  const parsed = topupPreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  const { amountToman } = parsed.data;

  const topup = await getTopupConfig(config);
  if (amountToman < topup.minToman || amountToman > topup.maxToman) {
    return res.status(400).json({ error: `amountToman must be between ${topup.minToman} and ${topup.maxToman}` });
  }

  const resolved = await resolveBillingConfig(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  if (!resolved) return res.status(400).json({ error: 'No billing provider configured' });
  if (!IRAN_PROVIDERS.has(resolved.provider.name)) {
    return res.status(400).json({ error: 'AI credit top-up is not supported for the configured provider' });
  }

  const amountIrr = amountToman * 10;
  const sb = getServiceClient(config);
  try {
    const { data: workspace } = await sb.from('workspaces').select('name').eq('id', workspaceId).maybeSingle();

    // Re-opening the dialog for the SAME amount must show the SAME document
    // number — only a still-usable, unbound, identical intent is reused.
    const { data: reusable } = await sb
      .from('billing_payment_intents')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending')
      .eq('purchase_type', 'ai_credit_topup')
      .eq('amount_irr', amountIrr)
      .eq('provider_name', resolved.provider.name)
      .is('provider_ref', null)
      .not('invoice_number', 'is', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const intent = (reusable as any) || await createAiCreditTopupIntent(config, {
      workspaceId,
      providerName: resolved.provider.name,
      amountIrr,
      workspaceNameSnapshot: (workspace as any)?.name ?? null,
      metadata: { origin: 'topup_preview' },
    });

    res.json({
      invoice: {
        intentId: intent.id,
        invoiceNumber: intent.invoice_number,
        issuedAt: intent.created_at,
        expiresAt: intent.expires_at,
        workspaceName: intent.workspace_name_snapshot || (workspace as any)?.name || null,
        purchaseType: 'ai_credit_topup',
        amountIrr: intent.amount_irr ?? amountIrr,
        discountIrr: intent.discount_irr ?? 0,
        totalIrr: intent.final_amount_irr ?? amountIrr,
        providerName: resolved.provider.name,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

aiBillingRouter.post('/workspaces/:workspaceId/topup/checkout', async (req, res) => {
  const config = cfg(req);
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const workspaceId = req.params.workspaceId;

  const parsed = topupCheckoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  const { amountToman, callbackUrl } = parsed.data;


  const topup = await getTopupConfig(config);
  if (amountToman < topup.minToman || amountToman > topup.maxToman) {
    return res.status(400).json({ error: `amountToman must be between ${topup.minToman} and ${topup.maxToman}` });
  }

  const resolved = await resolveBillingConfig(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  if (!resolved) return res.status(400).json({ error: 'No billing provider configured' });
  if (!IRAN_PROVIDERS.has(resolved.provider.name)) {
    return res.status(400).json({ error: 'AI credit top-up is not supported for the configured provider' });
  }

  const amountIrr = amountToman * 10;
  try {
    // The proforma the customer confirmed is reused so the document number
    // they saw is the one that reaches the bank — never a second one.
    let intent: any = null;
    if (parsed.data.intentId) {
      const { data: existing } = await getServiceClient(config)
        .from('billing_payment_intents')
        .select('*')
        .eq('id', parsed.data.intentId)
        .eq('workspace_id', workspaceId)
        .eq('purchase_type', 'ai_credit_topup')
        .eq('status', 'pending')
        .eq('amount_irr', amountIrr)
        .eq('provider_name', resolved.provider.name)
        .is('provider_ref', null)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      intent = existing || null;
    }
    if (!intent) {
      intent = await createAiCreditTopupIntent(config, {
        workspaceId,
        providerName: resolved.provider.name,
        amountIrr,
      });
    }

    const sep = callbackUrl.includes('?') ? '&' : '?';
    const result = await resolved.provider.createCheckoutSession(resolved.config, {
      workspaceId,
      planId: 'ai_credit_topup',
      interval: 'monthly',
      currency: 'IRR',
      callbackUrl: `${callbackUrl}${sep}intent=${intent.id}&provider=${encodeURIComponent(resolved.provider.name)}`,
      metadata: { amount: String(amountIrr) },
    });
    // Same fail-closed binding rule as the plan checkout: an AI top-up intent
    // that could not be bound to the gateway's reference must not be handed to
    // the customer as a working payment link.
    {
      const ref = result.providerRef || result.authority || result.sessionId || '';
      const bindingRequired = requiresReferenceBinding(resolved.provider.name);
      if (bindingRequired || ref) {
        try {
          await setPaymentIntentProviderRef(config, intent.id, ref);
        } catch (bindError: any) {
          await markPaymentIntentFailed(config, intent.id, String(bindError?.message || 'binding_failed'));
          if (bindingRequired) {
            return res.status(502).json({ error: 'CHECKOUT_REFERENCE_BINDING_FAILED' });
          }
        }
      }
    }
    res.json({ success: true, ...result, intentId: intent.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

aiBillingRouter.get('/workspaces/:workspaceId/history', async (req, res) => {
  const config = cfg(req);
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { data } = await sb
    .from('workspace_ai_ledger')
    .select('id, entry_type, amount, billing_cycle_id, reason, created_at, run_id')
    .eq('workspace_id', req.params.workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);
  res.json({ entries: data || [] });
});

// ═══════════════════ Admin surface ═══════════════════

aiBillingRouter.use('/admin', async (req, res, next) => {
  const adminId = await requirePlatformAdmin(req, res);
  if (!adminId) return;
  (req as any).adminId = adminId;
  next();
});

aiBillingRouter.get('/admin/overview', async (req, res) => {
  const sb = getServiceClient(cfg(req));
  const cycle = billingCycleId();
  const { data: settlements } = await sb
    .from('ai_run_settlements')
    .select('provider_cost_usd, internal_cost_irr, customer_charge_irr, platform_absorbed_amount')
    .eq('billing_cycle_id', cycle)
    .limit(5000);

  const totals = (settlements || []).reduce(
    (acc: any, r: any) => ({
      providerCostUsd: acc.providerCostUsd + Number(r.provider_cost_usd),
      internalCostIrr: acc.internalCostIrr + Number(r.internal_cost_irr),
      customerChargeIrr: acc.customerChargeIrr + Number(r.customer_charge_irr),
      absorbed: acc.absorbed + Number(r.platform_absorbed_amount),
    }),
    { providerCostUsd: 0, internalCostIrr: 0, customerChargeIrr: 0, absorbed: 0 },
  );
  const margin = totals.customerChargeIrr - totals.internalCostIrr;
  const marginPct = totals.customerChargeIrr > 0 ? (margin / totals.customerChargeIrr) * 100 : 0;

  const { count: runs } = await sb.from('ai_runs').select('id', { count: 'exact', head: true });
  const { count: unresolved } = await sb
    .from('ai_runs')
    .select('id', { count: 'exact', head: true })
    .eq('billing_quality', 'UNRESOLVED');

  // ALL-TIME provider spend in USD — what AI has actually cost us since day one.
  // Paged so the total stays exact as settlement volume grows.
  let providerCostUsdAllTime = 0;
  for (let from = 0; ; from += 1000) {
    const { data: page } = await sb
      .from('ai_run_settlements')
      .select('provider_cost_usd')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (!page || page.length === 0) break;
    for (const r of page as any[]) providerCostUsdAllTime += Number(r.provider_cost_usd) || 0;
    if (page.length < 1000) break;
  }

  res.json({
    cycleId: cycle,
    totals,
    providerCostUsdAllTime,
    margin,
    marginPct,
    runs: runs ?? 0,
    unresolved: unresolved ?? 0,
    generatedAt: new Date().toISOString(),
    mode: await getBillingMode(cfg(req)),
  });
});


aiBillingRouter.get('/admin/pricing', async (req, res) => {
  const sb = getServiceClient(cfg(req));
  const [cards, fx, policies] = await Promise.all([
    sb
      .from('ai_rate_cards')
      .select('id, provider, model_key, currency, version, effective_from, effective_to, ai_rate_card_components(component_type, unit, unit_amount, per_units)')
      .order('provider')
      .order('effective_from', { ascending: false })
      .limit(500),
    sb.from('ai_exchange_rates').select('*').order('effective_from', { ascending: false }).limit(200),
    sb.from('ai_sell_policies').select('*').order('effective_from', { ascending: false }).limit(200),
  ]);
  res.json({ rateCards: cards.data || [], exchangeRates: fx.data || [], sellPolicies: policies.data || [] });
});

/**
 * ACTIVE PRICING COVERAGE — the ENFORCED readiness gate.
 *
 * Enumerates every provider/model that runtime can actually bill, next to the
 * rate card in force, the active FX pairs, the customer multiplier and the per
 * plan AI allowance. `missingRates` lists billable paths WITHOUT a valid rate:
 * while it is non-empty the system must NOT be declared READY_FOR_ENFORCED,
 * because those calls could only be billed at zero.
 */
aiBillingRouter.get('/admin/pricing/coverage', async (req, res) => {
  const sb = getServiceClient(cfg(req));
  const nowIso = new Date().toISOString();
  const activeFilter = (qb: any) => qb.lte('effective_from', nowIso).or(`effective_to.is.null,effective_to.gt.${nowIso}`);

  const [cards, fx, policies, models, seenUsage, seenLogs, plans] = await Promise.all([
    activeFilter(
      sb
        .from('ai_rate_cards')
        .select('id, provider, model_key, currency, version, effective_from, effective_to, notes, ai_rate_card_components(component_type, unit, unit_amount, per_units)'),
    ),
    activeFilter(sb.from('ai_exchange_rates').select('id, from_currency, to_currency, rate, version, effective_from, effective_to')),
    activeFilter(sb.from('ai_sell_policies').select('id, scope, workspace_id, multiplier, overage_policy, version, effective_from, effective_to')),
    sb.from('ai_models').select('*'),
    sb.from('ai_usage_events').select('provider, model').limit(5000),
    sb.from('ai_usage_logs').select('provider_name, model').limit(5000),
    sb.from('billing_plans').select('id, name, limits'),
  ]);

  const cardRows = (cards.data || []) as any[];
  const priced = new Set(cardRows.map((c) => `${c.provider}/${c.model_key}`));
  // Every billable path runtime has actually taken, plus the configured catalog.
  const runtimePaths = new Map<string, { provider: string; model: string; source: string }>();
  const add = (provider: string | null, model: string | null, source: string) => {
    if (!provider || !model) return;
    const key = `${provider}/${model}`;
    if (!runtimePaths.has(key)) runtimePaths.set(key, { provider, model, source });
  };
  for (const m of (models.data || []) as any[]) add(m.provider ?? m.provider_name, m.model ?? m.model_key ?? m.name, 'catalog');
  for (const u of (seenUsage.data || []) as any[]) add(u.provider, u.model, 'usage_event');
  for (const l of (seenLogs.data || []) as any[]) add(l.provider_name, l.model, 'legacy_log');

  const paths = [...runtimePaths.values()].map((p) => ({
    ...p,
    priced: priced.has(`${p.provider}/${p.model}`),
  }));
  const missingRates = paths.filter((p) => !p.priced);

  res.json({
    generatedAt: nowIso,
    rateCards: cardRows.map((c) => ({
      provider: c.provider,
      model: c.model_key,
      currency: c.currency,
      version: c.version,
      effectiveFrom: c.effective_from,
      source: c.notes || 'admin',
      components: (c.ai_rate_card_components || []).map((k: any) => ({
        component: k.component_type,
        unit: k.unit,
        unitAmount: k.unit_amount,
        perUnits: k.per_units,
      })),
    })),
    exchangeRates: fx.data || [],
    billingFxUsdToIrr: (fx.data || []).find((r: any) => r.from_currency === 'USD' && r.to_currency === 'IRR') || null,
    sellPolicies: policies.data || [],
    planAllowances: (plans.data || []).map((p: any) => ({
      planId: p.id,
      name: p.name,
      aiAllowance: p.limits?.ai_credits ?? p.limits?.aiCredits ?? p.limits?.ai_allowance ?? null,
    })),
    runtimePaths: paths,
    missingRates,
    readyForEnforced: missingRates.length === 0 && !!(fx.data || []).length && !!(policies.data || []).length,
    currency: 'IRR',
    displayCurrency: 'TOMAN',
  });
});

const rateCardSchema = z.object({
  provider: z.string().min(1).max(80),
  modelKey: z.string().min(1).max(160),
  currency: z.string().min(3).max(8).default('USD'),
  notes: z.string().max(500).optional(),
  components: z
    .array(
      z.object({
        component_type: z.string().min(1).max(60),
        unit: z.string().min(1).max(20).default('TOKEN'),
        unit_amount: z.union([z.string(), z.number()]),
        per_units: z.union([z.string(), z.number()]).default(1_000_000),
      }),
    )
    .min(1),
});

aiBillingRouter.post('/admin/pricing/rate-cards', async (req, res) => {
  const parsed = rateCardSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  const sb = getServiceClient(cfg(req));
  const { data, error } = await sb.rpc('ai_publish_rate_card', {
    p_provider: parsed.data.provider,
    p_model_key: parsed.data.modelKey,
    p_currency: parsed.data.currency,
    p_components: parsed.data.components.map((c) => ({ ...c, unit_amount: String(c.unit_amount), per_units: String(c.per_units) })),
    p_actor: (req as any).adminId,
    p_notes: parsed.data.notes ?? null,
  });
  if (error) return res.status(500).json({ error: error.message });
  resetRateCache();
  res.json({ id: data });
});

/**
 * LIVE FX QUOTES — USD → IRR.
 *
 * Read-only: it never publishes anything. The admin sees the quotes from the
 * public sources and decides which one becomes the billing FX, so an upstream
 * outage or a bad print can never silently reprice the platform.
 *
 * `official` is the central-bank style reference rate, `market` is the free
 * market print most Iranian pricing actually follows.
 */
const FX_SOURCES: { key: string; url: string; kind: 'official' | 'market'; pick: (j: any) => number | null }[] = [
  {
    key: 'open_er_api',
    kind: 'official',
    url: 'https://open.er-api.com/v6/latest/USD',
    pick: (j) => (Number(j?.rates?.IRR) > 0 ? Number(j.rates.IRR) : null),
  },
  {
    key: 'tgju',
    kind: 'market',
    url: 'https://call1.tgju.org/ajax.json',
    // price_dollar_rl is quoted in Rial already.
    pick: (j) => {
      const raw = j?.current?.price_dollar_rl?.p;
      const n = Number(String(raw ?? '').replace(/,/g, ''));
      return Number.isFinite(n) && n > 0 ? n : null;
    },
  },
];

aiBillingRouter.get('/admin/pricing/fx-quotes', async (_req, res) => {
  const quotes = await Promise.all(
    FX_SOURCES.map(async (s) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch(s.url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        const rateIrr = s.pick(json);
        if (!rateIrr) throw new Error('rate_not_found');
        return { source: s.key, kind: s.kind, rateIrr, rateToman: rateIrr / 10, fetchedAt: new Date().toISOString(), ok: true };
      } catch (err: any) {
        return { source: s.key, kind: s.kind, ok: false, error: String(err?.message || err) };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  res.json({ quotes });
});

aiBillingRouter.post('/admin/pricing/exchange-rates', async (req, res) => {

  const schema = z.object({
    from: z.string().min(3).max(8).default('USD'),
    to: z.string().min(3).max(8).default('IRR'),
    rate: z.union([z.string(), z.number()]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  const sb = getServiceClient(cfg(req));
  const { data, error } = await sb.rpc('ai_publish_exchange_rate', {
    p_from: parsed.data.from,
    p_to: parsed.data.to,
    p_rate: String(parsed.data.rate),
    p_actor: (req as any).adminId,
  });
  if (error) return res.status(500).json({ error: error.message });
  resetRateCache();
  res.json({ id: data });
});

aiBillingRouter.post('/admin/pricing/sell-policies', async (req, res) => {
  const schema = z.object({
    scope: z.enum(['GLOBAL', 'WORKSPACE']).default('GLOBAL'),
    workspaceId: z.string().uuid().nullable().optional(),
    multiplier: z.union([z.string(), z.number()]),
    overagePolicy: z.enum(['CAP_AND_ABSORB', 'HALT_BILLABLE_EXECUTION']).default('CAP_AND_ABSORB'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  if (parsed.data.scope === 'WORKSPACE' && !parsed.data.workspaceId) {
    return res.status(400).json({ error: 'workspaceId required for workspace scope' });
  }
  const sb = getServiceClient(cfg(req));
  const { data, error } = await sb.rpc('ai_publish_sell_policy', {
    p_scope: parsed.data.scope,
    p_workspace_id: parsed.data.scope === 'WORKSPACE' ? parsed.data.workspaceId : null,
    p_multiplier: String(parsed.data.multiplier),
    p_overage_policy: parsed.data.overagePolicy,
    p_actor: (req as any).adminId,
  });
  if (error) return res.status(500).json({ error: error.message });
  resetRateCache();
  res.json({ id: data });
});

aiBillingRouter.get('/admin/runs', async (req, res) => {
  const sb = getServiceClient(cfg(req));
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  let q = sb
    .from('ai_runs')
    .select('id, workspace_id, entry_point, channel, status, billing_quality, unresolved_reason, primary_provider, primary_model, provider_cost_usd, internal_cost_irr, customer_charge_irr, platform_absorbed_amount, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (typeof req.query.workspaceId === 'string') q = q.eq('workspace_id', req.query.workspaceId);
  if (typeof req.query.quality === 'string') q = q.eq('billing_quality', req.query.quality);
  const { data } = await q;
  res.json({ runs: data || [] });
});

aiBillingRouter.get('/admin/runs/:runId', async (req, res) => {
  const sb = getServiceClient(cfg(req));
  const [run, steps, events, settlement] = await Promise.all([
    sb.from('ai_runs').select('*').eq('id', req.params.runId).maybeSingle(),
    sb.from('ai_run_steps').select('*').eq('run_id', req.params.runId).order('step_seq'),
    sb.from('ai_usage_events').select('*').eq('run_id', req.params.runId).order('created_at'),
    sb.from('ai_run_settlements').select('*').eq('run_id', req.params.runId).maybeSingle(),
  ]);
  if (!run.data) return res.status(404).json({ error: 'not_found' });
  res.json({ run: run.data, steps: steps.data || [], events: events.data || [], settlement: settlement.data || null });
});

aiBillingRouter.get('/admin/health', async (req, res) => {
  const sb = getServiceClient(cfg(req));
  const [conflicts, unresolved, staleRes, alerts] = await Promise.all([
    sb.from('ai_usage_event_conflicts').select('*').eq('resolved', false).order('created_at', { ascending: false }).limit(100),
    sb
      .from('ai_runs')
      .select('id, workspace_id, unresolved_reason, created_at')
      .eq('billing_quality', 'UNRESOLVED')
      .order('created_at', { ascending: false })
      .limit(100),
    sb.from('workspace_ai_reservations').select('id, workspace_id, amount, expires_at').eq('state', 'ACTIVE').lt('expires_at', new Date().toISOString()).limit(100),
    sb.from('ai_billing_audit_log').select('*').eq('action', 'idempotency_conflict').order('created_at', { ascending: false }).limit(50),
  ]);
  // METER_ONLY validation metrics — coverage/quality of the current cycle.
  const cycle = billingCycleId();
  const [{ count: runsTotal }, { count: runsEstimated }, { count: runsUnresolved }, { count: settledTotal }] =
    await Promise.all([
      sb.from('ai_runs').select('id', { count: 'exact', head: true }).eq('billing_cycle_id', cycle),
      sb.from('ai_runs').select('id', { count: 'exact', head: true }).eq('billing_cycle_id', cycle).eq('billing_quality', 'ESTIMATED'),
      sb.from('ai_runs').select('id', { count: 'exact', head: true }).eq('billing_cycle_id', cycle).eq('billing_quality', 'UNRESOLVED'),
      sb.from('ai_run_settlements').select('run_id', { count: 'exact', head: true }).eq('billing_cycle_id', cycle),
    ]);

  // Live-meter validation checklist — the numbers an operator compares before
  // any ENFORCED decision. All monetary values are IRR (displayed as Toman).
  const nowIso = new Date().toISOString();
  const [
    { count: orphanUsage },
    { count: settlementPending },
    { count: staleReservationCount },
    { count: openConflicts },
    settlements,
    wallets,
  ] = await Promise.all([
    sb.from('ai_usage_events').select('id', { count: 'exact', head: true }).is('run_id', null),
    sb.from('ai_runs').select('id', { count: 'exact', head: true }).in('status', ['USAGE_RECORDED', 'SETTLEMENT_PENDING']),
    sb.from('workspace_ai_reservations').select('id', { count: 'exact', head: true }).eq('state', 'ACTIVE').lt('expires_at', nowIso),
    sb.from('ai_usage_event_conflicts').select('id', { count: 'exact', head: true }).eq('resolved', false),
    sb.from('ai_run_settlements').select('provider_cost_usd, internal_cost_irr, customer_charge_irr, platform_absorbed_amount').eq('billing_cycle_id', cycle),
    sb.from('workspace_ai_wallets').select('workspace_id, available_amount, reserved_amount'),
  ]);
  const { data: lots } = await sb
    .from('workspace_ai_balance_lots')
    .select('workspace_id, remaining_amount, reserved_amount')
    .eq('state', 'ACTIVE');
  const sum = (rows: any[], key: string) => rows.reduce((a, r) => a + Number(r?.[key] ?? 0), 0);
  const settlementRows = settlements.data || [];
  // Wallet projection vs. lot truth — any nonzero drift needs ai_reconcile_wallet.
  const lotTruth = new Map<string, { available: number; reserved: number }>();
  for (const l of lots || []) {
    const key = (l as any).workspace_id as string;
    const cur = lotTruth.get(key) || { available: 0, reserved: 0 };
    cur.available += Number((l as any).remaining_amount ?? 0) - Number((l as any).reserved_amount ?? 0);
    cur.reserved += Number((l as any).reserved_amount ?? 0);
    lotTruth.set(key, cur);
  }
  const walletMismatch = (wallets.data || []).filter((w: any) => {
    const truth = lotTruth.get(w.workspace_id) || { available: 0, reserved: 0 };
    return (
      Math.abs(Number(w.available_amount ?? 0) - truth.available) > 0.000001 ||
      Math.abs(Number(w.reserved_amount ?? 0) - truth.reserved) > 0.000001
    );
  }).length;

  res.json({
    mode: await getBillingMode(cfg(req)),
    degradation: getBillingDegradation(),
    validationChecklist: {
      cycleId: cycle,
      orphanUsageEvents: orphanUsage ?? 0,
      ingestionConflictsOpen: openConflicts ?? 0,
      unresolvedRuns: runsUnresolved ?? 0,
      staleReservations: staleReservationCount ?? 0,
      settlementPendingRuns: settlementPending ?? 0,
      reconciliationMismatchWallets: walletMismatch,
      walletsTracked: (wallets.data || []).length,
      providerCostUsdTotal: sum(settlementRows, 'provider_cost_usd'),
      internalCostIrrTotal: sum(settlementRows, 'internal_cost_irr'),
      theoreticalCustomerChargeIrrTotal: sum(settlementRows, 'customer_charge_irr'),
      platformAbsorbedIrrTotal: sum(settlementRows, 'platform_absorbed_amount'),
      currency: 'IRR',
      displayCurrency: 'TOMAN',
    },
    ingestionConflicts: conflicts.data || [],
    unresolvedRuns: unresolved.data || [],
    staleReservations: staleRes.data || [],
    idempotencyConflicts: alerts.data || [],
    recoveryScheduler: getAiBillingRecoveryStatus(),
    meterOnlyMetrics: {
      cycleId: cycle,
      runsTotal: runsTotal ?? 0,
      runsSettled: settledTotal ?? 0,
      runsEstimated: runsEstimated ?? 0,
      runsUnresolved: runsUnresolved ?? 0,
      settlementCoverage: runsTotal ? Number(((settledTotal ?? 0) / runsTotal).toFixed(4)) : 1,
    },
  });
});

aiBillingRouter.post('/admin/mode', async (req, res) => {
  const schema = z.object({ mode: z.enum(['METER_ONLY', 'ENFORCED']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_mode' });
  await setBillingMode(cfg(req), parsed.data.mode);
  const sb = getServiceClient(cfg(req));
  await sb.from('ai_billing_audit_log').insert({
    actor_id: (req as any).adminId,
    action: 'set_billing_mode',
    details: { mode: parsed.data.mode },
  });
  res.json({ mode: parsed.data.mode });
});

aiBillingRouter.post('/admin/workspaces/:workspaceId/credit', async (req, res) => {
  const schema = z.object({
    amount: z.union([z.string(), z.number()]),
    reason: z.string().min(1).max(300),
    kind: z.enum(['PURCHASE', 'ADJUSTMENT']).default('ADJUSTMENT'),
    commandKey: z.string().min(6).max(120),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  const workspaceId = req.params.workspaceId;
  try {
    const id =
      parsed.data.kind === 'PURCHASE'
        ? await ledger.purchaseCredit(cfg(req), {
            workspaceId,
            amount: String(parsed.data.amount),
            commandKey: parsed.data.commandKey,
            reason: parsed.data.reason,
          })
        : await ledger.adjustBalance(cfg(req), {
            workspaceId,
            amount: String(parsed.data.amount),
            reason: parsed.data.reason,
            commandKey: parsed.data.commandKey,
            actorId: (req as any).adminId,
          });
    res.json({ id });
  } catch (err: any) {
    res.status(err?.httpStatus || 500).json({ error: err?.code || 'billing_internal_error' });
  }
});

aiBillingRouter.post('/admin/runs/:runId/refund', async (req, res) => {
  const schema = z.object({
    amount: z.union([z.string(), z.number()]),
    reason: z.string().min(1).max(300),
    commandKey: z.string().min(6).max(120),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  try {
    const result = await ledger.refundRun(cfg(req), {
      runId: req.params.runId,
      amount: String(parsed.data.amount),
      reason: parsed.data.reason,
      commandKey: parsed.data.commandKey,
      actorId: (req as any).adminId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(err?.httpStatus || 500).json({ error: err?.code || 'billing_internal_error', message: err?.message });
  }
});

aiBillingRouter.get('/admin/topup-config', async (req, res) => {
  res.json(await getTopupConfig(cfg(req)));
});

const topupConfigSchema = z.object({
  presetsToman: z.array(z.number().int().positive()).min(1).max(12),
  minToman: z.number().int().positive(),
  maxToman: z.number().int().positive(),
});

aiBillingRouter.put('/admin/topup-config', async (req, res) => {
  const parsed = topupConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten().fieldErrors });
  if (parsed.data.minToman >= parsed.data.maxToman) {
    return res.status(400).json({ error: 'minToman must be less than maxToman' });
  }
  const sb = getServiceClient(cfg(req));
  const { error } = await sb
    .from('app_runtime_config')
    .upsert({ key: TOPUP_CONFIG_KEY, value: parsed.data, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  res.json(parsed.data);
});

aiBillingRouter.post('/admin/recovery/run', async (req, res) => {
  const report = await runAiBillingRecovery(cfg(req));
  res.json(report);
});
