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
import { readRows } from '../../../lib/pagedRows.js';
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

/**
 * Bounds on one crawl's work (audit ai-5): only fetched pages count toward
 * maxPages, so failed, skipped, robots-blocked and wrong-type URLs were
 * attempted without limit, every page queued all its links, and one site
 * could hold the shared, sequential source-sync worker for hours.
 *   - attempts: every URL taken from the queue, whatever its outcome;
 *   - queue: URLs waiting; links past it are dropped;
 *   - wall clock: the whole crawl.
 * A crawl stopped by one of these is truncated and prunes nothing.
 */
const ATTEMPTS_PER_PAGE = 3;
const ATTEMPTS_HEADROOM = 50;
const QUEUE_PER_PAGE = 10;
const QUEUE_MIN = 500;
const CRAWL_MAX_MS = parseInt(process.env.AI_KB_CRAWL_MAX_MS || String(60 * 60 * 1000), 10);

export function crawlAttemptCap(maxPages: number): number {
  return Math.max(1, maxPages) * ATTEMPTS_PER_PAGE + ATTEMPTS_HEADROOM;
}

export function crawlQueueCap(maxPages: number): number {
  return Math.max(QUEUE_MIN, Math.max(1, maxPages) * QUEUE_PER_PAGE);
}

/** A page whose fetch says it is gone: its old knowledge goes with it. */
function pageIsGone(status: number | null | undefined): boolean {
  return status === 404 || status === 410;
}

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

  const attemptCap = crawlAttemptCap(opts.maxPages);
  const queueCap = crawlQueueCap(opts.maxPages);
  const deadline = Date.now() + CRAWL_MAX_MS;
  // Why the crawl did not see the whole site, when that was not the plan's
  // page cap: then what it did not see is unknown, not gone.
  let incomplete: string | null = null;
  let billingDenied = false;

  while (queue.length && summary.pages_fetched < opts.maxPages) {
    if (summary.pages_seen >= attemptCap) { incomplete = 'crawl_attempt_limit'; break; }
    if (Date.now() >= deadline) { incomplete = 'crawl_time_limit'; break; }
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
      // A page that failed to load this time (5xx, timeout, a bot
      // challenge) keeps its knowledge until a run reads it again or it
      // answers 404/410 (audit ai-4).
      if (!pageIsGone(fetched.status)) seenSourceIds.push(`${opts.sourceId}:${urlHash(url)}`);
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
      try {
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
      } catch (err: unknown) {
        // ENFORCED billing denial (exhausted wallet, missing rate card) —
        // every remaining page would fail identically, so stop crawling
        // instead of burning through the queue on repeat failures. Distinct
        // from a page fetch/parse error: the page itself was fine, indexing
        // it is what's blocked.
        billingDenied = true;
        summary.errors.push(`ai_billing_denied: ${err instanceof Error ? err.message : String(err)}`);
        await recordPage(sb, opts, url, {
          status: 'failed',
          http_status: fetched.status,
          warning: 'ai_billing_denied',
        });
      }
    } else if (lowText) {
      summary.warnings.push(`low_text_content: ${url}`);
    }
    if (billingDenied) break;

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
        if (queue.length >= queueCap) { incomplete = incomplete || 'crawl_queue_limit'; break; }
        seen.add(c.url);
        queue.push({ url: c.url, depth: depth + 1 });
      }
    }
  }

  if (queue.length > 0 || incomplete) {
    summary.truncated = true;
    summary.warnings.push(incomplete || 'plan_limit_truncated');
  }

  // Mark previously-known pages that we no longer saw as removed (deactivate
  // their chunks), only when this run read the site as far as the plan's
  // page cap: never after a run that fetched nothing (the site down, a bot
  // challenge), a billing denial, or a stop on the bounds above, which would
  // drop knowledge the run simply did not reach (audit ai-4).
  const pruneSkipped = shouldSkipPrune(summary, { billingDenied, incomplete });
  if (pruneSkipped) {
    summary.warnings.push(`prune_skipped_${pruneSkipped}`);
  } else {
    await pruneUnseenPages(sb, config, opts, seenSourceIds);
  }

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

/** Why this run must not prune, or null when it may. */
export function shouldSkipPrune(
  summary: Pick<CrawlSummary, 'pages_fetched'>,
  run: { billingDenied: boolean; incomplete: string | null },
): string | null {
  if (run.billingDenied) return 'billing_denied';
  if (summary.pages_fetched === 0) return 'nothing_fetched';
  if (run.incomplete) return 'incomplete';
  return null;
}

/** Chunk ids per pruning update. */
const PRUNE_BATCH = 500;

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
  // "select then delete" pattern. The select is paged: the data layer caps a
  // read at DATABASE_MAX_ROWS, and a chunk past it would stay answerable.
  // A failed read prunes nothing.
  const { data: rows, error } = await readRows<{ id: string; source_id: string }>((from, to) => sb
    .from('ai_knowledge_chunks')
    .select('id, source_id')
    .eq('workspace_id', opts.workspaceId)
    .eq('source_type', 'web_page')
    .like('source_id', `${opts.sourceId}:%`)
    .neq('status', 'deleted')
    .order('id', { ascending: true })
    .range(from, to));
  if (error) return;
  const seenSet = new Set(seenSourceIds);
  const stale = rows
    .filter((r) => !seenSet.has(r.source_id))
    .map((r) => r.id);
  for (let i = 0; i < stale.length; i += PRUNE_BATCH) {
    await sb.from('ai_knowledge_chunks').update({ status: 'deleted' }).in('id', stale.slice(i, i + PRUNE_BATCH));
  }
  void config;
}