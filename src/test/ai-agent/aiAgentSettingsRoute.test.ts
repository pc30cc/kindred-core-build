/**
 * PUT /api/ai-agent/settings, driven through the real router AND the real
 * settings service (server/services/ai-agent/settings.ts), over an in-memory
 * `ai_agent_settings` row:
 *
 *   - The answer-strategy fields the Activation page ("Answer behavior") and
 *     the Behavior page ("When AI is unsure") send were missing from the
 *     route's `.strict()` schema, so every such save was a 400 and the whole
 *     Behavior save failed with it; the customer-safe projection did not
 *     return them either, so the pages always showed the defaults.
 *   - `instructions` is one JSON column replaced whole on every write, and
 *     its `custom_system_instruction` is never returned to the browser, so
 *     any Behavior or Instructions save erased it. A write that leaves it out
 *     now keeps the stored one; only `has_custom_system_instruction` is sent.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '66666666-6666-4666-8666-666666666666';
const SECRET = 'Always sign off with "cheers".';

type Row = Record<string, unknown>;
type SettingsBody = {
  error?: string;
  settings?: Row & { instructions?: Row; has_custom_system_instruction?: boolean };
  counts?: Row;
};

const db: { row: Row; updates: Row[] } = { row: {}, updates: [] };

function seed(overrides: Row = {}) {
  db.row = {
    id: 'settings-1',
    workspace_id: WS,
    enabled: false,
    mode: 'off',
    agent_name: 'Aria',
    agent_logo_url: null,
    metadata: { internal_note: 'never sent' },
    escalation_style: 'balanced',
    allow_clarifying_questions: true,
    max_clarification_attempts: 1,
    allow_answer_with_caveat: true,
    instructions: {
      tone: 'friendly',
      max_answer_length: 'medium',
      brand_voice: 'Playful but precise.',
      do_list: ['Be concise'],
      custom_system_instruction: SECRET,
    },
    ...overrides,
  };
  db.updates = [];
}

/** Only `ai_agent_settings` holds data; every other table reads empty. */
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      let update: Row | null = null;
      const result = async () => {
        if (table !== 'ai_agent_settings') return { data: null, error: null };
        if (update) {
          db.updates.push(update);
          db.row = { ...db.row, ...update };
        }
        // A copy, so nothing downstream can edit the stored row in place.
        return { data: structuredClone(db.row), error: null };
      };
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        in: () => builder,
        is: () => builder,
        insert: () => builder,
        update: (values: Row) => { update = structuredClone(values); return builder; },
        single: result,
        maybeSingle: result,
        then: (onOk: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onOk),
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>();
  return {
    ...actual,
    authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: false, role: 'owner' }),
  };
});
vi.mock('../../../server/lib/cacheBus.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/lib/cacheBus.js')>();
  return { ...actual, publishCacheInvalidation: vi.fn() };
});
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkModuleAccess: async () => ({ allowed: true }),
  requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  checkEntitlementFromDB: async () => ({ allowed: true }),
  requireLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  clearEntitlementCache: () => {},
}));
vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => false,
}));
// GET /overview: the row as buildOverview reads it (raw, every column).
vi.mock('../../../server/services/ai-agent/overview.js', () => ({
  buildOverview: async () => ({ settings: structuredClone(db.row), counts: { qna: 2 }, warnings: [] }),
}));

const { assistantRouter } = await import('../../../server/routes/ai-agent/assistant.js');

const app = express();
app.use((req, _res, next) => {
  const r = req as express.Request & { serverConfig: unknown; authUser: unknown };
  r.serverConfig = { supabaseUrl: 'x', supabaseServiceRoleKey: 'z' };
  r.authUser = { id: 'u1' };
  next();
});
app.use(express.json());
app.use('/api/ai-agent', assistantRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;
afterAll(() => { server.close(); });

function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; body: SettingsBody }> {
  return new Promise((done, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { done({ status: res.statusCode || 0, text: d, body: d ? JSON.parse(d) : null }); }
        catch (e) { fail(e); }
      });
    });
    req.on('error', fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const put = (patch: Row) => call('PUT', '/api/ai-agent/settings', { workspaceId: WS, ...patch });

beforeEach(() => seed());

describe('PUT /api/ai-agent/settings — answer strategy fields', () => {
  it('accepts the four fields, stores them and returns them', async () => {
    const res = await put({
      escalation_style: 'helpful_first',
      allow_clarifying_questions: false,
      max_clarification_attempts: 3,
      allow_answer_with_caveat: false,
    });

    expect(res.status).toBe(200);
    expect(db.updates).toEqual([{
      escalation_style: 'helpful_first',
      allow_clarifying_questions: false,
      max_clarification_attempts: 3,
      allow_answer_with_caveat: false,
    }]);
    expect(res.body.settings).toMatchObject({
      escalation_style: 'helpful_first',
      allow_clarifying_questions: false,
      max_clarification_attempts: 3,
      allow_answer_with_caveat: false,
    });
  });

  it.each([
    ['conservative'], ['balanced'], ['helpful_first'],
  ])('accepts escalation_style %s', async (style) => {
    const res = await put({ escalation_style: style });
    expect(res.status).toBe(200);
    expect(db.row.escalation_style).toBe(style);
  });

  it('accepts max_clarification_attempts at both ends of 0..5', async () => {
    expect((await put({ max_clarification_attempts: 0 })).status).toBe(200);
    expect(db.row.max_clarification_attempts).toBe(0);
    expect((await put({ max_clarification_attempts: 5 })).status).toBe(200);
    expect(db.row.max_clarification_attempts).toBe(5);
  });

  it.each([
    ['escalation_style', 'reckless'],
    ['max_clarification_attempts', 6],
    ['max_clarification_attempts', -1],
    ['max_clarification_attempts', 1.5],
    ['max_clarification_attempts', '2'],
    ['allow_clarifying_questions', 'yes'],
    ['allow_answer_with_caveat', 1],
  ])('refuses %s = %j (outside the column) before writing anything', async (field, value) => {
    const res = await put({ [field]: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_params');
    expect(db.updates).toEqual([]);
  });

  it("saves Behavior's whole \"When AI is unsure\" patch (it used to fail on allow_clarifying_questions)", async () => {
    const res = await put({
      allow_clarifying_questions: false,
      handoff_on_low_confidence: true,
      fallback_behavior: 'handoff',
    });

    expect(res.status).toBe(200);
    expect(db.row).toMatchObject({
      allow_clarifying_questions: false,
      handoff_on_low_confidence: true,
      fallback_behavior: 'handoff',
    });
  });

  it('GET /settings returns the stored values, not the defaults', async () => {
    seed({
      escalation_style: 'conservative',
      allow_clarifying_questions: false,
      max_clarification_attempts: 4,
      allow_answer_with_caveat: false,
    });
    const res = await call('GET', `/api/ai-agent/settings?workspaceId=${WS}`);

    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({
      escalation_style: 'conservative',
      allow_clarifying_questions: false,
      max_clarification_attempts: 4,
      allow_answer_with_caveat: false,
    });
  });
});

describe('PUT /api/ai-agent/settings — the custom system instruction survives other instruction writes', () => {
  it('a Behavior save (tone and answer length only) keeps the stored custom instruction', async () => {
    const res = await put({ instructions: { tone: 'formal', max_answer_length: 'short' } });

    expect(res.status).toBe(200);
    // Kept in the WRITE itself, not patched up afterwards.
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].instructions).toEqual({
      tone: 'formal',
      max_answer_length: 'short',
      custom_system_instruction: SECRET,
    });
    expect(db.row.instructions).toEqual({
      tone: 'formal',
      max_answer_length: 'short',
      custom_system_instruction: SECRET,
    });
  });

  it('only that key is kept: every other instruction key is still replaced by the write', async () => {
    const res = await put({ instructions: { brand_voice: 'Bold and confident.' } });

    expect(res.status).toBe(200);
    expect(db.row.instructions).toEqual({
      brand_voice: 'Bold and confident.',
      custom_system_instruction: SECRET,
    });
  });

  it('a write that carries the key replaces the stored one', async () => {
    const res = await put({ instructions: { tone: 'friendly', custom_system_instruction: 'New closing line: stay curious.' } });

    expect(res.status).toBe(200);
    expect(db.row.instructions).toEqual({ tone: 'friendly', custom_system_instruction: 'New closing line: stay curious.' });
    expect(res.body.settings?.has_custom_system_instruction).toBe(true);
  });

  it("'' removes it, and a later write without the key does not bring it back", async () => {
    const removed = await put({ instructions: { tone: 'friendly', custom_system_instruction: '' } });
    expect(removed.status).toBe(200);
    expect((db.row.instructions as Row).custom_system_instruction).toBe('');
    expect(removed.body.settings?.has_custom_system_instruction).toBe(false);

    const later = await put({ instructions: { tone: 'formal' } });
    expect(later.status).toBe(200);
    expect((db.row.instructions as Row).custom_system_instruction ?? '').toBe('');
    expect(later.body.settings?.has_custom_system_instruction).toBe(false);
  });

  it('a save without `instructions` leaves the column untouched', async () => {
    const before = structuredClone(db.row.instructions);
    const res = await put({ agent_name: 'Nova' });

    expect(res.status).toBe(200);
    expect(db.updates).toEqual([{ agent_name: 'Nova' }]);
    expect(db.row.instructions).toEqual(before);
  });

  it('with nothing stored, a write without the key stays without it', async () => {
    seed({ instructions: { tone: 'friendly' } });
    const res = await put({ instructions: { tone: 'formal' } });

    expect(res.status).toBe(200);
    expect(db.row.instructions).toEqual({ tone: 'formal' });
    expect(res.body.settings?.has_custom_system_instruction).toBe(false);
  });

  it('the PUT response carries only has_custom_system_instruction, never the text', async () => {
    const res = await put({ instructions: { tone: 'formal' } });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('sign off with');
    expect(res.body.settings?.has_custom_system_instruction).toBe(true);
    expect(res.body.settings?.instructions).not.toHaveProperty('custom_system_instruction');
  });
});

describe('the settings reads never return the custom instruction or the metadata', () => {
  it('GET /settings: has_custom_system_instruction only', async () => {
    const res = await call('GET', `/api/ai-agent/settings?workspaceId=${WS}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('sign off with');
    expect(res.body.settings?.has_custom_system_instruction).toBe(true);
    expect(res.body.settings?.instructions).not.toHaveProperty('custom_system_instruction');
    expect(res.body.settings).not.toHaveProperty('metadata');
  });

  it('GET /settings: false when none is saved (or only whitespace)', async () => {
    seed({ instructions: { tone: 'friendly', custom_system_instruction: '   ' } });
    const res = await call('GET', `/api/ai-agent/settings?workspaceId=${WS}`);

    expect(res.body.settings?.has_custom_system_instruction).toBe(false);
  });

  it('GET /overview: its settings are the customer-safe ones too', async () => {
    const res = await call('GET', `/api/ai-agent/overview?workspaceId=${WS}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('sign off with');
    expect(res.text).not.toContain('never sent');
    expect(res.body.settings).not.toHaveProperty('metadata');
    expect(res.body.settings).toMatchObject({ enabled: false, mode: 'off', has_custom_system_instruction: true });
    // The rest of the overview is passed through unchanged.
    expect(res.body.counts).toEqual({ qna: 2 });
  });
});
