/**
 * CORE → AI RUNTIME CLIENT.
 *
 * The ONLY outbound AI path in Core. Core (restricted network) never opens a
 * socket to an AI provider; it hands the resolved provider config plus the
 * request to the AI Runtime (`ai-runtime/server.ts`), which lives on an
 * unrestricted network, and receives a normalized result back.
 *
 * Failure handling is explicit: every failure carries a stable code from
 * shared/ai/internalRoutes.ts so routes/UI can distinguish "AI runtime is not
 * deployed/reachable" from "the provider rejected the request".
 */
import type { ServerConfig } from '../../config.js';
import {
  AI_RUNTIME_ROUTES,
  AI_RUNTIME_CONTRACT_VERSION,
  AI_RUNTIME_SECRET_HEADER,
  AI_RUNTIME_CONTRACT_HEADER,
  type AiRuntimeErrorCode,
} from '../../../shared/ai/internalRoutes.js';
import type { AIConfig, AIRequest, AIResponse, AIConnectionTestResult } from '../../../shared/ai/types.js';
import { redactSecrets } from '../../lib/redactSecrets.js';
import { readBoundedEnvInt } from '../../../shared/ai/policy.js';

/** Wall clock for the Core→Runtime hop. Must exceed the runtime's own budget. */
const RUNTIME_TIMEOUT_MS = readBoundedEnvInt('AI_RUNTIME_TIMEOUT_MS', 45000, 1000, 180000);

export class AiRuntimeError extends Error {
  readonly code: AiRuntimeErrorCode;
  constructor(code: AiRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'AiRuntimeError';
    this.code = code;
  }
}

function runtimeTarget(config: ServerConfig): { baseUrl: string; secret: string } {
  const baseUrl = config.aiRuntimeBaseUrl;
  const secret = config.aiRuntimeInternalSecret;
  if (!baseUrl || !secret) {
    throw new AiRuntimeError(
      'runtime_not_configured',
      'AI runtime is not configured. Set AI_RUNTIME_URL and AI_RUNTIME_INTERNAL_SECRET on the Core server.',
    );
  }
  return { baseUrl, secret };
}

/** True when Core has an AI runtime configured at all. */
export function isAiRuntimeConfigured(config: ServerConfig): boolean {
  return Boolean(config.aiRuntimeBaseUrl && config.aiRuntimeInternalSecret);
}

async function callRuntime<T>(
  config: ServerConfig,
  route: string,
  body: unknown,
): Promise<T> {
  const { baseUrl, secret } = runtimeTarget(config);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUNTIME_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The same value twice: proxies in front of the runtime often consume
        // or rewrite `Authorization`, which makes a correct secret look wrong.
        Authorization: `Bearer ${secret}`,
        [AI_RUNTIME_SECRET_HEADER]: secret,
        [AI_RUNTIME_CONTRACT_HEADER]: AI_RUNTIME_CONTRACT_VERSION,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err: any) {
    throw new AiRuntimeError(
      'runtime_unreachable',
      `AI runtime unreachable: ${redactSecrets(err?.message || String(err))}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok || payload?.ok !== true) {
    const code: AiRuntimeErrorCode = payload?.error || (res.status === 401 ? 'runtime_unauthorized' : 'internal_error');
    const message = payload?.message || `AI runtime responded ${res.status}`;
    throw new AiRuntimeError(code, redactSecrets(message));
  }
  return payload as T;
}

/** Execute a completion on the remote runtime. */
export async function runtimeComplete(
  config: ServerConfig,
  aiConfig: AIConfig,
  request: AIRequest,
): Promise<AIResponse> {
  const payload = await callRuntime<{ response: AIResponse }>(config, AI_RUNTIME_ROUTES.complete, {
    config: aiConfig,
    request,
  });
  return payload.response;
}

/** Operator-triggered provider connection test on the remote runtime. */
export async function runtimeTestConnection(
  config: ServerConfig,
  aiConfig: AIConfig,
): Promise<AIConnectionTestResult> {
  const payload = await callRuntime<{ result: AIConnectionTestResult }>(config, AI_RUNTIME_ROUTES.test, {
    config: aiConfig,
  });
  return payload.result;
}

/** Embedding generation on the remote runtime. */
export async function runtimeEmbed(
  config: ServerConfig,
  embedConfig: { provider: string; apiKey: string; model: string; baseUrl?: string; orgId?: string },
  texts: string[],
): Promise<number[][]> {
  const payload = await callRuntime<{ vectors: number[][] }>(config, AI_RUNTIME_ROUTES.embed, {
    config: embedConfig,
    texts,
  });
  return payload.vectors;
}
