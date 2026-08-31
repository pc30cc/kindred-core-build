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

/** Human nouns. Mentioning one is NEVER sufficient on its own. */
const HUMAN_NOUN =
  /(اپراتور|پشتیبان|کارشناس|انسان|ادم|آدم|همکار|نماینده|temsilci|yetkili|insan|canli destek|canlı destek|musteri temsilcisi|human|humans|agent|agents|operator|operators|representative|real person|someone real|someone|somebody|live support|live agent|support person)/u;

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
 * An owner-configured handoff keyword is a STRONG signal only when it is a
 * real phrase that itself expresses transfer intent (e.g. "وصل کن به
 * پشتیبانی", "connect me to an agent"). A bare generic noun ("پشتیبان",
 * "agent") is downgraded to supporting evidence — it must never transfer a
 * conversation on its own. Backward compatible: the keyword list is still
 * read and honoured, only its authority is scoped.
 */
export function classifyConfiguredKeyword(keyword: string): 'strong' | 'supporting' | 'ignored' {
  const norm = normalizeForIntent(keyword);
  if (!norm || norm.length < 3) return 'ignored';
  const tokens = tokenCount(norm);
  if (tokens >= 2 && (TRANSFER_VERB.test(norm) || AI_REJECTION.test(norm) || STRONG_HUMAN_NOUN.test(norm))) {
    return 'strong';
  }
  if (tokens >= 3) return 'strong'; // deliberate full sentence configured by the owner
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

  const hasHumanNoun = HUMAN_NOUN.test(norm);
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
  if (hasHumanNoun && tokenCount(norm) <= BARE_REQUEST_MAX_TOKENS && !/\?|چطور|چگونه|چه|کی|nasil|nasıl|ne zaman|how|when|what/u.test(norm)) {
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
