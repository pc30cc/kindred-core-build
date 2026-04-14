// Server environment contract
// All sensitive values come from server env, never from frontend

export interface ServerConfig {
  port: number;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  corsOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMax: number;
  /** Base URL of the frontend app (e.g. https://destekly.tr). Used for auth email links. */
  appUrl: string;
  /** Display name for email templates */
  appName: string;
  /** System sender email address for auth emails */
  systemFromEmail: string;
  /** Secret key for signing session cookies (required in production) */
  sessionSecret: string;
}

export function loadConfig(): ServerConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const isProduction = process.env.NODE_ENV === 'production';

  // SESSION_SECRET is required in production
  const sessionSecret = process.env.SESSION_SECRET || '';
  if (isProduction && !sessionSecret) {
    throw new Error('Missing required env var: SESSION_SECRET (required in production)');
  }

  return {
    port: parseInt(process.env.PORT || '3001', 10),
    supabaseUrl: required('SUPABASE_URL'),
    supabaseAnonKey: required('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()),
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    appUrl: process.env.APP_URL || '',
    appName: process.env.APP_NAME || 'Growth Suite',
    systemFromEmail: process.env.SYSTEM_FROM_EMAIL || 'noreply@example.com',
    sessionSecret: sessionSecret || 'dev-secret-change-me',
  };
}
