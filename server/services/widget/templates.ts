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
 * Currently always returns `default` because no workspace-level selection
 * exists yet — but the signature already accepts `workspaceId` so a
 * future migration can add `widget_settings.template_slug` without
 * touching call sites.
 */
export async function getActiveTemplateSlug(
  _supabase: SupabaseClient,
  _workspaceId?: string | null,
): Promise<string> {
  return DEFAULT_TEMPLATE_SLUG;
}