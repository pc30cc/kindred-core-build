/**
 * AI provider contract types.
 *
 * PURE TYPES ONLY — importing this file never pulls provider networking into
 * a process. Core, the AI Runtime and the workers all speak these shapes.
 */

/** Minimal fetch contract (the runtime injects an SSRF-safe transport for tests). */
export type HttpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

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
  /**
   * Prior conversation turns, oldest first, WITHOUT the current message
   * (which stays in `prompt`).
   */
  messages?: { role: 'user' | 'assistant'; content: string }[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * AI billing — business identity of a STANDALONE call (no caller Run).
   * Lets a direct flow (assistant description, playground, test harness,
   * /api/ai/complete) open a meaningful, idempotent Run of its own instead of
   * an anonymous one.
   */
  billing?: {
    entryPoint: string;
    operationKey?: string;
    conversationId?: string | null;
    channel?: string | null;
  };
  /** Force JSON object response (OpenAI/compatible: response_format json_object). */
  jsonMode?: boolean;
  /** Optional OpenAI-compatible function tools for structured output. */
  tools?: any[];
  toolChoice?: any;
  /**
   * Stable id for ONE logical AI execution. Core mints it; transport-level
   * retries/replays of the same logical request reuse it so usage accounting
   * and credit consumption stay single-shot. Provider-internal retries inside
   * the runtime are part of the same logical execution and never change it.
   */
  requestId?: string;
}

/** A model-emitted tool call, normalized across providers. */
export interface AIToolCall {
  id?: string;
  name: string;
  /** Raw JSON argument string exactly as the model emitted it. */
  arguments: string;
}

/**
 * Why generation stopped, normalized: 'stop' | 'length' | 'tool_calls' |
 * 'content_filter' | 'other'. Providers' native values are mapped, unknown
 * values collapse to 'other'.
 */
export type AIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other';

export interface AIResponse {
  text: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  /**
   * Model-emitted tool calls, normalized. The AI Runtime NEVER executes an
   * application/business tool — it only reports what the model asked for.
   * Authorization and execution stay in Core.
   */
  toolCalls?: AIToolCall[];
  finishReason?: AIFinishReason;
  /** Echo of AIRequest.requestId, for correlating one logical execution. */
  requestId?: string;
}


export interface JsonResponse {
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
}

export interface AIConnectionTestResult {
  success: boolean;
  latencyMs: number;
  model: string;
  error?: string;
}
