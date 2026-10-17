/**
 * The chat widget template catalog in the dashboard
 * (shared/chatTemplateCatalog.ts).
 *
 *   - Super Admin → Widget settings → Widget templates:
 *     GET / PUT /api/admin/widget-catalog (the running edition's catalog).
 *   - Widget → Appearance → Widget template:
 *     GET /api/widget-settings/:workspaceId/templates (the enabled templates,
 *     the workspace's choice, what its visitors wear). The choice itself is
 *     saved through the ordinary widget settings PATCH.
 *
 * A failed request keeps the server's `code` (`migration_required`) and
 * `error`, so a page can explain it in the dashboard's language. A backend
 * from before the catalog answers the workspace read with 404: the page then
 * shows no picker (the query does not retry).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '@/lib/api';
import type { Edition } from '../../shared/edition';
import {
  resolveChatTemplateCatalog,
  resolveChatTemplateOptions,
  resolveWorkspaceChatTemplate,
  type ChatTemplateCatalog,
  type ChatTemplateCatalogInput,
  type ChatTemplateNames,
  type ChatTemplateOptions,
} from '../../shared/chatTemplateCatalog';
import type { ChatWidgetTemplateId } from '../../shared/widgetTemplates';

/** A failed catalog request, with the server's `code` when it gave one. */
export class WidgetCatalogError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function catalogFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new WidgetCatalogError(body.error || `Request failed: ${res.status}`, res.status, body.code || body.error);
  return body as T;
}

// ─── Super Admin ───────────────────────────────────────────────────────────

export interface AdminWidgetCatalogTemplate {
  id: ChatWidgetTemplateId;
  enabled: boolean;
  order: number;
  name: ChatTemplateNames;
  options: ChatTemplateOptions;
  /** null before migration 275 (no counts). */
  chosenBy: number | null;
}

export interface AdminWidgetCatalog {
  edition: Edition;
  /** False before migration 275: the page shows the built-in defaults, read only. */
  ready: boolean;
  defaultId: ChatWidgetTemplateId;
  templates: AdminWidgetCatalogTemplate[];
  followingDefault: number | null;
  limits: { nameMax: number; orderMax: number };
  updatedAt: string | null;
  updatedBy: string | null;
}

export const ADMIN_WIDGET_CATALOG_QUERY_KEY = ['admin', 'widget-catalog'] as const;

export function useAdminWidgetCatalog() {
  return useQuery({
    queryKey: ADMIN_WIDGET_CATALOG_QUERY_KEY,
    queryFn: () => catalogFetch<AdminWidgetCatalog>('/api/admin/widget-catalog'),
  });
}

export function useSaveAdminWidgetCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChatTemplateCatalogInput) =>
      catalogFetch<AdminWidgetCatalog>('/api/admin/widget-catalog', { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: (data) => {
      qc.setQueryData(ADMIN_WIDGET_CATALOG_QUERY_KEY, data);
      // Every workspace's picker reads the catalog.
      qc.invalidateQueries({ queryKey: ['widget-catalog'] });
    },
  });
}

// ─── Workspace ─────────────────────────────────────────────────────────────

export interface WorkspaceWidgetCatalogTemplate {
  id: ChatWidgetTemplateId;
  /** The Super Admin's name in the asked language; null = the dashboard's default name. */
  name: string | null;
  isDefault: boolean;
  /** The template's option defaults (the Super Admin's over the code's). */
  options: ChatTemplateOptions;
}

export interface WorkspaceWidgetCatalog {
  edition: Edition;
  ready: boolean;
  defaultId: ChatWidgetTemplateId;
  /** The enabled templates, in the Super Admin's order. */
  templates: WorkspaceWidgetCatalogTemplate[];
  selectedId: string | null;
  selectedOptions: ChatTemplateOptions;
  /** The stored choice is disabled (or gone): visitors get the default. */
  selectedUnavailable: boolean;
  effectiveId: ChatWidgetTemplateId;
  effectiveOptions: ChatTemplateOptions;
  planAllowsChoice: boolean;
  /** Two or more templates enabled, migration 275 applied, and the plan allows it. */
  canChoose: boolean;
}

export function useWorkspaceWidgetCatalog(workspaceId: string | undefined, locale: string) {
  return useQuery({
    queryKey: ['widget-catalog', workspaceId, locale],
    queryFn: () =>
      catalogFetch<WorkspaceWidgetCatalog>(`/api/widget-settings/${workspaceId}/templates?locale=${encodeURIComponent(locale)}`),
    enabled: !!workspaceId,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * Whether Widget → Appearance shows the template card: the catalog answered
 * (a backend without it answers 404), migration 275 is applied, and two or
 * more templates are enabled. A plan without widget_appearance still sees the
 * card, disabled, with the upgrade hint.
 */
export function templatePickerVisible(view: WorkspaceWidgetCatalog | undefined): view is WorkspaceWidgetCatalog {
  return !!view && view.ready && view.templates.length >= 2;
}

/** The workspace view's enabled templates as a catalog the shared resolvers read. */
export function workspaceTemplateCatalog(view: WorkspaceWidgetCatalog): ChatTemplateCatalog {
  return {
    edition: view.edition,
    defaultId: view.defaultId,
    entries: view.templates.map((t, order) => ({ id: t.id, enabled: true, order, name: {}, options: t.options })),
  };
}

/**
 * What the workspace's visitors would wear with the page's current draft:
 * the drafted choice while enabled and while the plan allows it, else the
 * default; and the merged options. Without the catalog view (loading, an
 * older backend, an error) the edition's default with no options, exactly as
 * the widget does without a catalog — never a stored id the visitor may not
 * get.
 */
export function effectiveWorkspaceTemplate(
  view: WorkspaceWidgetCatalog | undefined,
  edition: Edition,
  draftId: unknown,
  draftOptions: unknown,
  planAllows: boolean,
): { id: ChatWidgetTemplateId; options: ChatTemplateOptions } {
  const catalog = view ? workspaceTemplateCatalog(view) : resolveChatTemplateCatalog(edition, null);
  const allowed = planAllows && (view ? view.planAllowsChoice : true);
  const id = resolveWorkspaceChatTemplate(catalog, view ? draftId : null, allowed);
  return { id, options: resolveChatTemplateOptions(catalog, id, allowed ? draftOptions : {}) };
}
