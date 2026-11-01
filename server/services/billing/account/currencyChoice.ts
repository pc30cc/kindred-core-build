// ============================================================================
// WebYar: the account's currency follows the dashboard's language (owner,
// 2026-11-01: temporary, for Apple's App Review; to be removed later).
//
// In the Iranian edition a workspace whose dashboard is in Persian pays in
// Toman (IRR) through the Iranian gateways, exactly as before; any other
// dashboard language pays in US dollars (USD) with crypto through Apirone
// (providers/apirone.ts). The browser knows the language, so it asks for the
// currency (PUT /api/billing/account/:ws/currency); the server only says
// whether the choice exists for this viewer (`currency_choice` on the account
// view) and makes it. Once the account moved money its currency stays: an IRR
// account keeps the Iranian gateways in any language, a USD account keeps
// Apirone (the owner: do not complicate this).
//
// The SQL side is migration 292 (billing_account_choose_currency); the rule
// for "the account is still open" is read here the same way, for the view.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getBillingRegion } from '../edition.js';
import { accountGateways, type GatewayViewer } from './gateways.js';
import {
  ACCOUNT_PAYMENT_TTL_MS,
  AccountBillingError,
  GATEWAY_ENDED_PAYMENT_WINDOW_MS,
  GATEWAY_ENDED_PROVIDERS,
} from './index.js';

/** The currencies a WebYar account can be in (the Iranian edition only). */
export const CHOOSABLE_ACCOUNT_CURRENCIES: readonly string[] = ['IRR', 'USD'];

/** `currency_choice` on the account view: null when there is nothing to choose for this viewer. */
export interface CurrencyChoice {
  /** The currencies the account may be in, each payable by this viewer now (IRR and USD). */
  options: string[];
  /** The account has not moved money (no account yet counts), so PUT …/currency may switch it. */
  switchable: boolean;
}

/** Who is asking: the auth answer of authorizeWorkspaceAccess. */
export interface CurrencyViewer {
  userId: string;
  isAdmin: boolean;
  role: string | null;
}

function dbError(e: { message?: string } | null | undefined, fallback: string): never {
  throw new Error(e?.message || fallback);
}

/**
 * Whether this viewer manages the workspace's billing as a member (owner or
 * admin). A platform admin counts only with such a role in the workspace:
 * browsing a customer's billing page must never switch its currency.
 */
export async function mayChooseAccountCurrency(config: ServerConfig, workspaceId: string, viewer: CurrencyViewer): Promise<boolean> {
  if (!viewer.isAdmin) return viewer.role === 'owner' || viewer.role === 'admin';
  const { data, error } = await getServiceClient(config)
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', viewer.userId)
    .maybeSingle();
  if (error) dbError(error, 'membership read failed');
  const role = (data as { role?: string | null } | null)?.role;
  return role === 'owner' || role === 'admin';
}

/**
 * The account has not moved money, so its currency may still change: no
 * balance, no ledger row, no payment that may still be credited (a recorded
 * confirmation, a pending checkout within its hour, or an Apirone payment
 * that has not succeeded within GATEWAY_ENDED_PAYMENT_WINDOW_MS, whatever
 * its status: its invoice may be paid at the end of its hour and confirmed
 * after it) and no card-to-card request waiting. No account yet is open.
 * The same rule as billing_account_choose_currency (292).
 */
export async function accountCurrencyOpen(config: ServerConfig, workspaceId: string, now = Date.now()): Promise<boolean> {
  const sb = getServiceClient(config);
  const since = new Date(now - ACCOUNT_PAYMENT_TTL_MS).toISOString();
  const gatewaySince = new Date(now - GATEWAY_ENDED_PAYMENT_WINDOW_MS).toISOString();
  const [account, ledger, confirmed, recent, gatewayEnded, transfers] = await Promise.all([
    sb.from('billing_accounts').select('balance_minor').eq('workspace_id', workspaceId).maybeSingle(),
    sb.from('billing_account_ledger').select('id').eq('workspace_id', workspaceId).limit(1),
    sb.from('billing_account_payments').select('id').eq('workspace_id', workspaceId)
      .neq('status', 'succeeded').not('verified_at', 'is', null).limit(1),
    sb.from('billing_account_payments').select('id').eq('workspace_id', workspaceId)
      .eq('status', 'pending').gt('created_at', since).limit(1),
    sb.from('billing_account_payments').select('id').eq('workspace_id', workspaceId)
      .in('provider', [...GATEWAY_ENDED_PROVIDERS]).neq('status', 'succeeded').gt('created_at', gatewaySince).limit(1),
    sb.from('billing_card_transfers').select('id').eq('workspace_id', workspaceId).eq('status', 'pending').limit(1),
  ]);
  for (const r of [account, ledger, confirmed, recent, gatewayEnded, transfers]) {
    if (r.error) dbError(r.error, 'billing account read failed');
  }
  const balance = Number((account.data as { balance_minor?: unknown } | null)?.balance_minor ?? 0);
  if (balance !== 0) return false;
  return [ledger, confirmed, recent, gatewayEnded, transfers].every((r) => !((r.data as unknown[] | null)?.length));
}

/**
 * The choice for the account view: the Iranian edition only, for a viewer
 * who may choose (mayChooseAccountCurrency), and only while both IRR and USD
 * have a gateway listed for this viewer. `listedNow`: the gateways already
 * listed for the account's current currency (the view read them).
 */
export async function currencyChoiceFor(
  config: ServerConfig,
  workspaceId: string,
  viewer: CurrencyViewer,
  current: { currency: string; listed: number },
): Promise<CurrencyChoice | null> {
  if ((await getBillingRegion(config)).edition !== 'iran') return null;
  if (!(await mayChooseAccountCurrency(config, workspaceId, viewer))) return null;
  const gatewayViewer: GatewayViewer = { isPlatformAdmin: viewer.isAdmin };
  for (const currency of CHOOSABLE_ACCOUNT_CURRENCIES) {
    const listed = currency === current.currency
      ? current.listed
      : (await accountGateways(config, workspaceId, currency, gatewayViewer)).length;
    if (listed === 0) return null;
  }
  return { options: [...CHOOSABLE_ACCOUNT_CURRENCIES], switchable: await accountCurrencyOpen(config, workspaceId) };
}

/**
 * Puts the account in `currency` (IRR or USD), creating it in that currency
 * when it has none. The Iranian edition only (400 CURRENCY_NOT_SUPPORTED
 * elsewhere, or for another currency); USD only while a USD gateway is listed
 * for this viewer (409 CURRENCY_NOT_AVAILABLE); an account that moved money
 * keeps its currency (409 CURRENCY_LOCKED), and one with a payment that may
 * still be credited waits (409 CURRENCY_PAYMENT_PENDING). The caller checked
 * mayChooseAccountCurrency.
 */
export async function chooseAccountCurrency(
  config: ServerConfig,
  workspaceId: string,
  requested: string,
  viewer: GatewayViewer,
): Promise<{ currency: string }> {
  const currency = requested.trim().toUpperCase();
  if ((await getBillingRegion(config)).edition !== 'iran' || !CHOOSABLE_ACCOUNT_CURRENCIES.includes(currency)) {
    throw new AccountBillingError('CURRENCY_NOT_SUPPORTED', 400);
  }
  if (currency !== 'IRR' && (await accountGateways(config, workspaceId, currency, viewer)).length === 0) {
    throw new AccountBillingError('CURRENCY_NOT_AVAILABLE', 409);
  }
  const { data, error } = await getServiceClient(config).rpc('billing_account_choose_currency', {
    p_workspace_id: workspaceId,
    p_currency: currency,
  });
  if (error) {
    const message = error.message || '';
    if (message.includes('billing_account_currency_locked')) throw new AccountBillingError('CURRENCY_LOCKED', 409);
    if (message.includes('billing_account_payment_pending')) throw new AccountBillingError('CURRENCY_PAYMENT_PENDING', 409);
    if (message.includes('billing_account_currency_not_allowed')) throw new AccountBillingError('CURRENCY_NOT_SUPPORTED', 400);
    dbError(error, 'billing account currency update failed');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { currency?: unknown } | null;
  return { currency: typeof row?.currency === 'string' && row.currency ? row.currency : currency };
}
