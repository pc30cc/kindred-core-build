/**
 * BOT ANALYTICS — log import ingestion.
 *
 * A workspace uploads its own web-server/CDN access log (base64 in the
 * request body, matching the existing storage upload convention —
 * server/routes/storage.ts). Every line is parsed (logParser.ts) and its
 * User-Agent classified (signatures.ts); only lines that match a known bot
 * signature are kept — human traffic in the log is irrelevant here and is
 * discarded, never stored. This keeps `bot_visits` honest: every row is a
 * real request from something that identifies itself as a crawler/bot.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { parseLogContent } from './logParser.js';
import { classifyBot } from './signatures.js';

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB raw log content
const INSERT_BATCH_SIZE = 1000;

export class BotImportError extends Error {
  reason: 'too_large' | 'empty' | 'no_bot_lines' | 'limit_reached';
  constructor(reason: BotImportError['reason']) {
    super(reason);
    this.reason = reason;
  }
}

export interface ImportSummary {
  id: string;
  filename: string;
  format: string;
  totalLines: number;
  matchedBotLines: number;
  unparsedLines: number;
  truncated: boolean;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  createdAt: string;
}

export async function createImport(
  config: ServerConfig,
  args: { workspaceId: string; userId: string; filename: string; content: string; maxLines: number },
): Promise<ImportSummary> {
  const byteLength = Buffer.byteLength(args.content, 'utf-8');
  if (byteLength > MAX_UPLOAD_BYTES) throw new BotImportError('too_large');
  if (!args.content.trim()) throw new BotImportError('empty');

  const parsed = parseLogContent(args.content, args.maxLines);
  const botLines = parsed.lines
    .map((line) => {
      const match = classifyBot(line.userAgent);
      return match ? { ...line, ...match } : null;
    })
    .filter((l): l is NonNullable<typeof l> => l !== null);

  if (botLines.length === 0) throw new BotImportError('no_bot_lines');

  const sb = getServiceClient(config);
  const timestamps = botLines.map((l) => l.timestamp).sort();
  const dateRangeStart = timestamps[0] || null;
  const dateRangeEnd = timestamps[timestamps.length - 1] || null;

  const { data: importRow, error: importError } = await sb
    .from('bot_log_imports')
    .insert({
      workspace_id: args.workspaceId,
      filename: args.filename.slice(0, 255),
      format: 'auto',
      total_lines: parsed.totalLines,
      matched_bot_lines: botLines.length,
      date_range_start: dateRangeStart,
      date_range_end: dateRangeEnd,
      created_by: args.userId,
    })
    .select('*')
    .single();
  if (importError || !importRow) throw new Error(`bot_import_create_failed: ${importError?.message}`);

  const importId = (importRow as { id: string }).id;
  for (let i = 0; i < botLines.length; i += INSERT_BATCH_SIZE) {
    const batch = botLines.slice(i, i + INSERT_BATCH_SIZE).map((l) => ({
      workspace_id: args.workspaceId,
      import_id: importId,
      bot_name: l.botName,
      bot_category: l.category,
      user_agent: l.userAgent.slice(0, 1000),
      path: l.path.slice(0, 2048),
      method: l.method,
      status_code: l.statusCode,
      ip: l.ip,
      visited_at: l.timestamp,
    }));
    const { error: insertError } = await sb.from('bot_visits').insert(batch);
    if (insertError) {
      // Roll back the partial import rather than leaving an inconsistent row.
      await sb.from('bot_log_imports').delete().eq('id', importId);
      throw new Error(`bot_visits_insert_failed: ${insertError.message}`);
    }
  }

  return {
    id: importId,
    filename: (importRow as { filename: string }).filename,
    format: 'auto',
    totalLines: parsed.totalLines,
    matchedBotLines: botLines.length,
    unparsedLines: parsed.unparsedLines,
    truncated: parsed.truncated,
    dateRangeStart,
    dateRangeEnd,
    createdAt: (importRow as { created_at: string }).created_at,
  };
}

export async function listImports(config: ServerConfig, workspaceId: string): Promise<ImportSummary[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('bot_log_imports')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`list_bot_imports_failed: ${error.message}`);
  return ((data || []) as Array<Record<string, any>>).map((row) => ({
    id: row.id,
    filename: row.filename,
    format: row.format,
    totalLines: row.total_lines,
    matchedBotLines: row.matched_bot_lines,
    unparsedLines: 0,
    truncated: false,
    dateRangeStart: row.date_range_start,
    dateRangeEnd: row.date_range_end,
    createdAt: row.created_at,
  }));
}

export async function deleteImport(config: ServerConfig, workspaceId: string, importId: string): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('bot_log_imports').delete().eq('workspace_id', workspaceId).eq('id', importId);
}

export async function hasAnyImport(config: ServerConfig, workspaceId: string): Promise<boolean> {
  const sb = getServiceClient(config);
  const { count } = await sb.from('bot_log_imports').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
  return (count || 0) > 0;
}
