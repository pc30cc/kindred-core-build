import { supabase } from '@/lib/supabase';

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

function apiBase(): string {
  return import.meta.env.VITE_API_BASE_URL || window.location.origin;
}

async function authedFetch(path: string, init?: RequestInit) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export async function listWidgetTemplates(): Promise<WidgetTemplate[]> {
  const json = await authedFetch('/api/admin/widget/templates');
  return json.templates as WidgetTemplate[];
}

export async function updateWidgetTemplate(
  id: string,
  patch: Partial<Pick<WidgetTemplate, 'enabled' | 'status' | 'sort_order' | 'name' | 'description'>>,
): Promise<WidgetTemplate> {
  const json = await authedFetch(`/api/admin/widget/templates/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return json.template as WidgetTemplate;
}