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
