// ============================================================
// WALLET — typed wrappers over the atomic SQL wallet authority.
//
// There is deliberately NO balance arithmetic in this file. Reading a balance
// and then writing `balance - amount` from JavaScript is exactly the race that
// loses or duplicates customer money under concurrent callbacks; every mutation
// below is a single database call that locks the wallet row, appends to the
// append-only ledger and re-syncs the cached balance in one transaction.
//
// Wallet money is real customer money in IRR. It is NOT AI credit and can
// never be spent as AI credit — the only way wallet money becomes AI credit is
// by paying an `ai_credit_purchase` invoice.
// ============================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { insertWithDocumentNumber } from '../invoiceNumber.js';

export interface WalletBalance {
  workspace_id: string;
  available_balance_irr: number;
  frozen: boolean;
}

export interface WalletEntryResult {
  entry_id: string;
  balance_after_irr: number;
}

export interface WalletDepositRow {
  id: string;
  workspace_id: string;
  document_number: string;
  amount_irr: number;
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'canceled';
  created_at: string;
  paid_at: string | null;
}

function fail(error: { message?: string | null } | null): never {
  throw new Error(String(error?.message || 'wallet_operation_failed'));
}

/** Reads the cached balance. Never used as an authority for a debit. */
export async function getWalletBalance(
  config: ServerConfig,
  workspaceId: string,
): Promise<WalletBalance> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('billing_wallet_accounts')
    .select('workspace_id, available_balance_irr, frozen')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  return (
    (data as WalletBalance | null) ?? {
      workspace_id: workspaceId,
      available_balance_irr: 0,
      frozen: false,
    }
  );
}

/**
 * Creates a wallet deposit document.
 *
 * A deposit is a RECEIPT, not an invoice: it buys no service and applies no
 * entitlement. It only converts gateway money into wallet balance, which can
 * later pay invoices.
 */
export async function createWalletDeposit(
  config: ServerConfig,
  input: { workspaceId: string; amountIrr: number; metadata?: Record<string, unknown> },
): Promise<WalletDepositRow> {
  const amount = Math.round(Number(input.amountIrr));
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('deposit_amount_invalid');

  const sb = getServiceClient(config);
  return insertWithDocumentNumber<WalletDepositRow>(async (documentNumber) => {
    const { data, error } = await sb
      .from('billing_wallet_deposits')
      .insert({
        workspace_id: input.workspaceId,
        document_number: documentNumber,
        amount_irr: amount,
        status: 'pending',
        metadata: input.metadata ?? {},
      })
      .select('*')
      .single();
    return { data: data as WalletDepositRow | null, error };
  });
}

/** Credits verified gateway money to the wallet. Idempotent per deposit. */
export async function applyWalletDeposit(
  config: ServerConfig,
  input: { depositId: string; amountIrr: number; paymentId?: string | null },
): Promise<{ deposit_id: string; entry_id: string; replayed: boolean }> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_wallet_apply_deposit', {
    p_deposit_id: input.depositId,
    p_amount_irr: input.amountIrr,
    p_payment_id: input.paymentId ?? null,
  });
  if (error) fail(error);
  return data as { deposit_id: string; entry_id: string; replayed: boolean };
}

export async function refundWallet(
  config: ServerConfig,
  input: { workspaceId: string; amountIrr: number; commandKey: string; reason?: string; actorId?: string | null },
): Promise<WalletEntryResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_wallet_refund', {
    p_workspace_id: input.workspaceId,
    p_amount_irr: input.amountIrr,
    p_command_key: input.commandKey,
    p_reason: input.reason ?? 'refund',
    p_actor_id: input.actorId ?? null,
  });
  if (error) fail(error);
  return data as WalletEntryResult;
}

/**
 * Manual money movement by a platform admin. A reason and an actor are
 * mandatory (the RPC rejects a blank reason) so every adjustment is auditable.
 */
export async function adminAdjustWallet(
  config: ServerConfig,
  input: { workspaceId: string; amountIrr: number; commandKey: string; reason: string; actorId: string },
): Promise<WalletEntryResult> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_wallet_admin_adjust', {
    p_workspace_id: input.workspaceId,
    p_amount_irr: input.amountIrr,
    p_command_key: input.commandKey,
    p_reason: input.reason,
    p_actor_id: input.actorId,
  });
  if (error) fail(error);
  return data as WalletEntryResult;
}

/** Recomputes the balance from the append-only ledger and reports drift. */
export async function reconcileWallet(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ ledger_balance_irr: number; cached_balance_irr: number; drift_irr: number; consistent: boolean }> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('billing_wallet_reconcile', { p_workspace_id: workspaceId });
  if (error) fail(error);
  return data as {
    ledger_balance_irr: number;
    cached_balance_irr: number;
    drift_irr: number;
    consistent: boolean;
  };
}
