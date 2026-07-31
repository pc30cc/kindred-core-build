/**
 * AI Provider implementations — OpenAI, Anthropic, Gemini
 * All calls run server-side only. API keys never leave the backend.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const AI_HTTP_TIMEOUT_MS = parseInt(process.env.AI_HTTP_TIMEOUT_MS || '45000', 10);
const AI_RETRY_ATTEMPTS = parseInt(process.env.AI_RETRY_ATTEMPTS || '3', 10);

export interface AIConfig {
  provider: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string;
  orgId?: string;
}

export interface AIRequest {
  workspaceId: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Force JSON object response (OpenAI/compatible: response_format json_object). */
  jsonMode?: boolean;
  /** Optional OpenAI-compatible function tools for structured output. */
  tools?: any[];
  toolChoice?: any;
}

export interface AIResponse {
  text: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
}

// ─── Provider response contracts ─────────────────────────────────
// Each provider gets its own narrow contract covering ONLY the fields this
// file actually consumes. Parsing stays tolerant in exactly the places the
// previous optional-chaining code was tolerant, so runtime behaviour is
// unchanged for both well-formed and malformed payloads.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Error envelope shared in shape (not in type) by all three providers:
 * `{ error: { message: string } }`. Only `error.message` is consumed.
 */
export function readProviderErrorMessage(value: unknown): string | undefined {
  return asString(asRecord(asRecord(value)?.error)?.message);
}

interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** OpenAI (and OpenAI-compatible) `POST /chat/completions` success body. */
export interface OpenAIChatCompletion {
  text: string;
  usage: ProviderUsage;
}

export function parseOpenAIChatCompletion(value: unknown): OpenAIChatCompletion {
  const data = asRecord(value);
  const message = asRecord(asRecord(asArray(data?.choices)?.[0])?.message);
  const toolCall = asRecord(asArray(message?.tool_calls)?.[0]);
  const toolArgs = asString(asRecord(toolCall?.function)?.arguments);
  const usage = asRecord(data?.usage);

  return {
    // Tool arguments win over content, exactly as before; `content` is null on
    // tool calls and absent on malformed bodies.
    text: toolArgs || asString(message?.content) || '',
    usage: {
      promptTokens: asNumber(usage?.prompt_tokens) || 0,
      completionTokens: asNumber(usage?.completion_tokens) || 0,
      totalTokens: asNumber(usage?.total_tokens) || 0,
    },
  };
}

/** Anthropic `POST /v1/messages` success body. */
export interface AnthropicMessage {
  text: string;
  usage: ProviderUsage;
}

export function parseAnthropicMessage(value: unknown): AnthropicMessage {
  const data = asRecord(value);
  // Preserve existing behaviour: only the FIRST content block is read, and only
  // its `text` field — a leading `tool_use` block yields no text here.
  const firstBlock = asRecord(asArray(data?.content)?.[0]);
  const usage = asRecord(data?.usage);
  const inputTokens = asNumber(usage?.input_tokens) || 0;
  const outputTokens = asNumber(usage?.output_tokens) || 0;

  return {
    text: asString(firstBlock?.text) || '',
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

/** Gemini `:generateContent` success body. */
export interface GeminiGenerateContent {
  text: string;
  usage: ProviderUsage;
}

export function parseGeminiGenerateContent(value: unknown): GeminiGenerateContent {
  const data = asRecord(value);
  const parts = asArray(asRecord(asRecord(asArray(data?.candidates)?.[0])?.content)?.parts);
  const firstPart = asRecord(parts?.[0]);
  const meta = asRecord(data?.usageMetadata);

  return {
    text: asString(firstPart?.text) || '',
    usage: {
      promptTokens: asNumber(meta?.promptTokenCount) || 0,
      completionTokens: asNumber(meta?.candidatesTokenCount) || 0,
      totalTokens: asNumber(meta?.totalTokenCount) || 0,
    },
  };
}

// ─── OpenAI ──────────────────────────────────────────────────────

async function callOpenAI(config: AIConfig, req: AIRequest): Promise<AIResponse> {
  const start = Date.now();
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  const model = req.model || config.model || 'gpt-4o-mini';

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (config.orgId) headers['OpenAI-Organization'] = config.orgId;

  const body: any = {
    model,
    messages: [
      ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
      { role: 'user', content: req.prompt },
    ],
    max_tokens: req.maxTokens || config.maxTokens || 4096,
    temperature: req.temperature ?? config.temperature ?? 0.7,
  };
  if (req.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice || 'auto';
  }

  // Network resilience: retry transient fetch failures (DNS flake, TLS reset,
  // ECONNRESET) up to 2 extra times with exponential backoff. Real API errors
  // (4xx/5xx) are returned immediately and surfaced to the caller.
  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, AI_RETRY_ATTEMPTS, AI_HTTP_TIMEOUT_MS);

  if (!res.ok) {
    const err: unknown = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(`OpenAI error: ${readProviderErrorMessage(err) || res.statusText}`);
  }

  const data: unknown = await res.json();
  const latencyMs = Date.now() - start;
  const parsed = parseOpenAIChatCompletion(data);

  return {
    text: parsed.text,
    model,
    provider: 'openai',
    promptTokens: parsed.usage.promptTokens,
    completionTokens: parsed.usage.completionTokens,
    totalTokens: parsed.usage.totalTokens,
    latencyMs,
  };
}

// ─── Network retry helper ────────────────────────────────────────
// Retries only on TypeError / fetch failed / common transient codes.
// Never retries on HTTP error responses — those are returned to the caller.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts = 3,
  timeoutMs = AI_HTTP_TIMEOUT_MS,
): Promise<Response> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (err: any) {
      lastErr = err;
      const detail = String(
        err?.message || err?.cause?.message || err?.code || err?.cause?.code || '',
      );
      const transient =
        err?.name === 'AbortError' ||
        err?.name === 'TypeError' ||
        /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|socket hang up/i.test(detail);
      if (!transient || attempt === maxAttempts) {
        throw new Error(`AI network error after ${attempt} attempt(s): ${detail || err?.name || 'unknown'}`);
      }
      const delay = 750 * Math.pow(2, attempt - 1); // 750ms, 1.5s
      console.warn(`[ai] transient fetch failure, retrying in ${delay}ms`, {
        attempt,
        error: err?.message,
        code: err?.code || err?.cause?.code,
      });
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ─── Anthropic ───────────────────────────────────────────────────

async function callAnthropic(config: AIConfig, req: AIRequest): Promise<AIResponse> {
  const start = Date.now();
  const model = req.model || config.model || 'claude-sonnet-4-20250514';

  const body: any = {
    model,
    max_tokens: req.maxTokens || config.maxTokens || 4096,
    messages: [{ role: 'user', content: req.prompt }],
  };
  if (req.systemPrompt) body.system = req.systemPrompt;

  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, AI_RETRY_ATTEMPTS, AI_HTTP_TIMEOUT_MS);

  if (!res.ok) {
    const err: unknown = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(`Anthropic error: ${readProviderErrorMessage(err) || res.statusText}`);
  }

  const data: unknown = await res.json();
  const latencyMs = Date.now() - start;
  const parsed = parseAnthropicMessage(data);

  return {
    text: parsed.text,
    model,
    provider: 'anthropic',
    promptTokens: parsed.usage.promptTokens,
    completionTokens: parsed.usage.completionTokens,
    totalTokens: parsed.usage.totalTokens,
    latencyMs,
  };
}

// ─── Google Gemini ───────────────────────────────────────────────

async function callGemini(config: AIConfig, req: AIRequest): Promise<AIResponse> {
  const start = Date.now();
  const model = req.model || config.model || 'gemini-2.5-flash';

  const body: any = {
    contents: [{ parts: [{ text: req.prompt }] }],
    generationConfig: {
      maxOutputTokens: req.maxTokens || config.maxTokens || 4096,
      temperature: req.temperature ?? config.temperature ?? 0.7,
      ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (req.systemPrompt) {
    body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
  }

  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    AI_RETRY_ATTEMPTS,
    AI_HTTP_TIMEOUT_MS,
  );

  if (!res.ok) {
    const err: unknown = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(`Gemini error: ${readProviderErrorMessage(err) || res.statusText}`);
  }

  const data: unknown = await res.json();
  const latencyMs = Date.now() - start;
  const parsed = parseGeminiGenerateContent(data);

  return {
    text: parsed.text,
    model,
    provider: 'gemini',
    promptTokens: parsed.usage.promptTokens,
    completionTokens: parsed.usage.completionTokens,
    totalTokens: parsed.usage.totalTokens,
    latencyMs,
  };
}

// ─── Provider Router ─────────────────────────────────────────────

const providerHandlers: Record<string, (config: AIConfig, req: AIRequest) => Promise<AIResponse>> = {
  openai: callOpenAI,
  azure_openai: callOpenAI, // Same API, different baseUrl
  anthropic: callAnthropic,
  gemini: callGemini,
  // OpenAI-compatible providers (Groq, Together, Mistral, DeepSeek, Perplexity, Ollama, OpenRouter)
  groq: callOpenAI,
  together: callOpenAI,
  mistral: callOpenAI,
  deepseek: callOpenAI,
  perplexity: callOpenAI,
  ollama: callOpenAI,
  openrouter: callOpenAI,
  cohere: callOpenAI,
};

// Default base URLs for OpenAI-compatible providers
const providerBaseUrls: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  perplexity: 'https://api.perplexity.ai',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * Resolve AI provider config from DB for a workspace.
 * Resolution: workspace provider_configs → global app_runtime_config → null
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
      baseUrl: c.base_url || c.endpoint || providerBaseUrls[wsConfig.provider_name],
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
      baseUrl: c.base_url || c.endpoint || providerBaseUrls[provider],
      orgId: c.org_id,
    };
  }

  return null;
}

/**
 * Execute an AI completion through the resolved provider.
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

  const handler = providerHandlers[aiConfig.provider];
  if (!handler) {
    throw new Error(`Unsupported AI provider: ${aiConfig.provider}`);
  }

  const sb = getServiceClient(serverConfig);
  let response: AIResponse;

  try {
    response = await handler(aiConfig, request);

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
    // Log failure
    await sb.from('ai_usage_logs').insert({
      workspace_id: request.workspaceId,
      provider_name: aiConfig.provider,
      model: request.model || aiConfig.model,
      success: false,
      error_message: err.message,
      endpoint: 'complete',
    });
    throw err;
  }

  return response;
}

/**
 * Test AI provider connection with a minimal completion.
 */
export async function testAIConnection(config: AIConfig): Promise<{
  success: boolean;
  latencyMs: number;
  model: string;
  error?: string;
}> {
  const handler = providerHandlers[config.provider];
  if (!handler) {
    return { success: false, latencyMs: 0, model: config.model, error: `Unknown provider: ${config.provider}` };
  }

  // Apply default base URL
  if (!config.baseUrl && providerBaseUrls[config.provider]) {
    config.baseUrl = providerBaseUrls[config.provider];
  }

  try {
    const result = await handler(config, {
      workspaceId: 'test',
      prompt: 'Say "ok" and nothing else.',
      maxTokens: 5,
      temperature: 0,
    });
    return { success: true, latencyMs: result.latencyMs, model: result.model };
  } catch (err: any) {
    return { success: false, latencyMs: 0, model: config.model, error: err.message };
  }
}
