/**
 * Same-domain website crawler for the AI Agent Data Hub.
 *
 * SAFETY:
 *   - Same domain only (host equals workspace registered domain).
 *   - text/html only.
 *   - No JS execution.
 *   - Robots.txt respected unless AI_KB_IGNORE_ROBOTS=1.
 *   - Plan-resolved max_pages / max_depth caps.
 *   - Per-fetch timeout + max body size.
 *   - No external API/MCP/webhook calls of any kind.
 */

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { canonicalize, isPathAllowed, isSameDomain, normalizeHost, urlHash, type PathFilter } from './urlRules.js';
import { safeCrawlFetch } from './safeCrawlFetch.js';
import { extractFromHtml, sha256Hex } from './extractText.js';
import { getRobotsRules, isPathAllowedByRobots } from './robots.js';
import { chunkText } from '../knowledgeIndex/chunker.js';
import { indexSource, getEmbedderForWorkspace } from '../knowledgeIndex/indexer.js';

export interface CrawlOptions {
  workspaceId: string;
  sourceId: string;
  baseUrl: string;
  rootHost: string;            // workspace registered host (no www)
  include: string[];
  exclude: string[];
  maxPages: number;            // already capped by plan resolver
  maxDepth: number;            // already capped by plan resolver
  workerId: string;
  jobId: string | null;
}

export interface CrawlSummary {
  pages_seen: number;
  pages_fetched: number;
  pages_skipped: number;
  pages_failed: number;
  chunks_created: number;
  embeddings_generated: number;
  embedded_chunks: number;
  warnings: string[];
  truncated: boolean;
  errors: string[];
}

const DEFAULT_TIMEOUT_MS = parseInt(process.env.AI_KB_CRAWL_TIMEOUT_MS || '10000', 10);
const MAX_PAGE_BYTES = parseInt(process.env.AI_KB_MAX_PAGE_BYTES || String(2 * 1024 * 1024), 10);
const USER_AGENT = process.env.AI_KB_USER_AGENT || 'AiAgentDataHubBot/1.0 (+self-hosted)';
const MIN_TEXT_LEN = 200;

export async function crawlWebsiteSource(
  config: ServerConfig,
  opts: CrawlOptions,
): Promise<CrawlSummary> {
  const sb = getServiceClient(config);
  const summary: CrawlSummary = {
    pages_seen: 0, pages_fetched: 0, pages_skipped: 0, pages_failed: 0,
    chunks_created: 0, embeddings_generated: 0, embedded_chunks: 0,
    warnings: [], truncated: false, errors: [],
  };

  const filter: PathFilter = { include: opts.include, exclude: opts.exclude };
  const root = canonicalize(opts.baseUrl);
  if (!root.ok || !root.url) {
    summary.errors.push('invalid_base_url');
    return summary;
  }
  const rootHost = normalizeHost(opts.rootHost);
  const robots = await getRobotsRules(root.url, USER_AGENT);

  const seen = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: root.url, depth: 0 }];
  seen.add(root.url);

  const seenSourceIds: string[] = [];
  const embedder = await getEmbedderForWorkspace(config, opts.workspaceId).catch(() => null);

  while (queue.length && summary.pages_fetched < opts.maxPages) {
    const { url, depth } = queue.shift()!;
    summary.pages_seen += 1;

    // Same-domain check (defense in depth)
    if (!isSameDomain(url, rootHost)) {
      summary.pages_skipped += 1;
      await recordPage(sb, opts, url, { status: 'skipped', warning: 'outside_domain_skipped' });
      continue;
    }

    // Path include/exclude
    const pathCheck = isPathAllowed(url, filter);
    if (!pathCheck.allowed) {
      summary.pages_skipped += 1;
      await recordPage(sb, opts, url, { status: 'skipped', warning: pathCheck.reason || 'excluded_path' });
      continue;
    }

    // Robots
    const path = new URL(url).pathname || '/';
    if (!isPathAllowedByRobots(path, robots)) {
      summary.pages_skipped += 1;
      await recordPage(sb, opts, url, { status: 'skipped', warning: 'robots_blocked' });
      continue;
    }

    // Fetch
    const fetched = await fetchPage(url, opts.rootHost);
    if (!fetched.ok || !fetched.html) {
      summary.pages_failed += 1;
      summary.errors.push(`${fetched.error || 'fetch_failed'}: ${url}`);
      await recordPage(sb, opts, url, {
        status: 'failed',
        http_status: fetched.status || null,
        warning: fetched.error || 'fetch_failed',
      });
      continue;
    }

    summary.pages_fetched += 1;
    const ex = extractFromHtml(fetched.html, url);
    const contentHash = sha256Hex(ex.text);
    const lowText = ex.textLength < MIN_TEXT_LEN;
    const warning = lowText ? 'low_text_content_likely_csr' : null;

    // Chunk + index per page (use a stable per-page sourceId so rebuilds are surgical).
    const pageSourceId = `${opts.sourceId}:${urlHash(url)}`;
    seenSourceIds.push(pageSourceId);

    let pageChunks = 0; let pageEmbeds = 0;
    if (!lowText && ex.text.length > 0) {
      const chunks = chunkText(ex.text);
      const r = await indexSource(config, {
        workspaceId: opts.workspaceId,
        sourceType: 'web_page',
        sourceId: pageSourceId,
        title: ex.title || url,
        sourceUrl: url,
        locale: ex.locale,
        chunks,
        metadata: {
          parent_source_id: opts.sourceId,
          page_content_hash: contentHash,
          fetched_at: new Date().toISOString(),
        },
      }, embedder || undefined);
      pageChunks = r.chunksCreated + r.chunksUpdated;
      pageEmbeds = r.embeddingsGenerated;
      summary.chunks_created += r.chunksCreated;
      summary.embeddings_generated += r.embeddingsGenerated;
    } else if (lowText) {
      summary.warnings.push(`low_text_content: ${url}`);
    }

    await recordPage(sb, opts, url, {
      status: 'fetched',
      http_status: fetched.status,
      title: ex.title || null,
      locale: ex.locale,
      text_length: ex.textLength,
      content_hash: contentHash,
      chunks_created: pageChunks,
      embedding_status: pageEmbeds > 0 ? 'embedded' : (embedder ? 'pending' : 'no_embedder'),
      warning,
    });

    // Expand queue if depth allows.
    if (depth < opts.maxDepth) {
      for (const link of ex.links) {
        const c = canonicalize(link, url);
        if (!c.ok || !c.url) continue;
        if (!isSameDomain(c.url, rootHost)) continue;
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        queue.push({ url: c.url, depth: depth + 1 });
      }
    }
  }

  if (queue.length > 0) {
    summary.truncated = true;
    summary.warnings.push('plan_limit_truncated');
  }

  // Mark previously-known pages that we no longer saw as removed (deactivate their chunks).
  await pruneUnseenPages(sb, config, opts, seenSourceIds);

  // Count embedded chunks for this source (active only).
  const { count: embedded } = await sb
    .from('ai_knowledge_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', opts.workspaceId)
    .eq('source_type', 'web_page')
    .like('source_id', `${opts.sourceId}:%`)
    .eq('status', 'active')
    .not('embedding', 'is', null);
  summary.embedded_chunks = embedded || 0;

  return summary;
}

/**
 * Fetch one page through the SSRF-hardened transport: manual redirects,
 * per-hop DNS + same-domain revalidation and a streaming body cap.
 */
async function fetchPage(
  url: string,
  rootHost: string,
): Promise<{ ok: boolean; html?: string; status?: number; error?: string }> {
  const result = await safeCrawlFetch(url, {
    userAgent: USER_AGENT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes: MAX_PAGE_BYTES,
    isUrlAllowed: (candidate) => isSameDomain(candidate, rootHost),
  });
  return { ok: result.ok, html: result.html, status: result.status, error: result.error };
}

async function recordPage(
  sb: ReturnType<typeof getServiceClient>,
  opts: CrawlOptions,
  url: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await sb.from('ai_source_pages').upsert({
    workspace_id: opts.workspaceId,
    source_id: opts.sourceId,
    url,
    url_hash: urlHash(url),
    last_seen_at: new Date().toISOString(),
    ...patch,
  }, { onConflict: 'source_id,url_hash' });
}

async function pruneUnseenPages(
  sb: ReturnType<typeof getServiceClient>,
  config: ServerConfig,
  opts: CrawlOptions,
  seenSourceIds: string[],
): Promise<void> {
  // Deactivate chunks belonging to web_page rows that share this source's prefix
  // but were not visited this run.
  if (!seenSourceIds.length) {
    await sb.from('ai_knowledge_chunks')
      .update({ status: 'deleted' })
      .eq('workspace_id', opts.workspaceId)
      .eq('source_type', 'web_page')
      .like('source_id', `${opts.sourceId}:%`)
      .neq('status', 'deleted');
    return;
  }
  // Supabase JS doesn't support NOT IN with a list field directly via select-builder
  // for large lists, but our ceiling is maxPages (e.g. ≤2000). Use a server-side
  // "select then delete" pattern.
  const { data: rows } = await sb
    .from('ai_knowledge_chunks')
    .select('id, source_id')
    .eq('workspace_id', opts.workspaceId)
    .eq('source_type', 'web_page')
    .like('source_id', `${opts.sourceId}:%`)
    .neq('status', 'deleted');
  const seenSet = new Set(seenSourceIds);
  const stale = (rows || []).filter((r: any) => !seenSet.has(r.source_id)).map((r: any) => r.id);
  if (stale.length) {
    await sb.from('ai_knowledge_chunks').update({ status: 'deleted' }).in('id', stale);
  }
  void config;
}