/**
 * AI Agent — multilingual query expansion (Pass 1).
 *
 * Adds compact synonym maps for common SaaS support/commercial topics across
 * en/tr/fa. Used for retrieval ONLY — never returned to the visitor.
 *
 * Pure functions, no IO.
 */

export type TopicKey =
  | 'pricing'
  | 'support'
  | 'features'
  | 'contact'
  | 'billing'
  | 'demo'
  | 'account';

/** Synonym groups. Lowercased. Diacritics preserved for fa/tr. */
const SYNONYMS: Record<TopicKey, { en: string[]; tr: string[]; fa: string[] }> = {
  pricing: {
    en: ['price', 'pricing', 'plan', 'plans', 'subscription', 'cost', 'tier', 'package'],
    tr: ['fiyat', 'fiyatlar', 'ücret', 'ucret', 'paket', 'plan', 'abonelik', 'tarife'],
    fa: ['قیمت', 'تعرفه', 'پلن', 'اشتراک', 'هزینه', 'قیمت‌ها', 'بسته'],
  },
  support: {
    en: ['support', 'help', 'agent', 'operator', 'representative', 'human', 'customer service'],
    tr: ['destek', 'yardım', 'temsilci', 'operatör', 'müşteri hizmetleri', 'insan'],
    fa: ['پشتیبانی', 'کمک', 'اپراتور', 'کارشناس', 'انسان', 'پشتیبان'],
  },
  features: {
    en: ['feature', 'features', 'module', 'channel', 'integration', 'capability'],
    tr: ['özellik', 'özellikler', 'modül', 'kanal', 'entegrasyon', 'yetenek'],
    fa: ['امکانات', 'قابلیت', 'ماژول', 'کانال', 'اتصال', 'یکپارچه‌سازی'],
  },
  contact: {
    en: ['contact', 'reach', 'sales', 'email us', 'phone'],
    tr: ['iletişim', 'satış', 'ulaşmak', 'telefon'],
    fa: ['تماس', 'ارتباط', 'فروش', 'تلفن'],
  },
  billing: {
    en: ['invoice', 'payment', 'billing', 'subscription', 'refund', 'card'],
    tr: ['fatura', 'ödeme', 'abonelik', 'iade', 'kart'],
    fa: ['فاکتور', 'پرداخت', 'صورتحساب', 'اشتراک', 'بازگشت وجه', 'کارت'],
  },
  demo: {
    en: ['demo', 'trial', 'try', 'sandbox'],
    tr: ['demo', 'deneme', 'denemek'],
    fa: ['دمو', 'نسخه آزمایشی', 'تست'],
  },
  account: {
    en: ['account', 'login', 'sign in', 'sign up', 'register', 'password'],
    tr: ['hesap', 'giriş', 'kayıt', 'şifre', 'parola'],
    fa: ['حساب', 'ورود', 'ثبت‌نام', 'رمز عبور', 'گذرواژه'],
  },
};

/** Detect which topic groups the question touches. */
export function detectTopics(text: string): TopicKey[] {
  const q = (text || '').toLowerCase();
  if (!q) return [];
  const hits: TopicKey[] = [];
  for (const [topic, langs] of Object.entries(SYNONYMS) as Array<[TopicKey, typeof SYNONYMS['pricing']]>) {
    const all = [...langs.en, ...langs.tr, ...langs.fa];
    if (all.some((term) => q.includes(term.toLowerCase()))) {
      hits.push(topic);
    }
  }
  return hits;
}

/**
 * Expand a query with multilingual synonyms for any matched topic groups.
 * Returns a single space-separated string suitable for keyword retrieval.
 * Limits output to avoid runaway prompts.
 */
export function expandQuery(text: string): {
  expanded: string;
  topics: TopicKey[];
  addedTerms: string[];
} {
  const topics = detectTopics(text);
  if (topics.length === 0) {
    return { expanded: text, topics: [], addedTerms: [] };
  }
  const added = new Set<string>();
  for (const topic of topics) {
    const group = SYNONYMS[topic];
    [...group.en, ...group.tr, ...group.fa].forEach((t) => added.add(t));
  }
  // Keep added term count bounded — retrieval doesn't benefit from very long
  // expansions, and we don't want to drown short queries.
  const limited = Array.from(added).slice(0, 40);
  const expanded = `${text} ${limited.join(' ')}`.trim();
  return { expanded, topics, addedTerms: limited };
}

/** Exposed for tests / diagnostics. */
export const __SYNONYMS__ = SYNONYMS;