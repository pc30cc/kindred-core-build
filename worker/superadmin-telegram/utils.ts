export interface TelegramMessageLike {
  message_id?: number;
  text?: string;
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string; is_bot?: boolean };
}

export function parseAllowedUserIds(raw: string | undefined): Set<string> {
  return new Set(
    String(raw || '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => /^\d+$/.test(v)),
  );
}

export function isAuthorizedPrivateMessage(
  message: TelegramMessageLike | null | undefined,
  allowedUserIds: Set<string>,
): boolean {
  if (!message?.from?.id || message.from.is_bot) return false;
  if (message.chat?.type !== 'private') return false;
  return allowedUserIds.has(String(message.from.id));
}

export function normalizeQuestion(text: string | undefined, maxChars = 4_000): string {
  return String(text || '').replace(/\u0000/g, '').trim().slice(0, maxChars);
}

export function splitTelegramText(text: string, maxChars = 3_800): string[] {
  const source = String(text || '').trim();
  if (!source) return ['پاسخی تولید نشد.'];
  if (source.length <= maxChars) return [source];

  const chunks: string[] = [];
  let rest = source;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const cut = breakAt > maxChars * 0.55 ? breakAt : maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class InMemoryRateGate {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow = 12,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const current = (this.hits.get(key) || []).filter((ts) => ts > cutoff);
    if (current.length >= this.maxPerWindow) {
      this.hits.set(key, current);
      return false;
    }
    current.push(now);
    this.hits.set(key, current);
    if (this.hits.size > 100) {
      for (const [k, values] of this.hits) {
        if (!values.some((ts) => ts > cutoff)) this.hits.delete(k);
      }
    }
    return true;
  }
}
