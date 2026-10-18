/**
 * The operator's typing event now carries their public `name` and `avatar`
 * (POST /api/conversations/typing, g4 f4). `default` reads no field of an
 * operator typing event: with the live template mounted, a typing event
 * with a name and an avatar leaves the widget exactly as one without them.
 * (The inbox's side: src/test/inbox/operatorTypingPayload.test.ts.)
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, flush, resetWindow, win } from './coreFeaturesHarness';

beforeEach(() => { vi.useRealTimers(); resetWindow(); });
afterEach(() => { vi.restoreAllMocks(); });

type Hooks = { onTyping: (e: unknown) => void };

/** Boots default with a realtime driver, opens a thread, sends one typing event, returns what shows. */
async function afterTyping(payload: Record<string, unknown>) {
  resetWindow();
  const h = boot({
    renderer: 'default',
    realtime: true,
    conversations: [{ id: 'c1' }],
    history: { c1: [{ id: 'm1', role: 'agent', sender_type: 'agent', sender_name: 'سارا', text: 'سلام', time: '2026-10-18T09:00:00.000Z' }] },
  });
  // The driver is created once the realtime negotiation answers: wrap it to reach its hooks.
  const mod = win.__gs_mod_rt_centrifugo as { create: (ctx: unknown, resolved: unknown, hooks: Hooks) => unknown };
  const create = mod.create;
  let hooks: Hooks | null = null;
  mod.create = (ctx, resolved, hk) => { hooks = hk; return create(ctx, resolved, hk); };
  await flush();
  h.runtime.__test.openConversation('c1');
  await flush(20);
  // The first real paint after a skeleton keeps the one-shot `wy-crossfade`
  // marker for 200 ms (runtime.js): let it go, so both runs compare the
  // settled thread however slow the machine is.
  await new Promise((r) => setTimeout(r, 250));
  expect(hooks).not.toBeNull();
  const before = h.panel.innerHTML;
  hooks!.onTyping({ payload });
  await flush();
  return { before, after: h.panel.innerHTML, calls: h.calls.map((c) => c.surface) };
}

describe('default ignores the typing event\'s name and avatar', () => {
  it('a typing event with name and avatar shows exactly what one without them shows', async () => {
    const plain = await afterTyping({ actor: 'agent', conversation_id: 'c1', ts: 1 });
    const named = await afterTyping({
      actor: 'agent', conversation_id: 'c1', ts: 1,
      name: '<img src=x onerror=alert(1)> مهدی', avatar: 'javascript:alert(1)',
    });
    expect(named.after).toBe(plain.after);
    expect(named.calls).toEqual(plain.calls);
    expect(named.after).not.toContain('مهدی');
    expect(named.after).not.toContain('javascript:');
  });
});
