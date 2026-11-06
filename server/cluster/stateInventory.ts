/**
 * Every server module that keeps state in a module-level Map or Set, and
 * what that state does when the backend runs several processes in one
 * container (BACKEND_PROCESSES, docs/operations/BACKEND_PROCESSES.md).
 * src/test/cluster/stateInventory.test.ts fails for a module with such state
 * that is not listed here, so new state is classified before it ships.
 * (An ALL_CAPS Map or Set built from a literal is a constant and needs no
 * entry.)
 *
 *   hub         one copy per container, held by the cluster primary
 *               (cluster/hub.ts); the module's own copy is the single
 *               process's, and a worker's fallback
 *   bus         a cache every process clears through the cache bus
 *               (lib/cacheBus.ts)
 *   per-worker  accepted per process, as with several replicas: a limiter
 *               that is an abuse backstop, a short TTL cache, a once-at-a-
 *               time guard whose real guard is in the database, a
 *               connection, a warn-once memo
 *   lead-only   held by a loop that runs once per container (the lead)
 *   constant    filled once and only read (or a test hook)
 *
 * Not loaded at run time; data for the test and the runbook.
 */

export type StatePlacement = 'hub' | 'bus' | 'per-worker' | 'lead-only' | 'constant';

export const STATE_INVENTORY: Record<string, { placement: StatePlacement; note: string }> = {
  'server/cluster/client.ts': { placement: 'per-worker', note: "the IPC client's own pending calls, notices, warn memo and fallback claims" },
  'server/db/index.ts': { placement: 'per-worker', note: 'REST clients, one set per process' },
  'server/lib/cacheBus.ts': { placement: 'per-worker', note: "each process's cache handlers (the bus itself)" },
  'server/lib/globalAdminCache.ts': { placement: 'per-worker', note: "30 s 'not an admin' memo; a grant may wait 30 s elsewhere" },
  'server/lib/inflight.ts': { placement: 'per-worker', note: 'single-flight promises, not a cache' },
  'server/lib/redisClient.ts': { placement: 'per-worker', note: 'Redis connections' },
  'server/middleware/featureGating.ts': { placement: 'bus', note: "the 'entitlements' scope" },
  'server/middleware/loginAttempts.ts': { placement: 'hub', note: 'H3 the login brute-force tracker' },
  'server/middleware/security.ts': { placement: 'per-worker', note: 'abuse-pattern counters, log only (security.ts, "Abuse")' },
  'server/routes/adminEmailProviders.ts': { placement: 'per-worker', note: 'Super Admin test-button limit' },
  'server/routes/adminSeoBacklinksProvider.ts': { placement: 'per-worker', note: 'Super Admin test-button limit' },
  'server/routes/adminSeoKeywordsProvider.ts': { placement: 'per-worker', note: 'Super Admin test-button limit' },
  'server/routes/adminSeoPerformanceProvider.ts': { placement: 'per-worker', note: 'Super Admin test-button limit' },
  'server/routes/adminSeoRankTrackingProvider.ts': { placement: 'per-worker', note: 'Super Admin test-button limit' },
  'server/routes/adminSmsProviders.ts': { placement: 'per-worker', note: 'Super Admin test-button limit' },
  'server/routes/adminStorageProviders.ts': { placement: 'per-worker', note: 'Super Admin test-button limit' },
  'server/routes/ai-agent/internalQa.ts': { placement: 'per-worker', note: 'AI playground and debug counters (internalQa.ts:58, 163)' },
  'server/routes/ai-agent/operatorAssist.ts': { placement: 'per-worker', note: 'operator-assist counter' },
  'server/routes/brandRadar.ts': { placement: 'per-worker', note: 'one manual run at a time; the stored check is the cooldown' },
  'server/routes/commerce/connections.ts': { placement: 'per-worker', note: 'store handshake once at a time' },
  'server/routes/emailEvents.ts': { placement: 'per-worker', note: 'report replay memo; the suppression upsert is idempotent' },
  'server/routes/operatorActivity.ts': { placement: 'per-worker', note: 'presence lease write dedupe' },
  'server/routes/visitors.ts': { placement: 'per-worker', note: 'geo warm-up cooldown' },
  'server/routes/widget.ts': { placement: 'per-worker', note: 'geo-attempt memo' },
  'server/services/ai-agent/coalescing.ts': { placement: 'per-worker', note: 'burst debounce; the database freshness check is the guard' },
  'server/services/ai-agent/crawler/robots.ts': { placement: 'per-worker', note: 'robots.txt TTL cache' },
  'server/services/ai-agent/engine.ts': { placement: 'hub', note: "H9 lock 'ai:<conversation>' (the map is the single process's)" },
  'server/services/ai-agent/replyNow.ts': { placement: 'per-worker', note: 'fast path over the durable reply-now claim' },
  'server/services/ai-agent/runtimeConfig.ts': { placement: 'per-worker', note: 'AI runtime TTL cache' },
  'server/services/ai-billing/rates.ts': { placement: 'per-worker', note: 'AI rates cache: a save lags up to its TTL elsewhere' },
  'server/services/ai/idempotency.ts': { placement: 'per-worker', note: 'replay memo inside one call chain' },
  'server/services/auth/sessions.ts': { placement: 'per-worker', note: 'renewal guard; the database compare-and-set decides' },
  'server/services/billing/capabilityRegistry.ts': { placement: 'constant', note: 'registry by key' },
  'server/services/billing/locks/state.ts': { placement: 'bus', note: "the 'entitlements' scope" },
  'server/services/billing/planStops.ts': { placement: 'bus', note: "the 'entitlements' scope" },
  'server/services/billing/providers/paypal.ts': { placement: 'per-worker', note: 'OAuth token cache' },
  'server/services/callCenter/bootstrapCache.ts': { placement: 'bus', note: "the 'widget' and 'platform' scopes" },
  'server/services/callCenter/publicPresence.ts': { placement: 'bus', note: "the 'callpresence', 'widget', 'platform' and 'user' scopes" },
  'server/services/calls/availability.ts': { placement: 'per-worker', note: 'availability TTL cache' },
  'server/services/calls/callRequestLimiter.ts': { placement: 'hub', note: 'H6 call-request and ring-quiet limits' },
  'server/services/calls/calleeRingLimit.ts': { placement: 'hub', note: "H7 a callee's ring share" },
  'server/services/calls/departments.ts': { placement: 'bus', note: "the 'calls' scopes" },
  'server/services/calls/permissions.ts': { placement: 'bus', note: "the 'calls' scopes" },
  'server/services/channels/gmail/oauth.ts': { placement: 'per-worker', note: 'access-token cache' },
  'server/services/channels/metaSignature.ts': { placement: 'per-worker', note: 'warn-once memo' },
  'server/services/channels/yahoo/oauth.ts': { placement: 'per-worker', note: 'access-token cache' },
  'server/services/commerce/connectors/opencart.ts': { placement: 'per-worker', note: 'update nudge memo' },
  'server/services/commerce/metrics.ts': { placement: 'per-worker', note: 'diagnostic counters' },
  'server/services/commerce/whmcs/gateway.ts': { placement: 'per-worker', note: 'last-seen write throttle' },
  'server/services/conversationClosedNotice.ts': { placement: 'hub', note: "H9 lock 'close:<conversation>' (the map is the single process's)" },
  'server/services/desktopApp/live.ts': { placement: 'hub', note: 'H5 the desktop-app roster and broadcasts' },
  'server/services/email/gmailChangeNotifier.ts': { placement: 'per-worker', note: 'Pub/Sub burst coalescing' },
  'server/services/email/gmailLive.ts': { placement: 'per-worker', note: 'send replay memo; the stable Message-ID dedupes' },
  'server/services/email/index.ts': { placement: 'per-worker', note: 'warn-once memo' },
  'server/services/email/sendQuota.ts': { placement: 'per-worker', note: 'fallback only; the quota is in the database' },
  'server/services/email/yahooChangeNotifier.ts': { placement: 'per-worker', note: 'burst coalescing' },
  'server/services/geo/index.ts': { placement: 'per-worker', note: 'warn-once memo' },
  'server/services/geo/maxmindLocal.ts': { placement: 'bus', note: "the 'geo:<key of the file>' scope (and the file's mtime); one open in flight per path" },
  'server/services/invitations/idempotency.ts': { placement: 'per-worker', note: 'derived-key memo' },
  'server/services/invitations/worker.ts': { placement: 'per-worker', note: "this worker's own lost claims" },
  'server/services/jobs/background.ts': { placement: 'per-worker', note: 'background tasks, drained on SIGTERM' },
  'server/services/jobs/processShutdown.ts': { placement: 'per-worker', note: "this process's drains" },
  'server/services/knowledge-base/widgetSuggest.ts': { placement: 'per-worker', note: 'KB suggest TTL cache' },
  'server/services/mobileApp/androidRelease.ts': { placement: 'per-worker', note: 'file mtime cache' },
  'server/services/mobileApp/planGate.ts': { placement: 'bus', note: "the 'entitlements' scope; lastAllowedAt stays per worker" },
  'server/services/notificationEmail/producers.ts': { placement: 'lead-only', note: 'weekly handled memo of the leased ticker' },
  'server/services/observability/alertEvaluator.ts': { placement: 'lead-only', note: 'alert flap streaks' },
  'server/services/observability/reliabilityRollupTicker.ts': { placement: 'lead-only', note: 'rollup due map' },
  'server/services/operatorLocale.ts': { placement: 'per-worker', note: 'operator locale cache' },
  'server/services/operatorReplyJoin.ts': { placement: 'hub', note: "H9 lock 'reply:<conversation>' (the map is the single process's)" },
  'server/services/privacy/jobRateLimit.ts': { placement: 'hub', note: 'H2 privacy job limits' },
  'server/services/privacy/reauth.ts': { placement: 'hub', note: 'H1 re-auth token hashes' },
  'server/services/push/apns.ts': { placement: 'per-worker', note: 'APNs HTTP/2 sessions' },
  'server/services/push/teamCallRing.ts': { placement: 'hub', note: "H9 hold 'ring:<call>'; the local map orders this worker's own ring and stop" },
  'server/services/realtime/nodeHealth.ts': { placement: 'per-worker', note: 'node-health cache, refreshed in every worker' },
  'server/services/realtime/resolvePublisher.ts': { placement: 'bus', note: "the 'realtime' scope" },
  'server/services/seo/gsc/index.ts': { placement: 'per-worker', note: 'access-token cache' },
  'server/services/seo/rankTrackingService.ts': { placement: 'per-worker', note: 'manual check once at a time' },
  'server/services/storage/legacyMigration/categories.ts': { placement: 'per-worker', note: 'scope probe memo' },
  'server/services/verification/types.ts': { placement: 'constant', note: 'test overrides only' },
  'server/services/visitorTranscript.ts': { placement: 'hub', note: 'H10 the transcript claim (the Set is the single process\'s)' },
  'server/services/visitors/candidateIndex.ts': { placement: 'per-worker', note: 'caches over Centrifugo or Redis' },
  'server/services/visitors/presenceSource.ts': { placement: 'per-worker', note: 'caches over Centrifugo' },
  'server/services/widget/customerAvailability.ts': { placement: 'constant', note: 'Intl formatter memo' },
  'server/services/widget/operatorActivity.ts': { placement: 'hub', note: 'H8 operator active/away (without Redis)' },
  'server/services/widget/operatorActivityIndex.ts': { placement: 'hub', note: "H8 the primary's activity index" },
  'server/services/widget/operatorPresenceSource.ts': { placement: 'per-worker', note: 'caches over the shared presence lease' },
  'server/services/widget/public.ts': { placement: 'bus', note: "the 'origin' and 'host' scopes" },
  'server/services/widget/security.ts': { placement: 'per-worker', note: 'widget category buckets (WIDGET_CONFIG_CACHE.md, "Rate limits")' },
  'server/services/widget/senderIdentity.ts': { placement: 'per-worker', note: 'operator name TTL cache' },
  'server/services/widget/typingRateLimit.ts': { placement: 'per-worker', note: 'typing publish limit' },
};
