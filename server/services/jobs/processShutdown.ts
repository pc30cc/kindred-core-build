/**
 * The process's one answer to SIGTERM and SIGINT: drain, then exit.
 *
 * A listener installed with `process.on`/`process.once` replaces Node's own
 * handling of the signal, which is to exit. The invitation worker installed
 * one that drained its jobs and returned, and it was the only one in the
 * backend: so the backend never exited on SIGTERM. Every replacement of the
 * container (Coolify replaces it on each push to main) waited for the
 * SIGKILL that follows, with the HTTP server and every ticker, mail senders
 * included, still running until the kill cut them off mid-send.
 *
 * Here each in-process loop registers its drain once, the drains run
 * together within one bound, and the process then exits. A second signal
 * while they run finds no listener of ours left (they are `once`) and gets
 * Node's own: an immediate exit.
 *
 * The HTTP server's drain is the one registered `last`: it starts only once
 * every other drain has settled. Its close() stops accepting connections at
 * once, while the proxy in front (Traefik under Coolify) keeps sending
 * requests to this container until it exits; closed first, every request
 * routed here while a mail was still being sent got a 502. Now the window is
 * only the time the requests already in flight take.
 */

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 25_000);

const drains = new Map<string, { drain: () => Promise<unknown>; last: boolean }>();
let installed = false;
let shuttingDown = false;

/**
 * Registers a drain to run on SIGTERM or SIGINT (the latest registration of a
 * name wins). With `last`, it starts only once the others have settled (the
 * HTTP server, which keeps answering while the loops drain). Installs the
 * two signal listeners on the first call, and never again. Never logs
 * anything a drain carries.
 */
export function onProcessShutdown(name: string, drain: () => Promise<unknown>, opts: { last?: boolean } = {}): void {
  drains.set(name, { drain, last: opts.last === true });
  if (installed) return;
  installed = true;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdownProcess(signal);
    });
  }
}

/** Runs the named drains together; a drain that throws is logged and counted as done. */
function runTogether(entries: Array<[string, { drain: () => Promise<unknown> }]>): Promise<false> {
  return Promise.allSettled(
    entries.map(async ([name, { drain }]) => {
      try {
        await drain();
      } catch (err) {
        console.warn(`[shutdown] ${name} drain failed:`, err instanceof Error ? err.message : String(err));
      }
    }),
  ).then(() => false);
}

/**
 * Runs every registered drain at once, then the `last` ones, and resolves
 * when all have settled or `timeoutMs` has passed, whichever is first. A
 * bound that passes while the first ones run still starts the last ones (the
 * HTTP server then stops accepting before the exit). Exported for the tests;
 * the signal handler is its only caller in production.
 */
export async function runShutdownDrains(timeoutMs: number = SHUTDOWN_TIMEOUT_MS): Promise<{ timedOut: boolean }> {
  const entries = [...drains.entries()];
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
    timer.unref?.();
  });
  const firstTimedOut = await Promise.race([runTogether(entries.filter(([, d]) => !d.last)), bound]);
  const lastTimedOut = await Promise.race([runTogether(entries.filter(([, d]) => d.last)), bound]);
  if (timer) clearTimeout(timer);
  return { timedOut: firstTimedOut || lastTimedOut };
}

async function shutdownProcess(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — draining ${[...drains.keys()].join(', ') || 'nothing'}`);
  const { timedOut } = await runShutdownDrains();
  if (timedOut) console.warn('[shutdown] drains did not finish in time; leases will be reclaimed');
  process.exit(0);
}
