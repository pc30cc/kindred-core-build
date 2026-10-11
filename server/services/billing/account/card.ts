// ============================================================================
// SIMPLE BILLING — the saved card that renews a Multi Region plan (phase 3b,
// docs/billing/SIMPLE_BILLING.md; migration 262).
//
// A saved card is a Paddle subscription with one recurring price we set.
// Paddle's clock charges it; we only move that clock (the end of the last
// paid period − CARD_RENEWAL_LEAD_MS) and that price (the next period's), and
// only with calls that never bill (P4). Each charge Paddle makes comes in as
// a payment row (billing_card_record_charge) and is settled by one SQL
// transaction (billing_card_settle): credited to the balance, then spent on
// the renewal or upgrade, or kept in the balance for review (P1).
//
//   - setup: a Paddle checkout with a recurring price (prepareCardSetup);
//     Paddle's subscription.created registers the card (activateCard);
//   - events: everything Paddle reports about our subscriptions
//     (cardEventOwner, handleCardEvent), acted on only through our own card
//     row or our own card_setup payment, never custom_data alone (P6);
//   - the reconciler: syncCard moves Paddle to desiredCardState()
//     (cardState.ts), after every billing action and from the job;
//   - customer actions: an upgrade charged to the card (the only call that
//     bills, once per payment row), auto-renew off/on, remove, change card,
//     and "renew from balance" while a card is saved. Stop actions ask Paddle
//     first and change the database after (P7).
//
// Nothing here runs outside the International edition: every way in starts
// from a card row, and cards are only created from an eligible checkout
// (cardAvailability). Logs: [billing-card]; anything a person must look at
// starts with REVIEW.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { resolveNamedBillingConfig } from '../index.js';
import { getBillingRegion } from '../edition.js';
import { isRelationMissing } from '../entitlementParse.js';
import {
  buildChargeItem,
  buildRecurringItem,
  cancelSubscriptionAt,
  cardAutoRenewEnabled,
  clearScheduledChange,
  clientCheckoutFor,
  createCharge,
  getSubscription,
  getTransaction,
  getUpdatePaymentMethodTransaction,
  listSubscriptionTransactions,
  paddleConfigFor,
  previewCharge,
  previewSubscriptionUpdate,
  updateSubscription,
  type PaddleResult,
  type SubscriptionPatch,
} from '../providers/paddleSubscriptions.js';
import type {
  BillingProviderConfig,
  PaddleCardDetails,
  PaddleSubscription,
  PaddleTransaction,
  WebhookEvent,
} from '../types.js';
import {
  CARD_ACTIVATION_RECOVERY_MS,
  CARD_CHARGE_GIVE_UP_MS,
  CARD_CHARGE_RESOLVE_AFTER_MS,
  CARD_CURRENCIES,
  CARD_FREEZE_MAX_AFTER_MS,
  CARD_RENEWAL_LEAD_MS,
  CARD_SETUP_HOLD_MS,
  CARD_SYNC_DATE_TOLERANCE_MS,
  PADDLE_MIN_CHARGE_MINOR,
  chargeFor,
  vatPercentFor,
  type CardStatus,
} from '../../../../shared/simpleBilling.js';
import {
  AccountBillingError,
  failAccountPayment,
  getBillingSettings,
  patchAccountPayment,
  readAccount,
  readAccountPayment,
  verifyAccountPayment,
  type AccountPaymentRow,
  type SettleResult,
  type VerifyOutcome,
} from './index.js';
import { accountGateways, type GatewayViewer } from './gateways.js';
import { localizedPlanName, planNamesFor, sendBillingEmail, type BillingEmailSlug } from './notify.js';
import {
  cardFreeze,
  chargeDateFor,
  desiredCardState,
  lastPaidEnd,
  ownRenewalFreeze,
  periodEndOf,
  setupHoldFrom,
  type CardStateInput,
  type DesiredCardState,
} from './cardState.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CardRow {
  id: string;
  workspace_id: string;
  provider: string;
  subscription_id: string;
  customer_id: string | null;
  currency: string;
  setup_payment_id: string | null;
  status: CardStatus;
  cancel_reason: string | null;
  cancel_intent: 'period_end' | 'now' | null;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  paddle_status: string | null;
  paddle_next_billed_at: string | null;
  paddle_scheduled_change: Record<string, unknown> | null;
  paddle_item: Record<string, unknown> | null;
  sync_version: number;
  synced_version: number;
  synced_at: string | null;
  sync_error: string | null;
  sync_failures: number;
  next_sync_at: string;
  last_failure: { at: string; code: string | null; txn?: string } | null;
  created_at: string;
  updated_at: string;
  canceled_at: string | null;
}

export interface CardView {
  id: string;
  provider: string;
  status: 'active' | 'past_due';
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  auto_renew: boolean;
  /** Mirrored paddle_next_billed_at; null when a cancel is scheduled. */
  next_charge_at: string | null;
  /** What the next renewal charges (the desired item's total), else null. */
  next_charge_minor: number | null;
  next_charge_plan: { plan_id: string; name: string; localized: Record<string, unknown> } | null;
  next_charge_interval: 'monthly' | 'yearly' | null;
  /** A scheduled cancel's effective time (auto-renew off). */
  scheduled_cancel_at: string | null;
  last_failure: { at: string; code: string | null } | null;
  /** Until when plan changes are frozen around a renewal (Paddle's charge, or the one our period expects). */
  frozen_until: string | null;
  expires_before_next_charge: boolean;
  /** The card's gateway still has automatic card renewal on: an upgrade can be charged to it. */
  chargeable: boolean;
}

export interface CardAvailability {
  available: boolean;
  providers: string[];
  reason?: string;
}

export type CardEventOwner = { workspaceId: string; cardId: string | null; setupPaymentId: string | null };

export type SyncOutcome = { status: 'synced' | 'unchanged' | 'deferred' | 'canceled' | 'error'; detail?: string };

export interface CardJobReport {
  synced: number;
  activated: number;
  charges: number;
  canceled: number;
  pulled: number;
  errors: string[];
}

/** A payment row, with its card columns (source, card_id, charge_requested_at, review: migration 262). */
type CardPayment = AccountPaymentRow;

// ─── Small helpers ─────────────────────────────────────────────────────────

const CARD_PROVIDERS = new Set(['paddle', 'paddle_sandbox']);
const PAID = new Set(['paid', 'completed']);
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** How far Paddle's period may run past ours before a renewal is suspected we have not recorded. */
const PADDLE_AHEAD_SLACK_MS = DAY_MS;
/** Paddle refuses changes to a subscription in the 30 minutes before its charge. */
const PADDLE_LOCK_MS = 30 * MINUTE_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Errors 262's functions raise that mean "not this way" rather than "try again". */
const CARD_SQL_ERRORS = [
  'billing_card_setup_invalid',
  'billing_card_conflict',
  'billing_account_currency_mismatch',
  'billing_card_status_invalid',
  'billing_card_not_found',
  'billing_card_charge_amount_invalid',
  'billing_payment_reference_missing',
  'billing_card_workspace_missing',
  'billing_payment_reference_mismatch',
  'billing_payment_amount_mismatch',
  'billing_payment_currency_mismatch',
  'billing_payment_reference_reused',
] as const;
type CardSqlError = (typeof CARD_SQL_ERRORS)[number];

function sqlCode(error: { message?: string } | null | undefined): CardSqlError | null {
  const message = error?.message || '';
  return CARD_SQL_ERRORS.find((code) => message.includes(code)) ?? null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const isLive = (card: Pick<CardRow, 'status'>): boolean => card.status === 'active' || card.status === 'past_due';

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function rowOf(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
}

function toCard(row: Record<string, unknown>): CardRow {
  const failure = asRecord(row.last_failure);
  const status = String(row.status) as CardStatus;
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    provider: String(row.provider),
    subscription_id: String(row.subscription_id),
    customer_id: str(row.customer_id),
    currency: String(row.currency),
    setup_payment_id: str(row.setup_payment_id),
    status,
    cancel_reason: str(row.cancel_reason),
    cancel_intent: row.cancel_intent === 'period_end' || row.cancel_intent === 'now' ? row.cancel_intent : null,
    brand: str(row.brand),
    last4: str(row.last4),
    exp_month: intOrNull(row.exp_month),
    exp_year: intOrNull(row.exp_year),
    paddle_status: str(row.paddle_status),
    paddle_next_billed_at: str(row.paddle_next_billed_at),
    paddle_scheduled_change: row.paddle_scheduled_change ? asRecord(row.paddle_scheduled_change) : null,
    paddle_item: row.paddle_item ? asRecord(row.paddle_item) : null,
    sync_version: num(row.sync_version),
    synced_version: num(row.synced_version),
    synced_at: str(row.synced_at),
    sync_error: str(row.sync_error),
    sync_failures: num(row.sync_failures),
    next_sync_at: String(row.next_sync_at ?? ''),
    last_failure: row.last_failure
      ? { at: String(failure.at ?? ''), code: str(failure.code), ...(str(failure.txn) ? { txn: String(failure.txn) } : {}) }
      : null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    canceled_at: str(row.canceled_at),
  };
}

function priceOf(prices: unknown, currency: string, interval: string): number | null {
  const byCurrency = (prices as Record<string, Record<string, unknown>> | null)?.[currency.toUpperCase()];
  const raw = Number(byCurrency?.[interval]);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
}

const asInterval = (v: unknown): 'monthly' | 'yearly' => (v === 'yearly' || v === 'year' ? 'yearly' : 'monthly');

// ─── Reading cards ─────────────────────────────────────────────────────────

/**
 * The workspace's live card (active or past_due; at most one), or null. A
 * database without migration 262 has no card: the plan actions and the due
 * step that ask first keep working while a deploy's migrator has not run yet.
 */
export async function readLiveCard(config: ServerConfig, workspaceId: string): Promise<CardRow | null> {
  const { data, error } = await getServiceClient(config)
    .from('billing_account_cards')
    .select('*')
    .eq('workspace_id', workspaceId)
    .in('status', ['active', 'past_due'])
    .maybeSingle();
  if (error) {
    if (isRelationMissing(error, 'billing_account_cards')) return null;
    throw new Error(error.message || 'card read failed');
  }
  return data ? toCard(data as Record<string, unknown>) : null;
}

export async function readCard(config: ServerConfig, cardId: string): Promise<CardRow | null> {
  if (!UUID.test(cardId)) return null;
  const { data, error } = await getServiceClient(config)
    .from('billing_account_cards')
    .select('*')
    .eq('id', cardId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'card read failed');
  return data ? toCard(data as Record<string, unknown>) : null;
}

/** Writes what we learned about a card (its details, Paddle's state); never the reconciler's version. */
async function patchCard(config: ServerConfig, cardId: string, patch: Record<string, unknown>): Promise<void> {
  if (!Object.keys(patch).length) return;
  const { error } = await getServiceClient(config)
    .from('billing_account_cards')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', cardId);
  if (error) throw new Error(error.message || 'card update failed');
}

async function setCardStatus(config: ServerConfig, cardId: string, status: CardStatus, reason: string | null = null): Promise<Record<string, unknown>> {
  const { data, error } = await getServiceClient(config).rpc('billing_card_set_status', {
    p_card_id: cardId,
    p_status: status,
    p_reason: reason,
  });
  if (error) {
    // A canceling card does not become live again; anything else is a real failure.
    if (sqlCode(error) === 'billing_card_status_invalid') {
      console.warn(`[billing-card] card=${cardId} cannot move to ${status}`);
      return {};
    }
    throw new Error(error.message || 'card status update failed');
  }
  return asRecord(data);
}

/** The reconciler's compare-and-set write (billing_card_mark_synced). */
async function markSynced(
  config: ServerConfig,
  cardId: string,
  version: number,
  mirror: Record<string, unknown>,
  error: string | null = null,
): Promise<boolean> {
  const { data, error: rpcError } = await getServiceClient(config).rpc('billing_card_mark_synced', {
    p_card_id: cardId,
    p_version: version,
    p_mirror: mirror,
    p_error: error,
  });
  if (rpcError) throw new Error(rpcError.message || 'card sync record failed');
  return data === true;
}

/** What Paddle shows, in the card row's mirror columns. */
function mirrorOf(sub: PaddleSubscription): Record<string, unknown> {
  const item = sub.items[0] ?? null;
  return {
    paddle_status: sub.status || null,
    paddle_next_billed_at: sub.nextBilledAt,
    paddle_scheduled_change: sub.scheduledChange
      ? { action: sub.scheduledChange.action, effective_at: sub.scheduledChange.effectiveAt }
      : null,
    paddle_item: item
      ? {
          price_id: item.priceId,
          amount_minor: item.amountMinor,
          currency: item.currency,
          interval: item.interval,
          frequency: item.frequency,
          custom_data: item.customData,
        }
      : null,
    ...(sub.customerId ? { customer_id: sub.customerId } : {}),
  };
}

function cardDetailsPatch(details: PaddleCardDetails | null): Record<string, unknown> {
  if (!details) return {};
  return {
    ...(details.brand ? { brand: details.brand } : {}),
    ...(details.last4 ? { last4: details.last4 } : {}),
    ...(details.expMonth !== null ? { exp_month: details.expMonth } : {}),
    ...(details.expYear !== null ? { exp_year: details.expYear } : {}),
  };
}

// ─── Paddle ────────────────────────────────────────────────────────────────

/** The gateway a card lives on: its handler, the config as stored, and the config to call Paddle with. */
async function cardGateway(config: ServerConfig, workspaceId: string, providerName: string) {
  const resolved = await resolveNamedBillingConfig(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, providerName);
  if (!resolved || resolved.provider.name !== providerName) throw new Error(`${providerName} is not configured`);
  return { handler: resolved.provider, raw: resolved.config, paddle: paddleConfigFor(providerName, resolved.config) };
}

async function paddleConfigOf(config: ServerConfig, card: Pick<CardRow, 'workspace_id' | 'provider'>): Promise<BillingProviderConfig> {
  return (await cardGateway(config, card.workspace_id, card.provider)).paddle;
}

const isLocked = (r: PaddleResult<unknown>): boolean => (r.error?.code ?? '').startsWith('subscription_locked');
const isPastDueRefusal = (r: PaddleResult<unknown>): boolean => r.error?.code === 'subscription_update_when_past_due';
/** An answer that may change on a retry (Paddle busy, its renewal lock, or no answer at all). */
const isTransient = (r: PaddleResult<unknown>): boolean =>
  r.unknownOutcome || r.status === 0 || r.status === 429 || r.status >= 500 || isLocked(r);

function paddleProblem(r: PaddleResult<unknown>): string {
  return `${r.error?.code ?? `http_${r.status}`}: ${r.error?.detail ?? ''}`.slice(0, 500);
}

/** A refused customer action, as the route answers it. */
function providerError(r: PaddleResult<unknown>): AccountBillingError {
  const code = r.error?.code ?? `http_${r.status}`;
  if (isLocked(r)) return new AccountBillingError('CARD_RENEWAL_IN_PROGRESS', 409, { frozen_until: null, code });
  if (isPastDueRefusal(r)) return new AccountBillingError('CARD_PAST_DUE', 409, { code });
  return new AccountBillingError('CARD_PROVIDER_ERROR', 502, { code });
}

/** Paddle's subscription is already cancelled (a cancel call refused because of it). */
async function canceledAtPaddle(cfg: BillingProviderConfig, subscriptionId: string): Promise<PaddleSubscription | null> {
  const look = await getSubscription(cfg, subscriptionId);
  return look.ok && look.subscription?.status === 'canceled' ? look.subscription : null;
}

/**
 * Undoes our scheduled cancel (PATCH scheduled_change: null), previewed
 * first like every update (P4). A preview that would bill stops it.
 */
async function undoScheduledCancel(cfg: BillingProviderConfig, subscriptionId: string): Promise<PaddleResult<unknown> & { subscription: PaddleSubscription | null }> {
  const preview = await previewSubscriptionUpdate(cfg, subscriptionId, { scheduled_change: null });
  if (!preview.ok) return preview;
  if (preview.billsNow) {
    console.error(`[billing-card] REVIEW subscription ${subscriptionId}: undoing its scheduled cancel would bill now; not applied`);
    return { ...preview, ok: false, error: { code: 'preview_bills', detail: 'the preview bills now' }, subscription: null };
  }
  return clearScheduledChange(cfg, subscriptionId);
}

/**
 * Asks Paddle to cancel (now, or at its period end) with the intent recorded
 * on the card FIRST, so the event the cancel causes is known as ours and not
 * taken for a cancel made in Paddle's portal. A refusal puts the intent back;
 * a subscription Paddle already cancelled counts as done.
 */
async function cancelAtPaddle(
  config: ServerConfig,
  cfg: BillingProviderConfig,
  card: CardRow,
  effectiveFrom: 'immediately' | 'next_billing_period',
): Promise<{ ok: boolean; subscription: PaddleSubscription | null; result: PaddleResult<unknown> }> {
  const intent = effectiveFrom === 'immediately' ? 'now' : 'period_end';
  if (card.cancel_intent !== intent) await patchCard(config, card.id, { cancel_intent: intent });
  const res = await cancelSubscriptionAt(cfg, card.subscription_id, effectiveFrom);
  if (res.ok) return { ok: true, subscription: res.subscription, result: res };
  const canceled = await canceledAtPaddle(cfg, card.subscription_id).catch(() => null);
  if (canceled) return { ok: true, subscription: canceled, result: res };
  // A refusal puts the intent back. No answer keeps it: Paddle may have
  // cancelled after all, and its event must still read as ours (a stale
  // intent is cleared by the next sync that finds no cancel at Paddle).
  const answered = !res.unknownOutcome && res.status > 0 && res.status < 500;
  if (card.cancel_intent !== intent && answered) {
    await patchCard(config, card.id, { cancel_intent: card.cancel_intent }).catch(() => undefined);
  }
  return { ok: false, subscription: null, result: res };
}

// ─── Eligibility ───────────────────────────────────────────────────────────

/**
 * Whether this workspace may save a card, and on which gateways: the
 * International edition, region Multi Region or Global, a card currency,
 * and a Paddle gateway listed for this viewer whose card_auto_renew switch
 * is on (and whose credentials fit it).
 */
export async function cardAvailability(
  config: ServerConfig,
  workspaceId: string,
  currency: string,
  viewer: GatewayViewer,
): Promise<CardAvailability> {
  const region = await getBillingRegion(config);
  if (region.edition !== 'international') return { available: false, providers: [], reason: 'edition' };
  if (region.regionMode !== 'multi' && region.regionMode !== 'global') return { available: false, providers: [], reason: 'region' };
  const code = (currency || '').trim().toUpperCase();
  if (!CARD_CURRENCIES.includes(code)) return { available: false, providers: [], reason: 'currency' };
  const gateways = await accountGateways(config, workspaceId, code, viewer);
  const providers: string[] = [];
  for (const g of gateways) {
    if (!CARD_PROVIDERS.has(g.provider_name)) continue;
    const resolved = await resolveNamedBillingConfig(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, g.provider_name)
      .catch(() => null);
    if (!resolved || !cardAutoRenewEnabled(resolved.config)) continue;
    try {
      paddleConfigFor(g.provider_name, resolved.config);
    } catch {
      continue;
    }
    providers.push(g.provider_name);
  }
  return providers.length ? { available: true, providers } : { available: false, providers: [], reason: 'no_gateway' };
}

// ─── What the card should do ───────────────────────────────────────────────

interface PlanRow {
  id: string;
  name: string;
  localized: Record<string, unknown>;
  is_free: boolean;
  prices: unknown;
}

async function readPlanRow(config: ServerConfig, planId: string | null | undefined): Promise<PlanRow | null> {
  if (!planId) return null;
  const { data, error } = await getServiceClient(config)
    .from('billing_plans')
    .select('id, name, localized, is_free, prices')
    .eq('id', planId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'plan read failed');
  const row = data as Record<string, unknown> | null;
  return row
    ? { id: String(row.id), name: String(row.name ?? ''), localized: asRecord(row.localized), is_free: row.is_free === true, prices: row.prices }
    : null;
}

interface CardStateContext {
  input: CardStateInput;
  /** The plan of the next unpaid period (null without a paid period). */
  targetPlan: PlanRow | null;
  /** The account's currency (the card's when it has no account). */
  currency: string;
  balanceMinor: number;
  /** A prepayment made for a period that no longer runs: billing_account_renew returns it to the balance first. */
  stalePrepaidMinor: number;
}

/** Everything desiredCardState() needs, read from the workspace's billing state now. */
async function loadCardState(config: ServerConfig, card: CardRow, now = Date.now()): Promise<CardStateContext> {
  const sb = getServiceClient(config);
  const [workspace, setup, accountRead, subRead] = await Promise.all([
    sb.from('workspaces').select('id').eq('id', card.workspace_id).maybeSingle(),
    card.setup_payment_id
      ? sb.from('billing_account_payments').select('status, created_at').eq('id', card.setup_payment_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    sb.from('billing_accounts')
      .select('currency, balance_minor, auto_renew, scheduled_plan_id, scheduled_interval, next_period_prepaid_minor, next_period_start')
      .eq('workspace_id', card.workspace_id)
      .maybeSingle(),
    sb.from('workspace_subscriptions')
      .select('plan_id, status, billing_interval, current_period_end')
      .eq('workspace_id', card.workspace_id)
      .maybeSingle(),
  ]);
  for (const r of [workspace, setup, accountRead, subRead]) {
    if (r.error) throw new Error(r.error.message || 'card state read failed');
  }
  const account = asRecord(accountRead.data);
  const sub = asRecord(subRead.data);
  const currency = str(account.currency) ?? card.currency;

  // The running paid period (billing_account_paid_subscription: active, not
  // free, with an end; an end in the past is due but not processed yet).
  const subPlan = sub.status === 'active' && str(sub.current_period_end) ? await readPlanRow(config, str(sub.plan_id)) : null;
  const paid = subPlan && !subPlan.is_free
    ? { plan_id: subPlan.id, billing_interval: asInterval(sub.billing_interval), current_period_end: String(sub.current_period_end) }
    : null;

  let targetPlan: PlanRow | null = null;
  let target: CardStateInput['target'] = null;
  let prepaidNextEnd: string | null = null;
  let v2NextEnd: string | null = null;
  const prepaidMinor = account.next_period_prepaid_minor === null || account.next_period_prepaid_minor === undefined
    ? null
    : num(account.next_period_prepaid_minor);
  let stalePrepaidMinor = prepaidMinor ?? 0;
  if (paid) {
    const targetId = str(account.scheduled_plan_id) ?? paid.plan_id;
    const interval = account.scheduled_interval ? asInterval(account.scheduled_interval) : paid.billing_interval;
    targetPlan = targetId === subPlan?.id ? subPlan : await readPlanRow(config, targetId);
    target = targetPlan
      ? { plan_id: targetPlan.id, is_free: targetPlan.is_free, interval, price_minor: targetPlan.is_free ? 0 : priceOf(targetPlan.prices, currency, interval) }
      : null;
    // A prepayment counts only for the period that runs now (else it returns to the balance).
    const prepaidStart = Date.parse(str(account.next_period_start) ?? '');
    if (prepaidMinor !== null && Math.abs(prepaidStart - Date.parse(paid.current_period_end)) < 1000) {
      prepaidNextEnd = periodEndOf(paid.current_period_end, interval);
      stalePrepaidMinor = 0;
    }
    // A next period paid through billing v2 (a scheduled service period).
    const { data: v2Id } = await sb.rpc('billing_account_v2_next_period', { p_workspace_id: card.workspace_id });
    if (typeof v2Id === 'string' && v2Id) {
      const { data: period } = await sb.from('billing_subscription_periods').select('period_end').eq('id', v2Id).maybeSingle();
      v2NextEnd = str(asRecord(period).period_end);
    }
  }
  const settings = await getBillingSettings(config);
  const setupRow = setup.data ? asRecord(setup.data) : null;
  return {
    input: {
      now,
      card: { status: card.status, created_at: card.created_at, currency: card.currency },
      workspaceExists: Boolean(workspace.data),
      setupPayment: setupRow ? { status: String(setupRow.status), created_at: String(setupRow.created_at) } : null,
      autoRenew: account.auto_renew === true,
      paid,
      prepaidNextEnd,
      v2NextEnd,
      target,
      vatPercent: vatPercentFor(settings.vat_percent, currency),
    },
    targetPlan,
    currency,
    balanceMinor: num(account.balance_minor),
    stalePrepaidMinor,
  };
}

// ─── What the customer sees ────────────────────────────────────────────────

/** The card expires (end of its expiry month, UTC) before Paddle's next charge. */
function expiresBefore(card: Pick<CardRow, 'exp_month' | 'exp_year'>, chargeAt: string | null): boolean {
  if (!card.exp_month || !card.exp_year || !chargeAt) return false;
  const year = card.exp_year < 100 ? 2000 + card.exp_year : card.exp_year;
  const charge = Date.parse(chargeAt);
  return Number.isFinite(charge) && Date.UTC(year, card.exp_month, 1) <= charge;
}

export async function cardView(config: ServerConfig, workspaceId: string): Promise<CardView | null> {
  const card = await readLiveCard(config, workspaceId);
  if (!card) return null;
  const now = Date.now();
  const state = await loadCardState(config, card, now);
  const desired = desiredCardState(state.input);
  const scheduled = card.paddle_scheduled_change && card.paddle_scheduled_change.action === 'cancel'
    ? str(card.paddle_scheduled_change.effective_at) ?? card.paddle_next_billed_at
    : card.cancel_intent === 'period_end' ? card.paddle_next_billed_at : null;
  const cancelScheduled = Boolean(scheduled) || card.cancel_intent === 'period_end';
  const nextChargeAt = cancelScheduled ? null : card.paddle_next_billed_at;
  const renew = desired.kind === 'renew' ? desired : null;
  const mirrored = cardFreeze(card, now);
  const freeze = mirrored.frozen ? mirrored : ownRenewalFreeze(state.input);
  const gateway = await cardGateway(config, workspaceId, card.provider).catch(() => null);
  return {
    id: card.id,
    provider: card.provider,
    status: card.status === 'past_due' ? 'past_due' : 'active',
    brand: card.brand,
    last4: card.last4,
    exp_month: card.exp_month,
    exp_year: card.exp_year,
    auto_renew: state.input.autoRenew,
    next_charge_at: nextChargeAt,
    next_charge_minor: renew ? renew.item.amountMinor : null,
    next_charge_plan: renew && state.targetPlan
      ? { plan_id: state.targetPlan.id, name: state.targetPlan.name, localized: state.targetPlan.localized }
      : null,
    next_charge_interval: renew ? renew.item.interval : null,
    scheduled_cancel_at: scheduled,
    last_failure: card.last_failure ? { at: card.last_failure.at, code: card.last_failure.code } : null,
    frozen_until: freeze.frozen ? freeze.until : null,
    expires_before_next_charge: expiresBefore(card, nextChargeAt),
    chargeable: Boolean(gateway && cardAutoRenewEnabled(gateway.raw)),
  };
}

// ─── Saving a card (checkout) ──────────────────────────────────────────────

/** The Paddle customer of an earlier card on the same gateway, reused by the next checkout. */
async function reusableCustomerId(config: ServerConfig, workspaceId: string, providerName: string): Promise<string | null> {
  const sb = getServiceClient(config);
  const [{ data: account }, { data: cards }] = await Promise.all([
    sb.from('billing_accounts').select('card_customer_id').eq('workspace_id', workspaceId).maybeSingle(),
    sb.from('billing_account_cards')
      .select('customer_id')
      .eq('workspace_id', workspaceId)
      .eq('provider', providerName)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);
  // A customer id belongs to one Paddle account: only one a card of this gateway used.
  const known = ((cards ?? []) as Array<{ customer_id: string | null }>).map((c) => str(c.customer_id)).filter((c): c is string => Boolean(c));
  const fromAccount = str(asRecord(account).card_customer_id);
  if (fromAccount && known.includes(fromAccount)) return fromAccount;
  return known[0] ?? null;
}

/**
 * Older card checkouts of this workspace are closed, so only the newest can
 * save a card. One that was paid already (its card is on its way) refuses a
 * new setup: CARD_SETUP_IN_PROGRESS. One that cannot be closed and is not
 * paid is left; a second card from it is cancelled as a duplicate.
 */
async function closeOlderSetups(config: ServerConfig, workspaceId: string, now: number): Promise<void> {
  const { data, error } = await getServiceClient(config)
    .from('billing_account_payments')
    .select('id, provider, provider_ref, status, verified_at, created_at, completed_at')
    .eq('workspace_id', workspaceId)
    .eq('source', 'card_setup')
    .in('status', ['pending', 'succeeded'])
    .is('card_id', null)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message || 'payment read failed');
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = String(row.id);
    if (row.status === 'succeeded') {
      const at = Date.parse(str(row.completed_at) ?? String(row.created_at));
      if (Number.isFinite(at) && now - at < CARD_SETUP_HOLD_MS) throw new AccountBillingError('CARD_SETUP_IN_PROGRESS', 409);
      continue;
    }
    if (row.verified_at) throw new AccountBillingError('CARD_SETUP_IN_PROGRESS', 409);
    const ref = str(row.provider_ref);
    if (!ref) {
      await failAccountPayment(config, id, 'canceled', 'superseded');
      continue;
    }
    const gateway = await cardGateway(config, workspaceId, String(row.provider)).catch(() => null);
    const closed = gateway?.handler.closeCheckout
      ? await gateway.handler.closeCheckout(gateway.raw, ref).catch(() => false)
      : false;
    let canceled = closed;
    if (!closed && gateway) {
      // Paddle refuses to cancel a transaction that is billed or paid.
      const look = await getTransaction(gateway.paddle, ref);
      const status = look.transaction?.status ?? '';
      if (['billed', 'paid', 'completed', 'past_due'].includes(status)) throw new AccountBillingError('CARD_SETUP_IN_PROGRESS', 409);
      canceled = status === 'canceled';
    }
    if (canceled) {
      await failAccountPayment(config, id, 'canceled', 'superseded');
      await patchAccountPayment(config, id, { closed_at: new Date().toISOString() });
    } else {
      console.warn(`[billing-card] older card checkout payment=${id} could not be closed`);
    }
  }
}

/**
 * The checkout route with autoRenew: checks that a card may be saved, closes
 * older card checkouts, and returns what to add to the checkout: the Paddle
 * customer of an earlier card, the recurring interval, and the price's
 * custom_data (the plan, interval, net and VAT every renewal will carry).
 */
export async function prepareCardSetup(
  config: ServerConfig,
  workspaceId: string,
  input: { providerName: string; purpose: 'plan' | 'renewal'; planId: string; interval: 'monthly' | 'yearly'; viewer: GatewayViewer },
): Promise<{ customerId: string | null; recurring: { interval: 'monthly' | 'yearly' }; priceCustomData: Record<string, unknown> }> {
  if (input.purpose !== 'plan' && input.purpose !== 'renewal') throw new AccountBillingError('CARD_SETUP_PURPOSE', 400);
  const interval = input.interval === 'yearly' ? 'yearly' : 'monthly';
  const account = await readAccount(config, workspaceId);
  const currency = account?.currency ?? (await getBillingRegion(config)).currency;
  const availability = await cardAvailability(config, workspaceId, currency, input.viewer);
  if (!availability.available || !availability.providers.includes(input.providerName)) {
    throw new AccountBillingError('CARD_NOT_AVAILABLE', 400, { reason: availability.reason ?? 'provider' });
  }
  if (await readLiveCard(config, workspaceId)) throw new AccountBillingError('CARD_ALREADY_SAVED', 409);
  await closeOlderSetups(config, workspaceId, Date.now());

  // The recurring price: the plan's full price for one period, VAT on top.
  const plan = await readPlanRow(config, input.planId);
  const price = plan && !plan.is_free ? priceOf(plan.prices, currency, interval) : null;
  if (!plan || price === null) throw new AccountBillingError('PLAN_PRICE_UNAVAILABLE', 400);
  const settings = await getBillingSettings(config);
  const vat = vatPercentFor(settings.vat_percent, currency);
  const charge = chargeFor(price, vat);
  return {
    customerId: await reusableCustomerId(config, workspaceId, input.providerName),
    recurring: { interval },
    // vat_percent: the percent this tax was priced with, for the renewal's receipt.
    priceCustomData: {
      plan_id: plan.id, interval, net_minor: charge.net, tax_minor: charge.tax,
      ...(charge.tax > 0 && vat !== null ? { vat_percent: vat } : {}),
    },
  };
}

/**
 * Registers the card a paid card checkout saved (Paddle's subscription.created,
 * or the job's recovery): reads the subscription, records it for the
 * checkout's workspace (billing_card_register), takes the card's details from
 * the checkout, then syncs it (or cancels it as a duplicate). null when the
 * subscription cannot be this checkout's card.
 */
export async function activateCard(
  config: ServerConfig,
  input: { providerName: string; subscriptionId: string; setupPaymentId: string; checkoutTransactionId?: string | null },
): Promise<{ cardId: string; live: boolean; duplicate: boolean } | null> {
  const payment = (await readAccountPayment(config, input.setupPaymentId)) as CardPayment | null;
  if (!payment || payment.source !== 'card_setup' || payment.provider !== input.providerName) {
    console.error(`[billing-card] REVIEW activation of ${input.subscriptionId}: payment ${input.setupPaymentId} is not a ${input.providerName} card checkout`);
    return null;
  }
  if (input.checkoutTransactionId && payment.provider_ref && payment.provider_ref !== input.checkoutTransactionId) {
    console.error(`[billing-card] REVIEW activation of ${input.subscriptionId}: checkout ${input.checkoutTransactionId} is not payment ${payment.id}'s (${payment.provider_ref})`);
    return null;
  }
  const cfg = (await cardGateway(config, payment.workspace_id, input.providerName)).paddle;
  const answer = await getSubscription(cfg, input.subscriptionId);
  if (answer.status === 404) {
    // Not a subscription of this gateway's Paddle account: retrying cannot help.
    console.error(`[billing-card] REVIEW activation of ${input.subscriptionId} for payment ${payment.id}: Paddle does not know the subscription`);
    return null;
  }
  // Anything else may pass: the event is retried (the job retries a recovery).
  if (!answer.ok || !answer.subscription) throw new Error(`Paddle subscription ${input.subscriptionId}: ${paddleProblem(answer)}`);
  const sub = answer.subscription;
  const claimed = str(sub.customData.workspace_id);
  if (claimed && claimed !== payment.workspace_id) {
    console.error(`[billing-card] REVIEW subscription ${sub.id} names workspace ${claimed}; its checkout is workspace ${payment.workspace_id}'s`);
  }
  // The checkout that saved the card: the card's details, and, when Paddle's
  // event did not name it, the proof that it created this subscription (its
  // custom_data alone may be another installation's copy of our ids, P6).
  const checkoutTxn = input.checkoutTransactionId ?? payment.provider_ref;
  const txn = checkoutTxn ? await getTransaction(cfg, checkoutTxn).catch(() => null) : null;
  if (!input.checkoutTransactionId) {
    if (txn && !txn.ok && txn.status !== 404) throw new Error(`Paddle transaction ${checkoutTxn}: ${paddleProblem(txn)}`);
    if (!txn?.transaction || txn.transaction.subscriptionId !== sub.id) {
      console.error(`[billing-card] REVIEW subscription ${sub.id} was not made by checkout ${checkoutTxn ?? '-'} of payment ${payment.id}; not registered`);
      return null;
    }
  }

  const { data, error } = await getServiceClient(config).rpc('billing_card_register', {
    p_provider: input.providerName,
    p_subscription_id: sub.id,
    p_customer_id: sub.customerId,
    p_currency: sub.currency ?? payment.currency,
    p_setup_payment_id: payment.id,
  });
  if (error) {
    const code = sqlCode(error);
    if (code === 'billing_card_setup_invalid' || code === 'billing_card_conflict' || code === 'billing_account_currency_mismatch') {
      console.error(`[billing-card] REVIEW subscription ${sub.id} not registered for payment ${payment.id}: ${code}`);
      return null;
    }
    throw new Error(error.message || 'card registration failed');
  }
  const reg = asRecord(data);
  const cardId = String(reg.card_id);
  const live = reg.live === true;
  const duplicate = reg.duplicate === true;

  // The card that paid the checkout, and what Paddle shows now.
  await patchCard(config, cardId, { ...mirrorOf(sub), ...cardDetailsPatch(txn?.transaction?.card ?? null) })
    .catch((e) => console.warn(`[billing-card] card=${cardId} details:`, messageOf(e)));
  if (reg.replayed !== true) {
    console.log(`[billing-card] registered card=${cardId} workspace=${payment.workspace_id} subscription=${sub.id} live=${live} duplicate=${duplicate}`);
  }

  if (duplicate) await cancelCardNow(config, cardId, 'duplicate');
  else if (live) await syncCard(config, cardId);
  return { cardId, live, duplicate };
}

// ─── Paddle's events ───────────────────────────────────────────────────────

/**
 * Whose card event this is, without changing anything (P6): our card by its
 * subscription, else our card checkout by the transaction that created the
 * subscription or by the payment id Paddle copied from it. null = not ours
 * (another database's subscription on the same Paddle account): the route
 * acknowledges it and does nothing.
 */
export async function cardEventOwner(config: ServerConfig, providerName: string, event: WebhookEvent): Promise<CardEventOwner | null> {
  const evt = event.card;
  const sb = getServiceClient(config);
  const subscriptionId = evt?.subscriptionId ?? event.providerSubscriptionId ?? null;
  if (subscriptionId) {
    const { data, error } = await sb
      .from('billing_account_cards')
      .select('id, workspace_id, setup_payment_id')
      .eq('provider', providerName)
      .eq('subscription_id', subscriptionId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'card read failed');
    if (data) {
      const row = data as Record<string, unknown>;
      return { workspaceId: String(row.workspace_id), cardId: String(row.id), setupPaymentId: str(row.setup_payment_id) };
    }
  }
  // Not registered yet: subscription events name the checkout transaction.
  const checkoutTxn = evt?.entity === 'subscription' ? evt.transactionId : null;
  if (checkoutTxn) {
    const { data, error } = await sb
      .from('billing_account_payments')
      .select('id, workspace_id')
      .eq('provider', providerName)
      .eq('source', 'card_setup')
      .eq('provider_ref', checkoutTxn)
      .maybeSingle();
    if (error) throw new Error(error.message || 'payment read failed');
    if (data) {
      const row = data as Record<string, unknown>;
      return { workspaceId: String(row.workspace_id), cardId: null, setupPaymentId: String(row.id) };
    }
  }
  const intent = str(evt?.customData?.intent_id);
  if (intent && UUID.test(intent)) {
    const { data, error } = await sb
      .from('billing_account_payments')
      .select('id, workspace_id, provider_ref, card_id')
      .eq('id', intent)
      .eq('provider', providerName)
      .eq('source', 'card_setup')
      .maybeSingle();
    if (error) throw new Error(error.message || 'payment read failed');
    const row = data as Record<string, unknown> | null;
    // A checkout saves one card: once its subscription is registered (found
    // above by its id), another subscription naming that checkout is not ours.
    if (row && !str(row.card_id) && (!checkoutTxn || !str(row.provider_ref) || row.provider_ref === checkoutTxn)) {
      return { workspaceId: String(row.workspace_id), cardId: null, setupPaymentId: String(row.id) };
    }
  }
  return null;
}

/**
 * A card event of ours (cardEventOwner). Subscription events: Paddle is
 * asked for the subscription now (events arrive in any order), its state is
 * mirrored and acted on, and the card synced. Transaction events: the charge
 * is recorded once; paid → settled; declined → the card is past_due and the
 * customer is mailed once; cancelled → its row fails; a zero amount (a card
 * change) only refreshes the card's details. A subscription of our checkout
 * whose card is not registered yet is registered first.
 */
export async function handleCardEvent(
  config: ServerConfig,
  input: { providerName: string; event: WebhookEvent; owner: CardEventOwner },
): Promise<'handled' | 'ignored'> {
  const evt = input.event.card;
  if (!evt) return 'ignored';
  const subscriptionId = evt.subscriptionId ?? input.event.providerSubscriptionId ?? null;
  let cardId = input.owner.cardId;
  if (!cardId) {
    if (!input.owner.setupPaymentId || !subscriptionId) return 'ignored';
    const activated = await activateCard(config, {
      providerName: input.providerName,
      subscriptionId,
      setupPaymentId: input.owner.setupPaymentId,
      checkoutTransactionId: evt.entity === 'subscription' ? evt.transactionId : null,
    });
    if (!activated) return 'ignored';
    // Registering read, mirrored and synced the subscription already.
    if (evt.entity === 'subscription') return 'handled';
    cardId = activated.cardId;
  }
  const card = await readCard(config, cardId);
  if (!card || card.provider !== input.providerName) return 'ignored';

  if (evt.entity === 'subscription') {
    if (card.status === 'canceled') return 'handled';
    const answer = await getSubscription(await paddleConfigOf(config, card), card.subscription_id);
    // Paddle could not be asked: the event is retried.
    if (!answer.ok || !answer.subscription) throw new Error(`Paddle subscription ${card.subscription_id}: ${paddleProblem(answer)}`);
    await runSync(config, card.id, answer.subscription);
    return 'handled';
  }
  return onTransactionEvent(config, card, evt.eventType, evt.transaction, evt.occurredAt);
}

/** The payment id our /charge put on its item (price custom_data). */
function chargePaymentId(txn: PaddleTransaction): string | null {
  for (const data of txn.itemCustomData) {
    const id = str(data.payment_id);
    if (id && UUID.test(id)) return id;
  }
  return null;
}

/**
 * An unpaid /charge transaction whose payment row (this card's, never bound
 * to a transaction) has already ended: the charge was refused when it was
 * asked for, so there is nothing to record.
 */
async function chargeAlreadyEnded(config: ServerConfig, card: CardRow, txn: PaddleTransaction): Promise<boolean> {
  const paymentId = chargePaymentId(txn);
  const payment = paymentId ? ((await readAccountPayment(config, paymentId)) as CardPayment | null) : null;
  return Boolean(
    payment && payment.workspace_id === card.workspace_id && payment.card_id === card.id
      && payment.source === 'card_charge' && payment.status !== 'pending' && payment.status !== 'succeeded'
      && !payment.provider_ref,
  );
}

/**
 * One Paddle transaction of a card as a payment row (billing_card_record_charge:
 * once per transaction). null when it cannot be credited at all (logged REVIEW).
 */
async function recordCharge(config: ServerConfig, card: CardRow, txn: PaddleTransaction, amount: number): Promise<CardPayment | null> {
  const { data, error } = await getServiceClient(config).rpc('billing_card_record_charge', {
    p_card_id: card.id,
    p_txn_id: txn.id,
    p_origin: txn.origin ?? '',
    p_amount_minor: amount,
    p_currency: txn.currency ?? card.currency,
    p_items: txn.itemCustomData,
    p_payment_id: txn.origin === 'subscription_charge' ? chargePaymentId(txn) : null,
  });
  if (error) {
    const code = sqlCode(error);
    if (code === 'billing_card_workspace_missing') {
      console.error(`[billing-card] REVIEW card=${card.id} transaction ${txn.id} (${amount} ${txn.currency}) for a deleted workspace: refund it in Paddle`);
      return null;
    }
    if (code === 'billing_account_currency_mismatch' || code === 'billing_card_conflict' || code === 'billing_card_charge_amount_invalid') {
      console.error(`[billing-card] REVIEW card=${card.id} transaction ${txn.id} not recorded: ${code}`);
      return null;
    }
    throw new Error(error.message || 'card charge record failed');
  }
  const row = rowOf(data);
  return row?.id ? ((await readAccountPayment(config, String(row.id))) as CardPayment | null) : null;
}

/**
 * Settles a card payment Paddle reports paid (billing_card_settle: the
 * confirmation and the settlement in one transaction), then the receipt and
 * plan mail. null when Paddle's report cannot settle it (logged REVIEW).
 */
async function settleCardPayment(
  config: ServerConfig,
  payment: Pick<AccountPaymentRow, 'id' | 'status'>,
  amount: number,
  currency: string,
  txnId: string,
): Promise<SettleResult | null> {
  const { data, error } = await getServiceClient(config).rpc('billing_card_settle', {
    p_payment_id: payment.id,
    p_amount_minor: amount,
    p_currency: currency,
    p_txn_id: txnId,
  });
  if (error) {
    const code = sqlCode(error);
    if (code) {
      console.error(`[billing-card] REVIEW payment=${payment.id} transaction ${txnId} (${amount} ${currency}) not settled: ${code}`);
      return null;
    }
    throw new Error(error.message || 'card payment settlement failed');
  }
  const settled = asRecord(data) as unknown as SettleResult;
  if (!settled.replayed) {
    void import('./effects.js')
      .then((m) => m.afterAccountSettlement(config, settled))
      .catch((e) => console.warn('[billing-card] after settlement:', messageOf(e)));
  }
  return settled;
}

async function onTransactionEvent(
  config: ServerConfig,
  card: CardRow,
  eventType: string,
  txn: PaddleTransaction | null,
  occurredAt: string | null,
): Promise<'handled' | 'ignored'> {
  if (!txn) return 'ignored';
  const amount = txn.grandTotalMinor ?? txn.totalMinor ?? 0;
  const paid = PAID.has(txn.status);
  if (amount <= 0) {
    // A card change (subscription_payment_method_change) charges nothing.
    if (txn.card && paid) await patchCard(config, card.id, cardDetailsPatch(txn.card));
    return 'handled';
  }
  if (!paid && txn.origin === 'subscription_charge' && (await chargeAlreadyEnded(config, card, txn))) {
    // Our /charge was refused in the call itself (its row ended then) and
    // nothing was taken: no second row for it. Paid, it would be recorded.
    return 'handled';
  }
  const payment = await recordCharge(config, card, txn, amount);
  if (!payment) return 'handled';

  if (paid) {
    // The card that paid first: the settlement's mail names it.
    if (txn.card) await patchCard(config, card.id, cardDetailsPatch(txn.card));
    await settleCardPayment(config, payment, amount, txn.currency ?? card.currency, txn.id);
    // A renewal paid after a decline: the card is fine again.
    if (txn.origin === 'subscription_recurring' && card.status === 'past_due') {
      await setCardStatus(config, card.id, 'active');
      await patchCard(config, card.id, { last_failure: null });
    }
    return 'handled';
  }
  // Collected already (a later attempt; notifications come in any order): an
  // older one about a failed attempt changes nothing and is not mailed.
  if (payment.status === 'succeeded') return 'handled';
  if (txn.status === 'canceled' || eventType === 'transaction.canceled') {
    await failAccountPayment(config, payment.id, 'canceled', 'paddle_canceled');
    return 'handled';
  }
  const failed = eventType === 'transaction.payment_failed' || eventType === 'transaction.past_due' || txn.status === 'past_due';
  if (!failed) return 'handled';
  const code = txn.errorCode ?? 'payment_failed';
  if (txn.origin !== 'subscription_recurring') {
    // Our /charge (declined synchronously too) or an unexpected charge: nothing to retry.
    await failAccountPayment(config, payment.id, 'failed', 'card_declined');
    return 'handled';
  }
  // A renewal declined: the row stays pending (Paddle may still collect it
  // before our due moment); the card is past_due and the customer told once.
  await patchAccountPayment(config, payment.id, { failure_reason: code }, 'pending');
  if (!isLive(card)) return 'handled';
  if (card.status === 'active') await setCardStatus(config, card.id, 'past_due');
  await patchCard(config, card.id, { last_failure: { at: occurredAt ?? new Date().toISOString(), code, txn: txn.id } });
  await mailPaymentFailed(config, { ...card, ...cardDetailsPatch(txn.card) } as CardRow, payment, txn.id, code);
  return 'handled';
}

/**
 * What Paddle shows that we must follow: cancelled (by us, at the period end,
 * or in Paddle's portal), a cancel scheduled in the portal (auto-renew off;
 * never undone by the reconciler), past_due ↔ active. Returns the card now.
 */
async function applyPaddleState(config: ServerConfig, card: CardRow, sub: PaddleSubscription): Promise<CardRow> {
  let changed = false;
  if (sub.status === 'canceled') {
    if (card.status !== 'canceled') {
      const ours = card.status === 'canceling' || card.cancel_intent === 'now';
      const atPeriodEnd = card.cancel_intent === 'period_end';
      // Our cancel at the period end: mailed when the customer turned auto-renew
      // off (not for a plan that ends on Free, whose own mail says so).
      const turnedOff = atPeriodEnd && isLive(card) && !(await accountAutoRenew(config, card.workspace_id));
      const reason = card.cancel_reason ?? (ours ? 'canceled' : atPeriodEnd ? 'period_end' : 'canceled_at_paddle');
      await setCardStatus(config, card.id, 'canceled', reason);
      if (isLive(card) && !ours && (!atPeriodEnd || turnedOff)) {
        await mailCardRemoved(config, card, atPeriodEnd ? 'period_end' : 'canceled_at_paddle');
      }
      changed = true;
    }
  } else if (isLive(card)) {
    if (sub.scheduledChange?.action === 'cancel' && !card.cancel_intent) {
      // A cancel we never asked for: the customer cancelled in Paddle's portal,
      // and auto-renew goes off here too.
      const { error } = await getServiceClient(config)
        .from('billing_accounts')
        .update({ auto_renew: false, updated_at: new Date().toISOString() })
        .eq('workspace_id', card.workspace_id)
        .eq('card_provider', card.provider)
        .eq('card_subscription_id', card.subscription_id);
      if (error) throw new Error(error.message || 'auto-renew update failed');
      await patchCard(config, card.id, { cancel_intent: 'period_end' });
      console.log(`[billing-card] card=${card.id} cancel scheduled in Paddle's portal: auto-renew off`);
      await mailCardRemoved(config, card, 'canceled_at_paddle');
      changed = true;
    }
    if (sub.status === 'past_due' && card.status === 'active') {
      await setCardStatus(config, card.id, 'past_due');
      changed = true;
    } else if (sub.status === 'active' && card.status === 'past_due') {
      // last_failure stays until a renewal is paid (the view shows it while past_due).
      await setCardStatus(config, card.id, 'active');
      changed = true;
    }
  }
  return changed ? ((await readCard(config, card.id)) ?? card) : card;
}

// ─── The reconciler ────────────────────────────────────────────────────────

/** Whether Paddle's recurring item is the one the next period should charge. */
function itemMatches(sub: PaddleSubscription, item: Extract<DesiredCardState, { kind: 'renew' }>['item']): boolean {
  if (sub.items.length !== 1) return false;
  const current = sub.items[0];
  const data = current.customData;
  return current.amountMinor === item.amountMinor
    && current.currency === item.currency
    && current.interval === (item.interval === 'yearly' ? 'year' : 'month')
    && (current.frequency ?? 1) === 1
    && str(data.plan_id) === item.planId
    && asInterval(data.interval) === item.interval
    && num(data.net_minor) === item.netMinor
    && num(data.tax_minor) === item.taxMinor
    // The percent the renewal's receipt prints (a VAT change re-syncs the item).
    && (item.taxMinor > 0 ? num(data.vat_percent) === item.vatPercent : true);
}

/** Paddle's recurring item for the next period (a non-catalog price with our custom_data). */
function recurringItemFor(
  cfg: BillingProviderConfig,
  planName: string | null | undefined,
  item: Extract<DesiredCardState, { kind: 'renew' }>['item'],
): ReturnType<typeof buildRecurringItem> {
  const name = planName || 'Plan';
  return buildRecurringItem({
    name,
    description: `${name} (${item.interval})`,
    amountMinor: item.amountMinor,
    currency: item.currency,
    interval: item.interval,
    productId: str(cfg.product_id),
    customData: {
      plan_id: item.planId,
      interval: item.interval,
      net_minor: item.netMinor,
      tax_minor: item.taxMinor,
      ...(item.taxMinor > 0 && item.vatPercent !== null ? { vat_percent: item.vatPercent } : {}),
    },
  });
}

/**
 * Whether the subscription carries our custom_data. Other keys do not matter
 * (card events are never routed by them, P5): where Paddle merges a PATCH
 * into what the checkout left (its intent_id), asking again would never
 * change it, and each PATCH's own subscription.updated would sync again.
 */
function customDataMatches(sub: PaddleSubscription, wanted: Record<string, string>): boolean {
  return Object.keys(wanted).every((k) => sub.customData[k] === wanted[k]);
}

/**
 * Before Paddle's charge date is moved EARLIER. Moving it later never
 * charges; moving it earlier makes Paddle charge sooner, and when Paddle's
 * period runs well past the last one we count as paid, Paddle has most
 * likely charged a renewal we have not recorded yet: moving the date would
 * charge that period twice. So when Paddle is ahead, its renewals of its
 * current period are looked at first: one paid but not recorded is settled
 * now ('renewal_settled': decide again with the new state), one still in
 * flight waits ('renewal_in_flight'), one recorded but not applied to a
 * period is left for a person ('renewal_not_applied'). A period Paddle began
 * within the last hours whose renewal is not listed yet waits for it
 * ('renewal_expected': Paddle moves its dates before the transaction shows).
 * null = move it.
 */
async function earlierDateBlocked(
  config: ServerConfig,
  cfg: BillingProviderConfig,
  card: CardRow,
  sub: PaddleSubscription,
  paidUntil: string,
): Promise<string | null> {
  const paddleEnd = Date.parse(sub.currentPeriodEnd ?? sub.nextBilledAt ?? '');
  if (!Number.isFinite(paddleEnd) || paddleEnd <= Date.parse(paidUntil) + PADDLE_AHEAD_SLACK_MS) return null;
  const list = await listSubscriptionTransactions(cfg, card.subscription_id, { perPage: 10 });
  if (!list.ok) return 'paddle_transactions_unavailable';
  // Paddle's current period: from its start (else about one cycle before its end).
  const start = Date.parse(sub.currentPeriodStart ?? '');
  const currentFrom = Number.isFinite(start) ? start - DAY_MS : paddleEnd - (sub.items[0]?.interval === 'year' ? 367 : 32) * DAY_MS;
  let settled = false;
  let seen = false;
  let blocked: string | null = null;
  for (const txn of [...list.transactions].reverse()) {
    if (txn.origin !== 'subscription_recurring' || txn.status === 'canceled') continue;
    const at = Date.parse(txn.billedAt ?? txn.createdAt ?? '');
    if (Number.isFinite(at) && at < currentFrom) continue;
    seen = true;
    if (!PAID.has(txn.status)) {
      blocked = blocked ?? 'renewal_in_flight';
      continue;
    }
    const amount = txn.grandTotalMinor ?? txn.totalMinor ?? 0;
    const payment = amount > 0 ? await recordCharge(config, card, txn, amount) : null;
    if (!payment) {
      blocked = blocked ?? 'renewal_not_recorded';
    } else if (payment.status !== 'succeeded') {
      await settleCardPayment(config, payment, amount, txn.currency ?? card.currency, txn.id);
      settled = true;
    } else if (payment.purpose !== 'renewal' || payment.review || (payment.purpose_result && 'error' in payment.purpose_result)) {
      // Paddle charged its period, but the money did not renew ours (another
      // amount, credited as a top-up; a renewal guard): never charged again.
      blocked = blocked ?? 'renewal_not_applied';
    }
  }
  if (settled) return 'renewal_settled';
  const now = Date.now();
  if (!seen && Number.isFinite(start) && start <= now && now - start < CARD_FREEZE_MAX_AFTER_MS) return 'renewal_expected';
  if (blocked === 'renewal_not_applied' || blocked === 'renewal_not_recorded') {
    console.error(`[billing-card] REVIEW card=${card.id} Paddle charged its current period (until ${sub.currentPeriodEnd}) but no renewal of ours came of it; its date stays ${sub.nextBilledAt}`);
  }
  return blocked;
}

/** Brings one card's Paddle subscription to what it should be. Never charges; never throws. */
export async function syncCard(config: ServerConfig, cardId: string): Promise<SyncOutcome> {
  return runSync(config, cardId, null);
}

async function runSync(config: ServerConfig, cardId: string, prefetched: PaddleSubscription | null): Promise<SyncOutcome> {
  let card: CardRow | null = null;
  let mirror: Record<string, unknown> = {};
  let version = 0;
  const fail = async (detail: string): Promise<SyncOutcome> => {
    if (card) {
      const n = Date.parse(card.paddle_next_billed_at ?? '');
      const near = isLive(card) && Number.isFinite(n) && n - Date.now() < 2 * 60 * MINUTE_MS;
      if (near) console.error(`[billing-card] REVIEW card=${card.id} out of sync with Paddle near its charge (${card.paddle_next_billed_at}): ${detail}`);
      else console.warn(`[billing-card] sync card=${card.id}: ${detail}`);
      await markSynced(config, card.id, version, mirror, detail || 'sync_failed').catch((e) => console.warn('[billing-card] sync record:', messageOf(e)));
    }
    return { status: 'error', detail };
  };
  /** Nothing to change yet: look again later (a later version is synced sooner). */
  const defer = async (detail: string, delayMs: number): Promise<SyncOutcome> => {
    if (card) {
      await patchCard(config, card.id, { ...mirror, next_sync_at: new Date(Date.now() + delayMs).toISOString() })
        .catch((e) => console.warn('[billing-card] sync defer:', messageOf(e)));
    }
    return { status: 'deferred', detail };
  };
  const paddleFailure = (r: PaddleResult<unknown>): Promise<SyncOutcome> => {
    if (isLocked(r)) return defer('paddle_locked', 10 * MINUTE_MS);
    if (isPastDueRefusal(r)) return defer('paddle_past_due', 30 * MINUTE_MS);
    return fail(paddleProblem(r));
  };

  try {
    card = await readCard(config, cardId);
    if (!card) return { status: 'error', detail: 'card_not_found' };
    if (card.status === 'canceled') return { status: 'canceled' };
    version = card.sync_version;
    const cfg = await paddleConfigOf(config, card);
    let sub = prefetched;
    if (!sub) {
      const answer = await getSubscription(cfg, card.subscription_id);
      if (!answer.ok || !answer.subscription) return fail(paddleProblem(answer));
      sub = answer.subscription;
    }
    mirror = mirrorOf(sub);

    // 1./2. What Paddle shows that we follow (cancelled, portal cancel, past_due).
    card = await applyPaddleState(config, card, sub);
    if (card.status === 'canceled') {
      await markSynced(config, card.id, version, mirror);
      return { status: 'canceled', detail: card.cancel_reason ?? undefined };
    }

    const now = Date.now();
    const state = await loadCardState(config, card, now);
    const desired = desiredCardState(state.input);

    // 3. Cancel now (allowed even while past_due; it stops Paddle's dunning).
    if (desired.kind === 'cancel_now') {
      const res = await cancelAtPaddle(config, cfg, card, 'immediately');
      if (!res.ok) return paddleFailure(res.result);
      const after = res.subscription;
      await setCardStatus(config, card.id, 'canceled', card.cancel_reason ?? desired.reason);
      mirror = { ...mirror, ...(after ? mirrorOf(after) : { paddle_status: 'canceled' }), cancel_intent: 'now' };
      await markSynced(config, card.id, version, mirror);
      console.log(`[billing-card] canceled card=${card.id} subscription=${sub.id} reason=${card.cancel_reason ?? desired.reason}`);
      return { status: 'canceled', detail: desired.reason };
    }
    // 4. Past_due or paused: Paddle refuses changes; the due moment decides.
    if (sub.status === 'past_due' || sub.status === 'paused') return defer(`paddle_${sub.status}`, 30 * MINUTE_MS);
    if (sub.status !== 'active') return defer(`paddle_${sub.status || 'unknown'}`, 30 * MINUTE_MS);
    if (desired.kind === 'hold') {
      await settleSetupIfPaid(config, card);
      const setup = state.input.setupPayment;
      const setupAt = setup ? setupHoldFrom(setup, card) : Number.NaN;
      const holdLeft = Number.isFinite(setupAt) ? setupAt + CARD_SETUP_HOLD_MS - now : 0;
      return defer('setup_pending', Math.max(MINUTE_MS, Math.min(10 * MINUTE_MS, holdLeft)));
    }
    // 5. Around Paddle's charge: changes wait. Except, while Paddle's own lock
    // is still away, what never bills and never charges sooner: a date of
    // Paddle's earlier than our period's is moved later (else nothing could
    // ever undo a wrong early date before Paddle charges at it); a stop at
    // the period end goes on (step 6); and the item is swapped to the next
    // period's, keeping Paddle's date (else a plan or interval change made
    // just before would have Paddle charge the old item, which fails the
    // renewal's price check and lapses the plan at its end).
    const freeze = cardFreeze({ paddle_next_billed_at: sub.nextBilledAt, status: card.status }, now);
    const paddleAt = Date.parse(sub.nextBilledAt ?? '');
    const lockAway = paddleAt - now > PADDLE_LOCK_MS;
    if (freeze.frozen && !(desired.kind === 'stop_at_period_end' && lockAway)) {
      if (desired.kind !== 'renew' || !lockAway) return defer('frozen', 15 * MINUTE_MS);
      // Later only toward the date our period anchors (its end − the lead),
      // never toward one clamped to now + the minimum lead: that one moves
      // with every pass and would push a correct date on and on.
      const anchored = Date.parse(lastPaidEnd(state.input) ?? '') - CARD_RENEWAL_LEAD_MS;
      const moveLater = desired.feasible && Number.isFinite(anchored) && anchored - paddleAt > CARD_SYNC_DATE_TOLERANCE_MS
        && Date.parse(desired.nextBilledAt) - paddleAt > CARD_SYNC_DATE_TOLERANCE_MS;
      if (!moveLater) {
        if (itemMatches(sub, desired.item)) return defer('frozen', 15 * MINUTE_MS);
        const swap: SubscriptionPatch = {
          items: [recurringItemFor(cfg, state.targetPlan?.name, desired.item)],
          proration_billing_mode: 'do_not_bill',
        };
        const preview = await previewSubscriptionUpdate(cfg, sub.id, swap);
        if (!preview.ok) return paddleFailure(preview);
        if (preview.billsNow) {
          console.error(`[billing-card] REVIEW card=${card.id} Paddle's preview of the next period's item would bill now; not applied`);
          return fail('preview_bills');
        }
        const previewAt = Date.parse(preview.subscription?.nextBilledAt ?? '');
        if (!Number.isFinite(previewAt) || Math.abs(previewAt - paddleAt) > CARD_SYNC_DATE_TOLERANCE_MS) {
          // An interval swap that would move Paddle's date: never inside the freeze.
          return defer('frozen', 15 * MINUTE_MS);
        }
        const swapped = await updateSubscription(cfg, sub.id, swap);
        if (!swapped.ok) return paddleFailure(swapped);
        mirror = { ...mirror, ...mirrorOf(swapped.subscription ?? sub) };
        console.warn(`[billing-card] card=${card.id} the next period's item set inside the freeze; Paddle's date ${sub.nextBilledAt} kept`);
        return defer('frozen', 15 * MINUTE_MS);
      }
      const later: SubscriptionPatch = { next_billed_at: desired.nextBilledAt, proration_billing_mode: 'do_not_bill' };
      const preview = await previewSubscriptionUpdate(cfg, sub.id, later);
      if (!preview.ok) return paddleFailure(preview);
      if (preview.billsNow) {
        console.error(`[billing-card] REVIEW card=${card.id} Paddle's preview of moving its date later would bill now; not applied`);
        return fail('preview_bills');
      }
      const updated = await updateSubscription(cfg, sub.id, later);
      if (!updated.ok) return paddleFailure(updated);
      mirror = { ...mirror, ...mirrorOf(updated.subscription ?? sub) };
      console.warn(`[billing-card] card=${card.id} Paddle's date ${sub.nextBilledAt} was before ours: moved to ${desired.nextBilledAt}`);
      return defer('moved_later', MINUTE_MS);
    }

    // 6. No further charge: cancel at Paddle's period end.
    if (desired.kind === 'stop_at_period_end') {
      if (sub.scheduledChange?.action === 'cancel') {
        await markSynced(config, card.id, version, { ...mirror, cancel_intent: card.cancel_intent ?? 'period_end' });
        return { status: 'unchanged', detail: desired.reason };
      }
      const res = await cancelAtPaddle(config, cfg, card, 'next_billing_period');
      if (!res.ok) return paddleFailure(res.result);
      mirror = { ...mirror, ...(res.subscription ? mirrorOf(res.subscription) : {}), cancel_intent: 'period_end' };
      await markSynced(config, card.id, version, mirror);
      return { status: 'synced', detail: desired.reason };
    }

    // 7. Renew: undo our own scheduled cancel, then one PATCH of what differs.
    let changed = false;
    if (sub.scheduledChange?.action === 'cancel') {
      const res = await undoScheduledCancel(cfg, sub.id);
      if (!res.ok) return paddleFailure(res);
      sub = res.subscription ?? { ...sub, scheduledChange: null };
      mirror = { ...mirror, ...mirrorOf(sub), cancel_intent: null };
      changed = true;
    } else if (card.cancel_intent) {
      // No cancel at Paddle: an intent left from a cancel Paddle never applied.
      mirror = { ...mirror, cancel_intent: null };
    }
    const patch: SubscriptionPatch = {};
    const wantedCustom = { workspace_id: card.workspace_id, card_id: card.id };
    if (!customDataMatches(sub, wantedCustom)) patch.custom_data = wantedCustom;
    if (!itemMatches(sub, desired.item)) patch.items = [recurringItemFor(cfg, state.targetPlan?.name, desired.item)];
    let held: string | null = null;
    if (!desired.feasible) {
      console.warn(`[billing-card] card=${card.id} the period ends before Paddle can renew it; it expires as usual`);
    } else {
      const paddleAt = Date.parse(sub.nextBilledAt ?? '');
      const wantedAt = Date.parse(desired.nextBilledAt);
      if (!Number.isFinite(paddleAt) || Math.abs(paddleAt - wantedAt) > CARD_SYNC_DATE_TOLERANCE_MS) {
        const paidUntil = lastPaidEnd(state.input) ?? desired.nextBilledAt;
        const earlier = Number.isFinite(paddleAt) && wantedAt < paddleAt;
        if (earlier && state.input.setupPayment?.status === 'pending') {
          // The checkout that saved the card may have paid the very period
          // Paddle is ahead for (a renewal setup) without being settled here
          // yet: settled first if Paddle says it is paid, else the date waits.
          await settleSetupIfPaid(config, card);
          const again = await loadCardState(config, card, Date.now());
          if (again.input.setupPayment?.status === 'pending') {
            console.error(`[billing-card] REVIEW card=${card.id} setup checkout unsettled; Paddle's date ${sub.nextBilledAt} kept`);
            held = 'setup_unsettled';
          }
        }
        if (!held) held = earlier ? await earlierDateBlocked(config, cfg, card, sub, paidUntil) : null;
        if (!held && earlier) {
          // Decided again on what is paid now: a renewal another notification
          // settled while Paddle was asked moved our date on, and the date
          // read before it would have Paddle charge that period again.
          const fresh = desiredCardState((await loadCardState(config, card, Date.now())).input);
          if (fresh.kind === 'renew' && fresh.feasible && paddleAt - Date.parse(fresh.nextBilledAt) > CARD_SYNC_DATE_TOLERANCE_MS) {
            patch.next_billed_at = fresh.nextBilledAt;
          } else {
            held = 'renewal_settled';
          }
        } else if (!held) {
          patch.next_billed_at = desired.nextBilledAt;
        }
      }
    }
    // A renewal just settled changed what is paid: decide again shortly.
    const heldFor = held === 'renewal_settled' ? MINUTE_MS : held === 'renewal_expected' ? 10 * MINUTE_MS : 30 * MINUTE_MS;
    if (!Object.keys(patch).length) {
      if (held) return defer(held, heldFor);
      await markSynced(config, card.id, version, mirror);
      return { status: changed ? 'synced' : 'unchanged' };
    }
    if (patch.items || patch.next_billed_at) patch.proration_billing_mode = 'do_not_bill';
    // P4: a preview that would bill anything stops the sync.
    const preview = await previewSubscriptionUpdate(cfg, sub.id, patch);
    if (!preview.ok) return paddleFailure(preview);
    if (preview.billsNow) {
      console.error(`[billing-card] REVIEW card=${card.id} Paddle's preview of ${JSON.stringify(Object.keys(patch))} would bill now; not applied`);
      return fail('preview_bills');
    }
    const updated = await updateSubscription(cfg, sub.id, patch);
    if (!updated.ok) return paddleFailure(updated);
    const after = updated.subscription ?? sub;
    mirror = { ...mirror, ...mirrorOf(after) };
    if (held) return defer(held, heldFor);
    // An interval swap may move Paddle's date: the next pass corrects it. A
    // date we sent that Paddle did not take is an error (with its back-off),
    // so a Paddle that keeps refusing it is not asked every few minutes.
    const afterAt = Date.parse(after.nextBilledAt ?? '');
    const wantedDate = patch.next_billed_at ?? desired.nextBilledAt;
    const dateOff = desired.feasible && Number.isFinite(afterAt)
      && Math.abs(afterAt - Date.parse(wantedDate)) > CARD_SYNC_DATE_TOLERANCE_MS;
    if (dateOff && patch.next_billed_at) return fail(`paddle_date_not_applied: ${after.nextBilledAt} for ${wantedDate}`);
    await markSynced(config, card.id, dateOff ? version - 1 : version, mirror);
    return { status: 'synced' };
  } catch (e) {
    return fail(messageOf(e));
  }
}

/** A card waiting for its setup payment: a checkout Paddle reports paid is settled now. */
async function settleSetupIfPaid(config: ServerConfig, card: CardRow): Promise<void> {
  try {
    const payment = card.setup_payment_id ? await readAccountPayment(config, card.setup_payment_id) : null;
    if (!payment || payment.status !== 'pending' || !payment.provider_ref) return;
    const gateway = await cardGateway(config, card.workspace_id, card.provider);
    await verifyAccountPayment(config, { payment, providerConfig: gateway.raw, params: {} });
  } catch (e) {
    console.warn(`[billing-card] card=${card.id} setup payment check:`, messageOf(e));
  }
}

/** After a billing action: the workspace's live card is synced now. Best effort; never throws. */
export async function syncWorkspaceCard(config: ServerConfig, workspaceId: string): Promise<void> {
  try {
    const card = await readLiveCard(config, workspaceId);
    if (card) await syncCard(config, card.id);
  } catch (e) {
    console.warn('[billing-card] sync after action:', messageOf(e));
  }
}

// ─── Upgrade charged to the card ───────────────────────────────────────────

/** Our /charge's transaction, by the payment id on its item. */
async function findChargeTransaction(
  cfg: BillingProviderConfig,
  subscriptionId: string,
  paymentId: string,
): Promise<{ ok: boolean; txn: PaddleTransaction | null }> {
  const list = await listSubscriptionTransactions(cfg, subscriptionId, { perPage: 30 });
  if (!list.ok) return { ok: false, txn: null };
  return { ok: true, txn: list.transactions.find((t) => t.itemCustomData.some((d) => d.payment_id === paymentId)) ?? null };
}

/**
 * Why the card declined our /charge (Paddle's payment error code, such as
 * expired_card), when Paddle shows the declined transaction; null when it
 * does not (or cannot be asked). Read only: the row ends as refused, and
 * the transaction's own events find it ended (chargeAlreadyEnded).
 */
async function declinedChargeCode(card: CardRow, cfg: BillingProviderConfig, paymentId: string): Promise<string | null> {
  try {
    const found = await findChargeTransaction(cfg, card.subscription_id, paymentId);
    return found.txn?.errorCode ?? null;
  } catch (e) {
    console.warn(`[billing-card] payment=${paymentId} decline reason:`, messageOf(e));
    return null;
  }
}

/**
 * Binds a /charge transaction to its payment row and settles it when paid.
 * 'succeeded' with the settlement, 'failed' (with why), or 'pending'.
 */
async function resolveChargeTransaction(
  config: ServerConfig,
  card: CardRow,
  payment: CardPayment,
  txn: PaddleTransaction,
): Promise<{ status: 'succeeded'; settled: SettleResult } | { status: 'failed'; reason: string } | { status: 'pending' }> {
  const amount = txn.grandTotalMinor ?? txn.totalMinor ?? 0;
  if (amount > 0) {
    const bound = await recordCharge(config, card, txn, amount);
    if (bound && bound.id !== payment.id) {
      // Paddle's charge did not match our row: it was credited as a top-up, for review.
      console.error(`[billing-card] REVIEW payment=${payment.id} its charge ${txn.id} was recorded as payment ${bound.id}`);
      await failAccountPayment(config, payment.id, 'failed', 'charge_mismatch');
      return { status: 'failed', reason: 'charge_mismatch' };
    }
  }
  if (PAID.has(txn.status)) {
    const settled = await settleCardPayment(config, payment, amount, txn.currency ?? card.currency, txn.id);
    return settled ? { status: 'succeeded', settled } : { status: 'pending' };
  }
  if (txn.status === 'canceled' || txn.status === 'past_due') {
    await failAccountPayment(config, payment.id, 'failed', 'card_declined');
    return { status: 'failed', reason: 'card_declined' };
  }
  return { status: 'pending' };
}

/**
 * Upgrade now, charged to the saved card (design §2.3): exactly the quoted
 * difference, as one /charge that Paddle refuses rather than half-applies
 * (prevent_change), made once per payment row. A charge whose outcome is
 * unknown is never re-posted: it is answered 'processing' and found later by
 * its payment id (resolveCardCharge).
 */
export async function chargeCardForUpgrade(
  config: ServerConfig,
  workspaceId: string,
  input: { planId: string; expectedNetMinor: number; expectedTotalMinor?: number; actorId: string | null },
): Promise<{ status: 'succeeded' | 'processing'; paymentId: string; purposeResult?: Record<string, unknown> | null }> {
  const plans = await import('./plans.js');
  const card = await readLiveCard(config, workspaceId);
  if (!card) throw new AccountBillingError('CARD_NOT_AVAILABLE', 400);
  if (card.status === 'past_due') throw new AccountBillingError('CARD_PAST_DUE', 409);
  const gateway = await cardGateway(config, workspaceId, card.provider).catch(() => null);
  if (!gateway || !cardAutoRenewEnabled(gateway.raw)) throw new AccountBillingError('CARD_NOT_AVAILABLE', 400);
  const freeze = await renewalFreeze(config, card);
  if (freeze.frozen) throw new AccountBillingError('CARD_RENEWAL_IN_PROGRESS', 409, { frozen_until: freeze.until });

  const paid = await plans.paidPeriodOf(config, workspaceId);
  if (!paid) throw new AccountBillingError('QUOTE_CHANGED', 409, { quote: null });
  const quote = await plans.quotePlanChange(config, workspaceId, input.planId, paid.billing_interval);
  const net = plans.quoteNetMinor(quote);
  if (quote.kind !== 'upgrade' || net !== input.expectedNetMinor) throw new AccountBillingError('QUOTE_CHANGED', 409, { quote });
  if (quote.currency !== card.currency) throw new AccountBillingError('CARD_NOT_AVAILABLE', 400);
  const settings = await getBillingSettings(config);
  const vat = vatPercentFor(settings.vat_percent, card.currency);
  const charge = chargeFor(net, vat);
  // The card is charged at once, with no checkout to show the total first:
  // only the total the page showed (VAT included) is charged.
  if (input.expectedTotalMinor !== undefined && charge.total !== input.expectedTotalMinor) {
    throw new AccountBillingError('QUOTE_CHANGED', 409, { quote, vat_percent: vat });
  }
  const minimum = PADDLE_MIN_CHARGE_MINOR[card.currency] ?? 70;
  if (net <= 0 || charge.total < minimum) {
    throw new AccountBillingError('CARD_CHARGE_BELOW_MINIMUM', 400, { minimum_minor: minimum, amount_minor: charge.total });
  }

  // The row first: one pending upgrade charge per workspace (a double click is refused).
  const { data, error } = await getServiceClient(config)
    .from('billing_account_payments')
    .insert({
      workspace_id: workspaceId,
      provider: card.provider,
      currency: card.currency,
      amount_minor: charge.total,
      net_minor: charge.net,
      tax_minor: charge.tax,
      tax_percent: vat,
      purpose: 'upgrade',
      purpose_detail: { plan_id: input.planId, billing_interval: paid.billing_interval, card_id: card.id },
      status: 'pending',
      created_by: input.actorId,
      source: 'card_charge',
      card_id: card.id,
    })
    .select('id')
    .single();
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505' || /uq_billing_account_payments_card_charge|duplicate key/i.test(error.message || '')) {
      throw new AccountBillingError('CARD_CHARGE_IN_PROGRESS', 409);
    }
    throw new Error(error.message || 'payment create failed');
  }
  const paymentId = String((data as { id: string }).id);
  // Paddle refused (or was never asked): nothing was charged, the row ends.
  const refuse = async (reason: string, err: Error): Promise<never> => {
    await failAccountPayment(config, paymentId, 'failed', reason).catch(() => undefined);
    throw err;
  };

  let items: ReturnType<typeof buildChargeItem>[];
  try {
    const plan = await readPlanRow(config, input.planId);
    items = [buildChargeItem({
      name: `Upgrade to ${plan?.name || 'plan'}`,
      description: `Upgrade to ${plan?.name || 'plan'} for the rest of the current period`,
      amountMinor: charge.total,
      currency: card.currency,
      productId: str(gateway.paddle.product_id),
      customData: { payment_id: paymentId, workspace_id: workspaceId },
    })];
    // What Paddle would charge must be exactly this, with no Paddle credit.
    const preview = await previewCharge(gateway.paddle, card.subscription_id, items);
    if (!preview.ok) return refuse('charge_preview_failed', providerError(preview));
    if (preview.grandTotalMinor !== charge.total || (preview.creditMinor ?? 0) !== 0) {
      console.error(`[billing-card] REVIEW payment=${paymentId} Paddle's preview charges ${preview.grandTotalMinor} (credit ${preview.creditMinor}), not ${charge.total}`);
      return refuse('charge_preview_mismatch', new AccountBillingError('CARD_PROVIDER_ERROR', 502, { code: 'preview_mismatch' }));
    }
    // From here Paddle may charge: the row is resolved by looking the charge up, never retried.
    const { data: marked, error: markError } = await getServiceClient(config)
      .from('billing_account_payments')
      .update({ charge_requested_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', paymentId)
      .eq('status', 'pending')
      .select('id');
    if (markError || !Array.isArray(marked) || marked.length !== 1) {
      return refuse('charge_not_requested', new Error(markError?.message || 'the payment is no longer pending'));
    }
  } catch (e) {
    if (e instanceof AccountBillingError) throw e;
    return refuse('charge_not_requested', e instanceof Error ? e : new Error(String(e)));
  }
  const result = await createCharge(gateway.paddle, card.subscription_id, items);
  if (!result.ok) {
    if (result.unknownOutcome) {
      console.warn(`[billing-card] payment=${paymentId} charge outcome unknown (${paddleProblem(result)}); looked up later`);
      return { status: 'processing', paymentId };
    }
    if (result.error?.code === 'subscription_payment_declined') {
      return refuse('card_declined', new AccountBillingError('CARD_DECLINED', 402, {
        code: (await declinedChargeCode(card, gateway.paddle, paymentId)) ?? result.error.code,
      }));
    }
    return refuse(`charge_refused:${result.error?.code ?? result.status}`.slice(0, 200), providerError(result));
  }

  console.log(`[billing-card] charged payment=${paymentId} workspace=${workspaceId} ${charge.total} ${card.currency}`);
  // Paddle charged: from here nothing is an error for the customer; what is
  // not settled now is settled by the webhook, the verify route or the job.
  try {
    const found = await findChargeTransaction(gateway.paddle, card.subscription_id, paymentId);
    if (found.txn) {
      const payment = (await readAccountPayment(config, paymentId)) as CardPayment | null;
      const outcome = payment ? await resolveChargeTransaction(config, card, payment, found.txn) : { status: 'pending' as const };
      if (outcome.status === 'succeeded') {
        await syncCard(config, card.id);
        return { status: 'succeeded', paymentId, purposeResult: outcome.settled.purpose_result ?? null };
      }
    }
  } catch (e) {
    console.warn(`[billing-card] payment=${paymentId} charged; settling later:`, messageOf(e));
  }
  return { status: 'processing', paymentId };
}

/**
 * A pending card_charge row (the verify route, the job): its transaction is
 * found (by the reference it was bound to, else by the payment id on its
 * item), then settled or failed. A charge never asked for ends at once; one
 * Paddle shows no trace of after CARD_CHARGE_GIVE_UP_MS fails (charge_not_found).
 */
export async function resolveCardCharge(config: ServerConfig, payment: AccountPaymentRow): Promise<VerifyOutcome> {
  const row = payment as CardPayment;
  const succeeded = (p: AccountPaymentRow, settled?: SettleResult | null): VerifyOutcome => ({
    status: 'succeeded',
    ledgerId: settled?.ledger_id ?? p.ledger_id,
    receiptNumber: settled?.receipt_number ?? null,
    balanceMinor: settled?.balance_minor,
    purpose: p.purpose,
    purposeResult: settled?.purpose_result ?? p.purpose_result,
  });
  if (row.status === 'succeeded') return succeeded(row);
  if (row.status !== 'pending') return { status: 'failed', reason: row.failure_reason || row.status };
  const card = row.card_id ? await readCard(config, row.card_id) : null;
  if (!card) return { status: 'pending', reason: 'card_not_found' };
  const now = Date.now();
  const cfg = await paddleConfigOf(config, card).catch(() => null);
  if (!cfg) return { status: 'pending', reason: 'provider_not_configured' };

  let txn: PaddleTransaction | null = null;
  if (row.provider_ref) {
    const look = await getTransaction(cfg, row.provider_ref);
    if (!look.ok) return { status: 'pending' };
    txn = look.transaction;
  } else {
    const requested = Date.parse(row.charge_requested_at ?? '');
    if (!Number.isFinite(requested)) {
      // Paddle was never asked (the request stopped before the charge).
      if (now - Date.parse(row.created_at) > CARD_CHARGE_RESOLVE_AFTER_MS) {
        await failAccountPayment(config, row.id, 'failed', 'charge_not_requested');
        return { status: 'failed', reason: 'charge_not_requested' };
      }
      return { status: 'pending' };
    }
    const found = await findChargeTransaction(cfg, card.subscription_id, row.id);
    if (!found.ok) return { status: 'pending' };
    txn = found.txn;
    if (!txn) {
      if (now - requested > CARD_CHARGE_GIVE_UP_MS) {
        await failAccountPayment(config, row.id, 'failed', 'charge_not_found');
        return { status: 'failed', reason: 'charge_not_found' };
      }
      return { status: 'pending' };
    }
  }
  if (!txn) return { status: 'pending' };
  const outcome = await resolveChargeTransaction(config, card, row, txn);
  if (outcome.status === 'succeeded') {
    const fresh = (await readAccountPayment(config, row.id)) ?? row;
    if (!outcome.settled.replayed) await syncCard(config, card.id);
    return succeeded(fresh, outcome.settled.replayed ? null : outcome.settled);
  }
  if (outcome.status === 'failed') return { status: 'failed', reason: outcome.reason };
  return { status: 'pending' };
}

// ─── Remove, auto-renew, change card ───────────────────────────────────────

/** Removes the saved card: cancelled at Paddle first (P7), then here. The plan runs to its end. */
export async function removeCard(config: ServerConfig, workspaceId: string): Promise<{ removed: boolean }> {
  const card = await readLiveCard(config, workspaceId);
  if (!card) throw new AccountBillingError('CARD_NOT_FOUND', 404);
  const cfg = await paddleConfigOf(config, card).catch(() => {
    throw new AccountBillingError('CARD_PROVIDER_ERROR', 502, { code: 'not_configured' });
  });
  const res = await cancelAtPaddle(config, cfg, card, 'immediately');
  if (!res.ok) throw providerError(res.result);
  const after = res.subscription;
  await setCardStatus(config, card.id, 'canceled', 'removed');
  await patchCard(config, card.id, { ...(after ? mirrorOf(after) : { paddle_status: 'canceled' }), cancel_intent: 'now' })
    .catch((e) => console.warn(`[billing-card] card=${card.id} mirror:`, messageOf(e)));
  console.log(`[billing-card] removed card=${card.id} workspace=${workspaceId}`);
  await mailCardRemoved(config, card, 'removed');
  return { removed: true };
}

async function accountAutoRenew(config: ServerConfig, workspaceId: string): Promise<boolean> {
  const { data, error } = await getServiceClient(config)
    .from('billing_accounts')
    .select('auto_renew')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'billing account read failed');
  return (data as { auto_renew?: boolean } | null)?.auto_renew === true;
}

async function writeAutoRenew(config: ServerConfig, workspaceId: string, enabled: boolean): Promise<boolean> {
  const { data, error } = await getServiceClient(config)
    .from('billing_accounts')
    .update({ auto_renew: enabled, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .select('auto_renew')
    .maybeSingle();
  if (error) throw new Error(error.message || 'auto-renew update failed');
  return (data as { auto_renew?: boolean } | null)?.auto_renew === true;
}

/**
 * Auto-renew with a saved card. Off: Paddle cancels at its period end first
 * (P7), then the flag goes off (the card is removed then). On (before that):
 * the flag, then Paddle's scheduled cancel is undone; success only once
 * Paddle confirmed, and a refusal that a retry cannot change turns it back
 * off. Without a live card: the flag alone (the balance renews, 3a).
 */
export async function setCardAutoRenew(config: ServerConfig, workspaceId: string, enabled: boolean): Promise<boolean> {
  const card = await readLiveCard(config, workspaceId);
  if (!card) {
    const region = await getBillingRegion(config);
    const { error } = await getServiceClient(config).rpc('billing_account_ensure', { p_workspace_id: workspaceId, p_currency: region.currency });
    if (error) throw new Error(error.message || 'billing account create failed');
    return writeAutoRenew(config, workspaceId, enabled);
  }
  const cfg = await paddleConfigOf(config, card).catch(() => {
    throw new AccountBillingError('CARD_PROVIDER_ERROR', 502, { code: 'not_configured' });
  });
  const scheduled = card.paddle_scheduled_change?.action === 'cancel';
  if (!enabled) {
    if (card.status === 'past_due') {
      // A cancel at Paddle's period end would leave the declined renewal
      // collectable (Paddle's retries, "update card and pay") and its money
      // unspent: the card stops now, which ends both. The plan runs to its end.
      if (!(await cancelCardNow(config, card.id, 'auto_renew_off'))) {
        throw new AccountBillingError('CARD_PROVIDER_ERROR', 502, { code: 'cancel_failed' });
      }
      await mailCardRemoved(config, card, 'period_end');
      return writeAutoRenew(config, workspaceId, false);
    }
    // Paddle has charged (or is charging) the renewal and it is not recorded
    // yet: off now would leave that payment unspent.
    const freeze = await renewalFreeze(config, card);
    if (freeze.frozen && Date.now() >= Date.parse(freeze.at ?? '')) {
      throw new AccountBillingError('CARD_RENEWAL_IN_PROGRESS', 409, { frozen_until: freeze.until });
    }
    if (!scheduled) {
      const res = await cancelAtPaddle(config, cfg, card, 'next_billing_period');
      if (!res.ok) throw providerError(res.result);
      if (res.subscription) await patchCard(config, card.id, mirrorOf(res.subscription));
    } else if (card.cancel_intent !== 'period_end') {
      await patchCard(config, card.id, { cancel_intent: 'period_end' });
    }
    return writeAutoRenew(config, workspaceId, false);
  }
  const on = await writeAutoRenew(config, workspaceId, true);
  if (scheduled || card.cancel_intent === 'period_end') {
    const res = await undoScheduledCancel(cfg, card.subscription_id);
    if (!res.ok) {
      if (!isTransient(res)) await writeAutoRenew(config, workspaceId, false);
      throw providerError(res);
    }
    await patchCard(config, card.id, { ...(res.subscription ? mirrorOf(res.subscription) : { paddle_scheduled_change: null }), cancel_intent: null });
  }
  await syncCard(config, card.id);
  return on;
}

/**
 * "Change card" (and pay a past_due renewal): Paddle's update-payment-method
 * transaction, opened in Paddle.js. Its zero-amount (or past_due) transaction
 * comes back as a card event that refreshes the card's details.
 */
export async function cardUpdateCheckout(
  config: ServerConfig,
  workspaceId: string,
  input: { successUrl: string; customerEmail?: string },
): Promise<{ clientCheckout: Record<string, unknown>; transactionId: string }> {
  const card = await readLiveCard(config, workspaceId);
  if (!card) throw new AccountBillingError('CARD_NOT_FOUND', 404);
  const gateway = await cardGateway(config, workspaceId, card.provider).catch(() => {
    throw new AccountBillingError('CARD_PROVIDER_ERROR', 502, { code: 'not_configured' });
  });
  const res = await getUpdatePaymentMethodTransaction(gateway.paddle, card.subscription_id);
  if (!res.ok || !res.transactionId) throw providerError(res);
  return {
    clientCheckout: clientCheckoutFor(card.provider, gateway.raw, res.transactionId, input.successUrl, input.customerEmail),
    transactionId: res.transactionId,
  };
}

// ─── The due moment, renewals by hand ──────────────────────────────────────

/**
 * Before the due step: a renewal Paddle charged whose event never reached us
 * is recorded and settled now (so the due moment starts the period it paid).
 * True when one was settled. Never throws.
 */
export async function pullCardRenewal(config: ServerConfig, workspaceId: string): Promise<boolean> {
  try {
    const card = await readLiveCard(config, workspaceId);
    if (!card) return false;
    const cfg = await paddleConfigOf(config, card);
    const list = await listSubscriptionTransactions(cfg, card.subscription_id, { perPage: 10 });
    if (!list.ok) {
      console.warn(`[billing-card] pull card=${card.id}: ${paddleProblem(list)}`);
      return false;
    }
    let pulled = false;
    for (const txn of [...list.transactions].reverse()) {
      if (txn.origin !== 'subscription_recurring' || !PAID.has(txn.status)) continue;
      const amount = txn.grandTotalMinor ?? txn.totalMinor ?? 0;
      if (amount <= 0) continue;
      const payment = await recordCharge(config, card, txn, amount);
      if (!payment || payment.status === 'succeeded') continue;
      const settled = await settleCardPayment(config, payment, amount, txn.currency ?? card.currency, txn.id);
      if (settled && !settled.replayed) {
        console.log(`[billing-card] pulled renewal ${txn.id} card=${card.id} payment=${payment.id}`);
        pulled = true;
      }
    }
    return pulled;
  } catch (e) {
    console.warn(`[billing-card] pull ${workspaceId}:`, messageOf(e));
    return false;
  }
}

/** Cancels at Paddle immediately, then marks the card canceled. Never throws; the job retries 'canceling' cards. */
export async function cancelCardNow(config: ServerConfig, cardId: string, reason?: string): Promise<boolean> {
  let card: CardRow | null = null;
  try {
    card = await readCard(config, cardId);
    if (!card) return false;
    if (card.status === 'canceled') return true;
    const cfg = await paddleConfigOf(config, card);
    const res = await cancelAtPaddle(config, cfg, card, 'immediately');
    if (!res.ok) {
      // Recorded as a sync error (with its back-off); the job tries again.
      console.warn(`[billing-card] cancel card=${card.id}: ${paddleProblem(res.result)}`);
      await markSynced(config, card.id, card.sync_version, {}, `cancel: ${paddleProblem(res.result)}`).catch(() => undefined);
      return false;
    }
    const after = res.subscription;
    const why = reason ?? card.cancel_reason ?? 'canceled';
    await setCardStatus(config, card.id, 'canceled', why);
    await patchCard(config, card.id, { ...(after ? mirrorOf(after) : { paddle_status: 'canceled' }), cancel_intent: 'now' });
    console.log(`[billing-card] canceled card=${card.id} subscription=${card.subscription_id} reason=${why}`);
    return true;
  } catch (e) {
    console.warn(`[billing-card] cancel card=${cardId}:`, messageOf(e));
    return false;
  }
}

/** Moves Paddle's next charge to `at` without billing (preview first, P4). */
async function movePaddleDate(config: ServerConfig, card: CardRow, at: string): Promise<void> {
  const cfg = await paddleConfigOf(config, card).catch(() => {
    throw new AccountBillingError('CARD_PROVIDER_ERROR', 502, { code: 'not_configured' });
  });
  const patch: SubscriptionPatch = { next_billed_at: at, proration_billing_mode: 'do_not_bill' };
  const preview = await previewSubscriptionUpdate(cfg, card.subscription_id, patch);
  if (!preview.ok) throw providerError(preview);
  if (preview.billsNow) {
    console.error(`[billing-card] REVIEW card=${card.id} moving Paddle's date to ${at} would bill now; not applied`);
    throw new AccountBillingError('CARD_PROVIDER_ERROR', 502, { code: 'preview_bills' });
  }
  const updated = await updateSubscription(cfg, card.subscription_id, patch);
  if (!updated.ok) throw providerError(updated);
  if (updated.subscription) await patchCard(config, card.id, mirrorOf(updated.subscription)).catch(() => undefined);
}

/**
 * Whether "renew from balance" will go through: billing_account_renew's
 * guards, with what the page sent (the period, the price) and the balance it
 * will have (a prepayment for a replaced period returns to it first). Only
 * then is Paddle touched before it.
 */
async function balanceRenewalGoes(
  config: ServerConfig,
  card: CardRow,
  input: { expectedPeriodEnd: string | null; expectedPriceMinor: number | null },
  now: number,
): Promise<{ goes: boolean; paid: CardStateInput['paid']; target: CardStateInput['target'] }> {
  const state = await loadCardState(config, card, now);
  const { paid, target } = state.input;
  const price = target && !target.is_free ? target.price_minor : null;
  const sameEnd = !input.expectedPeriodEnd || !paid
    || Math.abs(Date.parse(input.expectedPeriodEnd) - Date.parse(paid.current_period_end)) < 1000;
  const goes = Boolean(paid && target && price !== null && !state.input.prepaidNextEnd && !state.input.v2NextEnd && sameEnd
    && state.balanceMinor + state.stalePrepaidMinor >= price && (input.expectedPriceMinor === null || input.expectedPriceMinor === price));
  return { goes, paid, target };
}

/**
 * "Renew from balance" while a card is saved (design §2.5). A past_due card
 * is cancelled first (refused when Paddle does not confirm), but only for a
 * renewal that will go through: otherwise the renewal's own refusal is
 * answered and the card (with its "update card and pay") stays. An active
 * card: outside the freeze, Paddle's next charge first moves one period on
 * (to the end of the period being prepaid − lead), then the balance pays. If
 * the renewal then fails, the reconciler moves the date back.
 */
export async function renewWithCard(
  config: ServerConfig,
  workspaceId: string,
  input: { actorId: string | null; expectedPeriodEnd: string | null; expectedPriceMinor: number | null },
): Promise<Record<string, unknown>> {
  const plans = await import('./plans.js');
  const renew = () => plans.renewPlan(config, workspaceId, input.actorId, input.expectedPeriodEnd, input.expectedPriceMinor);
  const card = await readLiveCard(config, workspaceId);
  if (!card) return renew();
  const now = Date.now();
  if (card.status === 'past_due') {
    if (!(await balanceRenewalGoes(config, card, input, now)).goes) {
      // billing_account_renew answers why (the card is not touched)...
      const result = await renew();
      // ...or renews after all: Paddle must not collect that period too.
      await setCardStatus(config, card.id, 'canceling', 'renewed_from_balance').catch(() => ({}));
      if (!(await cancelCardNow(config, card.id, 'renewed_from_balance'))) {
        console.error(`[billing-card] REVIEW card=${card.id} renewed from balance while past_due; not cancelled at Paddle yet (the job retries it)`);
      }
      return result;
    }
    if (!(await cancelCardNow(config, card.id, 'renewed_from_balance'))) {
      throw new AccountBillingError('CARD_PROVIDER_ERROR', 502, { code: 'cancel_failed' });
    }
    return renew();
  }
  const freeze = await renewalFreeze(config, card, now);
  if (freeze.frozen) throw new AccountBillingError('CARD_RENEWAL_IN_PROGRESS', 409, { frozen_until: freeze.until });

  // Only a renewal that will go through moves Paddle's date: the guards of
  // billing_account_renew answer anything else, with nothing moved.
  const { goes, paid, target } = await balanceRenewalGoes(config, card, input, now);
  if (!goes || !paid || !target) {
    const result = await renew();
    await syncCard(config, card.id);
    return result;
  }

  const prepaidEnd = periodEndOf(paid.current_period_end, target.interval);
  const { at, feasible } = chargeDateFor(Date.parse(prepaidEnd ?? ''), now);
  const scheduledCancel = card.paddle_scheduled_change?.action === 'cancel' || card.cancel_intent === 'period_end';
  const current = Date.parse(card.paddle_next_billed_at ?? '');
  if (feasible && !scheduledCancel && !(Number.isFinite(current) && current >= at - CARD_SYNC_DATE_TOLERANCE_MS)) {
    await movePaddleDate(config, card, new Date(at).toISOString());
  }
  let result: Record<string, unknown>;
  try {
    result = await renew();
  } catch (e) {
    // Nothing renewed: the reconciler puts Paddle's date back where it belongs.
    await getServiceClient(config).rpc('billing_card_touch_workspace', { p_workspace_id: workspaceId }).then(() => undefined, () => undefined);
    await syncCard(config, card.id);
    throw e;
  }
  // Paddle's date follows the period just paid (also when it was not moved above).
  await syncCard(config, card.id);
  return result;
}

/**
 * Whether plan actions wait for a renewal (CARD_RENEWAL_IN_PROGRESS): around
 * Paddle's mirrored charge date (cardFreeze), or around the charge our own
 * period expects while its renewal is not recorded (ownRenewalFreeze: Paddle
 * moves its date on before that renewal reaches us). Once that charge time
 * has passed, a renewal Paddle charged is pulled and settled first, which
 * ends the second. `at` = the charge time the freeze is about.
 */
async function renewalFreeze(
  config: ServerConfig,
  card: CardRow,
  now = Date.now(),
): Promise<{ frozen: boolean; until: string | null; at: string | null }> {
  const mirrored = cardFreeze(card, now);
  if (mirrored.frozen) return { ...mirrored, at: card.paddle_next_billed_at };
  const own = ownRenewalFreeze((await loadCardState(config, card, now)).input);
  if (!own.frozen || now < Date.parse(own.at ?? '')) return own;
  if (!(await pullCardRenewal(config, card.workspace_id))) return own;
  return ownRenewalFreeze((await loadCardState(config, card, Date.now())).input);
}

/** Plan actions on a card account: refused while the card is past_due or around a renewal (renewalFreeze). No card: nothing. */
export async function assertCardAllowsPlanChange(config: ServerConfig, workspaceId: string): Promise<void> {
  const card = await readLiveCard(config, workspaceId);
  if (!card) return;
  if (card.status === 'past_due') throw new AccountBillingError('CARD_PAST_DUE', 409);
  const freeze = await renewalFreeze(config, card);
  if (freeze.frozen) throw new AccountBillingError('CARD_RENEWAL_IN_PROGRESS', 409, { frozen_until: freeze.until });
}

// ─── The job ───────────────────────────────────────────────────────────────

/**
 * The 5-minute card step (each part on its own; one failure stops nothing):
 *   1. cards to sync (changed, never synced, due for a check; at most 100);
 *   2. paid card checkouts with no card after CARD_ACTIVATION_RECOVERY_MS;
 *   3. upgrade charges still pending after CARD_CHARGE_RESOLVE_AFTER_MS;
 *   4. cards still to cancel at Paddle;
 *   5. live cards whose Paddle charge passed 30 minutes ago with the next
 *      period unpaid (a renewal event lost): Paddle is asked.
 */
export async function runCardJob(config: ServerConfig): Promise<CardJobReport> {
  const report: CardJobReport = { synced: 0, activated: 0, charges: 0, canceled: 0, pulled: 0, errors: [] };
  const sb = getServiceClient(config);
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (e) {
      report.errors.push(`${name}: ${messageOf(e)}`);
    }
  };
  const each = async <T>(name: string, rows: T[], work: (row: T) => Promise<void>) => {
    for (const row of rows) {
      try {
        await work(row);
      } catch (e) {
        report.errors.push(`${name}: ${messageOf(e)}`);
      }
    }
  };

  await step('sync', async () => {
    const { data, error } = await sb.rpc('billing_card_sync_candidates', { p_limit: 100 });
    if (error) throw new Error(error.message);
    await each('sync', ((data ?? []) as Array<{ id: string }>).slice(0, 100), async (row) => {
      const outcome = await syncCard(config, String(row.id));
      if (outcome.status === 'synced' || outcome.status === 'unchanged') report.synced += 1;
      else if (outcome.status === 'canceled') report.canceled += 1;
      else if (outcome.status === 'error') report.errors.push(`sync ${row.id}: ${outcome.detail ?? ''}`);
    });
  });

  await step('activation', async () => {
    const now = Date.now();
    const { data, error } = await sb
      .from('billing_account_payments')
      .select('id, provider, provider_ref, workspace_id')
      .eq('source', 'card_setup')
      .eq('status', 'succeeded')
      .is('card_id', null)
      .lt('completed_at', new Date(now - CARD_ACTIVATION_RECOVERY_MS).toISOString())
      .gte('completed_at', new Date(now - 3 * DAY_MS).toISOString())
      .order('completed_at', { ascending: true })
      .limit(20);
    if (error) throw new Error(error.message);
    await each('activation', (data ?? []) as Array<Record<string, unknown>>, async (row) => {
      const ref = str(row.provider_ref);
      if (!ref) return;
      const providerName = String(row.provider);
      const cfg = (await cardGateway(config, String(row.workspace_id), providerName)).paddle;
      const look = await getTransaction(cfg, ref);
      const subscriptionId = look.transaction?.subscriptionId;
      if (!subscriptionId) {
        if (look.ok) console.warn(`[billing-card] card checkout payment=${row.id} paid, but Paddle shows no subscription for ${ref}`);
        return;
      }
      const activated = await activateCard(config, { providerName, subscriptionId, setupPaymentId: String(row.id), checkoutTransactionId: ref });
      if (activated) report.activated += 1;
    });
  });

  await step('charges', async () => {
    const { data, error } = await sb
      .from('billing_account_payments')
      .select('id')
      .eq('source', 'card_charge')
      .eq('purpose', 'upgrade')
      .eq('status', 'pending')
      .lt('created_at', new Date(Date.now() - CARD_CHARGE_RESOLVE_AFTER_MS).toISOString())
      .order('created_at', { ascending: true })
      .limit(50);
    if (error) throw new Error(error.message);
    await each('charges', (data ?? []) as Array<{ id: string }>, async (row) => {
      const payment = await readAccountPayment(config, String(row.id));
      if (!payment) return;
      const outcome = await resolveCardCharge(config, payment);
      if (outcome.status !== 'pending') report.charges += 1;
    });
  });

  await step('canceling', async () => {
    const { data, error } = await sb
      .from('billing_account_cards')
      .select('id')
      .eq('status', 'canceling')
      .lte('next_sync_at', new Date().toISOString())
      .order('next_sync_at', { ascending: true })
      .limit(50);
    if (error) throw new Error(error.message);
    await each('canceling', (data ?? []) as Array<{ id: string }>, async (row) => {
      if (await cancelCardNow(config, String(row.id))) report.canceled += 1;
    });
  });

  await step('missed_renewals', async () => {
    const { data, error } = await sb
      .from('billing_account_cards')
      .select('id, workspace_id')
      .in('status', ['active', 'past_due'])
      .lt('paddle_next_billed_at', new Date(Date.now() - 30 * MINUTE_MS).toISOString())
      .order('paddle_next_billed_at', { ascending: true })
      .limit(50);
    if (error) throw new Error(error.message);
    await each('missed_renewals', (data ?? []) as Array<{ id: string; workspace_id: string }>, async (row) => {
      const card = await readCard(config, String(row.id));
      if (!card || !isLive(card)) return;
      const state = await loadCardState(config, card);
      if (!state.input.paid || state.input.prepaidNextEnd || state.input.v2NextEnd) return;
      if (await pullCardRenewal(config, card.workspace_id)) report.pulled += 1;
    });
  });

  if (report.errors.length) console.error('[billing-card] job', report.errors.slice(0, 5).join('; '));
  if (report.synced || report.activated || report.charges || report.canceled || report.pulled) {
    console.log('[billing-card] job', JSON.stringify({ ...report, errors: report.errors.length }));
  }
  return report;
}

// ─── Mail ──────────────────────────────────────────────────────────────────

const BRAND_NAMES: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  american_express: 'American Express',
  amex: 'American Express',
  discover: 'Discover',
  diners_club: 'Diners Club',
  jcb: 'JCB',
  maestro: 'Maestro',
  union_pay: 'UnionPay',
  unionpay: 'UnionPay',
  mada: 'Mada',
  cartes_bancaires: 'Cartes Bancaires',
};

/**
 * "Visa •••• 4242": Paddle's card type, named, and the last four digits, for
 * a mail in `locale`. Without a known type, English says "Card"; the Persian
 * and Turkish templates already say "card" next to {card}, so there only the
 * digits are given (and a bare word when there are none).
 */
export function cardLabel(brand: string | null | undefined, last4: string | null | undefined, locale = 'en'): string {
  const key = (brand ?? '').trim().toLowerCase();
  const name = key && key !== 'unknown'
    ? BRAND_NAMES[key] ?? key.split(/[_\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
    : '';
  const generic = locale === 'fa' ? '' : locale === 'tr' ? 'Kart' : 'Card';
  if (last4) return `${name || (locale === 'en' ? generic : '')} •••• ${last4}`.trim();
  return name || generic;
}

const REMOVED_REASONS: Record<string, Record<'removed' | 'canceled_at_paddle' | 'period_end', string>> = {
  en: {
    removed: 'you removed the card',
    canceled_at_paddle: "the automatic payment was cancelled in Paddle's customer portal",
    period_end: 'automatic renewal was turned off',
  },
  fa: {
    removed: 'کارت را حذف کردید',
    canceled_at_paddle: 'پرداخت خودکار در پرتال مشتری Paddle لغو شد',
    period_end: 'تمدید خودکار خاموش شد',
  },
  tr: {
    removed: 'kartı kaldırdınız',
    canceled_at_paddle: "otomatik ödeme Paddle müşteri portalında iptal edildi",
    period_end: 'otomatik yenileme kapatıldı',
  },
};

const FAILURE_REASONS: Record<string, Record<'declined' | 'expired' | 'authentication' | 'funds' | 'other', string>> = {
  en: {
    declined: 'the card issuer declined the payment',
    expired: 'the card has expired',
    authentication: 'the payment needs your confirmation (3-D Secure)',
    funds: 'insufficient funds',
    other: 'the card could not be charged',
  },
  fa: {
    declined: 'بانک صادرکننده‌ی کارت پرداخت را رد کرد',
    expired: 'کارت منقضی شده است',
    authentication: 'پرداخت به تأیید شما (3-D Secure) نیاز دارد',
    funds: 'موجودی کافی نیست',
    other: 'از کارت برداشت نشد',
  },
  tr: {
    declined: 'kartı veren banka ödemeyi reddetti',
    expired: 'kartın süresi dolmuş',
    authentication: 'ödeme onayınızı (3-D Secure) gerektiriyor',
    funds: 'yetersiz bakiye',
    other: 'karttan ödeme alınamadı',
  },
};

function failureText(code: string, locale: string): string {
  const texts = FAILURE_REASONS[locale] ?? FAILURE_REASONS.en;
  // Paddle's error codes (payments[].error_code), as the billing page reads them.
  if (/expired|invalid_payment_details/.test(code)) return texts.expired;
  if (/authentication|3ds|three_d/.test(code)) return texts.authentication;
  if (/not_enough_balance|insufficient/.test(code)) return texts.funds;
  if (/declin|blocked|fraud|lost|stolen|transaction_not_permitted|prepaid_card_not_supported/.test(code)) return texts.declined;
  return texts.other;
}

/** Records a mail as sent once (billing_account_mark_notice); true only the first time. */
async function markNotice(config: ServerConfig, workspaceId: string, key: string): Promise<boolean> {
  const { data, error } = await getServiceClient(config).rpc('billing_account_mark_notice', {
    p_workspace_id: workspaceId,
    p_key: key,
    p_notices: ['sent'],
  });
  if (error) throw new Error(error.message || 'notice record failed');
  return data === true;
}

async function unmarkNotice(config: ServerConfig, workspaceId: string, key: string): Promise<void> {
  await getServiceClient(config)
    .rpc('billing_account_unmark_notice', { p_workspace_id: workspaceId, p_key: key, p_notice: 'sent' })
    .then(() => undefined, () => undefined);
}

/** The card mails (Super Admin templates seeded by migration 262, International edition only). */
const CARD_PAYMENT_FAILED: BillingEmailSlug = 'billing_card_payment_failed';
const CARD_REMOVED: BillingEmailSlug = 'billing_card_removed';

/** billing_card_payment_failed, once per Paddle transaction (notice card_failed:<txn>). Never throws. */
async function mailPaymentFailed(config: ServerConfig, card: CardRow, payment: AccountPaymentRow, txnId: string, code: string): Promise<void> {
  const key = `card_failed:${txnId}`;
  try {
    if (!(await markNotice(config, card.workspace_id, key))) return;
    const state = await loadCardState(config, card).catch(() => null);
    const planId = str(payment.purpose_detail.plan_id) ?? state?.input.target?.plan_id ?? null;
    const plans = await planNamesFor(config, [planId]);
    const sent = await sendBillingEmail(config, card.workspace_id, CARD_PAYMENT_FAILED, (ctx) => ({
      plan_name: localizedPlanName(plans.get(planId ?? ''), ctx.locale),
      amount: ctx.money(payment.amount_minor, payment.currency),
      card: cardLabel(card.brand, card.last4, ctx.locale),
      failure_reason: failureText(code, ctx.locale),
      due_at: ctx.date(state?.input.paid?.current_period_end ?? null),
    }));
    if (!sent.sent) await unmarkNotice(config, card.workspace_id, key);
  } catch (e) {
    console.warn(`[billing-card] payment failed mail card=${card.id}:`, messageOf(e));
  }
}

/** billing_card_removed, once per card (notice card_removed:<card_id>). Never throws. */
async function mailCardRemoved(config: ServerConfig, card: CardRow, reason: 'removed' | 'canceled_at_paddle' | 'period_end'): Promise<void> {
  const key = `card_removed:${card.id}`;
  try {
    if (!(await markNotice(config, card.workspace_id, key))) return;
    const state = await loadCardState(config, card).catch(() => null);
    const planId = state?.input.paid?.plan_id ?? null;
    const plans = await planNamesFor(config, [planId]);
    const paidUntil = state ? lastPaidEnd(state.input) : null;
    const sent = await sendBillingEmail(config, card.workspace_id, CARD_REMOVED, (ctx) => ({
      card: cardLabel(card.brand, card.last4, ctx.locale),
      reason: (REMOVED_REASONS[ctx.locale] ?? REMOVED_REASONS.en)[reason],
      plan_name: localizedPlanName(plans.get(planId ?? ''), ctx.locale),
      period_end: ctx.date(paidUntil),
    }));
    if (!sent.sent) await unmarkNotice(config, card.workspace_id, key);
  } catch (e) {
    console.warn(`[billing-card] removed mail card=${card.id}:`, messageOf(e));
  }
}
