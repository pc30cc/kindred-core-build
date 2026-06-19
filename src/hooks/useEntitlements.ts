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

export function useWorkspaceEffectiveEntitlements(workspaceId: string | null | undefined) {
  const [data, setData] = useState<WorkspaceEffectiveEntitlements | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!workspaceId) { setData(null); return; }
    let cancelled = false;
    setLoading(true);
    fetchWorkspaceEffective(workspaceId)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, reloadKey]);

  return { data, loading, error, reload: () => setReloadKey((k) => k + 1) };
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