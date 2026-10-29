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
 */

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 25_000);

const drains = new Map<string, () => Promise<unknown>>();
let installed = false;
let shuttingDown = false;

/**
 * Registers a drain to run on SIGTERM or SIGINT (the latest registration of a
 * name wins). Installs the two signal listeners on the first call, and never
 * again. Never logs anything a drain carries.
 */
export function onProcessShutdown(name: string, drain: () => Promise<unknown>): void {
  drains.set(name, drain);
  if (installed) return;
  installed = true;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdownProcess(signal);
    });
  }
}

/**
 * Runs every registered drain at once and resolves when all have settled or
 * `timeoutMs` has passed, whichever is first; a drain that throws is logged
 * and counted as done. Exported for the tests; the signal handler is its only
 * caller in production.
 */
export async function runShutdownDrains(timeoutMs: number = SHUTDOWN_TIMEOUT_MS): Promise<{ timedOut: boolean }> {
  const all = Promise.allSettled(
    [...drains.entries()].map(async ([name, drain]) => {
      try {
        await drain();
      } catch (err) {
        console.warn(`[shutdown] ${name} drain failed:`, err instanceof Error ? err.message : String(err));
      }
    }),
  ).then(() => false);
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
    timer.unref?.();
  });
  const timedOut = await Promise.race([all, bound]);
  if (timer) clearTimeout(timer);
  return { timedOut };
}

async function shutdownProcess(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — draining ${[...drains.keys()].join(', ') || 'nothing'}`);
  const { timedOut } = await runShutdownDrains();
  if (timedOut) console.warn('[shutdown] drains did not finish in time; leases will be reclaimed');
  process.exit(0);
}
