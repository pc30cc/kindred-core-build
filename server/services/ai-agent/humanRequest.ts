/**
 * AI Agent — canonical explicit human-request resolver (P0 handoff hardening).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Transferring a visitor to a human is a state-changing, high-impact action.
 * Before this module three independent, weak signals could each authorize it
 * on their own:
 *
 *   1. `runtimePolicy.isHumanRequest()` — raw `text.includes(keyword)` over
 *      owner-configured `handoff_keywords`. Generic nouns such as "پشتیبان",
 *      "agent" or "insan" are commonly stored there, so ANY sentence that
 *      merely mentioned support ("پشتیبانی شما چطور کار می‌کنه؟") was handed
 *      to a human.
 *   2. `humanRequestFromTopics` — the deterministic topic classifier picking
 *      the `human-request` topic as top topic, including via loose example
 *      containment.
 *   3. Message triggers / workflows / routing rules bound to `human_request`.
 *
 * The invariant this module enforces:
 *
 *      topic evidence alone  ≠  authority to transfer to a human
 *
 * Topic and configured-keyword evidence are SUPPORTING signals. An actual
 * transfer requires explicit transfer INTENT — a human noun combined with a
 * connect/talk-to verb, an explicit bot rejection, or an owner-configured
 * full phrase that itself expresses that intent.
 *
 * Deterministic, no LLM, no IO.
 */

export type HumanRequestReason =
  | 'explicit_phrase'
  | 'configured_phrase'
  | 'ai_rejection'
  | 'topic_support'
  | 'none';

export interface HumanRequestSignal {
  /** True ⇒ the runtime is authorized to hand this conversation to a human. */
  explicit: boolean;
  /** 0..1 — strength of the evidence. Supporting-only signals stay < 0.5. */
  confidence: number;
  reason: HumanRequestReason;
  matchedPhrase?: string | null;
  /** Non-authoritative evidence, kept for observability. */
  supporting: {
    topicHumanRequest: boolean;
    genericKeywordMention: string | null;
  };
}

export const NO_HUMAN_REQUEST: HumanRequestSignal = {
  explicit: false,
  confidence: 0,
  reason: 'none',
  matchedPhrase: null,
  supporting: { topicHumanRequest: false, genericKeywordMention: null },
};

/**
 * Shared normalization: Persian ی/ك variants, ZWNJ, diacritics, whitespace.
 * Keeps letters intact so word boundaries stay meaningful.
 */
export function normalizeForIntent(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/\u200c/g, ' ')
    .replace(/[\u064B-\u0652]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Human nouns / roles. Matched with word-phrase boundaries (see `nounHit`) so
 * an inflected or compound form ("پشتیبانی‌مان", "اپراتورها") never counts as
 * a bare role mention. Mentioning one is NEVER sufficient on its own.
 */
const HUMAN_NOUN_PHRASES = [
  'اپراتور', 'اپراتورها', 'پشتیبان', 'پشتیبانی', 'کارشناس', 'کارشناس فروش',
  'انسان', 'ادم', 'آدم', 'همکار', 'نماینده', 'ادم واقعی', 'آدم واقعی',
  'انسان واقعی', 'نیروی انسانی',
  // Turkish is agglutinative: the common case-inflected forms are listed so
  // boundary-aware matching still recognises the role.
  'temsilci', 'temsilciye', 'temsilciyle', 'temsilcisi', 'temsilcisiyle',
  'yetkili', 'yetkiliye', 'yetkiliyle', 'insan', 'insana', 'insanla',
  'operator', 'operatore', 'operatöre', 'operatörle', 'operatör', 'canli destek', 'canlı destek',
  'musteri temsilcisi', 'müşteri temsilcisi', 'gercek bir insan', 'gerçek bir insan',
  'human', 'humans', 'agent', 'agents', 'operator', 'operators', 'representative',
  'real person', 'real human', 'actual human', 'someone real', 'someone', 'somebody',
  'live support', 'live agent', 'support person', 'support agent', 'person',
];

/**
 * Boundary-aware human-noun detection. Returns the longest matched phrase so
 * callers can subtract it from the message when testing "bare request" shape.
 */
export function matchHumanNoun(norm: string): string | null {
  let best: string | null = null;
  for (const raw of HUMAN_NOUN_PHRASES) {
    const p = normalizeForIntent(raw);
    if (!p || !phraseHit(norm, p)) continue;
    if (!best || p.length > best.length) best = p;
  }
  return best;
}

/** "A real person" style nouns — strong enough to pair with a plain want-verb. */
const STRONG_HUMAN_NOUN =
  /(ادم واقعی|آدم واقعی|انسان واقعی|یک انسان|نیروی انسانی|gercek bir insan|gerçek bir insan|real person|real human|actual human|live agent|canli destek|canlı destek)/u;

/** Transfer / talk-to intent verbs. Must co-occur with a human noun. */
const TRANSFER_VERB =
  /(وصل|وصلم|منتقل|انتقال|ارتباط|صحبت کنم|صحبت کن|حرف بزنم|حرف بزن|گفتگو کنم|تماس بگیر|بده به|پاس بده|رد کن به|bagla|bağla|baglan|bağlan|aktar|gorusmek istiyorum|görüşmek istiyorum|konusmak istiyorum|konuşmak istiyorum|destek istiyorum|connect me|transfer me|put me through|talk to|speak to|speak with|chat with|get me|i want a|i need a|i want to talk|i want to speak|let me talk|let me speak)/u;

/** Plain want-verbs — only combined with a STRONG human noun. */
const WANT_VERB =
  /(میخوام|می خواهم|میخواهم|بخواهم|لطفا|istiyorum|lutfen|lütfen|i want|i need|please give me|give me)/u;

/** Explicit rejection of the bot / AI. */
const AI_REJECTION =
  /((نمیخوام|نمی خواهم|نمیخواهم|دیگه نمیخوام|دیگر نمیخواهم)[^\n]{0,40}(ربات|بات|هوش مصنوعی|ai|bot)|(ربات|بات|هوش مصنوعی)[^\n]{0,40}(نمیخوام|نمی خواهم|بس است|کافیه)|bot ?la? konusmak istemiyorum|botla konuşmak istemiyorum|yapay zeka istemiyorum|robot istemiyorum|(i (do ?n[o']?t|dont) want)[^\n]{0,25}(bot|ai|robot)|stop the bot|no more bot)/u;

/** Bare "operator please" style messages. */
const BARE_REQUEST_MAX_TOKENS = 4;

/**
 * Polite / request filler allowed to surround a bare human-role request.
 * Anything outside this closed set (a verb, an adjective, a question word,
 * a time expression …) means the message is a sentence ABOUT the role, not a
 * request FOR it — e.g. "اپراتور آنلاین دارید؟", "operator working today?".
 * This is a whitelist of request shape, not a blacklist of question words.
 */
const REQUEST_FILLER = new Set([
  // fa
  'لطفا', 'لطفن', 'خواهشا', 'میخوام', 'میخواهم', 'می', 'خواهم', 'بده', 'بدید',
  'یک', 'یه', 'با', 'به', 'من', 'منو', 'مرا', 'سلام', 'ممنون', 'مرسی',
  // tr
  'lutfen', 'lütfen', 'istiyorum', 'rica', 'ederim', 'bir', 'ben', 'merhaba',
  'tesekkurler', 'teşekkürler',
  // en
  'please', 'plz', 'kindly', 'thanks', 'thank', 'you', 'hi', 'hello',
  'i', 'want', 'need', 'a', 'an', 'the', 'to', 'me', 'my', 'now',
]);

/** Raw-text question punctuation (normalization strips it, so test raw). */
const QUESTION_PUNCT = /[?？؟]/u;

function tokenCount(norm: string): number {
  return norm ? norm.split(' ').filter(Boolean).length : 0;
}

/** Word/phrase-boundary aware containment on already-normalized strings. */
export function phraseHit(textNorm: string, phraseNorm: string): boolean {
  if (!phraseNorm) return false;
  const escaped = phraseNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \p{L}\p{N} boundaries work for Persian/Turkish where \b does not.
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u');
  return re.test(textNorm);
}

/**
 * "Bare human-role request" shape: the ENTIRE message is the human role plus
 * polite/request filler ("اپراتور", "اپراتور لطفا", "agent please",
 * "temsilci lütfen"). Any other token, or question punctuation in the raw
 * text, disqualifies it — a short sentence that merely contains a human noun
 * is informational, never an explicit transfer request.
 */
export function isBareHumanRoleRequest(rawText: string, norm: string, noun: string | null): boolean {
  if (!noun) return false;
  if (QUESTION_PUNCT.test(String(rawText || ''))) return false;
  if (tokenCount(norm) > BARE_REQUEST_MAX_TOKENS) return false;
  const nounTokens = noun.split(' ').filter(Boolean);
  const rest = norm.split(' ').filter(Boolean);
  // Remove one occurrence of the matched noun phrase.
  for (const t of nounTokens) {
    const i = rest.indexOf(t);
    if (i >= 0) rest.splice(i, 1);
  }
  return rest.every((t) => REQUEST_FILLER.has(t));
}

/**
 * An owner-configured handoff keyword is a STRONG signal only when the phrase
 * itself expresses human-request semantics: transfer/talk intent combined
 * with a human role, an explicit AI rejection, or a strong "real person"
 * noun. Length alone never makes a phrase strong — a descriptive sentence
 * configured by the owner stays supporting evidence.
 */
export function classifyConfiguredKeyword(keyword: string): 'strong' | 'supporting' | 'ignored' {
  const norm = normalizeForIntent(keyword);
  if (!norm || norm.length < 3) return 'ignored';
  if (AI_REJECTION.test(norm)) return 'strong';
  if (STRONG_HUMAN_NOUN.test(norm)) return 'strong';
  if (TRANSFER_VERB.test(norm) && matchHumanNoun(norm)) return 'strong';
  return 'supporting';
}


export interface ResolveHumanRequestInput {
  text: string;
  /** `ai_agent_settings.handoff_keywords` — kept for compatibility. */
  configuredKeywords?: string[] | null;
  /** Deterministic topic classifier said `human-request`. Supporting only. */
  topicHumanRequest?: boolean;
  /** Owner switch — when false nothing here can authorize a handoff. */
  handoffOnHumanRequest?: boolean;
}

/**
 * The single source of truth for "did the visitor explicitly ask for a
 * human right now?".
 */
export function resolveHumanRequestSignal(input: ResolveHumanRequestInput): HumanRequestSignal {
  const norm = normalizeForIntent(input.text);
  const supporting = {
    topicHumanRequest: !!input.topicHumanRequest,
    genericKeywordMention: null as string | null,
  };
  if (!norm) return { ...NO_HUMAN_REQUEST, supporting };

  const matchedNoun = matchHumanNoun(norm);
  const hasHumanNoun = !!matchedNoun;
  const hasStrongNoun = STRONG_HUMAN_NOUN.test(norm);
  const hasTransferVerb = TRANSFER_VERB.test(norm);
  const hasWantVerb = WANT_VERB.test(norm);

  // 1. Explicit bot rejection ("دیگه نمیخوام با ربات حرف بزنم").
  if (AI_REJECTION.test(norm)) {
    return {
      explicit: true, confidence: 0.9, reason: 'ai_rejection',
      matchedPhrase: input.text.trim().slice(0, 160), supporting,
    };
  }

  // 2. Human noun + transfer intent ("منو به اپراتور وصل کن").
  if (hasHumanNoun && hasTransferVerb) {
    return {
      explicit: true, confidence: 0.95, reason: 'explicit_phrase',
      matchedPhrase: input.text.trim().slice(0, 160), supporting,
    };
  }

  // 3. "آدم واقعی میخوام" / "I want a real person".
  if (hasStrongNoun && (hasWantVerb || hasTransferVerb)) {
    return {
      explicit: true, confidence: 0.9, reason: 'explicit_phrase',
      matchedPhrase: input.text.trim().slice(0, 160), supporting,
    };
  }

  // 4. Bare request: the whole message is essentially the noun ("اپراتور لطفا").
  if (isBareHumanRoleRequest(input.text, norm, matchedNoun)) {
    return {
      explicit: true, confidence: 0.75, reason: 'explicit_phrase',
      matchedPhrase: input.text.trim().slice(0, 160), supporting,
    };
  }

  // 5. Owner-configured phrases. Strong phrases authorize; generic nouns are
  //    recorded as supporting evidence only.
  for (const kw of input.configuredKeywords || []) {
    const kwNorm = normalizeForIntent(kw);
    if (!kwNorm || !phraseHit(norm, kwNorm)) continue;
    const cls = classifyConfiguredKeyword(kw);
    if (cls === 'strong') {
      return {
        explicit: true, confidence: 0.85, reason: 'configured_phrase',
        matchedPhrase: kw, supporting,
      };
    }
    if (cls === 'supporting' && !supporting.genericKeywordMention) {
      supporting.genericKeywordMention = kw;
    }
  }

  // 6. Topic support only — never authoritative by itself.
  if (supporting.topicHumanRequest) {
    return {
      explicit: false, confidence: 0.35, reason: 'topic_support',
      matchedPhrase: null, supporting,
    };
  }

  return { ...NO_HUMAN_REQUEST, supporting };
}

/**
 * Convenience wrapper used by the runtime policy. Honors the owner switch.
 */
export function isExplicitHumanRequest(input: ResolveHumanRequestInput): boolean {
  if (input.handoffOnHumanRequest === false) return false;
  return resolveHumanRequestSignal(input).explicit;
}
