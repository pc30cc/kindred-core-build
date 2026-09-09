/**
 * Knowledge Base article quota — ONE canonical resolver.
 *
 * The Knowledge Base MODULE stays ungated (core product); only the NUMBER of
 * stored rows in public.knowledge_base_articles is capped. Canonical plan key
 * `max_kb_articles`, legacy fallbacks `ai_kb_max_articles` / `kb_articles`.
 * `-1` or no key at all = unlimited. Occupancy semantics: deleting an article
 * frees capacity.
 *
 * Every path that CREATES an article must go through this helper — the manual
 * editor (POST /api/knowledge-base/articles) AND the AI KB Builder
 * accept/publish/publish-all paths, which previously wrote articles straight
 * through the SQL transaction and so silently exceeded the plan cap.
 *
 * Fail-closed: an unreadable plan or an unreadable count denies (503).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getWorkspacePlanInfoDetailed } from '../../middleware/featureGating.js';

export interface KbQuotaAllow {
  ok: true;
  unlimited: boolean;
  limit: number | null;
  used: number | null;
  remaining: number;
}
export interface KbQuotaDenial {
  ok: false;
  status: 403 | 503;
  body: Record<string, unknown>;
}
export type KbArticleQuota = KbQuotaAllow | KbQuotaDenial;

export async function resolveKbArticleQuota(
  config: ServerConfig,
  workspaceId: string,
): Promise<KbArticleQuota> {
  if (config.selfHostBillingUnlimited === true) return { ok: true, unlimited: true, limit: null, used: null, remaining: Number.POSITIVE_INFINITY };

  const info = await getWorkspacePlanInfoDetailed(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    workspaceId,
  );
  if (!info.ok) {
    return {
      ok: false,
      status: 503,
      body: { error: 'entitlement_status_unavailable', feature: 'max_kb_articles', retryable: true },
    };
  }

  const limits = (info.value.limits || {}) as Record<string, unknown>;
  let limit: number | null = null;
  for (const key of ['max_kb_articles', 'ai_kb_max_articles', 'kb_articles']) {
    const raw = limits[key];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    if (Number.isFinite(n)) { limit = n; break; }
  }
  if (limit === null || limit < 0) return { ok: true, unlimited: true, limit: null, used: null, remaining: Number.POSITIVE_INFINITY };

  const { count, error } = await getServiceClient(config)
    .from('knowledge_base_articles')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);
  if (error || typeof count !== 'number') {
    return {
      ok: false,
      status: 503,
      body: { error: 'usage_status_unavailable', feature: 'max_kb_articles', retryable: true },
    };
  }

  if (count >= limit) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'Limit reached: max_kb_articles',
        feature: 'max_kb_articles',
        plan: info.value.plan?.slug ?? null,
        limit,
        used: count,
        upgrade_required: true,
      },
    };
  }

  return { ok: true, unlimited: false, limit, used: count, remaining: limit - count };
}
