/**
 * Platform support — the rules for what an operator may send, kept apart
 * from any I/O so they are tested as plain functions.
 */

export const MAX_BODY_LENGTH = 4000;
export const MAX_RATING_COMMENT_LENGTH = 1000;
/** A file the operator attaches: 2 MB, decoded. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** What an operator may attach — the chat widget's own list. */
export const ALLOWED_FILE_TYPES: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['application/pdf', 'pdf'],
  ['text/plain', 'txt'],
]);

/** Collapses what a composer adds around a message; null when nothing is left. */
export function normalizeBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n?/g, '\n').split('\u0000').join('').trim();
  if (!text || text.length > MAX_BODY_LENGTH) return null;
  return text;
}

/** A client message id: a uuid or a short opaque token the app minted. */
export function normalizeClientMessageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

/** The first line of a message as a conversation subject in the inbox. */
export function subjectFromBody(body: string): string {
  const line = body.split('\n').find((part) => part.trim()) ?? body;
  const trimmed = line.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

/** 1–5 stars; anything else is not a rating. */
export function normalizeScore(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : null;
}

/** An optional comment: trimmed, null when empty; undefined when too long. */
export function normalizeRatingComment(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(/\r\n?/g, '\n').split('\u0000').join('').trim();
  if (!text) return null;
  return text.length > MAX_RATING_COMMENT_LENGTH ? undefined : text;
}

/**
 * The app a request came from, from `X-Client-Platform`. The apps send it;
 * a browser does not, and is the web console.
 */
export type ClientPlatform = 'android' | 'ios' | 'macos' | 'windows' | 'web';

export function clientPlatformOf(raw: unknown): ClientPlatform {
  const value = String(Array.isArray(raw) ? raw[0] : raw ?? '').trim().toLowerCase();
  return value === 'android' || value === 'ios' || value === 'macos' || value === 'windows' ? value : 'web';
}

/**
 * A file name as the team will see it: no path, no control characters, at
 * most 120 characters, and the extension its type says it has.
 */
export function supportFileName(raw: unknown, mimeType: string): string {
  const ext = ALLOWED_FILE_TYPES.get(mimeType) ?? 'bin';
  const base = String(raw ?? '')
    .split(/[\\/]/)
    .pop()!
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch !== '"')
    .join('')
    .trim()
    .replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const stem = (base || 'file').slice(0, 110);
  return `${stem}.${ext}`;
}

/** What the transcript calls a file, from its type. */
export function attachmentKind(mimeType: string): 'image' | 'audio' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * A sliding-window limit per key, in this process's memory.
 *
 * Enough to stop a loop in an app or a hand on the send button from filling
 * the support team's inbox; not an abuse wall across instances.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Records a hit and says whether it is within the limit. */
  take(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(since);
    return true;
  }

  private prune(since: number): void {
    for (const [key, times] of this.hits) {
      if (!times.some((at) => at > since)) this.hits.delete(key);
    }
  }
}
