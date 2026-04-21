/**
 * Widget Templates Resolver
 *
 * Foundation for managing platform-registered widget UI templates.
 * The widget runtime continues to use the built-in `default` template;
 * this module simply lets the platform admin enable/disable templates
 * and gives downstream code a stable API to ask "which templates are
 * available?" without coupling to the database directly.
 *
 * Backward compatibility contract:
 *   - If no template is selected anywhere, `getActiveTemplateSlug()`
 *     returns `'default'`.
 *   - If the `default` template is somehow disabled, we still fall back
 *     to it at runtime so existing widgets never break.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const DEFAULT_TEMPLATE_SLUG = 'default';

export interface WidgetTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'active' | 'beta' | 'deprecated' | 'hidden';
  enabled: boolean;
  is_builtin: boolean;
  sort_order: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function listWidgetTemplates(supabase: SupabaseClient): Promise<WidgetTemplate[]> {
  const { data, error } = await supabase
    .from('widget_templates')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('slug', { ascending: true });
  if (error) throw error;
  return (data || []) as WidgetTemplate[];
}

export async function getEnabledTemplateSlugs(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from('widget_templates')
    .select('slug')
    .eq('enabled', true);
  if (error) throw error;
  const slugs = (data || []).map((r: any) => r.slug as string);
  // Always guarantee the default template is considered available so the
  // runtime never lands in an unrenderable state.
  if (!slugs.includes(DEFAULT_TEMPLATE_SLUG)) slugs.push(DEFAULT_TEMPLATE_SLUG);
  return slugs;
}

/**
 * Resolves the active template slug for a workspace.
 *
 * Reads `widget_settings.template_slug` for the workspace and validates
 * it against the registered templates. If the chosen template is missing
 * or has been disabled by the platform admin, we silently fall back to
 * `'default'` so the widget never lands in an unrenderable state.
 */
export async function getActiveTemplateSlug(
  supabase: SupabaseClient,
  workspaceId?: string | null,
): Promise<string> {
  if (!workspaceId) return DEFAULT_TEMPLATE_SLUG;
  const { data: ws } = await supabase
    .from('widget_settings')
    .select('template_slug')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const slug = (ws as any)?.template_slug || DEFAULT_TEMPLATE_SLUG;
  if (slug === DEFAULT_TEMPLATE_SLUG) return DEFAULT_TEMPLATE_SLUG;
  const { data: tpl } = await supabase
    .from('widget_templates')
    .select('slug, enabled')
    .eq('slug', slug)
    .maybeSingle();
  if (!tpl || !(tpl as any).enabled) return DEFAULT_TEMPLATE_SLUG;
  return slug;
}