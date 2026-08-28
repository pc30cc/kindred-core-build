/**
 * Provider response parsers — pure functions, no I/O.
 *
 * Each provider gets a narrow contract covering ONLY the fields consumed by
 * this codebase. Parsing stays tolerant of malformed payloads.
 */

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
    // Tool arguments win over content; `content` is null on tool calls and
    // absent on malformed bodies.
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
  // Only the FIRST content block is read, and only its `text` field.
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
