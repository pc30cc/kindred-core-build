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
 * Handoff acknowledgement when the human team is offline. Never promises a
 * callback/follow-up contact the workspace has no way to make — the copy
 * only says "we'll reach out" when the workspace actually collects email
 * or phone in pre-chat; otherwise it points the visitor back to this chat.
 */
const HANDOFF_OFFLINE_WITH_CONTACT: Record<string, string> = {
  fa: 'در حال حاضر همکاران ما آنلاین نیستند. لطفاً پیام و اطلاعات تماس خود را بگذارید تا در اولین فرصت با شما در ارتباط باشیم.',
  tr: 'Şu anda ekibimiz çevrimdışı. Lütfen mesajınızı ve iletişim bilgilerinizi bırakın; en kısa sürede sizinle iletişime geçeceğiz.',
  en: "Our team isn't online right now. Please leave your message and contact details and we'll get back to you as soon as we can.",
};
const HANDOFF_OFFLINE_NO_CONTACT: Record<string, string> = {
  fa: 'در حال حاضر همکاران ما آنلاین نیستند. پیام شما ثبت می‌شود و می‌توانید پاسخ را در همین گفتگو دریافت کنید.',
  tr: 'Şu anda ekibimiz çevrimdışı. Mesajınız kaydedilecek ve yanıtı bu sohbetten alabilirsiniz.',
  en: "Our team isn't online right now. Your message will be saved and you can get the reply right here in this chat.",
};

export function pickHandoffOfflineMessage(
  locale: string | undefined,
  hasContactCapability: boolean,
): string {
  const l = (locale || 'en').toLowerCase();
  const map = hasContactCapability ? HANDOFF_OFFLINE_WITH_CONTACT : HANDOFF_OFFLINE_NO_CONTACT;
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