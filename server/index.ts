import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { loadConfig } from './config.js';
import { widgetRouter } from './routes/widget.js';
import { visitorRouter } from './routes/visitors.js';
import { healthRouter } from './routes/health.js';
import { emailRouter } from './routes/email.js';
import { authSecurityRouter } from './routes/auth.js';
import { authEmailRouter } from './routes/auth-email.js';
import { aiRouter } from './routes/ai.js';
import { storageRouter } from './routes/storage.js';
import { cdnRouter } from './routes/cdn.js';
import { billingRouter } from './routes/billing.js';
import { plansRouter } from './routes/plans.js';
import { adminRouter } from './routes/admin.js';
import { realtimeRouter } from './routes/realtime.js';
import { conversationsRouter } from './routes/conversations.js';
import { conversationAttachmentsRouter } from './routes/conversationAttachments.js';
import { conversationNotesRouter } from './routes/conversationNotes.js';
import { cannedResponsesRouter } from './routes/cannedResponses.js';
import { widgetKbRouter, publicKbRouter } from './routes/kb.js';
import { startAttachmentJanitor } from './services/attachmentJanitor.js';
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

// Email — workspace-scoped rate limit
app.use('/api/email', emailRateLimiter, emailRouter);

// AI — auth required, workspace rate limiting built into routes
app.use('/api/ai', aiRouter);

// Storage — auth required, file size limits in routes
app.use('/api/storage', storageRouter);

// CDN — auth required, purge and config
app.use('/api/cdn', cdnRouter);

// Billing — checkout, webhooks, subscription management
app.use('/api/billing', billingRouter);

// Plans & Feature Gating
app.use('/api/plans', plansRouter);

// Admin — moderate rate limit
app.use('/api/admin', adminRateLimiter, adminRouter);

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
});

export default app;
