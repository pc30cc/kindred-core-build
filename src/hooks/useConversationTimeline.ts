/**
 * Phase 4b — Conversation timeline read.
 *
 * Reads normalized rows from `conversation_events` via the backend route
 * /api/conversations/:id/timeline. Never reconstructs from audit_logs or
 * messages. Payload shape per event_type matches the contract documented
 * in server/routes/conversationNotes.ts.
 */

import { useQuery } from '@tanstack/react-query';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export type TimelineEventType =
  | 'created' | 'identified'
  | 'assigned' | 'unassigned'
  | 'status_changed' | 'resolved' | 'reopened'
  | 'priority_changed'
  | 'tag_added' | 'tag_removed'
  | 'attachment_added' | 'ai_reply'
  | 'note_added' | 'note_deleted';

export interface TimelineActor {
  id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface TimelineEvent {
  id: string;
  conversation_id: string;
  workspace_id: string;
  event_type: TimelineEventType | string;
  actor_type: 'agent' | 'visitor' | 'system' | 'ai';
  actor_id: string | null;
  payload: Record<string, any>;
  created_at: string;
  actor: TimelineActor | null;
}

export function useConversationTimeline(
  conversationId: string | undefined,
  workspaceId: string | undefined,
) {
  return useQuery({
    queryKey: ['conversation-timeline', conversationId, workspaceId],
    queryFn: async (): Promise<TimelineEvent[]> => {
      const url = `${API_BASE}/api/conversations/${encodeURIComponent(conversationId!)}/timeline`
        + `?workspace_id=${encodeURIComponent(workspaceId!)}`;
      const res = await fetch(url, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Timeline load failed: ${res.status}`);
      return (json.events ?? []) as TimelineEvent[];
    },
    enabled: !!conversationId && !!workspaceId,
    staleTime: 10_000,
  });
}
