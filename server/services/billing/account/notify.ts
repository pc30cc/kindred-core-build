// ============================================================================
// SIMPLE BILLING — the billing emails (docs/billing/SIMPLE_BILLING.md, Emails).
//
// Every billing email is a Super Admin template of the running edition
// (Branding → Email templates, migration 261), sent through sendEmail with
// no text of its own: a missing template is a logged failure, never
// hard-coded copy. This module only fills the template's variables, in the
// edition's own way: Toman and the Persian calendar in the Iranian edition,
// the account's currency and the Gregorian calendar otherwise.
// ============================================================================

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { resolveEmailScope, sendEmail } from '../../email/index.js';
import { getPlatformEditionOrNull } from '../../platformRegion.js';
import { resolveWorkspaceAppUrl } from '../../auth-email.js';
import type { Edition } from '../../../../shared/edition.js';

export type BillingEmailSlug =
  | 'billing_renewal_reminder'
  | 'billing_renewed'
  | 'billing_expired'
  | 'billing_plan_changed'
  | 'billing_change_scheduled'
  | 'billing_payment_receipt'
  | 'billing_plan_activated'
  | 'billing_trial_ending'
  | 'billing_trial_ended';

/** Decimal places of a currency's minor unit; IRR is kept in whole Rial. */
const DECIMALS: Record<string, number> = { IRR: 0, USD: 2, EUR: 2, GBP: 2, TRY: 2 };

const intlLocale = (edition: Edition | null, locale: string): string => {
  // Persian outside the Iranian edition keeps the Gregorian calendar ('fa'
  // alone defaults to the Persian one).
  if (locale === 'fa') return edition === 'iran' ? 'fa-IR' : 'fa-u-ca-gregory';
  if (locale === 'tr') return 'tr-TR';
  return 'en-US';
};

/**
 * An amount for an email. Rial is shown as Toman (÷10) with the Persian unit
 * name in Persian; every other currency in its own format.
 */
export function formatBillingMoney(edition: Edition | null, locale: string, currency: string, minor: number): string {
  const code = currency.toUpperCase();
  if (code === 'IRR') {
    const toman = Math.round(minor / 10);
    const number = new Intl.NumberFormat(intlLocale(edition, locale)).format(toman);
    return locale === 'fa' ? `${number} تومان` : `${number} Toman`;
  }
  const decimals = DECIMALS[code] ?? 2;
  try {
    return new Intl.NumberFormat(intlLocale(edition, locale), {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(minor / 10 ** decimals);
  } catch {
    return `${(minor / 10 ** decimals).toFixed(decimals)} ${code}`;
  }
}

/** A date for an email: the Persian calendar in the Iranian edition's Persian mail. */
export function formatBillingDate(edition: Edition | null, locale: string, iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const tag = locale === 'fa' && edition === 'iran' ? 'fa-IR-u-ca-persian' : intlLocale(edition, locale);
  return new Intl.DateTimeFormat(tag, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: edition === 'iran' ? 'Asia/Tehran' : 'UTC',
  }).format(date);
}

/** A whole number in the locale's digits (days left). */
export function formatBillingNumber(edition: Edition | null, locale: string, value: number): string {
  return new Intl.NumberFormat(intlLocale(edition, locale)).format(value);
}

export interface BillingRecipient {
  email: string;
  locale: string;
  workspaceName: string;
}

/**
 * Who gets a workspace's billing mail: the billing profile's invoice email
 * when set, else the owner; in the owner's language, else the platform's.
 */
export async function billingRecipient(config: ServerConfig, workspaceId: string): Promise<BillingRecipient | null> {
  const sb = getServiceClient(config);
  const { data: ws } = await sb.from('workspaces').select('name, owner_id').eq('id', workspaceId).maybeSingle();
  const workspace = (ws ?? {}) as { name?: string | null; owner_id?: string | null };
  let ownerEmail = '';
  let ownerLocale = '';
  if (workspace.owner_id) {
    const { data: profile } = await sb.from('profiles').select('email, preferred_locale').eq('id', workspace.owner_id).maybeSingle();
    const p = (profile ?? {}) as { email?: string | null; preferred_locale?: string | null };
    ownerEmail = typeof p.email === 'string' ? p.email.trim() : '';
    ownerLocale = typeof p.preferred_locale === 'string' ? p.preferred_locale : '';
  }
  const { data: account } = await sb.from('billing_accounts').select('billing_profile').eq('workspace_id', workspaceId).maybeSingle();
  const profile = ((account as { billing_profile?: Record<string, unknown> } | null)?.billing_profile ?? {}) as Record<string, unknown>;
  const invoiceEmail = typeof profile.invoice_email === 'string' ? profile.invoice_email.trim() : '';
  const email = invoiceEmail.includes('@') ? invoiceEmail : ownerEmail;
  if (!email.includes('@')) return null;
  let locale = ownerLocale;
  if (!locale) {
    const { data: settings } = await sb.from('platform_settings').select('default_locale').limit(1).maybeSingle();
    locale = String((settings as { default_locale?: string | null } | null)?.default_locale || 'en');
  }
  return { email, locale: locale.toLowerCase().split('-')[0], workspaceName: String(workspace.name || '') };
}

export interface BillingEmailContext {
  edition: Edition | null;
  locale: string;
  money: (minor: number | null | undefined, currency: string) => string;
  date: (iso: string | null | undefined) => string;
  number: (value: number) => string;
}

/**
 * Sends one billing email to the workspace's billing recipient. `build`
 * receives the edition's formatters and returns the template's variables;
 * billing_url (and receipt_url for a ledger id) are added here.
 */
export async function sendBillingEmail(
  config: ServerConfig,
  workspaceId: string,
  slug: BillingEmailSlug,
  build: (ctx: BillingEmailContext) => Record<string, string>,
  options: { receiptLedgerId?: string | null } = {},
): Promise<{ sent: boolean; error?: string }> {
  try {
    const recipient = await billingRecipient(config, workspaceId);
    if (!recipient) return { sent: false, error: 'no_recipient' };
    const edition = await getPlatformEditionOrNull(config);
    // The language the template will be sent in (sendEmail clamps it the
    // same way: Iran sends Persian only).
    const scope = await resolveEmailScope(config, recipient.locale);
    const locale = scope?.locales[0] ?? recipient.locale;
    const ctx: BillingEmailContext = {
      edition,
      locale,
      money: (minor, currency) => (minor === null || minor === undefined ? '' : formatBillingMoney(edition, locale, currency, minor)),
      date: (iso) => formatBillingDate(edition, locale, iso),
      number: (value) => formatBillingNumber(edition, locale, value),
    };
    const data: Record<string, string> = {
      workspace: recipient.workspaceName,
      billing_url: await resolveWorkspaceAppUrl(config, workspaceId, '/billing'),
      ...build(ctx),
    };
    if (options.receiptLedgerId) {
      data.receipt_url = await resolveWorkspaceAppUrl(config, workspaceId, `/billing/receipts/${options.receiptLedgerId}`);
    }
    const result = await sendEmail(config, {
      workspaceId,
      to: recipient.email,
      templateSlug: slug,
      templateData: data,
      locale: recipient.locale,
    });
    if (!result.success) {
      console.warn(`[billing-email] ${slug} for ${workspaceId} not sent: ${result.error ?? 'unknown'}`);
      return { sent: false, error: result.error };
    }
    return { sent: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[billing-email] ${slug} for ${workspaceId} failed: ${message}`);
    return { sent: false, error: message };
  }
}

/** A plan's name in the mail's language (billing_plans.localized), else its own name. */
export async function planNamesFor(
  config: ServerConfig,
  planIds: Array<string | null | undefined>,
): Promise<Map<string, { name: string; localized: Record<string, { name?: string }> }>> {
  const ids = [...new Set(planIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const out = new Map<string, { name: string; localized: Record<string, { name?: string }> }>();
  if (!ids.length) return out;
  const { data } = await getServiceClient(config).from('billing_plans').select('id, name, localized').in('id', ids);
  for (const row of (data ?? []) as Array<{ id: string; name: string; localized?: Record<string, { name?: string }> | null }>) {
    out.set(row.id, { name: row.name, localized: row.localized ?? {} });
  }
  return out;
}

const INTERVAL_LABELS: Record<string, Record<string, string>> = {
  fa: { monthly: 'ماهانه', yearly: 'سالانه' },
  en: { monthly: 'monthly', yearly: 'yearly' },
  tr: { monthly: 'aylık', yearly: 'yıllık' },
};

/** "monthly" / "yearly" in the mail's language. */
export function billingIntervalLabel(interval: string, locale: string): string {
  return (INTERVAL_LABELS[locale] ?? INTERVAL_LABELS.en)[interval] ?? interval;
}

export function localizedPlanName(
  plan: { name: string; localized: Record<string, { name?: string }> } | undefined,
  locale: string,
): string {
  if (!plan) return '';
  const own = plan.localized?.[locale]?.name;
  return typeof own === 'string' && own.trim() ? own.trim() : plan.name;
}
