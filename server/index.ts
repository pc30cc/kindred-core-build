import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
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
import { notificationsRouter } from './routes/notifications.js';
import { availabilityRouter } from './routes/availability.js';
import { billingRouter } from './routes/billing.js';
import { plansRouter } from './routes/plans.js';
import { adminRouter } from './routes/admin.js';
import { realtimeRouter } from './routes/realtime.js';
import { mapGeoRouter } from './routes/mapGeo.js';
import { conversationsRouter } from './routes/conversations.js';
import { conversationAttachmentsRouter } from './routes/conversationAttachments.js';
import { conversationNotesRouter } from './routes/conversationNotes.js';
import { cannedResponsesRouter } from './routes/cannedResponses.js';
import { widgetKbRouter, publicKbRouter } from './routes/kb.js';
import { privacyRouter } from './routes/privacy.js';
import { startAttachmentJanitor } from './services/attachmentJanitor.js';
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
import { invalidateManifestCache, getManifestDiagnostics } from './services/widget/manifest.js';
import { widgetCorsMiddleware } from './middleware/widgetCors.js';
import {
  ipBlockMiddleware,
  authRateLimiter,
  emailRateLimiter,
  widgetRateLimiter,
  visitorRateLimiter,
  adminRateLimiter,
  abuseDetectionMiddleware,
  validateJsonBody,
} from './middleware/security.js';

const config = loadConfig();

const app = express();

// Trust upstream reverse proxies (nginx / Cloudflare / Coolify). Without this,
// req.ip would always be the proxy's address and our IP-extraction utility
// wouldn't be able to reach x-forwarded-for / cf-connecting-ip safely. We use
// "loopback, linklocal, uniquelocal" so only proxies on private networks are
// trusted — public IPs in the chain are still treated as untrusted hops.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

// Security headers
app.use(helmet());

const appCors = cors({
  origin: config.corsOrigins[0] === '*' ? true : config.corsOrigins,
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
    req.path.startsWith('/api/visitors') ||
    PUBLIC_WIDGET_REALTIME_PATHS.has(req.path)
  ) {
    return next();
  }
  return appCors(req, res, next);
});

app.use(express.json({ limit: '50mb' })); // Larger limit for file uploads
app.use(cookieParser()); // Parse signed visitor cookies (HttpOnly dvsid)

// Attach config to requests
app.use((req, _res, next) => {
  (req as any).serverConfig = config;
  next();
});

// Global: IP blocking check
app.use('/api/', ipBlockMiddleware());

// Global: Abuse detection
app.use('/api/', abuseDetectionMiddleware());

// ─── Routes with per-endpoint rate limiting ──────────────────────

// Health (no rate limit)
app.use('/api/health', healthRouter);

// Auth security (brute force + captcha) — strict rate limit
app.use('/api/auth', authRateLimiter, authSecurityRouter);

// Auth email — verification & reset via configured provider
app.use('/api/auth-email', emailRateLimiter, authEmailRouter);

// Widget — dynamic CORS + rate limit
app.use('/api/widget', widgetCorsMiddleware(), widgetRateLimiter, widgetRouter);

// KB widget JSON endpoints — same dynamic CORS + rate limit as widget.
app.use('/api/widget/kb', widgetCorsMiddleware(), widgetRateLimiter, widgetKbRouter);

// Public KB SSR routes — server-rendered HTML for /help/:locale/...
// No CORS / no rate limit; these are normal public web pages indexed by search engines.
app.use(publicKbRouter);

// Visitor tracking — dynamic CORS + rate limit
app.use('/api/visitors', widgetCorsMiddleware(), visitorRateLimiter, visitorRouter);

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

// Self-service notification preferences
app.use('/api/notifications', notificationsRouter);

// Self-service per-user availability schedule
app.use('/api/availability', availabilityRouter);

// Billing — checkout, webhooks, subscription management
app.use('/api/billing', billingRouter);

// Plans & Feature Gating
app.use('/api/plans', plansRouter);

// Admin — moderate rate limit
app.use('/api/admin', adminRateLimiter, adminRouter);

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
  // GDPR — start privacy job worker (in-process loop).
  startPrivacyWorker(config);
  // GDPR — start hourly TTL purge for expired export artifacts (provider-based).
  startPrivacyExpirySweep(config);

  // Phase 3 — start in-process metrics rollup (every 10 min). Best-effort.
  startMetricsRollup(config);

  // Phase 4 — start in-process alerting ticker (every 60s). Best-effort.
  startAlertingTicker(config);

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
