/**
 * Typed wrappers over the SQL financial authority.
 *
 * All money mutations live in Postgres functions (atomic, row-locking,
 * command-idempotent, SECURITY DEFINER, service-role only). This module never
 * computes a balance in JS — it only calls the authority and reads results.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { AiBillingError } from './errors.js';

function rpcError(err: any): never {
  const msg = String(err?.message || err || 'billing_internal_error');
  if (msg.includes('idempotency_conflict')) throw new AiBillingError('idempotency_conflict', msg, 409);
  if (msg.includes('refund_cap_exceeded')) throw new AiBillingError('refund_cap_exceeded', msg, 400);
  throw new AiBillingError('billing_internal_error', msg, 500);
}

async function rpc<T>(config: ServerConfig, fn: string, args: Record<string, unknown>): Promise<T> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc(fn, args as any);
  if (error) rpcError(error);
  return data as T;
}

export interface ReserveResult {
  reservation_id: string;
  requested: number;
  reserved: number;
  shortfall: number;
  replayed: boolean;
}

export function reserve(
  config: ServerConfig,
  args: { workspaceId: string; runId: string | null; amount: string; commandKey?: string | null },
): Promise<ReserveResult> {
  return rpc<ReserveResult>(config, 'ai_reserve', {
    p_workspace_id: args.workspaceId,
    p_run_id: args.runId,
    p_amount: args.amount,
    p_command_key: args.commandKey ?? null,
  });
}

export function topupReservation(config: ServerConfig, runId: string, delta: string): Promise<number> {
  return rpc<number>(config, 'ai_topup_reservation', { p_run_id: runId, p_delta: delta });
}

export function releaseReservation(config: ServerConfig, reservationId: string): Promise<void> {
  return rpc<void>(config, 'ai_release_reservation', { p_reservation_id: reservationId });
}

export interface SettleResult {
  settlement_id: string;
  charged?: number;
  absorbed?: number;
  available_before?: number;
  available_after?: number;
  replayed: boolean;
}

export function settleRun(
  config: ServerConfig,
  args: {
    runId: string;
    commandKey: string;
    providerCostUsd: string;
    internalCostIrr: string;
    customerChargeIrr: string;
    billingCycleId: string;
  },
): Promise<SettleResult> {
  return rpc<SettleResult>(config, 'ai_settle_run', {
    p_run_id: args.runId,
    p_command_key: args.commandKey,
    p_provider_cost_usd: args.providerCostUsd,
    p_internal_cost_irr: args.internalCostIrr,
    p_customer_charge_irr: args.customerChargeIrr,
    p_billing_cycle_id: args.billingCycleId,
  });
}

export function grantAllowance(
  config: ServerConfig,
  args: {
    workspaceId: string;
    amount: string;
    billingCycleId: string;
    allowanceSource?: string;
    expiresAt: string | null;
    commandKey?: string | null;
  },
): Promise<string> {
  return rpc<string>(config, 'ai_grant_allowance', {
    p_workspace_id: args.workspaceId,
    p_amount: args.amount,
    p_billing_cycle_id: args.billingCycleId,
    p_allowance_source: args.allowanceSource ?? 'plan',
    p_expires_at: args.expiresAt,
    p_command_key: args.commandKey ?? null,
  });
}

export function purchaseCredit(
  config: ServerConfig,
  args: { workspaceId: string; amount: string; commandKey: string; reason?: string },
): Promise<string> {
  return rpc<string>(config, 'ai_purchase_credit', {
    p_workspace_id: args.workspaceId,
    p_amount: args.amount,
    p_command_key: args.commandKey,
    p_reason: args.reason ?? 'purchase',
  });
}

export function refundRun(
  config: ServerConfig,
  args: { runId: string; amount: string; reason: string; commandKey: string; actorId?: string | null },
): Promise<{ ledger_entry_id: string; refunded?: number; replayed: boolean }> {
  return rpc(config, 'ai_refund_run', {
    p_run_id: args.runId,
    p_amount: args.amount,
    p_reason: args.reason,
    p_command_key: args.commandKey,
    p_actor: args.actorId ?? null,
  });
}

export function adjustBalance(
  config: ServerConfig,
  args: { workspaceId: string; amount: string; reason: string; commandKey: string; actorId?: string | null },
): Promise<string> {
  return rpc<string>(config, 'ai_adjust_balance', {
    p_workspace_id: args.workspaceId,
    p_amount: args.amount,
    p_reason: args.reason,
    p_command_key: args.commandKey,
    p_actor: args.actorId ?? null,
  });
}

export function expireLots(config: ServerConfig): Promise<number> {
  return rpc<number>(config, 'ai_expire_lots', {});
}

export function availableBalance(config: ServerConfig, workspaceId: string): Promise<number> {
  return rpc<number>(config, 'ai_available_balance', { p_workspace_id: workspaceId });
}

export function reconcileWallet(config: ServerConfig, workspaceId: string): Promise<{ available: number; reserved: number }> {
  return rpc(config, 'ai_reconcile_wallet', { p_workspace_id: workspaceId });
}
