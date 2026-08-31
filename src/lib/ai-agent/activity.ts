/**
 * AI Agent API client — activity domain.
 *
 * Mechanically extracted from src/lib/ai-agent-api.ts (Phase 4 split).
 * Runs, paged runs, run inspection, analytics, conversation suggestions,
 * and manual operator take-over. Same URLs, methods, bodies, and response
 * types as before.
 */
import { jsonFetch } from './client.js';


export interface AgentSuggestionSource {
  id: string;
  title: string;
  slug: string | null;
  locale: string | null;
}


export interface AgentSuggestion {
  id: string;
  conversation_id: string;
  visitor_message_id: string | null;
  suggested_reply: string;
  source_article_ids: string[];
  confidence: number | null;
  status: 'pending' | 'used' | 'dismissed' | 'expired';
  created_at: string;
  updated_at: string;
  sources?: AgentSuggestionSource[];
}


export const activityApi = {
  getRuns: (workspaceId: string, limit = 50) =>
    jsonFetch(`/api/ai-agent/runs?workspaceId=${workspaceId}&limit=${limit}`) as Promise<{ runs: any[] }>,
  getRunsPaged: (workspaceId: string, opts: { page?: number; pageSize?: number; search?: string; filter?: string } = {}) => {
    const p = new URLSearchParams({ workspaceId });
    p.set('page', String(opts.page ?? 1));
    p.set('pageSize', String(opts.pageSize ?? 20));
    p.set('filter', opts.filter ?? 'all');
    if (opts.search) p.set('search', opts.search);
    return jsonFetch(`/api/ai-agent/runs?${p.toString()}`) as Promise<{ runs: any[]; page: number; pageSize: number; total: number; totalPages: number }>;
  },
  inspectRun: (id: string) =>
    jsonFetch(`/api/ai-agent/runs/${id}/inspect`) as Promise<any>,
  getAnalytics: (workspaceId: string) =>
    jsonFetch(`/api/ai-agent/analytics?workspaceId=${workspaceId}`) as Promise<any>,
  // Conversation suggestions (Phase 2 operator-facing UI)
  listConversationSuggestions: (conversationId: string, status: 'pending' | 'all' = 'pending') =>
    jsonFetch(`/api/ai-agent/conversations/${conversationId}/suggestions?status=${status}`) as Promise<{ items: AgentSuggestion[] }>,
  useSuggestion: (id: string) =>
    jsonFetch(`/api/ai-agent/suggestions/${id}/use`, { method: 'POST' }) as Promise<{ ok: boolean; suggestion: AgentSuggestion }>,
  dismissSuggestion: (id: string) =>
    jsonFetch(`/api/ai-agent/suggestions/${id}/dismiss`, { method: 'POST' }) as Promise<{ ok: boolean; suggestion: AgentSuggestion }>,
  // Takeover goes through the inbox-owned route, which is not behind the AI
  // Agent platform/plan guard. Falls back to the legacy AI route on 404 so
  // older backends keep working.
  takeOverConversation: async (workspaceId: string, conversationId: string, assignToMe = true) => {
    const body = JSON.stringify({ workspaceId, assign_to_me: assignToMe });
    try {
      return (await jsonFetch(`/api/conversations/${conversationId}/take-over`, {
        method: 'POST',
        body,
      })) as { ok: boolean };
    } catch (e: any) {
      if (e?.status !== 404) throw e;
      return (await jsonFetch(`/api/ai-agent/conversations/${conversationId}/take-over`, {
        method: 'POST',
        body,
      })) as { ok: boolean };
    }
  },
};

