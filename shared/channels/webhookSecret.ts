/**
 * PURE shared module — safe to import from Core Backend and the Channels
 * Gateway alike. It has no I/O, no database client, no framework imports, so
 * it never creates a same-process coupling between the two deployables.
 *
 * The Telegram `secret_token` for an integration is DERIVED, never stored:
 *
 *   secret = base64url(HMAC-SHA256(CHANNELS_WEBHOOK_SIGNING_KEY,
 *                                  `telegram:${publicIntegrationId}`))
 *
 * Core derives it when calling setWebhook; the Gateway independently derives
 * the same value from the public integration id in the request URL and
 * compares in constant time. No DB lookup is required to verify a webhook.
 *
 * Rotating CHANNELS_WEBHOOK_SIGNING_KEY invalidates every registered webhook
 * and requires re-registration (see the `telegram_webhook_repair` job).
 *
 * Never log the signing key, the derived secret, or the raw header value.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Telegram allows 1-256 chars of A-Z a-z 0-9 _ - in secret_token. base64url qualifies. */
export function deriveChannelWebhookSecret(
  signingKey: string,
  provider: string,
  publicIntegrationId: string,
): string {
  if (!signingKey) throw new Error('CHANNELS_WEBHOOK_SIGNING_KEY is not configured');
  if (!publicIntegrationId) throw new Error('publicIntegrationId is required');
  return createHmac('sha256', signingKey)
    .update(`${provider}:${publicIntegrationId}`)
    .digest('base64url');
}

/**
 * Constant-time comparison that tolerates length mismatch, null input and
 * any bytes. Lengths are compared on the UTF-8 bytes, not the JS string: a
 * header with a non-ASCII character of the same character length used to
 * reach timingSafeEqual with buffers of different lengths, which throws.
 */
export function safeSecretEqual(actual: string | null | undefined, expected: string): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Startup guard: the webhook signing key must be its own secret. Reusing the
 * internal service secret, the plugin master key, the service-role key or a
 * bot token is rejected outright.
 */
export function assertDistinctSigningKey(
  signingKey: string | undefined,
  forbidden: Array<string | undefined>,
): void {
  if (!signingKey) return;
  for (const other of forbidden) {
    if (other && other === signingKey) {
      throw new Error(
        'CHANNELS_WEBHOOK_SIGNING_KEY must not reuse another secret (internal secret, master key, service-role key or bot token)',
      );
    }
  }
}
