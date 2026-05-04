/**
 * AI Agent — C2 localized templates for runtime actions.
 * Languages: fa, tr, en (fallback en).
 */
export type TemplateKey =
  | 'greeting'
  | 'handoff'
  | 'no_answer_handoff'
  | 'pricing_safe_guidance'
  | 'trigger_fallback';

const T: Record<TemplateKey, Record<string, string>> = {
  greeting: {
    fa: 'سلام! چطور می‌توانم کمکتان کنم؟',
    tr: 'Merhaba! Size nasıl yardımcı olabilirim?',
    en: 'Hi! How can I help?',
  },
  handoff: {
    fa: 'باشه — همین الان شما را به یک کارشناس انسانی وصل می‌کنم.',
    tr: 'Tamam — sizi bir temsilciye bağlıyorum.',
    en: "Sure — I'll connect you with a human agent.",
  },
  no_answer_handoff: {
    fa: 'برای پاسخ دقیق‌تر، شما را به یک کارشناس وصل می‌کنم.',
    tr: 'Daha doğru bir yanıt için sizi bir temsilciye bağlıyorum.',
    en: "Let me connect you with a teammate for a more accurate answer.",
  },
  pricing_safe_guidance: {
    fa: 'برای اطلاع از قیمت‌ها لطفاً به صفحه قیمت‌گذاری مراجعه کنید یا با کارشناس ما در تماس باشید.',
    tr: 'Fiyatlar için lütfen fiyatlandırma sayfamıza bakın veya bir temsilciyle iletişime geçin.',
    en: 'For pricing details please check our pricing page or talk to a teammate.',
  },
  trigger_fallback: {
    fa: 'سلام، چطور می‌توانم کمک کنم؟',
    tr: 'Merhaba, nasıl yardımcı olabilirim?',
    en: 'Hi — how can I help?',
  },
};

export function pickTemplate(key: TemplateKey, locale: string | undefined): string {
  const l = (locale || 'en').toLowerCase();
  const map = T[key];
  if (l.startsWith('fa')) return map.fa;
  if (l.startsWith('tr')) return map.tr;
  return map.en;
}

/**
 * Pick a localized message from a translations map, with visitor language
 * preference and fallback to en, then any first available value.
 */
export function pickLocalizedMessage(
  source: { message?: string; template?: string; translations?: Record<string, string> } | null | undefined,
  locale: string | undefined,
): string | null {
  if (!source) return null;
  const t = source.translations || {};
  const l = (locale || 'en').toLowerCase();
  const candidates = [l, l.split('-')[0], 'en'];
  for (const c of candidates) {
    if (t[c]) return t[c];
  }
  if (typeof source.message === 'string' && source.message.trim()) return source.message;
  if (typeof source.template === 'string' && source.template.trim()) return source.template;
  const first = Object.values(t).find((v) => typeof v === 'string' && v.trim());
  return first || null;
}