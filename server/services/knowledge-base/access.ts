/**
 * Phase 6-S5-R1 — Knowledge Base authorization helpers.
 *
 * Knowledge Base is an INDEPENDENT product. Access depends on the
 * `knowledge_base` module ONLY — never on AI Agent platform toggles,
 * the `ai_assistant` module, or AI provider availability.
 *
 * Authorization order for every private read/write:
 *   authentication → workspace resolution → membership →
 *   existing KB role permission → knowledge_base module → resource
 *   workspace-ownership validation → database operation
 */
import type { ServerConfig } from '../../config.js';
import { checkModuleAccess } from '../../middleware/featureGating.js';

export interface KnowledgeBasePlanDenial {
  error: 'knowledge_base_plan_required';
  module: 'knowledge_base';
  plan: string | null;
  upgrade_required: true;
}

/**
 * Fail-closed `knowledge_base` module check. Returns null when allowed,
 * otherwise the canonical denial body (never a raw RPC/DB error).
 */
export async function checkKnowledgeBaseModule(
  config: ServerConfig,
  workspaceId: string,
): Promise<KnowledgeBasePlanDenial | null> {
  let allowed = false;
  let plan: string | null = null;
  try {
    const r = await checkModuleAccess(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      'knowledge_base',
    );
    allowed = r.allowed === true;
    plan = (r.plan as string | undefined) ?? null;
  } catch {
    allowed = false;
  }
  if (allowed) return null;
  return {
    error: 'knowledge_base_plan_required',
    module: 'knowledge_base',
    plan,
    upgrade_required: true,
  };
}

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
