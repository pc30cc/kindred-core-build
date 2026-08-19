import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { widgetRouter } from './routes/widget.js';
import { visitorRouter, visitorsAdminRouter } from './routes/visitors.js';
import { healthRouter } from './routes/health.js';
import { emailRouter } from './routes/email.js';
import { authSecurityRouter } from './routes/auth.js';
import { authEmailRouter } from './routes/auth-email.js';
import { aiRouter } from './routes/ai.js';
import { storageRouter } from './routes/storage.js';
import { cdnRouter } from './routes/cdn.js';
import { accountRouter } from './routes/account.js';
import { workspacesRouter } from './routes/workspaces.js';
import { workspaceMembersRouter } from './routes/workspaceMembers.js';
import { widgetSettingsRouter } from './routes/widgetSettings.js';
import { notificationsRouter } from './routes/notifications.js';
import { workspaceAlertsRouter } from './routes/workspaceAlerts.js';
import { availabilityRouter } from './routes/availability.js';
import { operatorActivityRouter } from './routes/operatorActivity.js';
import { billingRouter, billingWebhookRouter } from './routes/billing.js';
import { plansRouter } from './routes/plans.js';
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
import { startPrivacyExpirySweep } from './services/privacy/expirySweep.js';
import { startMetricsRollup } from './services/observability/rollupTicker.js';
import { startAlertingTicker } from './services/observability/alertingTicker.js';
import { startPerfCollectors } from './services/observability/perf.js';
import { startAutoActionsTicker } from './services/observability/autoActionsTicker.js';
import { startAutoActionsCache } from './services/observability/autoActionsCache.js';
import { startFailoverTicker } from './services/realtime/failoverTicker.js';
import { startReliabilityRollup } from './services/observability/reliabilityRollupTicker.js';
import { startEnforcementTicker } from './services/observability/enforcementTicker.js';
import { startMaxmindUpdateTicker } from './services/geo/maxmindUpdater.js';
import { invalidateManifestCache, getManifestDiagnostics } from './services/widget/manifest.js';
import { widgetCorsMiddleware } from './middleware/widgetCors.js';
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
      setHeaders: (res, filePath) => widgetAssetHeaders(res as any, filePath),
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
      setHeaders: (res, filePath) => widgetAssetHeaders(res as any, filePath),
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
    'browser requests with credentials are now REJECTED by default — set ' +
    'CORS_ORIGINS to your frontend origin(s) if the frontend is served ' +
    'from a different origin than this API. Same-origin deployments are ' +
    'unaffected.'
  );
}
const appCors = cors({
  origin: config.corsOrigins.length === 1 && config.corsOrigins[0] === '*' ? false : config.corsOrigins,
  credentials: true,
});

// Public widget-facing routes manage their own dynamic CORS via widgetCorsMiddleware.
// /api/realtime/connect and /api/realtime/subscribe are also public widget routes
// (called from arbitrary customer origins) — admin routes under /api/realtime/admin
// still need the standard appCors and are handled below.
const PUBLIC_WIDGET_REALTIME_PATHS = new Set([
  '/api/realtime/connect',
  '/api/realtime/subscribe',
]);

app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/widget') ||
    req.path.startsWith('/api/call-widget') ||
    req.path.startsWith('/api/visitors') ||
    PUBLIC_WIDGET_REALTIME_PATHS.has(req.path)
  ) {
    return next();
  }
  return appCors(req, res, next);
});

// Attach config FIRST so the webhook route (which bypasses json/cookieParser)
// can still resolve its config off the request object.
app.use((req, _res, next) => {
  (req as any).serverConfig = config;
  next();
});

// ─── LiveKit webhook — must run BEFORE express.json so we can hash the
// raw body for signature verification. The router uses its own raw body
// parser at the route level. ────────────────────────────────────────────
app.use('/api/calls/livekit/webhook', livekitWebhookRouter);

// Billing provider webhooks — same reason: signature verification needs the
// exact raw bytes, so this mounts before express.json with its own raw parser.
app.use('/api/billing/webhook', billingWebhookRouter);

// JSON / cookies for everything else. Skip the webhook path explicitly so
// a future re-order can't accidentally consume the raw body.
app.use((req, res, next) => {
  if (req.path === '/api/calls/livekit/webhook') return next();
  if (req.path.startsWith('/api/billing/webhook')) return next();
  return (express.json({ limit: '50mb' }) as any)(req, res, next);
});
app.use(cookieParser()); // Parse signed visitor cookies (HttpOnly dvsid)

// Global: IP blocking check
app.use('/api/', ipBlockMiddleware());

// Global: Abuse detection
app.use('/api/', abuseDetectionMiddleware());

// ─── Routes with per-endpoint rate limiting ──────────────────────

// Health (no rate limit)
app.use('/api/health', healthRouter);

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
app.use('/api/widget-settings', widgetSettingsRouter);

// Self-service notification preferences
app.use('/api/notifications', notificationsRouter);

// Workspace operational alerts (derived, read-only)
app.use('/api/workspace-alerts', workspaceAlertsRouter);

// Self-service per-user availability schedule
app.use('/api/availability', availabilityRouter);
app.use('/api/operator-activity', operatorActivityRouter);

// Billing — checkout, webhooks, subscription management
app.use('/api/billing', billingRouter);

// Plans & Feature Gating
app.use('/api/plans', plansRouter);

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
app.use('/api/realtime/connect', widgetCorsMiddleware());
app.use('/api/realtime/subscribe', widgetCorsMiddleware());
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
  // GDPR — start hourly TTL purge for expired export artifacts (provider-based).
  startPrivacyExpirySweep(config);

  // Phase 3 — start in-process metrics rollup (every 10 min). Best-effort.
  startMetricsRollup(config);

  // Phase 4 — start in-process alerting ticker (every 60s). Best-effort.
  startAlertingTicker(config);

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
  startPerfCollectors(config);

  // Phase 5C — start in-process auto-actions ticker (every 60s). Best-effort.
  startAutoActionsTicker(config);

  // Phase 5C.1 — start fast in-memory cache for active auto-actions
  // (refresh ~7s). Required by hot-path checks like typing suppression.
  startAutoActionsCache(config);

  // Phase 6B — start realtime failover engine ticker (every 30s). Best-effort.
  startFailoverTicker(config);

  // Phase 7 — start reliability/business/health rollup (every 10 min). Best-effort.
  startReliabilityRollup(config);

  // Phase 7.5 — SLA enforcement engine (SLO eval + rule-driven actions, every 60s).
  startEnforcementTicker(config);

  // Phase 8C — Call queue expiry sweeper (every 30s). Best-effort.
  startCallQueueTicker(config);

  // MaxMind GeoLite2 auto-update ticker. No-ops unless Map & Geo has
  // maxmind_local enabled + auto mode + credentials. Never blocks startup and
  // never touches the widget request path.
  startMaxmindUpdateTicker(config);

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
    } catch (err: any) {
      console.warn('[startup] widget manifest warm-up failed:', err?.message || err);
    }
  }, 100);
});

export default app;
