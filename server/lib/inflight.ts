/**
 * Share one in-flight lookup among concurrent identical requests.
 *
 * The dashboard fires several requests at the same instant (a realtime
 * invalidation refetches the conversation list, both inbox counters and the
 * open thread together), and each one used to repeat the same session,
 * admin-role and membership reads. While a lookup for `key` is still
 * running, later callers await that same promise instead of issuing their
 * own query.
 *
 * This is NOT a cache: the entry is dropped the moment the lookup settles,
 * so a request that starts after a revocation, suspension or role change
 * always reads the database afresh. Callers must treat the shared result as
 * read-only.
 */
const pending = new Map<string, Promise<unknown>>();

export function coalesce<T>(key: string, load: () => PromiseLike<T>): Promise<T> {
  const running = pending.get(key) as Promise<T> | undefined;
  if (running) return running;
  const promise = Promise.resolve()
    .then(load)
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, promise);
  return promise;
}
