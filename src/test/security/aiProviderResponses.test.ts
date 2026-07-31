import { describe, it, expect } from 'vitest';
import {
  parseOpenAIChatCompletion,
  parseAnthropicMessage,
  parseGeminiGenerateContent,
  readProviderErrorMessage,
} from '../../../server/services/ai/index';

describe('parseOpenAIChatCompletion', () => {
  it('extracts text content and usage', () => {
    const parsed = parseOpenAIChatCompletion({
      choices: [{ message: { role: 'assistant', content: 'hello' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    expect(parsed.text).toBe('hello');
    expect(parsed.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  });

  it('prefers tool call arguments and passes the raw JSON string through untouched', () => {
    const args = '{"city":"Tehran"}';
    const parsed = parseOpenAIChatCompletion({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ function: { name: 'get_weather', arguments: args } }],
          },
        },
      ],
    });
    expect(parsed.text).toBe(args);
  });

  it('returns empty text and zero usage for malformed or usage-less bodies', () => {
    expect(parseOpenAIChatCompletion({ choices: [] }).text).toBe('');
    expect(parseOpenAIChatCompletion({}).usage.totalTokens).toBe(0);
    expect(parseOpenAIChatCompletion(null).text).toBe('');
    expect(parseOpenAIChatCompletion({ choices: [{ message: { content: 42 } }] }).text).toBe('');
  });
});

describe('parseAnthropicMessage', () => {
  it('extracts the first text block and derives total tokens', () => {
    const parsed = parseAnthropicMessage({
      content: [{ type: 'text', text: 'salam' }],
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    expect(parsed.text).toBe('salam');
    expect(parsed.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
  });

  it('does not treat a leading tool_use block as text', () => {
    const parsed = parseAnthropicMessage({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'x' } }],
    });
    expect(parsed.text).toBe('');
  });

  it('tolerates an empty content array and a missing usage object', () => {
    const parsed = parseAnthropicMessage({ content: [] });
    expect(parsed.text).toBe('');
    expect(parsed.usage.totalTokens).toBe(0);
  });
});

describe('parseGeminiGenerateContent', () => {
  it('extracts the first part text and usage metadata', () => {
    const parsed = parseGeminiGenerateContent({
      candidates: [{ content: { parts: [{ text: 'merhaba' }] } }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
    });
    expect(parsed.text).toBe('merhaba');
    expect(parsed.usage).toEqual({ promptTokens: 9, completionTokens: 4, totalTokens: 13 });
  });

  it('returns empty text for a function-call part with no text', () => {
    const parsed = parseGeminiGenerateContent({
      candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: {} } }] } }],
    });
    expect(parsed.text).toBe('');
  });

  it('tolerates a safety-blocked response with no candidates', () => {
    const parsed = parseGeminiGenerateContent({ promptFeedback: { blockReason: 'SAFETY' } });
    expect(parsed.text).toBe('');
    expect(parsed.usage.promptTokens).toBe(0);
  });
});

describe('readProviderErrorMessage', () => {
  it('reads the provider message when present', () => {
    expect(readProviderErrorMessage({ error: { message: 'invalid api key' } })).toBe('invalid api key');
  });

  it('returns undefined for shapes without a string message', () => {
    expect(readProviderErrorMessage({ error: {} })).toBeUndefined();
    expect(readProviderErrorMessage({ error: { message: 500 } })).toBeUndefined();
    expect(readProviderErrorMessage(null)).toBeUndefined();
  });
});