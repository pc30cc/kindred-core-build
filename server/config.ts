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
}

export function loadConfig(): ServerConfig {
  const resolveEnv = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const val = process.env[key]?.trim();
      if (val) return val;
    }
    return undefined;
  };

  const required = (...keys: string[]): string => {
    const val = resolveEnv(...keys);
    if (!val) throw new Error(`Missing required env var: ${keys[0]}`);
    return val;
  };

  const supabaseUrl = required('SUPABASE_URL', 'VITE_SUPABASE_URL');
  const supabaseAnonKey = required('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY');
  const supabaseServiceRoleKey = resolveEnv('SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_SERVICE_ROLE_KEY') || supabaseAnonKey;

  if (!resolveEnv('SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_SERVICE_ROLE_KEY')) {
    console.warn('[config] SUPABASE_SERVICE_ROLE_KEY is missing; falling back to anon key until it is configured.');
  }

  return {
    port: parseInt(process.env.PORT || '3001', 10),
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()),
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  };
}
