/**
 * AI RUN CONTEXT — the business-operation boundary of AI billing.
 *
 * A Run is opened by the CALLER (inbound message handling, operator assist,
 * KB job, /api/ai/complete) before any billable provider work, and is carried
 * explicitly through retrieval, embeddings, tool calls, completions and
 * retries. Every provider attempt is a Step; every billable component of that
 * attempt is an immutable usage event.
 *
 * Locked invariants implemented here:
 *  - durable idempotent run creation (operation key + canonical request hash);
 *  - immutable usage ingestion (insert-only, conflicts flagged, never merged);
 *  - pricing snapshot: sell multiplier + billing FX frozen at run start, rate
 *    card + provider-currency FX resolved per usage event;
 *  - METER_ONLY never blocks; ENFORCED resolves pricing before billable work
 *    and never lets a run spend past the reservable balance.
 */

import { createHash } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import * as D from './decimal.js';
import { AiBillingError } from './errors.js';
import { getBillingMode, type BillingMode } from './mode.js';
import { resolveFx, resolveRateCard, resolveSellPolicy, priceComponent } from './rates.js';
import { estimateProviderCost, estimateTokens } from './estimate.js';
import * as ledger from './ledger.js';
import type { NormalizedUsage } from './normalize.js';

/** Fields that must never influence the operation hash. */
const VOLATILE_KEYS = new Set([
  'requestId',
  'request_id',
  'timestamp',
  'createdAt',
  'created_at',
  'now',
  'latencyMs',
  'traceId',
  'attempt',
  'retry',
]);

/** Deterministic canonical JSON of a business payload, volatile fields removed. */
export function canonicalPayload(payload: unknown): string {
  const walk = (v: any): any => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const key of Object.keys(v).sort()) {
        if (VOLATILE_KEYS.has(key)) continue;
        out[key] = walk(v[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(payload));
}

export function operationRequestHash(payload: unknown): string {
  return createHash('sha256').update(canonicalPayload(payload)).digest('hex');
}

export interface AiRunContext {
  runId: string;
  workspaceId: string;
  conversationId: string | null;
  channel: string | null;
  entryPoint: string;
  mode: BillingMode;
  reservationId: string | null;
  sellMultiplier: string;
  /** USD → IRR, frozen for the whole run. */
  billingFxRate: string;
  billingFxId: string | null;
  overagePolicy: 'CAP_AND_ABSORB' | 'HALT_BILLABLE_EXECUTION';
  billingCycleId: string;
  /** running totals, kept as decimal strings */
  totals: { providerCostUsd: D.Dec; internalCostIrr: D.Dec };
  stepSeq: number;
  unresolved: boolean;
  reused: boolean;
}

export function billingCycleId(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface BeginRunArgs {
  workspaceId: string;
  /** Stable business identity: inbound message id, job id, request id. */
  operationKey: string;
  /** Business payload used for the deterministic request hash. */
  payload: unknown;
  entryPoint: string;
  channel?: string | null;
  conversationId?: string | null;
  /** Estimation hints for the initial reservation (ENFORCED only). */
  estimate?: { promptChars: number; maxTokens?: number | null; provider?: string; model?: string };
}

/**
 * Opens (or resumes) the run for one business operation.
 * Same key + same hash → the SAME run resumes. Same key + different hash →
 * `idempotency_conflict`, never a silent reuse.
 */
export async function beginAiRun(config: ServerConfig, args: BeginRunArgs): Promise<AiRunContext> {
  const sb = getServiceClient(config);
  const mode = await getBillingMode(config);
  const hash = operationRequestHash(args.payload);

  const policy = await resolveSellPolicy(config, args.workspaceId);
  const fx = await resolveFx(config, 'USD', 'IRR');

  if (mode === 'ENFORCED') {
    if (!policy) throw new AiBillingError('billing_policy_not_configured', 'No AI sell policy configured', 503);
    if (!fx) throw new AiBillingError('billing_fx_not_configured', 'No USD→IRR exchange rate configured', 503);
  }

  const { data, error } = await sb.rpc('ai_begin_run', {
    p_workspace_id: args.workspaceId,
    p_operation_key: args.operationKey,
    p_request_hash: hash,
    p_entry_point: args.entryPoint,
    p_channel: args.channel ?? null,
    p_conversation_id: args.conversationId ?? null,
    p_mode: mode,
    p_sell_policy_id: policy?.id ?? null,
    p_sell_multiplier: policy?.multiplier ?? null,
    p_fx_id: fx?.id || null,
    p_fx_rate: fx?.rate ?? null,
    p_overage_policy: policy?.overage_policy ?? 'CAP_AND_ABSORB',
  });

  if (error) {
    if (String(error.message || '').includes('idempotency_conflict')) {
      // The SQL audit insert is rolled back with the RAISE that reports the
      // conflict, so the durable audit record is written here, outside that
      // aborted transaction. Best-effort: never mask the conflict itself.
      await sb
        .from('ai_billing_audit_log')
        .insert({
          action: 'idempotency_conflict',
          workspace_id: args.workspaceId,
          details: {
            key: args.operationKey,
            incoming_hash: hash,
            entry_point: args.entryPoint,
          },
        })
        .then(undefined, () => undefined);
      throw new AiBillingError(
        'idempotency_conflict',
        'The same operation key was reused with a different business payload',
        409,
      );
    }
    throw new AiBillingError('billing_internal_error', String(error.message), 500);
  }

  const run: any = Array.isArray(data) ? data[0] : data;

  const ctx: AiRunContext = {
    runId: run.id,
    workspaceId: args.workspaceId,
    conversationId: args.conversationId ?? null,
    channel: args.channel ?? null,
    entryPoint: args.entryPoint,
    mode,
    reservationId: run.reservation_id ?? null,
    sellMultiplier: String(run.sell_multiplier ?? policy?.multiplier ?? '1'),
    billingFxRate: String(run.billing_fx_rate ?? fx?.rate ?? '0'),
    billingFxId: run.billing_fx_id ?? fx?.id ?? null,
    overagePolicy: (run.overage_policy as any) ?? 'CAP_AND_ABSORB',
    billingCycleId: billingCycleId(),
    totals: { providerCostUsd: 0n, internalCostIrr: 0n },
    stepSeq: 0,
    unresolved: run.billing_quality === 'UNRESOLVED',
    reused: run.status !== 'RUNNING' || !!run.reservation_id,
  };

  if (mode === 'ENFORCED' && !ctx.reservationId) {
    await reserveForRun(config, ctx, args.estimate);
  }
  return ctx;
}

async function reserveForRun(
  config: ServerConfig,
  ctx: AiRunContext,
  est?: BeginRunArgs['estimate'],
): Promise<void> {
  let amount = D.fromString('0');
  if (est?.provider && est?.model) {
    const card = await resolveRateCard(config, est.provider, est.model);
    if (!card) throw new AiBillingError('billing_rate_not_configured', `No rate card for ${est.provider}/${est.model}`, 503);
    const providerCost = estimateProviderCost(card, estimateTokens({ promptChars: est.promptChars, maxTokens: est.maxTokens }));
    amount = customerCharge(providerCost, ctx);
  }
  if (amount === 0n) amount = D.fromString('1');

  const res = await ledger.reserve(config, {
    workspaceId: ctx.workspaceId,
    runId: ctx.runId,
    amount: D.toStoredIrr(amount),
    commandKey: `reserve:${ctx.runId}`,
  });
  ctx.reservationId = res.reservation_id;
  if (Number(res.reserved) <= 0) {
    throw new AiBillingError('ai_allowance_exhausted', 'AI balance exhausted for this workspace', 403);
  }
}

/** internal cost (IRR) → customer charge (IRR) using the frozen multiplier. */
function applyMultiplier(internalIrr: D.Dec, ctx: AiRunContext): D.Dec {
  return D.mul(internalIrr, D.fromString(ctx.sellMultiplier || '1'));
}

function customerCharge(providerCostUsd: D.Dec, ctx: AiRunContext): D.Dec {
  const irr = D.mul(providerCostUsd, D.fromString(ctx.billingFxRate || '0'));
  return applyMultiplier(irr, ctx);
}

export interface RecordUsageArgs {
  stepKind: 'COMPLETION' | 'EMBEDDING' | 'RETRIEVAL' | 'TOOL';
  attemptNo?: number;
  usage: NormalizedUsage;
  providerRequestId?: string | null;
  /** Set when this attempt ran on a platform-chosen fallback model. */
  fallbackKind?: 'PLATFORM_FALLBACK' | null;
  /** The model the user actually selected — used for the fallback price cap. */
  userSelectedModel?: string | null;
  succeeded?: boolean;
}

/**
 * Records ONE provider attempt: opens the step, prices each normalized
 * component against the rate card in force right now, and ingests each
 * component as an immutable usage event.
 */
export async function recordStepUsage(
  config: ServerConfig,
  ctx: AiRunContext,
  args: RecordUsageArgs,
): Promise<{ providerCostUsd: string; internalCostIrr: string; ingested: string[] }> {
  const sb = getServiceClient(config);
  ctx.stepSeq += 1;
  const model = args.usage.actualModel || args.usage.requestedModel || 'unknown';

  const { data: stepId, error: stepErr } = await sb.rpc('ai_open_step', {
    p_run_id: ctx.runId,
    p_step_kind: args.stepKind,
    p_step_seq: ctx.stepSeq,
    p_attempt_no: args.attemptNo ?? 1,
    p_provider: args.usage.provider,
    p_requested_model: args.usage.requestedModel,
  });
  if (stepErr) throw new AiBillingError('billing_internal_error', String(stepErr.message), 500);

  const card = await resolveRateCard(config, args.usage.provider, model);
  if (!card) {
    if (ctx.mode === 'ENFORCED') {
      throw new AiBillingError('billing_rate_not_configured', `No rate card for ${args.usage.provider}/${model}`, 503);
    }
    await markUnresolved(config, ctx, 'billing_config_missing');
  }

  const usageFx = card && card.currency !== 'USD' ? await resolveFx(config, card.currency, 'USD') : null;
  if (card && card.currency !== 'USD' && !usageFx) {
    if (ctx.mode === 'ENFORCED') {
      throw new AiBillingError('billing_fx_not_configured', `No ${card.currency}→USD rate`, 503);
    }
    await markUnresolved(config, ctx, 'billing_config_missing');
  }

  let stepProviderUsd = 0n;
  let stepInternalIrr = 0n;
  const ingested: string[] = [];

  for (const comp of args.usage.components) {
    const priced = card ? priceComponent(card, comp.componentType, comp.quantity) : { amount: 0n, matched: false };
    const nativeAmount = priced.amount;
    const usd = usageFx ? D.mul(nativeAmount, D.fromString(usageFx.rate)) : nativeAmount;
    const internalIrr = D.mul(usd, D.fromString(ctx.billingFxRate || '0'));

    const payload = {
      provider: args.usage.provider,
      requested_model: args.usage.requestedModel,
      actual_model: model,
      quantity: comp.quantity,
      unit: comp.unit,
      rate_card_version_id: card?.id ?? '',
      provider_cost_amount: D.toString(nativeAmount),
      provider_cost_currency: card?.currency ?? 'USD',
      usage_fx_id: usageFx?.id ?? '',
      provider_cost_usd: D.toString(usd),
      internal_cost_irr: D.toStoredIrr(internalIrr),
      raw_usage_json: args.usage.raw ?? null,
    };
    const usageEventKey = `${args.stepKind}:${args.attemptNo ?? 1}:${comp.componentType}:${comp.quantity}`;

    const { data: result, error } = await sb.rpc('ai_ingest_usage_event', {
      p_step_id: stepId,
      p_component_type: comp.componentType,
      p_usage_event_key: usageEventKey,
      p_payload: payload,
    });
    if (error) throw new AiBillingError('billing_internal_error', String(error.message), 500);
    ingested.push(String(result));

    if (result === 'INSERTED') {
      stepProviderUsd = D.add(stepProviderUsd, usd);
      stepInternalIrr = D.add(stepInternalIrr, internalIrr);
    }
    if (result === 'CONFLICT') ctx.unresolved = true;
  }

  ctx.totals.providerCostUsd = D.add(ctx.totals.providerCostUsd, stepProviderUsd);
  ctx.totals.internalCostIrr = D.add(ctx.totals.internalCostIrr, stepInternalIrr);

  await sb
    .from('ai_run_steps')
    .update({
      actual_model: model,
      provider_request_id: args.providerRequestId ?? null,
      state: args.succeeded === false ? 'FAILED' : 'SUCCEEDED',
    })
    .eq('id', stepId);

  await sb
    .from('ai_runs')
    .update({
      primary_provider: args.usage.provider,
      primary_model: model,
      status: 'USAGE_RECORDED',
      fallback_kind: args.fallbackKind ?? undefined,
      billing_quality: args.usage.estimated ? 'ESTIMATED' : undefined,
      cost_source: args.usage.estimated ? 'ESTIMATED_TOKENS' : 'PROVIDER_USAGE',
      updated_at: new Date().toISOString(),
    })
    .eq('id', ctx.runId);

  // Fallback price cap: the customer never pays more than the model they chose.
  if (args.fallbackKind === 'PLATFORM_FALLBACK' && args.userSelectedModel) {
    (ctx as any).__fallbackCapModel = args.userSelectedModel;
    (ctx as any).__fallbackUsage = args.usage;
  }

  return {
    providerCostUsd: D.toString(stepProviderUsd),
    internalCostIrr: D.toStoredIrr(stepInternalIrr),
    ingested,
  };
}

async function markUnresolved(config: ServerConfig, ctx: AiRunContext, reason: string): Promise<void> {
  ctx.unresolved = true;
  const sb = getServiceClient(config);
  await sb
    .from('ai_runs')
    .update({ billing_quality: 'UNRESOLVED', unresolved_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', ctx.runId);
}

/**
 * ENFORCED multi-step guard: the next billable step must be funded before it
 * runs. Never absorb-to-keep-spending — an unfunded step simply does not run.
 */
export async function ensureBudgetForNextStep(
  config: ServerConfig,
  ctx: AiRunContext,
  expectedIrr: string,
): Promise<void> {
  if (ctx.mode !== 'ENFORCED') return;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_ai_reservations')
    .select('amount')
    .eq('id', ctx.reservationId ?? '')
    .maybeSingle();
  const reserved = D.fromString(String(data?.amount ?? '0'));
  const needed = D.add(ctx.totals.internalCostIrr, D.fromString(expectedIrr));
  if (needed <= reserved) return;
  const delta = D.sub(needed, reserved);
  const added = await ledger.topupReservation(config, ctx.runId, D.toStoredIrr(delta));
  if (D.fromString(String(added ?? 0)) < delta) {
    throw new AiBillingError('ai_allowance_exhausted', 'AI balance exhausted before the next billable step', 403);
  }
}

/** Final, exactly-once settlement of the run. Safe to call more than once. */
export async function settleAiRun(
  config: ServerConfig,
  ctx: AiRunContext,
): Promise<{ settlementId: string; charged: number; replayed: boolean }> {
  const sb = getServiceClient(config);

  // Recompute totals from the immutable events — never from in-memory state.
  const { data: events } = await sb
    .from('ai_usage_events')
    .select('provider_cost_usd, internal_cost_irr')
    .eq('run_id', ctx.runId);

  let providerUsd = 0n;
  let internalIrr = 0n;
  for (const e of events || []) {
    providerUsd = D.add(providerUsd, D.fromString(String((e as any).provider_cost_usd)));
    internalIrr = D.add(internalIrr, D.fromString(String((e as any).internal_cost_irr)));
  }

  let charge = applyMultiplier(internalIrr, ctx);

  // Platform fallback: cap at the normal-model-equivalent charge.
  const capModel = (ctx as any).__fallbackCapModel as string | undefined;
  const fallbackUsage = (ctx as any).__fallbackUsage as NormalizedUsage | undefined;
  if (capModel && fallbackUsage) {
    const card = await resolveRateCard(config, fallbackUsage.provider, capModel);
    if (card) {
      let capUsd = 0n;
      for (const comp of fallbackUsage.components) {
        capUsd = D.add(capUsd, priceComponent(card, comp.componentType, comp.quantity).amount);
      }
      const capCharge = customerCharge(capUsd, ctx);
      if (capCharge < charge) charge = capCharge;
    }
  }

  await sb
    .from('ai_runs')
    .update({ status: 'SETTLEMENT_PENDING', updated_at: new Date().toISOString() })
    .eq('id', ctx.runId);

  const result = await ledger.settleRun(config, {
    runId: ctx.runId,
    commandKey: `settle:${ctx.runId}`,
    providerCostUsd: D.toString(providerUsd),
    internalCostIrr: D.toStoredIrr(internalIrr),
    customerChargeIrr: D.toStoredIrr(charge),
    billingCycleId: ctx.billingCycleId,
  });

  return {
    settlementId: result.settlement_id,
    charged: Number(result.charged ?? 0),
    replayed: !!result.replayed,
  };
}

/** Terminal failure path: release any reservation, keep the run auditable. */
export async function failAiRun(config: ServerConfig, ctx: AiRunContext, reason: string): Promise<void> {
  const sb = getServiceClient(config);
  if (ctx.reservationId) {
    try {
      await ledger.releaseReservation(config, ctx.reservationId);
    } catch {
      /* recovery worker will expire it */
    }
  }
  await sb
    .from('ai_runs')
    .update({
      status: 'FAILED',
      unresolved_reason: reason.slice(0, 500),
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', ctx.runId);
}
