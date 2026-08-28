// Server environment contract
// All sensitive values come from server env, never from frontend

import { assertDistinctSigningKey } from '../shared/channels/webhookSecret.js';


export interface ServerConfig {
  port: number;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  corsOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  /**
   * Deployment-controlled platform-admin bootstrap boundary
   * (server/routes/adminBootstrap.ts). Only the caller whose verified
   * first-party email exactly matches this value may bootstrap the first
   * platform admin — bootstrap_admin's own "zero admins exist" check
   * remains as defense in depth, but is no longer the only guard,
   * closing the first-authenticated-user-wins race on a fresh, publicly
   * reachable install. Normalized (trim + lowercase) at load time.
   * `undefined` when unset — bootstrap fails closed in that case rather
   * than falling back to "any user."
   */
  initialAdminEmail?: string;
  /**
   * Explicit, server-only deployment-policy boundary: true ONLY when this
   * server was deliberately started as a self-host install with no
   * billing/plans subsystem installed (SELF_HOST_BILLING_MODE=unlimited).
   * Read once from process.env at server startup — never from a request,
   * header, or client-supplied value, so it cannot be toggled per-request or
   * from the browser. Defaults to `false` (fail-closed) when unset, matching
   * every other entitlement-outage path in server/middleware/featureGating.ts.
   * The one place this flag is consulted (checkEntitlementFromDB) still
   * additionally requires the RPC error to precisely name
   * check_workspace_entitlement as absent — this flag alone never bypasses
   * an entitlement check by itself; see entitlementParse.ts's
   * isCheckWorkspaceEntitlementFunctionMissing for the other half of that
   * condition.
   */
  selfHostBillingUnlimited: boolean;

  // ── Channels runtime (Plugin Platform) ──────────────────────────────
  /**
   * Dedicated server-to-server secret for the Core ↔ Channels boundary.
   * NEVER the service-role key, the auth/JWT secret, the plugin master key
   * or a provider token. Unset ⇒ /internal/channels/* fails closed (503).
   */
  coreInternalSecret?: string;
  /**
   * HMAC key used to DERIVE each integration's provider webhook secret.
   * Present in Core and the Channels Gateway; never in the worker or browser.
   */
  channelsWebhookSigningKey?: string;
  /**
   * Canonical public HTTPS origin of the Channels Gateway. Core builds the
   * provider webhook URL from this value only — never from Host,
   * X-Forwarded-Host or Origin.
   */
  publicChannelsBaseUrl?: string;
  /** Internal address Core uses to reach the gateway (health probes). */
  channelsInternalBaseUrl?: string;
  /**
   * Master key for plugin credential encryption (AES-256-GCM).
   * Core: yes. Channels Worker: yes. Gateway: no. Frontend: no.
   */
  pluginSecretsMasterKey?: string;

  // ── AI Runtime (Provider Network Isolation) ─────────────────────────
  /**
   * Base URL of the AI Runtime service (ai-runtime/server.ts), deployed on a
   * network that can reach AI providers. Core NEVER contacts a provider
   * directly; every completion/test/embedding call goes here.
   * Unset → all AI features fail with `runtime_not_configured` (fail-closed,
   * never a silent local provider call).
   */
  aiRuntimeBaseUrl?: string;
  /**
   * Shared server-to-server secret for the Core ⇄ AI Runtime boundary.
   *
   * Related env (read where they are used, not part of ServerConfig):
   *   AI_RUNTIME_TIMEOUT_MS  Core→Runtime wall clock, default 45000
   *                          (bounds 1000–180000). MUST exceed the runtime's
   *                          own AI_TOTAL_BUDGET_MS, otherwise Core aborts a
   *                          request the runtime is still paying for.
   */
  aiRuntimeInternalSecret?: string;

}

export function loadConfig(): ServerConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const optional = (key: string): string | undefined => process.env[key]?.trim() || undefined;

  const coreInternalSecret = optional('CORE_INTERNAL_SECRET');
  const channelsWebhookSigningKey = optional('CHANNELS_WEBHOOK_SIGNING_KEY');
  const pluginSecretsMasterKey = optional('PLUGIN_SECRETS_MASTER_KEY');
  const aiRuntimeInternalSecret = optional('AI_RUNTIME_INTERNAL_SECRET');

  // Startup guard: these three must be distinct from each other and from the
  // service-role key. A shared value collapses three security boundaries.
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
  assertDistinctSigningKey(channelsWebhookSigningKey, [
    coreInternalSecret,
    pluginSecretsMasterKey,
    serviceRoleKey,
    process.env.SESSION_SECRET,
    process.env.JWT_SECRET,
  ]);
  if (coreInternalSecret && coreInternalSecret === pluginSecretsMasterKey) {
    throw new Error('CORE_INTERNAL_SECRET must not reuse PLUGIN_SECRETS_MASTER_KEY');
  }
  if (coreInternalSecret && coreInternalSecret === serviceRoleKey) {
    throw new Error('CORE_INTERNAL_SECRET must not reuse SUPABASE_SERVICE_ROLE_KEY');
  }
  if (pluginSecretsMasterKey && pluginSecretsMasterKey === serviceRoleKey) {
    throw new Error('PLUGIN_SECRETS_MASTER_KEY must not reuse SUPABASE_SERVICE_ROLE_KEY');
  }
  // The AI runtime lives OUTSIDE the trusted network. Its secret must never be
  // a credential that also unlocks the database or another internal boundary.
  if (aiRuntimeInternalSecret) {
    for (const [name, other] of [
      ['SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey],
      ['CORE_INTERNAL_SECRET', coreInternalSecret],
      ['PLUGIN_SECRETS_MASTER_KEY', pluginSecretsMasterKey],
      ['CHANNELS_WEBHOOK_SIGNING_KEY', channelsWebhookSigningKey],
    ] as const) {
      if (other && aiRuntimeInternalSecret === other) {
        throw new Error(`AI_RUNTIME_INTERNAL_SECRET must not reuse ${name}`);
      }
    }
  }

  return {
    port: parseInt(process.env.PORT || '3001', 10),
    supabaseUrl: required('SUPABASE_URL'),
    supabaseAnonKey: required('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: serviceRoleKey,
    corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()),
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    initialAdminEmail: process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() || undefined,
    selfHostBillingUnlimited: process.env.SELF_HOST_BILLING_MODE === 'unlimited',
    coreInternalSecret,
    channelsWebhookSigningKey,
    publicChannelsBaseUrl: normalizeBaseUrl(optional('PUBLIC_CHANNELS_BASE_URL')),
    channelsInternalBaseUrl: normalizeBaseUrl(optional('CHANNELS_INTERNAL_BASE_URL')),
    pluginSecretsMasterKey,
    aiRuntimeBaseUrl: normalizeBaseUrl(optional('AI_RUNTIME_URL')),
    aiRuntimeInternalSecret,
  };
}

/** Strips a trailing slash; returns undefined for unparseable values. */
export function normalizeBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

