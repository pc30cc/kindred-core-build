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
}

export function loadConfig(): ServerConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  return {
    port: parseInt(process.env.PORT || '3001', 10),
    supabaseUrl: required('SUPABASE_URL'),
    supabaseAnonKey: required('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()),
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    initialAdminEmail: process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase() || undefined,
  };
}
