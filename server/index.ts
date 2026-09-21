import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { primePlatformOrigins, isAllowedOrigin } from './services/platformOrigins.js';
import { loadConfig, type ServerConfig } from './config.js';
import { widgetRouter } from './routes/widget.js';
import { visitorRouter, visitorsAdminRouter } from './routes/visitors.js';
import { healthRouter } from './routes/health.js';
import { backupAgentRouter } from './routes/backupAgent.js';
import { manifestRouter } from './routes/manifest.js';
import { metricsExportRouter } from './routes/metricsExport.js';
import { emailRouter } from './routes/email.js';
import { authSecurityRouter } from './routes/auth.js';
import { authEmailRouter } from './routes/auth-email.js';
import { aiRouter } from './routes/ai.js';
import { aiBillingRouter } from './routes/aiBilling.js';
import { storageRouter } from './routes/storage.js';
import { cdnRouter } from './routes/cdn.js';
import { accountRouter } from './routes/account.js';
import { workspacesRouter } from './routes/workspaces.js';
import { workspaceMembersRouter } from './routes/workspaceMembers.js';
import { workspaceInvitationsRouter } from './routes/workspaceInvitations.js';
import { widgetSettingsRouter } from './routes/widgetSettings.js';
import { workspaceIntegrationsRouter } from './routes/workspaceIntegrations.js';
import { notificationsRouter } from './routes/notifications.js';
import { pushRouter } from './routes/push.js';
import { workspaceAlertsRouter } from './routes/workspaceAlerts.js';
import { availabilityRouter } from './routes/availability.js';
import { mobilePromotionsRouter } from './routes/mobilePromotions.js';
import { platformOriginsPublicRouter } from './routes/platformOriginsPublic.js';
import { operatorActivityRouter } from './routes/operatorActivity.js';
import { billingRouter, billingWebhookRouter } from './routes/billing.js';
import { commercePairingRouter } from './routes/commerce/pairing.js';
import { commerceConnectionsRouter } from './routes/commerce/connections.js';
import { commerceEventsRouter } from './routes/commerce/events.js';
import { commercePluginActionsRouter } from './routes/commerce/pluginActions.js';
import { commerceGuestVerificationRouter } from './routes/commerce/guestVerification.js';
import { commerceIdentityRouter } from './routes/commerce/identity.js';
import { internalTestGatewayRouter } from './routes/internalTestGateway.js';
import { billingCustomerRouter } from './routes/billingCustomer.js';
import { adminBillingV2Router } from './routes/adminBillingV2.js';
import { adminBillingRouter } from './routes/adminBilling.js';

import { seoRouter } from './routes/seo.js';
import { webAnalyticsRouter } from './routes/webAnalytics.js';
import { botAnalyticsRouter } from './routes/botAnalytics.js';
import { brandRadarRouter } from './routes/brandRadar.js';
import { plansRouter } from './routes/plans.js';
import { pluginsRouter, adminPluginsRouter } from './routes/plugins.js';
import { internalChannelsRouter } from './routes/internalChannels.js';
import { emailInboxRouter } from './routes/emailInbox.js';
import { gmailPushRouter } from './routes/gmailPush.js';

import { phoneVerificationRouter } from './routes/phoneVerification.js';
import { adminRouter } from './routes/admin.js';
import { adminBootstrapRouter } from './routes/adminBootstrap.js';
import { realtimeRouter } from './routes/realtime.js';
import { mapGeoRouter } from './routes/mapGeo.js';
import { conversationsRouter } from './routes/conversations.js';
import { conversationAttachmentsRouter } from './routes/conversationAttachments.js';
import { conversationNotesRouter } from './routes/conversationNotes.js';
import { cannedResponsesRouter } from './routes/cannedResponses.js';
import { widgetKbRouter, publicKbRouter } from './routes/kb.js';
import { privacyRouter } from './routes/privacy.js';
import { callsRouter } from './routes/calls.js';
import { livekitWebhookRouter } from './routes/livekitWebhook.js';
import { recordingPlaybackRouter } from './routes/recordingPlayback.js';
import { callQueueRouter } from './routes/callQueue.js';
import { workspaceCallsRouter } from './routes/workspaceCalls.js';
import { callAvailabilityRouter } from './routes/callAvailability.js';
import { callbacksRouter } from './routes/callbacks.js';
import { workspaceDepartmentsRouter } from './routes/workspaceDepartments.js';
import { workspaceSmartRulesRouter } from './routes/workspaceSmartRules.js';
import { callInvitationsRouter } from './routes/callInvitations.js';
import { aiKbRouter } from './routes/aiKb.js';
import { knowledgeBaseRouter } from './routes/knowledgeBase.js';
import { aiAgentRouter } from './routes/aiAgent.js';
import { callCenterRouter } from './routes/callCenter.js';
import { callWidgetRouter } from './routes/callWidget.js';
import { contactsRouter } from './routes/contacts.js';
import { teamChatRouter } from './routes/teamChat.js';
import { startInProcessSourceWorker } from './services/ai-agent/sourceWorker.js';
import { startCallQueueTicker } from './services/calls/queueTicker.js';
import { startInvitationExpirySweeper } from './services/calls/invitations.js';
import { startAttachmentJanitor } from './services/attachmentJanitor.js';
import { startRecordingRetentionJanitor } from './services/recordings/retentionJanitor.js';
import { startPrivacyWorker } from './services/privacy/worker.js';
import { startInvitationWorker } from './services/invitations/worker.js';
import { syncSeatEntitlementMode } from './services/invitations/bootstrap.js';
import { ensureInvitationSecrets } from './services/invitations/secretBootstrap.js';

import { startPrivacyExpirySweep } from './services/privacy/expirySweep.js';
import { startWorkspaceDeletionWorker } from './services/workspaceDeletion/worker.js';
import { startUserDeletionWorker } from './services/userDeletion/worker.js';
import { startAiBillingRecovery } from './services/ai-billing/recoveryTicker.js';
import { startBillingV2Schedulers } from './services/billing/scheduler/ticker.js';
import { startAlertingTicker } from './services/observability/alertingTicker.js';
import { startPerfCollectors } from './services/observability/perf.js';
import { startAutoActionsTicker } from './services/observability/autoActionsTicker.js';
import { startAutoActionsCache } from './services/observability/autoActionsCache.js';
import { startFailoverTicker } from './services/realtime/failoverTicker.js';
import { startNodeHealthRefresher } from './services/realtime/healthRefresher.js';

import { startReliabilityRollup } from './services/observability/reliabilityRollupTicker.js';
import { startEnforcementTicker } from './services/observability/enforcementTicker.js';
import { startMaxmindUpdateTicker } from './services/geo/maxmindUpdater.js';
import { startRankTrackingTicker } from './services/seo/rankTrackingTicker.js';
import { startGmailWatchRenewalTicker } from './services/channels/gmail/watchRenewalTicker.js';
import { invalidateManifestCache, getManifestDiagnostics } from './services/widget/manifest.js';
import { widgetCorsMiddleware } from './middleware/widgetCors.js';
import { isPublicWidgetApiPath, PUBLIC_WIDGET_REALTIME_ROUTES } from './lib/routePrefix.js';
import {
  ipBlockMiddleware,
  emailRateLimiter,
  widgetRateLimiter,
  visitorRateLimiter,
  widgetWorkspaceRateLimiter,
  widgetSessionRateLimiter,
  adminRateLimiter,
  widgetBootstrapRateLimiter,
  widgetBootstrapGlobalCeiling,
  callWidgetBootstrapRateLimiter,
  callWidgetBootstrapGlobalCeiling,
  callWidgetSessionRateLimiter,
  publicKbRateLimiter,
  publicKbGlobalCeiling,
  visitorPreAuthRateLimiter,
  visitorPreAuthGlobalCeiling,
  abuseDetectionMiddleware,
  validateJsonBody,
} from './middleware/security.js';

const config = loadConfig();

const app = express();

// Trust upstream reverse proxies (nginx / Traefik / Coolify / Cloudflare).
// Without this, req.ip would always be the proxy's address.
//
// Default: "loopback, linklocal, uniquelocal" — only proxies on private
// networks are trusted, which is exactly the Coolify/Traefik/Docker topology
// (the origin container is reached over the private bridge network). Public
// IPs in the chain stay untrusted hops.
//
// Override with TRUST_PROXY when the origin is reached over a public address
// by a known edge (e.g. a Cloudflare Tunnel-less setup): set it to that
// proxy's IP / CIDR list. Never use `true` — it trusts every hop blindly.
// Additionally, `TRUSTED_PROXY_IPS` (see server/utils/clientIp.ts) controls
// which peers may set cf-connecting-ip / x-forwarded-for / cf-ipcountry.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

// Security headers
app.use(helmet());

// ─── Standalone Call Widget static assets ────────────────────────────
// Backward-compatible: lets the API origin serve /call-widget/* so
// previously-copied install snippets (which pointed at the API base)
// keep working. Self-hosted only — no CDN.
//
// Resolves project root relative to this compiled file. In dev (tsx) and
// in the Docker server image we expect ./public/call-widget and
// ./public/widget/vendor next to the server entry's working directory.
const __cwFilename = fileURLToPath(import.meta.url);
const __cwServerDir = path.dirname(__cwFilename);
const CALL_WIDGET_DIRS = [
  path.resolve(__cwServerDir, '..', 'public', 'call-widget'), // monorepo dev
  path.resolve(__cwServerDir, 'public', 'call-widget'),       // server image (cwd=/app)
  path.resolve(process.cwd(), 'public', 'call-widget'),       // fallback
];
const CALL_WIDGET_VENDOR_SOURCES = [
  path.resolve(__cwServerDir, '..', 'public', 'widget', 'vendor'),
  path.resolve(__cwServerDir, 'public', 'widget', 'vendor'),
  path.resolve(process.cwd(), 'public', 'widget', 'vendor'),
];

function widgetAssetHeaders(res: express.Response, filePath: string) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (/livekit-client\.umd\.min\.js$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    // Loader + runtime are NOT content-hashed. If we let CDNs cache them
    // even briefly, customers see stale widget UI after every deploy and
    // a Cloudflare purge isn't always enough (heuristic / edge TTL).
    // Force no-store everywhere so each page load fetches fresh bytes.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  }
}

// Serve LiveKit UMD under /call-widget/vendor/* (preferred path) by
// reading from public/widget/vendor — that's where the SDK already lives
// so we don't duplicate the binary.
app.get('/call-widget/vendor/:file', (req, res, next) => {
  const file = req.params.file;
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) return res.status(400).end();
  for (const dir of CALL_WIDGET_VENDOR_SOURCES) {
    const full = path.join(dir, file);
    if (full.startsWith(dir)) {
      return res.sendFile(full, { headers: {} }, (err) => {
        if (err) return next();
        widgetAssetHeaders(res, full);
      });
    }
  }
  return next();
});

for (const dir of CALL_WIDGET_DIRS) {
  app.use(
    '/call-widget',
    express.static(dir, {
      fallthrough: true,
      setHeaders: (res, filePath) => widgetAssetHeaders(res as unknown as express.Response, filePath),
    }),
  );
}

// Back-compat: also serve /widget/vendor/* (older loader path) with
// cross-origin CORP so embeds that still reference it keep working.
for (const dir of CALL_WIDGET_VENDOR_SOURCES) {
  app.use(
    '/widget/vendor',
    express.static(dir, {
      fallthrough: true,
      setHeaders: (res, filePath) => widgetAssetHeaders(res as unknown as express.Response, filePath),
    }),
  );
}

// SECURITY: `credentials: true` below means every response to an allowed
// origin carries `Access-Control-Allow-Credentials: true`, so the cookie-
// authenticated dashboard session rides along on cross-origin requests from
// that origin. `CORS_ORIGINS` unset (the `*` default, see config.ts) used
// to be handled by passing `origin: true` to the `cors` package, which
// reflects the REQUEST'S Origin verbatim (the only way to combine a
// wildcard with credentials — browsers refuse literal `*` alongside
// Allow-Credentials) — i.e. by default this server trusted every origin on
// the internet with a real, cookie-carrying session, for both accidental
// (default-configured) and deliberately unsafe (`CORS_ORIGINS=*`, as this
// repo's own .env.docker.example previously suggested) deployments alike.
//
// Fixed to fail closed: an unconfigured/wildcarded corsOrigins now disables
// cross-origin CORS entirely (`origin: false` — no Access-Control-Allow-*
// headers at all). This costs nothing for the documented, intended
// same-origin reverse-proxy topology (SELF_HOST_GUIDE.md) — browsers never
// consult CORS headers for same-origin requests in the first place — and it
// requires any deployment that genuinely needs cross-origin browser calls
// (e.g. local dev, Vite :5173 talking to Express :3001) to say so
// explicitly via CORS_ORIGINS, as server/.env.example already documents.
if (config.corsOrigins.length === 1 && config.corsOrigins[0] === '*') {
  console.warn(
    '[security] CORS_ORIGINS is not set (or set to "*"). Cross-origin ' +
    'browser requests with credentials are only allowed for the domains ' +
    'configured in Super Admin → Domains (platform_domains). Set ' +
    'CORS_ORIGINS as well if the frontend origin is not one of them. ' +
    'Same-origin deployments are unaffected.'
  );
}
// Origins come from the DB (Super Admin → Domains) FIRST, with CORS_ORIGINS as
// a static fallback, so changing the dashboard/API/public domain later needs no
// redeploy. Still fails closed: an unknown origin gets no Access-Control-* header.
primePlatformOrigins(config);
const appCors = cors({
  origin: (origin, cb) => {
    // No Origin header (same-origin, curl, server-to-server) → nothing to allow.
    if (!origin) return cb(null, false);
    return cb(null, isAllowedOrigin(config, origin) ? origin : false);
  },
  credentials: true,
});


// Public widget-facing routes manage their own dynamic CORS via widgetCorsMiddleware.
app.use((req, res, next) => {
  if (isPublicWidgetApiPath(req.path)) {
    return next();
  }
  return appCors(req, res, next);
});

// Attach config FIRST so the webhook route (which bypasses json/cookieParser)
// can still resolve its config off the request object.
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig: ServerConfig }).serverConfig = config;
  next();
});

// ─── LiveKit webhook — must run BEFORE express.json so we can hash the
// raw body for signature verification. The router uses its own raw body
// parser at the route level. ────────────────────────────────────────────
app.use('/api/calls/livekit/webhook', livekitWebhookRouter);

// Billing provider webhooks — same reason: signature verification needs the
// exact raw bytes, so this mounts before express.json with its own raw parser.
app.use('/api/billing/webhook', billingWebhookRouter);

// Commerce event ingestion (webyar-woocommerce plugin) — HMAC signature
// verification needs the exact raw bytes; the router applies its own
// express.raw() parser. See docs/commerce/SECURITY.md §Request signing.
app.use('/api/commerce/events', commerceEventsRouter);

// Connection actions the plugin triggers itself (test / sync / disconnect).
// Same signed-request trust model as event ingestion, and likewise mounted
// before express.json() so the raw bytes survive for verification.
app.use('/api/commerce/connection', commercePluginActionsRouter);

// JSON / cookies for everything else. Skip the webhook path explicitly so
// a future re-order can't accidentally consume the raw body.
app.use((req, res, next) => {
  if (req.path === '/api/calls/livekit/webhook') return next();
  if (req.path.startsWith('/api/billing/webhook')) return next();
  if (req.path.startsWith('/api/commerce/events')) return next();
  if (req.path.startsWith('/api/commerce/connection')) return next();
  return express.json({ limit: '50mb' })(req, res, next);
});
app.use(cookieParser()); // Parse signed visitor cookies (HttpOnly dvsid)

// Global: IP blocking check
app.use('/api/', ipBlockMiddleware());

// Global: Abuse detection
app.use('/api/', abuseDetectionMiddleware());

// ─── Routes with per-endpoint rate limiting ──────────────────────

// Health (no rate limit)
app.use('/api/health', healthRouter);

// Host-side backup agent reporting. Token-authenticated inside the router and
// disabled entirely unless BACKUP_AGENT_TOKEN is configured. Read/write of
// backup metadata only — it can never trigger a restore.
app.use('/api/backup-agent', backupAgentRouter);

// PWA web app manifest — public, unauthenticated, reflects live platform_branding.
app.use('/api/manifest.webmanifest', manifestRouter);

// Prometheus/OpenTelemetry readiness stub — off by default (404) unless
// OBSERVABILITY_PROMETHEUS_ENABLED=1, and token-gated even when enabled.
// Mounted at the top level (not /api) to match standard scrape conventions;
// scrapers don't carry the admin session cookie so this isn't under
// adminRouter's requireAdmin gate — see server/routes/metricsExport.ts.
app.use('/metrics', metricsExportRouter);

// Auth security (brute force + captcha). The strict 5/min limiter is applied
// per-route inside authSecurityRouter (login/signup/etc.), NOT blanket here —
// GET /api/auth/session is read-only and called on every page load/tab, so it
// must not share a budget with security-sensitive mutating actions.
app.use('/api/auth', authSecurityRouter);

// Auth email — verification & reset via configured provider
app.use('/api/auth-email', emailRateLimiter, authEmailRouter);

// Pre-auth widget bootstrap — no signed credential exists yet, so it is
// protected by per-IP + global ceilings ONLY. It must never touch the
// authenticated per-workspace bucket (a spoofed Origin / known workspace UUID
// would otherwise let an attacker drain a victim's shared quota).
app.use('/api/widget/bootstrap', widgetCorsMiddleware(), widgetBootstrapGlobalCeiling, widgetBootstrapRateLimiter);

// Anonymous public KB JSON — no cryptographic credential exists on this path,
// so there is deliberately NO workspace blocking bucket for it.
app.use('/api/widget/kb', widgetCorsMiddleware(), widgetRateLimiter, publicKbGlobalCeiling, publicKbRateLimiter, widgetKbRouter);

// Widget — dynamic CORS + per-IP limit + authenticated per-workspace limit +
// per-session limit. The workspace bucket is only selected when a verified
// token carries rl:'workspace'; the session limiter applies to every
// verified token regardless of trust class, and structurally covers every
// sub-router mounted inside widgetRouter (identity/attachments/callback/
// departments/call-invitations) without each needing its own opt-in.
app.use('/api/widget', widgetCorsMiddleware(), widgetRateLimiter, widgetWorkspaceRateLimiter, widgetSessionRateLimiter, widgetRouter);

// Public KB SSR routes — server-rendered HTML for /help/:locale/...
// No CORS / no rate limit; these are normal public web pages indexed by search engines.
app.use(publicKbRouter);

// Visitor tracking — anonymous (no widget token in the runtime contract), so
// pre-auth per-IP + global limits. The workspace limiter still runs and will
// use a verified token when one is present, else the per-IP bucket.
app.use('/api/visitors', widgetCorsMiddleware(), visitorRateLimiter, visitorPreAuthGlobalCeiling, visitorPreAuthRateLimiter, widgetWorkspaceRateLimiter, visitorRouter);

// Visitor intelligence (operator-side, authenticated). Standard appCors,
// auth+membership enforced per-route. Lower rate-limit footprint vs widget.
app.use('/api/visitor-intel', visitorsAdminRouter);

// Email — workspace-scoped rate limit
app.use('/api/email', emailRateLimiter, emailRouter);

// AI — auth required, workspace rate limiting built into routes
app.use('/api/ai', aiRouter);
app.use('/api/ai-billing', aiBillingRouter);

// Storage — auth required, file size limits in routes
app.use('/api/storage', storageRouter);

// CDN — auth required, purge and config
app.use('/api/cdn', cdnRouter);

// Account — self-service for the authenticated user (profile, avatar, password)
app.use('/api/account', accountRouter);

// Canonical server-owned workspace seat-creation boundary.
// See docs/MAX_AGENTS_POLICY.md and server/routes/workspaceMembers.ts.
app.use('/api/workspaces', workspacesRouter);
app.use('/api/workspace-members', workspaceMembersRouter);
// Workspace Invitations v5.1 — canonical invitation API (Express-only).
app.use('/api/workspace-invitations', workspaceInvitationsRouter);
app.use('/api/widget-settings', widgetSettingsRouter);
app.use('/api/workspace-integrations', workspaceIntegrationsRouter);
// Commerce Integration Platform — pairing (state/PKCE, no workspace in the
// URL yet) and workspace-scoped connection management. Event ingestion is
// mounted separately above, before express.json(). See
// docs/commerce/ARCHITECTURE.md.
app.use('/api/commerce/pairing', commercePairingRouter);
app.use('/api/workspaces', commerceConnectionsRouter);
// Widget-facing guest order verification — anonymous visitor, no workspace
// session, so it gets the widget CORS policy rather than appCors.
app.use('/api/widget/commerce/guest-verification', widgetCorsMiddleware(), commerceGuestVerificationRouter);
app.use('/api/widget/commerce/identity', widgetCorsMiddleware(), commerceIdentityRouter);

// Self-service notification preferences
app.use('/api/notifications', notificationsRouter);

// Native mobile push device registry (FCM → APNs/iOS + Android)
app.use('/api/push', pushRouter);

// Workspace operational alerts (derived, read-only)
app.use('/api/workspace-alerts', workspaceAlertsRouter);

// Where the platform actually lives, for clients that must ask before they
// can authenticate. Public, cached, read-only.
app.use('/api/platform', platformOriginsPublicRouter);

// What the native app may show as a promotion. Read-only, workspace-scoped.
app.use('/api/mobile-app', mobilePromotionsRouter);

// Self-service per-user availability schedule
app.use('/api/availability', availabilityRouter);
app.use('/api/operator-activity', operatorActivityRouter);

// Billing — checkout, webhooks, subscription management
// Simulated in-house gateway page (test provider only; must be mounted first).
app.use('/api/billing/test-gateway', internalTestGatewayRouter);
app.use('/api/billing', billingCustomerRouter);
app.use('/api/billing', billingRouter);
app.use('/api/seo', seoRouter);
app.use('/api/web-analytics', webAnalyticsRouter);
app.use('/api/bot-analytics', botAnalyticsRouter);
app.use('/api/brand-radar', brandRadarRouter);

// Billing Engine V2 rollout control — Platform Admin only (authorized in-router).
app.use('/api/admin/billing-v2', adminBillingV2Router);

// Unified billing — super-admin finance panel (currencies, gateways, tax,
// coupons, metered items, global invoices/payments/customers).
app.use('/api/admin/billing', adminBillingRouter);


// Plans & Feature Gating
app.use('/api/plans', plansRouter);

// Plugin Platform — workspace marketplace + Super Admin controls.
// Both surfaces authorize inside the router before any service-role query.
app.use('/api/plugins/admin', adminRateLimiter, adminPluginsRouter);
app.use('/api/plugins', pluginsRouter);

// Email Inbox — dedicated, not the unified chat Inbox, and NOT the same
// surface as /api/email/* (transactional + outbound SMTP channel email —
// see server/routes/email.ts's header comment). See
// server/services/email/inbox.ts's header comment.
app.use('/api/email-inbox', emailInboxRouter);

// Core ↔ Channels internal API. NOT under /api: it is a server-to-server
// boundary authenticated with CORE_INTERNAL_SECRET and must never be exposed
// to browsers or included in the public CORS surface.
app.use('/internal/channels', internalChannelsRouter);



// Gmail Pub/Sub push. NOT under /api (no CORS/browser auth applies — Google
// Pub/Sub authenticates with its own OIDC bearer token, verified inside the
// router) and NOT under /internal/channels (that boundary is
// CORE_INTERNAL_SECRET-only, which Google cannot present).
app.use('/webhooks', gmailPushRouter);



// Phone verification (account-level OTP). Auth is enforced per route.
app.use('/api/phone-verification', phoneVerificationRouter);

// Admin — moderate rate limit
app.use('/api/admin', adminRateLimiter, adminRouter);
app.use('/api/admin-status', adminRateLimiter, adminBootstrapRouter);

// Tokenized super-admin recording playback (read-only). Not under
// /api/admin because native <audio>/<video> elements cannot attach a
// bearer header — access is governed by short-lived HMAC tokens minted
// by POST /api/admin/calls/recordings/:id/playback-token.
app.use('/api/calls/recording-playback', recordingPlaybackRouter);

// Platform admin: Map & Geo (mounted under /api/admin/map-geo, admin role enforced inside)
app.use('/api/admin/map-geo', adminRateLimiter, mapGeoRouter);

// Realtime — admin config + widget connect/subscribe (auth handled per-route).
// Public widget endpoints get the dynamic widget CORS; admin endpoints rely on the
// global appCors applied above.
// Single mount driven by the canonical route list in lib/routePrefix.ts —
// the same list the app-CORS bypass consults, so classification and policy
// can never drift apart (that drift is what left /visitor-presence on the
// first-party app CORS allow-list).
app.use([...PUBLIC_WIDGET_REALTIME_ROUTES], widgetCorsMiddleware());
app.use('/api/realtime', realtimeRouter);

// Conversations — backend-mediated agent reply send + realtime publish.
// Auth handled per-route via Supabase user JWT + workspace membership check.
app.use('/api/conversations', conversationsRouter);

// Phase 4b — Operator-only notes + timeline routes.
// Mounted under the same /api/conversations prefix so paths read as
//   /api/conversations/:id/notes
//   /api/conversations/:id/timeline
// Auth + workspace membership are enforced inside the router.
app.use('/api/conversations', conversationNotesRouter);

// Phase 2 — Operator attachments (Inbox-side). Reuses conversation_attachments
// table + storage service; gated by Supabase JWT + workspace membership.
app.use('/api/conversation-attachments', conversationAttachmentsRouter);

// Phase 6 — Canned responses (operator reply templates). Workspace-scoped,
// multilingual, no widget exposure. Auth + membership enforced per-route.
app.use('/api/canned-responses', cannedResponsesRouter);

// GDPR — privacy export/delete jobs. Auth + admin role enforced per-route.
// Worker loop runs in-process (see startPrivacyWorker below).
app.use('/api/privacy', privacyRouter);

// Phase 8A — Voice/Video calls signaling. Auth + workspace membership enforced per-route.
app.use('/api/calls', callsRouter);

// Phase 8C — Call queue (operator surfaces). Auth + workspace membership per-route.
app.use('/api/call-queue', callQueueRouter);

// Phase 8C — Workspace-scoped call settings + role permission overrides.
// Workspace owner/admin only (enforced inside the router).
app.use('/api/workspace-calls', workspaceCallsRouter);

// Phase 8D — Operator call availability (per-user readiness).
app.use('/api/call-availability', callAvailabilityRouter);

// Phase 8D — Callback requests (operator-side management).
app.use('/api/callbacks', callbacksRouter);

// Phase 8H — Workspace-scoped department management.
app.use('/api/workspace-departments', workspaceDepartmentsRouter);
app.use('/api/workspaces', workspaceSmartRulesRouter);

// Phase 9 — Operator-side Call Invitations (invitation-first calling).
// Auth + workspace membership enforced inside the router.
app.use('/api/call-invitations', callInvitationsRouter);

// Contacts — canonical TS-first create / bulk-import chokepoint enforcing
// `max_contacts`. UI hooks (useCreateContact / useBulkCreateContacts)
// route here. Update / delete / tags / notes remain direct PostgREST.
app.use('/api/contacts', contactsRouter);

// Team chat — internal operator-to-operator direct messages.
app.use('/api/team-chat', teamChatRouter);

// AI Knowledge Base Builder — auth + workspace membership enforced inside.
// Worker that actually crawls + generates runs as a separate process; see
// worker/intelligence/index.ts and Dockerfile.worker.
app.use('/api/knowledge-base', knowledgeBaseRouter);
app.use('/api/ai-kb', aiKbRouter);

// AI Agent (Phase 1) — workspace-scoped configuration, knowledge status,
// playground, analytics, Q&A, diagnostics. Auth + membership enforced inside.
// Phase 2 will wire the engine into widget.ts to replace the primitive auto-reply.
app.use('/api/ai-agent', aiAgentRouter);

// Call Center — operator/admin (workspace-scoped) and platform admin endpoints.
app.use('/api/call-center', callCenterRouter);

// Call Widget — public visitor-facing standalone widget endpoints.
// Dynamic per-workspace CORS handled inside the router.
// Pre-auth call-widget bootstrap: `publicKey` is a PUBLIC identifier visible in
// the embed, never a secret — it cannot select a workspace bucket.
app.use('/api/call-widget/bootstrap', callWidgetBootstrapGlobalCeiling, callWidgetBootstrapRateLimiter);
// Post-bootstrap call-widget traffic: per-IP + workspace bucket (unreachable
// today, see resolveRateLimitWorkspaceKey's doc comment) + a per-session
// ceiling keyed on the verified x-cc-session nonce, so one credential can't
// be hammered past a sane cap purely by rotating source IPs.
app.use('/api/call-widget', widgetRateLimiter, widgetWorkspaceRateLimiter, callWidgetSessionRateLimiter, callWidgetRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Invitation key material must exist before any invitation route or worker
// runs, otherwise delivery jobs fail closed with DERIVATION_KEY_UNAVAILABLE.
// Explicit env vars win; otherwise durable keys are provisioned in the
// operator's own database exactly once.
await ensureInvitationSecrets(config)
  .then((r) => console.log(`[invitations] key material: link=${r.linkSecret} otp=${r.otpPepper}`));

app.listen(config.port, () => {
  console.log(`Growth Suite server running on port ${config.port}`);

  // Phase 3 — start best-effort orphan-attachment sweeper.
  startAttachmentJanitor(config);
  // recording_retention_days — sole enforcement path for call-recording
  // retention. See server/services/recordings/retentionJanitor.ts and
  // docs/CALL_RECORDING_RETENTION.md.
  startRecordingRetentionJanitor(config);
  // GDPR — start privacy job worker (in-process loop).
  startPrivacyWorker(config);
  // Invitation outbox. Self-hosted single-container deployments have no
  // dedicated WORKER_KIND=invitations service, which left delivery jobs
  // sitting in `queued` forever ("email queued but never sent"). The
  // in-process worker is therefore ON by default and only disabled when the
  // operator explicitly runs a dedicated worker container
  // (INVITATION_WORKER_INPROC=0).
  if (process.env.INVITATION_WORKER_INPROC !== '0') {
    void syncSeatEntitlementMode(config).then((result) => {
      if (result.ok) startInvitationWorker(config);
      else console.error('[invitations] worker not started: entitlement bootstrap failed');
    });
  }

  // GDPR — start hourly TTL purge for expired export artifacts (provider-based).
  startPrivacyExpirySweep(config);
  // Storage-aware workspace deletion — walks + deletes every workspace/<id>/
  // storage object before the existing DB purge runs. See
  // docs/STORAGE_ARCHITECTURE_AUDIT.md and server/services/workspaceDeletion/worker.ts.
  startWorkspaceDeletionWorker(config);
  // Storage-aware account deletion — routes every owned workspace through
  // the SAME machinery above before purging the user's own DB row and
  // global users/<id>/ storage. See server/services/userDeletion/worker.ts.
  startUserDeletionWorker(config);

  // AI billing — automatic, idempotent recovery/reconciliation pass.
  startAiBillingRecovery(config);
  // Billing Engine V2 — renewal invoices, wallet auto-pay and period activation.
  startBillingV2Schedulers(config);

  // Phase 4 — start in-process alerting ticker (every 60s). Best-effort.
  // Reporting-only: nothing on a request path reads alert_events, so this
  // ticker (and the five other observe-and-report tickers below) is skipped
  // wholesale when OBSERVABILITY_REPORTING_TICKERS=off. See server/config.ts.
  if (config.observabilityReportingTickersEnabled !== false) {
    startAlertingTicker(config);
  } else {
    console.warn(
      '[observability] reporting tickers NOT started (OBSERVABILITY_REPORTING_TICKERS=off): ' +
        'alerting ticker, perf/process collectors, reliability+business rollup, ' +
        'auto-actions ticker, auto-actions cache, SLO+enforcement ticker. ' +
        'No new alert_events rows, no outbound alert webhooks, no new hourly rollup ' +
        'buckets, an empty admin process-trend chart, no slo_breach_events and no ' +
        'automatic workspace throttling — a real incident needs a manual admin ' +
        'auto-action instead of self-throttling. Visitors keep FULL capability ' +
        '(isActionActive() fails open), so nothing 503s and nothing a visitor can ' +
        'see changes; a manually activated auto-action lapses after ~60s instead of ' +
        'running its full TTL. Realtime failover, call queue, billing, deletions and ' +
        'every other worker keep running. To restore: unset ' +
        'OBSERVABILITY_REPORTING_TICKERS (or set any value other than "off") and restart.',
    );
  }

  // ── Request-path logging switches ───────────────────────────────────────
  // These four write nothing on a timer, so there is no ticker to skip — they
  // suppress INSERTs at the single choke point for each table. Announce them
  // once at boot so an operator reading the log knows why a panel is empty,
  // instead of discovering it months later from a blank chart. Every one of
  // them defaults to ON; only the literal value `off` reaches these lines.
  if (config.productAnalyticsLoggingEnabled === false) {
    console.warn(
      '[analytics] product-analytics logging DISABLED (PRODUCT_ANALYTICS_LOGGING=off): ' +
        'no visitor_page_views, web_analytics_events, widget_smart_events (TypeScript ' +
        'half), ai_agent_debug_events or ai_usage_logs rows. Visitor journey and ' +
        'page-path reports, the per-visitor page history in the Inbox, the ' +
        'custom-events report, smart-rule / AI-nudge conversion analytics, the AI ' +
        'answer_inspected debug trail and the AI provider/model breakdown charts all ' +
        'stay empty. AI BILLING IS UNAFFECTED — it reads ai_usage_events, which is ' +
        'written inside Postgres. To restore: unset PRODUCT_ANALYTICS_LOGGING (or set ' +
        'any value other than "off") and restart.',
    );
  }
  if (config.deliveryDiagnosticsLoggingEnabled === false) {
    console.warn(
      '[diagnostics] delivery-diagnostics logging DISABLED ' +
        '(DELIVERY_DIAGNOSTICS_LOGGING=off): no email_logs, ' +
        'channel_delivery_attempts or ai_source_sync_logs rows. You lose the only ' +
        'evidence that an invitation / password-reset / invoice email was actually ' +
        'sent, the per-attempt error code and latency of a failed WhatsApp or ' +
        'Telegram send, and the Data Hub sync history — the knowledge-source screen ' +
        'can no longer say whether the last sync succeeded. Sending, RETRY and ' +
        'ingestion themselves are unaffected (retry state lives on channel_jobs). ' +
        'To restore: unset DELIVERY_DIAGNOSTICS_LOGGING (or set any value other than ' +
        '"off") and restart.',
    );
  }
  if (config.complianceAuditLoggingEnabled === false) {
    console.warn(
      '[audit] COMPLIANCE AUDIT LOGGING DISABLED (COMPLIANCE_AUDIT_LOGGING=off) — ' +
        'NOT RECOMMENDED IN PRODUCTION. No audit_logs, security_events, ' +
        'login_attempts, admin_gate_bypass_log, plan_change_log, commerce_tool_audit ' +
        'or realtime_provider_audit rows are written. This saves nothing on an ' +
        'install with no users (all of them are request-path-only) while removing the ' +
        'legal record of administrative and privacy actions, the GDPR export\'s ' +
        'audit_logs section, the only forensic trail if this install is probed or ' +
        'compromised, account-takeover evidence, any trace of an admin gate bypass, ' +
        'and billing-dispute evidence of plan changes. To restore: unset ' +
        'COMPLIANCE_AUDIT_LOGGING (or set any value other than "off") and restart.',
    );
  }
  if (config.channelsWorkerHeartbeatEnabled === false) {
    console.warn(
      '[channels] worker heartbeat DISABLED (CHANNELS_WORKER_HEARTBEAT=off): Core no ' +
        'longer records channel_worker_heartbeats, and channelsWorkerOffline() now ' +
        'FAILS OPEN so no request path starts refusing work on a signal you silenced. ' +
        'The Super Admin channels-health panel reports the worker offline/unknown ' +
        'forever even while it drains channel_jobs normally, and Telegram diagnostics ' +
        '/ webhook repair no longer fail fast with a clean 503 when the worker really ' +
        'IS dead — the operator waits out the 12-15s operation timeout instead. ' +
        'Channel messaging is unaffected. CHEAPER LEVER FIRST: raising ' +
        'CHANNELS_HEARTBEAT_MS (up to ~100s, below the 120s staleness window) drops ' +
        '~85% of these writes and keeps the gate working. To restore: unset ' +
        'CHANNELS_WORKER_HEARTBEAT (or set any value other than "off") and restart ' +
        'BOTH Core and the channels worker.',
    );
  }

  // E2 — in-process Data Hub source-sync worker.
  // Production: run as a separate WORKER_KIND=source-sync container.
  // Dev/local: AI_SOURCE_SYNC_WORKER_INPROC=1 (preferred) or legacy
  // AI_KB_WORKER_INPROC=1 (deprecated — see warning below).
  if (
    process.env.AI_SOURCE_SYNC_WORKER_INPROC === '1' ||
    process.env.AI_KB_WORKER_INPROC === '1'
  ) {
    if (process.env.AI_KB_WORKER_INPROC === '1' && process.env.AI_SOURCE_SYNC_WORKER_INPROC !== '1') {
      console.warn('[worker] AI_KB_WORKER_INPROC is deprecated. Use AI_SOURCE_SYNC_WORKER_INPROC for source-sync or AI_KB_INTELLIGENCE_WORKER_INPROC for intelligence.');
    }
    process.env.AI_KB_WORKER_INPROC = '1'; // sourceWorker.ts checks this internally
    startInProcessSourceWorker(config);
  }

  // Phase 5A — start perf sample flusher + process sampler. Best-effort.
  // Reporting-only, and purely in-memory: this starts the collector's 60s
  // process-trend sampler, nothing else. Gating it costs ZERO Postgres
  // traffic — perfHttpMiddleware and getMonitoringCollector() are lazy and
  // keep feeding request/realtime metrics either way, so failover health
  // and the live process snapshot are unaffected. Only the admin
  // process-trend series stops filling.
  if (config.observabilityReportingTickersEnabled !== false) {
    startPerfCollectors(config);
  }

  // Phase 5C — start in-process auto-actions ticker (every 60s). Best-effort.
  // Covered by OBSERVABILITY_REPORTING_TICKERS. It writes auto_action_events,
  // which the cache below serves to live request paths (typing suppression,
  // transport selection, call media policy) — but that read only ever REMOVES
  // capability and fails open, so stopping the producer leaves visitors with
  // MORE capability, never less. Producer and consumer stay coherent because
  // the cache below is gated by the same flag.
  if (config.observabilityReportingTickersEnabled !== false) {
    startAutoActionsTicker(config);
  }

  // Phase 5C.1 — start fast in-memory cache for active auto-actions
  // (refresh ~7s). Read by effectivePolicy.ts, routes/conversations.ts and
  // routes/widget.ts. Covered by OBSERVABILITY_REPORTING_TICKERS: with the
  // flag off this is ~12.3k indexed SELECT transactions/day kept alive for a
  // table the gated producer above is no longer filling. isActionActive()
  // already returns false when the cache has never refreshed, so skipping it
  // is the same fail-open answer the hot path would get anyway. The one cost
  // is that a manual POST /api/admin/auto-actions lapses after ~60s
  // (STALE_FAIL_OPEN_MS) instead of running its full TTL.
  if (config.observabilityReportingTickersEnabled !== false) {
    startAutoActionsCache(config);
  }

  // Phase 6B — start realtime failover engine ticker (every 30s). Best-effort.
  // Its own switch, NOT the reporting flag: this ticker is not a reporter —
  // it makes the live provider-routing decision — and it is the largest
  // periodic writer left once the reporting flag is off (~5,760
  // observability_ticker_lease writes/day for the `failover_health` lease).
  if (config.realtimeFailoverTickerEnabled !== false) {
    startFailoverTicker(config);
  } else {
    console.warn(
      '[realtime] failover engine ticker NOT started (REALTIME_FAILOVER_TICKER=off): ' +
        'no 30s provider health probe, no failover/failback decisions, no ' +
        'realtime_provider_audit transition rows. Realtime KEEPS WORKING — ' +
        'loadFailoverState() is read independently on every /connect and falls back ' +
        'to effective_provider=centrifugo — but the effective provider is now PINNED ' +
        'at its last persisted value: if that provider later dies nothing moves the ' +
        'platform to polling_builtin and nothing ever fails back, so recovery means ' +
        'setting realtime_provider_lock by hand in the admin panel. To restore: unset ' +
        'REALTIME_FAILOVER_TICKER (or set any value other than "off") and restart.',
    );
  }

  // Multi-node topology — keep the Centrifugo node-health cache warm in the
  // background so the /connect assignment path never issues an HTTP probe.
  startNodeHealthRefresher(config);


  // Phase 7 — start reliability/business/health rollup (every 10 min). Best-effort.
  // Reporting-only: the hourly aggregates it writes are read by the admin
  // reliability charts and by the SLO evaluator, never by a request path.
  if (config.observabilityReportingTickersEnabled !== false) {
    startReliabilityRollup(config);
  }

  // Phase 7.5 — SLA enforcement engine (SLO eval + rule-driven actions, every 60s).
  // Covered by OBSERVABILITY_REPORTING_TICKERS. The SLO half is already a
  // near-no-op with the rollup gated off (sloEvaluator's 3h MAX_BUCKET_AGE_MS
  // guard refuses stale buckets); the enforcement half's entire blast radius
  // is writing auto_action_events, which fails open, so gating it removes
  // automatic throttling and nothing else. Without this gate the cycle costs
  // ~20k no-op slo_breach write transactions/day plus a constant read of two
  // rollup tables that the same flag already stopped filling.
  if (config.observabilityReportingTickersEnabled !== false) {
    startEnforcementTicker(config);
  }

  // Phase 8C — Call queue expiry sweeper (every 30s). Best-effort.
  startCallQueueTicker(config);

  // MaxMind GeoLite2 auto-update ticker. No-ops unless Map & Geo has
  // maxmind_local enabled + auto mode + credentials. Never blocks startup and
  // never touches the widget request path.
  startMaxmindUpdateTicker(config);

  // SEO Rank Tracking — periodic keyword-position refresh (every 15 min).
  // No-ops unless a platform rank-tracking provider is configured and
  // active. See server/services/seo/rankTrackingTicker.ts.
  startRankTrackingTicker(config);

  // Gmail — 7-day Pub/Sub watch renewal (checked every 6h). No-ops unless
  // GOOGLE_OAUTH_CLIENT_ID/SECRET + GMAIL_PUBSUB_TOPIC are configured. See
  // server/services/channels/gmail/watchRenewalTicker.ts.
  startGmailWatchRenewalTicker(config);

  // Phase 9 — Call invitation TTL sweeper (every 30s). Flips pending
  // invitations whose CALL_INVITATION_TTL_SECONDS window passed into
  // 'expired' and patches the system card so the widget UI updates.
  startInvitationExpirySweeper(config);

  // AI KB Builder — optional in-process worker (dev/local only).
  // Production deploys MUST run a separate WORKER_KIND=intelligence
  // container. Preferred flag: AI_KB_INTELLIGENCE_WORKER_INPROC=1.
  // Legacy flag AI_KB_WORKER_INPROC=1 still works but is deprecated.
  if (
    process.env.AI_KB_INTELLIGENCE_WORKER_INPROC === '1' ||
    process.env.AI_KB_WORKER_INPROC === '1'
  ) {
    if (process.env.AI_KB_WORKER_INPROC === '1' && process.env.AI_KB_INTELLIGENCE_WORKER_INPROC !== '1') {
      console.warn('[worker] AI_KB_WORKER_INPROC is deprecated. Use AI_KB_INTELLIGENCE_WORKER_INPROC for intelligence worker in-process.');
    }
    import('../worker/intelligence/index.js')
      .then((m) => m.startAiKbWorker?.())
      .catch((e) => console.warn('[ai-kb worker] inproc start failed:', e?.message));
  }

  // E10 — Scheduled regression worker (dev/local only).
  // Production: run WORKER_KIND=regression-runner in a separate container.
  if (process.env.AI_AGENT_REGRESSION_WORKER_INPROC === '1') {
    import('../worker/regression-runner/index.js')
      .then((m) => m.startRegressionWorker?.())
      .catch((e) => console.warn('[regression-worker] inproc start failed:', e?.message));
  }

  // ─── Post-deploy widget manifest invalidation ────────────────────
  // The in-memory widget manifest cache is per-process, so a fresh deploy
  // (which restarts this process) starts with an empty cache anyway. BUT:
  //  - In rolling deployments, multiple replicas may briefly serve old
  //    hashed asset names if their cached manifest pre-dates the new
  //    frontend build.
  //  - The remote-fetch path uses ETag revalidation, which can return 304
  //    against a stale cached body if we keep a residual entry in memory
  //    from before the boot completed.
  // Force-invalidate at startup, then warm the cache by reading it once
  // so the first widget request doesn't pay the cold-fetch latency.
  invalidateManifestCache();
  // Defer the warm-up so it doesn't block the listen() callback. The
  // remote fetch has a 4s timeout; even worst-case it just logs and
  // moves on without crashing the server.
  setTimeout(() => {
    try {
      const diag = getManifestDiagnostics();
      console.log(
        `[startup] widget manifest warmed: source=${diag.source}, ` +
          `loaderVersion=${diag.loaderVersion}, ` +
          `runtimeJs=${diag.runtimeJs}`,
      );
    } catch (err) {
      console.warn('[startup] widget manifest warm-up failed:', err instanceof Error ? err.message : err);
    }
  }, 100);
});

export default app;
