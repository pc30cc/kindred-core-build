/**
 * The jobs one worker process is running right now, with a ceiling.
 *
 * The interval-driven workers (AI KB Builder, SEO, regression) start a new
 * claim on every interval while earlier jobs are still running, which is how
 * they run several at once. Without a ceiling, a burst of queued jobs started
 * all of them in one process: each crawl holding pages in memory, all of them
 * sharing a connection pool of 3 to 5 (DATABASE_POOL_MAX), so their heartbeats
 * queued behind each other's queries and leases lapsed under load. The
 * ceiling bounds that; the queue keeps the rest until a slot frees.
 *
 * It also names the jobs a shutdown leaves behind (`ids()`), so a worker that
 * is being stopped can release them instead of leaving them `running`.
 */
export class InFlightJobs {
  private readonly running = new Set<string>();
  /** Slots held by claims still in flight (no job id yet). */
  private reserved = 0;

  constructor(readonly max: number) {
    if (!(Number.isInteger(max) && max >= 1)) throw new Error('inFlightJobs: max must be an integer >= 1');
  }

  /** No slot left: the caller must not claim another job. */
  get full(): boolean {
    return this.running.size + this.reserved >= this.max;
  }

  get size(): number {
    return this.running.size;
  }

  /**
   * Holds a slot for a claim that is still talking to the database, so two
   * overlapping intervals cannot both see a free slot and both claim. Returns
   * the release; call it once the claim has resolved (after `add` if it got a
   * job). Releasing twice is harmless.
   */
  reserve(): () => void {
    this.reserved += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved -= 1;
    };
  }

  add(id: string): void {
    this.running.add(id);
  }

  delete(id: string): void {
    this.running.delete(id);
  }

  ids(): string[] {
    return [...this.running];
  }
}

/** Resolves with the promise's outcome, or after `ms` — a shutdown must not hang on a dead database. */
export async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]);
  if (timer) clearTimeout(timer);
}
