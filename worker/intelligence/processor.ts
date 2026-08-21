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
import { executeAICompletion, resolveAIConfig } from '../../server/services/ai/index.js';
import { logGateBypass } from '../../server/middleware/adminBypass.js';
import { consumeAiCredits } from '../../server/services/ai-kb/credits.js';
import { DbJobQueueProvider } from '../../server/services/ai-kb/queue.js';
import type { ServerConfig } from '../../server/config.js';
import { normalizeArticleHtml } from '../../server/services/ai-kb/htmlNormalize.js';
import { workerLog } from './index.js';

const TIMEOUT_MS = parseInt(process.env.CRAWLER_TIMEOUT_MS || '15000', 10);
const MAX_BYTES = parseInt(process.env.CRAWLER_MAX_BYTES || '2000000', 10); // 2 MB
const USER_AGENT = process.env.CRAWLER_USER_AGENT || 'AiKbBuilder/1.0 (+self-hosted)';
// SSRF guard policy: when DNS resolution fails (e.g. transient resolver error,
// IPv6 stack issue, NXDOMAIN flake), default to ALLOW so a flaky resolver
// doesn't permanently block public hosts. The actual fetch() will still fail
// safely on its own. Set CRAWLER_STRICT_DNS=1 to revert to deny-on-failure.
const STRICT_DNS = process.env.CRAWLER_STRICT_DNS === '1';

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

async function isHostSafe(host: string): Promise<{ ok: boolean; reason?: string; addrs?: string[] }> {
  try {
    const addrs = await lookup(host, { all: true });
    const list = addrs.map((a) => a.address);
    const bad = list.filter((ip) => isPrivateIp(ip));
    if (bad.length > 0) {
      return { ok: false, reason: `private_ip:${bad.join(',')}`, addrs: list };
    }
    if (list.length === 0) {
      return STRICT_DNS
        ? { ok: false, reason: 'no_dns_addresses' }
        : { ok: true, reason: 'no_dns_addresses_allowed', addrs: [] };
    }
    return { ok: true, addrs: list };
  } catch (err: any) {
    const reason = `dns_error:${err?.code || err?.message || 'unknown'}`;
    if (STRICT_DNS) return { ok: false, reason };
    return { ok: true, reason };
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
  ok: boolean; status?: number; html?: string; bytes?: number; reason?: string; detail?: string;
}> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: 'bad_protocol' };
  if (!sameOrSubdomain(parsed.hostname, allowedRoot)) return { ok: false, reason: 'off_domain' };
  const safe = await isHostSafe(parsed.hostname);
  if (!safe.ok) return { ok: false, reason: 'unsafe_host', detail: safe.reason };

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
      const fSafe = await isHostSafe(finalHost);
      if (!fSafe.ok) return { ok: false, status: res.status, reason: 'redirect_unsafe', detail: fSafe.reason };
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
    return {
      ok: false,
      reason: err?.name === 'AbortError' ? 'timeout' : 'fetch_error',
      detail: `${err?.name || ''}:${err?.message || err?.code || 'unknown'}`,
    };
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
type GenerateDraftResult =
  | {
      ok: true;
      draft: {
        title: string; slug: string; excerpt: string; content_md: string;
        confidence: number; model: string; provider: string;
        locale?: 'en' | 'fa' | 'tr';
      };
    }
  | {
      ok: false;
      reason: 'ai_call_failed' | 'empty_response' | 'parse_failed' | 'invalid_schema';
      errorMessage?: string;
      errorName?: string;
      stackPreview?: string;
      rawPreview?: string;
      parsedKeys?: string[];
    };

/**
 * Explicit narrowing helpers.
 *
 * `tsconfig.server.json` runs with `strictNullChecks: false`, where TypeScript
 * cannot discriminate a `ok: true | false` union through `if (!result.ok)`.
 * These guards assert exactly the same runtime condition the code already
 * relied on (`ok === false`) — no behavior, ordering or logging changes.
 */
type GenerateDraftFailure = Extract<GenerateDraftResult, { ok: false }>;

function isDraftFailure(result: GenerateDraftResult): result is GenerateDraftFailure {
  return result.ok === false;
}

type ParsedDraftJson = { ok: true; value: any } | { ok: false; error: string };

function isParsedDraftJsonFailure(
  parsed: ParsedDraftJson,
): parsed is Extract<ParsedDraftJson, { ok: false }> {
  return parsed.ok === false;
}

function safePreview(s: string, max = 500): string {
  return (s || '').slice(0, max).replace(/\s+/g, ' ').trim();
}


function tryParseDraftJson(raw: string): ParsedDraftJson {
  let s = (raw || '').trim();
  // Strip ``` or ```json fences.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();

  const candidates = [s];
  const firstObject = extractFirstCompleteJsonObject(s);
  if (firstObject && firstObject !== s) candidates.push(firstObject);

  const start = s.indexOf('{');
  if (start >= 0) {
    const repaired = repairTruncatedJson(s.slice(start));
    if (repaired) candidates.push(repaired);
  }

  let lastError = 'parse_failed';
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (e: any) {
      lastError = e?.message || lastError;
    }
  }
  return { ok: false, error: lastError };
}

function extractFirstCompleteJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let inStr = false;
  let escape = false;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Best-effort repair for JSON truncated mid-string (common when the model
 * hits max_tokens). Closes the dangling string and any unclosed braces.
 */
function repairTruncatedJson(s: string): string | null {
  let inStr = false;
  let escape = false;
  let braces = 0;
  let brackets = 0;
  let lastSafe = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') braces++;
    else if (ch === '}') { braces--; if (braces >= 0 && brackets === 0) lastSafe = i; }
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  let out = s;
  if (inStr) out += '"';
  // Drop trailing comma before closing.
  out = out.replace(/,\s*$/, '');
  while (brackets-- > 0) out += ']';
  while (braces-- > 0) out += '}';
  return out;
}

async function generateArticle(
  serverConfig: ServerConfig,
  workspaceId: string,
  locale: string,
  pageText: string,
  pageUrl: string,
  pageTitle: string,
): Promise<GenerateDraftResult> {
  // The model MUST detect the source page's natural language and write the
  // article in that same language. The `locale` argument is only a fallback
  // hint when detection is ambiguous. Supported codes: en, fa, tr.
  const sys = `You are a senior multilingual help-center writer producing widget-ready articles.

LANGUAGE: FIRST detect the natural language of the SOURCE page (one of: en, fa, tr) and write title, excerpt and content in THAT SAME language. Never translate. Hint (use only if detection is impossible): ${locale}.

OUTPUT: Return STRICT JSON ONLY, no prose, no code fences. Exact shape:
{"title":"","slug":"","excerpt":"","content_html":"","confidence":0.0,"locale":"en|fa|tr"}

CONTENT FORMAT — content_html MUST be clean, semantic HTML suitable for direct injection into a help widget:
- Use ONLY these tags: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <a href="...">, <code>, <pre>, <blockquote>, <br>.
- DO NOT use markdown syntax. Never output #, ##, ###, **, __, \`\`\`, ---, > , - , * as list/heading/bold markers.
- DO NOT include <html>, <head>, <body>, <h1>, <style>, <script>, <img>, inline CSS, classes, ids, or data-* attributes.
- Start with one short intro <p>. Then organize into 2–5 <h2> sections. Use <h3> only if needed inside a section.
- Prefer concise paragraphs (2–4 sentences) and well-formed <ul>/<ol> lists for steps.
- Close every tag. No empty tags. No trailing whitespace inside tags.
- excerpt: 1–2 plain-text sentences, NO HTML, NO markdown.
- title: plain text, no quotes, no markdown.
- slug: lowercase ASCII a-z 0-9 and hyphens only.
- Keep tone helpful and factual. No marketing fluff. No "as an AI" disclaimers.

If the source is thin, still produce a useful article from what is there — never invent product facts that contradict the source.`;
  const user = `Source URL: ${pageUrl}\nPage title: ${pageTitle}\n---\n${pageText.slice(0, 6000)}`;
  let res: Awaited<ReturnType<typeof executeAICompletion>>;
  try {
    res = await executeAICompletion(serverConfig, {
      workspaceId,
      systemPrompt: sys,
      prompt: user,
      maxTokens: 4096,
      temperature: 0.2,
      jsonMode: true,
    });
  } catch (err: any) {
    return {
      ok: false,
      reason: 'ai_call_failed',
      errorMessage: err?.message || String(err),
      errorName: err?.name,
      stackPreview: safePreview(err?.stack || '', 500),
    };
  }

  const text = (res.text || '').trim();
  if (!text) {
    return { ok: false, reason: 'empty_response' };
  }

  const parsed = tryParseDraftJson(text);
  if (isParsedDraftJsonFailure(parsed)) {
    return {
      ok: false,
      reason: 'parse_failed',
      errorMessage: parsed.error,
      rawPreview: safePreview(text, 500),
    };
  }

  const v = parsed.value || {};
  // Accept either content_html (preferred) or legacy content_md.
  const rawContent = String(v.content_html || v.content_md || '');
  if (!v.title || !rawContent) {
    return {
      ok: false,
      reason: 'invalid_schema',
      parsedKeys: Object.keys(v),
      rawPreview: safePreview(text, 500),
    };
  }

  const detectedRaw = String(v.locale || '').toLowerCase().split('-')[0];
  const detectedLocale = (['en', 'fa', 'tr'].includes(detectedRaw) ? detectedRaw : '') as 'en' | 'fa' | 'tr' | '';
  return {
    ok: true,
    draft: {
      title: String(v.title).slice(0, 200),
      slug: String(v.slug || '').slice(0, 80),
      excerpt: String(v.excerpt || '').slice(0, 300),
      content_md: normalizeArticleHtml(rawContent),
      confidence: Number(v.confidence) || 0.7,
      model: res.model,
      provider: res.provider,
      locale: detectedLocale || undefined,
    },
  };
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
    selfHostBillingUnlimited: false,
  };
  const jobQueue = new DbJobQueueProvider(sb);
  const snap = job.plan_snapshot || {};
  const root = String(job.source_domain).toLowerCase();
  const seedUrl = `https://${root}/`;

  // Local counters (authoritative — DB row may be stale by the time we log).
  let pagesFetched = 0;
  let pagesBlocked = 0;
  let articlesGenerated = 0;
  let generationFailed = 0;
  let creditsUsed = 0;
  let lastGenerationError: string | null = null;
  let lastGenerationReason: string | null = null;

  await jobQueue.updateJob(job.id, { status: 'crawling', progress: 5 } as any);
  await jobQueue.recordEvent(job.id, job.workspace_id, 'info', 'Crawl started', { domain: root });
  workerLog('crawl started', { jobId: job.id, domain: root });

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
        .update({
          status: 'failed',
          http_status: r.status,
          error_message: r.detail ? `${r.reason}: ${r.detail}`.slice(0, 500) : r.reason,
        })
        .eq('job_id', job.id).eq('url_hash', urlHash);
      await sb.from('ai_kb_jobs').update({ pages_failed: (job.pages_failed || 0) + 1 }).eq('id', job.id);
      pagesBlocked += 1;
      workerLog('page blocked', { jobId: job.id, url, reason: r.reason, detail: r.detail, status: r.status });
      await jobQueue.recordEvent(job.id, job.workspace_id, 'warn', 'Page blocked', {
        url, reason: r.reason, detail: r.detail, status: r.status,
      });
      continue;
    }
    const { text, title, links } = stripHtml(r.html);
    fetched.push({ url, html: r.html, title, text });
    pagesFetched += 1;
    workerLog('page fetched', { jobId: job.id, url, status: r.status, textLength: text.length });
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

  // ── Crawl-only test job: maxArticles explicitly 0 → no generation. ──
  // Preserve explicit zero (Math.max(1, 0||3) was wrong).
  const maxArticles = typeof snap.maxArticles === 'number' ? snap.maxArticles : 3;

  if (maxArticles === 0) {
    await jobQueue.updateJob(job.id, {
      status: 'completed',
      progress: 100,
      pages_crawled: pagesFetched,
      pages_failed: pagesBlocked,
      articles_generated: 0,
      credits_used: 0,
      completed_at: new Date().toISOString(),
    } as any);
    await jobQueue.recordEvent(job.id, job.workspace_id, 'info',
      'Crawl-only test completed', { reason: 'crawl_only_test', pagesCrawled: pagesFetched });
    await sb.from('ai_kb_usage').insert({
      workspace_id: job.workspace_id, job_id: job.id,
      event_type: 'job_completed', credits: 0,
      metadata: { completion_reason: 'crawl_only_test', pages_crawled: pagesFetched },
    });
    workerLog('crawl-only test completed', { jobId: job.id, pagesCrawled: pagesFetched });
    return;
  }

  // ── AI provider preflight ── (fail fast with a clear reason)
  const aiCfg = await resolveAIConfig(serverConfig, job.workspace_id).catch(() => null);
  if (!aiCfg) {
    const msg = 'AI provider is not configured';
    await jobQueue.recordEvent(job.id, job.workspace_id, 'error', msg, {});
    await jobQueue.failJob(job.id, msg);
    await sb.from('ai_kb_usage').insert({
      workspace_id: job.workspace_id, job_id: job.id,
      event_type: 'job_failed', credits: 0,
      metadata: {
        reason: 'provider_missing',
        pages_crawled: pagesFetched,
      },
    });
    workerLog('generation failed - ai provider missing', {
      jobId: job.id, workspaceId: job.workspace_id,
    });
    return;
  }

  // Generate
  await jobQueue.updateJob(job.id, { status: 'generating', progress: 55 } as any);
  workerLog('generation started', { jobId: job.id, candidatePages: fetched.length });

  let creditExhausted = false;
  const adminOverride = job.admin_override === true || job.plan_snapshot?.admin_override === true;
  if (adminOverride) {
    await jobQueue.recordEvent(job.id, job.workspace_id, 'info',
      'Global admin credit bypass active', { reason: 'admin_override' });
    await logGateBypass(serverConfig, {
      userId: job.created_by_global_admin || job.requested_by,
      workspaceId: job.workspace_id,
      moduleKey: 'ai_credits',
      route: 'worker/intelligence/processJob',
      reason: 'ai_kb_admin_override',
    });
  }

  for (const page of fetched) {
    if (articlesGenerated >= maxArticles) break;

    // Dedup: if a generated article already exists for the same workspace +
    // locale + source URL, skip re-generation. This prevents repeat scans
    // from creating duplicate KB drafts/articles for unchanged pages.
    const dedupLocale = job.locale || 'en';
    try {
      const { data: existingDup } = await sb
        .from('ai_kb_generated_articles')
        .select('id, status, kb_article_id')
        .eq('workspace_id', job.workspace_id)
        .eq('locale', dedupLocale)
        .contains('source_urls', [page.url])
        .limit(1)
        .maybeSingle();
      if (existingDup?.id) {
        workerLog('draft skipped — duplicate source url', {
          jobId: job.id, pageUrl: page.url, existingId: existingDup.id, status: existingDup.status,
        });
        await jobQueue.recordEvent(job.id, job.workspace_id, 'info',
          'Skipped duplicate page', {
            url: page.url, locale: dedupLocale,
            existing_generated_id: existingDup.id,
            existing_status: existingDup.status,
            existing_kb_article_id: existingDup.kb_article_id,
          });
        continue;
      }
    } catch (e) {
      workerLog('dedup check failed (continuing)', {
        jobId: job.id, pageUrl: page.url, error: (e as Error)?.message,
      });
    }

    workerLog('draft generation attempt', {
      jobId: job.id,
      pageUrl: page.url,
      textLength: page.text.length,
      locale: job.locale || 'en',
    });

    const result = await generateArticle(
      serverConfig,
      job.workspace_id,
      job.locale || 'en',
      page.text,
      page.url,
      page.title,
    );

    if (isDraftFailure(result)) {
      generationFailed += 1;
      lastGenerationReason = result.reason;
      lastGenerationError = result.errorMessage || result.reason;

      if (result.reason === 'ai_call_failed') {
        workerLog('draft generation failed', {
          jobId: job.id, pageUrl: page.url,
          errorMessage: result.errorMessage,
          errorName: result.errorName,
          stackPreview: result.stackPreview,
        });
        await jobQueue.recordEvent(job.id, job.workspace_id, 'error',
          'AI call failed', {
            url: page.url,
            error: result.errorMessage,
            errorName: result.errorName,
          });
      } else if (result.reason === 'empty_response') {
        workerLog('draft empty response', { jobId: job.id, pageUrl: page.url });
        await jobQueue.recordEvent(job.id, job.workspace_id, 'warn',
          'AI returned empty response', { url: page.url });
      } else if (result.reason === 'parse_failed') {
        workerLog('draft parse failed', {
          jobId: job.id, pageUrl: page.url,
          rawPreview: result.rawPreview,
          errorMessage: result.errorMessage,
        });
        await jobQueue.recordEvent(job.id, job.workspace_id, 'warn',
          'AI response was not valid JSON', {
            url: page.url,
            error: result.errorMessage,
            rawPreview: result.rawPreview,
          });
      } else if (result.reason === 'invalid_schema') {
        workerLog('draft invalid', {
          jobId: job.id, pageUrl: page.url,
          parsedKeys: result.parsedKeys,
        });
        await jobQueue.recordEvent(job.id, job.workspace_id, 'warn',
          'AI JSON missing title/content_md', {
            url: page.url,
            parsedKeys: result.parsedKeys,
            rawPreview: result.rawPreview,
          });
      }
      continue;
    }

    const draft = result.draft;

    // Deduct 1 credit only on a valid draft. Failed AI/parse cost 0.
    // Global Admin override (job.admin_override) bypasses credit gating
    // for diagnostic / platform-owner runs. Bypass is implicit via the
    // job flag set at creation time and was already audit-logged then.
    const ded = adminOverride
      ? { success: true, reason: 'admin_override' as const }
      : await consumeAiCredits(serverConfig, job.workspace_id, 1);
    if (!ded.success) {
      creditExhausted = true;
      lastGenerationReason = 'credits_exhausted';
      lastGenerationError = ded.reason || 'AI credits exhausted';
      await jobQueue.recordEvent(job.id, job.workspace_id, 'warn',
        'AI credits exhausted; dropping generated draft', {
          reason: ded.reason,
          admin_override: adminOverride,
          job_admin_override: job.admin_override,
          snapshot_admin_override: job.plan_snapshot?.admin_override,
        });
      workerLog('credits exhausted', { jobId: job.id, reason: ded.reason });
      break;
    }

    const { data: ins } = await sb.from('ai_kb_generated_articles').insert({
      workspace_id: job.workspace_id,
      job_id: job.id,
      title: draft.title,
      slug: draft.slug || (draft.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)),
      excerpt: draft.excerpt,
      content_md: draft.content_md,
      locale: draft.locale || job.locale || 'en',
      confidence: draft.confidence,
      source_urls: [page.url],
      model: draft.model,
      credits_used: adminOverride ? 0 : 1,
    }).select('id').single();

    articlesGenerated += 1;
    creditsUsed += adminOverride ? 0 : 1;
    workerLog('draft generated', {
      jobId: job.id,
      generatedArticleId: ins?.id,
      title: draft.title,
      creditsUsed,
    });
    await jobQueue.recordEvent(job.id, job.workspace_id, 'info', 'Draft generated', {
      url: page.url, generatedArticleId: ins?.id, title: draft.title,
    });
    await jobQueue.updateJob(job.id, {
      articles_generated: articlesGenerated,
      credits_used: creditsUsed,
      progress: Math.min(95, 55 + Math.floor((articlesGenerated / maxArticles) * 40)),
    } as any);
    await sb.from('ai_kb_usage').insert({
      workspace_id: job.workspace_id, job_id: job.id, generated_article_id: ins?.id || null,
      event_type: 'article_generated', credits: adminOverride ? 0 : 1, metadata: {
        url: page.url,
        model: draft.model,
        provider: draft.provider,
        admin_override: adminOverride || undefined,
      },
    });
  }

  // ── Final status decision ──
  let finalStatus: 'completed' | 'partial' | 'failed';
  let finalError: string | null = null;
  let completionReason: string;

  if (articlesGenerated === 0) {
    // No drafts produced — never report this as a successful completion.
    finalStatus = 'failed';
    finalError = lastGenerationError
      || (pagesFetched === 0 ? 'No pages were crawled successfully' : 'No AI drafts were generated');
    completionReason = lastGenerationReason || (pagesFetched === 0 ? 'no_pages_crawled' : 'no_drafts');
  } else if (creditExhausted || articlesGenerated < Math.min(maxArticles, pagesFetched)) {
    finalStatus = 'partial';
    completionReason = creditExhausted ? 'credits_exhausted' : 'partial_generation';
  } else {
    finalStatus = 'completed';
    completionReason = 'completed';
  }

  await jobQueue.updateJob(job.id, {
    status: finalStatus,
    progress: 100,
    pages_crawled: pagesFetched,
    pages_failed: pagesBlocked,
    articles_generated: articlesGenerated,
    credits_used: creditsUsed,
    completed_at: new Date().toISOString(),
    ...(finalError ? { error_message: finalError.slice(0, 1000) } : {}),
  } as any);

  await sb.from('ai_kb_usage').insert({
    workspace_id: job.workspace_id, job_id: job.id,
    event_type: finalStatus === 'failed' ? 'job_failed' : 'job_completed', credits: 0,
    metadata: {
      articles_generated: articlesGenerated,
      pages_crawled: pagesFetched,
      pages_blocked: pagesBlocked,
      generation_failed: generationFailed,
      credits_used: creditsUsed,
      status: finalStatus,
      completion_reason: completionReason,
      ...(finalError ? { error_message: finalError } : {}),
    },
  });

  workerLog('job finished', {
    jobId: job.id,
    status: finalStatus,
    pagesCrawled: pagesFetched,
    pagesBlocked,
    articlesGenerated,
    generationFailed,
    creditsUsed,
    reason: completionReason,
    ...(finalError ? { error: finalError } : {}),
  });
}
