/**
 * AI PROVIDER EXECUTION — the ONLY code in this repository that opens a socket
 * to an AI provider (OpenAI, Anthropic, Gemini and OpenAI-compatible vendors).
 *
 * It is deliberately located outside `server/**` so Core cannot import it:
 * Core runs on a restricted network and must never make a provider request.
 * Only the AI Runtime deployable (`ai-runtime/server.ts`) loads this module.
 *
 * Moved verbatim (behaviour-preserving) out of server/services/ai/index.ts
 * during the Provider Network Isolation refactor.
 */

import { redactSecrets } from '../../../shared/security/redactSecrets.js';
import {
  readBoundedEnvInt,
  isRetryableStatus,
  parseRetryAfterMs,
} from '../../../shared/ai/policy.js';
import {
  parseOpenAIChatCompletion,
  parseAnthropicMessage,
  parseGeminiGenerateContent,
  readProviderErrorMessage,
} from '../../../shared/ai/parse.js';
import type {
  AIConfig,
  AIRequest,
  AIResponse,
  AIConnectionTestResult,
  HttpFetch,
  JsonResponse,
} from '../../../shared/ai/types.js';
import { assertProviderConfig, PROVIDER_BASE_URLS } from './catalog.js';

/**
 * Bounded timeout/retry policy for realtime chat.
 *   per attempt : 12s  (1s … 60s)
 *   attempts    : 2    (1 … 5)
 *   total budget: 28s  (1s … 120s) — hard wall clock across ALL attempts
 */
const AI_HTTP_TIMEOUT_MS = readBoundedEnvInt('AI_HTTP_TIMEOUT_MS', 12000, 1000, 60000);
const AI_RETRY_ATTEMPTS = readBoundedEnvInt('AI_RETRY_ATTEMPTS', 2, 1, 5);
const AI_TOTAL_BUDGET_MS = readBoundedEnvInt('AI_TOTAL_BUDGET_MS', 28000, 1000, 120000);

export type { JsonResponse };

/**
 * Reads the JSON body while the request deadline is still armed. An abort
 * (total-budget/per-attempt timeout) must surface as a failure — never as a
 * silently "successful" empty payload.
 */
async function readJsonUnderDeadline(res: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await res.json();
  } catch (err: any) {
    if (res.ok || signal.aborted || err?.name === 'AbortError') throw err;
    return { error: { message: res.statusText } };
  }
}

/**
 * Single shared wall-clock deadline (AI_TOTAL_BUDGET_MS) covering connect,
 * TLS, upload, response headers, retry backoff, response BODY download and
 * JSON parsing.
 */
export async function requestJsonWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts = 3,
  timeoutMs = AI_HTTP_TIMEOUT_MS,
  fetchImpl?: HttpFetch,
): Promise<JsonResponse> {
  const doFetch: HttpFetch = fetchImpl ?? ((input, requestInit) => fetch(input, requestInit));
  let lastErr: any;
  const deadline = Date.now() + AI_TOTAL_BUDGET_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`AI request exceeded the ${AI_TOTAL_BUDGET_MS}ms total budget`);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, remaining));
    try {
      const res = await doFetch(url, { ...init, signal: ctrl.signal });
      if (res.ok || !isRetryableStatus(res.status) || attempt === maxAttempts) {
        const data: unknown = await readJsonUnderDeadline(res, ctrl.signal);
        return { ok: res.ok, status: res.status, statusText: res.statusText, data };
      }
      const retryAfter = res.status === 429 ? parseRetryAfterMs(res.headers.get('retry-after')) : null;
      const backoff = retryAfter ?? 750 * Math.pow(2, attempt - 1);
      if (deadline - Date.now() - backoff <= 0) {
        const data: unknown = await readJsonUnderDeadline(res, ctrl.signal);
        return { ok: res.ok, status: res.status, statusText: res.statusText, data };
      }
      try { await res.body?.cancel(); } catch { /* ignore */ }
      console.warn('[ai-runtime] retryable provider status, retrying', { attempt, status: res.status, backoff });
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    } catch (err: any) {
      lastErr = err;
      const detail = String(
        err?.message || err?.cause?.message || err?.code || err?.cause?.code || '',
      );
      const transient =
        err?.name === 'AbortError' ||
        err?.name === 'TypeError' ||
        /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|socket hang up/i.test(detail);
      const delay = 750 * Math.pow(2, attempt - 1); // 750ms, 1.5s
      const budgetLeft = deadline - Date.now() - delay;
      if (!transient || attempt === maxAttempts || budgetLeft <= 0) {
        throw new Error(
          `AI network error after ${attempt} attempt(s): ${redactSecrets(detail) || err?.name || 'unknown'}`,
        );
      }
      console.warn(`[ai-runtime] transient fetch failure, retrying in ${delay}ms`, {
        attempt,
        error: redactSecrets(err?.message),
        code: err?.code || err?.cause?.code,
      });
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** Normalized prior conversation turns (oldest first). */
function priorMessages(req: AIRequest): { role: 'user' | 'assistant'; content: string }[] {
  return (req.messages || [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim().length > 0)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: m.content }));
}

// ─── OpenAI (and OpenAI-compatible) ──────────────────────────────

async function callOpenAI(config: AIConfig, req: AIRequest, fetchImpl?: HttpFetch): Promise<AIResponse> {
  const start = Date.now();
  const baseUrl = config.baseUrl || PROVIDER_BASE_URLS.openai;
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
      ...priorMessages(req),
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

  const res = await requestJsonWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, AI_RETRY_ATTEMPTS, AI_HTTP_TIMEOUT_MS, fetchImpl);

  if (!res.ok) {
    throw new Error(`OpenAI error: ${readProviderErrorMessage(res.data) || res.statusText}`);
  }

  const latencyMs = Date.now() - start;
  const parsed = parseOpenAIChatCompletion(res.data);

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

// ─── Anthropic ───────────────────────────────────────────────────

async function callAnthropic(config: AIConfig, req: AIRequest, fetchImpl?: HttpFetch): Promise<AIResponse> {
  const start = Date.now();
  const model = req.model || config.model || 'claude-sonnet-4-20250514';

  const body: any = {
    model,
    max_tokens: req.maxTokens || config.maxTokens || 4096,
    messages: [...priorMessages(req), { role: 'user', content: req.prompt }],
  };
  if (req.systemPrompt) body.system = req.systemPrompt;

  const res = await requestJsonWithRetry(`${config.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, AI_RETRY_ATTEMPTS, AI_HTTP_TIMEOUT_MS, fetchImpl);

  if (!res.ok) {
    throw new Error(`Anthropic error: ${readProviderErrorMessage(res.data) || res.statusText}`);
  }

  const latencyMs = Date.now() - start;
  const parsed = parseAnthropicMessage(res.data);

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

async function callGemini(config: AIConfig, req: AIRequest, fetchImpl?: HttpFetch): Promise<AIResponse> {
  const start = Date.now();
  const model = req.model || config.model || 'gemini-2.5-flash';

  const body: any = {
    contents: [
      ...priorMessages(req).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      { role: 'user', parts: [{ text: req.prompt }] },
    ],
    generationConfig: {
      maxOutputTokens: req.maxTokens || config.maxTokens || 4096,
      temperature: req.temperature ?? config.temperature ?? 0.7,
      ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (req.systemPrompt) {
    body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
  }

  const base = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const res = await requestJsonWithRetry(
    `${base}/models/${model}:generateContent?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    AI_RETRY_ATTEMPTS,
    AI_HTTP_TIMEOUT_MS,
    fetchImpl,
  );

  if (!res.ok) {
    throw new Error(`Gemini error: ${readProviderErrorMessage(res.data) || res.statusText}`);
  }

  const latencyMs = Date.now() - start;
  const parsed = parseGeminiGenerateContent(res.data);

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

// ─── Provider router ─────────────────────────────────────────────

const providerHandlers: Record<
  string,
  (config: AIConfig, req: AIRequest, fetchImpl?: HttpFetch) => Promise<AIResponse>
> = {
  openai: callOpenAI,
  azure_openai: callOpenAI, // Same API, different baseUrl
  anthropic: callAnthropic,
  gemini: callGemini,
  // OpenAI-compatible providers
  groq: callOpenAI,
  together: callOpenAI,
  mistral: callOpenAI,
  deepseek: callOpenAI,
  perplexity: callOpenAI,
  ollama: callOpenAI,
  openrouter: callOpenAI,
  cohere: callOpenAI,
};

export function isSupportedProvider(provider: string): boolean {
  return Boolean(providerHandlers[provider]);
}

/**
 * Executes one completion against the given provider config. Usage logging and
 * credit accounting stay in Core — this function does networking only.
 */
export async function executeProviderCompletion(
  aiConfig: AIConfig,
  request: AIRequest,
  fetchImpl?: HttpFetch,
): Promise<AIResponse> {
  const handler = providerHandlers[aiConfig.provider];
  if (!handler) {
    throw new Error(`Unsupported AI provider: ${aiConfig.provider}`);
  }
  assertProviderConfig(aiConfig);
  return handler(aiConfig, request, fetchImpl);
}

/** Test a provider connection with a minimal completion. */
export async function testAIConnection(
  config: AIConfig,
  options: { fetchImpl?: HttpFetch } = {},
): Promise<AIConnectionTestResult> {
  const handler = providerHandlers[config.provider];
  if (!handler) {
    return { success: false, latencyMs: 0, model: config.model, error: `Unknown provider: ${config.provider}` };
  }

  if (!config.baseUrl && PROVIDER_BASE_URLS[config.provider]) {
    config.baseUrl = PROVIDER_BASE_URLS[config.provider];
  }

  try {
    assertProviderConfig(config);
    const result = await handler(
      config,
      {
        workspaceId: 'test',
        prompt: 'Say "ok" and nothing else.',
        maxTokens: 5,
        temperature: 0,
      },
      options.fetchImpl,
    );
    return { success: true, latencyMs: result.latencyMs, model: result.model };
  } catch (err: any) {
    return { success: false, latencyMs: 0, model: config.model, error: redactSecrets(err?.message) || 'unknown_error' };
  }
}
