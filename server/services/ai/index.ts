/**
 * AI orchestration — Core side.
 *
 * PROVIDER NETWORK ISOLATION (non-negotiable):
 *   Core NEVER makes a network request to an AI provider. This file resolves
 *   provider configuration from the database, enforces credits/usage logging,
 *   and delegates every provider call to the AI Runtime service
 *   (`ai-runtime/server.ts`) through server/services/ai/runtimeClient.ts.
 *
 *   The provider implementations themselves live in runtime/ai/providers/**,
 *   deliberately outside `server/**` so this boundary cannot be crossed by an
 *   accidental import. src/test/security/aiProviderIsolation.test.ts fails the
 *   build if Core ever imports them again.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { redactSecrets } from '../../lib/redactSecrets.js';
import { runtimeComplete, AiRuntimeError } from './runtimeClient.js';

// Pure, network-free helpers re-exported for existing Core callers and tests.
export { readBoundedEnvInt, isRetryableStatus, parseRetryAfterMs } from '../../../shared/ai/policy.js';
export {
  parseOpenAIChatCompletion,
  parseAnthropicMessage,
  parseGeminiGenerateContent,
  readProviderErrorMessage,
} from '../../../shared/ai/parse.js';
export type {
  OpenAIChatCompletion,
  AnthropicMessage,
  GeminiGenerateContent,
} from '../../../shared/ai/parse.js';
export type {
  AIConfig,
  AIRequest,
  AIResponse,
  AIConnectionTestResult,
  HttpFetch,
  JsonResponse,
} from '../../../shared/ai/types.js';

import type { AIConfig, AIRequest, AIResponse } from '../../../shared/ai/types.js';

/**
 * Resolve AI provider config from DB for a workspace.
 * Resolution: workspace provider_configs → global app_runtime_config → null
 *
 * Database only — no provider contact. Default endpoints are intentionally NOT
 * applied here: the AI Runtime owns the provider endpoint catalog, so Core
 * holds no provider hostnames.
 */
export async function resolveAIConfig(serverConfig: ServerConfig, workspaceId: string): Promise<AIConfig | null> {
  const sb = getServiceClient(serverConfig);

  // 1. Workspace-level provider config
  const { data: wsConfig } = await sb
    .from('provider_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'ai')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (wsConfig?.config) {
    const c = wsConfig.config as any;
    if (!c.api_key) {
      console.error('[ai] workspace provider_configs missing api_key', {
        workspaceId,
        provider: wsConfig.provider_name,
      });
    } else {
      return {
        provider: wsConfig.provider_name,
        apiKey: c.api_key,
        model: c.model || 'gpt-4o-mini',
        maxTokens: c.max_tokens ? parseInt(c.max_tokens) : undefined,
        temperature: c.temperature ? parseFloat(c.temperature) : undefined,
        baseUrl: c.base_url || c.endpoint || undefined,
        orgId: c.org_id,
      };
    }
  }

  // 2. Global default from runtime config
  const { data: globalConfig } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_ai_provider')
    .single();

  if (globalConfig?.value) {
    const raw = globalConfig.value as any;
    // Support two shapes:
    //  A) flat: { provider, api_key, model, ... }
    //  B) nested: { provider_name, config: { api_key, model, ... } }
    const provider = raw.provider || raw.provider_name || 'openai';
    const c = raw.config && typeof raw.config === 'object' ? raw.config : raw;
    if (!c.api_key) {
      console.error('[ai] default_ai_provider missing api_key', {
        provider,
        hasConfigWrapper: !!raw.config,
        keys: Object.keys(raw),
      });
      return null;
    }
    return {
      provider,
      apiKey: c.api_key,
      model: c.model || 'gpt-4o-mini',
      maxTokens: c.max_tokens ? parseInt(c.max_tokens) : undefined,
      temperature: c.temperature ? parseFloat(c.temperature) : undefined,
      baseUrl: c.base_url || c.endpoint || undefined,
      orgId: c.org_id,
    };
  }

  return null;
}

/**
 * Execute an AI completion through the resolved provider (via the AI Runtime).
 * Logs usage to ai_usage_logs.
 */
export async function executeAICompletion(
  serverConfig: ServerConfig,
  request: AIRequest
): Promise<AIResponse> {
  const aiConfig = await resolveAIConfig(serverConfig, request.workspaceId);
  if (!aiConfig) {
    throw new Error('No AI provider configured. Set up an AI provider in admin settings.');
  }
  return executeAICompletionWithConfig(serverConfig, aiConfig, request);
}

/**
 * Same as executeAICompletion but for callers that already resolved the
 * provider config (engine generation stage) — avoids a duplicate DB lookup
 * on every visitor turn.
 */
export async function executeAICompletionWithConfig(
  serverConfig: ServerConfig,
  aiConfig: AIConfig,
  request: AIRequest,
): Promise<AIResponse> {
  const sb = getServiceClient(serverConfig);
  let response: AIResponse;

  try {
    // The ONLY outbound AI path in Core: an authenticated, private call to the
    // AI Runtime. Never a provider socket.
    response = await runtimeComplete(serverConfig, aiConfig, request);

    // Log success
    await sb.from('ai_usage_logs').insert({
      workspace_id: request.workspaceId,
      provider_name: aiConfig.provider,
      model: response.model,
      prompt_tokens: response.promptTokens,
      completion_tokens: response.completionTokens,
      total_tokens: response.totalTokens,
      latency_ms: response.latencyMs,
      success: true,
      endpoint: 'complete',
    });
  } catch (err: any) {
    // Log failure. Runtime-boundary failures are recorded as such so an
    // operator can tell "AI runtime down" from "provider rejected the key".
    await sb.from('ai_usage_logs').insert({
      workspace_id: request.workspaceId,
      provider_name: aiConfig.provider,
      model: request.model || aiConfig.model,
      success: false,
      error_message: redactSecrets(
        err instanceof AiRuntimeError ? `[${err.code}] ${err.message}` : err?.message,
      ),
      endpoint: 'complete',
    });
    throw err;
  }

  return response;
}
