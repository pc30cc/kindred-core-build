/**
 * Poll cadence for queue consumers: fast while there is work, progressively
 * slower while there is not.
 *
 * A fixed poll interval bills its cost against the busiest case and then
 * charges it around the clock. Measured on this deployment over 24h, with a
 * product that processed under a thousand real messages in two months:
 *
 *   claim_channel_jobs        54,726 requests/day   (1.5s fixed interval)
 *   claim_invitation_jobs     68,841 requests/day   (5s fixed interval)
 *   reclaim/expire sweeps     68,852 requests/day   (every tick, unconditional)
 *
 * Every one of those is a transaction the database opens, plans, commits and
 * writes WAL for. Almost all of them find nothing. That is what a Disk IO
 * budget actually gets spent on: not user traffic, but machinery checking an
 * empty queue several times a second forever.
 *
 * The policy here is the standard one for a queue consumer, and the important
 * property is that it costs nothing when it matters: the FIRST idle cycle
 * still waits exactly the old interval, and any cycle that finds work resets
 * immediately. A queue that is busy behaves identically to before. Only a
 * queue that has been empty for several consecutive cycles starts to ease
 * off, growing geometrically to a ceiling.
 *
 * Jitter is not decoration. Without it N replicas that booted together stay
 * in lockstep forever, so the database sees their polls arrive as a
 * simultaneous burst rather than spread out, and every backoff step keeps
 * them aligned. A proportional random offset decorrelates them.
 *
 * The class is deliberately pure — no timers, no I/O, no clock. It decides
 * how long to wait; the caller owns its own loop and shutdown semantics,
 * which differ between a `while (!stopping)` worker and a self-rescheduling
 * ticker. That also makes the policy directly testable without fake timers.
 */

export interface IdleBackoffOptions {
  /** Delay after a cycle that found work. Keeps a draining burst draining. */
  busyMs: number;
  /** Delay after the first idle cycle — i.e. the pre-existing poll interval. */
  idleMs: number;
  /** Ceiling for the idle delay, bounding worst-case pickup latency. */
  maxIdleMs: number;
  /** Geometric growth per consecutive idle cycle. Default 2. */
  factor?: number;
  /** Proportional jitter, ± this fraction of the delay. Default 0.2. */
  jitterRatio?: number;
  /** Injectable for deterministic tests. Default Math.random. */
  random?: () => number;
}

export class IdleBackoff {
  private readonly busyMs: number;
  private readonly idleMs: number;
  private readonly maxIdleMs: number;
  private readonly factor: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;

  private idleStreak = 0;

  constructor(options: IdleBackoffOptions) {
    if (!(options.busyMs >= 0)) throw new Error('idleBackoff: busyMs must be >= 0');
    if (!(options.idleMs > 0)) throw new Error('idleBackoff: idleMs must be > 0');
    if (!(options.maxIdleMs >= options.idleMs)) throw new Error('idleBackoff: maxIdleMs must be >= idleMs');

    this.busyMs = options.busyMs;
    this.idleMs = options.idleMs;
    this.maxIdleMs = options.maxIdleMs;
    this.factor = options.factor ?? 2;
    this.jitterRatio = options.jitterRatio ?? 0.2;
    this.random = options.random ?? Math.random;

    if (!(this.factor >= 1)) throw new Error('idleBackoff: factor must be >= 1');
    if (this.jitterRatio < 0 || this.jitterRatio >= 1) throw new Error('idleBackoff: jitterRatio must be in [0, 1)');
  }

  /** Consecutive idle cycles observed. Exposed for logging and assertions. */
  get idleCycles(): number {
    return this.idleStreak;
  }

  /** The current idle delay before jitter — what the streak has grown to. */
  peekIdleMs(): number {
    if (this.idleStreak <= 0) return this.busyMs;
    return Math.min(this.maxIdleMs, Math.round(this.idleMs * this.factor ** (this.idleStreak - 1)));
  }

  /** Forget the streak — the next idle cycle waits idleMs again. */
  reset(): void {
    this.idleStreak = 0;
  }

  /**
   * Records the outcome of a cycle and returns how long to wait before the
   * next one. `foundWork` must be true whenever the cycle did anything at
   * all, so that a queue which is merely slow never gets backed off.
   */
  next(foundWork: boolean): number {
    if (foundWork) {
      this.idleStreak = 0;
      return this.jittered(this.busyMs);
    }
    this.idleStreak += 1;
    return this.jittered(this.peekIdleMs());
  }

  private jittered(ms: number): number {
    if (ms <= 0 || this.jitterRatio === 0) return ms;
    // Symmetric proportional jitter: ms * (1 ± jitterRatio).
    const offset = (this.random() * 2 - 1) * this.jitterRatio;
    return Math.max(0, Math.round(ms * (1 + offset)));
  }
}

/**
 * A cheap "run this every Nth cycle" gate, for the maintenance sweeps that
 * used to fire on every single tick.
 *
 * reclaim_expired_invitation_jobs and expire_invitations_v2 are lease reapers
 * and TTL sweeps — they exist to catch work a crashed worker abandoned, and
 * to expire invitations whose deadline passed. Neither is latency-critical to
 * the second, and both were running 34,000+ times a day on a 5s tick. Running
 * them on their own slower schedule keeps the guarantee (nothing is
 * abandoned forever) at a small fraction of the cost.
 */
export class IntervalGate {
  /** null until the first pass — "never run" is distinct from "ran at t=0". */
  private lastRunAt: number | null = null;

  constructor(private readonly everyMs: number) {
    if (!(everyMs > 0)) throw new Error('intervalGate: everyMs must be > 0');
  }

  /**
   * True at most once per `everyMs`. The first call always passes, so a
   * freshly booted worker still reaps abandoned leases immediately.
   */
  due(now: number = Date.now()): boolean {
    if (this.lastRunAt !== null && now - this.lastRunAt < this.everyMs) return false;
    this.lastRunAt = now;
    return true;
  }
}

/**
 * IdleBackoff for a worker that must keep firing on a fixed interval.
 *
 * Several workers drive their poll from setInterval on purpose: a job runs
 * for minutes inside one cycle while the next interval still claims the next
 * queued job, so a self-rescheduling timeout (which waits for the cycle to
 * finish) would serialise them. This keeps the interval and skips it
 * instead: after consecutive empty cycles, the next few intervals do nothing,
 * so an idle queue is asked every IdleBackoff delay rather than every
 * interval, and the first cycle that finds work resets it.
 */
export class IdleIntervalSkipper {
  private skipsLeft = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly backoff: IdleBackoff,
  ) {
    if (!(intervalMs > 0)) throw new Error('idleIntervalSkipper: intervalMs must be > 0');
  }

  /** Call at the start of every interval: true means "do nothing this time". */
  skip(): boolean {
    if (this.skipsLeft <= 0) return false;
    this.skipsLeft -= 1;
    return true;
  }

  /** Records a finished cycle's outcome. */
  record(foundWork: boolean): void {
    const delay = this.backoff.next(foundWork);
    this.skipsLeft = foundWork ? 0 : Math.max(0, Math.round(delay / this.intervalMs) - 1);
  }
}

/**
 * Reads an integer (a poll interval, a lease length) from the environment,
 * clamped to a sane range.
 *
 * A bare parseInt reads "5s" as 5 and anything unparseable as NaN, and a
 * timer handed NaN fires every millisecond: one typo in a worker's env turned
 * its poll into a flood of database requests.
 */
export function intFromEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(value || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
