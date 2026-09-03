/**
 * useEntitlements — registry-driven hooks for admin & app UI.
 *
 * Backend is the source of truth. These hooks just cache the
 * results of the read-only catalog / effective-state endpoints.
 */
import { useEffect, useState } from 'react';
import {
  fetchCapabilityCatalog,
  fetchWorkspaceEffective,
  fetchEntitlementDiagnostics,
  type CapabilityDefinition,
  type WorkspaceEffectiveEntitlements,
  type EntitlementDiagnostics,
} from '@/lib/entitlements-api';

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
 * Cross-component cache for the effective entitlement snapshot.
 *
 * Plan gating decides which menus/tabs exist, so a re-fetch on every mount
 * used to render gated UI for a few hundred ms before it disappeared. The
 * cache (plus in-flight de-duplication) makes the snapshot available
 * synchronously after the first load, so nothing ever flashes in and out.
 */
const effectiveCache = new Map<string, WorkspaceEffectiveEntitlements>();
const effectiveInflight = new Map<string, Promise<WorkspaceEffectiveEntitlements>>();

export function useWorkspaceEffectiveEntitlements(workspaceId: string | null | undefined) {
  const cached = workspaceId ? effectiveCache.get(workspaceId) ?? null : null;
  const [data, setData] = useState<WorkspaceEffectiveEntitlements | null>(cached);
  const [loading, setLoading] = useState(!!workspaceId && !cached);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!workspaceId) { setData(null); setLoading(false); return; }
    let cancelled = false;
    const hit = reloadKey === 0 ? effectiveCache.get(workspaceId) : undefined;
    if (hit) { setData(hit); setLoading(false); return; }
    setLoading(true);
    let req = reloadKey === 0 ? effectiveInflight.get(workspaceId) : undefined;
    if (!req) {
      req = fetchWorkspaceEffective(workspaceId).then((r) => {
        effectiveCache.set(workspaceId, r);
        return r;
      }).finally(() => { effectiveInflight.delete(workspaceId); });
      effectiveInflight.set(workspaceId, req);
    }
    req
      .then((r) => { if (!cancelled) { setData(r); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, reloadKey]);

  return {
    data,
    loading,
    error,
    reload: () => {
      if (workspaceId) { effectiveCache.delete(workspaceId); effectiveInflight.delete(workspaceId); }
      setReloadKey((k) => k + 1);
    },
  };
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