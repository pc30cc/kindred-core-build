/**
 * Billing i18n helpers — shared strings, capability labels, and value
 * formatters used by the customer-facing Billing page and the
 * Plan/Usage panel. Keeps fa / en / tr consistent in a single place.
 */

import type { CapabilityDefinition } from '@/lib/entitlements-api';

export type BillingLocale = 'fa' | 'en' | 'tr' | string;

type Dict = Record<string, { fa: string; en: string; tr: string }>;

const STRINGS: Dict = {
  title: { fa: 'صورتحساب', en: 'Billing', tr: 'Faturalandırma' },
  subtitle: {
    fa: 'مدیریت اشتراک، مصرف و پرداخت‌های فضای کاری شما',
    en: 'Manage your workspace subscription, usage and payments',
    tr: 'Çalışma alanı aboneliğinizi, kullanımınızı ve ödemelerinizi yönetin',
  },
  customerPortal: { fa: 'پنل پرداخت', en: 'Customer Portal', tr: 'Ödeme Paneli' },
  currentPlan: { fa: 'پلن فعلی', en: 'Current Plan', tr: 'Mevcut Plan' },
  provider: { fa: 'ارائه‌دهنده', en: 'Provider', tr: 'Sağlayıcı' },
  renews: { fa: 'تاریخ تمدید', en: 'Renews on', tr: 'Yenileme tarihi' },
  resume: { fa: 'ادامه اشتراک', en: 'Resume', tr: 'Devam ettir' },
  cancel: { fa: 'لغو اشتراک', en: 'Cancel', tr: 'İptal et' },
  tabUsage: { fa: 'پلن و مصرف', en: 'Plan & Usage', tr: 'Plan ve Kullanım' },
  tabPlans: { fa: 'پلن‌ها', en: 'Plans', tr: 'Planlar' },
  tabPayments: { fa: 'پرداخت‌ها', en: 'Payments', tr: 'Ödemeler' },
  monthly: { fa: 'ماهانه', en: 'Monthly', tr: 'Aylık' },
  yearly: { fa: 'سالانه', en: 'Yearly', tr: 'Yıllık' },
  yearlyBadge: { fa: '۲ ماه رایگان', en: '2 months free', tr: '2 ay ücretsiz' },
  current: { fa: 'فعلی', en: 'Current', tr: 'Mevcut' },
  free: { fa: 'رایگان', en: 'Free', tr: 'Ücretsiz' },
  perMo: { fa: '/ماه', en: '/mo', tr: '/ay' },
  perYr: { fa: '/سال', en: '/yr', tr: '/yıl' },
  upgrade: { fa: 'ارتقای پلن', en: 'Upgrade', tr: 'Yükselt' },
  noPayments: { fa: 'هنوز پرداختی ثبت نشده است', en: 'No payments yet', tr: 'Henüz ödeme yok' },
  date: { fa: 'تاریخ', en: 'Date', tr: 'Tarih' },
  amount: { fa: 'مبلغ', en: 'Amount', tr: 'Tutar' },
  status: { fa: 'وضعیت', en: 'Status', tr: 'Durum' },
  // Plan / Usage panel
  yourPlan: { fa: 'پلن شما', en: 'Your plan', tr: 'Planınız' },
  usageOverview: { fa: 'نمای کلی مصرف', en: 'Usage overview', tr: 'Kullanım özeti' },
  usageOverviewDesc: {
    fa: 'مصرف فعلی شما در دوره جاری',
    en: 'Your current usage in this billing cycle',
    tr: 'Mevcut faturalama döneminizdeki kullanımınız',
  },
  unlimited: { fa: 'نامحدود', en: 'Unlimited', tr: 'Sınırsız' },
  notTracked: { fa: 'مصرف این مورد در این نما رهگیری نمی‌شود', en: 'Usage not tracked here', tr: 'Bu görünümde takip edilmiyor' },
  modules: { fa: 'ماژول‌های فعال', en: 'Included modules', tr: 'Etkin modüller' },
  channels: { fa: 'کانال‌های ارتباطی', en: 'Channels', tr: 'Kanallar' },
  features: { fa: 'امکانات', en: 'Features', tr: 'Özellikler' },
  notIncluded: { fa: 'در پلن شما نیست', en: 'Not in your plan', tr: 'Planınızda yok' },
  limitsAndUsage: { fa: 'سقف و مصرف', en: 'Limits & usage', tr: 'Limitler ve kullanım' },
  ofLabel: { fa: 'از', en: 'of', tr: '/' },
  sourceOverride: { fa: 'سفارشی', en: 'Custom', tr: 'Özel' },
  sourcePlan: { fa: 'از پلن', en: 'From plan', tr: 'Plandan' },
  sourceDefault: { fa: 'پیش‌فرض', en: 'Default', tr: 'Varsayılan' },
  planUnavailable: { fa: 'اطلاعات پلن در دسترس نیست', en: 'Plan state unavailable', tr: 'Plan durumu mevcut değil' },
};

export function bt(locale: BillingLocale, key: keyof typeof STRINGS): string {
  const row = STRINGS[key as string];
  if (!row) return key as string;
  return (row as any)[locale] || row.en;
}

// ── Capability labels ────────────────────────────────────────
const CAP_FA: Record<string, string> = {
  chat: 'گفتگوی زنده', knowledge_base: 'پایگاه دانش', ai_assistant: 'دستیار هوشمند',
  visitor_tracking: 'ردیابی بازدیدکنندگان', email_campaigns: 'کمپین ایمیلی', automation: 'اتوماسیون',
  analytics: 'تحلیل و گزارش', omnichannel: 'چندکاناله', custom_branding: 'برندینگ سفارشی',
  api_access: 'دسترسی API', voice_video: 'صوت و تصویر', help_center: 'مرکز راهنما',
  call_center: 'مرکز تماس', contacts: 'مخاطبین',
  chat_widget: 'ویجت چت', email: 'ایمیل', whatsapp: 'واتس‌اپ', sms: 'پیامک',
  instagram: 'اینستاگرام', telegram: 'تلگرام', voice: 'تماس صوتی', video: 'تماس تصویری',
  advanced_ai_agent: 'دستیار هوش مصنوعی پیشرفته', ai_operator_assist: 'کمک‌کار هوشمند اپراتور',
  ai_kb_builder: 'سازنده پایگاه دانش با هوش مصنوعی', priority_support: 'پشتیبانی اولویت‌دار',
  sso: 'ورود یکپارچه (SSO/SAML)', audit_logs: 'گزارش‌های ممیزی',
  white_label: 'برندینگ کاملاً سفارشی', remove_powered_by: 'حذف نشان «Powered by»',
  call_recording: 'ضبط تماس', call_queue: 'صف تماس', call_callbacks: 'درخواست تماس مجدد',
  contact_import: 'ورود مخاطبین', contact_export: 'خروجی مخاطبین', contact_tags: 'برچسب مخاطبین',
  contact_notes: 'یادداشت مخاطبین', bulk_contact_actions: 'عملیات گروهی مخاطبین',
  max_agents: 'حداکثر اپراتور', max_workspaces: 'حداکثر فضای کاری',
  max_conversations: 'گفتگو در ماه', max_visitors: 'بازدیدکننده در ماه',
  ai_credits_per_month: 'اعتبار هوش مصنوعی در ماه',
  ai_kb_max_pages: 'حداکثر صفحات هر کار KB', ai_kb_max_depth: 'عمق پیمایش KB',
  ai_kb_jobs_per_month: 'کارهای KB در ماه', ai_kb_file_size_mb: 'حداکثر حجم فایل KB',
  ai_kb_file_count: 'حداکثر تعداد فایل KB', storage_gb: 'فضای ذخیره‌سازی',
  data_retention_days: 'نگهداری داده', max_contacts: 'حداکثر مخاطبین',
  max_concurrent_calls: 'حداکثر تماس هم‌زمان', max_call_minutes_per_month: 'دقیقه تماس در ماه',
  recording_retention_days: 'نگهداری فایل ضبط تماس', max_call_recordings: 'حداکثر فایل ضبط تماس',
  max_call_recording_storage_mb: 'فضای ذخیره ضبط تماس',
};

const CAP_TR: Record<string, string> = {
  chat: 'Canlı Sohbet', knowledge_base: 'Bilgi Tabanı', ai_assistant: 'AI Asistanı',
  visitor_tracking: 'Ziyaretçi Takibi', email_campaigns: 'E-posta Kampanyaları', automation: 'Otomasyon',
  analytics: 'Analitik', omnichannel: 'Çoklu Kanal', custom_branding: 'Özel Marka',
  api_access: 'API Erişimi', voice_video: 'Ses ve Video', help_center: 'Yardım Merkezi',
  call_center: 'Çağrı Merkezi', contacts: 'Kişiler',
  chat_widget: 'Sohbet Widget', email: 'E-posta', whatsapp: 'WhatsApp', sms: 'SMS',
  instagram: 'Instagram', telegram: 'Telegram', voice: 'Sesli Arama', video: 'Görüntülü Arama',
  advanced_ai_agent: 'Gelişmiş AI Asistanı', ai_operator_assist: 'AI Operatör Yardımı',
  ai_kb_builder: 'AI Bilgi Tabanı Oluşturucu', priority_support: 'Öncelikli Destek',
  sso: 'SSO / SAML', audit_logs: 'Denetim Kayıtları',
  white_label: 'White-label Marka', remove_powered_by: '"Powered by" Kaldırma',
  call_recording: 'Çağrı Kaydı', call_queue: 'Çağrı Kuyruğu', call_callbacks: 'Geri Arama',
  contact_import: 'Kişi İçe Aktar', contact_export: 'Kişi Dışa Aktar', contact_tags: 'Kişi Etiketleri',
  contact_notes: 'Kişi Notları', bulk_contact_actions: 'Toplu Kişi İşlemleri',
  max_agents: 'Maks. Operatör', max_workspaces: 'Maks. Çalışma Alanı',
  max_conversations: 'Aylık Konuşma', max_visitors: 'Aylık Ziyaretçi',
  ai_credits_per_month: 'Aylık AI Kredisi',
  ai_kb_max_pages: 'KB İşi Başına Maks. Sayfa', ai_kb_max_depth: 'KB Tarama Derinliği',
  ai_kb_jobs_per_month: 'Aylık KB İşi', ai_kb_file_size_mb: 'Maks. KB Dosya Boyutu',
  ai_kb_file_count: 'Maks. KB Dosya', storage_gb: 'Depolama',
  data_retention_days: 'Veri Saklama', max_contacts: 'Maks. Kişi',
  max_concurrent_calls: 'Eşzamanlı Maks. Çağrı', max_call_minutes_per_month: 'Aylık Çağrı Dakikası',
  recording_retention_days: 'Çağrı Kaydı Saklama', max_call_recordings: 'Maks. Çağrı Kaydı',
  max_call_recording_storage_mb: 'Çağrı Kaydı Depolama',
};

export function capLabel(cap: { key: string; label: string }, locale: BillingLocale): string {
  if (locale === 'fa' && CAP_FA[cap.key]) return CAP_FA[cap.key];
  if (locale === 'tr' && CAP_TR[cap.key]) return CAP_TR[cap.key];
  return cap.label;
}

export function formatLimitValue(value: number, cap: CapabilityDefinition | { unit?: string }, locale: BillingLocale): string {
  if (value === -1) return bt(locale, 'unlimited');
  const fmt = locale === 'fa' ? value.toLocaleString('fa-IR') : value.toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US');
  const unit = (cap as any).unit;
  const perMo = locale === 'fa' ? '/ماه' : locale === 'tr' ? '/ay' : '/mo';
  const perDay = locale === 'fa' ? '/روز' : locale === 'tr' ? '/gün' : '/day';
  const days = locale === 'fa' ? 'روز' : locale === 'tr' ? 'gün' : 'days';
  const mins = locale === 'fa' ? 'دقیقه' : locale === 'tr' ? 'dk' : 'min';
  switch (unit) {
    case 'per_month': return `${fmt}${perMo}`;
    case 'per_day': return `${fmt}${perDay}`;
    case 'gb': return `${fmt} GB`;
    case 'mb': return `${fmt} MB`;
    case 'days': return `${fmt} ${days}`;
    case 'minutes': return `${fmt} ${mins}`;
    default: return fmt;
  }
}

export function formatUsageValue(v: number, unit: string | undefined, locale: BillingLocale): string {
  const loc = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
  if (unit === 'gb') return `${v.toFixed(2)} GB`;
  if (unit === 'mb') return `${v.toFixed(1)} MB`;
  return Math.round(v).toLocaleString(loc);
}