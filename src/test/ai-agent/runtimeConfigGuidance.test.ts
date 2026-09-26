/**
 * Workspace guidance rules reach the AI Agent runtime.
 *
 * `ai_agent_guidance_rules` stores `rule_type`, `instruction` and
 * `condition_json` (20260429192129; the guidance API writes exactly those).
 * The runtime loader asked for `type`, `body` and `metadata`, columns the
 * table never had, so PostgREST rejected the whole query and every workspace
 * ran with no guidance at all. The loader now reads the real columns and maps
 * them onto the runtime shape the prompt builder uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerConfig } from '../../../server/config';

const REAL_COLUMNS = ['id', 'workspace_id', 'title', 'description', 'rule_type', 'condition_json', 'instruction', 'priority', 'enabled'];

const selects = new Map<string, string>();
let guidanceRows: Array<Record<string, unknown>> = [];

interface FakeQuery {
  select: (cols: string, opts?: unknown) => FakeQuery;
  eq: () => FakeQuery;
  order: () => FakeQuery;
  then: (resolve: (result: { data: unknown; error: unknown; count: number }) => unknown) => unknown;
}

function query(table: string): FakeQuery {
  const q: FakeQuery = {
    select: (cols) => {
      if (!selects.has(table)) selects.set(table, cols);
      return q;
    },
    eq: () => q,
    order: () => q,
    then: (resolve) => {
      if (table !== 'ai_agent_guidance_rules') return resolve({ data: [], error: null, count: 0 });
      // PostgREST answers an unknown column with an error and no rows.
      const unknown = (selects.get(table) || '')
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c && !REAL_COLUMNS.includes(c));
      if (unknown.length) {
        return resolve({ data: null, error: { code: '42703', message: `column ${unknown[0]} does not exist` }, count: 0 });
      }
      return resolve({ data: guidanceRows, error: null, count: guidanceRows.length });
    },
  };
  return q;
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({ from: (t: string) => query(t) }) }));
vi.mock('../../../server/services/ai-agent/settings.js', () => ({
  getOrCreateSettings: async () => ({ enabled: true, instructions: {} }),
}));

const { loadAiAgentRuntimeConfig, invalidateRuntimeConfig } = await import('../../../server/services/ai-agent/runtimeConfig');

const CFG = {} as ServerConfig;

beforeEach(() => {
  selects.clear();
  invalidateRuntimeConfig();
  guidanceRows = [
    {
      id: 'g1',
      rule_type: 'tone',
      title: 'Warm tone',
      description: 'Keep it friendly',
      instruction: 'Greet the visitor by name when it is known.',
      condition_json: { channel: 'widget' },
      priority: 10,
      enabled: true,
    },
    {
      id: 'g2',
      rule_type: 'pricing_guidance',
      title: 'No discounts',
      description: null,
      instruction: '',
      condition_json: null,
      priority: 20,
      enabled: true,
    },
  ];
});

describe('AI Agent runtime guidance rules', () => {
  it('asks only for columns ai_agent_guidance_rules really has', async () => {
    await loadAiAgentRuntimeConfig(CFG, 'ws-guidance-1');
    const cols = (selects.get('ai_agent_guidance_rules') || '').split(',').map((c) => c.trim());
    expect(cols).toEqual(expect.arrayContaining(['rule_type', 'instruction', 'condition_json']));
    expect(cols.filter((c) => !REAL_COLUMNS.includes(c))).toEqual([]);
  });

  it('maps rule_type / instruction / condition_json onto the runtime shape', async () => {
    const cfg = await loadAiAgentRuntimeConfig(CFG, 'ws-guidance-2');
    expect(cfg.guidanceRules).toEqual([
      {
        id: 'g1',
        type: 'tone',
        title: 'Warm tone',
        description: 'Keep it friendly',
        body: 'Greet the visitor by name when it is known.',
        priority: 10,
        enabled: true,
        metadata: { channel: 'widget' },
      },
      {
        id: 'g2',
        type: 'pricing_guidance',
        title: 'No discounts',
        description: null,
        body: '',
        priority: 20,
        enabled: true,
        metadata: {},
      },
    ]);
  });
});
