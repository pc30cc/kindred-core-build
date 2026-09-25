/**
 * useEntitlements — registry-driven hooks for admin & app UI.
 *
 * Backend is the source of truth. These hooks just cache the
 * results of the read-only catalog / effective-state endpoints.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  fetchCapabilityCatalog,
  fetchWorkspaceEffective,
  fetchEntitlementDiagnostics,
  type CapabilityDefinition,
  type WorkspaceEffectiveEntitlements,
  type EntitlementDiagnostics,
} from '@/lib/entitlements-api';
import { planAccessOf, type PlanAccess } from '@/lib/planAccess';

export function useCapabilityCatalog() {
  const [data, setData] = useState<CapabilityDefinition[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCapabilityCatalog()
      .then((r) => { if (!cancelled) setData(r.capabilities); })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { capabilities: data, loading, error };
}

/**
 * The effective entitlement snapshot, shared by every component of the app.
 *
 * One store per workspace, so a plan-gated menu, tab and page all read the
 * same snapshot and change together:
 *  - the first reader fetches it; later readers get it synchronously, so
 *    nothing gated flashes in and out on mount;
 *  - it is refetched when it is more than a minute old and the window regains
 *    focus or becomes visible, and every five minutes while visible — a plan
 *    Super Admin changes reaches open tabs without a reload;
 *  - a failed refetch keeps the last snapshot that was read (the server still
 *    enforces); only a workspace never read successfully reports an error;
 *  - clearEffectiveEntitlementsCache() drops everything when the signed-in
 *    identity changes (IdentityCacheBoundary).
 */
interface SnapshotEntry {
  data: WorkspaceEffectiveEntitlements | null;
  error: string | null;
  fetchedAt: number;
  loading: boolean;
}

const STALE_MS = 60_000;
const REFRESH_MS = 5 * 60_000;
const EMPTY: SnapshotEntry = { data: null, error: null, fetchedAt: 0, loading: false };

const snapshots = new Map<string, SnapshotEntry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
const refreshers = new Map<string, () => void>();
let generation = 0;

function publish(workspaceId: string, next: SnapshotEntry) {
  snapshots.set(workspaceId, next);
  listeners.get(workspaceId)?.forEach((notify) => notify());
}

function loadSnapshot(workspaceId: string, opts: { force?: boolean } = {}): Promise<void> {
  const running = inflight.get(workspaceId);
  if (running) return running;
  const current = snapshots.get(workspaceId) ?? EMPTY;
  if (!opts.force && current.data && Date.now() - current.fetchedAt < STALE_MS) return Promise.resolve();

  const started = generation;
  if (!current.data) publish(workspaceId, { ...current, loading: true });
  const request = fetchWorkspaceEffective(workspaceId)
    .then(
      (data) => {
        if (started !== generation) return;
        publish(workspaceId, { data, error: null, fetchedAt: Date.now(), loading: false });
      },
      (e: unknown) => {
        if (started !== generation) return;
        const latest = snapshots.get(workspaceId) ?? EMPTY;
        publish(workspaceId, { ...latest, error: e instanceof Error ? e.message : String(e), loading: false });
      },
    )
    .finally(() => {
      if (inflight.get(workspaceId) === request) inflight.delete(workspaceId);
    });
  inflight.set(workspaceId, request);
  return request;
}

/** One focus/visibility/interval refresher per workspace, however many readers it has. */
function startRefresher(workspaceId: string) {
  if (typeof window === 'undefined' || refreshers.has(workspaceId)) return;
  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
  const onFocus = () => { if (visible()) void loadSnapshot(workspaceId); };
  const timer = window.setInterval(() => { if (visible()) void loadSnapshot(workspaceId, { force: true }); }, REFRESH_MS);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  refreshers.set(workspaceId, () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
  });
}

function subscribeSnapshot(workspaceId: string, notify: () => void) {
  let set = listeners.get(workspaceId);
  if (!set) {
    set = new Set();
    listeners.set(workspaceId, set);
    startRefresher(workspaceId);
  }
  set.add(notify);
  return () => {
    set!.delete(notify);
    if (set!.size === 0) {
      listeners.delete(workspaceId);
      refreshers.get(workspaceId)?.();
      refreshers.delete(workspaceId);
    }
  };
}

/** Forget every snapshot (identity change). Readers still mounted refetch for the new identity. */
export function clearEffectiveEntitlementsCache() {
  generation += 1;
  inflight.clear();
  const workspaces = [...snapshots.keys()];
  snapshots.clear();
  for (const workspaceId of workspaces) {
    listeners.get(workspaceId)?.forEach((notify) => notify());
    if (listeners.has(workspaceId)) void loadSnapshot(workspaceId);
  }
}

export function useWorkspaceEffectiveEntitlements(workspaceId: string | null | undefined) {
  const subscribe = useCallback(
    (notify: () => void) => (workspaceId ? subscribeSnapshot(workspaceId, notify) : () => {}),
    [workspaceId],
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (workspaceId ? snapshots.get(workspaceId) ?? EMPTY : EMPTY),
    () => EMPTY,
  );

  useEffect(() => {
    if (workspaceId) void loadSnapshot(workspaceId);
  }, [workspaceId]);

  const reload = useCallback(() => {
    if (workspaceId) void loadSnapshot(workspaceId, { force: true });
  }, [workspaceId]);

  return {
    data: entry.data,
    // Not loaded yet counts as loading, so a gate never renders "denied" first.
    loading: !!workspaceId && !entry.data && (entry.loading || !entry.error),
    // A refetch that failed after a good read is not an error to the reader.
    error: entry.data ? null : entry.error,
    reload,
  };
}

/** The plan rules of src/lib/planAccess.ts over the shared snapshot. */
export function usePlanAccess(workspaceId: string | null | undefined): PlanAccess {
  const { data, error } = useWorkspaceEffectiveEntitlements(workspaceId);
  return useMemo(() => planAccessOf(data, !!error), [data, error]);
}


export function useEntitlementDiagnostics() {
  const [data, setData] = useState<EntitlementDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchEntitlementDiagnostics()
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  return { data, loading, error, reload: () => setReloadKey((k) => k + 1) };
}