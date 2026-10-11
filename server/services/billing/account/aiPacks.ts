// ============================================================================
// SIMPLE BILLING — AI credit packs (phase 5, migration 264;
// docs/billing/SIMPLE_BILLING.md).
//
// A pack is bought from the balance with one click (billing_account_buy_ai_pack:
// one transaction debits the balance and adds a PURCHASED lot that never
// expires to the AI wallet), or paid online with purpose 'ai_pack' (the
// settlement credits the payment, then buys the pack in the same transaction).
// Packs are sold only while AI billing is ENFORCED: in METER_ONLY credit
// blocks nothing, so selling it would mislead. A payment that settles after
// the mode changed still delivers its pack (the money was paid).
//
// The AI wallet counts in IRR; the page shows it in the account currency with
// the rate the meter charges with (billing_ai_wallet_rate). Without a rate no
// amount is shown and no pack is offered.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getBillingMode, type BillingMode } from '../../ai-billing/mode.js';
import { getBillingRegion } from '../edition.js';
import { AccountBillingError, getBillingSettings, readAccount } from './index.js';
import { sendBillingEmail } from './notify.js';
import { rpc } from './plans.js';
import { activePacks, packLabel, walletToMinor, type AiPack } from '../../../../shared/aiPacks.js';

export type AiSectionReason = null | 'mode' | 'no_packs' | 'no_rate';

export interface AiSection {
  mode: BillingMode;
  /** The account currency packs are sold and amounts shown in. */
  currency: string;
  rate_available: boolean;
  /** The AI wallet in its own unit (IRR): what can be spent now, and its parts. */
  wallet: { available: number; reserved: number; plan_remaining: number; purchased_remaining: number };
  /** The same in minor units of the account currency (rounded down); null without a rate. */
  display: { available_minor: number; plan_remaining_minor: number; purchased_remaining_minor: number } | null;
  /** When the plan's monthly credit runs out (the earliest plan lot); null without one. */
  plan_expires_at: string | null;
  /** The packs on offer; empty unless sellable. */
  packs: AiPack[];
  sellable: boolean;
  reason: AiSectionReason;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** AI wallet units (IRR) per one major unit of `currency`; null when no rate exists (or it cannot be read). */
export async function aiWalletRate(config: ServerConfig, currency: string): Promise<number | null> {
  try {
    const { data, error } = await getServiceClient(config).rpc('billing_ai_wallet_rate', { p_currency: currency });
    if (error) throw new Error(error.message || 'rate read failed');
    const rate = data === null || data === undefined ? NaN : Number(data);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch (e) {
    console.warn('[billing-account] AI wallet rate:', e instanceof Error ? e.message : e);
    return null;
  }
}

interface LotRow {
  source_type: string;
  remaining_amount: unknown;
  reserved_amount: unknown;
  expires_at: string | null;
}

async function walletOf(config: ServerConfig, workspaceId: string, now = Date.now()) {
  const { data, error } = await getServiceClient(config)
    .from('workspace_ai_balance_lots')
    .select('source_type, remaining_amount, reserved_amount, expires_at')
    .eq('workspace_id', workspaceId)
    .in('state', ['ACTIVE', 'EXPIRING']);
  if (error) throw new Error(error.message || 'AI wallet read failed');
  let reserved = 0;
  let plan = 0;
  let purchased = 0;
  let planExpires: number | null = null;
  for (const lot of (data ?? []) as LotRow[]) {
    // A lot past its end is spent by nothing (ai_reserve), even before ai_expire_lots marks it.
    const expires = lot.expires_at ? Date.parse(lot.expires_at) : null;
    if (expires !== null && Number.isFinite(expires) && expires <= now) continue;
    const held = num(lot.reserved_amount);
    const free = Math.max(num(lot.remaining_amount) - held, 0);
    reserved += held;
    // Credit that ends (the plan's, and a refund's compensation for an ended plan lot,
    // 073 ai_refund_run) is shown with its end date; only credit with no end
    // (PURCHASED, ADJUSTMENT) counts as "never expires".
    if (lot.source_type === 'PLAN_ALLOWANCE' || expires !== null) {
      plan += free;
      if (free > 0 && expires !== null && Number.isFinite(expires) && (planExpires === null || expires < planExpires)) planExpires = expires;
    } else {
      purchased += free;
    }
  }
  return {
    wallet: { available: plan + purchased, reserved, plan_remaining: plan, purchased_remaining: purchased },
    plan_expires_at: planExpires === null ? null : new Date(planExpires).toISOString(),
  };
}

/** The AI part of the billing page: the wallet in the account currency, and the packs on offer. Read-only. */
export async function aiSection(config: ServerConfig, workspaceId: string): Promise<AiSection> {
  const [mode, account, settings] = await Promise.all([
    getBillingMode(config),
    readAccount(config, workspaceId),
    getBillingSettings(config),
  ]);
  const currency = account?.currency ?? (await getBillingRegion(config)).currency;
  const [rate, { wallet, plan_expires_at }] = await Promise.all([
    aiWalletRate(config, currency),
    walletOf(config, workspaceId),
  ]);
  const offered = activePacks(settings.ai_packs, currency);
  const reason: AiSectionReason = mode !== 'ENFORCED' ? 'mode' : offered.length === 0 ? 'no_packs' : rate === null ? 'no_rate' : null;
  const display = rate === null
    ? null
    : {
        available_minor: walletToMinor(wallet.available, rate, currency) ?? 0,
        plan_remaining_minor: walletToMinor(wallet.plan_remaining, rate, currency) ?? 0,
        purchased_remaining_minor: walletToMinor(wallet.purchased_remaining, rate, currency) ?? 0,
      };
  return {
    mode,
    currency,
    rate_available: rate !== null,
    wallet,
    display,
    plan_expires_at,
    packs: reason === null ? offered : [],
    sellable: reason === null,
    reason,
  };
}

/** Packs are sold only while AI billing is ENFORCED (decision D5). */
async function assertPacksSold(config: ServerConfig): Promise<void> {
  if ((await getBillingMode(config)) !== 'ENFORCED') throw new AccountBillingError('AI_PACKS_UNAVAILABLE', 409);
}

/** What billing_account_buy_ai_pack answers (also a settled ai_pack payment's purpose_result). */
export interface AiPackResult extends Record<string, unknown> {
  action?: string;
  replayed?: boolean;
  pack_ledger_id?: string;
  lot_id?: string | null;
  pack_id?: string;
  price_minor?: number;
  credit_minor?: number;
  currency?: string;
  wallet_amount?: number;
  balance_minor?: number;
}

/**
 * Buys a pack from the balance. `key` is `<workspace>:<the browser's key>`:
 * a retried click buys once (the replay is answered before the pack is looked
 * up, so it holds after Super Admin edits or removes the pack). The mail goes
 * out once, never for a replay.
 */
export async function buyAiPack(
  config: ServerConfig,
  workspaceId: string,
  input: { packId: string; expectedPriceMinor: number | null; key: string; actorId: string | null },
): Promise<AiPackResult> {
  await assertPacksSold(config);
  const result = (await rpc(config, 'billing_account_buy_ai_pack', {
    p_workspace_id: workspaceId,
    p_pack_id: input.packId,
    p_expected_price_minor: input.expectedPriceMinor,
    p_key: input.key,
    p_actor: input.actorId,
  })) as AiPackResult;
  if (!result.replayed) await afterAiPack(config, workspaceId, result);
  return result;
}

/** The pack's label as it was bought (the ai_pack ledger row keeps it); null when it had none. */
async function boughtLabel(config: ServerConfig, ledgerId: unknown): Promise<AiPack['label'] | null> {
  if (typeof ledgerId !== 'string' || !ledgerId) return null;
  const { data } = await getServiceClient(config)
    .from('billing_account_ledger')
    .select('description')
    .eq('id', ledgerId)
    .maybeSingle();
  const label = (data as { description?: { label?: unknown } | null } | null)?.description?.label;
  return label && typeof label === 'object' && !Array.isArray(label) ? (label as AiPack['label']) : null;
}

/**
 * The mail's {pack_name} for a pack with no name in the mail's language. Not
 * its credit: the seeded bodies follow {pack_name} with {credit}, so that
 * would read "$6.00: $6.00 of AI credit was added".
 */
const UNNAMED_PACK: Record<string, string> = {
  fa: 'بسته‌ی اعتبار هوش مصنوعی',
  en: 'AI credit pack',
  tr: 'Yapay zekâ kredi paketi',
};
function unnamedPack(locale: string): string {
  return UNNAMED_PACK[locale.toLowerCase().split('-')[0]] ?? UNNAMED_PACK.en;
}

/**
 * After a pack was bought (from the balance, or by a settled payment): the
 * billing_ai_pack_purchased mail. {pack_name} is the pack's label in the
 * mail's language, else a generic pack name; {ai_balance} is empty without a rate.
 * Never throws: the pack is already in the wallet.
 */
export async function afterAiPack(config: ServerConfig, workspaceId: string, result: AiPackResult): Promise<void> {
  try {
    const currency = String(result.currency ?? '') || (await readAccount(config, workspaceId))?.currency || (await getBillingRegion(config)).currency;
    const [label, section] = await Promise.all([
      boughtLabel(config, result.pack_ledger_id).catch(() => null),
      aiSection(config, workspaceId).catch(() => null),
    ]);
    const credit = num(result.credit_minor);
    await sendBillingEmail(config, workspaceId, 'billing_ai_pack_purchased', (ctx) => ({
      pack_name: packLabel({ label: label ?? undefined }, ctx.locale, unnamedPack(ctx.locale)),
      credit: ctx.money(credit, currency),
      amount: ctx.money(num(result.price_minor), currency),
      balance: ctx.money(num(result.balance_minor), currency),
      ai_balance: section?.display && section.currency === currency ? ctx.money(section.display.available_minor, currency) : '',
    }));
  } catch (e) {
    console.warn('[billing-account] after AI pack:', e instanceof Error ? e.message : e);
  }
}

/**
 * What paying online for a pack must charge (the checkout route adds the
 * top-up minimum and VAT): the pack's price, against the balance. The pack is
 * checked now as the SQL will check it at settlement: sold (ENFORCED), a rate
 * for the account currency, active, and at the price the page showed (else
 * QUOTE_CHANGED with the pack as it is now, or null when it is gone). The
 * detail travels with the payment to its settlement.
 */
export async function aiPackNeed(
  config: ServerConfig,
  workspaceId: string,
  input: { packId: string; expectedPriceMinor?: number | null },
): Promise<{ needed: number; currency: string; balance: number; detail: Record<string, unknown> }> {
  await assertPacksSold(config);
  const [account, settings] = await Promise.all([readAccount(config, workspaceId), getBillingSettings(config)]);
  const currency = account?.currency ?? (await getBillingRegion(config)).currency;
  const balance = account?.balance_minor ?? 0;
  const pack = activePacks(settings.ai_packs, currency).find((p) => p.id === input.packId) ?? null;
  if (!pack) throw new AccountBillingError('AI_PACK_NOT_AVAILABLE', 409, { pack: null });
  if (input.expectedPriceMinor !== undefined && input.expectedPriceMinor !== null && input.expectedPriceMinor !== pack.price_minor) {
    throw new AccountBillingError('QUOTE_CHANGED', 409, { pack });
  }
  if ((await aiWalletRate(config, currency)) === null) throw new AccountBillingError('AI_CREDIT_UNAVAILABLE', 409);
  return {
    needed: pack.price_minor,
    currency,
    balance,
    detail: {
      pack_id: pack.id,
      price_minor: pack.price_minor,
      credit_minor: pack.credit_minor,
      credit_currency: currency,
      label: pack.label ?? null,
    },
  };
}
