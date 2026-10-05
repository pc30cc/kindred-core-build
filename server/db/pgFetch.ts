/**
 * A `fetch` for supabase-js that never leaves the process: `/rest/v1/*`
 * requests are answered by the in-process PostgREST engine over the direct
 * database connection. Every other Supabase service (Auth, Storage, Realtime,
 * Edge Functions) answers 501 — with a direct connection the platform uses
 * Supabase, if at all, purely as PostgreSQL.
 */
import type { PostgrestEngine } from './postgrest/engine.js';
import { statusText } from './postgrest/engine.js';

const REST_PREFIX = '/rest/v1';

function serviceName(pathname: string): string {
  const m = /^\/(auth|storage|realtime|functions|graphql)\/v1/.exec(pathname);
  return m ? m[1] : pathname;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: statusText(status),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function createPgFetch(engine: PostgrestEngine): typeof fetch {
  return async function pgFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const at = url.pathname.indexOf(REST_PREFIX);
    if (at < 0) {
      const service = serviceName(url.pathname);
      return jsonResponse(501, {
        code: 'DIRECT_DATABASE',
        message: `Supabase ${service} is not available: the server is connected straight to PostgreSQL (DATABASE_URL) and uses no other Supabase service.`,
        details: null,
        hint: null,
        error: 'not_available',
        error_description: `Supabase ${service} is not used with DATABASE_URL`,
      });
    }
    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    const res = await engine.handle({
      method,
      path: url.pathname.slice(at + REST_PREFIX.length) || '/',
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const empty = method === 'HEAD' || res.status === 204 || res.body === '';
    return new Response(empty ? null : res.body, {
      status: res.status,
      statusText: statusText(res.status),
      headers: { 'content-type': 'application/json; charset=utf-8', ...res.headers },
    });
  };
}
