/**
 * Shared, side-effect-free constants for the Gmail channel plugin — the
 * plugin_secrets key name, importable from BOTH Core
 * (server/services/channels/gmail/oauth.ts, which writes it) and the
 * Channels Worker (worker/channels/index.ts, which reads it via
 * resolveIntegrationToken), without pulling either side's DB/crypto
 * dependencies into the other.
 */

export const GMAIL_REFRESH_TOKEN_KEY = 'gmail_refresh_token';
export const GMAIL_PLUGIN_ID = 'gmail';
