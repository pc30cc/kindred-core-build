/**
 * AI Agent — conversation-aware retrieval query builder (Pass 1).
 *
 * Combines the current visitor message with short-term conversation context
 * (especially the previous visitor message when the AI just asked a clarifying
 * question) and multilingual synonym expansion. The output is used ONLY for
 * retrieval — never shown to the visitor.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { expandQuery, type TopicKey } from './queryExpansion.js';

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
}

const RECENT_LOOKBACK = 6;

/**
 * Builds a retrieval-friendly query that incorporates relevant short-term
 * context. Cheap: 1 supabase call.
 */
export async function buildRetrievalQuery(
  input: BuildRetrievalQueryInput,
): Promise<BuiltRetrievalQuery> {
  const { config, conversationId } = input;
  const current = (input.currentMessage || '').trim();

  let contextMessagesUsed = 0;
  let followUpDetected = false;
  let previousAiAskedClarification = false;
  let augmented = current;

  try {
    const sb = getServiceClient(config);
    const { data: rows } = await sb
      .from('conversation_messages')
      .select('id, body, sender_type, metadata, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(RECENT_LOOKBACK);
    const recent = (rows || []).slice().reverse(); // chronological

    // Look at the most recent assistant message — was it a clarifying question?
    const lastAssistant = [...recent].reverse().find(
      (m: any) => m.sender_type === 'ai' || m.sender_type === 'agent' || m.sender_type === 'assistant',
    );
    const lastAssistantMeta = (lastAssistant as any)?.metadata || {};
    const decisionType =
      lastAssistantMeta?.answer_strategy?.decision_type
      || lastAssistantMeta?.decision_type
      || lastAssistantMeta?.source;
    if (decisionType === 'ask_clarifying_question') {
      previousAiAskedClarification = true;
    }

    // Pull the previous visitor message if the AI just asked a clarifying
    // question — the current visitor message may only carry the missing
    // detail (e.g. "plan fiyat" after "Which pricing info?").
    const visitorMessages = recent.filter(
      (m: any) => m.sender_type === 'visitor' || m.sender_type === 'contact' || m.sender_type === 'user',
    );
    if (previousAiAskedClarification && visitorMessages.length >= 2) {
      const prevVisitor = visitorMessages[visitorMessages.length - 2];
      const prevText = ((prevVisitor as any)?.body || '').toString().trim();
      if (prevText && prevText !== current) {
        augmented = `${prevText} ${current}`.trim();
        followUpDetected = true;
        contextMessagesUsed = 2;
      }
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
  };
}