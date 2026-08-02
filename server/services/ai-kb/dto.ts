/**
 * Phase 6-S5-R5 — explicit public DTOs for every customer-facing AI KB read.
 *
 * Database rows are NEVER spread into responses. Each mapper below is the
 * single place where a field becomes visible to a client, so anything added to
 * the schema later is redacted by default.
 *
 * Permanently excluded from every public DTO:
 *   raw error_message / stack traces, provider request or response payloads,
 *   internal worker metadata, worker ids, claim/lease bookkeeping,
 *   authorization data, credentials, service-role information, private
 *   provider URLs, full plan_snapshot, raw retry payloads, debug context.
 */

// ─── Canonical public error codes ──────────────────────────────
export type AiKbPublicErrorCode =
  | 'crawl_failed'
  | 'generation_failed'
  | 'publish_failed'
  | 'provider_unavailable'
  | 'job_failed';

/**
 * Maps an internal failure (raw text or status) onto a stable public code.
 * Returns null when there is nothing to report. Never echoes input text.
 */
export function toPublicErrorCode(
  internal: { status?: string | null; errorMessage?: string | null },
): AiKbPublicErrorCode | null {
  const raw = (internal.errorMessage || '').toLowerCase();
  if (!raw && internal.status !== 'failed') return null;
  if (/crawl|fetch|robots|dns|http/.test(raw)) return 'crawl_failed';
  if (/generat|model|prompt|token/.test(raw)) return 'generation_failed';
  if (/publish|article/.test(raw)) return 'publish_failed';
  if (/provider|unavailable|timeout|rate.?limit|quota/.test(raw)) return 'provider_unavailable';
  return internal.status === 'failed' || raw ? 'job_failed' : null;
}

// ─── Row shapes (internal, as stored) ──────────────────────────
export interface AiKbJobRowLike {
  id: string; workspace_id: string; status: string;
  source_kind: string | null; source_domain: string | null; locale: string | null;
  progress: number | null;
  pages_discovered: number | null; pages_crawled: number | null;
  pages_failed: number | null; articles_generated: number | null;
  error_message?: string | null;
  created_at: string; updated_at: string; completed_at: string | null;
}

export interface AiKbPageRowLike {
  id: string; job_id: string; url: string | null; title: string | null;
  status: string; depth: number | null; http_status: number | null;
  error_message?: string | null; fetched_at: string | null; created_at: string;
}

export interface AiKbGeneratedRowLike {
  id: string; job_id: string; title: string; slug: string | null;
  excerpt: string | null; locale: string; status: string;
  kb_article_id: string | null; suggested_category?: string | null;
  confidence?: number | null; created_at: string; updated_at: string;
}

export interface AiKbJobEventRowLike {
  id: string; job_id: string; level: string | null; message?: string | null;
  created_at: string;
}

// ─── Public DTOs ───────────────────────────────────────────────
export interface AiKbJobPublicDto {
  id: string;
  workspace_id: string;
  status: string;
  source_kind: string | null;
  source_domain: string | null;
  locale: string | null;
  progress: number;
  total_pages: number | null;
  processed_pages: number | null;
  failed_pages: number | null;
  generated_articles: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error_code: AiKbPublicErrorCode | null;
}

export interface AiKbPagePublicDto {
  id: string;
  job_id: string;
  url: string | null;
  title: string | null;
  status: string;
  depth: number | null;
  http_status: number | null;
  fetched_at: string | null;
  created_at: string;
  error_code: AiKbPublicErrorCode | null;
}

export interface AiKbGeneratedArticlePublicDto {
  id: string;
  job_id: string;
  title: string;
  slug: string | null;
  excerpt: string | null;
  locale: string;
  status: string;
  kb_article_id: string | null;
  suggested_category: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

export interface AiKbJobEventPublicDto {
  id: string;
  job_id: string;
  event_type: string;
  status: string | null;
  created_at: string;
  error_code: AiKbPublicErrorCode | null;
}

// ─── Explicit column lists for the queries ─────────────────────
export const AI_KB_JOB_COLUMNS =
  'id, workspace_id, status, source_kind, source_domain, locale, progress, ' +
  'pages_discovered, pages_crawled, pages_failed, articles_generated, ' +
  'error_message, created_at, updated_at, completed_at';
export const AI_KB_PAGE_COLUMNS =
  'id, job_id, url, title, status, depth, http_status, error_message, fetched_at, created_at';
export const AI_KB_GENERATED_COLUMNS =
  'id, job_id, workspace_id, title, slug, excerpt, locale, status, kb_article_id, ' +
  'suggested_category, confidence, created_at, updated_at';
export const AI_KB_EVENT_COLUMNS = 'id, job_id, level, created_at';
/**
 * Phase 6-S5-R7 — SERVER-INTERNAL column list for draft mutation paths
 * (accept / publish / publish-all). It adds `content_md`, which the public
 * DTO deliberately withholds, so it must never be returned to a client
 * unmapped. Use `AI_KB_GENERATED_COLUMNS` for anything that is serialized.
 */
export const AI_KB_GENERATED_INTERNAL_COLUMNS =
  'id, job_id, workspace_id, title, slug, excerpt, locale, status, kb_article_id, content_md';

// ─── Mappers ───────────────────────────────────────────────────
export function toPublicAiKbJob(row: AiKbJobRowLike): AiKbJobPublicDto {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    status: row.status,
    source_kind: row.source_kind ?? null,
    source_domain: row.source_domain ?? null,
    locale: row.locale ?? null,
    progress: typeof row.progress === 'number' ? row.progress : 0,
    total_pages: row.pages_discovered ?? null,
    processed_pages: row.pages_crawled ?? null,
    failed_pages: row.pages_failed ?? null,
    generated_articles: row.articles_generated ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null,
    error_code: toPublicErrorCode({ status: row.status, errorMessage: row.error_message ?? null }),
  };
}

export function toPublicAiKbPage(row: AiKbPageRowLike): AiKbPagePublicDto {
  return {
    id: row.id,
    job_id: row.job_id,
    url: row.url ?? null,
    title: row.title ?? null,
    status: row.status,
    depth: row.depth ?? null,
    http_status: row.http_status ?? null,
    fetched_at: row.fetched_at ?? null,
    created_at: row.created_at,
    error_code: toPublicErrorCode({ status: row.status, errorMessage: row.error_message ?? null }),
  };
}

export function toPublicAiKbGenerated(
  row: AiKbGeneratedRowLike,
): AiKbGeneratedArticlePublicDto {
  return {
    id: row.id,
    job_id: row.job_id,
    title: row.title,
    slug: row.slug ?? null,
    excerpt: row.excerpt ?? null,
    locale: row.locale,
    status: row.status,
    kb_article_id: row.kb_article_id ?? null,
    suggested_category: row.suggested_category ?? null,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Job events carry free-form operator log text (`message`) that can contain
 * provider payloads, so it is dropped entirely; only the level and a mapped
 * error code survive.
 */
export function toPublicAiKbJobEvent(row: AiKbJobEventRowLike): AiKbJobEventPublicDto {
  const level = row.level || 'info';
  return {
    id: row.id,
    job_id: row.job_id,
    event_type: level,
    status: level === 'error' ? 'error' : 'ok',
    created_at: row.created_at,
    error_code: level === 'error' ? 'job_failed' : null,
  };
}
