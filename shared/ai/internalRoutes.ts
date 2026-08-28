/**
 * CORE ⇄ AI RUNTIME CONTRACT — single source of truth.
 *
 * Topology this exists for:
 *
 *   IRAN / restricted network            EXTERNAL / unrestricted network
 *   ┌───────────────────────────┐        ┌──────────────────────────────┐
 *   │ Core (Express) + DB + UI  │ ─────▶ │ AI Runtime (ai-runtime/)     │
 *   │ NEVER talks to a provider │        │ ONLY process that talks to   │
 *   └───────────────────────────┘        │ OpenAI/Anthropic/Gemini/...  │
 *                                        └──────────────────────────────┘
 *
 * Core → AI Runtime is a one-way, authenticated, private call. The runtime
 * never calls back into Core.
 *
 * Both sides import THIS file. Changing a path without bumping
 * AI_RUNTIME_CONTRACT_VERSION is a deployment bug: the runtime refuses to
 * serve a Core whose advertised contract version differs.
 */

export const AI_RUNTIME_CONTRACT_VERSION = '1';

export const AI_RUNTIME_ROUTES = {
  /** Liveness — no auth, no secrets, no provider contact. */
  health: '/health',
  /** Readiness — auth required; reports contract version + provider egress. */
  ready: '/ready',
  /** Execute one completion against a resolved (or workspace-resolved) provider. */
  complete: '/internal/ai/complete',
  /** Operator-triggered provider connection test (SSRF-pinned transport). */
  test: '/internal/ai/test',
  /** Embedding generation for OpenAI-compatible providers. */
  embed: '/internal/ai/embed',
} as const;

export type AiRuntimeRouteKey = keyof typeof AI_RUNTIME_ROUTES;

/** Header carrying the shared Core ⇄ Runtime secret (survives proxies that eat Authorization). */
export const AI_RUNTIME_SECRET_HEADER = 'x-ai-runtime-secret';
/** Header carrying the contract version Core was built against. */
export const AI_RUNTIME_CONTRACT_HEADER = 'x-ai-runtime-contract';

/**
 * Stable error codes returned by the runtime. Core maps these to user-facing
 * messages WITHOUT inventing a fallback that hides a misconfiguration.
 */
export type AiRuntimeErrorCode =
  | 'runtime_not_configured'   // Core has no AI_RUNTIME_URL / secret
  | 'runtime_unreachable'      // transport failure Core→Runtime
  | 'runtime_unauthorized'     // secret mismatch
  | 'contract_mismatch'        // version skew between Core and Runtime
  | 'no_provider_configured'   // no AI provider row for the workspace
  | 'unsupported_provider'
  | 'invalid_request'
  | 'provider_error'           // provider returned an error / network failed
  | 'internal_error';

export interface AiRuntimeErrorBody {
  error: AiRuntimeErrorCode;
  /** Redacted, human-readable detail. Never contains an API key. */
  message: string;
  contractVersion?: string;
}

/** True when the failure is worth a bounded retry by the caller. */
export function isRetryableRuntimeError(code: AiRuntimeErrorCode): boolean {
  return code === 'runtime_unreachable' || code === 'internal_error';
}
