/**
 * AI RUNTIME SERVICE LAYER.
 *
 * Pure request handlers shared by the HTTP service (`ai-runtime/server.ts`)
 * and by tests. Stateless by design: every request carries the resolved
 * provider config, so the runtime holds NO database access, NO service-role
 * key and NO long-lived credentials.
 */
import { executeProviderCompletion, testAIConnection, isSupportedProvider } from './providers/executor.js';
import { withDefaultBaseUrl, isOpenAICompatible } from './providers/catalog.js';
import { embedTexts, type EmbedProviderConfig } from './providers/embeddings.js';
import { createSafeTestFetch, createSafeProviderFetch, providerHostPolicy } from './providers/safeTransport.js';
import { redactSecrets } from '../../shared/security/redactSecrets.js';
import { isOperatorAllowedPrivateHost } from '../../shared/ai/endpointPolicy.js';
import type { AIConfig, AIRequest, AIResponse, AIConnectionTestResult, HttpFetch } from '../../shared/ai/types.js';
import type { AiRuntimeErrorCode } from '../../shared/ai/internalRoutes.js';

export interface RuntimeFailure {
  ok: false;
  code: AiRuntimeErrorCode;
  message: string;
}
export interface RuntimeSuccess<T> { ok: true; data: T }
export type RuntimeResult<T> = RuntimeSuccess<T> | RuntimeFailure;

function fail(code: AiRuntimeErrorCode, message: string): RuntimeFailure {
  return { ok: false, code, message: redactSecrets(message) || code };
}

function validConfig(raw: any): raw is AIConfig {
  return Boolean(raw && typeof raw.provider === 'string' && typeof raw.model === 'string');
}

/**
 * Picks the transport for a completion / embedding request.
 *
 *  - No base URL: the endpoint comes from the runtime's own catalog / the
 *    executor's built-in default — a constant, not tenant input. Unchanged.
 *  - `endpointScope: 'platform'`: the platform default provider, configured by
 *    the operator (platform admin). Unchanged, so a self-hosted deployment can
 *    keep pointing its default provider at a private LLM (e.g. Ollama).
 *  - Anything else is a workspace-supplied base URL (missing scope is treated
 *    as workspace — fail closed): SSRF-safe transport with the provider host
 *    policy, public-address check, connect-time DNS pinning and same-origin-
 *    only, per-hop re-validated redirects. Hosts the operator explicitly lists
 *    in AI_PROVIDER_PRIVATE_HOSTS may be private and use plain http.
 *
 * Must be called with the config BEFORE withDefaultBaseUrl() fills defaults.
 */
export function providerFetchFor(config: {
  provider: string;
  baseUrl?: string;
  endpointScope?: string;
}): HttpFetch | undefined {
  if (!config.baseUrl) return undefined;
  if (config.endpointScope === 'platform') return undefined;
  const policy = providerHostPolicy(config.provider);
  return createSafeProviderFetch({
    isHostAllowed: (hostname) => isOperatorAllowedPrivateHost(hostname) || !policy || policy(hostname),
    isPrivateHostAllowed: (hostname) => isOperatorAllowedPrivateHost(hostname),
  });
}

export async function handleComplete(body: any): Promise<RuntimeResult<{ response: AIResponse }>> {
  const config = body?.config;
  const request = body?.request as AIRequest | undefined;
  if (!validConfig(config)) return fail('invalid_request', 'config.provider and config.model are required');
  if (!request || typeof request.prompt !== 'string' || !request.prompt) {
    return fail('invalid_request', 'request.prompt is required');
  }
  if (!isSupportedProvider(config.provider)) {
    return fail('unsupported_provider', `Unsupported AI provider: ${config.provider}`);
  }
  try {
    const fetchImpl = providerFetchFor(config);
    const response = await executeProviderCompletion(withDefaultBaseUrl(config), request, fetchImpl);
    // Echo the logical execution id so Core can correlate one request with one
    // usage/accounting row even across transport replays.
    return { ok: true, data: { response: { ...response, requestId: request.requestId } } };
  } catch (err: any) {
    return fail('provider_error', err?.message || 'provider call failed');
  }
}

export async function handleTest(body: any): Promise<RuntimeResult<{ result: AIConnectionTestResult }>> {
  const config = body?.config;
  if (!validConfig(config)) return fail('invalid_request', 'config.provider and config.model are required');
  if (!isSupportedProvider(config.provider)) {
    return fail('unsupported_provider', `Unsupported AI provider: ${config.provider}`);
  }
  // Validation, DNS pinning and redirect handling all inside one boundary —
  // the operator-supplied baseUrl can never be used to reach a private host.
  // Operator allow-listed private hosts (AI_PROVIDER_PRIVATE_HOSTS) can be
  // tested too, matching what completions will accept.
  const policy = providerHostPolicy(config.provider);
  const safeFetch = createSafeTestFetch({
    isHostAllowed: policy
      ? (hostname) => isOperatorAllowedPrivateHost(hostname) || policy(hostname)
      : undefined,
    isPrivateHostAllowed: (hostname) => isOperatorAllowedPrivateHost(hostname),
  });
  const result = await testAIConnection({ ...config }, { fetchImpl: safeFetch });
  return { ok: true, data: { result } };
}

export async function handleEmbed(body: any): Promise<RuntimeResult<{ vectors: number[][] }>> {
  const config = body?.config as EmbedProviderConfig | undefined;
  const texts = body?.texts;
  if (!config || typeof config.provider !== 'string' || typeof config.model !== 'string') {
    return fail('invalid_request', 'config.provider and config.model are required');
  }
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) {
    return fail('invalid_request', 'texts must be an array of strings');
  }
  if (!isOpenAICompatible(config.provider)) {
    return fail('unsupported_provider', `Provider "${config.provider}" has no OpenAI-compatible embeddings API`);
  }
  try {
    const vectors = await embedTexts(config, texts, providerFetchFor(config));
    return { ok: true, data: { vectors } };
  } catch (err: any) {
    return fail('provider_error', err?.message || 'embedding call failed');
  }
}

/** HTTP status for each failure code. */
export function statusForCode(code: AiRuntimeErrorCode): number {
  switch (code) {
    case 'invalid_request':
    case 'unsupported_provider':
      return 400;
    case 'runtime_unauthorized':
      return 401;
    case 'contract_mismatch':
      return 409;
    case 'provider_error':
      return 502;
    default:
      return 500;
  }
}
