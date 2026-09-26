/**
 * Every AI request counts ai_requests_count exactly once.
 *
 * The route bumped the counter itself, and on a database with the hosted
 * chain the ai_usage_logs insert trigger bumped it again, so every request
 * counted twice. The route now counts only when the completion's usage row
 * did NOT reach ai_usage_logs — PRODUCT_ANALYTICS_LOGGING=off, or a self-host
 * database with neither the table nor the trigger — which is what
 * wasRequestCounted() reports.
 *
 * deduct_ai_credits() counted the request a third time on /api/ai/complete
 * (and a second time for the AI-KB builder, its other caller). The hosted
 * chain's latest definition moves credits only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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

const HOSTED = 'supabase/migrations';

/** The newest hosted-chain definition of public.<name>(), and its file. */
function latestHostedDefinition(name: string): { file: string; sql: string } {
  const defines = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, 'gi');
  const file = readdirSync(HOSTED)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => new RegExp(defines.source, 'i').test(readFileSync(`${HOSTED}/${f}`, 'utf8')))
    .pop();
  if (!file) throw new Error(`no hosted migration defines public.${name}()`);
  const text = readFileSync(`${HOSTED}/${file}`, 'utf8');
  const start = [...text.matchAll(defines)].pop()?.index ?? 0;
  const rest = text.slice(start);
  const open = /\bAS\s+(\$[A-Za-z_]*\$)/i.exec(rest);
  if (!open) throw new Error(`public.${name}() in ${file} has no dollar-quoted body`);
  const close = rest.indexOf(open[1], open.index + open[0].length);
  return { file, sql: rest.slice(0, close + open[1].length) };
}

describe('deduct_ai_credits (hosted chain)', () => {
  const deduct = latestHostedDefinition('deduct_ai_credits');

  it('moves credits without counting the request', () => {
    expect(deduct.sql).toMatch(/SET ai_credits_used = ai_credits_used \+ _credits,/);
    expect(deduct.sql).not.toMatch(/ai_requests_count/);
  });

  it('stays service_role-only', () => {
    const file = readFileSync(`${HOSTED}/${deduct.file}`, 'utf8');
    expect(file).toContain(
      'REVOKE ALL ON FUNCTION public.deduct_ai_credits(uuid, integer, text) FROM PUBLIC, anon, authenticated;',
    );
    expect(file).toContain('GRANT EXECUTE ON FUNCTION public.deduct_ai_credits(uuid, integer, text) TO service_role;');
  });

  it('leaves the count to the ai_usage_logs trigger', () => {
    const trigger = latestHostedDefinition('tg_ai_usage_logs_count_request');
    expect(trigger.sql).toMatch(/bump_usage_counter_for\(NEW\.workspace_id, 'ai_requests_count', 1,/);
  });
});
