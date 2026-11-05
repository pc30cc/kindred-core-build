/**
 * One missed-call toast per call across a member's panel tabs
 * (src/features/teamCalls/missedCallOnce.ts, docs/operations/TEAM_CALLS.md
 * "Web panel"): the tabs claim the call over a BroadcastChannel keyed by
 * call id and exactly one shows it; without BroadcastChannel each tab shows
 * its own, as before.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createMissedCallOnce, MISSED_CALL_CLAIM_WINDOW_MS } = await import('@/features/teamCalls/missedCallOnce');

/** A BroadcastChannel between the "tabs" of one test: async, never to the sender, as the browser's. */
function fakeBus() {
  const open = new Set<FakeChannel>();
  class FakeChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(readonly name: string) { open.add(this); }
    postMessage(data: unknown) {
      for (const other of open) {
        if (other !== this && other.name === this.name) {
          queueMicrotask(() => other.onmessage?.({ data } as MessageEvent));
        }
      }
    }
    close() { open.delete(this); }
  }
  return FakeChannel;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('missed-call toast once across tabs', () => {
  it('two tabs hearing the same missed call at once: exactly one shows it', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const a = createMissedCallOnce('team-call-missed:me', { Channel });
    const b = createMissedCallOnce('team-call-missed:me', { Channel });
    a.tell('c1', () => shown.push('a'));
    b.tell('c1', () => shown.push('b'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS + 10);
    expect(shown).toHaveLength(1);
    a.close();
    b.close();
  });

  it('a tab that comes to the call after another showed it stays quiet; the same tab never shows it twice', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const a = createMissedCallOnce('team-call-missed:me', { Channel });
    const b = createMissedCallOnce('team-call-missed:me', { Channel });
    a.tell('c1', () => shown.push('a'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS + 10);
    expect(shown).toEqual(['a']);
    b.tell('c1', () => shown.push('b'));
    a.tell('c1', () => shown.push('a again'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS + 10);
    expect(shown).toEqual(['a']);
    a.close();
    b.close();
  });

  it('keyed by call id: another call is told on its own', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const a = createMissedCallOnce('team-call-missed:me', { Channel });
    const b = createMissedCallOnce('team-call-missed:me', { Channel });
    a.tell('c1', () => shown.push('c1'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS + 10);
    b.tell('c2', () => shown.push('c2'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS + 10);
    expect(shown).toEqual(['c1', 'c2']);
    a.close();
    b.close();
  });

  it('another member\'s tabs (another channel) do not hide this member\'s toast', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const mine = createMissedCallOnce('team-call-missed:me', { Channel });
    const theirs = createMissedCallOnce('team-call-missed:them', { Channel });
    theirs.tell('c1', () => shown.push('them'));
    mine.tell('c1', () => shown.push('me'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS + 10);
    expect(shown.sort()).toEqual(['me', 'them']);
    mine.close();
    theirs.close();
  });

  it('without BroadcastChannel each tab shows its own, at once', () => {
    const shown: string[] = [];
    const a = createMissedCallOnce('team-call-missed:me', { Channel: null });
    const b = createMissedCallOnce('team-call-missed:me', { Channel: null });
    a.tell('c1', () => shown.push('a'));
    b.tell('c1', () => shown.push('b'));
    expect(shown).toEqual(['a', 'b']);
  });

  it('a BroadcastChannel that cannot be opened falls back to per tab', () => {
    const shown: string[] = [];
    class Broken { constructor() { throw new Error('SecurityError'); } }
    const a = createMissedCallOnce('team-call-missed:me', { Channel: Broken as never });
    a.tell('c1', () => shown.push('a'));
    expect(shown).toEqual(['a']);
  });
});
