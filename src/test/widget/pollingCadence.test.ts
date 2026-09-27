/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

type PollHandle = { pollNow: () => void; stop: () => void };
type ChatModule = { startPolling: (options: Record<string, unknown>) => PollHandle };

function chatModule(): ChatModule {
  // eslint-disable-next-line no-new-func
  new Function(readFileSync('public/widget/runtime-chat.js', 'utf8')).call(window);
  return (window as unknown as { __gs_mod_chat: ChatModule }).__gs_mod_chat;
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
  delete (window as unknown as { __gs_mod_chat?: ChatModule }).__gs_mod_chat;
});

describe('widget polling cadence', () => {
  it('backs off while closed/hidden, refreshes on open/foreground, and cleans up on stop', async () => {
    vi.useFakeTimers();
    let open = false;
    let hidden = false;
    const fetchWith = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [] }) }));
    const handle = chatModule().startPolling({
      apiBase: 'https://example.test',
      workspaceId: 'workspace',
      fetchWith,
      getInterval: () => hidden ? 60000 : open ? 4000 : 20000,
      getConversationId: () => null,
    });
    await vi.advanceTimersByTimeAsync(19999);
    expect(fetchWith).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchWith).toHaveBeenCalledTimes(1);

    open = true;
    handle.pollNow();
    handle.pollNow();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchWith).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchWith).toHaveBeenCalledTimes(3);

    hidden = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(59000);
    expect(fetchWith).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchWith).toHaveBeenCalledTimes(4);

    hidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchWith).toHaveBeenCalledTimes(5);
    handle.stop();
    await vi.advanceTimersByTimeAsync(120000);
    expect(fetchWith).toHaveBeenCalledTimes(5);
  });

  it('ignores a response that arrives after stop', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: { ok: boolean; json: () => Promise<{ messages: Array<{ id: string }> }> }) => void;
    const fetchWith = vi.fn(() => new Promise<{ ok: boolean; json: () => Promise<{ messages: Array<{ id: string }> }> }>((resolve) => {
      resolveFetch = resolve;
    }));
    const onMessages = vi.fn();
    const onTick = vi.fn();
    const handle = chatModule().startPolling({
      apiBase: 'https://example.test',
      workspaceId: 'workspace',
      fetchWith,
      getInterval: () => 4000,
      onMessages,
      onTick,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetchWith).toHaveBeenCalledTimes(1);
    handle.stop();
    resolveFetch({ ok: true, json: async () => ({ messages: [{ id: 'stale' }] }) });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20000);
    expect(onMessages).not.toHaveBeenCalled();
    expect(onTick).not.toHaveBeenCalled();
    expect(fetchWith).toHaveBeenCalledTimes(1);
  });
});
