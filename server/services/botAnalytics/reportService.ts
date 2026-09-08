/**
 * BOT ANALYTICS — reporting layer over `bot_visits` (populated by log
 * imports — see importService.ts and the header comment of
 * database/migrations/146_bot_analytics.sql for why this cannot be a
 * Web-Analytics-style always-on JS beacon).
 *
 * Same bounded-aggregation tradeoff as Web Analytics
 * (../webAnalytics/reportService.ts): a capped row set per date range,
 * aggregated in-process, with `truncated` surfaced rather than silently
 * dropping data.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { BOT_CATEGORY_LABELS, type BotCategory } from './signatures.js';
import { hasAnyImport } from './importService.js';

const ROW_CAP = 20_000;

export interface DateRange {
  startDate: string;
  endDate: string;
}

function rangeToTimestamps(range: DateRange): { startIso: string; endIso: string } {
  const start = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${range.endDate}T23:59:59.999Z`);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

interface BotVisitRow {
  bot_name: string;
  bot_category: BotCategory;
  path: string;
  visited_at: string;
}

async function loadBotVisits(config: ServerConfig, workspaceId: string, range: DateRange): Promise<{ visits: BotVisitRow[]; truncated: boolean }> {
  const sb = getServiceClient(config);
  const { startIso, endIso } = rangeToTimestamps(range);
  const { data, error } = await sb
    .from('bot_visits')
    .select('bot_name, bot_category, path, visited_at')
    .eq('workspace_id', workspaceId)
    .gte('visited_at', startIso)
    .lte('visited_at', endIso)
    .order('visited_at', { ascending: true })
    .limit(ROW_CAP);
  if (error) throw new Error(`bot_visits_query_failed: ${error.message}`);
  const visits = (data || []) as BotVisitRow[];
  return { visits, truncated: visits.length >= ROW_CAP };
}

export interface BreakdownRow {
  key: string;
  label: string;
  visits: number;
}

// ─── Overview ───────────────────────────────────────────────────────────

export interface BotOverviewStats {
  hasImports: boolean;
  totalVisits: number;
  uniqueBots: number;
  uniquePaths: number;
  trend: Array<{ date: string; visits: number }>;
  topBots: BreakdownRow[];
  topCategories: BreakdownRow[];
  truncated: boolean;
}

export async function getOverview(config: ServerConfig, workspaceId: string, range: DateRange): Promise<BotOverviewStats> {
  const [{ visits, truncated }, hasImports] = await Promise.all([
    loadBotVisits(config, workspaceId, range),
    hasAnyImport(config, workspaceId),
  ]);

  const byDate = new Map<string, number>();
  const byBot = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const paths = new Set<string>();
  for (const v of visits) {
    const day = v.visited_at.slice(0, 10);
    byDate.set(day, (byDate.get(day) || 0) + 1);
    byBot.set(v.bot_name, (byBot.get(v.bot_name) || 0) + 1);
    byCategory.set(v.bot_category, (byCategory.get(v.bot_category) || 0) + 1);
    paths.add(v.path);
  }

  const trend = Array.from(byDate.entries()).map(([date, count]) => ({ date, visits: count })).sort((a, b) => (a.date < b.date ? -1 : 1));
  const topBots = Array.from(byBot.entries()).map(([key, count]) => ({ key, label: key, visits: count })).sort((a, b) => b.visits - a.visits).slice(0, 8);
  const topCategories = Array.from(byCategory.entries())
    .map(([key, count]) => ({ key, label: BOT_CATEGORY_LABELS[key as BotCategory] || key, visits: count }))
    .sort((a, b) => b.visits - a.visits);

  return {
    hasImports,
    totalVisits: visits.length,
    uniqueBots: byBot.size,
    uniquePaths: paths.size,
    trend,
    topBots,
    topCategories,
    truncated,
  };
}

// ─── Categories ─────────────────────────────────────────────────────────

export async function getCategories(config: ServerConfig, workspaceId: string, range: DateRange): Promise<{ rows: Array<BreakdownRow & { uniqueBots: number }>; truncated: boolean }> {
  const { visits, truncated } = await loadBotVisits(config, workspaceId, range);
  const buckets = new Map<string, { visits: number; bots: Set<string> }>();
  for (const v of visits) {
    const bucket = buckets.get(v.bot_category) || { visits: 0, bots: new Set<string>() };
    bucket.visits += 1;
    bucket.bots.add(v.bot_name);
    buckets.set(v.bot_category, bucket);
  }
  const rows = Array.from(buckets.entries())
    .map(([key, v]) => ({ key, label: BOT_CATEGORY_LABELS[key as BotCategory] || key, visits: v.visits, uniqueBots: v.bots.size }))
    .sort((a, b) => b.visits - a.visits);
  return { rows, truncated };
}

// ─── Crawled pages ──────────────────────────────────────────────────────

export interface CrawledPageRow {
  path: string;
  visits: number;
  uniqueBots: number;
  topBot: string;
}

export async function getCrawledPages(config: ServerConfig, workspaceId: string, range: DateRange): Promise<{ rows: CrawledPageRow[]; truncated: boolean }> {
  const { visits, truncated } = await loadBotVisits(config, workspaceId, range);
  const buckets = new Map<string, { visits: number; bots: Map<string, number> }>();
  for (const v of visits) {
    const bucket = buckets.get(v.path) || { visits: 0, bots: new Map<string, number>() };
    bucket.visits += 1;
    bucket.bots.set(v.bot_name, (bucket.bots.get(v.bot_name) || 0) + 1);
    buckets.set(v.path, bucket);
  }
  const rows = Array.from(buckets.entries())
    .map(([path, v]) => {
      const topBot = Array.from(v.bots.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      return { path, visits: v.visits, uniqueBots: v.bots.size, topBot };
    })
    .sort((a, b) => b.visits - a.visits);
  return { rows, truncated };
}

// ─── AI bots (the dedicated LLM/AI-crawler view) ───────────────────────

export interface AiBotRow {
  botName: string;
  visits: number;
  uniquePaths: number;
  lastSeen: string;
}

export async function getAiBots(config: ServerConfig, workspaceId: string, range: DateRange): Promise<{ rows: AiBotRow[]; totalAiVisits: number; totalVisits: number; truncated: boolean }> {
  const { visits, truncated } = await loadBotVisits(config, workspaceId, range);
  const buckets = new Map<string, { visits: number; paths: Set<string>; lastSeen: string }>();
  let totalAiVisits = 0;
  for (const v of visits) {
    if (v.bot_category !== 'ai_assistant') continue;
    totalAiVisits += 1;
    const bucket = buckets.get(v.bot_name) || { visits: 0, paths: new Set<string>(), lastSeen: v.visited_at };
    bucket.visits += 1;
    bucket.paths.add(v.path);
    if (v.visited_at > bucket.lastSeen) bucket.lastSeen = v.visited_at;
    buckets.set(v.bot_name, bucket);
  }
  const rows = Array.from(buckets.entries())
    .map(([botName, v]) => ({ botName, visits: v.visits, uniquePaths: v.paths.size, lastSeen: v.lastSeen }))
    .sort((a, b) => b.visits - a.visits);
  return { rows, totalAiVisits, totalVisits: visits.length, truncated };
}
