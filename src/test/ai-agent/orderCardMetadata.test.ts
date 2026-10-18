/**
 * insertAiMessage and the order card: with a card the AI row's metadata gains
 * exactly `kind: 'order_status'` and `order`, and the realtime envelope the
 * widget receives carries them; without one the metadata is exactly what it
 * was before the card existed (pinned key for key), and the body, channels
 * and inbox preview see only the text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerConfig } from '../../../server/config.js';

type Loose = Record<string, unknown>;
const inserts: Loose[] = [];
const published: Loose[] = [];
const outbound: Loose[] = [];

function fakeClient() {
  return {
    from: (table: string) => {
      if (table === 'conversation_messages') {
        return {
          insert: (payload: Loose) => {
            inserts.push(payload);
            const row = { id: `m-${inserts.length}`, created_at: '2026-10-18T10:00:00Z', seen_at: null, ...payload };
            const chain = { select: () => chain, single: async () => ({ data: row, error: null }) };
            return chain;
          },
        };
      }
      const chain: Loose = {};
      chain.update = () => chain;
      chain.eq = async () => ({ data: null, error: null });
      return chain;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/realtime/publish.js')>();
  return {
    ...real,
    publishConversationEvent: async (_c: unknown, _w: string, _id: string, envelope: Loose) => { published.push(envelope); },
  };
});
vi.mock('../../../server/services/channels/outbound.js', () => ({
  ensureOutboundIntent: async (_c: unknown, input: Loose) => { outbound.push(input); },
}));
vi.mock('../../../server/services/channels/telegram/offlineDelivery.js', () => ({ maybeQueueTelegramOfflineScreen: async () => false }));
vi.mock('../../../server/services/ai-agent/settings.js', () => ({ resolveWorkspaceAgentLogoUrl: async () => null }));

const { insertAiMessage } = await import('../../../server/services/ai-agent/responder.js');
const { systemMessageText } = await import('../../../src/lib/systemMessageText.js');

const CONFIG = {} as ServerConfig;
const CARD = {
  v: 1 as const, number: '48213', summary: 'کفش رانینگ', more: 1, status: 'shipped' as const, statusLabel: null, step: 2 as const,
  arrives: '2026-10-23', trackingUrl: 'https://tracking.post.ir/?id=RR1',
};
const BASE = {
  workspaceId: 'ws-1', conversationId: 'conv-1', body: 'سفارش ۴۸۲۱۳ ارسال شده است.', source: 'ai_agent' as const,
  runId: 'run-1', mode: 'auto_reply_always', kbArticleIds: [], qnaIds: [], confidence: 0.8, provider: 'openai', model: 'gpt',
  handoff: false, agentName: 'Nova', agentLogoUrl: null, decisionType: 'answer',
};

/** The AI row's metadata keys as they were before the order card (pinned). */
const TODAY_KEYS = ['source', 'run_id', 'mode', 'kb_article_ids', 'qna_ids', 'confidence', 'provider', 'model', 'handoff', 'agent_name', 'decision_type', 'answer_strategy'];

beforeEach(() => { inserts.length = 0; published.length = 0; outbound.length = 0; });

describe('the AI row’s metadata', () => {
  it('without a card: exactly today’s keys, in today’s order', async () => {
    await insertAiMessage(CONFIG, BASE);
    await insertAiMessage(CONFIG, { ...BASE, orderCard: null });
    for (const row of inserts) {
      expect(Object.keys(row.metadata as Loose)).toEqual(TODAY_KEYS);
      expect(row.metadata).not.toHaveProperty('kind');
    }
    expect(inserts[0]).toEqual(inserts[1]);
  });

  it('with a card: kind and order added, nothing else changes', async () => {
    await insertAiMessage(CONFIG, BASE);
    await insertAiMessage(CONFIG, { ...BASE, orderCard: CARD });
    const [plain, carded] = inserts as Array<{ body: string; sender_type: string; metadata: Loose }>;
    expect(Object.keys(carded.metadata)).toEqual([...TODAY_KEYS, 'kind', 'order']);
    expect(carded.metadata.kind).toBe('order_status');
    expect(carded.metadata.order).toEqual(CARD);
    const { kind: _k, order: _o, ...rest } = carded.metadata;
    expect(rest).toEqual(plain.metadata);
    expect(carded.body).toBe(plain.body);
    expect(carded.sender_type).toBe('ai');
  });

  it('the realtime envelope carries the card whole; the visitor copy too', async () => {
    const { visitorMessagePayload } = await import('../../../server/services/realtime/publish.js');
    await insertAiMessage(CONFIG, { ...BASE, orderCard: CARD });
    const payload = (published[0] as { payload: Loose }).payload;
    expect(payload.text).toBe(BASE.body);
    expect((payload.metadata as Loose).order).toEqual(CARD);
    expect((visitorMessagePayload(payload).metadata as Loose).order).toEqual(CARD);
  });

  it('channels get the text only', async () => {
    await insertAiMessage(CONFIG, { ...BASE, orderCard: CARD });
    expect(outbound[0]).toEqual({ workspaceId: 'ws-1', conversationId: 'conv-1', messageId: 'm-1', body: BASE.body });
  });

  it('the inbox list preview falls back to the body (no sentence for this kind)', () => {
    expect(systemMessageText({ kind: 'order_status' }, (k: string) => k)).toBeNull();
  });
});
