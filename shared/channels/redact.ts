/**
 * Credential redaction shared by Core, the Channels Gateway and the Channels
 * Worker.
 *
 * Lives in `shared/` on purpose: Core must be able to redact provider
 * credentials out of error strings WITHOUT importing a provider client (those
 * live in `channels/providers/**` and are the only code allowed to open a
 * socket to a provider).
 */

/** Redacts any Telegram-shaped bot token accidentally present in a string. */
export function redactToken(text: string): string {
  return String(text).replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[REDACTED_BOT_TOKEN]');
}
