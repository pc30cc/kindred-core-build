import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';

export function useEmailLogs(options?: { limit?: number; status?: string }) {
  const workspace = useCurrentWorkspace();

  return useQuery({
    queryKey: ['email-logs', workspace?.id, options],
    queryFn: async () => {
      let query = supabase
        .from('email_logs')
        .select('*')
        .eq('workspace_id', workspace!.id)
        .order('created_at', { ascending: false })
        .limit(options?.limit || 50);

      if (options?.status) {
        query = query.eq('status', options.status);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    enabled: !!workspace?.id,
  });
}
