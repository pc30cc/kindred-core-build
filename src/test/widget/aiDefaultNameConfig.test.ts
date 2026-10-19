// @vitest-environment node
/**
 * GET /config's `aiAgent.agentName` is the agent's stored name, the
 * built-in English one ('AI Assistant') too, as on realtime, /history and
 * the intro: the runtime.js loaded before this release reads it as it
 * always did. Today's runtime treats the built-in name as no name
 * (runtime.js aiOwnName), so t1 draws the AI with the workspace's tile, not
 * a Latin "A" in a Persian widget (src/test/widget/aiNamelessRun.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createFakeDb, allowAllRpc, widgetScenarioTables, type FakeDb } from './widgetConfigFakeDb';

const holder = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-ai-default-name';
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;
const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');
const { WS } = await import('./widgetConfigFakeDb');

const req = { query: {}, headers: {}, protocol: 'https', get: () => 'api.test', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
type Row = Record<string, unknown>;

async function aiAgentName(agentName: string | null) {
  const tables = widgetScenarioTables({ edition: 'iran', ai: true, smart: false }) as Record<string, Row[]>;
  tables.ai_agent_settings[0].agent_name = agentName;
  holder.db = createFakeDb(tables, { rpc: allowAllRpc });
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  const out = await snapshotMod.resolveWidgetConfigBody(config, req, WS, { edition: 'iran', quotaFull: null });
  expect(out.status).toBe(200);
  return ((out.body as Row).aiAgent as Row).agentName;
}

describe('aiAgent.agentName in the visitor\'s config', () => {
  it('the built-in English name is sent as stored; none is null', async () => {
    expect(await aiAgentName('AI Assistant')).toBe('AI Assistant');
    expect(await aiAgentName(null)).toBeNull();
  });

  it('a name the owner chose is sent as written', async () => {
    expect(await aiAgentName('Ava')).toBe('Ava');
  });
});
