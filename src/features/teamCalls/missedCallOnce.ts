/**
 * One missed-call toast per call across a member's panel tabs
 * (docs/operations/TEAM_CALLS.md, "Web panel"): every open tab hears the
 * same missed or cancelled ring, and each used to show its own toast.
 *
 * Over a BroadcastChannel (one per member), keyed by call id: a tab that
 * would tell a missed call claims it, saying whether it is visible, and waits
 * a short window for the other tabs' claims of the same call. Claims rank
 * visible before hidden, then by tab id, so every tab picks the same winner.
 *
 * A toast is only ever shown in a tab that is visible at that moment (a
 * hidden tab's would close unseen), and the tab that shows it says so
 * (`shown`): from then on no tab shows it. Until a tab hears `shown`, it
 * keeps its toast:
 *   - the winner may show it from the end of its window: at once if visible
 *     then, else when it is next seen;
 *   - every other claimant may show it from a grace later (two windows,
 *     enough for the winner's `shown` to arrive), if visible then, else when
 *     it is next seen: so a winner that went hidden in the window, or closed,
 *     never leaves the toast unshown, and a visible winner's `shown` is heard
 *     before any other tab may show it.
 * Where BroadcastChannel is missing (or cannot be opened), each tab shows its
 * own, as before.
 */

/** How long a tab waits for the other tabs' claims of the same call. */
export const MISSED_CALL_CLAIM_WINDOW_MS = 150;

type Message =
  | { kind: 'team_call_missed_claim'; callId: string; tab: string; visible: boolean }
  | { kind: 'team_call_missed_shown'; callId: string };

type ChannelLike = Pick<BroadcastChannel, 'postMessage' | 'close'> & {
  onmessage: ((event: MessageEvent) => void) | null;
};

/** Whether this tab can be seen, and a way to hear when that changes. */
export interface TabVisibility {
  visible(): boolean;
  onChange(listener: () => void): () => void;
}

const documentVisibility: TabVisibility = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onChange: (listener) => {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

export interface MissedCallOnce {
  /** Calls [show] for [callId] in exactly one tab, a visible one (in each, without BroadcastChannel). */
  tell(callId: string, show: () => void): void;
  close(): void;
}

interface Entry {
  /** Claims heard or made: tab → visible when it claimed. */
  claims: Map<string, boolean>;
  shown: boolean;
  /** This tab's toast, while it may still have to show it. */
  show: (() => void) | null;
  /** This tab may show the toast now, if visible (else on becoming visible). */
  ready: boolean;
}

function randomTab(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export function createMissedCallOnce(
  name: string,
  opts: {
    windowMs?: number;
    Channel?: (new (name: string) => ChannelLike) | null;
    visibility?: TabVisibility;
  } = {},
): MissedCallOnce {
  const windowMs = opts.windowMs ?? MISSED_CALL_CLAIM_WINDOW_MS;
  const visibility = opts.visibility ?? documentVisibility;
  const Channel = opts.Channel !== undefined
    ? opts.Channel
    : (typeof BroadcastChannel === 'function' ? BroadcastChannel as unknown as new (name: string) => ChannelLike : null);
  const tab = randomTab();
  const entries = new Map<string, Entry>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let channel: ChannelLike | null = null;
  try {
    channel = Channel ? new Channel(name) : null;
  } catch {
    channel = null;
  }

  const entryOf = (callId: string): Entry => {
    let entry = entries.get(callId);
    if (!entry) {
      entry = { claims: new Map(), shown: false, show: null, ready: false };
      entries.set(callId, entry);
      // Bounded: a long-open tab forgets the oldest calls.
      if (entries.size > 200) entries.delete(entries.keys().next().value as string);
    }
    return entry;
  };

  const post = (message: Message) => {
    try { channel?.postMessage(message); } catch { /* the toast still shows here */ }
  };

  const showHere = (callId: string, entry: Entry) => {
    const show = entry.show;
    entry.show = null;
    if (entry.shown || !show) return;
    entry.shown = true;
    post({ kind: 'team_call_missed_shown', callId });
    show();
  };

  /** The claim every tab ranks first: visible before hidden, then the lowest tab id. */
  const winnerOf = (entry: Entry): { tab: string; visible: boolean } | null => {
    let best: { tab: string; visible: boolean } | null = null;
    for (const [claimTab, visible] of entry.claims) {
      if (!best || (visible && !best.visible) || (visible === best.visible && claimTab < best.tab)) {
        best = { tab: claimTab, visible };
      }
    }
    return best;
  };

  /** From now on this tab may show the toast: now if seen, else when it is next seen. */
  const becomeReady = (callId: string, entry: Entry) => {
    entry.ready = true;
    if (visibility.visible()) showHere(callId, entry);
  };

  const decide = (callId: string, entry: Entry) => {
    if (entry.shown || !entry.show) return;
    if (winnerOf(entry)?.tab === tab) {
      becomeReady(callId, entry);
      return;
    }
    // Another tab won: its `shown` comes first if it showed it.
    const grace = setTimeout(() => {
      timers.delete(grace);
      if (!entry.shown && entry.show) becomeReady(callId, entry);
    }, windowMs * 2);
    timers.add(grace);
  };

  const offVisibility = channel
    ? visibility.onChange(() => {
      if (!visibility.visible()) return;
      for (const [callId, entry] of entries) {
        if (entry.ready && entry.show && !entry.shown) showHere(callId, entry);
      }
    })
    : () => {};

  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const data = event?.data as Partial<Message> | null;
      if (!data || typeof data.callId !== 'string') return;
      if (data.kind === 'team_call_missed_shown') {
        const entry = entryOf(data.callId);
        entry.shown = true;
        entry.show = null;
        return;
      }
      if (data.kind === 'team_call_missed_claim' && typeof data.tab === 'string') {
        entryOf(data.callId).claims.set(data.tab, data.visible === true);
      }
    };
  }

  return {
    tell(callId, show) {
      if (!channel) {
        show();
        return;
      }
      const entry = entryOf(callId);
      // Shown somewhere already, or this tab is on it.
      if (entry.shown || entry.claims.has(tab)) return;
      const visible = visibility.visible();
      entry.claims.set(tab, visible);
      entry.show = show;
      post({ kind: 'team_call_missed_claim', callId, tab, visible });
      const timer = setTimeout(() => {
        timers.delete(timer);
        decide(callId, entry);
      }, windowMs);
      timers.add(timer);
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      offVisibility();
      try { channel?.close(); } catch { /* ignore */ }
      channel = null;
    },
  };
}
