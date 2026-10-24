/**
 * One current conversation per visitor, over the wire: the SHIPPED
 * runtime-chat.js (not the harness's fake chat module) between Core and the
 * fake API, so what Core relies on is what the module really sends and
 * hands back (server: POST /message, GET /poll in
 * server/routes/widget.ts):
 *  - POST /message carries `ai_intro` ({ locale }) for the greeting drawn
 *    from the intro preview; its `intro_message` and `continued` reach Core
 *    (onAccepted);
 *  - GET /poll's `status` reaches Core with its conversation id
 *    (onConversation), so a fresh thread takes a live one only.
 * The poll test is last: its loop keeps polling after it.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, flush, key, resetWindow, typeInto, type ApiAnswer, type Harness } from './coreFeaturesHarness';

type Row = Record<string, unknown>;

beforeEach(() => {
  vi.useRealTimers();
  resetWindow();
  try { localStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { vi.restoreAllMocks(); });

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const AI = { aiAgent: { visitorFacing: true, providerReady: true, introCapable: true, introEnabled: true, suppressGreeting: true } };
const GREETING = 'سلام! من نیلو هستم. چطور کمکتان کنم؟';
const cid = (h: Harness) => h.runtime.__test.chatState().conversationId as string | null;
const msgs = (h: Harness) => h.runtime.__test.chatState().messages as Row[];
const messagePosts = (h: Harness) => h.posts.filter((p) => p.url.endsWith('/api/widget/message')).map((p) => p.body);
async function writeFirst(h: Harness, text: string) {
  h.runtime.__test.setConnectionState('online');
  h.runtime.setTab('chat');
  await flush(20);
  expect(msgs(h).some((m) => m.introLocal)).toBe(true);
  const input = h.q<HTMLTextAreaElement>('[data-msg-input]')!;
  typeInto(input, text);
  key(input, 'Enter');
  await flush(30);
}

describe('Core with the shipped runtime-chat.js', () => {
  it('POST /message carries ai_intro; its intro_message takes the local greeting\'s place', async () => {
    const h = boot({
      renderer: 't1',
      chat: 'real',
      realtime: true,
      config: AI,
      conversations: [],
      api: (url): ApiAnswer | undefined => {
        if (url.includes('/ai-agent/intro')) return { body: { sent: true, preview: true, body: GREETING, conversationId: null, messageId: null } };
        if (url.endsWith('/api/widget/message')) {
          return {
            body: {
              ok: true, conversation_id: 'c-new', message_id: 'm-v',
              intro_message: { id: 'srv-intro', role: 'agent', sender_type: 'ai', text: GREETING, time: ago(0), conversation_id: 'c-new', metadata: { source: 'ai_agent_intro' } },
            },
          };
        }
        return undefined;
      },
    });
    await flush(40);
    await writeFirst(h, 'سفارشم کجاست؟');
    expect(messagePosts(h)).toHaveLength(1);
    expect(messagePosts(h)[0]).toMatchObject({ ai_intro: { locale: 'fa' }, force_new_conversation: true, message: 'سفارشم کجاست؟' });
    expect(cid(h)).toBe('c-new');
    const greetings = msgs(h).filter((m) => (m.metadata as Row | null)?.source === 'ai_agent_intro');
    expect(greetings).toHaveLength(1);
    expect(greetings[0]).toMatchObject({ __id: 'srv-intro', introLocal: false });
    expect(msgs(h).find((m) => m.sender === 'visitor')).toMatchObject({ __id: 'm-v', status: 'sent' });
  });

  it('continued: the module hands it to Core, which loads that conversation\'s history in its order', async () => {
    const h = boot({
      renderer: 't1',
      chat: 'real',
      realtime: true,
      config: AI,
      conversations: [],
      api: (url): ApiAnswer | undefined => {
        if (url.includes('/ai-agent/intro')) return { body: { sent: true, preview: true, body: GREETING, conversationId: null, messageId: null } };
        if (url.endsWith('/api/widget/message')) return { body: { ok: true, conversation_id: 'c-live', message_id: 'm-v', continued: true } };
        if (url.includes('/api/widget/history') && url.includes('conversation_id=c-live')) {
          return {
            body: {
              messages: [
                { id: 'x1', role: 'visitor', sender_type: 'contact', text: 'سؤال قبلی', time: ago(30), conversation_id: 'c-live' },
                { id: 'x2', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'پاسخ قبلی', time: ago(29), conversation_id: 'c-live' },
              ],
            },
          };
        }
        return undefined;
      },
    });
    await flush(40);
    await writeFirst(h, 'سؤال تازه');
    expect(cid(h)).toBe('c-live');
    expect(h.fetches.some((u) => u.includes('/api/widget/history') && u.includes('conversation_id=c-live'))).toBe(true);
    expect(msgs(h).some((m) => m.introLocal)).toBe(false);
    expect(msgs(h).map((m) => m.__id)).toEqual(['x1', 'x2', 'm-v']);
  });

  it('GET /poll: its status reaches Core, so a fresh thread takes a live conversation and never a closed one', async () => {
    let poll: Row = { conversation_id: 'c-closed', status: 'closed', messages: [] };
    const h = boot({
      renderer: 't1',
      chat: 'real',
      open: false,
      conversations: [],
      api: (url): ApiAnswer | undefined => {
        if (url.includes('/api/widget/poll')) return { body: poll };
        if (url.includes('/api/widget/history') && url.includes('conversation_id=c-out')) {
          return { body: { messages: [{ id: 'o1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام! کمکی لازم دارید؟', time: ago(1), conversation_id: 'c-out' }] } };
        }
        return undefined;
      },
    });
    await flush(40);
    const polls = () => h.fetches.filter((u) => u.includes('/api/widget/poll'));
    // Opening the panel polls at once (pollNow), without a conversation id (a fresh thread).
    h.runtime.open();
    await flush(20);
    expect(polls().length).toBeGreaterThan(0);
    expect(polls()[0]).not.toContain('conversation_id=');
    expect(cid(h)).toBeNull();
    expect(h.runtime.__test.chatState().freshIntent).toBe(true);

    poll = { conversation_id: 'c-out', status: 'open', messages: [] };
    h.runtime.close();
    h.runtime.open();
    await flush(20);
    expect(cid(h)).toBe('c-out');
    expect(msgs(h).map((m) => m.__id)).toEqual(['o1']);
  });
});
