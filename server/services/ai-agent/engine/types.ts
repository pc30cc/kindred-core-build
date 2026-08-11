/**
 * AI Agent engine — public types.
 *
 * Mechanically extracted from server/services/ai-agent/engine.ts (Phase 5
 * engine extraction). No behavior change; text unchanged.
 */
import type { RetrievedSource } from '../retrieval.js';

export interface MaybeRunInput {
  workspaceId: string;
  conversationId: string;
  visitorMessageId: string;
  question: string;
  locale?: string;
  /** E2C — sanitized visitor page context from the widget. */
  pageContext?: {
    currentPageUrl?: string | null;
    currentPageOrigin?: string | null;
    currentPagePath?: string | null;
    currentPageTitle?: string | null;
    referrer?: string | null;
    source?: string;
  } | null;
}

export interface MaybeRunResult {
  ran: boolean;
  action: 'replied' | 'suggested' | 'handoff' | 'no_answer' | 'skipped' | 'failed';
  reason?: string;
  suggestionId?: string | null;
  runId?: string | null;
  messageId?: string | null;
}

export type { RetrievedSource };
