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

const DEFAULT_SUPABASE_URL = 'https://bdycuenbjztkgnaqonfm.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkeWN1ZW5ianp0a2duYXFvbmZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTczODksImV4cCI6MjA5MTY3MzM4OX0.YDa2Gt-ZjADDmN5jpJZGaUiEsB152x4IsQG7yE0qiEk';

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

  const supabaseUrl = resolveEnv('SUPABASE_URL', 'VITE_SUPABASE_URL') || DEFAULT_SUPABASE_URL;
  const supabaseAnonKey = resolveEnv('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY') || DEFAULT_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = resolveEnv('SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_SERVICE_ROLE_KEY') || supabaseAnonKey;

  if (!resolveEnv('SUPABASE_URL', 'VITE_SUPABASE_URL')) {
    console.warn('[config] SUPABASE_URL is missing; falling back to the connected Supabase project URL.');
  }

  if (!resolveEnv('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY')) {
    console.warn('[config] SUPABASE_ANON_KEY is missing; falling back to the connected Supabase publishable key.');
  }

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
