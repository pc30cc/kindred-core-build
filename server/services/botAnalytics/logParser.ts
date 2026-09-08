/**
 * Access-log parsing — turns raw uploaded log text into normalized request
 * lines. Supports the two formats that cover the vast majority of real
 * exports:
 *   - Combined Log Format (the nginx/Apache default: `log_format combined`).
 *   - JSON Lines, one request object per line — the shape most CDN "export
 *     logs as JSON" features produce (Cloudflare Logpush, load balancer
 *     exports, custom scripts). Recognized keys are intentionally liberal
 *     (ip/clientIP, path/uri/url, userAgent/user_agent, ...) since exporters
 *     don't agree on casing.
 * Format is auto-detected per line; a file may even mix the two (rare, but
 * harmless) since detection happens line by line.
 */

export interface ParsedLogLine {
  ip: string | null;
  method: string | null;
  path: string;
  statusCode: number | null;
  userAgent: string;
  timestamp: string;
}

export interface ParseResult {
  lines: ParsedLogLine[];
  totalLines: number;
  unparsedLines: number;
  truncated: boolean;
}

// e.g. 203.0.113.5 - - [10/Sep/2026:14:32:01 +0000] "GET /pricing HTTP/1.1" 200 5321 "-" "Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)"
const COMBINED_LOG_RE =
  /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z]+)\s+(\S+)\s+[^"]*"\s+(\d{3})\s+\S+\s+"[^"]*"\s+"([^"]*)"/;

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** `10/Sep/2026:14:32:01 +0000` -> ISO 8601. Falls back to `now` for an unparseable stamp rather than dropping the line. */
function parseCombinedLogTimestamp(raw: string): string {
  const m = /^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?/.exec(raw);
  if (!m) return new Date().toISOString();
  const [, day, monAbbr, year, hh, mm, ss, tz] = m;
  const month = MONTHS[monAbbr];
  if (!month) return new Date().toISOString();
  const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : '+00:00';
  const iso = `${year}-${month}-${day}T${hh}:${mm}:${ss}${offset}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function parseCombinedLine(line: string): ParsedLogLine | null {
  const m = COMBINED_LOG_RE.exec(line);
  if (!m) return null;
  const [, ip, rawTs, method, rawPath, status, ua] = m;
  if (!ua) return null;
  return {
    ip: ip === '-' ? null : ip,
    method: method || null,
    path: rawPath.split('?')[0] || '/',
    statusCode: Number.parseInt(status, 10) || null,
    userAgent: ua,
    timestamp: parseCombinedLogTimestamp(rawTs),
  };
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function parseJsonLine(line: string): ParsedLogLine | null {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const userAgent = firstString(obj, ['userAgent', 'user_agent', 'ClientRequestUserAgent', 'uaString']);
  if (!userAgent) return null;

  const rawPath = firstString(obj, ['path', 'uri', 'url', 'ClientRequestURI', 'ClientRequestPath', 'request_uri']) || '/';
  const method = firstString(obj, ['method', 'ClientRequestMethod', 'request_method']);
  const ip = firstString(obj, ['ip', 'clientIP', 'ClientIP', 'remote_addr']);
  const statusRaw = obj.status ?? obj.statusCode ?? obj.EdgeResponseStatus ?? obj.status_code;
  const statusCode = typeof statusRaw === 'number' ? statusRaw : (typeof statusRaw === 'string' ? Number.parseInt(statusRaw, 10) : null);
  const timestampRaw = firstString(obj, ['timestamp', 'time', 'EdgeStartTimestamp', 'datetime', '@timestamp']);
  const timestamp = timestampRaw ? (Number.isNaN(new Date(timestampRaw).getTime()) ? new Date().toISOString() : new Date(timestampRaw).toISOString()) : new Date().toISOString();

  return {
    ip,
    method,
    path: rawPath.split('?')[0] || '/',
    statusCode: Number.isFinite(statusCode) ? (statusCode as number) : null,
    userAgent,
    timestamp,
  };
}

/**
 * Parses at most `maxLines` non-empty lines (bounded, same tradeoff as
 * Web Analytics' ROW_CAP — a `truncated` flag is surfaced rather than
 * silently dropping the remainder of a larger file).
 */
export function parseLogContent(content: string, maxLines: number): ParseResult {
  const allLines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const truncated = allLines.length > maxLines;
  const toParse = truncated ? allLines.slice(0, maxLines) : allLines;

  const lines: ParsedLogLine[] = [];
  let unparsedLines = 0;
  for (const raw of toParse) {
    const parsed = parseJsonLine(raw) || parseCombinedLine(raw);
    if (parsed) lines.push(parsed);
    else unparsedLines += 1;
  }

  return { lines, totalLines: toParse.length, unparsedLines, truncated };
}
