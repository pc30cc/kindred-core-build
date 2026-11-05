/**
 * One missed-call toast per call across a member's panel tabs
 * (src/features/teamCalls/missedCallOnce.ts, docs/operations/TEAM_CALLS.md
 * "Web panel"): the tabs claim the call over a BroadcastChannel keyed by
 * call id and exactly one shows it, a visible one (a hidden tab's toast
 * would close unseen); without BroadcastChannel each tab shows its own, as
 * before.
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

/** One tab's visibility, set by the test. */
function tabVisibility(visible = true) {
  const listeners = new Set<() => void>();
  return {
    state: { visible },
    visible() { return this.state.visible; },
    onChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: boolean) { this.state.visible = next; for (const l of listeners) l(); },
  };
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

  it('a visible tab and a hidden one, the hidden one claiming first: the visible tab shows it', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const hiddenTab = tabVisibility(false);
    const visibleTab = tabVisibility(true);
    const hidden = createMissedCallOnce('team-call-missed:me', { Channel, visibility: hiddenTab });
    const seen = createMissedCallOnce('team-call-missed:me', { Channel, visibility: visibleTab });
    hidden.tell('c1', () => shown.push('hidden'));
    await vi.advanceTimersByTimeAsync(10);
    seen.tell('c1', () => shown.push('visible'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS + 10);
    expect(shown).toEqual(['visible']);
    // Shown: the hidden tab, once seen, does not show it again.
    hiddenTab.set(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(shown).toEqual(['visible']);
    hidden.close();
    seen.close();
  });

  it('a hidden tab that won alone never suppresses a visible one that comes later', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const hidden = createMissedCallOnce('team-call-missed:me', { Channel, visibility: tabVisibility(false) });
    const seen = createMissedCallOnce('team-call-missed:me', { Channel, visibility: tabVisibility(true) });
    hidden.tell('c1', () => shown.push('hidden'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS + 10);
    expect(shown).toEqual([]);
    seen.tell('c1', () => shown.push('visible'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS + 10);
    expect(shown).toEqual(['visible']);
    hidden.close();
    seen.close();
  });

  it('every tab hidden: the first one the member looks at shows it, once', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const aTab = tabVisibility(false);
    const bTab = tabVisibility(false);
    const a = createMissedCallOnce('team-call-missed:me', { Channel, visibility: aTab });
    const b = createMissedCallOnce('team-call-missed:me', { Channel, visibility: bTab });
    a.tell('c1', () => shown.push('a'));
    b.tell('c1', () => shown.push('b'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS + 10);
    expect(shown).toEqual([]);
    // Looked at after both windows and the losers' grace: whichever it is shows it.
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS * 2 + 10);
    bTab.set(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(shown).toEqual(['b']);
    aTab.set(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(shown).toEqual(['b']);
    a.close();
    b.close();
  });

  it('one tab that claims visible and is hidden before its window ends: shown once, when it is seen again', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const only = tabVisibility(true);
    const a = createMissedCallOnce('team-call-missed:me', { Channel, visibility: only });
    a.tell('c1', () => shown.push('a'));
    await vi.advanceTimersByTimeAsync(50);
    only.set(false);
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS * 3);
    expect(shown).toEqual([]);
    only.set(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(shown).toEqual(['a']);
    only.set(false);
    only.set(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(shown).toEqual(['a']);
    a.close();
  });

  it('A visible and B hidden, the member switches A to B inside the window: one toast, in B', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const aTab = tabVisibility(true);
    const bTab = tabVisibility(false);
    const a = createMissedCallOnce('team-call-missed:me', { Channel, visibility: aTab });
    const b = createMissedCallOnce('team-call-missed:me', { Channel, visibility: bTab });
    a.tell('c1', () => shown.push('a'));
    b.tell('c1', () => shown.push('b'));
    await vi.advanceTimersByTimeAsync(50);
    aTab.set(false);
    bTab.set(true);
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS * 3);
    expect(shown).toEqual(['b']);
    // Back to A: never a second one.
    bTab.set(false);
    aTab.set(true);
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS * 3);
    expect(shown).toEqual(['b']);
    a.close();
    b.close();
  });

  it('A visible and B hidden, A hidden inside the window, and A looked at again first: one toast, in A', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const aTab = tabVisibility(true);
    const bTab = tabVisibility(false);
    const a = createMissedCallOnce('team-call-missed:me', { Channel, visibility: aTab });
    const b = createMissedCallOnce('team-call-missed:me', { Channel, visibility: bTab });
    a.tell('c1', () => shown.push('a'));
    b.tell('c1', () => shown.push('b'));
    await vi.advanceTimersByTimeAsync(50);
    aTab.set(false);
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS * 3);
    expect(shown).toEqual([]);
    aTab.set(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(shown).toEqual(['a']);
    aTab.set(false);
    bTab.set(true);
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS * 3);
    expect(shown).toEqual(['a']);
    a.close();
    b.close();
  });

  it('two visible tabs: the loser waits its grace and hears the winner\'s shown, never a second toast', async () => {
    vi.useFakeTimers();
    const Channel = fakeBus();
    const shown: string[] = [];
    const a = createMissedCallOnce('team-call-missed:me', { Channel, visibility: tabVisibility(true) });
    await vi.advanceTimersByTimeAsync(0);
    a.tell('c1', () => shown.push('a'));
    await vi.advanceTimersByTimeAsync(100);
    const b = createMissedCallOnce('team-call-missed:me', { Channel, visibility: tabVisibility(true) });
    b.tell('c1', () => shown.push('b'));
    await vi.advanceTimersByTimeAsync(MISSED_CALL_CLAIM_WINDOW_MS * 4);
    expect(shown).toHaveLength(1);
    a.close();
    b.close();
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
