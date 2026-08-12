/**
 * AI Agent — conversation-aware retrieval query builder (Pass 1, extended in
 * Phase 2.2 / 2.3).
 *
 * Combines the current visitor message with short-term conversation context
 * (the previous visitor message when the AI just asked a clarifying question,
 * and — new in Phase 2 — the previous visitor topic whenever the current
 * message is a referential/short follow-up such as "does that include API
 * access?" or "what about 10 agents?") plus multilingual synonym expansion.
 * The output is used ONLY for retrieval — never shown to the visitor.
 *
 * Deterministic by design: no LLM call is made to rewrite queries.
 */
import type { ServerConfig } from '../../config.js';
import { expandQuery, type TopicKey } from './queryExpansion.js';
import { loadConversationContext, type ContextTurn } from './conversationContext.js';

export interface BuildRetrievalQueryInput {
  config: ServerConfig;
  workspaceId: string;
  conversationId: string;
  currentMessage: string;
  /** Visitor input language (from language service) — informs context. */
  inputLanguage?: string;
  widgetLocale?: string;
}

export interface BuiltRetrievalQuery {
  retrievalQuery: string;        // final string to feed retrieval
  expandedQuery: string;         // post-expansion form (debug)
  originalMessage: string;
  contextMessagesUsed: number;
  topics: TopicKey[];
  addedTerms: string[];
  followUpDetected: boolean;
  previousAiAskedClarification: boolean;
  /** Phase 2.1 — bounded rendered conversation context (may be ''). */
  conversationContext: string;
  /** Bounded turns behind `conversationContext`, for role-tagged prompting. */
  contextTurns: ContextTurn[];
  conversationContextUsed: boolean;
  conversationTurnsUsed: number;
  /** Phase 2.2 — clarification continuity metadata. */
  clarification: {
    asked: boolean;
    question: string | null;
    originalIntent: string | null;
    followUpResponse: string | null;
  };
  /** Phase 2.3 — why the query differs from the raw visitor message. */
  rewriteReason: 'none' | 'clarification_followup' | 'referential_followup';
}

const RECENT_LOOKBACK = 6;

/**
 * Deterministic referential / continuation detector.
 *
 * A message is referential ONLY when it carries explicit evidence that it
 * depends on the previous turn. Shortness alone is NOT evidence: a short but
 * self-contained topic switch ("What is API access?") must keep its own topic.
 */

/** Anaphora — pronouns / demonstratives pointing at an earlier topic. */
const PRONOUN_PATTERNS: RegExp[] = [
  /\b(that|this|those|these|them|they|it|its|there)\b/i,
  /\b(onu|bunu|şunu|onlar|bunlar|orada)\b/i,
  /(اون|آن\b|این|همون|همان|آنها|اونها)/,
];

/** Continuation prefixes — the message extends the previous question. */
const CONTINUATION_PREFIXES: RegExp[] = [
  /^\s*(and|also|but|plus|then|what about|how about|and what about|what if|ok(?:ay)?,? and)\b/i,
  /^\s*(peki|ya|ayrıca|ve|peki ya)\b/i,
  /^\s*(و |پس |خب |چطور در مورد|و بعد|پس از اون)/,
];

/** Ellipsis-like fragments: no subject/verb, just a constraint continuation. */
const ELLIPSIS_PATTERNS: RegExp[] = [
  // starts with a preposition: "after 30 days?", "for 10 agents?"
  /^\s*(after|before|for|with|without|under|over|during|per|in case of)\b/i,
  /^\s*(sonra|önce|için|ile)\b/i,
  /^\s*(بعد از|قبل از|برای|با )/,
];

/** Bare numeric constraint continuation: "10 agents?", "30 days?", "۳۰ روز؟" */
const NUMERIC_FRAGMENT = /^\s*[\d۰-۹٠-٩]+\s*[\p{L}]+[\s?؟.!]*$/u;

export function isReferentialFollowUp(message: string): boolean {
  const m = (message || '').trim();
  if (!m) return false;

  if (PRONOUN_PATTERNS.some((p) => p.test(m))) return true;
  if (CONTINUATION_PREFIXES.some((p) => p.test(m))) return true;
  if (ELLIPSIS_PATTERNS.some((p) => p.test(m))) return true;
  if (NUMERIC_FRAGMENT.test(m)) return true;

  // Standalone interrogative "how about"-style forms in fa/tr that don't sit
  // at the start of the sentence (e.g. "اون چطور؟" already matched above).
  if (/^\s*(چطور|چی|نه\?)\s*[؟?]?\s*$/.test(m)) return true;

  return false;
}

/**
 * Builds a retrieval-friendly query that incorporates relevant short-term
 * context. Cheap: 1 supabase call.
 */
export async function buildRetrievalQuery(
  input: BuildRetrievalQueryInput,
): Promise<BuiltRetrievalQuery> {
  const { config, conversationId, workspaceId } = input;
  const current = (input.currentMessage || '').trim();

  let contextMessagesUsed = 0;
  let followUpDetected = false;
  let previousAiAskedClarification = false;
  let augmented = current;
  let conversationContext = '';
  let contextTurns: ContextTurn[] = [];
  let conversationContextUsed = false;
  let conversationTurnsUsed = 0;
  let clarificationQuestion: string | null = null;
  let originalIntent: string | null = null;
  let rewriteReason: BuiltRetrievalQuery['rewriteReason'] = 'none';

  try {
    // Tenant-scoped: the loader verifies conversation ∈ workspace first.
    const loaded = await loadConversationContext(config, {
      workspaceId,
      conversationId,
      lookback: RECENT_LOOKBACK,
    });
    conversationContext = loaded.text;
    contextTurns = loaded.turns;
    conversationContextUsed = loaded.used;
    conversationTurnsUsed = loaded.turnsUsed;
    const recent: Array<any> = loaded.allTurns.map((t: ContextTurn) => ({
      id: t.id,
      body: t.text,
      sender_type: t.role === 'assistant' ? 'ai' : t.role,
      metadata: t.metadata,
    }));

    // Look at the most recent assistant message — was it a clarifying question?
    const lastAssistant = [...recent].reverse().find(
      (m: any) => m.sender_type === 'ai' || m.sender_type === 'agent' || m.sender_type === 'assistant' || m.sender_type === 'operator',
    );
    const lastAssistantMeta = (lastAssistant as any)?.metadata || {};
    const decisionType =
      lastAssistantMeta?.answer_strategy?.decision_type
      || lastAssistantMeta?.decision_type
      || lastAssistantMeta?.source;
    if (decisionType === 'ask_clarifying_question') {
      previousAiAskedClarification = true;
      clarificationQuestion = ((lastAssistant as any)?.body || '').toString().trim() || null;
    }

    // Pull the previous visitor message if the AI just asked a clarifying
    // question — the current visitor message may only carry the missing
    // detail (e.g. "plan fiyat" after "Which pricing info?").
    const visitorMessages = recent.filter(
      (m: any) => m.sender_type === 'visitor' || m.sender_type === 'contact' || m.sender_type === 'user',
    );
    // The previous visitor message: `recent` may or may not already include
    // the current message depending on insert ordering, so match by text.
    const priorVisitor = [...visitorMessages]
      .reverse()
      .map((m: any) => ((m?.body || '').toString().trim()))
      .find((t: string) => t && t !== current) || null;

    if (previousAiAskedClarification && priorVisitor) {
      originalIntent = priorVisitor;
      augmented = `${priorVisitor} ${current}`.trim();
      followUpDetected = true;
      contextMessagesUsed = 2;
      rewriteReason = 'clarification_followup';
    } else if (priorVisitor && isReferentialFollowUp(current)) {
      // Phase 2.3 — referential follow-up ("what about 10 agents?"): fold the
      // unresolved topic from the previous visitor turn into the query.
      originalIntent = priorVisitor;
      augmented = `${priorVisitor} ${current}`.trim();
      followUpDetected = true;
      contextMessagesUsed = Math.max(contextMessagesUsed, 2);
      rewriteReason = 'referential_followup';
    }

    // If the AI asked clarification, also fold its question text in — it
    // anchors the topic the visitor is now answering.
    if (previousAiAskedClarification && lastAssistant) {
      const aiBody = ((lastAssistant as any).body || '').toString().trim();
      if (aiBody) {
        augmented = `${augmented} ${aiBody}`.trim();
        contextMessagesUsed = Math.max(contextMessagesUsed, 1) + 1;
      }
    }
  } catch {
    // Best-effort: fall back to current message only.
    augmented = current;
  }

  const { expanded, topics, addedTerms } = expandQuery(augmented);

  return {
    retrievalQuery: expanded,
    expandedQuery: expanded,
    originalMessage: current,
    contextMessagesUsed,
    topics,
    addedTerms,
    followUpDetected,
    previousAiAskedClarification,
    conversationContext,
    contextTurns,
    conversationContextUsed,
    conversationTurnsUsed,
    clarification: {
      asked: previousAiAskedClarification,
      question: clarificationQuestion,
      originalIntent,
      followUpResponse: previousAiAskedClarification ? current : null,
    },
    rewriteReason,
  };
}