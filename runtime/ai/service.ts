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
import { createSafeTestFetch, providerHostPolicy } from './providers/safeTransport.js';
import { redactSecrets } from '../../server/lib/redactSecrets.js';
import type { AIConfig, AIRequest, AIResponse, AIConnectionTestResult } from '../../shared/ai/types.js';
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
    const response = await executeProviderCompletion(withDefaultBaseUrl(config), request);
    return { ok: true, data: { response } };
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
  const safeFetch = createSafeTestFetch({ isHostAllowed: providerHostPolicy(config.provider) });
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
    const vectors = await embedTexts(config, texts);
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
