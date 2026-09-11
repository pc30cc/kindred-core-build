/**
 * DATAFORSEO KEYWORDS ADAPTER
 *
 * Wraps DataForSEO's Keywords Data API (`POST
 * /v3/keywords_data/google_ads/search_volume/live`, the synchronous "live"
 * variant) behind a narrow, promise-based interface. Same auth (HTTP Basic,
 * login:password) and response envelope as the backlinks adapter — see
 * server/services/seo/backlinks/providers/dataforseo.ts's header comment
 * for the shared field-mapping caveat (written against DataForSEO's
 * long-stable v3 conventions, not verified against a live response from
 * this sandboxed environment; re-verify on first live test).
 *
 * Documented response fields consumed here: `items[].keyword`,
 * `search_volume`, `cpc`, `competition` (0..1), `competition_index`
 * (0..100). `competition_level` is derived locally from `competition`
 * since the live endpoint does not return a label directly.
 */
import {
  KeywordsError,
  type KeywordResultItem,
  type KeywordsAccountInfo,
  type KeywordsFetchResult,
  type DataForSeoKeywordsConfig,
  type RankedKeywordItem,
  type RankedKeywordsFetchResult,
} from '../types.js';

export const DATAFORSEO_TIMEOUT_MS = 30_000;
export const DATAFORSEO_API_BASE = 'https://api.dataforseo.com/v3';
const DEFAULT_LOCATION_CODE = 2840; // United States
const DEFAULT_LANGUAGE_CODE = 'en';

export interface DataForSeoKeywordsAdapter {
  fetchKeywordData(input: { keywords: string[] }): Promise<KeywordsFetchResult>;
  fetchRankedKeywords(input: { target: string; limit: number }): Promise<RankedKeywordsFetchResult>;
  getAccountInfo(): Promise<KeywordsAccountInfo>;
}

export interface DataForSeoKeywordsAdapterOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiBase?: string;
}

function authHeader(config: DataForSeoKeywordsConfig): string {
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
    if (res.status === 401 || res.status === 403) throw new KeywordsError('keywords_auth_failed');
    if (res.status === 429) throw new KeywordsError('keywords_rate_limited');
    if (!res.ok) throw new KeywordsError('keywords_provider_error');
    try {
      return await res.json();
    } catch {
      throw new KeywordsError('keywords_provider_error');
    }
  } catch (err) {
    if (err instanceof KeywordsError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') throw new KeywordsError('keywords_timeout');
    throw new KeywordsError('keywords_network_error');
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
    if (res.status === 401 || res.status === 403) throw new KeywordsError('keywords_auth_failed');
    if (res.status === 429) throw new KeywordsError('keywords_rate_limited');
    if (!res.ok) throw new KeywordsError('keywords_provider_error');
    try {
      return await res.json();
    } catch {
      throw new KeywordsError('keywords_provider_error');
    }
  } catch (err) {
    if (err instanceof KeywordsError) throw err;
    if ((err as { name?: string })?.name === 'AbortError') throw new KeywordsError('keywords_timeout');
    throw new KeywordsError('keywords_network_error');
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
 *  - 40100 bad credentials, 40104 account not verified
 *  - 40204 API subscription required, 40207 IP not whitelisted
 *  - 40200/40203/40210      → balance / cost limit
 *  - 40202/40209/42900      → rate limits
 *  - 404xx/405xx            → invalid request fields
 */
function throwKeywordsStatus(status: number, message: string | null): never {
  if (status === 40104) throw new KeywordsError('keywords_account_unverified', message);
  if (status === 40100) throw new KeywordsError('keywords_auth_failed', message);
  if (status === 40204) throw new KeywordsError('keywords_subscription_required', message);
  if (status === 40207) throw new KeywordsError('keywords_ip_not_allowed', message);
  if (status === 40200 || status === 40203 || status === 40210) throw new KeywordsError('keywords_insufficient_credit', message);
  if (status === 40202 || status === 40209 || status === 42900) throw new KeywordsError('keywords_rate_limited', message);
  if (status >= 40400 && status < 40600) throw new KeywordsError('keywords_invalid_input', message);
  throw new KeywordsError('keywords_provider_error', message);
}



function readNumber(source: Record<string, unknown>, key: string): number | null {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function competitionLevel(competition: number | null): 'low' | 'medium' | 'high' | null {
  if (competition === null) return null;
  if (competition < 0.33) return 'low';
  if (competition < 0.66) return 'medium';
  return 'high';
}

/**
 * Google Ads search_volume/live returns `competition` as a LABEL string
 * ("HIGH" | "MEDIUM" | "LOW") and `competition_index` as 0..100 — it does not
 * return a 0..1 float. The normalized 0..1 value is derived from
 * competition_index, with the label falling back to the derived value.
 */
function parseItem(raw: unknown): KeywordResultItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const keyword = readString(item, 'keyword');
  if (!keyword) return null;

  const index = readNumber(item, 'competition_index');
  const rawCompetition = item.competition;
  const label = typeof rawCompetition === 'string' ? rawCompetition.trim().toLowerCase() : null;
  const numericCompetition =
    index !== null
      ? Math.max(0, Math.min(1, index / 100))
      : typeof rawCompetition === 'number' && Number.isFinite(rawCompetition)
        ? rawCompetition
        : null;

  return {
    keyword,
    searchVolume: readNumber(item, 'search_volume'),
    cpc: readNumber(item, 'cpc'),
    competition: numericCompetition,
    competitionLevel:
      label === 'low' || label === 'medium' || label === 'high' ? label : competitionLevel(numericCompetition),
  };
}


/**
 * Parses one item of DataForSEO Labs' Ranked Keywords report
 * (`dataforseo_labs/google/ranked_keywords/live`). FIELD-MAPPING NOTE: same
 * caveat as parseItem above — written against DataForSEO's documented v3
 * conventions (`keyword_data.keyword`, `keyword_data.keyword_info.{search_volume,
 * cpc,competition}`, `ranked_serp_element.serp_item.{rank_absolute,relative_url,
 * url,etv}`), not verified against a live response from this sandboxed
 * environment. Every field is optional-safe; only `keyword_data.keyword` is
 * required per item.
 */
function parseRankedItem(raw: unknown): RankedKeywordItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const keywordData = (item.keyword_data && typeof item.keyword_data === 'object' ? item.keyword_data : {}) as Record<string, unknown>;
  const keyword = readString(keywordData, 'keyword');
  if (!keyword) return null;
  const keywordInfo = (keywordData.keyword_info && typeof keywordData.keyword_info === 'object' ? keywordData.keyword_info : {}) as Record<string, unknown>;

  const rankedElement = (item.ranked_serp_element && typeof item.ranked_serp_element === 'object' ? item.ranked_serp_element : {}) as Record<string, unknown>;
  const serpItem = (rankedElement.serp_item && typeof rankedElement.serp_item === 'object' ? rankedElement.serp_item : {}) as Record<string, unknown>;

  return {
    keyword,
    searchVolume: readNumber(keywordInfo, 'search_volume'),
    cpc: readNumber(keywordInfo, 'cpc'),
    competition: readNumber(keywordInfo, 'competition'),
    position: readNumber(serpItem, 'rank_absolute'),
    rankingUrl: readString(serpItem, 'url') || readString(serpItem, 'relative_url'),
    trafficEstimate: readNumber(serpItem, 'etv'),
  };
}

export function createDataForSeoKeywordsAdapter(
  config: DataForSeoKeywordsConfig,
  options: DataForSeoKeywordsAdapterOptions = {},
): DataForSeoKeywordsAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DATAFORSEO_TIMEOUT_MS;
  const apiBase = options.apiBase ?? DATAFORSEO_API_BASE;
  const headers = { Authorization: authHeader(config) };

  return {
    async fetchKeywordData({ keywords }) {
      if (!keywords.length) return { items: [] };
      const body = await postJson(
        `${apiBase}/keywords_data/google_ads/search_volume/live`,
        [{ keywords: keywords.slice(0, 1000), location_code: DEFAULT_LOCATION_CODE, language_code: DEFAULT_LANGUAGE_CODE }],
        headers,
        fetchImpl,
        timeoutMs,
      );
      const envelope = body as Record<string, unknown>;
      const envelopeStatus = readNumber(envelope, 'status_code');
      if (envelopeStatus !== null && envelopeStatus !== 20000) {
        throwKeywordsStatus(envelopeStatus, readString(envelope, 'status_message'));
      }
      const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
      const task = tasks[0] as Record<string, unknown> | undefined;
      if (!task) throw new KeywordsError('keywords_provider_error');
      const taskStatus = readNumber(task, 'status_code');
      if (taskStatus !== null && taskStatus !== 20000) {
        throwKeywordsStatus(taskStatus, readString(task, 'status_message'));
      }

      const results = Array.isArray(task.result) ? task.result : [];
      const items: KeywordResultItem[] = [];
      for (const raw of results) {
        const parsed = parseItem(raw);
        if (parsed) items.push(parsed);
      }
      return { items };
    },

    async fetchRankedKeywords({ target, limit }) {
      const body = await postJson(
        `${apiBase}/dataforseo_labs/google/ranked_keywords/live`,
        [{
          target,
          location_code: DEFAULT_LOCATION_CODE,
          language_code: DEFAULT_LANGUAGE_CODE,
          limit: Math.max(1, Math.min(limit, 1000)),
          // default is ["organic","paid"]; we only report organic rankings
          item_types: ['organic'],
          order_by: ['keyword_data.keyword_info.search_volume,desc'],
        }],
        headers,
        fetchImpl,
        timeoutMs,
      );
      const envelope = body as Record<string, unknown>;
      const envelopeStatus = readNumber(envelope, 'status_code');
      if (envelopeStatus !== null && envelopeStatus !== 20000) {
        throwKeywordsStatus(envelopeStatus, readString(envelope, 'status_message'));
      }
      const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
      const task = tasks[0] as Record<string, unknown> | undefined;
      if (!task) throw new KeywordsError('keywords_provider_error');
      const taskStatus = readNumber(task, 'status_code');
      if (taskStatus !== null && taskStatus !== 20000) {
        throwKeywordsStatus(taskStatus, readString(task, 'status_message'));
      }

      const results = Array.isArray(task.result) ? task.result : [];
      const first = results[0] as Record<string, unknown> | undefined;
      const rawItems = first && Array.isArray(first.items) ? first.items : [];

      const items: RankedKeywordItem[] = [];
      for (const raw of rawItems) {
        const parsed = parseRankedItem(raw);
        if (parsed) items.push(parsed);
      }
      return { items, totalCount: readNumber(first || {}, 'total_count') ?? items.length };
    },

    async getAccountInfo() {
      const body = await getJson(`${apiBase}/appendix/user_data`, headers, fetchImpl, timeoutMs);
      const envelope = body as Record<string, unknown>;
      const envelopeStatus = readNumber(envelope, 'status_code');
      if (envelopeStatus !== null && envelopeStatus !== 20000) {
        throwKeywordsStatus(envelopeStatus, readString(envelope, 'status_message'));
      }
      const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
      const task = tasks[0] as Record<string, unknown> | undefined;
      const taskStatus = task ? readNumber(task, 'status_code') : null;
      if (taskStatus !== null && taskStatus !== 20000 && task) {
        throwKeywordsStatus(taskStatus, readString(task, 'status_message'));
      }
      const results = task && Array.isArray(task.result) ? task.result : [];
      const first = results[0] as Record<string, unknown> | undefined;
      if (!first) throw new KeywordsError('keywords_provider_error');
      const money = (first.money && typeof first.money === 'object' ? first.money : {}) as Record<string, unknown>;
      const balance = readNumber(money, 'balance') ?? readNumber(first, 'money_balance') ?? readNumber(first, 'balance');
      const currency = readString(money, 'currency') || readString(first, 'currency') || 'USD';
      return { balance, currency };
    },
  };
}
