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
};
