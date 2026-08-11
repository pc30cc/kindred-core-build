/**
 * AI Agent API client — operator-assist domain.
 *
 * Mechanically extracted from src/lib/ai-agent-api.ts (Phase 4 split).
 * Suggest-reply, assist feedback, and assist analytics. Same URLs,
 * methods, bodies, and response types as before.
 */
import { jsonFetch } from './client.js';


export interface OperatorSuggestReplyResponse {
  ok: boolean;
  assist_run_id: string | null;
  suggestion: string | null;
  confidence: number;
  tone: string | null;
  provider: string | null;
  model: string | null;
  selected_sources: Array<{
    id: string;
    source_id: string;
    source_type: string;
    kind: string;
    title: string;
    source_url: string | null;
    locale: string | null;
    final_score: number;
  }>;
  retrieval_debug: any;
  answer_strategy: {
    action: 'answer' | 'handoff' | 'clarification' | 'no_answer';
    decision_type: string;
    reason: string;
    retrieval_strength: string;
    top_score: number;
    handoff_required: boolean;
    source_types_used: string[];
  };
  safety_notes: string[];
  excluded_summary?: Record<string, number>;
  prompt_preview?: { system: string; user: string };
}


export type OperatorAssistFeedbackRating = 'positive' | 'negative' | 'neutral';

export type OperatorAssistFeedbackReason =
  | 'helpful' | 'wrong_answer' | 'missing_context' | 'bad_tone'
  | 'too_long' | 'too_short' | 'unsafe' | 'not_grounded' | 'other';

export type OperatorAssistFeedbackAction =
  | 'inserted' | 'replaced' | 'appended' | 'copied' | 'dismissed'
  | 'regenerated' | 'sent_after_edit' | 'sent_as_is';


export interface OperatorAssistFeedbackInput {
  rating: OperatorAssistFeedbackRating;
  reason?: OperatorAssistFeedbackReason | null;
  comment?: string | null;
  operatorAction?: OperatorAssistFeedbackAction | null;
  finalComposerText?: string | null;
  metadata?: Record<string, unknown>;
}


export interface OperatorAssistAnalytics {
  range: string;
  summary: {
    total_suggestions: number;
    total_feedback: number;
    positive: number;
    negative: number;
    neutral: number;
    acceptance_rate: number;
    negative_rate: number;
    avg_confidence: number;
    no_source_count: number;
    usage_increment_failed_count: number;
  };
  by_reason: Array<{ reason: string; count: number }>;
  by_action: Array<{ action: string; count: number }>;
  by_source_type: Array<{ source_type: string; runs: number }>;
  by_day: Array<{ day: string; suggestions: number; positive: number; negative: number; neutral: number }>;
  worst_runs: Array<{
    run_id: string;
    feedback_id: string | null;
    created_at: string;
    confidence: number | null;
    rating: 'negative';
    reason: string | null;
    source_types: string[];
    safety_notes: string[];
    suggestion_preview: string | null;
  }>;
}


export const operatorAssistApi = {
  // Pass E7 — Operator AI Suggest-Reply (read-only, manual)
  suggestReply: (input: {
    workspaceId: string;
    conversationId: string;
    locale?: string;
    tone?: 'friendly' | 'professional' | 'short' | 'detailed';
    instruction?: string;
    callLLM?: boolean;
  }) =>
    jsonFetch(`/api/ai-agent/operator/suggest-reply`, {
      method: 'POST',
      body: JSON.stringify(input),
    }) as Promise<OperatorSuggestReplyResponse>,
  // Pass E8 — Operator Assist feedback + analytics
  submitAssistFeedback: (runId: string, input: OperatorAssistFeedbackInput) =>
    jsonFetch(`/api/ai-agent/operator-assist/${runId}/feedback`, {
      method: 'POST',
      body: JSON.stringify(input),
    }) as Promise<{ ok: boolean; feedback: any }>,
  getAssistAnalytics: (workspaceId: string, range: '7d' | '30d' | '90d' = '7d') =>
    jsonFetch(`/api/ai-agent/operator-assist/analytics?workspaceId=${workspaceId}&range=${range}`) as Promise<OperatorAssistAnalytics>,
};
