/**
 * An AI reply keeps its AI badge (the sparkle, read as the word for the AI)
 * and its time when a system line follows it, in every template, and the
 * AI's built-in name ('AI Assistant', English in every widget language) is
 * no name for the visitor.
 *
 * The server sends that name as it is stored (realtime, /poll, /history,
 * the intro, /config `aiAgent.agentName`): a runtime.js loaded before this
 * release labels the AI's replies with it, and `default` groups bubbles
 * into runs by name and photo (presentation-default.js, byte-identical), so
 * a nameless AI reply there shares the key of the system line under it: the
 * owner's sequence (AI: "I'll connect you", then the queue notice) lost the
 * AI bubble's badge and time. Core now treats the built-in name as no name
 * and names such a reply with the widget's own word for the AI in the
 * visitor's language for `default` (and its intl skin), which keeps its runs
 * apart; the renderer prints no such stand-in beside the sparkle, which
 * already says it (owner, 2026-10-23: the icon instead of the text). t1 and
 * t2 end a run at every system line and draw the badge alone, as before;
 * t1's AI avatar is then the workspace's tile, not a Latin "A".
 *
 * The SHIPPED runtime.js and the real renderers (coreFeaturesHarness.ts).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, flush, resetWindow } from './coreFeaturesHarness';
import { DEFAULT_AI_AGENT_NAME } from '../../../shared/systemMessages';

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

const NOW = new Date().toISOString();
const BUILT_IN = DEFAULT_AI_AGENT_NAME;

/** The owner's sequence: the AI hand-over (its name as the server sent it), then the queue notice. */
function history(aiName: string | null) {
  return [
    { id: 'v1', role: 'visitor', sender_type: 'contact', text: 'سلام', time: NOW, conversation_id: 'c1' },
    {
      id: 'a1', role: 'agent', sender_type: 'ai', text: 'شما را به همکارم وصل می‌کنم.', time: NOW, conversation_id: 'c1',
      sender_name: aiName, sender_avatar: null, metadata: aiName ? { source: 'ai_agent', agent_name: aiName } : {},
    },
    { id: 's1', role: 'system', sender_type: 'system', text: 'Your message is in the support queue.', time: NOW, conversation_id: 'c1', metadata: { kind: 'routing_in_queue' } },
  ];
}

async function thread(renderer: 'default' | 't1' | 't2', aiName: string | null, locale: 'fa' | 'tr' = 'fa', config: Record<string, unknown> = {}) {
  const h = boot({ renderer, config: { locale, ...config }, conversations: [{ id: 'c1' }], history: { c1: history(aiName) } });
  await flush(20);
  h.runtime.__test.openConversation('c1');
  await vi.waitFor(() => expect((h.runtime.__test.chatState().messages as unknown[]).length).toBe(3));
  await vi.waitFor(() => expect(h.panel.querySelector('.msg-ai-badge')).not.toBeNull());
  return h;
}

const senderOf = (h: { panel: HTMLElement }) =>
  h.panel.querySelector('.msg-ai-badge')?.closest('.msg-meta')?.querySelector('.msg-sender')?.textContent;

/** The name Core gave the AI reply (the thread's second message). */
const standInOf = (h: Awaited<ReturnType<typeof thread>>) =>
  (h.runtime.__test.chatState().messages as Array<{ senderName?: string | null }>)[1]?.senderName;

/** The AI badge: the sparkle alone, read (and, in `default`, titled) in the visitor's words. */
function expectSparkle(badge: Element, label: string, title: string | null) {
  expect(badge.getAttribute('role')).toBe('img');
  expect(badge.getAttribute('aria-label')).toBe(label);
  expect(badge.getAttribute('title')).toBe(title);
  expect(badge.textContent).toBe('');
  expect(badge.querySelectorAll('svg')).toHaveLength(1);
  expect(badge.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
}

describe('a nameless AI reply followed by a system line', () => {
  for (const name of [null, BUILT_IN]) {
    it(`default (name ${JSON.stringify(name)}): keeps its badge and time, and prints no stand-in name beside the sparkle`, async () => {
      const h = await thread('default', name);
      const badges = h.panel.querySelectorAll('.msg-ai-badge');
      expect(badges).toHaveLength(1);
      expectSparkle(badges[0], 'هوش مصنوعی', 'دستیار هوش مصنوعی');
      const meta = badges[0].closest('.msg-meta')!;
      expect(meta.querySelector('.msg-time')).not.toBeNull();
      expect(meta.querySelector('.msg-sender')).toBeNull();
      expect(meta.textContent).not.toContain('هوش مصنوعی');
      expect(h.panel.textContent).not.toContain(BUILT_IN);
      // Core still names the reply with its stand-in: that keeps its run apart from the line under it.
      expect(standInOf(h)).toBe('دستیار هوش مصنوعی');
    });

    it(`default, Turkish (name ${JSON.stringify(name)}): the Turkish words, on the badge only`, async () => {
      const h = await thread('default', name, 'tr');
      expectSparkle(h.panel.querySelector('.msg-ai-badge')!, 'YZ', 'Yapay zekâ asistanı');
      expect(senderOf(h)).toBeUndefined();
      expect(h.panel.textContent).not.toContain('Yapay zekâ asistanı');
      expect(h.panel.textContent).not.toContain(BUILT_IN);
      expect(standInOf(h)).toBe('Yapay zekâ asistanı');
    });
  }

  it('default: a name the owner gave the agent stays as written, between the sparkle and the time', async () => {
    const h = await thread('default', 'نیلو');
    const badge = h.panel.querySelector('.msg-ai-badge')!;
    expectSparkle(badge, 'هوش مصنوعی', 'دستیار هوش مصنوعی');
    expect(senderOf(h)).toBe('نیلو');
    expect(badge.nextElementSibling!.className).toBe('msg-sender');
    expect(badge.nextElementSibling!.nextElementSibling!.className).toBe('msg-time');
  });

  for (const renderer of ['t1', 't2'] as const) {
    for (const name of [null, BUILT_IN]) {
      it(`${renderer} (name ${JSON.stringify(name)}): the badge alone, as before (its runs end at the system line)`, async () => {
        const h = await thread(renderer, name);
        const badges = h.panel.querySelectorAll('.msg-ai-badge');
        expect(badges).toHaveLength(1);
        expectSparkle(badges[0], 'هوش مصنوعی', null);
        expect(badges[0].closest('.msg-meta')?.querySelector('.msg-sender')).toBeNull();
        expect(h.panel.textContent).not.toContain(BUILT_IN);
      });
    }
  }

  it('t1: /config\'s built-in agent name draws the workspace\'s tile beside the AI, not its "A"', async () => {
    const h = await thread('t1', BUILT_IN, 'fa', {
      aiAgent: { visitorFacing: false, providerReady: false, introCapable: false, agentName: BUILT_IN },
    });
    const avatar = h.panel.querySelector('.msg-row.operator .msg-avatar:not(.msg-avatar-spacer)')!;
    expect(avatar).not.toBeNull();
    expect(avatar.textContent).toBe('ف');
  });
});

describe('the built-in name off the thread: a live reply, its toast and the intro', () => {
  it('a live AI reply under the built-in name toasts and joins the thread without it', async () => {
    const h = boot({ renderer: 'default', realtime: true, open: false, conversations: [{ id: 'c1' }], history: { c1: [] } });
    await flush(20);
    h.runtime.__test.openConversation('c1');
    await flush(10);
    h.runtime.close();
    await flush(5);
    h.emitMessages([{
      id: 'a9', role: 'agent', sender_type: 'ai', text: 'سلام! چطور کمکتان کنم؟', time: NOW, conversation_id: 'c1',
      sender_name: BUILT_IN, sender_avatar: null, metadata: { source: 'ai_agent', agent_name: BUILT_IN },
    }]);
    await vi.waitFor(() => expect(h.shadow.querySelector('.gs-toast')?.textContent).toContain('سلام! چطور کمکتان کنم؟'));
    expect(h.shadow.querySelector('.gs-toast')?.textContent).not.toContain(BUILT_IN);
    const merged = (h.runtime.__test.chatState().messages as Array<{ senderName?: string | null }>)[0];
    expect(merged?.senderName).toBe('دستیار هوش مصنوعی');
  });

  for (const renderer of ['default', 't2'] as const) {
    it(`${renderer}: the intro's built-in agentName is no name`, async () => {
      const h = boot({
        renderer,
        // The AI owns the chat (suppressGreeting), so opening it asks for the intro.
        config: { aiAgent: { visitorFacing: true, providerReady: true, introCapable: true, suppressGreeting: true, agentName: BUILT_IN } },
        api: (u) => (u.includes('/api/widget/ai-agent/intro')
          ? { body: { sent: true, messageId: 'm-intro', conversationId: 'c-intro', body: 'سلام! من یک دستیار هوش مصنوعی هستم.', agentName: BUILT_IN } }
          : undefined),
      });
      await flush(20);
      h.runtime.setTab('chat');
      await vi.waitFor(() => expect(h.panel.querySelector('.msg-ai-badge')).not.toBeNull());
      expect(h.fetches.some((u) => u.includes('/api/widget/ai-agent/intro'))).toBe(true);
      expect(h.panel.textContent).not.toContain(BUILT_IN);
      const intro = (h.runtime.__test.chatState().messages as Array<{ senderName?: string | null }>)[0];
      expect(intro?.senderName ?? null).toBe(renderer === 'default' ? 'دستیار هوش مصنوعی' : null);
    });
  }
});
