/**
 * AI Agent — shared retrieval source policy (Follow-up 6B).
 *
 * Pure, IO-free extraction of the source-eligibility logic that was
 * previously implemented independently (and identically, by comment-only
 * convention) in both server/services/ai-agent/retrievalHybrid.ts and
 * server/services/ai-agent/sourceHealth.ts.
 *
 * Scope is intentionally narrow:
 *   - web_page parent-source-id derivation (was a byte-identical copy in
 *     both files).
 *   - the per-source-type "is this allowed at all" predicate (workspace +
 *     status/enabled/used_by_ai/approved), i.e. the SAME underlying policy
 *     question retrieval's defense-in-depth re-check and Source Health's
 *     eligibility decision both already answered independently.
 *
 * Explicitly NOT in scope (still owned by the two call sites):
 *   - chunk/embedding "health" (active_chunks_count, embedded_chunks_count)
 *   - excluded-summary counters and cross-workspace attribution bookkeeping
 *   - HealthReason vocabulary / observability labels
 *   - any DB querying — every function here takes already-loaded row data.
 *
 * No Supabase, no ServerConfig, no IO. Pure functions only.
 */

export interface QnaEligibilityRow {
  workspace_id: string;
  enabled: boolean;
}

export interface KbArticleEligibilityRow {
  workspace_id: string;
  status: string;
  used_by_ai?: boolean | null;
}

export interface LearnedQnaEligibilityRow {
  workspace_id: string;
  status: string;
}

export interface DataSourceEligibilityRow {
  workspace_id: string;
  status: string;
  source_type: string;
}

/** ai_agent_qna: workspace-scoped and enabled. */
export function isQnaSourceAllowed(row: QnaEligibilityRow, workspaceId: string): boolean {
  return row.workspace_id === workspaceId && row.enabled === true;
}

/** knowledge_base_articles: workspace-scoped, published, and not opted out of AI use. */
export function isKbArticleSourceAllowed(row: KbArticleEligibilityRow, workspaceId: string): boolean {
  return row.workspace_id === workspaceId && row.status === 'published' && row.used_by_ai !== false;
}

/** ai_agent_learning_candidates: workspace-scoped and approved. */
export function isLearnedQnaSourceAllowed(row: LearnedQnaEligibilityRow, workspaceId: string): boolean {
  return row.workspace_id === workspaceId && row.status === 'approved';
}

/** ai_data_sources (source_type='file'): workspace-scoped, active, and actually a file row. */
export function isFileSourceAllowed(row: DataSourceEligibilityRow, workspaceId: string): boolean {
  return row.workspace_id === workspaceId && row.status === 'active' && row.source_type === 'file';
}

/** ai_data_sources (source_type='website'), the parent row for web_page chunks. */
export function isWebsiteSourceAllowed(row: DataSourceEligibilityRow, workspaceId: string): boolean {
  return row.workspace_id === workspaceId && row.status === 'active' && row.source_type === 'website';
}

/**
 * Derive the parent ai_data_sources id for a web_page chunk. web_page chunks
 * are not directly rows in ai_data_sources -- their source_id is either a
 * compound "${parentId}:${urlHash}" string or carries the parent id in
 * chunk metadata. Mechanical extraction only: no canonicalization, no UUID
 * validation, no reinterpretation of malformed ids.
 */
export function deriveWebPageParentSourceId(sourceId: string, metadata: unknown): string {
  const m = (metadata && typeof metadata === 'object') ? (metadata as Record<string, unknown>) : {};
  const fromMeta = (m.parent_source_id as string) || (m.source_id as string);
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();
  if (sourceId && sourceId.includes(':')) return sourceId.split(':', 2)[0];
  return sourceId;
}
