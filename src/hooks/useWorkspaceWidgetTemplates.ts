/**
 * Workspace-facing widget templates hook.
 *
 * Reads the list of platform-registered widget templates that are
 * `enabled = true`. Workspace users (not just admins) can read this
 * directly via the existing "Authenticated can read widget templates"
 * RLS policy — no admin endpoint required.
 *
 * The selected template is stored on `widget_settings.template_slug`
 * and is updated through the regular `useUpdateWidgetSettings` mutation.
 */
import { supabase } from '@/lib/supabase';
import { useQuery } from '@tanstack/react-query';
import type { WidgetTemplate } from '@/lib/widget-templates-api';

export function useWorkspaceWidgetTemplates() {
  return useQuery({
    queryKey: ['workspace-widget-templates'] as const,
    queryFn: async (): Promise<WidgetTemplate[]> => {
      const { data, error } = await supabase
        .from('widget_templates')
        .select('*')
        .eq('enabled', true)
        .neq('status', 'hidden')
        .order('sort_order', { ascending: true })
        .order('slug', { ascending: true });
      if (error) throw error;
      return (data || []) as unknown as WidgetTemplate[];
    },
    staleTime: 60_000,
  });
}