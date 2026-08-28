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

/** Normalized tool call (mirrors AIToolCall in shared/ai/types.ts). */
export interface ParsedToolCall {
  id?: string;
  name: string;
  arguments: string;
}

export type ParsedFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other';

/** Maps a provider's native stop reason onto the normalized set. */
export function normalizeFinishReason(raw: unknown, hasToolCalls = false): ParsedFinishReason | undefined {
  const value = typeof raw === 'string' ? raw.toLowerCase() : undefined;
  if (!value) return hasToolCalls ? 'tool_calls' : undefined;
  switch (value) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      return hasToolCalls ? 'tool_calls' : 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'tool_use':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
    case 'safety':
    case 'blocklist':
    case 'prohibited_content':
      return 'content_filter';
    default:
      return hasToolCalls ? 'tool_calls' : 'other';
  }
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
  toolCalls?: ParsedToolCall[];
  finishReason?: ParsedFinishReason;
}

export function parseOpenAIChatCompletion(value: unknown): OpenAIChatCompletion {
  const data = asRecord(value);
  const choice = asRecord(asArray(data?.choices)?.[0]);
  const message = asRecord(choice?.message);
  const rawToolCalls = asArray(message?.tool_calls) || [];
  const toolCalls: ParsedToolCall[] = rawToolCalls
    .map((entry): ParsedToolCall | undefined => {
      const call = asRecord(entry);
      const fn = asRecord(call?.function);
      const name = asString(fn?.name);
      if (!name) return undefined;
      return { id: asString(call?.id), name, arguments: asString(fn?.arguments) || '' };
    })
    .filter((c): c is ParsedToolCall => Boolean(c));
  const toolArgs = toolCalls[0]?.arguments;
  const usage = asRecord(data?.usage);

  return {
    // Tool arguments win over content; `content` is null on tool calls and
    // absent on malformed bodies.
    text: toolArgs || asString(message?.content) || '',
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: normalizeFinishReason(choice?.finish_reason, toolCalls.length > 0),
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
  toolCalls?: ParsedToolCall[];
  finishReason?: ParsedFinishReason;
}

export function parseAnthropicMessage(value: unknown): AnthropicMessage {
  const data = asRecord(value);
  // Only the FIRST content block is read, and only its `text` field.
  const blocks = asArray(data?.content) || [];
  const firstBlock = asRecord(blocks[0]);
  const toolCalls: ParsedToolCall[] = blocks
    .map((entry): ParsedToolCall | undefined => {
      const block = asRecord(entry);
      if (asString(block?.type) !== 'tool_use') return undefined;
      const name = asString(block?.name);
      if (!name) return undefined;
      return {
        id: asString(block?.id),
        name,
        arguments: block?.input === undefined ? '' : JSON.stringify(block.input),
      };
    })
    .filter((c): c is ParsedToolCall => Boolean(c));
  const usage = asRecord(data?.usage);
  const inputTokens = asNumber(usage?.input_tokens) || 0;
  const outputTokens = asNumber(usage?.output_tokens) || 0;

  return {
    text: asString(firstBlock?.text) || '',
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: normalizeFinishReason(data?.stop_reason, toolCalls.length > 0),
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
  toolCalls?: ParsedToolCall[];
  finishReason?: ParsedFinishReason;
}

export function parseGeminiGenerateContent(value: unknown): GeminiGenerateContent {
  const data = asRecord(value);
  const candidate = asRecord(asArray(data?.candidates)?.[0]);
  const parts = asArray(asRecord(candidate?.content)?.parts);
  const firstPart = asRecord(parts?.[0]);
  const toolCalls: ParsedToolCall[] = (parts || [])
    .map((entry) => {
      const call = asRecord(asRecord(entry)?.functionCall);
      const name = asString(call?.name);
      if (!name) return undefined;
      return { name, arguments: call?.args === undefined ? '' : JSON.stringify(call.args) };
    })
    .filter((c): c is ParsedToolCall => Boolean(c));
  const meta = asRecord(data?.usageMetadata);

  return {
    text: asString(firstPart?.text) || '',
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: normalizeFinishReason(candidate?.finishReason, toolCalls.length > 0),
    usage: {
      promptTokens: asNumber(meta?.promptTokenCount) || 0,
      completionTokens: asNumber(meta?.candidatesTokenCount) || 0,
      totalTokens: asNumber(meta?.totalTokenCount) || 0,
    },
  };
}
