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
  return value.replace(/\/+$/, '');
}

export const API_BASE = resolveApiBase(
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL,
);
