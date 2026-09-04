// ============================================================
// BILLING NOTIFICATION COPY — fa (default), en, tr.
//
// Pure rendering. No IO, no database, no financial decision: every number the
// customer reads was computed by the SQL lifecycle and arrives here already
// decided, so this module can never disagree with the ledger.
//
// Amounts are IRR integers formatted with a locale-appropriate grouping, and
// dates are rendered in the Tehran calendar for `fa` — the same convention the
// rest of the Iran billing surface uses.
// ============================================================

export type BillingNotificationType =
  | 'invoice_issued'
  | 'invoice_reminder'
  | 'invoice_due'
  | 'wallet_autopay_insufficient'
  | 'invoice_past_due'
  | 'payment_received'
  | 'subscription_restored'
  | 'subscription_free_fallback';

export type BillingLocale = 'fa' | 'en' | 'tr';

export interface RenderedMessage {
  subject: string;
  text: string;
}

export function normalizeLocale(locale: string | null | undefined): BillingLocale {
  return locale === 'en' || locale === 'tr' ? locale : 'fa';
}

export function formatIrr(amount: unknown, locale: BillingLocale): string {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return '0';
  const grouped = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US', {
    maximumFractionDigits: 0,
  }).format(Math.round(n));
  return locale === 'fa' ? `${grouped} ریال` : locale === 'tr' ? `${grouped} IRR` : `${grouped} IRR`;
}

export function formatDate(value: unknown, locale: BillingLocale): string {
  if (!value) return '—';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(
      locale === 'fa' ? 'fa-IR-u-ca-persian' : locale === 'tr' ? 'tr-TR' : 'en-US',
      { dateStyle: 'medium', timeZone: 'Asia/Tehran' },
    ).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

interface Ctx {
  invoiceNumber: string;
  amount: string;
  dueAt: string;
  graceEndsAt: string;
  planName: string;
}

type Copy = Record<BillingNotificationType, (c: Ctx) => RenderedMessage>;

const FA: Copy = {
  invoice_issued: (c) => ({
    subject: `صورتحساب ${c.invoiceNumber} صادر شد`,
    text: `صورتحساب ${c.invoiceNumber} به مبلغ ${c.amount} صادر شد. مهلت پرداخت: ${c.dueAt}.\nصدور صورتحساب باعث کسر خودکار از کیف پول نمی‌شود؛ در تاریخ سررسید پرداخت انجام می‌شود.`,
  }),
  invoice_reminder: (c) => ({
    subject: `یادآوری پرداخت صورتحساب ${c.invoiceNumber}`,
    text: `مهلت پرداخت صورتحساب ${c.invoiceNumber} به مبلغ ${c.amount} تا ${c.dueAt} است. برای جلوگیری از وقفه در سرویس، پیش از سررسید پرداخت کنید یا موجودی کیف پول را افزایش دهید.`,
  }),
  invoice_due: (c) => ({
    subject: `سررسید صورتحساب ${c.invoiceNumber}`,
    text: `امروز سررسید صورتحساب ${c.invoiceNumber} به مبلغ ${c.amount} است.`,
  }),
  wallet_autopay_insufficient: (c) => ({
    subject: `موجودی کیف پول برای پرداخت صورتحساب ${c.invoiceNumber} کافی نبود`,
    text: `موجودی کیف پول برای پرداخت خودکار صورتحساب ${c.invoiceNumber} به مبلغ ${c.amount} کافی نبود. لطفاً کیف پول را شارژ کنید یا صورتحساب را مستقیماً پرداخت کنید.`,
  }),
  invoice_past_due: (c) => ({
    subject: `صورتحساب ${c.invoiceNumber} پرداخت نشده است`,
    text: `صورتحساب ${c.invoiceNumber} به مبلغ ${c.amount} در سررسید پرداخت نشد. تا ${c.graceEndsAt} فرصت دارید پرداخت کنید؛ پس از آن سرویس به پلن رایگان منتقل می‌شود. اطلاعات شما حذف نمی‌شود.`,
  }),
  payment_received: (c) => ({
    subject: `پرداخت صورتحساب ${c.invoiceNumber} تأیید شد`,
    text: `پرداخت صورتحساب ${c.invoiceNumber} به مبلغ ${c.amount} با موفقیت ثبت شد.`,
  }),
  subscription_restored: () => ({
    subject: 'اشتراک شما دوباره فعال شد',
    text: 'پرداخت شما دریافت شد و اشتراک از حالت بدهی خارج و فعال شد.',
  }),
  subscription_free_fallback: (c) => ({
    subject: 'اشتراک شما به پلن رایگان منتقل شد',
    text: `به دلیل پرداخت نشدن صورتحساب در مهلت تعیین‌شده، فضای کاری شما به پلن «${c.planName}» منتقل شد. هیچ داده‌ای حذف نشده است و با ارتقای پلن، سرویس دوباره در دسترس قرار می‌گیرد.`,
  }),
};

const EN: Copy = {
  invoice_issued: (c) => ({
    subject: `Invoice ${c.invoiceNumber} issued`,
    text: `Invoice ${c.invoiceNumber} for ${c.amount} has been issued and is due on ${c.dueAt}.\nIssuing an invoice does not debit your wallet; payment is taken on the due date.`,
  }),
  invoice_reminder: (c) => ({
    subject: `Reminder: invoice ${c.invoiceNumber} is due soon`,
    text: `Invoice ${c.invoiceNumber} for ${c.amount} is due on ${c.dueAt}. Pay it or top up your wallet before the due date to avoid a service interruption.`,
  }),
  invoice_due: (c) => ({
    subject: `Invoice ${c.invoiceNumber} is due today`,
    text: `Invoice ${c.invoiceNumber} for ${c.amount} is due today.`,
  }),
  wallet_autopay_insufficient: (c) => ({
    subject: `Wallet balance was not enough for invoice ${c.invoiceNumber}`,
    text: `Automatic payment of invoice ${c.invoiceNumber} for ${c.amount} failed because the wallet balance was insufficient. Top up your wallet or pay the invoice directly.`,
  }),
  invoice_past_due: (c) => ({
    subject: `Invoice ${c.invoiceNumber} is past due`,
    text: `Invoice ${c.invoiceNumber} for ${c.amount} was not paid on its due date. You have until ${c.graceEndsAt} to pay before the workspace moves to the free plan. No data is deleted.`,
  }),
  payment_received: (c) => ({
    subject: `Payment received for invoice ${c.invoiceNumber}`,
    text: `We received your payment of ${c.amount} for invoice ${c.invoiceNumber}.`,
  }),
  subscription_restored: () => ({
    subject: 'Your subscription is active again',
    text: 'Your payment was received and the subscription is no longer past due.',
  }),
  subscription_free_fallback: (c) => ({
    subject: 'Your workspace moved to the free plan',
    text: `Because the invoice was not paid within the grace period, your workspace moved to the "${c.planName}" plan. No data has been deleted, and upgrading restores full service.`,
  }),
};

const TR: Copy = {
  invoice_issued: (c) => ({
    subject: `${c.invoiceNumber} numaralı fatura oluşturuldu`,
    text: `${c.invoiceNumber} numaralı ${c.amount} tutarındaki fatura oluşturuldu. Son ödeme tarihi: ${c.dueAt}.\nFatura oluşturulması cüzdanınızdan otomatik tahsilat yapmaz; ödeme, vade tarihinde alınır.`,
  }),
  invoice_reminder: (c) => ({
    subject: `Hatırlatma: ${c.invoiceNumber} numaralı faturanın vadesi yaklaşıyor`,
    text: `${c.invoiceNumber} numaralı ${c.amount} tutarındaki faturanın son ödeme tarihi ${c.dueAt}. Hizmet kesintisini önlemek için vadeden önce ödeyin veya cüzdanınıza bakiye yükleyin.`,
  }),
  invoice_due: (c) => ({
    subject: `${c.invoiceNumber} numaralı faturanın vadesi bugün`,
    text: `${c.invoiceNumber} numaralı ${c.amount} tutarındaki faturanın vadesi bugün.`,
  }),
  wallet_autopay_insufficient: (c) => ({
    subject: `${c.invoiceNumber} numaralı fatura için cüzdan bakiyesi yetersiz`,
    text: `${c.invoiceNumber} numaralı ${c.amount} tutarındaki faturanın otomatik ödemesi, cüzdan bakiyesi yetersiz olduğu için yapılamadı. Lütfen bakiye yükleyin veya faturayı doğrudan ödeyin.`,
  }),
  invoice_past_due: (c) => ({
    subject: `${c.invoiceNumber} numaralı fatura gecikmiş durumda`,
    text: `${c.invoiceNumber} numaralı ${c.amount} tutarındaki fatura vadesinde ödenmedi. ${c.graceEndsAt} tarihine kadar ödeyebilirsiniz; sonrasında çalışma alanı ücretsiz plana geçer. Hiçbir veri silinmez.`,
  }),
  payment_received: (c) => ({
    subject: `${c.invoiceNumber} numaralı fatura için ödeme alındı`,
    text: `${c.invoiceNumber} numaralı fatura için ${c.amount} tutarındaki ödemeniz alındı.`,
  }),
  subscription_restored: () => ({
    subject: 'Aboneliğiniz yeniden etkin',
    text: 'Ödemeniz alındı ve aboneliğiniz gecikmiş durumdan çıkarıldı.',
  }),
  subscription_free_fallback: (c) => ({
    subject: 'Çalışma alanınız ücretsiz plana geçti',
    text: `Fatura ek süre içinde ödenmediği için çalışma alanınız "${c.planName}" planına geçti. Hiçbir veri silinmedi; planı yükselttiğinizde hizmet geri gelir.`,
  }),
};

const COPY: Record<BillingLocale, Copy> = { fa: FA, en: EN, tr: TR };

/**
 * Template context for the branding-managed email templates.
 * Same numbers the plain-text fallback uses — the copy lives in
 * `public.email_templates` (Branding → Email templates), keyed by the
 * notification type as slug.
 */
export function buildBillingTemplateData(
  locale: string | null | undefined,
  payload: Record<string, unknown> = {},
): Record<string, string> {
  const loc = normalizeLocale(locale);
  return {
    invoice_number: String(payload.invoice_number ?? '—'),
    amount: formatIrr(payload.amount_irr, loc),
    due_at: formatDate(payload.due_at, loc),
    grace_ends_at: formatDate(payload.grace_period_ends_at, loc),
    plan_name: String(payload.plan_name ?? (loc === 'fa' ? 'رایگان' : 'Free')),
    action_url: String(payload.action_url ?? ''),
  };
}

export function renderBillingNotification(
  type: BillingNotificationType,
  locale: string | null | undefined,
  payload: Record<string, unknown> = {},
): RenderedMessage {
  const loc = normalizeLocale(locale);
  const ctx: Ctx = {
    invoiceNumber: String(payload.invoice_number ?? '—'),
    amount: formatIrr(payload.amount_irr, loc),
    dueAt: formatDate(payload.due_at, loc),
    graceEndsAt: formatDate(payload.grace_period_ends_at, loc),
    planName: String(payload.plan_name ?? (loc === 'fa' ? 'رایگان' : 'Free')),
  };
  return COPY[loc][type](ctx);
}
