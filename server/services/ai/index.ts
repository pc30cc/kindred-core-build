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
import { getServiceClient, type ServiceClient } from '../../supabase.js';
import { redactSecrets } from '../../lib/redactSecrets.js';
import { runtimeComplete, AiRuntimeError } from './runtimeClient.js';
import { withAiIdempotency, newAiRequestId } from './idempotency.js';
import {
  beginAiRunGuarded,
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
  // .maybeSingle(), not .single(): "this workspace has no override" is the
  // NORMAL case (provider_configs is empty on a fresh install), and .single()
  // answers 0 rows with PostgREST 406 — one rejected transaction per call.
  // The error was also dropped, so a genuine read failure was indistinguishable
  // from "no override" and fell through to the global default unnoticed.
  const { data: wsConfig, error: wsConfigError } = await sb
    .from('provider_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('provider_type', 'ai')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (wsConfigError) {
    // Fall through to the global default (intended behaviour) but say so.
    console.error('[ai] provider_configs lookup failed:', wsConfigError.message);
  }

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
 * The single choke point for `ai_usage_logs` — the LEGACY analytics
 * projection (see ../ai-billing/normalize.ts). Both writers below (the
 * runtime-failure row and the success row) go through here so
 * PRODUCT_ANALYTICS_LOGGING has one place to stop.
 *
 * This is NOT the billing record. The authoritative, immutable financial
 * events (`ai_usage_events`) are written inside Postgres from the same
 * normalized usage object and are untouched by any env flag, so AI billing
 * keeps working exactly as today with this logging off — only the admin
 * provider/model breakdown chart and the per-workspace usage panel lose
 * their data source.
 */
async function recordAiUsageLog(
  serverConfig: ServerConfig,
  sb: ServiceClient,
  row: Record<string, unknown>,
): Promise<void> {
  if (serverConfig.productAnalyticsLoggingEnabled === false) return;
  await sb.from('ai_usage_logs').insert(row as any);
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
      ctx = await beginAiRunGuarded(serverConfig, {
        workspaceId: request.workspaceId,
        operationKey:
          request.billing?.operationKey ||
          `standalone:${request.billing?.entryPoint || 'ai_complete'}:${request.requestId || newAiRequestId()}`,
        payload: {
          workspaceId: request.workspaceId,
          prompt: request.prompt,
          systemPrompt: request.systemPrompt,
          model: request.model || aiConfig.model,
        },
        entryPoint: request.billing?.entryPoint || 'ai_complete',
        channel: request.billing?.channel ?? null,
        conversationId: request.billing?.conversationId ?? null,
        estimate: {
          promptChars: (request.prompt || '').length + (request.systemPrompt || '').length,
          maxTokens: request.maxTokens ?? aiConfig.maxTokens ?? null,
          provider: aiConfig.provider,
          model: request.model || aiConfig.model,
        },
      });
      ownsRun = !!ctx;
    } catch (err) {
      // beginAiRunGuarded already decided by mode: in METER_ONLY a billing
      // outage returns null (AI keeps serving, loss is audited); anything that
      // throws here is a real denial and must fail closed BEFORE the provider
      // call.
      throw err;
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
    await recordAiUsageLog(serverConfig, sb, {
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

  await recordAiUsageLog(serverConfig, sb, {
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


