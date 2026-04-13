import { supabase } from '@/lib/supabase';
import { useQuery } from '@tanstack/react-query';
import type { VisitorSession, VisitorPresence } from '@/types/models';

export function useOnlineVisitors(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['online-visitors', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('visitor_presence')
        .select('*, visitor_sessions(*)')
        .eq('workspace_id', workspaceId!)
        .in('status', ['online', 'idle'])
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data as (VisitorPresence & { visitor_sessions: VisitorSession })[];
    },
    enabled: !!workspaceId,
    refetchInterval: 10000, // Poll every 10s
  });
}

export function useVisitorSessions(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['visitor-sessions', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('visitor_sessions')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('last_seen_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as VisitorSession[];
    },
    enabled: !!workspaceId,
  });
}
