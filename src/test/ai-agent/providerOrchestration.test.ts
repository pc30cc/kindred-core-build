/**
 * Phase 1 characterization — C17 (orchestration slice only). The provider
 * response PARSERS (parseOpenAIChatCompletion / parseAnthropicMessage /
 * parseGeminiGenerateContent / readProviderErrorMessage) already have
 * thorough, passing coverage in src/test/security/aiProviderResponses.test.ts
 * and are intentionally NOT retested here. This file covers only the
 * missing orchestration layer around them: resolveAIConfig's resolution
 * order and executeAICompletion's provider-not-configured / error-mapping
 * behavior, using the real server/supabase.js boundary (faked) and the
 * real global fetch (stubbed) as the true external boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeSupabase } from './helpers/engineFixtures.js';

let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

const { resolveAIConfig, executeAICompletion } = await import('../../../server/services/ai/index.js');

const CONFIG = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'ANON_KEY',
  supabaseServiceRoleKey: 'SERVICE_KEY',
} as any;

const WORKSPACE_ID = 'ws-1';

beforeEach(() => {
  fakeSb = makeFakeSupabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveAIConfig — resolution order', () => {
  it('prefers an active workspace-level provider_configs row over the global default', async () => {
    fakeSb = makeFakeSupabase({
      provider_configs: [
        {
          id: 'pc-1',
          workspace_id: WORKSPACE_ID,
          provider_type: 'ai',
          is_active: true,
          provider_name: 'openai',
          config: { api_key: 'ws-key', model: 'gpt-4o-mini' },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      app_runtime_config: [{ key: 'default_ai_provider', value: { provider: 'anthropic', api_key: 'global-key' } }],
    });

    const cfg = await resolveAIConfig(CONFIG, WORKSPACE_ID);

    expect(cfg?.provider).toBe('openai');
    expect(cfg?.apiKey).toBe('ws-key');
  });

  it('falls back to the global default_ai_provider when no workspace config exists', async () => {
    fakeSb = makeFakeSupabase({
      app_runtime_config: [{ key: 'default_ai_provider', value: { provider: 'anthropic', api_key: 'global-key', model: 'claude-3' } }],
    });

    const cfg = await resolveAIConfig(CONFIG, WORKSPACE_ID);

    expect(cfg?.provider).toBe('anthropic');
    expect(cfg?.apiKey).toBe('global-key');
  });

  it('returns null when neither workspace nor global config is usable', async () => {
    fakeSb = makeFakeSupabase();
    const cfg = await resolveAIConfig(CONFIG, WORKSPACE_ID);
    expect(cfg).toBeNull();
  });

  it('does not use a workspace config row missing an api_key, falls through to global instead', async () => {
    fakeSb = makeFakeSupabase({
      provider_configs: [
        {
          id: 'pc-2',
          workspace_id: WORKSPACE_ID,
          provider_type: 'ai',
          is_active: true,
          provider_name: 'openai',
          config: { model: 'gpt-4o-mini' }, // no api_key
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      app_runtime_config: [{ key: 'default_ai_provider', value: { provider: 'anthropic', api_key: 'global-key' } }],
    });

    const cfg = await resolveAIConfig(CONFIG, WORKSPACE_ID);
    expect(cfg?.provider).toBe('anthropic');
  });
});

describe('executeAICompletion — provider not configured', () => {
  it('throws a specific, stable error message when no provider is configured', async () => {
    fakeSb = makeFakeSupabase();
    await expect(
      executeAICompletion(CONFIG, { workspaceId: WORKSPACE_ID, prompt: 'hi' } as any),
    ).rejects.toThrow('No AI provider configured. Set up an AI provider in admin settings.');
  });

  it('throws for an unsupported/unknown provider name', async () => {
    fakeSb = makeFakeSupabase({
      provider_configs: [
        {
          id: 'pc-3',
          workspace_id: WORKSPACE_ID,
          provider_type: 'ai',
          is_active: true,
          provider_name: 'not_a_real_provider',
          config: { api_key: 'k' },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    await expect(
      executeAICompletion(CONFIG, { workspaceId: WORKSPACE_ID, prompt: 'hi' } as any),
    ).rejects.toThrow(/Unsupported AI provider/);
  });
});

describe('executeAICompletion — error mapping and usage logging', () => {
  it('logs a failed ai_usage_logs row and rethrows the provider error', async () => {
    fakeSb = makeFakeSupabase({
      provider_configs: [
        {
          id: 'pc-4',
          workspace_id: WORKSPACE_ID,
          provider_type: 'ai',
          is_active: true,
          provider_name: 'openai',
          config: { api_key: 'k', model: 'gpt-4o-mini' },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { message: 'upstream boom' } }),
      })) as any,
    );

    await expect(
      executeAICompletion(CONFIG, { workspaceId: WORKSPACE_ID, prompt: 'hi' } as any),
    ).rejects.toThrow();

    const logs = fakeSb.__store['ai_usage_logs'] || [];
    expect(logs).toHaveLength(1);
    expect(logs[0].success).toBe(false);
    expect(logs[0].workspace_id).toBe(WORKSPACE_ID);
    expect(logs[0].provider_name).toBe('openai');
  });

  it('logs a successful ai_usage_logs row on a normal completion', async () => {
    fakeSb = makeFakeSupabase({
      provider_configs: [
        {
          id: 'pc-5',
          workspace_id: WORKSPACE_ID,
          provider_type: 'ai',
          is_active: true,
          provider_name: 'openai',
          config: { api_key: 'k', model: 'gpt-4o-mini' },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'hello there' } }],
          model: 'gpt-4o-mini',
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      })) as any,
    );

    const result = await executeAICompletion(CONFIG, { workspaceId: WORKSPACE_ID, prompt: 'hi' } as any);

    expect(result.text).toBe('hello there');
    const logs = fakeSb.__store['ai_usage_logs'] || [];
    expect(logs).toHaveLength(1);
    expect(logs[0].success).toBe(true);
    expect(logs[0].total_tokens).toBe(8);
  });
});
