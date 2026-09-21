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
  /**
   * Whether the OBSERVE-AND-REPORT tickers start at boot (server/index.ts).
   * Six of them: the alerting ticker, the perf/process trend collectors, the
   * reliability/business hourly rollup, the auto-actions ticker, the
   * auto-actions cache and the SLO+enforcement ticker. They observe the
   * system and write history; an install with no traffic pays their DB churn
   * (observability_ticker_lease + alert_events writes every 60s, hourly
   * rollup RPCs every 10 min, an auto-actions SELECT every 7s) for reports
   * nobody reads.
   *
   * Set OBSERVABILITY_REPORTING_TICKERS to exactly `off` to skip them.
   * Defaults to `true` (fail-open) for ANY other value, including unset or
   * a typo — an unrecognized value never silently stops alerting.
   *
   * The auto-actions pair and the enforcement engine are covered even though
   * their output IS read on a request path, because that read FAILS OPEN in
   * every direction: isActionActive() returns false when the cache has never
   * refreshed and again once it is >60s stale (autoActionsCache.ts), and all
   * fifteen consumers treat `true` as REMOVE-capability, never as a grant.
   * With the producers stopped, visitors keep FULL capability — realtime
   * transport, typing indicators, video, no throttling. The enforcement
   * engine's entire blast radius is writing auto_action_events; it cannot
   * suspend a workspace, touch billing, revoke auth or delete anything.
   * ONE admin-UX cost: a manual POST /api/admin/auto-actions still
   * force-refreshes the cache, but the action then lapses after ~60s via the
   * staleness guard instead of running its full TTL.
   *
   * The REALTIME FAILOVER ticker is deliberately NOT covered — it makes a
   * live routing decision rather than a report, and gets its own switch
   * (realtimeFailoverTickerEnabled). Neither are the functional tickers
   * (call queue, billing, deletions, invitations, retention janitors).
   *
   * This is a process-level boot switch, not a substitute for the
   * per-workspace `alerting_enabled` toggle in widget_platform_settings:
   * that one short-circuits INSIDE runAlertCycle, after the ticker has
   * already taken and released its lease. When this flag is off the admin
   * UI's alerting toggle becomes cosmetic — the env wins.
   *
   * OPTIONAL on the interface on purpose — and so is every other flag field
   * below. The worker entrypoints (worker/commerce-sync, worker/source-sync,
   * worker/intelligence) build a ServerConfig literal by hand, so requiring
   * any of these would break their builds for fields most of them cannot act
   * on. Those three DO set the three request-path logging flags, because
   * they run writers those flags cover; none of them starts a ticker, so the
   * two ticker flags stay omitted there. EVERY read site uses `!== false`
   * (or `=== false` to suppress), so an omitted field keeps today's
   * behaviour — the fail-open default.
   */
  observabilityReportingTickersEnabled?: boolean;

  /**
   * Whether the REALTIME FAILOVER ENGINE ticker starts at boot
   * (server/services/realtime/failoverTicker.ts, every 30s). Kept separate
   * from OBSERVABILITY_REPORTING_TICKERS on purpose: this ticker is not
   * reporting — it probes provider health and makes a LIVE routing decision
   * (which realtime provider every /connect resolves to). It is also the
   * single largest periodic writer left once the reporting flag is off:
   * ~5,760 observability_ticker_lease writes/day for the `failover_health`
   * lease, roughly double the `alerting` lease that flag stops.
   *
   * Set REALTIME_FAILOVER_TICKER to exactly `off` to skip it. Defaults to
   * `true` (fail-open) for any other value, including unset or a typo.
   *
   * Turning it off does NOT stop realtime: the read side is independent of
   * the ticker. loadFailoverState() (failoverState.ts) is what /connect and
   * the handshake read, and it falls back to effective_provider='centrifugo'
   * when the row is missing. The effective provider simply FREEZES at its
   * last persisted value — so there is no automatic failover away from a
   * broken provider and no automatic failback. Manual recovery via the admin
   * realtime_provider_lock (server/routes/realtimeControl.ts) still works.
   */
  realtimeFailoverTickerEnabled?: boolean;

  /**
   * Whether PRODUCT-ANALYTICS telemetry rows are written on the request path.
   * These are charts-only tables: nothing in the product reads them back to
   * make a decision. visitor_page_views, web_analytics_events,
   * widget_smart_events (the TypeScript half — the rest is written by the
   * ai_nudge_apply_lifecycle_event SQL function and is out of reach),
   * ai_agent_debug_events and ai_usage_logs (the LEGACY analytics
   * projection; the authoritative billing record ai_usage_events is written
   * inside Postgres and is NOT affected).
   *
   * Set PRODUCT_ANALYTICS_LOGGING to exactly `off` to turn every one of
   * those writes into a no-op. Defaults to `true` for any other value.
   *
   * Cost when off: visitor journey / page-path reports, the per-visitor page
   * history in the Inbox, the custom-events report, smart-rule and AI-nudge
   * conversion analytics, the AI `answer_inspected` debug trail and the
   * provider/model breakdown charts all go blank. No billing, legal, routing
   * or visitor-facing impact.
   */
  productAnalyticsLoggingEnabled?: boolean;

  /**
   * Whether DELIVERY-DIAGNOSTICS trails are written on the request path:
   * email_logs, channel_delivery_attempts and ai_source_sync_logs. Separate
   * from PRODUCT_ANALYTICS_LOGGING because a human reads these AFTER
   * something has already gone wrong, which is a different decision from
   * "I do not want product charts".
   *
   * Set DELIVERY_DIAGNOSTICS_LOGGING to exactly `off` to no-op them.
   * Defaults to `true` for any other value.
   *
   * Cost when off: no evidence that a transactional email (invitation,
   * password reset, invoice) was actually sent, so "I never got the email"
   * becomes unanswerable; the workspace-integration and admin email panels
   * and the GDPR export's email section go empty; a failed WhatsApp/Telegram
   * send loses its per-attempt error code, latency and attempt number
   * (delivery and RETRY are unaffected — retry state lives on channel_jobs);
   * and the Data Hub knowledge-source screen can no longer say whether the
   * last sync succeeded, which is the one user-visible regression here.
   */
  deliveryDiagnosticsLoggingEnabled?: boolean;

  /**
   * Whether the COMPLIANCE / SECURITY / FINANCIAL record is written from
   * TypeScript: audit_logs, security_events, login_attempts,
   * admin_gate_bypass_log, plan_change_log, commerce_tool_audit and
   * realtime_provider_audit.
   *
   * DO NOT SET THIS TO `off` IN PRODUCTION. It exists so the choice is the
   * operator's and is written down, not because turning it off is advisable:
   * it saves nothing on an install with no users (every one of these tables
   * is request-path-only) while removing the legal record of administrative
   * and privacy actions, the only forensic trail if this install is probed
   * or compromised, account-takeover evidence, any trace of an admin gate
   * bypass, and billing-dispute evidence of plan changes. The GDPR
   * subject-access export also loses its audit_logs section, which it is
   * required to include.
   *
   * Set COMPLIANCE_AUDIT_LOGGING to exactly `off` to no-op the TypeScript
   * write sites. Defaults to `true` for any other value.
   *
   * OUT OF REACH of this (or any) env flag, because they are written by
   * PERFORM inside Postgres functions and stopping them needs a migration:
   * verification_attempts, verification_delivery_attempts and the
   * storage_usage_logs quota trigger.
   *
   * NOT covered by this flag, but reachable from TypeScript if you ever
   * decide they should be — deliberately left writing because they are the
   * financial audit trail and each sits in a money path that deserves a
   * per-site review before being suppressed:
   *   server/services/billing/rollout.ts:115      billing_v2_audit
   *   server/services/billing/dunning/index.ts:127 billing_v2_audit
   *   server/services/ai-billing/degrade.ts:65     ai_billing_audit_log
   *   server/routes/aiBilling.ts:807               ai_billing_audit_log
   * (Both tables are ALSO written by Postgres functions, so gating these
   * four would thin the trail without stopping it — another reason the
   * decision belongs to an operator, not to this default.)
   */
  complianceAuditLoggingEnabled?: boolean;

  /**
   * Whether the CHANNELS WORKER LIVENESS BEACON is written
   * (channel_worker_heartbeats — the #3 cumulative writer in the database,
   * and unreachable by OBSERVABILITY_REPORTING_TICKERS because the writer is
   * the channels worker itself, not an observability ticker).
   *
   * Set CHANNELS_WORKER_HEARTBEAT to exactly `off` to stop the 45s upsert.
   * Defaults to `true` for any other value.
   *
   * This flag deliberately moves TWO things together: the write AND the
   * consumer gate channelsWorkerOffline() (server/routes/plugins.ts), which
   * is made to fail OPEN when the flag is off. Silencing the signal without
   * relaxing the gate would make two authenticated provider routes answer
   * 503 forever on a beacon the operator deliberately turned off.
   *
   * Cost when off: the Super Admin channels-health panel reports the worker
   * offline/unknown forever even while it is draining channel_jobs normally,
   * and Telegram diagnostics/webhook repair no longer fail fast with a clean
   * 503 when the worker really IS dead — the operator waits out the 12-15s
   * awaitOperation timeout instead. Channel messaging is unaffected.
   *
   * CHEAPER LEVER FIRST: raising CHANNELS_HEARTBEAT_MS drops ~85% of these
   * writes with no code change — but only up to ~100s, because the staleness
   * windows are 120s (plugins.ts gate) and 150s (admin panel).
   *
   * The channels WORKER entrypoint never builds a ServerConfig, so it reads
   * process.env.CHANNELS_WORKER_HEARTBEAT directly via envFlagEnabled() —
   * the same parsing rule, one shared helper. Only the Core half (the
   * /internal/channels/heartbeat mirror and the plugins.ts gate) uses this
   * config field.
   */
  channelsWorkerHeartbeatEnabled?: boolean;

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

/**
 * The ONE parsing rule behind every reversible "stop doing this" switch in
 * this build. Only the exact string `off` (after trim + lowercase) disables;
 * unset, empty, or a typo leaves the behaviour running, so an operator who
 * sets nothing observes today's behaviour byte for byte and a fat-fingered
 * value never silently turns something off.
 *
 * Exported because the channels WORKER entrypoint and
 * server/services/channels/jobs.ts run without a ServerConfig and must apply
 * the identical rule to their own env var rather than re-deriving it.
 */
export function envFlagEnabled(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() !== 'off';
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
    observabilityReportingTickersEnabled: envFlagEnabled('OBSERVABILITY_REPORTING_TICKERS'),
    realtimeFailoverTickerEnabled: envFlagEnabled('REALTIME_FAILOVER_TICKER'),
    productAnalyticsLoggingEnabled: envFlagEnabled('PRODUCT_ANALYTICS_LOGGING'),
    deliveryDiagnosticsLoggingEnabled: envFlagEnabled('DELIVERY_DIAGNOSTICS_LOGGING'),
    complianceAuditLoggingEnabled: envFlagEnabled('COMPLIANCE_AUDIT_LOGGING'),
    channelsWorkerHeartbeatEnabled: envFlagEnabled('CHANNELS_WORKER_HEARTBEAT'),
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

