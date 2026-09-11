/**
 * DATAFORSEO RANK TRACKING ADAPTER
 *
 * Wraps DataForSEO's SERP API (`POST /v3/serp/google/organic/live/regular`,
 * the synchronous "live" variant) behind a narrow, promise-based interface.
 * Same auth and response envelope as the sibling backlinks/keywords
 * adapters — see server/services/seo/backlinks/providers/dataforseo.ts's
 * header comment for the shared field-mapping caveat (written against
 * DataForSEO's long-stable v3 conventions, not verified against a live
 * response from this sandboxed environment; re-verify on first live test).
 *
 * Documented response fields consumed here: `items[].type` ('organic'),
 * `items[].domain`, `items[].url`, `items[].rank_group`.
 */
import {
  RankTrackingError,
  type RankCheckResult,
  type RankTrackingAccountInfo,
  type DataForSeoRankTrackingConfig,
} from '../types.js';

export const DATAFORSEO_TIMEOUT_MS = 45_000;
export const DATAFORSEO_API_BASE = 'https://api.dataforseo.com/v3';
const DEFAULT_LOCATION_CODE = 2840; // United States
const DEFAULT_LANGUAGE_CODE = 'en';

export interface DataForSeoRankTrackingAdapter {
  checkRank(input: { keyword: string; targetHost: string; device: 'desktop' | 'mobile'; locationCode?: number | null }): Promise<RankCheckResult>;
  getAccountInfo(): Promise<RankTrackingAccountInfo>;
}

export interface DataForSeoRankTrackingAdapterOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiBase?: string;
}

function authHeader(config: DataForSeoRankTrackingConfig): string {
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
    if (res.status === 401 || res.status === 403) throw new RankTrackingError('rank_tracking_auth_failed');
    if (res.status === 429) throw new RankTrackingError('rank_tracking_rate_limited');
    if (!res.ok) throw new RankTrackingError('rank_tracking_provider_error');
    try {
      return await res.json();
    } catch {
      throw new RankTrackingError('rank_tracking_provider_error');
    }
  } catch (err) {
    if (err instanceof RankTrackingError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') throw new RankTrackingError('rank_tracking_timeout');
    throw new RankTrackingError('rank_tracking_network_error');
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
    if (res.status === 401 || res.status === 403) throw new RankTrackingError('rank_tracking_auth_failed');
    if (res.status === 429) throw new RankTrackingError('rank_tracking_rate_limited');
    if (!res.ok) throw new RankTrackingError('rank_tracking_provider_error');
    try {
      return await res.json();
    } catch {
      throw new RankTrackingError('rank_tracking_provider_error');
    }
  } catch (err) {
    if (err instanceof RankTrackingError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') throw new RankTrackingError('rank_tracking_timeout');
    throw new RankTrackingError('rank_tracking_network_error');
  } finally {
    clearTimeout(timer);
  }
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const v = source[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Strips a leading "www." so "www.example.com" and "example.com" compare equal. */
function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Maps a DataForSEO status_code to a normalized error, per
 * https://docs.dataforseo.com/v3/appendix/errors/
 */
function throwRankTrackingStatus(status: number, message: string | null): never {
  if (status === 40100 || status === 40104 || status === 40204 || status === 40207) {
    throw new RankTrackingError('rank_tracking_auth_failed', message);
  }
  if (status === 40200 || status === 40203 || status === 40210) throw new RankTrackingError('rank_tracking_insufficient_credit', message);
  if (status === 40202 || status === 40209 || status === 42900) throw new RankTrackingError('rank_tracking_rate_limited', message);
  if (status >= 40400 && status < 40600) throw new RankTrackingError('rank_tracking_invalid_input', message);
  throw new RankTrackingError('rank_tracking_provider_error', message);
}


export function createDataForSeoRankTrackingAdapter(
  config: DataForSeoRankTrackingConfig,
  options: DataForSeoRankTrackingAdapterOptions = {},
): DataForSeoRankTrackingAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DATAFORSEO_TIMEOUT_MS;
  const apiBase = options.apiBase ?? DATAFORSEO_API_BASE;
  const headers = { Authorization: authHeader(config) };

  return {
    async checkRank({ keyword, targetHost, device, locationCode }) {
      // A Persian/Arabic-script keyword searched in the US/en locale returns a
      // SERP the site can never rank in, so infer the Iran/fa locale from the
      // keyword's script unless an explicit location was stored.
      const persian = /[\u0600-\u06FF]/.test(keyword);
      const body = await postJson(
        `${apiBase}/serp/google/organic/live/regular`,
        [{
          keyword,
          location_code: locationCode ?? (persian ? PERSIAN_LOCATION_CODE : DEFAULT_LOCATION_CODE),
          language_code: persian ? PERSIAN_LANGUAGE_CODE : DEFAULT_LANGUAGE_CODE,
          device,
          depth: 100,
        }],
        headers,
        fetchImpl,
        timeoutMs,
      );
      const envelope = body as Record<string, unknown>;
      const envelopeStatus = readNumber(envelope, 'status_code');
      if (envelopeStatus !== null && envelopeStatus !== 20000) {
        throwRankTrackingStatus(envelopeStatus, readString(envelope, 'status_message'));
      }
      const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
      const task = tasks[0] as Record<string, unknown> | undefined;
      if (!task) throw new RankTrackingError('rank_tracking_provider_error');
      const taskStatus = readNumber(task, 'status_code');
      if (taskStatus !== null && taskStatus !== 20000) {
        throwRankTrackingStatus(taskStatus, readString(task, 'status_message'));
      }

      const results = Array.isArray(task.result) ? task.result : [];
      const first = results[0] as Record<string, unknown> | undefined;
      const rawItems = first && Array.isArray(first.items) ? first.items : [];

      const target = bareHost(targetHost);
      for (const raw of rawItems) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        if (readString(item, 'type') !== 'organic') continue;
        const domain = readString(item, 'domain');
        if (!domain || bareHost(domain) !== target) continue;
        return {
          position: readNumber(item, 'rank_group') ?? readNumber(item, 'rank_absolute'),
          rankingUrl: readString(item, 'url'),
        };
      }
      return { position: null, rankingUrl: null };
    },

    async getAccountInfo() {
      const body = await getJson(`${apiBase}/appendix/user_data`, headers, fetchImpl, timeoutMs);
      const envelope = body as Record<string, unknown>;
      const envelopeStatus = readNumber(envelope, 'status_code');
      if (envelopeStatus !== null && envelopeStatus !== 20000) {
        throwRankTrackingStatus(envelopeStatus, readString(envelope, 'status_message'));
      }
      const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
      const task = tasks[0] as Record<string, unknown> | undefined;
      const taskStatus = task ? readNumber(task, 'status_code') : null;
      if (taskStatus !== null && taskStatus !== 20000) {
        throwRankTrackingStatus(taskStatus, task ? readString(task, 'status_message') : null);
      }
      const results = task && Array.isArray(task.result) ? task.result : [];
      const first = results[0] as Record<string, unknown> | undefined;
      if (!first) throw new RankTrackingError('rank_tracking_provider_error');

      const money = (first.money && typeof first.money === 'object' ? first.money : {}) as Record<string, unknown>;
      const balance = readNumber(money, 'balance') ?? readNumber(first, 'money_balance') ?? readNumber(first, 'balance');
      const currency = readString(money, 'currency') || readString(first, 'currency') || 'USD';
      return { balance, currency };
    },
  };
}
