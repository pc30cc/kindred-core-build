/**
 * Public Knowledge Base API client (SPA-side).
 * Hits the same endpoints used by the widget so the SSR + SPA paths stay
 * in sync. Workspace is resolved server-side from the request Host header.
 */
import { API_BASE } from './api';

export interface KbCategory {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  icon?: string | null;
  sort_order?: number | null;
}

export interface KbArticleSummary {
  title: string;
  slug: string;
  excerpt?: string | null;
}

export interface KbArticle extends KbArticleSummary {
  id: string;
  content: string;
  locale: string;
  updated_at: string | null;
  category_id?: string | null;
}

export interface KbSearchResult {
  title: string;
  slug: string;
  excerpt?: string | null;
  score?: number;
}

function workspaceIdFromMeta(): string | null {
  // The SSR public KB pages do not embed workspace_id. The widget endpoints
  // require it explicitly. SPA navigations on /help/:locale/... only happen
  // *after* an SSR-rendered first paint where the workspace is already
  // bound to the host. We expose the resolved workspace_id via a small
  // public bootstrap endpoint that uses the same host→workspace mapping.
  // Here we read it from a meta tag the SSR layer (or a follow-up patch)
  // can emit; if absent we fall back to a network lookup.
  if (typeof document === 'undefined') return null;
  const m = document.querySelector('meta[name="x-workspace-id"]');
  return m?.getAttribute('content') || null;
}

let cachedWorkspaceId: string | null = null;
let cachedWorkspaceLookup: Promise<string | null> | null = null;

async function resolveWorkspaceId(): Promise<string | null> {
  if (cachedWorkspaceId) return cachedWorkspaceId;
  const fromMeta = workspaceIdFromMeta();
  if (fromMeta) { cachedWorkspaceId = fromMeta; return fromMeta; }
  if (cachedWorkspaceLookup) return cachedWorkspaceLookup;
  cachedWorkspaceLookup = (async () => {
    try {
      // Lightweight host→workspace probe; returns 404 if host is not bound.
      const r = await fetch(`${API_BASE}/api/widget/help-host`, { credentials: 'include' });
      if (!r.ok) return null;
      const data = await r.json();
      cachedWorkspaceId = data?.workspace_id || null;
      return cachedWorkspaceId;
    } catch {
      return null;
    }
  })();
  return cachedWorkspaceLookup;
}

function buildUrl(path: string, params: Record<string, string | number>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') sp.set(k, String(v));
  }
  return `${API_BASE}${path}?${sp.toString()}`;
}

export async function fetchKbCategories(locale: string): Promise<KbCategory[]> {
  const workspace_id = await resolveWorkspaceId();
  if (!workspace_id) return [];
  const r = await fetch(buildUrl('/api/widget/kb/categories', { workspace_id, locale }), {
    credentials: 'include',
  });
  if (!r.ok) return [];
  const data = await r.json();
  return data.categories || [];
}

export async function fetchKbArticle(locale: string, slug: string): Promise<KbArticle | null> {
  const workspace_id = await resolveWorkspaceId();
  if (!workspace_id) return null;
  const r = await fetch(buildUrl('/api/widget/kb/article', { workspace_id, locale, slug }), {
    credentials: 'include',
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.article || null;
}

export async function searchKbArticles(
  locale: string,
  query: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<KbSearchResult[]> {
  if (!query.trim()) return [];
  const workspace_id = await resolveWorkspaceId();
  if (!workspace_id) return [];
  const r = await fetch(
    buildUrl('/api/widget/kb/search', { workspace_id, locale, q: query, limit }),
    { credentials: 'include', signal },
  );
  if (!r.ok) return [];
  const data = await r.json();
  return data.results || [];
}