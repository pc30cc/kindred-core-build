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
import { withAiIdempotency, newAiRequestId } from './idempotency.js';
import {
  beginAiRun,
  recordStepUsage,
  settleAiRun,
  failAiRun,
  type AiRunContext,
} from '../ai-billing/runContext.js';
import { normalizeUsage } from '../ai-billing/normalize.js';
import { AiBillingError } from '../ai-billing/errors.js';

export { withAiIdempotency, newAiRequestId, resetAiIdempotency } from './idempotency.js';


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
 *
 * Billing: when the caller already opened a Run at its business-operation
 * boundary it passes the context in; otherwise a standalone Run is opened here
 * (direct /api/ai/complete, playground, KB worker) so no billable provider
 * execution ever happens outside a Run.
 */
export async function executeAICompletion(
  serverConfig: ServerConfig,
  request: AIRequest,
  runCtx?: AiRunContext,
): Promise<AIResponse> {
  const aiConfig = await resolveAIConfig(serverConfig, request.workspaceId);
  if (!aiConfig) {
    throw new Error('No AI provider configured. Set up an AI provider in admin settings.');
  }
  return executeAICompletionWithConfig(serverConfig, aiConfig, request, runCtx);
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
  runCtx?: AiRunContext,
): Promise<AIResponse> {
  // ONE logical request → ONE runtime execution → ONE usage row. A replay of
  // the same requestId returns the first execution's outcome (success OR
  // failure) instead of calling the runtime and logging usage twice.
  return withAiIdempotency(request.requestId, () =>
    runOneCompletion(serverConfig, aiConfig, request, runCtx),
  );
}

async function runOneCompletion(
  serverConfig: ServerConfig,
  aiConfig: AIConfig,
  request: AIRequest,
  providedCtx?: AiRunContext,
): Promise<AIResponse> {
  const sb = getServiceClient(serverConfig);
  let response: AIResponse;

  // Attach to the caller's Run, or open a standalone one for this operation.
  let ctx: AiRunContext | null = providedCtx ?? null;
  let ownsRun = false;
  if (!ctx) {
    try {
      ctx = await beginAiRun(serverConfig, {
        workspaceId: request.workspaceId,
        operationKey: `standalone:${request.requestId || newAiRequestId()}`,
        payload: {
          workspaceId: request.workspaceId,
          prompt: request.prompt,
          systemPrompt: request.systemPrompt,
          model: request.model || aiConfig.model,
        },
        entryPoint: 'ai_complete',
        estimate: {
          promptChars: (request.prompt || '').length + (request.systemPrompt || '').length,
          maxTokens: request.maxTokens ?? aiConfig.maxTokens ?? null,
          provider: aiConfig.provider,
          model: request.model || aiConfig.model,
        },
      });
      ownsRun = true;
    } catch (err) {
      // ENFORCED denials (no balance / no pricing) must reach the caller.
      if (err instanceof AiBillingError) throw err;
      ctx = null;
    }
  }

  try {
    // The ONLY outbound AI path in Core: an authenticated, private call to the
    // AI Runtime. Never a provider socket.
    response = await runtimeComplete(serverConfig, aiConfig, request);
  } catch (err: any) {
    const message = redactSecrets(
      err instanceof AiRuntimeError ? `[${err.code}] ${err.message}` : err?.message,
    );
    // Log failure. Runtime-boundary failures are recorded as such so an
    // operator can tell "AI runtime down" from "provider rejected the key".
    await sb.from('ai_usage_logs').insert({
      workspace_id: request.workspaceId,
      provider_name: aiConfig.provider,
      model: request.model || aiConfig.model,
      success: false,
      error_message: message,
      endpoint: 'complete',
    });
    if (ctx && ownsRun) await failAiRun(serverConfig, ctx, message || 'runtime_error').catch(() => undefined);
    throw err;
  }

  // ONE normalized usage object feeds BOTH the immutable financial events and
  // the legacy analytics projection. There is no second parser.
  const usage = normalizeUsage({
    provider: aiConfig.provider,
    requestedModel: request.model || aiConfig.model,
    actualModel: response.model,
    promptTokens: response.promptTokens,
    completionTokens: response.completionTokens,
    totalTokens: response.totalTokens,
    latencyMs: response.latencyMs,
    kind: 'completion',
    raw: { finishReason: response.finishReason },
  });

  await sb.from('ai_usage_logs').insert({
    workspace_id: request.workspaceId,
    provider_name: usage.provider,
    model: usage.actualModel,
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    latency_ms: usage.latencyMs,
    success: true,
    endpoint: 'complete',
  });

  if (ctx) {
    try {
      await recordStepUsage(serverConfig, ctx, { stepKind: 'COMPLETION', usage });
      if (ownsRun) await settleAiRun(serverConfig, ctx);
    } catch (err) {
      if (err instanceof AiBillingError && err.code === 'ai_allowance_exhausted') throw err;
      console.error('[ai-billing] usage recording failed', (err as any)?.message);
    }
  }

  return response;
}


