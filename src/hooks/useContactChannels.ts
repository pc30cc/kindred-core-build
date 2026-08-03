import { supabase } from '@/lib/supabase';
import { useQuery } from '@tanstack/react-query';

/**
 * Contacts are shared between the chat widget and the call center.
 * There is no `source` column on `contacts`, so origin is derived:
 *  - a conversation that has call sessions  -> call center
 *  - a conversation without call sessions   -> chat widget
 */
export type ContactChannelInfo = {
  chat: boolean;
  call: boolean;
  calls: number;
  lastCallAt: string | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchCallSessionsForConversations(convIds: string[]) {
  const rows: any[] = [];
  for (const part of chunk(convIds, 150)) {
    const { data, error } = await supabase
      .from('call_sessions')
      .select(
        'id, context_id, call_type, direction, state, entry_source, duration_seconds, wait_seconds, created_at, started_at, connected_at, ended_at, end_reason, assigned_agent_id, recording_enabled, recording_state, visitor_name, visitor_phone, visitor_email',
      )
      .eq('context_type', 'conversation')
      .in('context_id', part)
      .order('created_at', { ascending: false });
    if (error) throw error;
    rows.push(...((data ?? []) as any[]));
  }
  return rows;
}

/** Channel origin badges for the whole contacts list. */
export function useContactChannels(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['contact-channels', workspaceId],
    queryFn: async () => {
      const { data: convs, error } = await supabase
        .from('conversations')
        .select('id, contact_id')
        .eq('workspace_id', workspaceId!)
        .not('contact_id', 'is', null);
      if (error) throw error;

      const convToContact = new Map<string, string>();
      const map: Record<string, ContactChannelInfo> = {};
      for (const c of (convs ?? []) as any[]) {
        convToContact.set(c.id, c.contact_id);
        if (!map[c.contact_id]) map[c.contact_id] = { chat: false, call: false, calls: 0, lastCallAt: null };
      }

      const convIds = Array.from(convToContact.keys());
      const callConvIds = new Set<string>();
      if (convIds.length) {
        const sessions = await fetchCallSessionsForConversations(convIds);
        for (const s of sessions) {
          const contactId = convToContact.get(s.context_id);
          if (!contactId) continue;
          callConvIds.add(s.context_id);
          const entry = map[contactId];
          entry.call = true;
          entry.calls += 1;
          const at = s.created_at ?? null;
          if (at && (!entry.lastCallAt || at > entry.lastCallAt)) entry.lastCallAt = at;
        }
      }

      // A contact counts as a chat contact when at least one of its
      // conversations never turned into a call.
      for (const [convId, contactId] of convToContact) {
        if (!callConvIds.has(convId)) map[contactId].chat = true;
      }

      return map;
    },
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}

export type ContactCall = {
  id: string;
  call_type: string;
  direction: string;
  state: string;
  entry_source: string | null;
  duration_seconds: number | null;
  wait_seconds: number | null;
  created_at: string;
  ended_at: string | null;
  end_reason: string | null;
  agent_name: string | null;
  agent_avatar: string | null;
  recording_state: string | null;
  recording_available: boolean;
  recording_duration: number | null;
  recording_size_bytes: number | null;
  conversation_id: string | null;
};

/** Full call history (with recordings + operator) for one contact. */
export function useContactCalls(contactId: string | undefined) {
  return useQuery({
    queryKey: ['contact-calls', contactId],
    queryFn: async (): Promise<ContactCall[]> => {
      const { data: convs, error } = await supabase
        .from('conversations')
        .select('id')
        .eq('contact_id', contactId!);
      if (error) throw error;
      const convIds = ((convs ?? []) as any[]).map((c) => c.id);
      if (!convIds.length) return [];

      const sessions = await fetchCallSessionsForConversations(convIds);
      if (!sessions.length) return [];

      const agentIds = Array.from(
        new Set(sessions.map((s) => s.assigned_agent_id).filter(Boolean)),
      ) as string[];
      const profiles: Record<string, { full_name: string | null; email: string; avatar_url: string | null }> = {};
      if (agentIds.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, email, avatar_url')
          .in('id', agentIds);
        for (const p of (profs ?? []) as any[]) {
          profiles[p.id] = { full_name: p.full_name, email: p.email, avatar_url: p.avatar_url };
        }
      }

      const recordings: Record<string, any> = {};
      for (const part of chunk(sessions.map((s) => s.id), 150)) {
        const { data: recs } = await supabase
          .from('call_recordings')
          .select('call_session_id, duration_seconds, size_bytes, created_at')
          .in('call_session_id', part);
        for (const r of (recs ?? []) as any[]) recordings[r.call_session_id] = r;
      }

      return sessions.map((s) => {
        const p = s.assigned_agent_id ? profiles[s.assigned_agent_id] : null;
        const rec = recordings[s.id] ?? null;
        return {
          id: s.id,
          call_type: s.call_type,
          direction: s.direction,
          state: s.state,
          entry_source: s.entry_source ?? null,
          duration_seconds: s.duration_seconds ?? null,
          wait_seconds: s.wait_seconds ?? null,
          created_at: s.created_at,
          ended_at: s.ended_at ?? null,
          end_reason: s.end_reason ?? null,
          agent_name: p ? p.full_name || p.email : null,
          agent_avatar: p?.avatar_url ?? null,
          recording_state: s.recording_state ?? null,
          recording_available: !!rec,
          recording_duration: rec?.duration_seconds ?? null,
          recording_size_bytes: rec?.size_bytes ?? null,
          conversation_id: s.context_id ?? null,
        };
      });
    },
    enabled: !!contactId,
  });
}
