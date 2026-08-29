/**
 * AI Agent API client — human guidance domain (vNext).
 *
 * Private operator → AI steering for one conversation. Nothing here is
 * visitor-visible: guidance and guidance requests are internal-only records.
 */
import { jsonFetch } from './client.js';

export type GuidanceKind = 'direction' | 'fact';
export type GuidanceScope = 'next_turn' | 'conversation';
export type GuidanceStatus = 'active' | 'consumed' | 'expired' | 'revoked';

export interface AiGuidance {
  id: string;
  workspace_id: string;
  conversation_id: string;
  kind: GuidanceKind;
  scope: GuidanceScope;
  body: string;
  status: GuidanceStatus;
  operator_id: string | null;
  operator_name: string | null;
  used_count: number;
  created_at: string;
  updated_at: string;
}

export interface AiGuidanceRequest {
  id: string;
  workspace_id: string;
  conversation_id: string;
  question: string;
  visitor_question: string | null;
  known_summary: string | null;
  missing_information: string | null;
  status: 'pending' | 'resolved' | 'dismissed' | 'expired';
  created_at: string;
}

export interface ConversationGuidanceResponse {
  items: AiGuidance[];
  requests: AiGuidanceRequest[];
  maxBody: number;
}

export type ReplyNowBlockedReason =
  | 'conversation_not_found'
  | 'conversation_closed'
  | 'human_active'
  | 'handoff_in_progress'
  | 'not_ai_managed'
  | 'no_visitor_message'
  | 'reply_now_in_progress'
  | 'guidance_create_failed';

export interface ReplyNowEligibility {
  eligible: boolean;
  reason: ReplyNowBlockedReason | null;
  visitorMessageId: string | null;
}

export interface ReplyNowResponse {
  guidance: AiGuidance | null;
  visitorMessageId: string;
  deduplicated: boolean;
  action: 'replied' | 'suggested' | 'handoff' | 'no_answer' | 'skipped' | 'failed';
  reason: string | null;
  messageId: string | null;
  runId: string | null;
}


export const humanGuidanceApi = {
  /** Active guidance + pending AI questions for a conversation. */
  getConversationGuidance(conversationId: string): Promise<ConversationGuidanceResponse> {
    return jsonFetch<ConversationGuidanceResponse>(`/api/ai-agent/conversations/${conversationId}/guidance`);
  },

  /** Write a private instruction or fact for the AI. */
  createConversationGuidance(
    conversationId: string,
    body: {
      body: string;
      kind?: GuidanceKind;
      scope?: GuidanceScope;
      requestId?: string;
    },
  ): Promise<{ guidance: AiGuidance }> {
    return jsonFetch<{ guidance: AiGuidance }>(`/api/ai-agent/conversations/${conversationId}/guidance`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  revokeConversationGuidance(guidanceId: string): Promise<{ ok: boolean }> {
    return jsonFetch<{ ok: boolean }>(`/api/ai-agent/guidance/${guidanceId}`, { method: 'DELETE' });
  },

  dismissGuidanceRequest(requestId: string): Promise<{ ok: boolean }> {
    return jsonFetch<{ ok: boolean }>(`/api/ai-agent/guidance-requests/${requestId}/dismiss`, { method: 'POST' });
  },

  /** Can the AI answer right now (latest visitor message, no takeover)? */
  getReplyNowEligibility(conversationId: string): Promise<ReplyNowEligibility> {
    return jsonFetch<ReplyNowEligibility>(
      `/api/ai-agent/conversations/${conversationId}/ai-reply-now/eligibility`,
    );
  },

  /**
   * Persist optional private guidance and run the REAL AI Agent pipeline
   * against the latest visitor message, publishing the reply when eligible.
   */
  aiReplyNow(
    conversationId: string,
    body: {
      body?: string;
      kind?: GuidanceKind;
      scope?: GuidanceScope;
      requestId?: string;
      idempotencyKey?: string;
    },
  ): Promise<ReplyNowResponse> {
    return jsonFetch<ReplyNowResponse>(`/api/ai-agent/conversations/${conversationId}/ai-reply-now`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};

