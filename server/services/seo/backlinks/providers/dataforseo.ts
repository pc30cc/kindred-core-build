/**
 * DATAFORSEO BACKLINKS ADAPTER
 *
 * Wraps DataForSEO's Backlinks API (`POST /v3/backlinks/backlinks/live`, the
 * synchronous "live" variant — no task polling, one HTTP call returns
 * results directly) behind a narrow, promise-based interface.
 *
 * Auth: HTTP Basic (login:password from the DataForSEO dashboard) — DataForSEO
 * uses account credentials, not a bearer API key.
 *
 * FIELD-MAPPING NOTE: this adapter's response parsing was written against
 * DataForSEO's long-stable v3 response envelope and documented field names
 * (`items[].url_from`, `url_to`, `domain_from`, `anchor`, `dofollow`,
 * `rank`, `domain_from_rank`, `backlink_spam_score`, `first_seen`,
 * `last_seen`, `is_new`, `is_lost`). It could not be verified against a live
 * response or the current docs page from this environment (network policy
 * blocks docs.dataforseo.com), so `parseItem` is deliberately defensive:
 * every field is optional-safe, unknown/renamed fields are ignored rather
 * than throwing, and only `url_from`/`url_to` are treated as required per
 * item. Re-verify field names against a real response on first live test.
 *
 * SECURITY
 * - No credential is ever placed in an error message, log line or return value.
 * - Every call is fail-closed: HTTP errors, malformed JSON, and timeouts all
 *   resolve to a normalized `BacklinksError`.
 */
import {
  BacklinksError,
  type BacklinkResultItem,
  type BacklinksAccountInfo,
  type BacklinksFetchResult,
  type DataForSeoBacklinksConfig,
} from '../types.js';

export const DATAFORSEO_TIMEOUT_MS = 30_000;
export const DATAFORSEO_API_BASE = 'https://api.dataforseo.com/v3';

export interface DataForSeoAdapter {
  fetchBacklinks(input: { target: string; limit: number }): Promise<BacklinksFetchResult>;
  getAccountInfo(): Promise<BacklinksAccountInfo>;
}

export interface DataForSeoAdapterOptions {
  /** Test seam — injects a fake fetch. Production leaves this undefined. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiBase?: string;
}

function authHeader(config: DataForSeoBacklinksConfig): string {
  const token = Buffer.from(`${config.login}:${config.password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) throw new BacklinksError('backlinks_auth_failed');
    if (res.status === 429) throw new BacklinksError('backlinks_rate_limited');
    if (!res.ok) throw new BacklinksError('backlinks_provider_error');
    try {
      return await res.json();
    } catch {
      throw new BacklinksError('backlinks_provider_error');
    }
  } catch (err) {
    if (err instanceof BacklinksError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') throw new BacklinksError('backlinks_timeout');
    throw new BacklinksError('backlinks_network_error');
  } finally {
    clearTimeout(timer);
  }
}

/** DataForSEO's `appendix/user_data` endpoint is GET-only; POSTing to it returns an error envelope. */
async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    if (res.status === 401 || res.status === 403) throw new BacklinksError('backlinks_auth_failed');
    if (res.status === 429) throw new BacklinksError('backlinks_rate_limited');
    if (!res.ok) throw new BacklinksError('backlinks_provider_error');
    try {
      return await res.json();
    } catch {
      throw new BacklinksError('backlinks_provider_error');
    }
  } catch (err) {
    if (err instanceof BacklinksError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') throw new BacklinksError('backlinks_timeout');
    throw new BacklinksError('backlinks_network_error');
  } finally {
    clearTimeout(timer);
  }
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const v = source[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Maps a DataForSEO status_code to a normalized error, per
 * https://docs.dataforseo.com/v3/appendix/errors/
 *  - 40100 bad credentials, 40104 account not verified,
 *    40204 Backlinks API subscription required, 40207 IP not whitelisted
 *  - 40200/40203/40210 balance or cost limit
 *  - 40202/40209/42900 rate limits
 *  - 404xx/405xx invalid request fields
 */
function throwBacklinksStatus(status: number, message: string | null): never {
  if (status === 40100 || status === 40104 || status === 40204 || status === 40207) {
    throw new BacklinksError('backlinks_auth_failed', message);
  }
  if (status === 40200 || status === 40203 || status === 40210) throw new BacklinksError('backlinks_insufficient_credit', message);
  if (status === 40202 || status === 40209 || status === 42900) throw new BacklinksError('backlinks_rate_limited', message);
  if (status >= 40400 && status < 40600) throw new BacklinksError('backlinks_invalid_target', message);
  throw new BacklinksError('backlinks_provider_error', message);
}


function readNumber(source: Record<string, unknown>, key: string): number | null {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readBool(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = source[key];
  return typeof v === 'boolean' ? v : fallback;
}

function parseItem(raw: unknown): BacklinkResultItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const sourceUrl = readString(item, 'url_from');
  const targetUrl = readString(item, 'url_to');
  if (!sourceUrl || !targetUrl) return null;

  let sourceDomain = readString(item, 'domain_from') || '';
  if (!sourceDomain) {
    try { sourceDomain = new URL(sourceUrl).hostname; } catch { sourceDomain = ''; }
  }

  return {
    sourceUrl,
    sourceDomain,
    targetUrl,
    anchorText: readString(item, 'anchor'),
    isDofollow: readBool(item, 'dofollow', true),
    isNew: readBool(item, 'is_new', false),
    isLost: readBool(item, 'is_lost', false),
    pageRank: readNumber(item, 'rank') ?? readNumber(item, 'page_from_rank'),
    domainRank: readNumber(item, 'domain_from_rank'),
    spamScore: readNumber(item, 'backlink_spam_score'),
    firstSeen: readString(item, 'first_seen'),
    lastSeen: readString(item, 'last_seen'),
  };
}

export function createDataForSeoAdapter(
  config: DataForSeoBacklinksConfig,
  options: DataForSeoAdapterOptions = {},
): DataForSeoAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DATAFORSEO_TIMEOUT_MS;
  const apiBase = options.apiBase ?? DATAFORSEO_API_BASE;
  const headers = { Authorization: authHeader(config) };

  return {
    async fetchBacklinks({ target, limit }) {
      const body = await postJson(
        `${apiBase}/backlinks/backlinks/live`,
        [{
          target,
          mode: 'as_is',
          limit: Math.max(1, Math.min(limit, 1000)),
          backlinks_status_type: 'live',
          // API default is a 0-1000 scale; the UI shows 0-100 rank values
          rank_scale: 'one_hundred',
        }],

        headers,
        fetchImpl,
        timeoutMs,
      );
      const envelope = body as Record<string, unknown>;
      const topStatus = readNumber(envelope, 'status_code');
      if (topStatus !== null && topStatus !== 20000) {
        throwBacklinksStatus(topStatus, readString(envelope, 'status_message'));
      }
      const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
      const task = tasks[0] as Record<string, unknown> | undefined;
      if (!task) throw new BacklinksError('backlinks_provider_error');
      const taskStatus = readNumber(task, 'status_code');
      if (taskStatus !== null && taskStatus !== 20000) {
        throwBacklinksStatus(taskStatus, readString(task, 'status_message'));
      }
      const results = Array.isArray(task.result) ? task.result : [];
      const first = results[0] as Record<string, unknown> | undefined;
      const rawItems = first && Array.isArray(first.items) ? first.items : [];

      const items: BacklinkResultItem[] = [];
      let dofollowCount = 0;
      let newCount = 0;
      let lostCount = 0;
      const domains = new Set<string>();
      for (const raw of rawItems) {
        const parsed = parseItem(raw);
        if (!parsed) continue;
        items.push(parsed);
        if (parsed.isDofollow) dofollowCount++;
        if (parsed.isNew) newCount++;
        if (parsed.isLost) lostCount++;
        if (parsed.sourceDomain) domains.add(parsed.sourceDomain);
      }

      return {
        items,
        totalCount: readNumber(first || {}, 'total_count') ?? items.length,
        referringDomains: domains.size,
        dofollowCount,
        nofollowCount: items.length - dofollowCount,
        newCount,
        lostCount,
      };
    },

    async getAccountInfo() {
      const body = await getJson(`${apiBase}/appendix/user_data`, headers, fetchImpl, timeoutMs);
      const envelope = body as Record<string, unknown>;
      const envelopeStatus = readNumber(envelope, 'status_code');
      if (envelopeStatus !== null && envelopeStatus !== 20000) {
        throwBacklinksStatus(envelopeStatus, readString(envelope, 'status_message'));
      }
      const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
      const task = tasks[0] as Record<string, unknown> | undefined;
      const taskStatus = task ? readNumber(task, 'status_code') : null;
      if (taskStatus !== null && taskStatus !== 20000 && task) {
        throwBacklinksStatus(taskStatus, readString(task, 'status_message'));
      }
      const results = task && Array.isArray(task.result) ? task.result : [];
      const first = results[0] as Record<string, unknown> | undefined;
      if (!first) throw new BacklinksError('backlinks_provider_error');
      const money = (first.money && typeof first.money === 'object' ? first.money : {}) as Record<string, unknown>;
      const balance = readNumber(money, 'balance') ?? readNumber(first, 'money_balance') ?? readNumber(first, 'balance');
      const currency = readString(money, 'currency') || readString(first, 'currency') || 'USD';
      return { balance, currency };
    },
  };
}
