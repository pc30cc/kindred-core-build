/**
 * Deployment-safe resolution of the backend API base URL.
 *
 * `VITE_API_BASE_URL` is a BUILD-TIME variable. If it is not passed as a
 * Docker build ARG, the compiled bundle used to interpolate the literal
 * string `undefined`, producing requests to `undefined/api/auth/login` —
 * which broke login and password reset with a generic network error.
 *
 * Behaviour:
 *  - explicitly configured  → that origin, trailing slashes stripped, so
 *    `https://api.example.com/` never yields `https://api.example.com//api/...`
 *  - absent / empty         → SAME ORIGIN (`''`), so calls become
 *    `/api/auth/login` and the frontend nginx `/api/` proxy (BACKEND_URL)
 *    forwards them to Express.
 *
 * Never hardcodes a domain, never falls back to localhost, and never
 * derives the backend from the Supabase URL.
 */
export function resolveApiBase(raw?: string | null): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value === 'undefined' || value === 'null') return '';
  // Every client path already starts with `/api`. Operators commonly paste
  // `https://api.example.com/api` into VITE_API_BASE_URL; retaining that
  // suffix silently creates `/api/api/...`, which reaches Express but falls
  // through to its generic 404 response. Accept both forms and keep the
  // public configuration forgiving.
  return value.replace(/\/+$/, '').replace(/\/api$/i, '');
}

const viteEnv = (import.meta as unknown as {
  env?: Record<string, string | boolean | undefined>;
}).env;

// During local/Lovable preview, route API requests through Vite's same-origin
// proxy. Preview hosts are intentionally not added to production CORS because
// they are temporary and unpredictable. Production builds continue to use the
// explicitly configured public API origin.
export const API_BASE = viteEnv?.DEV
  ? ''
  : resolveApiBase(typeof viteEnv?.VITE_API_BASE_URL === 'string' ? viteEnv.VITE_API_BASE_URL : undefined);
