/**
 * One missed-call toast per call across a member's panel tabs
 * (docs/operations/TEAM_CALLS.md, "Web panel"): every open tab hears the
 * same missed or cancelled ring, and each used to show its own toast.
 *
 * Over a BroadcastChannel (one per member), keyed by call id: a tab that
 * would tell a missed call claims it, waits a short window for the other
 * tabs' claims of the same call, and shows it only if its own claim is the
 * lowest it saw. Every tab sees the same claims, so exactly one shows it; a
 * tab that comes to the call after the window already heard the claim and
 * stays quiet. Where BroadcastChannel is missing (or cannot be opened), each
 * tab shows its own, as before.
 */

/** How long a tab waits for the other tabs' claims of the same call. */
export const MISSED_CALL_CLAIM_WINDOW_MS = 150;

interface Claim {
  kind: 'team_call_missed_claim';
  callId: string;
  tab: string;
}

type ChannelLike = Pick<BroadcastChannel, 'postMessage' | 'close'> & {
  onmessage: ((event: MessageEvent) => void) | null;
};

export interface MissedCallOnce {
  /** Calls [show] for [callId] in exactly one tab (in each, without BroadcastChannel). */
  tell(callId: string, show: () => void): void;
  close(): void;
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
  opts: { windowMs?: number; Channel?: (new (name: string) => ChannelLike) | null } = {},
): MissedCallOnce {
  const windowMs = opts.windowMs ?? MISSED_CALL_CLAIM_WINDOW_MS;
  const Channel = opts.Channel !== undefined
    ? opts.Channel
    : (typeof BroadcastChannel === 'function' ? BroadcastChannel as unknown as new (name: string) => ChannelLike : null);
  const tab = randomTab();
  /** Every claim heard or made, by call id. */
  const claims = new Map<string, Set<string>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let channel: ChannelLike | null = null;
  try {
    channel = Channel ? new Channel(name) : null;
  } catch {
    channel = null;
  }
  const claimsOf = (callId: string): Set<string> => {
    let set = claims.get(callId);
    if (!set) {
      set = new Set();
      claims.set(callId, set);
      // Bounded: a long-open tab forgets the oldest calls.
      if (claims.size > 200) claims.delete(claims.keys().next().value as string);
    }
    return set;
  };
  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const data = event?.data as Partial<Claim> | null;
      if (!data || data.kind !== 'team_call_missed_claim') return;
      if (typeof data.callId !== 'string' || typeof data.tab !== 'string') return;
      claimsOf(data.callId).add(data.tab);
    };
  }

  return {
    tell(callId, show) {
      if (!channel) {
        show();
        return;
      }
      const seen = claimsOf(callId);
      // Claimed already: by this tab, or by another before this one came to it.
      if (seen.size > 0) return;
      seen.add(tab);
      try {
        channel.postMessage({ kind: 'team_call_missed_claim', callId, tab } satisfies Claim);
      } catch {
        show();
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        const all = [...claimsOf(callId)].sort();
        if (all[0] === tab) show();
      }, windowMs);
      timers.add(timer);
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      try { channel?.close(); } catch { /* ignore */ }
      channel = null;
    },
  };
}
