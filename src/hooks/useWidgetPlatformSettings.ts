import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export type PreChatPolicy = 'force_on' | 'force_off' | 'default_on' | 'default_off';
export type FeatureLockMode = 'allow' | 'force_on' | 'force_off';

export interface WidgetPlatformSettings {
  id: string;
  prechat_name_policy: PreChatPolicy;
  prechat_email_policy: PreChatPolicy;
  prechat_phone_policy: PreChatPolicy;
  default_allow_subdomains: boolean;
  max_allowed_domains_per_workspace: number;
  enforce_domain_validation: boolean;
  default_debug_mode: boolean;
  force_chat_enabled: FeatureLockMode;
  force_kb_enabled: FeatureLockMode;
  force_visitor_tracking: FeatureLockMode;
  max_message_length: number;
  rate_limit_messages_per_minute: number;
  admin_notes: string | null;
  // ── Deployment URLs (single source of truth for widget loader/assets/api) ──
  widget_loader_base_url: string | null;
  widget_asset_base_url: string | null;
  widget_public_base_url: string | null;
  widget_api_base_url: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

const QUERY_KEY = ['widget-platform-settings'] as const;

export function useWidgetPlatformSettings() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('widget_platform_settings')
        .select('*')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as WidgetPlatformSettings | null;
    },
  });
}

export function useUpdateWidgetPlatformSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<WidgetPlatformSettings> }) => {
      const { data, error } = await supabase
        .from('widget_platform_settings')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}
