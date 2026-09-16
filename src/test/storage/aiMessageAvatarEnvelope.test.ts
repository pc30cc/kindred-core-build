/**
 * A LIVE AI REPLY MUST CARRY ITS LOGO ON THE ENVELOPE.
 *
 * The widget draws an agent bubble's avatar from `sender_avatar`, and the
 * shipped runtime's ONLY fallback is `metadata.agent_logo_url` — a URL
 * snapshot frozen into the message row. That snapshot is exactly what the
 * key-only model removes: it names one storage provider and stops being true
 * the moment a new one is promoted, so `insertAiMessage` no longer writes it.
 *
 * Removing the snapshot without also putting the DERIVED link on the envelope
 * is what broke live AI replies: they arrived with no avatar at all and only
 * gained one when the visitor reloaded and /poll re-enriched them. These
 * tests pin both halves — nothing provider-shaped is persisted, and the
 * realtime envelope still carries a usable link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const CONV = '11111111-2222-4333-8444-555555555555';
const AGENT_KEY = `workspace/${WS}/avatars/ai-agent/bcc850cf-logo.jpg`;

const CDN = 'https://cdn.new-vendor.test';

/** The realtime envelope, as far as these tests read it. */
type Envelope = { payload: { sender_avatar: string | null; sender_name: string | null } };

const state: {
  agentSettings: Record<string, unknown> | null;
  inserted: Record<string, unknown> | null;
  published: Envelope[];
} = { agentSettings: null, inserted: null, published: [] };

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> & { single: () => Promise<unknown> } = {
        select: () => builder,
        eq: () => builder,
        insert: (values: Record<string, unknown>) => {
          state.inserted = values;
          return builder;
        },
        update: () => builder,
        single: async () => ({
          data: table === 'conversation_messages'
            ? { id: 'msg-1', conversation_id: CONV, sender_type: 'ai', body: 'hi', created_at: '2026-01-01T00:00:00Z', metadata: state.inserted?.metadata }
            : state.agentSettings,
          error: null,
        }),
        maybeSingle: async () => builder.single(),
        then: (onOk: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onOk),
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

// The real derivation is under test; only the provider lookup is stubbed.
vi.mock('../../../server/services/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/storage/index.js')>();
  return {
    ...actual,
    resolveStorageConfig: async () => ({ provider: 'bunny_storage', cdnUrl: CDN }),
    resolveGlobalStorageConfig: async () => ({ provider: 'bunny_storage', cdnUrl: CDN }),
  };
});

vi.mock('../../../server/services/realtime/publish.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/realtime/publish.js')>();
  return {
    ...actual,
    publishConversationEvent: async (_c: unknown, _w: string, _conv: string, envelope: Envelope) => {
      state.published.push(envelope);
      return { ok: true };
    },
  };
});

vi.mock('../../../server/services/channels/outbound.js', () => ({
  ensureOutboundIntent: async () => ({ ok: true }),
}));
vi.mock('../../../server/services/channels/telegram/offlineDelivery.js', () => ({
  maybeQueueTelegramOfflineScreen: async () => false,
}));

const { insertAiMessage } = await import('../../../server/services/ai-agent/responder.js');

const config = {} as never;

beforeEach(() => {
  state.agentSettings = {
    workspace_id: WS,
    agent_logo_url: null,
    metadata: { ai_avatar_storage_key: AGENT_KEY },
  };
  state.inserted = null;
  state.published = [];
});

async function send(overrides: Record<string, unknown> = {}) {
  return insertAiMessage(config, {
    workspaceId: WS,
    conversationId: CONV,
    body: 'hi',
    source: 'ai_agent',
    agentName: 'Aria',
    ...overrides,
  } as never);
}

describe('insertAiMessage', () => {
  it('publishes a realtime envelope carrying the DERIVED agent logo', async () => {
    await send();

    expect(state.published).toHaveLength(1);
    expect(state.published[0].payload.sender_avatar).toBe(`${CDN}/${AGENT_KEY}`);
    expect(state.published[0].payload.sender_name).toBe('Aria');
  });

  it('never snapshots a provider URL into the message row', async () => {
    await send();

    const metadata = state.inserted?.metadata as Record<string, unknown>;
    expect(metadata).toBeTruthy();
    expect('agent_logo_url' in metadata).toBe(false);
    expect(JSON.stringify(state.inserted)).not.toContain('http');
  });

  it('follows a provider promotion without touching the message row', async () => {
    await send();
    const first = state.published[0].payload.sender_avatar;

    // The whole point: the link comes from the key, so a new primary changes
    // it on the next publish with nothing rewritten.
    const storage = await import('../../../server/services/storage/index.js');
    vi.spyOn(storage, 'resolveStorageConfig').mockResolvedValue(
      { provider: 'bunny_storage', cdnUrl: 'https://cdn.other-vendor.test' } as never,
    );

    state.published = [];
    await send();

    expect(first).toBe(`${CDN}/${AGENT_KEY}`);
    expect(state.published[0].payload.sender_avatar)
      .toBe(`https://cdn.other-vendor.test/${AGENT_KEY}`);
    vi.restoreAllMocks();
  });

  it('sends no avatar rather than a stale one when the agent has no stored logo', async () => {
    state.agentSettings = { workspace_id: WS, agent_logo_url: null, metadata: {} };

    await send();

    expect(state.published[0].payload.sender_avatar).toBeNull();
  });

  it('still falls back to an operator-typed legacy logo while one exists', async () => {
    // `agent_logo_url` is cleared by the upload route, so a value here can
    // only be a legacy/operator-typed one. Deprecated, but not dropped
    // mid-rollout.
    state.agentSettings = {
      workspace_id: WS,
      agent_logo_url: 'https://legacy-vendor.example/logo.png',
      metadata: {},
    };

    await send();

    expect(state.published[0].payload.sender_avatar).toBe('https://legacy-vendor.example/logo.png');
  });
});
