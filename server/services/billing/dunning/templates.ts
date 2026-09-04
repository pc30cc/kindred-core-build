// ============================================================
// BILLING V2 — customer notification templates (fa / en / tr).
//
// Transactional only: these messages exist because the customer owes money or
// their service state changed. They are never marketing, they carry no secret,
// no token and no gateway reference, and the SMS variants deliberately contain
// no amount-plus-identity combination that would leak on a shared screen.
//
// Rendering is pure: the worker passes already-computed, server-authoritative
// values. Nothing here re-derives a financial number.
// ============================================================

export type NotificationType =
  | 'invoice_issued'
  | 'invoice_reminder'
  | 'invoice_due'
  | 'wallet_autopay_insufficient'
  | 'invoice_past_due'
  | 'payment_succeeded'
  | 'subscription_restored'
  | 'free_fallback';

export type Channel = 'email' | 'sms';
export type Locale = 'fa' | 'en' | 'tr';

export interface TemplateVars {
  workspaceName: string;
  invoiceNumber: string;
  amountLabel: string;
  dueLabel: string;
  graceLabel: string;
  planName: string;
  billingUrl: string;
}

export interface RenderedMessage {
  subject?: string;
  text: string;
  html?: string;
}

export function normalizeLocale(input?: string | null): Locale {
  const l = String(input || '').toLowerCase();
  if (l.startsWith('en')) return 'en';
  if (l.startsWith('tr')) return 'tr';
  return 'fa';
}

type Copy = Record<Locale, { subject: string; body: string; sms: string }>;

const COPY: Record<NotificationType, Copy> = {
  invoice_issued: {
    fa: {
      subject: 'صورتحساب جدید برای {workspaceName}',
      body: 'صورتحساب {invoiceNumber} به مبلغ {amountLabel} صادر شد. مهلت پرداخت: {dueLabel}.',
      sms: 'صورتحساب {invoiceNumber} صادر شد. مهلت پرداخت {dueLabel}.',
    },
    en: {
      subject: 'New invoice for {workspaceName}',
      body: 'Invoice {invoiceNumber} for {amountLabel} has been issued. Due on {dueLabel}.',
      sms: 'Invoice {invoiceNumber} issued. Due {dueLabel}.',
    },
    tr: {
      subject: '{workspaceName} için yeni fatura',
      body: '{invoiceNumber} numaralı {amountLabel} tutarındaki fatura oluşturuldu. Son ödeme: {dueLabel}.',
      sms: '{invoiceNumber} faturası oluşturuldu. Son ödeme {dueLabel}.',
    },
  },
  invoice_reminder: {
    fa: {
      subject: 'یادآوری پرداخت صورتحساب {invoiceNumber}',
      body: 'مهلت پرداخت صورتحساب {invoiceNumber} به مبلغ {amountLabel} در {dueLabel} است.',
      sms: 'یادآوری: مهلت پرداخت صورتحساب {invoiceNumber} تا {dueLabel}.',
    },
    en: {
      subject: 'Payment reminder for invoice {invoiceNumber}',
      body: 'Invoice {invoiceNumber} for {amountLabel} is due on {dueLabel}.',
      sms: 'Reminder: invoice {invoiceNumber} is due {dueLabel}.',
    },
    tr: {
      subject: '{invoiceNumber} faturası için ödeme hatırlatması',
      body: '{invoiceNumber} numaralı {amountLabel} tutarındaki faturanın son ödeme tarihi {dueLabel}.',
      sms: 'Hatırlatma: {invoiceNumber} faturasının son ödemesi {dueLabel}.',
    },
  },
  invoice_due: {
    fa: {
      subject: 'امروز سررسید صورتحساب {invoiceNumber} است',
      body: 'صورتحساب {invoiceNumber} به مبلغ {amountLabel} امروز سررسید شده است.',
      sms: 'صورتحساب {invoiceNumber} امروز سررسید شد.',
    },
    en: {
      subject: 'Invoice {invoiceNumber} is due today',
      body: 'Invoice {invoiceNumber} for {amountLabel} is due today.',
      sms: 'Invoice {invoiceNumber} is due today.',
    },
    tr: {
      subject: '{invoiceNumber} faturasının son ödeme günü bugün',
      body: '{invoiceNumber} numaralı {amountLabel} tutarındaki faturanın son ödeme günü bugün.',
      sms: '{invoiceNumber} faturasının son ödeme günü bugün.',
    },
  },
  wallet_autopay_insufficient: {
    fa: {
      subject: 'موجودی کیف پول برای پرداخت خودکار کافی نبود',
      body: 'موجودی کیف پول برای پرداخت کامل صورتحساب {invoiceNumber} به مبلغ {amountLabel} کافی نبود. هیچ مبلغی برداشت نشد.',
      sms: 'موجودی کیف پول برای صورتحساب {invoiceNumber} کافی نبود.',
    },
    en: {
      subject: 'Wallet balance was not enough for auto-pay',
      body: 'Your wallet could not cover invoice {invoiceNumber} ({amountLabel}) in full. Nothing was charged.',
      sms: 'Wallet balance was not enough for invoice {invoiceNumber}.',
    },
    tr: {
      subject: 'Cüzdan bakiyesi otomatik ödeme için yeterli değildi',
      body: 'Cüzdanınız {invoiceNumber} ({amountLabel}) faturasının tamamını karşılayamadı. Hiçbir tutar tahsil edilmedi.',
      sms: '{invoiceNumber} faturası için cüzdan bakiyesi yetersizdi.',
    },
  },
  invoice_past_due: {
    fa: {
      subject: 'صورتحساب {invoiceNumber} پرداخت نشده است',
      body: 'صورتحساب {invoiceNumber} پرداخت نشده است. سرویس شما تا {graceLabel} فعال می‌ماند و پس از آن به پلن رایگان منتقل می‌شود.',
      sms: 'صورتحساب {invoiceNumber} پرداخت نشده. مهلت تا {graceLabel}.',
    },
    en: {
      subject: 'Invoice {invoiceNumber} is past due',
      body: 'Invoice {invoiceNumber} has not been paid. Your service stays active until {graceLabel}, after which the workspace moves to the free plan.',
      sms: 'Invoice {invoiceNumber} is past due. Grace ends {graceLabel}.',
    },
    tr: {
      subject: '{invoiceNumber} faturasının ödemesi gecikti',
      body: '{invoiceNumber} faturası ödenmedi. Hizmetiniz {graceLabel} tarihine kadar açık kalır, sonrasında ücretsiz plana geçilir.',
      sms: '{invoiceNumber} faturası gecikti. Ek süre {graceLabel}.',
    },
  },
  payment_succeeded: {
    fa: {
      subject: 'پرداخت صورتحساب {invoiceNumber} انجام شد',
      body: 'پرداخت صورتحساب {invoiceNumber} به مبلغ {amountLabel} با موفقیت ثبت شد.',
      sms: 'پرداخت صورتحساب {invoiceNumber} ثبت شد.',
    },
    en: {
      subject: 'Invoice {invoiceNumber} has been paid',
      body: 'Payment of {amountLabel} for invoice {invoiceNumber} was recorded successfully.',
      sms: 'Payment for invoice {invoiceNumber} recorded.',
    },
    tr: {
      subject: '{invoiceNumber} faturası ödendi',
      body: '{invoiceNumber} faturası için {amountLabel} tutarındaki ödeme kaydedildi.',
      sms: '{invoiceNumber} faturasının ödemesi kaydedildi.',
    },
  },
  subscription_restored: {
    fa: {
      subject: 'اشتراک {workspaceName} دوباره فعال شد',
      body: 'پرداخت شما دریافت شد و اشتراک پلن {planName} دوباره فعال است.',
      sms: 'اشتراک شما دوباره فعال شد.',
    },
    en: {
      subject: 'Subscription for {workspaceName} is active again',
      body: 'Your payment was received and the {planName} subscription is active again.',
      sms: 'Your subscription is active again.',
    },
    tr: {
      subject: '{workspaceName} aboneliği yeniden etkin',
      body: 'Ödemeniz alındı ve {planName} aboneliği yeniden etkin.',
      sms: 'Aboneliğiniz yeniden etkin.',
    },
  },
  free_fallback: {
    fa: {
      subject: 'ورک‌اسپیس {workspaceName} به پلن رایگان منتقل شد',
      body: 'به دلیل پرداخت نشدن صورتحساب، ورک‌اسپیس به پلن رایگان منتقل شد. اطلاعات شما حذف نشده است و با پرداخت می‌توانید پلن را دوباره فعال کنید.',
      sms: 'ورک‌اسپیس به پلن رایگان منتقل شد. اطلاعات حذف نشده است.',
    },
    en: {
      subject: '{workspaceName} moved to the free plan',
      body: 'Because the invoice was not paid, this workspace moved to the free plan. Your data was not deleted and you can re-activate a paid plan at any time.',
      sms: 'Workspace moved to the free plan. No data was deleted.',
    },
    tr: {
      subject: '{workspaceName} ücretsiz plana geçti',
      body: 'Fatura ödenmediği için çalışma alanı ücretsiz plana geçti. Verileriniz silinmedi, dilediğiniz zaman ücretli planı yeniden etkinleştirebilirsiniz.',
      sms: 'Çalışma alanı ücretsiz plana geçti. Veri silinmedi.',
    },
  },
};

function fill(template: string, vars: TemplateVars): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) =>
    String((vars as unknown as Record<string, unknown>)[key] ?? ''),
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderNotification(
  type: NotificationType,
  channel: Channel,
  locale: Locale,
  vars: TemplateVars,
): RenderedMessage {
  const copy = COPY[type][locale];

  if (channel === 'sms') {
    return { text: fill(copy.sms, vars) };
  }

  const subject = fill(copy.subject, vars);
  const body = fill(copy.body, vars);
  const dir = locale === 'fa' ? 'rtl' : 'ltr';
  // Link target is the caller-provided allowed origin only — never a value
  // taken from the database row.
  const link = vars.billingUrl
    ? `<p><a href="${escapeHtml(vars.billingUrl)}">${escapeHtml(vars.billingUrl)}</a></p>`
    : '';

  return {
    subject,
    text: vars.billingUrl ? `${body}\n\n${vars.billingUrl}` : body,
    html:
      `<div dir="${dir}" style="font-family:system-ui,-apple-system,sans-serif;line-height:1.8">` +
      `<h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(subject)}</h2>` +
      `<p style="margin:0 0 12px">${escapeHtml(body)}</p>${link}</div>`,
  };
}
