/**
 * AI Agent — Source Health service (E5-Final).
 *
 * Self-host. Computes per-source eligibility for runtime retrieval.
 * Workspace-scoped. NEVER exposes storage_path/storage_url/signed_url/credentials.
 * For files, source_url is always null.
 *
 * NOTE: the underlying per-source-type allow/deny policy (workspace +
 * enabled/status/used_by_ai/approved) is shared with runtime retrieval via
 * ./sourcePolicy.ts — see that file for the single source of truth. The
 * chunk/embedding health layer below (active_chunks_count,
 * embedded_chunks_count) is Source-Health-specific and intentionally NOT
 * part of runtime retrieval's actual eligibility (see the module doc
 * there): a source can be status-allowed but still reported not-eligible
 * here if it isn't indexed/embedded yet.
 * Eligibility reasons here mirror retrievalHybrid excluded counters:
 *   disabled_qna ↔ disabled_qna_excluded
 *   draft_kb ↔ draft_kb_excluded
 *   file_not_active ↔ inactive_file_excluded
 *   website_not_active ↔ inactive_web_page_excluded
 *   candidate_not_approved ↔ unapproved_learned_qna_excluded
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  deriveWebPageParentSourceId,
  isQnaSourceAllowed,
  isLearnedQnaSourceAllowed,
  isFileSourceAllowed,
  isWebsiteSourceAllowed,
} from './sourcePolicy.js';

export type HealthSourceType = 'qna' | 'learned_qna' | 'kb_article' | 'file' | 'website' | 'web_page';

export type HealthReason =
  | 'eligible'
  | 'no_active_chunks'
  | 'disabled_qna'
  | 'candidate_not_approved'
  | 'draft_kb'
  | 'kb_disabled_for_ai'
  | 'file_not_active'
  | 'website_not_active'
  | 'source_missing'
  | 'embedding_missing'
  | 'unknown';

export interface SourceHealthItem {
  source_type: HealthSourceType;
  source_id: string;
  title: string;
  status: string | null;
  eligible: boolean;
  reason: HealthReason;
  active_chunks_count: number;
  embedded_chunks_count: number;
  stale_chunks_count: number;
  deleted_chunks_count: number;
  last_indexed_at: string | null;
  last_error: string | null;
  last_warning: string | null;
  metadata_summary: Record<string, unknown>;
}

export interface SourceHealthSummary {
  total: number;
  eligible: number;
  not_eligible: number;
  qna_enabled: number;
  qna_disabled: number;
  learned_qna_approved: number;
  learned_qna_unapproved: number;
  kb_published: number;
  kb_draft: number;
  files_active: number;
  files_not_active: number;
  websites_active: number;
  websites_not_active: number;
  web_pages_eligible: number;
  web_pages_not_eligible: number;
  active_chunks_total: number;
  embedded_chunks_total: number;
}

export interface SourceHealthResponse {
  items: SourceHealthItem[];
  summary: SourceHealthSummary;
}

export interface SourceHealthFilters {
  sourceType?: HealthSourceType;
  eligible?: boolean;
  query?: string;
  limit?: number;
}

// Sanitizer key blocklist — substrings (lowercased) that mark a sensitive field.
const SENSITIVE_META_KEYS = [
  'storage_path', 'storagepath', 'storage_url', 'storageurl',
  'signed_url', 'signedurl', 'public_url', 'publicurl',
  'token', 'secret', 'password', 'credential', 'credentials',
  'api_key', 'apikey', 'access_key', 'accesskey',
  'authorization', 'signature', 'bucket',
];
const URL_LIKE_KEY_HINTS = ['storage', 'signed', 'public'];

function isSensitiveKey(lk: string): boolean {
  return SENSITIVE_META_KEYS.some((p) => lk.includes(p));
}
function isStorageishUrlKey(lk: string): boolean {
  return lk.endsWith('_url') && URL_LIKE_KEY_HINTS.some((h) => lk.includes(h));
}
function sanitizeMetaDeep(value: any, depth = 0): any {
  if (depth > 8) return undefined;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const arr: any[] = [];
    for (const v of value) {
      const s = sanitizeMetaDeep(v, depth + 1);
      if (s !== undefined) arr.push(s);
    }
    return arr;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const lk = k.toLowerCase();
      if (isSensitiveKey(lk)) continue;
      if (isStorageishUrlKey(lk)) continue;
      const s = sanitizeMetaDeep(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return value;
}
function sanitizeMeta(meta: any): Record<string, unknown> {
  const s = sanitizeMetaDeep(meta);
  return (s && typeof s === 'object' && !Array.isArray(s)) ? s as Record<string, unknown> : {};
}
// File metadata must never expose any URL/path-like field.
function sanitizeFileMeta(meta: any): Record<string, unknown> {
  const base = sanitizeMeta(meta);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) {
    const lk = k.toLowerCase();
    if (lk.includes('url') || lk.includes('path')) continue;
    out[k] = v;
  }
  return out;
}

function matchesQuery(title: string | null | undefined, q: string): boolean {
  if (!q) return true;
  return (title || '').toLowerCase().includes(q.toLowerCase());
}

export async function getSourceHealth(
  config: ServerConfig,
  workspaceId: string,
  filters: SourceHealthFilters = {},
): Promise<SourceHealthResponse> {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(filters.limit || 200, 1), 500);
  const q = (filters.query || '').trim();

  // ── Aggregate chunk counts per (source_type, source_id) ────────────────
  // status: active / stale / deleted / inactive (legacy)
  type ChunkAgg = {
    active: number; stale: number; deleted: number;
    embedded: number; lastIndexedAt: string | null;
    // Web-page extras (only populated for source_type='web_page')
    title?: string | null;
    pageUrl?: string | null;
    locale?: string | null;
    parentId?: string | null;
  };
  const chunkMap = new Map<string, ChunkAgg>();
  const key = (t: string, id: string) => `${t}:${id}`;
  const deriveWebPageParent = deriveWebPageParentSourceId;
  // Pull chunks page-by-page (Supabase 1000-row default)
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb
      .from('ai_knowledge_chunks')
      .select('source_type, source_id, status, embedding, updated_at, metadata, title, source_url')
      .eq('workspace_id', workspaceId)
      .range(from, from + PAGE - 1);
    if (error) break;
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      const t = r.source_type as string;
      const sid = r.source_id as string;
      if (!t || !sid) continue;
      const k = key(t, sid);
      let agg = chunkMap.get(k);
      if (!agg) {
        agg = { active: 0, stale: 0, deleted: 0, embedded: 0, lastIndexedAt: null };
        chunkMap.set(k, agg);
      }
      const status = String(r.status || '').toLowerCase();
      if (status === 'active') agg.active += 1;
      else if (status === 'stale') agg.stale += 1;
      else if (status === 'deleted') agg.deleted += 1;
      if (r.embedding) agg.embedded += 1;
      const ts = (r.updated_at) as string | null;
      if (ts && (!agg.lastIndexedAt || ts > agg.lastIndexedAt)) agg.lastIndexedAt = ts;
      if (t === 'web_page') {
        const meta = r.metadata || {};
        if (!agg.parentId) agg.parentId = deriveWebPageParent(sid, meta);
        if (!agg.title) agg.title = (r.title as string) || (meta.page_title as string) || (meta.title as string) || null;
        if (!agg.pageUrl) {
          // Page URL is a normal http(s) URL; safe to expose for web pages only.
          const candidate = (meta.page_url as string) || (meta.url as string) || (typeof r.source_url === 'string' ? r.source_url : null);
          if (candidate && /^https?:\/\//i.test(candidate)) agg.pageUrl = candidate;
        }
        if (!agg.locale) agg.locale = (meta.locale as string) || null;
      }
    }
    if (data.length < PAGE) break;
    from += PAGE;
    if (from > 50_000) break; // safety guard
  }

  // Roll-up website parent counts from web_page chunks (using derived parent id).
  const websiteRollup = new Map<string, ChunkAgg>();
  for (const [k, agg] of chunkMap.entries()) {
    if (!k.startsWith('web_page:')) continue;
    const parent = agg.parentId || k.slice('web_page:'.length);
    let r = websiteRollup.get(parent);
    if (!r) { r = { active: 0, stale: 0, deleted: 0, embedded: 0, lastIndexedAt: null }; websiteRollup.set(parent, r); }
    r.active += agg.active;
    r.stale += agg.stale;
    r.deleted += agg.deleted;
    r.embedded += agg.embedded;
    if (agg.lastIndexedAt && (!r.lastIndexedAt || agg.lastIndexedAt > r.lastIndexedAt)) r.lastIndexedAt = agg.lastIndexedAt;
  }

  const items: SourceHealthItem[] = [];

  // ── Q&A ────────────────────────────────────────────────────────────────
  if (!filters.sourceType || filters.sourceType === 'qna') {
    const { data } = await sb
      .from('ai_agent_qna')
      .select('id, question, enabled, locale, updated_at')
      .eq('workspace_id', workspaceId)
      .limit(limit);
    for (const r of (data || []) as any[]) {
      if (!matchesQuery(r.question, q)) continue;
      const agg = chunkMap.get(key('qna', r.id)) || { active: 0, stale: 0, deleted: 0, embedded: 0, lastIndexedAt: null };
      const allowed = isQnaSourceAllowed({ workspace_id: workspaceId, enabled: r.enabled }, workspaceId);
      let reason: HealthReason = 'eligible';
      if (!allowed) reason = 'disabled_qna';
      else if (agg.active === 0) reason = 'no_active_chunks';
      else if (agg.embedded === 0) reason = 'embedding_missing';
      items.push({
        source_type: 'qna', source_id: r.id, title: r.question || '(untitled Q&A)',
        status: allowed ? 'enabled' : 'disabled',
        eligible: reason === 'eligible',
        reason,
        active_chunks_count: agg.active, embedded_chunks_count: agg.embedded,
        stale_chunks_count: agg.stale, deleted_chunks_count: agg.deleted,
        last_indexed_at: agg.lastIndexedAt, last_error: null, last_warning: null,
        metadata_summary: { locale: r.locale || 'en', updated_at: r.updated_at || null },
      });
    }
  }

  // ── Learned Q&A ────────────────────────────────────────────────────────
  if (!filters.sourceType || filters.sourceType === 'learned_qna') {
    const { data } = await sb
      .from('ai_agent_learning_candidates')
      .select('id, question_text, suggested_title, normalized_question, status, locale, updated_at')
      .eq('workspace_id', workspaceId)
      .limit(limit);
    for (const r of (data || []) as any[]) {
      const title = r.suggested_title || r.question_text || r.normalized_question || '(learned answer)';
      if (!matchesQuery(title, q)) continue;
      const agg = chunkMap.get(key('learned_qna', r.id)) || { active: 0, stale: 0, deleted: 0, embedded: 0, lastIndexedAt: null };
      const approved = isLearnedQnaSourceAllowed({ workspace_id: workspaceId, status: r.status }, workspaceId);
      let reason: HealthReason = 'eligible';
      if (!approved) reason = 'candidate_not_approved';
      else if (agg.active === 0) reason = 'no_active_chunks';
      else if (agg.embedded === 0) reason = 'embedding_missing';
      items.push({
        source_type: 'learned_qna', source_id: r.id, title,
        status: r.status || null,
        eligible: reason === 'eligible',
        reason,
        active_chunks_count: agg.active, embedded_chunks_count: agg.embedded,
        stale_chunks_count: agg.stale, deleted_chunks_count: agg.deleted,
        last_indexed_at: agg.lastIndexedAt, last_error: null, last_warning: null,
        metadata_summary: { locale: r.locale || 'en', updated_at: r.updated_at || null },
      });
    }
  }

  // ── KB Articles ────────────────────────────────────────────────────────
  if (!filters.sourceType || filters.sourceType === 'kb_article') {
    const { data } = await sb
      .from('knowledge_base_articles')
      .select('id, title, status, locale, slug, updated_at, used_by_ai, visible_in_widget')
      .eq('workspace_id', workspaceId)
      .limit(limit);
    for (const r of (data || []) as any[]) {
      if (!matchesQuery(r.title, q)) continue;
      const agg = chunkMap.get(key('kb_article', r.id)) || { active: 0, stale: 0, deleted: 0, embedded: 0, lastIndexedAt: null };
      const published = String(r.status || '') === 'published';
      const aiEnabled = r.used_by_ai !== false;
      let reason: HealthReason = 'eligible';
      if (!published) reason = 'draft_kb';
      else if (!aiEnabled) reason = 'kb_disabled_for_ai';
      else if (agg.active === 0) reason = 'no_active_chunks';
      else if (agg.embedded === 0) reason = 'embedding_missing';
      items.push({
        source_type: 'kb_article', source_id: r.id, title: r.title || '(untitled)',
        status: r.status || null,
        eligible: reason === 'eligible',
        reason,
        active_chunks_count: agg.active, embedded_chunks_count: agg.embedded,
        stale_chunks_count: agg.stale, deleted_chunks_count: agg.deleted,
        last_indexed_at: agg.lastIndexedAt, last_error: null, last_warning: null,
        metadata_summary: { locale: r.locale || null, slug: r.slug || null, updated_at: r.updated_at || null, used_by_ai: aiEnabled, visible_in_widget: r.visible_in_widget !== false },
      });
    }
  }

  // ── Files & Websites (ai_data_sources) ─────────────────────────────────
  if (!filters.sourceType || filters.sourceType === 'file' || filters.sourceType === 'website' || filters.sourceType === 'web_page') {
    const { data } = await sb
      .from('ai_data_sources')
      .select('id, source_type, status, name, last_synced_at, last_error, metadata')
      .eq('workspace_id', workspaceId)
      .in('source_type', ['file', 'website'])
      .limit(limit);
    const websiteParents = new Map<string, any>();
    for (const r of (data || []) as any[]) {
      const isFile = r.source_type === 'file';
      const isWebsite = r.source_type === 'website';
      if (isWebsite) websiteParents.set(r.id, r);
      const meta = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
      const fileTitle = isFile
        ? (r.name || (meta.original_file_name as string) || '(file)')
        : (r.name || (meta.page_title as string) || (meta.title as string) || '(website)');
      if (!matchesQuery(fileTitle, q)) continue;

      // Skip when filter excludes this row's surfacing as a parent item.
      if (filters.sourceType === 'file' && !isFile) continue;
      if (filters.sourceType === 'website' && !isWebsite) continue;
      if (filters.sourceType === 'web_page') continue; // surfaced individually below

      const safeMeta = isFile ? sanitizeFileMeta(r.metadata) : sanitizeMeta(r.metadata);
      const active = isFile
        ? isFileSourceAllowed({ workspace_id: workspaceId, status: r.status, source_type: r.source_type }, workspaceId)
        : isWebsiteSourceAllowed({ workspace_id: workspaceId, status: r.status, source_type: r.source_type }, workspaceId);

      let agg: ChunkAgg;
      if (isFile) {
        agg = chunkMap.get(key('file', r.id)) || { active: 0, stale: 0, deleted: 0, embedded: 0, lastIndexedAt: null };
      } else {
        agg = websiteRollup.get(r.id) || { active: 0, stale: 0, deleted: 0, embedded: 0, lastIndexedAt: null };
      }

      let reason: HealthReason = 'eligible';
      if (!active) reason = isFile ? 'file_not_active' : 'website_not_active';
      else if (agg.active === 0) reason = 'no_active_chunks';
      else if (agg.embedded === 0) reason = 'embedding_missing';

      items.push({
        source_type: isFile ? 'file' : 'website',
        source_id: r.id,
        title: fileTitle,
        status: r.status || null,
        eligible: reason === 'eligible',
        reason,
        active_chunks_count: agg.active, embedded_chunks_count: agg.embedded,
        stale_chunks_count: agg.stale, deleted_chunks_count: agg.deleted,
        last_indexed_at: r.last_synced_at || agg.lastIndexedAt,
        last_error: r.last_error || null,
        last_warning: null,
        metadata_summary: safeMeta,
      });
    }

    // ── Individual web_page health items ──────────────────────────────────
    if (!filters.sourceType || filters.sourceType === 'web_page') {
      for (const [k, agg] of chunkMap.entries()) {
        if (!k.startsWith('web_page:')) continue;
        const sid = k.slice('web_page:'.length);
        const parentId = agg.parentId || (sid.includes(':') ? sid.split(':', 2)[0] : sid);
        const parent = websiteParents.get(parentId);
        const pageTitle = agg.title || agg.pageUrl || '(web page)';
        if (!matchesQuery(pageTitle, q)) continue;
        const parentActive = parent
          ? isWebsiteSourceAllowed({ workspace_id: workspaceId, status: parent.status, source_type: parent.source_type }, workspaceId)
          : false;
        let reason: HealthReason = 'eligible';
        if (!parent) reason = 'source_missing';
        else if (!parentActive) reason = 'website_not_active';
        else if (agg.active === 0) reason = 'no_active_chunks';
        else if (agg.embedded === 0) reason = 'embedding_missing';
        items.push({
          source_type: 'web_page',
          source_id: sid,
          title: pageTitle,
          status: parent ? (parent.status || null) : null,
          eligible: reason === 'eligible',
          reason,
          active_chunks_count: agg.active,
          embedded_chunks_count: agg.embedded,
          stale_chunks_count: agg.stale,
          deleted_chunks_count: agg.deleted,
          last_indexed_at: agg.lastIndexedAt,
          last_error: parent?.last_error || null,
          last_warning: null,
          metadata_summary: {
            parent_source_id: parentId,
            page_url: agg.pageUrl || null,
            locale: agg.locale || null,
          },
        } as SourceHealthItem & { parent_source_id?: string });
      }
    }
  }

  // Apply eligible filter & query
  const filtered = items.filter((it) => {
    if (typeof filters.eligible === 'boolean' && it.eligible !== filters.eligible) return false;
    return true;
  }).slice(0, limit);

  // Summary
  const summary: SourceHealthSummary = {
    total: filtered.length,
    eligible: 0, not_eligible: 0,
    qna_enabled: 0, qna_disabled: 0,
    learned_qna_approved: 0, learned_qna_unapproved: 0,
    kb_published: 0, kb_draft: 0,
    files_active: 0, files_not_active: 0,
    websites_active: 0, websites_not_active: 0,
    web_pages_eligible: 0, web_pages_not_eligible: 0,
    active_chunks_total: 0, embedded_chunks_total: 0,
  };
  for (const it of filtered) {
    if (it.eligible) summary.eligible += 1; else summary.not_eligible += 1;
    summary.active_chunks_total += it.active_chunks_count;
    summary.embedded_chunks_total += it.embedded_chunks_count;
    if (it.source_type === 'qna') (it.status === 'enabled' ? summary.qna_enabled++ : summary.qna_disabled++);
    else if (it.source_type === 'learned_qna') (it.status === 'approved' ? summary.learned_qna_approved++ : summary.learned_qna_unapproved++);
    else if (it.source_type === 'kb_article') (it.status === 'published' ? summary.kb_published++ : summary.kb_draft++);
    else if (it.source_type === 'file') (it.status === 'active' ? summary.files_active++ : summary.files_not_active++);
    else if (it.source_type === 'website') (it.status === 'active' ? summary.websites_active++ : summary.websites_not_active++);
    else if (it.source_type === 'web_page') (it.eligible ? summary.web_pages_eligible++ : summary.web_pages_not_eligible++);
  }

  return { items: filtered, summary };
}