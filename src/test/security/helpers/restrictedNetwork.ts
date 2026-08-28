/**
 * Shared restricted-network harness.
 *
 * Models the production topology used by the AI Provider Network Isolation
 * work:
 *
 *   IRAN / restricted network                 EXTERNAL / unrestricted network
 *   ┌───────────────────────────┐             ┌──────────────────────────────┐
 *   │ Core (this process)       │ ──HTTPS──▶  │ AI Runtime ──▶ AI providers  │
 *   │ provider egress: BLOCKED  │             │ provider egress: ALLOWED     │
 *   └───────────────────────────┘             └──────────────────────────────┘
 *
 * A single global fetch stub plays the network:
 *  - AI_RUNTIME_URL stays reachable and is dispatched into the REAL runtime
 *    handlers (runtime/ai/service.ts).
 *  - Provider hosts are only reachable while a runtime handler is on the
 *    stack. A provider request made from Core is recorded as a violation and
 *    fails the way a firewalled egress fails.
 *  - Any other host is unreachable, so a "fallback" provider call from Core
 *    cannot silently succeed either.
 *
 * Used by the per-entrypoint restricted-network integration tests.
 */
import { vi } from 'vitest';
import { handleComplete, handleTest, handleEmbed, statusForCode } from '../../../../runtime/ai/service.js';
import { AI_RUNTIME_ROUTES, AI_RUNTIME_SECRET_HEADER } from '../../../../shared/ai/internalRoutes.js';

export const RUNTIME_BASE = 'https://ai-runtime.external.example';
export const RUNTIME_SECRET = 'runtime-secret';

export const PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'openrouter.ai',
  'api.mistral.ai',
];

/** ServerConfig fragment that points Core at the external AI Runtime. */
export function restrictedServerConfig(extra: Record<string, unknown> = {}): any {
  return {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON_KEY',
    supabaseServiceRoleKey: 'SERVICE_KEY',
    aiRuntimeBaseUrl: RUNTIME_BASE,
    aiRuntimeInternalSecret: RUNTIME_SECRET,
    ...extra,
  };
}

export interface RestrictedNetwork {
  /** Provider URLs Core tried to open directly. MUST stay empty. */
  coreProviderViolations: string[];
  /** Provider URLs opened from inside a runtime handler. */
  providerHits: string[];
  /** AI Runtime URLs Core called. */
  runtimeHits: string[];
  /** Non-provider, non-runtime URLs Core reached (e.g. a crawled site). */
  otherHits: string[];
  reset(): void;
}

export interface RestrictedNetworkOptions {
  /**
   * Optional handler for legitimate, non-provider Core egress (for example
   * the KB Builder crawling a customer website). Return undefined to leave
   * the host unreachable.
   */
  allowHost?: (url: string, host: string) => Response | undefined;
  /** Override the provider payload returned once the runtime reaches it. */
  providerResponse?: (url: string) => Response;
}

/** What a provider returns once the *unrestricted* side reaches it. */
export function defaultProviderResponse(url: string): Response {
  if (url.includes('/embeddings')) {
    return new Response(
      JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }], model: 'text-embedding-3-small' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.includes('anthropic')) {
    return new Response(
      JSON.stringify({
        content: [{ type: 'text', text: 'hello from anthropic' }],
        model: 'claude',
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: 'hello from provider' }, finish_reason: 'stop' }],
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export function installRestrictedNetwork(options: RestrictedNetworkOptions = {}): RestrictedNetwork {
  const net: RestrictedNetwork = {
    coreProviderViolations: [],
    providerHits: [],
    runtimeHits: [],
    otherHits: [],
    reset() {
      net.coreProviderViolations.length = 0;
      net.providerHits.length = 0;
      net.runtimeHits.length = 0;
      net.otherHits.length = 0;
    },
  };
  const providerResponse = options.providerResponse ?? defaultProviderResponse;
  let insideRuntime = 0;

  vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);

    // Hop 1: Core → AI Runtime (the only AI egress Core is allowed).
    if (url.startsWith(RUNTIME_BASE)) {
      net.runtimeHits.push(url);
      const route = url.slice(RUNTIME_BASE.length);
      const rawHeaders = (init.headers || {}) as any;
      const headers: Record<string, string> =
        typeof rawHeaders?.get === 'function'
          ? Object.fromEntries((rawHeaders as Headers).entries())
          : rawHeaders;
      if (headers[AI_RUNTIME_SECRET_HEADER] !== RUNTIME_SECRET) {
        return new Response(JSON.stringify({ ok: false, error: 'runtime_unauthorized' }), { status: 401 });
      }
      const body = JSON.parse(String(init.body || '{}'));
      insideRuntime++;
      try {
        const out: any =
          route === AI_RUNTIME_ROUTES.complete
            ? await handleComplete(body)
            : route === AI_RUNTIME_ROUTES.test
              ? await handleTest(body)
              : route === AI_RUNTIME_ROUTES.embed
                ? await handleEmbed(body)
                : { ok: false, code: 'internal_error', message: 'unknown route' };
        const status = out.ok ? 200 : statusForCode(out.code);
        const payload = out.ok ? { ok: true, ...out.data } : { ok: false, error: out.code, message: out.message };
        return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
      } finally {
        insideRuntime--;
      }
    }

    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return '';
      }
    })();

    // Hop 2: provider sockets.
    const isProvider = PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || host.includes('openai');
    if (isProvider) {
      if (insideRuntime === 0) {
        // Core tried to reach a provider directly — impossible in this topology.
        net.coreProviderViolations.push(url);
        throw new TypeError(`fetch failed: ${host} is unreachable from the restricted network`);
      }
      net.providerHits.push(url);
      return providerResponse(url);
    }

    // Legitimate non-provider Core egress (opt-in per test).
    const allowed = options.allowHost?.(url, host);
    if (allowed) {
      net.otherHits.push(url);
      return allowed;
    }

    throw new TypeError(`fetch failed: ${host || url} is unreachable from the restricted network`);
  });

  return net;
}
