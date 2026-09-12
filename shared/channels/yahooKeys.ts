/**
 * Shared, side-effect-free constants for the Yahoo Mail channel plugin —
 * mirrors shared/channels/gmailKeys.ts. Importable from both Core (which
 * writes the plugin_secrets key) and the Channels Worker (which reads it
 * via resolveIntegrationToken) without pulling either side's dependencies
 * into the other.
 */

export const YAHOO_REFRESH_TOKEN_KEY = 'yahoo_refresh_token';
export const YAHOO_PLUGIN_ID = 'yahoomail';
