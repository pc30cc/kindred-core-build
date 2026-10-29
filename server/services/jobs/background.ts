/**
 * Work a request starts and does not wait for, after its answer has gone.
 *
 * A public form that must not tell whether an account exists (a password
 * reset, a verification link) cannot do the account's work before it
 * answers: the lookup, the token and the provider's round trip took seconds
 * for a known address and nothing for an unknown one, which told the caller
 * which was which. Such a route answers first and hands the rest to
 * runInBackground, so every answer takes the same time.
 *
 * The task starts on the next turn of the event loop (setImmediate), after
 * the answer was written. A failure is logged with its label only, never
 * with what the task carried. On SIGTERM the tasks still running are waited
 * for, within the shutdown bound (processShutdown.ts), so a deploy does not
 * cut a mail off halfway.
 */
import { onProcessShutdown } from './processShutdown.js';

const pending = new Set<Promise<void>>();
let registered = false;

export function runInBackground(label: string, task: () => Promise<unknown>): void {
  if (!registered) {
    registered = true;
    onProcessShutdown('background-tasks', () => backgroundTasksSettled());
  }
  const done: Promise<void> = new Promise<void>((resolve) => {
    setImmediate(() => {
      Promise.resolve()
        .then(task)
        .catch((err: unknown) => {
          console.warn(`[${label}] background task failed:`, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          pending.delete(done);
          resolve();
        });
    });
  });
  pending.add(done);
}

/** Resolves once every task started so far has finished (for shutdown and the tests). */
export async function backgroundTasksSettled(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
