/**
 * AI Provider implementations — OpenAI, Anthropic, Gemini
 * All calls run server-side only. API keys never leave the backend.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

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

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(`OpenAI error: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const latencyMs = Date.now() - start;

  return {
    text: data.choices?.[0]?.message?.content || '',
    model,
    provider: 'openai',
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
    latencyMs,
  };
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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(`Anthropic error: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const latencyMs = Date.now() - start;

  return {
    text: data.content?.[0]?.text || '',
    model,
    provider: 'anthropic',
    promptTokens: data.usage?.input_tokens || 0,
    completionTokens: data.usage?.output_tokens || 0,
    totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
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
    },
  };
  if (req.systemPrompt) {
    body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(`Gemini error: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const latencyMs = Date.now() - start;

  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    model,
    provider: 'gemini',
    promptTokens: data.usageMetadata?.promptTokenCount || 0,
    completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
    totalTokens: data.usageMetadata?.totalTokenCount || 0,
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

  // 2. Global default from runtime config
  const { data: globalConfig } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'default_ai_provider')
    .single();

  if (globalConfig?.value) {
    const c = globalConfig.value as any;
    return {
      provider: c.provider || 'openai',
      apiKey: c.api_key,
      model: c.model || 'gpt-4o-mini',
      maxTokens: c.max_tokens ? parseInt(c.max_tokens) : undefined,
      temperature: c.temperature ? parseFloat(c.temperature) : undefined,
      baseUrl: c.base_url || providerBaseUrls[c.provider],
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
