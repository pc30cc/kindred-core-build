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
 *   - `instructions` is one JSON column. It used to be replaced whole on
 *     every write, so a page sending only the keys it edited erased the
 *     rest, the never-returned `custom_system_instruction` included. A write
 *     now MERGES key by key (settings.ts mergeInstructions): keys left out
 *     keep their stored value, '' / [] clear one; only
 *     `has_custom_system_instruction` is ever sent back.
 *   - The "Personality & behavior" page's contract: reply_language,
 *     handoff_policy (+ max_assist_attempts), learning_enabled and
 *     auto_create_learning_candidates are accepted, stored and returned
 *     customer-safe; picking a handoff policy turns handoff_on_human_request
 *     on (settings.ts syncHumanRequestSwitch).
 *   - Owners and admins write, members read; every read and write is scoped
 *     to the workspace the request names.
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

/**
 * `updates`: what each write set; `scopes`: the eq() filters of every query
 * on ai_agent_settings (reads and writes alike).
 */
const db: { row: Row; updates: Row[]; scopes: Row[] } = { row: {}, updates: [], scopes: [] };
/** Who the request authenticates as (workspaceAuth.authorizeWorkspaceAccess). */
const access: { as: { userId: string; isAdmin: boolean; role: string | null } | null; asked: unknown[] } = {
  as: { userId: 'u1', isAdmin: false, role: 'owner' },
  asked: [],
};

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
  db.scopes = [];
}

/** Only `ai_agent_settings` holds data; every other table reads empty. */
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      let update: Row | null = null;
      const scope: Row = {};
      const result = async () => {
        if (table !== 'ai_agent_settings') return { data: null, error: null };
        db.scopes.push({ ...scope, ...(update ? { write: true } : {}) });
        if (update) {
          db.updates.push(update);
          db.row = { ...db.row, ...update };
        }
        // A copy, so nothing downstream can edit the stored row in place.
        return { data: structuredClone(db.row), error: null };
      };
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => { scope[col] = val; return builder; },
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
    // Not a member of the workspace asked for: 403, as the real one answers.
    authorizeWorkspaceAccess: async (
      _req: unknown,
      res: { status: (code: number) => { json: (body: unknown) => void } },
      workspaceId: unknown,
    ) => {
      access.asked.push(workspaceId);
      if (!access.as) {
        res.status(403).json({ error: 'Not a member of this workspace' });
        return null;
      }
      return access.as;
    },
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

beforeEach(() => {
  seed();
  access.as = { userId: 'u1', isAdmin: false, role: 'owner' };
  access.asked = [];
});

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
      brand_voice: 'Playful but precise.',
      do_list: ['Be concise'],
      custom_system_instruction: SECRET,
    });
    expect(db.row.instructions).toEqual(db.updates[0].instructions);
  });

  it('a write that carries the key replaces the stored one', async () => {
    const res = await put({ instructions: { tone: 'friendly', custom_system_instruction: 'New closing line: stay curious.' } });

    expect(res.status).toBe(200);
    expect(db.row.instructions).toEqual({
      tone: 'friendly',
      max_answer_length: 'medium',
      brand_voice: 'Playful but precise.',
      do_list: ['Be concise'],
      custom_system_instruction: 'New closing line: stay curious.',
    });
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

describe('PUT /api/ai-agent/settings — `instructions` merges key by key', () => {
  const LEGACY = {
    tone: 'friendly',
    max_answer_length: 'medium',
    brand_voice: 'Playful but precise.',
    do_list: ['Be concise'],
    custom_system_instruction: SECRET,
    // Keys no current page shows or knows: still the prompt's input (prompt.ts).
    custom_instructions: 'Legacy operator text.',
    forbidden_topics: ['politics'],
    personality: 'calm',
  };

  it('a page sending one key keeps every other stored key, the ones it never sees or does not know included', async () => {
    seed({ instructions: LEGACY });
    const res = await put({ instructions: { dont_list: ['Never promise refunds'] } });

    expect(res.status).toBe(200);
    // Merged in the WRITE itself: one update, the whole object.
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].instructions).toEqual({ ...LEGACY, dont_list: ['Never promise refunds'] });
    expect(db.row.instructions).toEqual({ ...LEGACY, dont_list: ['Never promise refunds'] });
    expect(res.body.settings?.instructions).toMatchObject({
      tone: 'friendly', brand_voice: 'Playful but precise.', do_list: ['Be concise'], dont_list: ['Never promise refunds'],
    });
  });

  it("'' clears a text and [] clears a list; every other key stays", async () => {
    seed({ instructions: LEGACY });
    const res = await put({ instructions: { brand_voice: '', do_list: [] } });

    expect(res.status).toBe(200);
    expect(db.row.instructions).toEqual({ ...LEGACY, brand_voice: '', do_list: [] });
    expect(res.body.settings?.instructions).toMatchObject({ brand_voice: '', do_list: [], tone: 'friendly' });
    expect(res.body.settings?.has_custom_system_instruction).toBe(true);
  });

  it('two saves from two parts of the page both stick', async () => {
    expect((await put({ instructions: { tone: 'formal' } })).status).toBe(200);
    expect((await put({ instructions: { reply_language: 'workspace_default' } })).status).toBe(200);

    expect(db.row.instructions).toMatchObject({ tone: 'formal', reply_language: 'workspace_default', brand_voice: 'Playful but precise.' });
  });

  it('a client that sends the whole object gets what it sent, and the keys it never had stay', async () => {
    seed({ instructions: LEGACY });
    const whole = {
      tone: 'formal', max_answer_length: 'long', brand_voice: 'Bold.', do_list: ['Greet once'], dont_list: [],
      pricing_instructions: 'Quote the plan page.', support_instructions: '', handoff_instructions: 'Offer a callback.',
    };
    const res = await put({ instructions: whole });

    expect(res.status).toBe(200);
    expect(db.row.instructions).toEqual({ ...LEGACY, ...whole });
  });
});

describe('PUT /api/ai-agent/settings — the reply language', () => {
  it.each([['visitor'], ['workspace_default']])('accepts %s, stores it in instructions and returns it', async (value) => {
    const res = await put({ instructions: { reply_language: value } });

    expect(res.status).toBe(200);
    expect((db.row.instructions as Row).reply_language).toBe(value);
    expect(res.body.settings?.instructions?.reply_language).toBe(value);
  });

  it('is independent of allowed_locales: writing it leaves the allow-list alone', async () => {
    seed({ allowed_locales: ['fa', 'en'] });
    const res = await put({ instructions: { reply_language: 'workspace_default' } });

    expect(res.status).toBe(200);
    expect(Object.keys(db.updates[0])).toEqual(['instructions']);
    expect(db.row.allowed_locales).toEqual(['fa', 'en']);
    expect(res.body.settings?.allowed_locales).toEqual(['fa', 'en']);
  });

  it("reads 'visitor' when the row has none (today's behaviour)", async () => {
    const res = await call('GET', `/api/ai-agent/settings?workspaceId=${WS}`);

    expect(res.body.settings?.instructions?.reply_language).toBe('visitor');
  });

  it.each([['auto'], ['fa'], [''], [true]])('refuses reply_language = %j before writing anything', async (value) => {
    const res = await put({ instructions: { reply_language: value } });

    expect(res.status).toBe(400);
    expect(db.updates).toEqual([]);
  });
});

describe('PUT /api/ai-agent/settings — the handoff control', () => {
  it.each([['immediate'], ['assist_first'], ['adaptive']])('accepts handoff_policy %s, stores and returns it', async (policy) => {
    const res = await put({ handoff_policy: policy });

    expect(res.status).toBe(200);
    expect(db.row.handoff_policy).toBe(policy);
    expect(res.body.settings?.handoff_policy).toBe(policy);
  });

  it('picking a policy turns handoff_on_human_request on, so the control takes effect where the switch was off', async () => {
    seed({ handoff_on_human_request: false, handoff_policy: null });
    const res = await put({ handoff_policy: 'assist_first', max_assist_attempts: 1 });

    expect(res.status).toBe(200);
    expect(db.updates).toEqual([{ handoff_policy: 'assist_first', max_assist_attempts: 1, handoff_on_human_request: true }]);
    expect(res.body.settings).toMatchObject({ handoff_policy: 'assist_first', handoff_on_human_request: true, max_assist_attempts: 1 });
  });

  it('a write that sets the switch itself keeps it as written ("never hand over"), and the policy waits', async () => {
    const res = await put({ handoff_policy: 'adaptive', handoff_on_human_request: false });

    expect(res.status).toBe(200);
    expect(db.updates).toEqual([{ handoff_policy: 'adaptive', handoff_on_human_request: false }]);
    expect(res.body.settings).toMatchObject({ handoff_policy: 'adaptive', handoff_on_human_request: false });
  });

  it('null returns to the legacy rule and leaves the switch alone', async () => {
    seed({ handoff_policy: 'assist_first', handoff_on_human_request: false });
    const res = await put({ handoff_policy: null });

    expect(res.status).toBe(200);
    expect(db.updates).toEqual([{ handoff_policy: null }]);
    expect(res.body.settings).toMatchObject({ handoff_policy: null, handoff_on_human_request: false });
  });

  it('a legacy row reads handoff_policy null and one assist attempt', async () => {
    seed({ handoff_on_human_request: true });
    const res = await call('GET', `/api/ai-agent/settings?workspaceId=${WS}`);

    expect(res.body.settings).toMatchObject({ handoff_policy: null, max_assist_attempts: 1, handoff_on_human_request: true });
  });

  it('accepts max_assist_attempts at both ends of 0..3', async () => {
    expect((await put({ max_assist_attempts: 0 })).status).toBe(200);
    expect(db.row.max_assist_attempts).toBe(0);
    expect((await put({ max_assist_attempts: 3 })).status).toBe(200);
    expect(db.row.max_assist_attempts).toBe(3);
  });

  it.each([
    ['handoff_policy', 'never'],
    ['handoff_policy', ''],
    ['max_assist_attempts', 4],
    ['max_assist_attempts', -1],
    ['max_assist_attempts', 1.5],
    ['max_assist_attempts', '1'],
  ])('refuses %s = %j before writing anything', async (field, value) => {
    const res = await put({ [field]: value });

    expect(res.status).toBe(400);
    expect(db.updates).toEqual([]);
  });
});

describe('PUT /api/ai-agent/settings — learning', () => {
  it('accepts learning_enabled and auto_create_learning_candidates, stores and returns them', async () => {
    const res = await put({ learning_enabled: false, auto_create_learning_candidates: false });

    expect(res.status).toBe(200);
    expect(db.updates).toEqual([{ learning_enabled: false, auto_create_learning_candidates: false }]);
    expect(res.body.settings).toMatchObject({ learning_enabled: false, auto_create_learning_candidates: false });
  });

  it('reads both on for a row without them (the columns default to true)', async () => {
    const res = await call('GET', `/api/ai-agent/settings?workspaceId=${WS}`);

    expect(res.body.settings).toMatchObject({ learning_enabled: true, auto_create_learning_candidates: true });
  });

  it.each([
    ['learning_enabled', 'no'],
    ['auto_create_learning_candidates', 0],
    // No runtime consumer: not part of the page's contract.
    ['require_approval_for_learning', false],
  ])('refuses %s = %j before writing anything', async (field, value) => {
    const res = await put({ [field]: value });

    expect(res.status).toBe(400);
    expect(db.updates).toEqual([]);
  });
});

describe('the customer-safe settings carry everything the "Personality & behavior" page shows', () => {
  const FULL: Row = {
    enabled: true, mode: 'auto_reply_always', agent_name: 'Aria', business_description: 'We sell tea.',
    ai_intro_enabled: false,
    intro_message_localized: { fa: 'سلام' }, handoff_message_localized: { en: 'One moment.' },
    handoff_prechat_message_localized: { tr: 'Bir saniye.' },
    allowed_locales: ['fa', 'en'],
    allow_clarifying_questions: false, max_clarification_attempts: 2, allow_answer_with_caveat: false,
    escalation_style: 'helpful_first', handoff_policy: 'assist_first', max_assist_attempts: 2,
    handoff_on_human_request: true, handoff_on_low_confidence: true, handoff_when_no_kb_match: true,
    fallback_behavior: 'silent', fallback_message: 'A colleague will reply.', answer_only_from_kb: false,
    strict_topic_scope: true, answer_guidance: 'creative', stop_on_handoff: false,
    pause_auto_reply_after_human_reply: false, max_replies_per_conversation: 7, max_replies_per_hour: 40,
    confidence_threshold: 0.6, handoff_keywords: ['human'], learning_enabled: false,
    auto_create_learning_candidates: false,
    instructions: {
      tone: 'formal', max_answer_length: 'short', brand_voice: 'Warm.', do_list: ['Greet once'],
      dont_list: ['No slang'], pricing_instructions: 'P', support_instructions: 'S', handoff_instructions: 'H',
      reply_language: 'workspace_default', custom_system_instruction: SECRET,
    },
  };

  it('GET /settings returns each stored value, and no metadata or custom instruction text', async () => {
    seed(FULL);
    const res = await call('GET', `/api/ai-agent/settings?workspaceId=${WS}`);
    const s = res.body.settings as Row;

    expect(res.status).toBe(200);
    for (const [key, value] of Object.entries(FULL)) {
      if (key === 'instructions') continue;
      expect([key, s[key]]).toEqual([key, value]);
    }
    expect(s.instructions).toEqual({
      tone: 'formal', max_answer_length: 'short', brand_voice: 'Warm.', do_list: ['Greet once'],
      dont_list: ['No slang'], pricing_instructions: 'P', support_instructions: 'S', handoff_instructions: 'H',
      reply_language: 'workspace_default',
    });
    expect(s.has_custom_system_instruction).toBe(true);
    expect(s).toHaveProperty('avatar_display_url');
    expect(s).not.toHaveProperty('metadata');
    expect(res.text).not.toContain('sign off with');
    expect(res.text).not.toContain('never sent');
  });

  it('GET /overview carries the same fields', async () => {
    seed(FULL);
    const res = await call('GET', `/api/ai-agent/overview?workspaceId=${WS}`);

    expect(res.body.settings).toMatchObject({
      handoff_policy: 'assist_first', max_assist_attempts: 2, learning_enabled: false,
      auto_create_learning_candidates: false, instructions: { reply_language: 'workspace_default' },
    });
    expect(res.text).not.toContain('sign off with');
  });
});

describe('who may read and write, and which workspace (unchanged)', () => {
  it('a member reads but may not write', async () => {
    access.as = { userId: 'u2', isAdmin: false, role: 'member' };

    expect((await call('GET', `/api/ai-agent/settings?workspaceId=${WS}`)).status).toBe(200);
    const res = await put({ agent_name: 'Nova', instructions: { tone: 'formal' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_or_admin_required');
    expect(db.updates).toEqual([]);
  });

  it.each([
    ['an admin', { userId: 'u3', isAdmin: false, role: 'admin' }],
    ['a platform admin', { userId: 'u4', isAdmin: true, role: null }],
  ])('%s writes', async (_who, as) => {
    access.as = as;
    expect((await put({ agent_name: 'Nova' })).status).toBe(200);
    expect(db.row.agent_name).toBe('Nova');
  });

  it('someone outside the workspace neither reads nor writes', async () => {
    access.as = null;

    expect((await call('GET', `/api/ai-agent/settings?workspaceId=${WS}`)).status).toBe(403);
    expect((await put({ agent_name: 'Nova' })).status).toBe(403);
    expect(db.updates).toEqual([]);
  });

  it('every read and write is scoped to the workspace the request names', async () => {
    await put({ instructions: { tone: 'formal' }, agent_name: 'Nova' });
    await call('GET', `/api/ai-agent/settings?workspaceId=${WS}`);

    expect(access.asked).toEqual([WS, WS]);
    expect(db.scopes.length).toBeGreaterThan(0);
    for (const scope of db.scopes) expect(scope.workspace_id).toBe(WS);
    expect(db.scopes.filter((sc) => sc.write)).toHaveLength(1);
  });
});

describe('PUT /api/ai-agent/settings — a field shown over a legacy key clears it', () => {
  it('clearing the handoff instructions clears the legacy escalation text the prompt fell back to', async () => {
    seed({ instructions: { tone: 'friendly', escalation_instructions: 'Old: always offer a callback.' } });
    const res = await put({ instructions: { handoff_instructions: '' } });

    expect(res.status).toBe(200);
    expect(db.row.instructions).toEqual({ tone: 'friendly', handoff_instructions: '' });
    expect(res.text).not.toContain('Old: always offer a callback.');
  });

  it('removing the custom instruction also retires the legacy custom_instructions text', async () => {
    seed({ instructions: { tone: 'friendly', custom_system_instruction: SECRET, custom_instructions: 'Old operator text.' } });
    const res = await put({ instructions: { custom_system_instruction: '' } });

    expect(res.status).toBe(200);
    expect(db.row.instructions).toEqual({ tone: 'friendly', custom_system_instruction: '' });
    expect(res.body.settings?.has_custom_system_instruction).toBe(false);
  });
});
