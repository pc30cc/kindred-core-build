/**
 * Phase 6-S5-R4 — Knowledge Base authorization helpers.
 *
 * Knowledge Base is a CORE product and is ALWAYS available. There is NO
 * `knowledge_base` module/feature entitlement check anywhere in the KB path —
 * not in Express, not in RLS, not in the UI. It also never depends on AI Agent
 * platform toggles, the `ai_assistant` module, or AI provider availability.
 *
 * Authorization order for every private read/write:
 *   authentication → workspace resolution → membership →
 *   KB role permission → resource workspace-ownership validation →
 *   database operation
 *
 * The former `checkKnowledgeBaseModule()` helper and the
 * `knowledge_base_plan_required` denial were REMOVED on purpose. Do not
 * reintroduce them.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type ArticleStatus = 'draft' | 'published' | 'archived';

export interface KnowledgeBaseArticleInput {
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  locale: string;
  status: ArticleStatus;
  category_id: string | null;
  visible_in_widget: boolean;
}

export interface KnowledgeBaseArticleRecord extends KnowledgeBaseArticleInput {
  id: string;
  workspace_id: string;
  used_by_ai: boolean;
  created_at: string;
  updated_at: string;
}

// ─── Granular KB permissions ────────────────────────────────

export type KnowledgeBasePermission =
  | 'can_manage_knowledge_base'
  | 'can_publish_knowledge_base';

export interface KnowledgeBasePermissionDenial {
  error: 'knowledge_base_permission_denied';
  permission: KnowledgeBasePermission;
}

/**
 * Phase 6-S5-R7.2 — permission evaluation outcome.
 *
 * `unavailable` means the permission RPC itself could not be evaluated. It is
 * deliberately distinct from `denied`: the caller must surface a retryable
 * 503 rather than telling the user they lack a permission they may well have.
 */
export type KnowledgeBasePermissionOutcome = 'granted' | 'denied' | 'unavailable';

export async function checkKnowledgeBasePermissionDetailed(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  permission: KnowledgeBasePermission,
): Promise<KnowledgeBasePermissionOutcome> {
  try {
    const { data, error } = await getServiceClient(config).rpc('has_workspace_permission', {
      _workspace_id: workspaceId,
      _user_id: userId,
      _permission_key: permission,
    });
    if (error) return 'unavailable';
    return data === true ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * Fail-closed granular permission check backed by
 * `public.has_workspace_permission` (role_permissions override + role default).
 * Returns null when allowed, otherwise the canonical denial body.
 */
export async function checkKnowledgeBasePermission(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  permission: KnowledgeBasePermission,
): Promise<KnowledgeBasePermissionDenial | null> {
  let granted = false;
  try {
    const { data, error } = await getServiceClient(config).rpc('has_workspace_permission', {
      _workspace_id: workspaceId,
      _user_id: userId,
      _permission_key: permission,
    });
    granted = !error && data === true;
  } catch {
    granted = false;
  }
  if (granted) return null;
  return { error: 'knowledge_base_permission_denied', permission };
}
