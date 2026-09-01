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
import { getAiBillingRecoveryStatus } from '../services/ai-billing/recoveryTicker.js';

export const aiBillingRouter = Router();

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

  res.json({ cycleId: cycle, totals, margin, marginPct, runs: runs ?? 0, unresolved: unresolved ?? 0, mode: await getBillingMode(cfg(req)) });
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

  res.json({
    mode: await getBillingMode(cfg(req)),
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

aiBillingRouter.post('/admin/recovery/run', async (req, res) => {
  const report = await runAiBillingRecovery(cfg(req));
  res.json(report);
});
