/**
 * Throttled React Query invalidation for realtime event handlers.
 *
 * `invalidateQueries()` refetches every active matching query immediately,
 * and by default cancels a fetch already in flight to start a new one — so
 * nothing is deduplicated: a burst of realtime events (a busy inbox, a
 * traffic spike on the visitor map) sent one full list request per event,
 * from every open dashboard. The conversation list was also invalidated by
 * both the workspace channel and the open conversation's channel for the
 * same message.
 *
 * Per query key, per QueryClient:
 *   - the first event invalidates at once, exactly as before;
 *   - further events within `windowMs` are folded into ONE trailing
 *     invalidation when the window ends.
 * An isolated event is as fresh as ever; a sustained burst refetches at most
 * once per window, and the last event of a burst is never lost.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';

export const DEFAULT_INVALIDATION_WINDOW_MS = 1_000;

interface KeyWindow {
  queryKey: QueryKey;
  dirty: boolean;
}

const windowsByClient = new WeakMap<QueryClient, Map<string, KeyWindow>>();

export function invalidateThrottled(
  qc: QueryClient,
  queryKey: QueryKey,
  windowMs: number = DEFAULT_INVALIDATION_WINDOW_MS,
): void {
  let windows = windowsByClient.get(qc);
  if (!windows) {
    windows = new Map();
    windowsByClient.set(qc, windows);
  }
  const id = JSON.stringify(queryKey);
  const open = windows.get(id);
  if (open) {
    open.dirty = true;
    return;
  }
  fire(qc, windows, id, queryKey, windowMs);
}

function fire(qc: QueryClient, windows: Map<string, KeyWindow>, id: string, queryKey: QueryKey, windowMs: number): void {
  void qc.invalidateQueries({ queryKey });
  const current: KeyWindow = { queryKey, dirty: false };
  windows.set(id, current);
  setTimeout(() => {
    windows.delete(id);
    if (current.dirty) fire(qc, windows, id, queryKey, windowMs);
  }, windowMs);
}
