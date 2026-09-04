/**
 * AI Proactive Nudge — trusted session lineage.
 *
 * This is the ONLY identity ever used to gate AI evaluation quota,
 * cooldown, per-session display caps, dedup, and AI billing operation
 * identity for this feature. It is derived from the widget token's nonce
 * (server/services/widget/security.ts's enforceWidgetToken sets
 * `req._widgetNonce` from the verified token) — a random, server-minted
 * value that stays STABLE across token refresh within one logical widget
 * session (see widget.ts's /session/refresh, which threads the same nonce
 * forward) and can never be rotated or forged by the browser.
 *
 * A client-supplied `session_id` or `visitor_id` must NEVER be used for
 * any of the above — they remain purely display/debug fields, exactly
 * like every other widget route's precedence of the signed visitor cookie
 * over client-supplied identity.
 */
import { createHash } from 'node:crypto';
import type { Request } from 'express';

/** Pure function — sha256("ai-nudge-session:" + nonce), hex-encoded. */
export function hashTrustedNudgeSession(nonce: string): string {
  return createHash('sha256').update('ai-nudge-session:' + nonce).digest('hex');
}

/**
 * Reads the nonce enforceWidgetToken already verified on this request and
 * derives the trusted session key. Returns null when no verified widget
 * token context exists — callers MUST fail closed in that case (suppress),
 * never fall back to a client-supplied identifier.
 */
export function resolveTrustedNudgeSessionKey(req: Request): string | null {
  const nonce = (req as any)._widgetNonce;
  if (typeof nonce !== 'string' || !nonce) return null;
  return hashTrustedNudgeSession(nonce);
}
