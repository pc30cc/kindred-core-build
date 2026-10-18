/**
 * The visible typing row names who is typing (issue #340, g4 f4): an
 * operator's typing event carries their public `name` and `avatar`, and
 * t1/t2 (feature `operatorTyping`) draw that person instead of guessing (the
 * assigned operator, else the first team member online). Without a name the
 * guess stays; a typing event that came before runtime-ext.js keeps its
 * name; the visitor's own echo is never drawn. (`default`:
 * operatorTypingIdentityInert.test.ts.)
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, flush, resetWindow } from './coreFeaturesHarness';

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

const MSG = { id: 'm1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: new Date().toISOString(), conversation_id: 'c1' };
async function thread(renderer: 't1' | 't2', ext: 'load' | 'tick' = 'load') {
  const h = boot({
    renderer, realtime: true, ext,
    conversations: [{ id: 'c1', operatorName: 'سارا', operatorOnline: true }],
    history: { c1: [MSG] },
    assignedOperator: { name: 'سارا', avatar: null, online: true },
  });
  await flush(20);
  h.runtime.__test.openConversation('c1');
  await flush(30);
  return h;
}
const typingVm = (h: ReturnType<typeof boot>) => (h.lastCall('messagesHtml')![2] as { operatorTyping?: { name: string; avatar: string | null } }).operatorTyping;

describe('the typing row names who types', () => {
  for (const renderer of ['t1', 't2'] as const) {
    it(`${renderer}: the event's name and photo, not the assigned operator`, async () => {
      const h = await thread(renderer);
      h.emitTyping({ actor: 'agent', conversation_id: 'c1', ts: 1, name: '  مهدی  ', avatar: 'https://cdn.test/m.png' });
      await flush(10);
      expect(typingVm(h)).toEqual({ name: 'مهدی', avatar: 'https://cdn.test/m.png' });
      expect(h.q('.typing-row')).not.toBeNull();
    });
  }

  it('t1 says the name in the row\'s line', async () => {
    const h = await thread('t1');
    h.emitTyping({ actor: 'agent', name: 'مهدی' });
    await flush(10);
    expect(h.q('.typing-row .msg-meta')!.textContent).toBe('مهدی در حال نوشتن…');
  });

  it('without a name (an older server) the assigned operator, as before; a long name is cut', async () => {
    const h = await thread('t1');
    h.emitTyping({ actor: 'agent' });
    await flush(10);
    expect(typingVm(h)!.name).toBe('سارا');
    h.emitTyping({ actor: 'agent', name: '   ' });
    await flush(10);
    expect(typingVm(h)!.name).toBe('سارا');
    h.emitTyping({ actor: 'agent', name: 'x'.repeat(200), avatar: 12 });
    await flush(10);
    expect(typingVm(h)).toEqual({ name: 'x'.repeat(80), avatar: null });
  });

  it('the visitor\'s own echo is never drawn', async () => {
    const h = await thread('t2');
    h.emitTyping({ actor: 'visitor', name: 'من' });
    await flush(10);
    expect(typingVm(h)).toBeFalsy();
  });

  it('a typing event that came before runtime-ext.js keeps its name', async () => {
    const h = boot({ renderer: 't1', realtime: true, ext: 'hold', conversations: [{ id: 'c1' }], history: { c1: [MSG] } });
    await flush(20);
    h.emitTyping({ actor: 'agent', name: 'رضا' });
    h.releaseExt();
    await flush(20);
    h.runtime.__test.openConversation('c1');
    await flush(30);
    expect(typingVm(h)!.name).toBe('رضا');
  });
});
