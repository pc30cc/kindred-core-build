/**
 * Platform support — the rules for what an operator may send, kept apart
 * from any I/O so they are tested as plain functions.
 */

export const MAX_BODY_LENGTH = 4000;
export const MAX_SUBJECT_LENGTH = 200;

/** Collapses what a composer adds around a message; null when nothing is left. */
export function normalizeBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n?/g, '\n').replaceAll('\u0000', '').trim();
  if (!text || text.length > MAX_BODY_LENGTH) return null;
  return text;
}

/** One line, trimmed; null when empty or too long. */
export function normalizeSubject(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\r\n\t]+/g, ' ').replaceAll('\u0000', '').replace(/\s{2,}/g, ' ').trim();
  if (!text || text.length > MAX_SUBJECT_LENGTH) return null;
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

/**
 * What a person typed, made safe for an email template.
 *
 * Templates are interpolated as HTML (server/services/email/index.ts) with
 * `String.replace`, so markup is escaped and `$` — which `replace` would
 * read as a back-reference — is doubled.
 */
export function templateValue(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\$/g, '$$$$');
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
