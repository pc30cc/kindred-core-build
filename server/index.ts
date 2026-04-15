import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
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
import { adminRouter } from './routes/admin.js';
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
const widgetAssetDir = path.resolve(process.cwd(), 'public/widget');

// Security headers
app.use(helmet());
app.use(cors({
  origin: config.corsOrigins[0] === '*' ? true : config.corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '50mb' })); // Larger limit for file uploads

// Attach config to requests
app.use((req, _res, next) => {
  (req as any).serverConfig = config;
  next();
});

// Widget static assets also served from the API container so older cached loaders
// that resolve runtime/css from api.<domain> keep working.
app.use('/widget', express.static(widgetAssetDir, {
  fallthrough: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('loader.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return;
    }

    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  },
}));

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

// Admin — moderate rate limit
app.use('/api/admin', adminRateLimiter, adminRouter);

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
});

export default app;
