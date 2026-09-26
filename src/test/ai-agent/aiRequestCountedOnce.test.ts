/**
 * /api/ai/complete counts ai_requests_count exactly once.
 *
 * The route bumped the counter itself, and on a database with the hosted
 * chain the ai_usage_logs insert trigger bumped it again, so every request
 * counted twice. The route now counts only when the completion's usage row
 * did NOT reach ai_usage_logs — PRODUCT_ANALYTICS_LOGGING=off, or a self-host
 * database with neither the table nor the trigger — which is what
 * wasRequestCounted() reports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeFakeSupabase } from './helpers/engineFixtures.js';

let fakeSb: ReturnType<typeof makeFakeSupabase>;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

const { executeAICompletion, wasRequestCounted } = await import('../../../server/services/ai/index.js');

type Config = Parameters<typeof executeAICompletion>[0];
type Request = Parameters<typeof executeAICompletion>[1];

const CONFIG = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'ANON_KEY',
  supabaseServiceRoleKey: 'SERVICE_KEY',
  aiRuntimeBaseUrl: 'https://ai-runtime.test',
  aiRuntimeInternalSecret: 'runtime-secret',
} as unknown as Config;

const REQUEST = { workspaceId: 'ws-1', prompt: 'hi' } as Request;

function seededSupabase() {
  return makeFakeSupabase({
    provider_configs: [
      {
        id: 'pc-1',
        workspace_id: 'ws-1',
        provider_type: 'ai',
        is_active: true,
        provider_name: 'openai',
        config: { api_key: 'k', model: 'gpt-4o-mini' },
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
}

/** A self-host database: the ai_usage_logs table does not exist. */
function withoutUsageLogTable(sb: ReturnType<typeof makeFakeSupabase>) {
  const from = sb.from.bind(sb);
  return Object.assign(Object.create(sb), {
    from: (table: string) =>
      table === 'ai_usage_logs'
        ? { insert: async () => ({ data: null, error: { code: '42P01', message: 'relation "ai_usage_logs" does not exist' } }) }
        : from(table),
  }) as ReturnType<typeof makeFakeSupabase>;
}

beforeEach(() => {
  fakeSb = seededSupabase();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        response: {
          text: 'hello', model: 'gpt-4o-mini', provider: 'openai',
          promptTokens: 5, completionTokens: 3, totalTokens: 8, latencyMs: 12,
        },
      }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wasRequestCounted', () => {
  it('is true once the usage row — whose trigger counts the request — is written', async () => {
    const result = await executeAICompletion(CONFIG, REQUEST);
    expect(fakeSb.__store['ai_usage_logs']).toHaveLength(1);
    expect(wasRequestCounted(result)).toBe(true);
  });

  it('is false when analytics logging is off and no row is written', async () => {
    const result = await executeAICompletion({ ...CONFIG, productAnalyticsLoggingEnabled: false } as Config, REQUEST);
    expect(fakeSb.__store['ai_usage_logs'] ?? []).toHaveLength(0);
    expect(wasRequestCounted(result)).toBe(false);
  });

  it('is false on a self-host database without the table (and its trigger)', async () => {
    fakeSb = withoutUsageLogTable(seededSupabase());
    const result = await executeAICompletion(CONFIG, REQUEST);
    expect(wasRequestCounted(result)).toBe(false);
  });

  it('the route counts only when the usage row did not', () => {
    // Source-level: the unconditional bump is what double counted.
    const route = readFileSync('server/routes/ai.ts', 'utf8');
    expect(route).toMatch(/if \(!wasRequestCounted\(result\)\) \{\s*incrementUsage\([^)]*'ai_requests_count'\)/);
  });
});
