/**
 * Locale-aware wrapper around sonner's `toast`.
 *
 * Many call sites pass hardcoded English strings. This wrapper translates
 * known phrases (exact match, prefix match for "X: " style messages, and
 * simple template patterns) into the active UI locale before displaying.
 * Import `toast` from here instead of from 'sonner'.
 */
import { toast as sonnerToast } from 'sonner';
import { getStoredLocale } from '@/i18n';
import type { Locale } from '@/i18n/config';

type Dict = Record<string, { fa: string; tr: string }>;

const EXACT: Dict = {
  'Workspace created successfully': { fa: 'فضای کاری با موفقیت ساخته شد', tr: 'Çalışma alanı başarıyla oluşturuldu' },
  'Workspace deleted successfully': { fa: 'فضای کاری با موفقیت حذف شد', tr: 'Çalışma alanı başarıyla silindi' },
  'Workspace privacy export storage saved': { fa: 'فضای ذخیره‌سازی خروجی حریم خصوصی ذخیره شد', tr: 'Gizlilik dışa aktarma depolaması kaydedildi' },
  'Workspace override removed — using platform default': { fa: 'بازنویسی فضای کاری حذف شد — استفاده از پیش‌فرض پلتفرم', tr: 'Çalışma alanı geçersiz kılması kaldırıldı — platform varsayılanı kullanılıyor' },
  'Email provider settings saved': { fa: 'تنظیمات ارائه‌دهنده ایمیل ذخیره شد', tr: 'E-posta sağlayıcı ayarları kaydedildi' },
  'AI provider settings saved': { fa: 'تنظیمات ارائه‌دهنده هوش مصنوعی ذخیره شد', tr: 'Yapay zekâ sağlayıcı ayarları kaydedildi' },
  'Webhook settings saved': { fa: 'تنظیمات وب‌هوک ذخیره شد', tr: 'Webhook ayarları kaydedildi' },
  'Email config removed': { fa: 'پیکربندی ایمیل حذف شد', tr: 'E-posta yapılandırması kaldırıldı' },
  'AI config removed': { fa: 'پیکربندی هوش مصنوعی حذف شد', tr: 'Yapay zekâ yapılandırması kaldırıldı' },
  'Webhook config removed': { fa: 'پیکربندی وب‌هوک حذف شد', tr: 'Webhook yapılandırması kaldırıldı' },
  'Advanced routing policy updated': { fa: 'سیاست مسیریابی پیشرفته به‌روزرسانی شد', tr: 'Gelişmiş yönlendirme politikası güncellendi' },
  'Flag updated': { fa: 'پرچم ویژگی به‌روزرسانی شد', tr: 'Özellik bayrağı güncellendi' },
  'Failed to update flag': { fa: 'به‌روزرسانی پرچم ویژگی ناموفق بود', tr: 'Özellik bayrağı güncellenemedi' },
  'Copied to clipboard': { fa: 'در حافظه موقت کپی شد', tr: 'Panoya kopyalandı' },
  'Department deleted': { fa: 'دپارتمان حذف شد', tr: 'Departman silindi' },
  'Department assignments updated': { fa: 'تخصیص دپارتمان‌ها به‌روزرسانی شد', tr: 'Departman atamaları güncellendi' },
  'Members updated': { fa: 'اعضا به‌روزرسانی شدند', tr: 'Üyeler güncellendi' },
  'Resolve the checklist below before enabling.': { fa: 'پیش از فعال‌سازی، موارد چک‌لیست زیر را برطرف کنید.', tr: 'Etkinleştirmeden önce aşağıdaki kontrol listesini tamamlayın.' },
  'Plan granted successfully': { fa: 'پلن با موفقیت اعطا شد', tr: 'Plan başarıyla verildi' },
  'Plan updated': { fa: 'پلن به‌روزرسانی شد', tr: 'Plan güncellendi' },
  'Plan created': { fa: 'پلن ساخته شد', tr: 'Plan oluşturuldu' },
  'Plan assigned': { fa: 'پلن اختصاص داده شد', tr: 'Plan atandı' },
  'Plan deactivated': { fa: 'پلن غیرفعال شد', tr: 'Plan devre dışı bırakıldı' },
  'Revoked': { fa: 'لغو شد', tr: 'İptal edildi' },
  'Name and slug are required': { fa: 'نام و شناسه (slug) الزامی است', tr: 'Ad ve slug zorunludur' },
  'Override id not found — please reload': { fa: 'شناسه بازنویسی پیدا نشد — لطفاً صفحه را بازنشانی کنید', tr: 'Geçersiz kılma kimliği bulunamadı — lütfen sayfayı yenileyin' },
  'Enter a value (use -1 for unlimited)': { fa: 'یک مقدار وارد کنید (برای نامحدود از ۱- استفاده کنید)', tr: 'Bir değer girin (sınırsız için -1)' },
  'Value must be -1 (unlimited) or a non-negative integer': { fa: 'مقدار باید ۱- (نامحدود) یا عددی صحیح و نامنفی باشد', tr: 'Değer -1 (sınırsız) veya negatif olmayan bir tam sayı olmalıdır' },
  'Limit override applied': { fa: 'بازنویسی محدودیت اعمال شد', tr: 'Limit geçersiz kılması uygulandı' },
  'Limit override removed — inheriting from plan': { fa: 'بازنویسی محدودیت حذف شد — ارث‌بری از پلن', tr: 'Limit geçersiz kılması kaldırıldı — plandan devralınıyor' },
  'You are now the global admin!': { fa: 'شما اکنون مدیر کل پلتفرم هستید!', tr: 'Artık genel yöneticisiniz!' },
  'A global admin already exists. Contact the platform admin.': { fa: 'یک مدیر کل از قبل وجود دارد. با مدیر پلتفرم تماس بگیرید.', tr: 'Zaten bir genel yönetici var. Platform yöneticisiyle iletişime geçin.' },
  'Bootstrap failed.': { fa: 'راه‌اندازی اولیه ناموفق بود.', tr: 'Başlatma başarısız oldu.' },
  'Template updated': { fa: 'قالب به‌روزرسانی شد', tr: 'Şablon güncellendi' },
  'Template created': { fa: 'قالب ساخته شد', tr: 'Şablon oluşturuldu' },
  'Template deleted': { fa: 'قالب حذف شد', tr: 'Şablon silindi' },
  'Template exists for all locales': { fa: 'قالب برای همه زبان‌ها موجود است', tr: 'Şablon tüm diller için mevcut' },
  'Failed to load templates': { fa: 'بارگذاری قالب‌ها ناموفق بود', tr: 'Şablonlar yüklenemedi' },
  'Failed to update template': { fa: 'به‌روزرسانی قالب ناموفق بود', tr: 'Şablon güncellenemedi' },
  'Failed to create template': { fa: 'ساخت قالب ناموفق بود', tr: 'Şablon oluşturulamadı' },
  'Failed to duplicate': { fa: 'تکثیر ناموفق بود', tr: 'Çoğaltma başarısız' },
  'Failed to delete': { fa: 'حذف ناموفق بود', tr: 'Silme başarısız' },
  'Subject and HTML body are required': { fa: 'موضوع و متن HTML الزامی است', tr: 'Konu ve HTML gövdesi zorunludur' },
  'Failed': { fa: 'ناموفق', tr: 'Başarısız' },
};

// Messages that start with a known English prefix, e.g. "Save failed: <detail>"
const PREFIX: Dict = {
  'Failed to save: ': { fa: 'ذخیره ناموفق بود: ', tr: 'Kaydedilemedi: ' },
  'Save failed: ': { fa: 'ذخیره ناموفق بود: ', tr: 'Kaydetme başarısız: ' },
  'Remove failed: ': { fa: 'حذف ناموفق بود: ', tr: 'Kaldırma başarısız: ' },
  'Copied ': { fa: 'کپی شد: ', tr: 'Kopyalandı: ' },
  'Duplicated to ': { fa: 'تکثیر شد به: ', tr: 'Şuraya çoğaltıldı: ' },
};

// Patterns with interpolated values.
const PATTERNS: { re: RegExp; fa: (m: RegExpMatchArray) => string; tr: (m: RegExpMatchArray) => string }[] = [
  {
    re: /^(.+): Connected \((\d+)ms\)$/,
    fa: (m) => `${m[1]}: متصل شد (${m[2]} میلی‌ثانیه)`,
    tr: (m) => `${m[1]}: Bağlandı (${m[2]}ms)`,
  },
  {
    re: /^(\d+) validation error\(s\)$/,
    fa: (m) => `${m[1]} خطای اعتبارسنجی`,
    tr: (m) => `${m[1]} doğrulama hatası`,
  },
  {
    re: /^(\d+) warning\(s\) — saving anyway$/,
    fa: (m) => `${m[1]} هشدار — با این حال ذخیره می‌شود`,
    tr: (m) => `${m[1]} uyarı — yine de kaydediliyor`,
  },
  {
    re: /^(.+) override applied$/,
    fa: (m) => `بازنویسی ${m[1]} اعمال شد`,
    tr: (m) => `${m[1]} geçersiz kılması uygulandı`,
  },
  {
    re: /^(.+) override removed — inheriting from plan$/,
    fa: (m) => `بازنویسی ${m[1]} حذف شد — ارث‌بری از پلن`,
    tr: (m) => `${m[1]} geçersiz kılması kaldırıldı — plandan devralınıyor`,
  },
];

function translate(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let locale: Locale;
  try {
    locale = getStoredLocale();
  } catch {
    return value;
  }
  if (locale === 'en') return value;

  const exact = EXACT[value.trim()];
  if (exact) return exact[locale];

  for (const [prefix, entry] of Object.entries(PREFIX)) {
    if (value.startsWith(prefix)) return entry[locale] + value.slice(prefix.length);
  }

  for (const p of PATTERNS) {
    const m = value.match(p.re);
    if (m) return locale === 'fa' ? p.fa(m) : p.tr(m);
  }

  return value;
}

function localizeOptions<T>(opts: T): T {
  if (!opts || typeof opts !== 'object') return opts;
  const o = opts as Record<string, unknown>;
  if (typeof o.description === 'string') {
    return { ...o, description: translate(o.description) } as T;
  }
  return opts;
}

type ToastFn = typeof sonnerToast;

function wrap<F extends (...args: any[]) => any>(fn: F): F {
  return ((message: unknown, opts?: unknown) =>
    fn(translate(message) as never, localizeOptions(opts) as never)) as F;
}

const base = wrap(sonnerToast as unknown as (...a: any[]) => any);

export const toast = Object.assign(base, sonnerToast, {
  success: wrap(sonnerToast.success),
  error: wrap(sonnerToast.error),
  info: wrap(sonnerToast.info),
  warning: wrap(sonnerToast.warning),
  message: wrap(sonnerToast.message),
  loading: wrap(sonnerToast.loading),
}) as ToastFn;

export default toast;
