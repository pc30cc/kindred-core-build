import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { loadConfig } from './config.js';
import { widgetRouter } from './routes/widget.js';
import { visitorRouter } from './routes/visitors.js';
import { healthRouter } from './routes/health.js';
import { emailRouter } from './routes/email.js';

const config = loadConfig();

const app = express();

// Security
app.use(helmet());
app.use(cors({
  origin: config.corsOrigins[0] === '*' ? true : config.corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Stricter rate limit for widget/visitor ingestion
const widgetLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// Attach config to requests
app.use((req, _res, next) => {
  (req as any).serverConfig = config;
  next();
});

// Routes
app.use('/api/health', healthRouter);
app.use('/api/widget', widgetLimiter, widgetRouter);
app.use('/api/visitors', widgetLimiter, visitorRouter);
app.use('/api/email', limiter, emailRouter);

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
