/**
 * AI KB Builder — job processor.
 *
 * Pipeline (all bounded by job.plan_snapshot):
 *   1. Crawl: BFS within job.source_domain only, http/https only,
 *      max pages / depth from snapshot. Blocks private IPs, redirects
 *      outside the allowed domain, non-text/html, oversized bodies.
 *   2. Extract: strip HTML to plain text; respect maxChars.
 *   3. Generate: for each page (or merged chunk), call the existing
 *      backend AI provider through the workspace's resolved AI config,
 *      consuming 1 AI credit per generated draft. Stops gracefully on
 *      credit exhaustion and marks the job 'partial'.
 *
 * NOTE: This v1 implementation focuses on safe scaffolding. The crawler
 * uses a small allow-list, DNS check via lookup, redirect re-validation,
 * and size/timeout caps. AI generation is delegated to the same provider
 * resolution code used by /api/ai/complete (no duplicate AI client).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { WorkerEnv } from './index.js';
import { executeAICompletion } from '../../server/services/ai/index.js';
import { consumeAiCredits } from '../../server/services/ai-kb/credits.js';
import { DbJobQueueProvider } from '../../server/services/ai-kb/queue.js';
import type { ServerConfig } from '../../server/config.js';

const TIMEOUT_MS = parseInt(process.env.CRAWLER_TIMEOUT_MS || '15000', 10);
const MAX_BYTES = parseInt(process.env.CRAWLER_MAX_BYTES || '2000000', 10); // 2 MB
const USER_AGENT = process.env.CRAWLER_USER_AGENT || 'AiKbBuilder/1.0 (+self-hosted)';

function isPrivateIp(ip: string): boolean {
  // IPv4 ranges + IPv6 loopback/link-local/unique-local
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;       // link-local / metadata
  if (/^fe80:/i.test(ip)) return true;
  if (/^fc|^fd/i.test(ip)) return true;
  return false;
}

async function isHostSafe(host: string): Promise<boolean> {
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

function sameOrSubdomain(host: string, root: string): boolean {
  return host === root || host.endsWith('.' + root);
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

function stripHtml(html: string): { text: string; title: string; links: string[] } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] || '').trim().slice(0, 200);
  const links: string[] = [];
  const linkRe = /<a\s+[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) links.push(m[1]);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, title, links };
}

async function fetchPage(url: string, allowedRoot: string): Promise<{
  ok: boolean; status?: number; html?: string; bytes?: number; reason?: string;
}> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: 'bad_protocol' };
  if (!sameOrSubdomain(parsed.hostname, allowedRoot)) return { ok: false, reason: 'off_domain' };
  if (!(await isHostSafe(parsed.hostname))) return { ok: false, reason: 'unsafe_host' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
    });
    // After redirect, re-check final host.
    try {
      const finalHost = new URL(res.url).hostname;
      if (!sameOrSubdomain(finalHost, allowedRoot)) return { ok: false, status: res.status, reason: 'redirect_off_domain' };
      if (!(await isHostSafe(finalHost))) return { ok: false, status: res.status, reason: 'redirect_unsafe' };
    } catch { return { ok: false, reason: 'bad_redirect_url' }; }

    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return { ok: false, status: res.status, reason: 'non_html' };

    const reader = res.body?.getReader();
    if (!reader) return { ok: false, status: res.status, reason: 'no_body' };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) return { ok: false, status: res.status, reason: 'too_large' };
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { ok: true, status: res.status, html: buf.toString('utf8'), bytes: total };
  } catch (err: any) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'fetch_error' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Generate one draft via the existing shared AI provider abstraction.
 * NEVER instantiates its own OpenAI/Anthropic/Gemini client — all routing
 * (workspace AI config → global default → provider-specific call) lives in
 * server/services/ai/index.ts. The worker only crafts the prompt.
 */
async function generateArticle(
  serverConfig: ServerConfig,
  workspaceId: string,
  locale: string,
  pageText: string,
  pageUrl: string,
  pageTitle: string,
): Promise<{
  title: string; slug: string; excerpt: string; content_md: string;
  confidence: number; model: string; provider: string;
} | null> {
  const sys = `You are a help-center writer. Output STRICT JSON only with this exact shape: {"title":"","slug":"","excerpt":"","content_md":"","confidence":0.0}. Locale: ${locale}. Keep markdown clean, helpful, and free of marketing fluff. No commentary outside the JSON.`;
  const user = `Source URL: ${pageUrl}\nPage title: ${pageTitle}\n---\n${pageText.slice(0, 6000)}`;
  try {
    const res = await executeAICompletion(serverConfig, {
      workspaceId,
      systemPrompt: sys,
      prompt: user,
      maxTokens: 1500,
      temperature: 0.4,
    });
    // Tolerate models that wrap JSON in code fences.
    const raw = (res.text || '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed = JSON.parse(raw);
    if (!parsed.title || !parsed.content_md) return null;
    return {
      title: String(parsed.title).slice(0, 200),
      slug: String(parsed.slug || '').slice(0, 80),
      excerpt: String(parsed.excerpt || '').slice(0, 300),
      content_md: String(parsed.content_md),
      confidence: Number(parsed.confidence) || 0.7,
      model: res.model,
      provider: res.provider,
    };
  } catch {
    return null;
  }
}

export async function processJob(sb: SupabaseClient, env: WorkerEnv, job: any): Promise<void> {
  const serverConfig: ServerConfig = {
    port: 0,
    supabaseUrl: env.supabaseUrl,
    supabaseAnonKey: env.supabaseUrl, // unused by AI service
    supabaseServiceRoleKey: env.supabaseServiceRoleKey,
    corsOrigins: ['*'],
    rateLimitWindowMs: 60000,
    rateLimitMax: 100,
  };
  const jobQueue = new DbJobQueueProvider(sb);
  const snap = job.plan_snapshot || {};
  const root = String(job.source_domain).toLowerCase();
  const seedUrl = `https://${root}/`;

  await jobQueue.updateJob(job.id, { status: 'crawling', progress: 5 } as any);
  await jobQueue.recordEvent(job.id, job.workspace_id, 'info', 'Crawl started', { domain: root });

  // BFS crawl
  const crawlQueue: Array<{ url: string; depth: number }> = [{ url: seedUrl, depth: 0 }];
  const seen = new Set<string>();
  const fetched: Array<{ url: string; html: string; title: string; text: string }> = [];
  const maxPages = Math.max(1, snap.maxPages || 3);
  const maxDepth = Math.max(0, snap.maxDepth || 1);

  while (crawlQueue.length && fetched.length < maxPages) {
    const { url, depth } = crawlQueue.shift()!;
    const urlHash = hash(url);
    if (seen.has(urlHash)) continue;
    seen.add(urlHash);

    try {
      await sb.from('ai_kb_job_pages').insert({
        job_id: job.id, workspace_id: job.workspace_id, url, url_hash: urlHash, depth, status: 'pending',
      });
    } catch { /* swallow — worker may retry on next page */ }

    const r = await fetchPage(url, root);
    if (!r.ok || !r.html) {
      await sb.from('ai_kb_job_pages')
        .update({ status: 'failed', http_status: r.status, error_message: r.reason })
        .eq('job_id', job.id).eq('url_hash', urlHash);
      await sb.from('ai_kb_jobs').update({ pages_failed: (job.pages_failed || 0) + 1 }).eq('id', job.id);
      continue;
    }
    const { text, title, links } = stripHtml(r.html);
    fetched.push({ url, html: r.html, title, text });
    await sb.from('ai_kb_job_pages').update({
      status: 'extracted', http_status: r.status, bytes: r.bytes, text_length: text.length,
      content_hash: hash(text), title, fetched_at: new Date().toISOString(),
    }).eq('job_id', job.id).eq('url_hash', urlHash);

    if (depth < maxDepth) {
      for (const href of links) {
        try {
          const next = new URL(href, url).toString().split('#')[0];
          const np = new URL(next);
          if (sameOrSubdomain(np.hostname, root) && /^https?:$/.test(np.protocol)) {
            crawlQueue.push({ url: next, depth: depth + 1 });
          }
        } catch { /* skip */ }
      }
    }

    await jobQueue.updateJob(job.id, {
      pages_discovered: seen.size,
      pages_crawled: fetched.length,
      progress: Math.min(50, 5 + Math.floor((fetched.length / maxPages) * 45)),
    } as any);
  }

  // Generate
  await jobQueue.updateJob(job.id, { status: 'generating', progress: 55 } as any);

  const maxArticles = Math.max(1, snap.maxArticles || 3);
  let generated = 0;
  let creditsUsed = 0;
  let creditExhausted = false;

  for (const page of fetched) {
    if (generated >= maxArticles) break;

    // Credit policy v1: 1 credit per SUCCESSFULLY generated draft.
    // We try generation first, then deduct only on success — this avoids
    // a separate refund/reversal path. Infrastructure failures (timeouts,
    // bad JSON, no AI provider configured) cost nothing.
    let draft: Awaited<ReturnType<typeof generateArticle>> = null;
    try {
      draft = await generateArticle(
        serverConfig,
        job.workspace_id,
        job.locale || 'en',
        page.text,
        page.url,
        page.title,
      );
    } catch (err: any) {
      await jobQueue.recordEvent(job.id, job.workspace_id, 'warn',
        'AI generation failed', { url: page.url, error: err?.message });
    }
    if (!draft) {
      await jobQueue.recordEvent(job.id, job.workspace_id, 'warn',
        'AI returned no usable draft', { url: page.url });
      continue;
    }

    // Deduct 1 credit for the successful draft. If credits are exhausted
    // at this point, we drop the draft and stop generating further.
    const ded = await consumeAiCredits(serverConfig, job.workspace_id, 1);
    if (!ded.success) {
      creditExhausted = true;
      await jobQueue.recordEvent(job.id, job.workspace_id, 'warn',
        'AI credits exhausted; dropping generated draft', { reason: ded.reason });
      break;
    }

    const { data: ins } = await sb.from('ai_kb_generated_articles').insert({
      workspace_id: job.workspace_id,
      job_id: job.id,
      title: draft.title,
      slug: draft.slug || (draft.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)),
      excerpt: draft.excerpt,
      content_md: draft.content_md,
      locale: job.locale || 'en',
      confidence: draft.confidence,
      source_urls: [page.url],
      model: draft.model,
      credits_used: 1,
    }).select('id').single();

    generated += 1;
    creditsUsed += 1;
    await jobQueue.updateJob(job.id, {
      articles_generated: generated,
      credits_used: creditsUsed,
      progress: Math.min(95, 55 + Math.floor((generated / maxArticles) * 40)),
    } as any);
    await sb.from('ai_kb_usage').insert({
      workspace_id: job.workspace_id, job_id: job.id, generated_article_id: ins?.id || null,
      event_type: 'article_generated', credits: 1, metadata: { url: page.url, model: draft.model, provider: draft.provider },
    });
  }

  const finalStatus = creditExhausted && generated > 0 ? 'partial' : 'completed';
  await jobQueue.updateJob(job.id, {
    status: finalStatus, progress: 100, completed_at: new Date().toISOString(),
  } as any);
  await sb.from('ai_kb_usage').insert({
    workspace_id: job.workspace_id, job_id: job.id,
    event_type: 'job_completed', credits: 0,
    metadata: { articles_generated: generated, credits_used: creditsUsed, status: finalStatus },
  });
}
