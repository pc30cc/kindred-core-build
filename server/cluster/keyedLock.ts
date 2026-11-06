/**
 * Keyed chain locks, held for the whole container by the cluster primary
 * (cluster/hub.ts). The semantics are exactly those of the in-process reply
 * lock (services/operatorReplyJoin.ts, lockConversationReplies):
 *
 *   - a waiter becomes the key's tail at once, and waits only for its
 *     predecessor's release, or for its own `maxWaitMs`, whichever is first;
 *   - a waiter whose bound passed proceeds and stays in the chain: the next
 *     one waits for its release;
 *   - release is idempotent;
 *   - every token of a worker that exited is released (releaseOwner), so a
 *     crash never holds a key longer than the waiters' bounds.
 *
 * A token released before it was granted (its worker exited while it
 * waited, or the GC) does not let its successor go: its tail opens only when
 * its predecessor's does, as if it had been granted and released at once. In
 * the single process a waiter cannot vanish mid-wait, so the next one always
 * waited for the real holder; it still does.
 *
 * Tokens are chosen by the worker, so it can release a lock whose grant it
 * never saw (its IPC wait timed out). Pure: no I/O, timers unref'd.
 */

interface Held {
  key: string;
  owner: number;
  tail: Promise<void>;
  open: () => void;
  since: number;
  /** The tail this token waits behind (undefined: it was first). */
  previous: Promise<void> | undefined;
  /** It went on: its predecessor released, or its own bound passed. */
  granted: boolean;
  /** Stops its wait (an ungranted token released). */
  cancelWait: () => void;
}

/** A lock held this long is released by the GC (its holder forgot it). */
const MAX_HOLD_MS = 10 * 60_000;
const MAX_HELD = 100_000;

export class KeyedChainLocks {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly held = new Map<string, Held>();

  constructor(private readonly maxHeld: number = MAX_HELD) {}

  /** Resolves when `token` may proceed on `key`. */
  acquire(key: string, maxWaitMs: number, token: string, owner: number, now: number = Date.now()): Promise<void> {
    if (this.held.has(token)) return Promise.resolve();
    // Over the cap: proceed unlocked rather than grow without bound, as a
    // waiter whose bound passed does.
    if (this.held.size >= this.maxHeld) return Promise.resolve();
    const previous = this.tails.get(key);
    let open: () => void = () => undefined;
    const tail = new Promise<void>((resolve) => { open = resolve; });
    this.tails.set(key, tail);
    const h: Held = { key, owner, tail, open, since: now, previous, granted: !previous, cancelWait: () => undefined };
    this.held.set(token, h);
    if (!previous) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        h.granted = true;
        resolve();
      };
      const timer = setTimeout(grant, Math.max(0, maxWaitMs));
      timer.unref?.();
      h.cancelWait = () => clearTimeout(timer);
      void previous.then(grant);
    });
  }

  /** Releases `token`; false when it was not held (already released). */
  release(token: string): boolean {
    const h = this.held.get(token);
    if (!h) return false;
    this.held.delete(token);
    const openTail = () => {
      h.open();
      if (this.tails.get(h.key) === h.tail) this.tails.delete(h.key);
    };
    if (h.granted || !h.previous) {
      openTail();
    } else {
      // Never granted: the key is still its predecessor's. Opening this tail
      // now would let the next waiter run beside that holder, so it opens
      // when the predecessor's does; and the tail stays the key's until then,
      // so a newcomer waits for that holder too.
      h.cancelWait();
      void h.previous.then(openTail);
    }
    return true;
  }

  /** Releases every token of a worker that exited; returns how many. */
  releaseOwner(owner: number): number {
    let n = 0;
    for (const [token, h] of [...this.held]) {
      if (h.owner === owner && this.release(token)) n += 1;
    }
    return n;
  }

  /** Releases locks held longer than any caller holds one. */
  gc(now: number = Date.now()): void {
    for (const [token, h] of [...this.held]) if (now - h.since > MAX_HOLD_MS) this.release(token);
  }

  get size(): number {
    return this.held.size;
  }
}
