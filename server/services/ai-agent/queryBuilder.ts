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
 * Deterministic referential / continuation detector. True when the current
 * message cannot stand on its own for retrieval.
 */
const REFERENTIAL_PATTERNS: RegExp[] = [
  /\b(that|this|it|those|these|them|there)\b/i,
  /^\s*(and|also|what about|how about|but)\b/i,
  /^\s*(peki|ya|onu|bunu|şu)\b/i,
  /(اون|آن|این|همون|همان|چطور در مورد|و بعد)/,
];

export function isReferentialFollowUp(message: string): boolean {
  const m = (message || '').trim();
  if (!m) return false;
  const words = m.split(/\s+/).filter(Boolean);
  if (words.length <= 6) return true;
  return REFERENTIAL_PATTERNS.some((p) => p.test(m));
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