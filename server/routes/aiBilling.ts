/**
 * AI Usage Billing API.
 *
 *  /api/ai-billing/workspaces/:workspaceId/history — workspace-facing, final
 *      numbers only. Provider cost, FX and the margin multiplier are NEVER
 *      exposed. (The balance, its packs and the monthly credit are the simple
 *      billing's: /api/billing/account/:workspaceId/ai. Billing v2's summary
 *      and Rial top-up routes were removed in phase 7.)
 *  /api/ai-billing/admin/*                    — platform super admin only,
 *      every mutation audited, gated by router-level middleware.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess, requirePlatformAdmin, serverConfigOf } from '../lib/workspaceAuth.js';
import * as ledger from '../services/ai-billing/ledger.js';
import { billingCycleId } from '../services/ai-billing/runContext.js';
import { getBillingMode, setBillingMode } from '../services/ai-billing/mode.js';
import { resetRateCache } from '../services/ai-billing/rates.js';
import { runAiBillingRecovery } from '../services/ai-billing/recovery.js';
import { getBillingDegradation } from '../services/ai-billing/degrade.js';
import { getAiBillingRecoveryStatus } from '../services/ai-billing/recoveryTicker.js';
import { editionErrorResponse, getPlatformEdition } from '../services/billing/edition.js';
import { isCurrencyAllowedInEdition } from '../../shared/edition.js';
import { planAiAllowance } from '../../shared/planLimits.js';

export const aiBillingRouter = Router();

/** What the admin gate below attaches to the request. */
interface AdminRequestContext {
  adminId?: string;
}

/** Fields read from a thrown error (AiBillingError, DB and network errors). */
interface ThrownErrorShape {
  message?: string;
  code?: string;
  httpStatus?: number;
}

/** PostgREST returns `numeric` columns as a number or a string. */
type DbNumeric = number | string;

function cfg(req: object): ServerConfig {
  return serverConfigOf(req);
}

function adminIdOf(req: object): string | undefined {
  return (req as AdminRequestContext).adminId;
}

/** The current UTC calendar month, the cycle the admin health counts read. */
function cycleStart(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function cycleEnd(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

// ═══════════════════ Workspace surface ═══════════════════

aiBillingRouter.get('/workspaces/:workspaceId/history', async (req, res) => {
  const config = cfg(req);
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const { data, count } = await sb
    .from('workspace_ai_ledger')
    .select('id, entry_type, amount, billing_cycle_id, reason, created_at, run_id', { count: 'exact' })
    .eq('workspace_id', req.params.workspaceId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  res.json({ entries: data || [], total: count ?? 0, limit, offset });
});


// ═══════════════════ Admin surface ═══════════════════

aiBillingRouter.use('/admin', async (req, res, next) => {
  const adminId = await requirePlatformAdmin(req, res);
  if (!adminId) return;
  (req as AdminRequestContext).adminId = adminId;
  next();
});

interface SettlementCostRow {
  provider_cost_usd: DbNumeric;
  internal_cost_irr: DbNumeric;
  customer_charge_irr: DbNumeric;
  platform_absorbed_amount: DbNumeric;
}

interface SettlementTotals {
  providerCostUsd: number;
  internalCostIrr: number;
  customerChargeIrr: number;
  absorbed: number;
}

aiBillingRouter.get('/admin/overview', async (req, res) => {
  const sb = getServiceClient(cfg(req));
  const cycle = billingCycleId();
  const { data: settlements } = await sb
    .from('ai_run_settlements')
    .select('provider_cost_usd, internal_cost_irr, customer_charge_irr, platform_absorbed_amount')
    .eq('billing_cycle_id', cycle)
    .limit(5000);

  const totals = (settlements || []).reduce(
    (acc: SettlementTotals, r: SettlementCostRow): SettlementTotals => ({
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
    for (const r of page as Pick<SettlementCostRow, 'provider_cost_usd'>[]) providerCostUsdAllTime += Number(r.provider_cost_usd) || 0;
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

/** A query builder whose filters return the builder itself. */
interface EffectiveDatedQuery<Q> {
  lte(column: string, value: string): Q;
  or(filters: string): Q;
}

interface RateCardComponentRow {
  component_type: string;
  unit: string;
  unit_amount: DbNumeric;
  per_units: DbNumeric;
}

interface RateCardRow {
  provider: string;
  model_key: string;
  currency: string;
  version: number;
  effective_from: string;
  notes: string | null;
  ai_rate_card_components: RateCardComponentRow[] | null;
}

/** ai_models is read with `*`; each of these column names is accepted. */
interface AiModelRow {
  provider?: string | null;
  provider_name?: string | null;
  model?: string | null;
  model_key?: string | null;
  name?: string | null;
}

interface UsageEventPathRow {
  provider: string | null;
  requested_model: string | null;
  actual_model: string | null;
}

interface UsageLogPathRow {
  provider_name: string | null;
  model: string | null;
}

interface PlanAllowanceRow {
  id: string;
  name: string;
  limits: Record<string, unknown> | null;
  ai_allowance: Record<string, unknown> | null;
}

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
  const activeFilter = <Q extends EffectiveDatedQuery<Q>>(qb: Q): Q =>
    qb.lte('effective_from', nowIso).or(`effective_to.is.null,effective_to.gt.${nowIso}`);

  const [cards, fx, policies, models, seenUsage, seenLogs, plans] = await Promise.all([
    activeFilter(
      sb
        .from('ai_rate_cards')
        .select('id, provider, model_key, currency, version, effective_from, effective_to, notes, ai_rate_card_components(component_type, unit, unit_amount, per_units)'),
    ),
    activeFilter(sb.from('ai_exchange_rates').select('id, from_currency, to_currency, rate, version, effective_from, effective_to')),
    activeFilter(sb.from('ai_sell_policies').select('id, scope, workspace_id, multiplier, overage_policy, version, effective_from, effective_to')),
    sb.from('ai_models').select('*'),
    // priced by the model that actually ran (runContext: actualModel, else
    // requestedModel) — ai_usage_events has no `model` column
    sb.from('ai_usage_events').select('provider, requested_model, actual_model').limit(5000),
    sb.from('ai_usage_logs').select('provider_name, model').limit(5000),
    sb.from('billing_plans').select('id, name, limits, ai_allowance'),
  ]);

  const cardRows = (cards.data || []) as RateCardRow[];
  const priced = new Set(cardRows.map((c) => `${c.provider}/${c.model_key}`));
  // Every billable path runtime has actually taken, plus the configured catalog.
  const runtimePaths = new Map<string, { provider: string; model: string; source: string }>();
  const add = (provider: string | null, model: string | null, source: string) => {
    if (!provider || !model) return;
    const key = `${provider}/${model}`;
    if (!runtimePaths.has(key)) runtimePaths.set(key, { provider, model, source });
  };
  for (const m of (models.data || []) as AiModelRow[]) add(m.provider ?? m.provider_name, m.model ?? m.model_key ?? m.name, 'catalog');
  for (const u of (seenUsage.data || []) as UsageEventPathRow[]) add(u.provider, u.actual_model || u.requested_model, 'usage_event');
  for (const l of (seenLogs.data || []) as UsageLogPathRow[]) add(l.provider_name, l.model, 'legacy_log');

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
      components: (c.ai_rate_card_components || []).map((k) => ({
        component: k.component_type,
        unit: k.unit,
        unitAmount: k.unit_amount,
        perUnits: k.per_units,
      })),
    })),
    exchangeRates: fx.data || [],
    billingFxUsdToIrr:
      (fx.data || []).find((r: { from_currency: string; to_currency: string }) => r.from_currency === 'USD' && r.to_currency === 'IRR') || null,
    sellPolicies: policies.data || [],
    planAllowances: (plans.data || []).map((p: PlanAllowanceRow) => ({
      planId: p.id,
      name: p.name,
      // The monthly grant's own source (billing_plan_ai_allowance), in the wallet's unit (IRR).
      aiAllowance: planAiAllowance(p),
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
    p_actor: adminIdOf(req),
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
const FX_SOURCES: { key: string; url: string; kind: 'official' | 'market'; pick: (j: unknown) => number | null }[] = [
  {
    key: 'open_er_api',
    kind: 'official',
    url: 'https://open.er-api.com/v6/latest/USD',
    pick: (j) => {
      const quote = j as { rates?: { IRR?: unknown } } | null;
      return Number(quote?.rates?.IRR) > 0 ? Number(quote.rates.IRR) : null;
    },
  },
  {
    key: 'tgju',
    kind: 'market',
    url: 'https://call1.tgju.org/ajax.json',
    // price_dollar_rl is quoted in Rial already.
    pick: (j) => {
      const raw = (j as { current?: { price_dollar_rl?: { p?: unknown } } } | null)?.current?.price_dollar_rl?.p;
      const n = Number(String(raw ?? '').replace(/,/g, ''));
      return Number.isFinite(n) && n > 0 ? n : null;
    },
  },
];

aiBillingRouter.get('/admin/pricing/fx-quotes', async (req, res) => {
  // USD→Rial market quotes (Iranian sources) belong to the Iranian edition.
  try {
    if ((await getPlatformEdition(cfg(req))) !== 'iran') return res.json({ quotes: [] });
  } catch (e) {
    const answer = editionErrorResponse(e);
    return res.status(answer?.status ?? 500).json(answer?.body ?? { error: 'edition_read_failed' });
  }
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
      } catch (err) {
        return { source: s.key, kind: s.kind, ok: false, error: String((err as ThrownErrorShape)?.message || err) };
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
  try {
    const edition = await getPlatformEdition(cfg(req));
    if (!isCurrencyAllowedInEdition(parsed.data.from, edition) || !isCurrencyAllowedInEdition(parsed.data.to, edition)) {
      return res.status(400).json({ error: 'CURRENCY_NOT_AVAILABLE_IN_EDITION' });
    }
  } catch (e) {
    const answer = editionErrorResponse(e);
    return res.status(answer?.status ?? 500).json(answer?.body ?? { error: 'edition_read_failed' });
  }
  const sb = getServiceClient(cfg(req));
  const { data, error } = await sb.rpc('ai_publish_exchange_rate', {
    p_from: parsed.data.from,
    p_to: parsed.data.to,
    p_rate: String(parsed.data.rate),
    p_actor: adminIdOf(req),
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
    p_actor: adminIdOf(req),
  });
  if (error) return res.status(500).json({ error: error.message });
  resetRateCache();
  res.json({ id: data });
});

/** An ai_runs row as listed below; every selected column is passed through. */
interface AiRunListRow {
  workspace_id: string | null;
  [column: string]: unknown;
}

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
  const rows = data || [];
  const wsIds = Array.from(new Set(rows.map((r: AiRunListRow) => r.workspace_id).filter(Boolean)));
  let nameById = new Map<string, string>();
  if (wsIds.length) {
    const { data: ws } = await sb.from('workspaces').select('id, name, slug').in('id', wsIds);
    nameById = new Map((ws || []).map((w: { id: string; name: string | null; slug: string | null }) => [w.id, w.name || w.slug || '']));
  }
  res.json({ runs: rows.map((r: AiRunListRow) => ({ ...r, workspace_name: nameById.get(r.workspace_id) || null })) });
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

/** A query builder whose filters return the builder itself. */
interface CreatedAtRangeQuery<Q> {
  gte(column: string, value: string): Q;
  lt(column: string, value: string): Q;
}

interface WalletLotRow {
  workspace_id: string;
  remaining_amount: DbNumeric;
  reserved_amount: DbNumeric;
}

interface WalletRow {
  workspace_id: string;
  available_amount: DbNumeric;
  reserved_amount: DbNumeric;
}

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
  // ai_runs has no billing_cycle_id column (asking for it failed every count,
  // so these read 0): a run's cycle is the UTC month it began in
  // (billingCycleId at beginRun), so the cycle's runs are those created in it.
  const cycle = billingCycleId();
  const inCycle = <Q extends CreatedAtRangeQuery<Q>>(qb: Q): Q => qb.gte('created_at', cycleStart()).lt('created_at', cycleEnd());
  const [{ count: runsTotal }, { count: runsEstimated }, { count: runsUnresolved }, { count: settledTotal }] =
    await Promise.all([
      inCycle(sb.from('ai_runs').select('id', { count: 'exact', head: true })),
      inCycle(sb.from('ai_runs').select('id', { count: 'exact', head: true })).eq('billing_quality', 'ESTIMATED'),
      inCycle(sb.from('ai_runs').select('id', { count: 'exact', head: true })).eq('billing_quality', 'UNRESOLVED'),
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
  const sum = (rows: SettlementCostRow[], key: keyof SettlementCostRow) => rows.reduce((a, r) => a + Number(r?.[key] ?? 0), 0);
  const settlementRows = settlements.data || [];
  // Wallet projection vs. lot truth — any nonzero drift needs ai_reconcile_wallet.
  const lotTruth = new Map<string, { available: number; reserved: number }>();
  for (const l of (lots || []) as WalletLotRow[]) {
    const key = l.workspace_id;
    const cur = lotTruth.get(key) || { available: 0, reserved: 0 };
    cur.available += Number(l.remaining_amount ?? 0) - Number(l.reserved_amount ?? 0);
    cur.reserved += Number(l.reserved_amount ?? 0);
    lotTruth.set(key, cur);
  }
  const walletMismatch = (wallets.data || []).filter((w: WalletRow) => {
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
    actor_id: adminIdOf(req),
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
            actorId: adminIdOf(req),
          });
    res.json({ id });
  } catch (err) {
    const e = err as ThrownErrorShape;
    res.status(e?.httpStatus || 500).json({ error: e?.code || 'billing_internal_error' });
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
      actorId: adminIdOf(req),
    });
    res.json(result);
  } catch (err) {
    const e = err as ThrownErrorShape;
    res.status(e?.httpStatus || 500).json({ error: e?.code || 'billing_internal_error', message: e?.message });
  }
});

aiBillingRouter.post('/admin/recovery/run', async (req, res) => {
  const report = await runAiBillingRecovery(cfg(req));
  res.json(report);
});
