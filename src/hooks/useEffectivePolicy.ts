/**
 * Phase 6C — Operator-side hook that polls the operator handshake to
 * surface the latest effective realtime policy snapshot. On
 * `failover_epoch` change it invalidates the per-workspace client
 * realtime cache so the next subscribe re-negotiates with the new
 * vendor / token. Never throws.
 */
import { useEffect, useState } from 'react';
import {
  SAFE_DEFAULT_POLICY,
  type EffectivePolicySnapshot,
} from '@/lib/effective-policy-api';
import { invalidateClientRealtimeCache } from '@/realtime/resolveClientRealtimeProvider';
import { setEffectivePolicySnapshot } from '@/realtime/policySnapshot';
import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';

const API_BASE = (RESOLVED_API_BASE as string | undefined) || '';
const POLL_MS = 30_000;

async function fetchPolicy(workspaceId: string): Promise<EffectivePolicySnapshot | null> {
  try {
    const res = await fetch(`${API_BASE}/api/realtime/operator-connect`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const p = json?.effective_policy as EffectivePolicySnapshot | undefined;
    return p ?? null;
  } catch {
    return null;
  }
}

export function useEffectivePolicy(workspaceId: string | undefined): EffectivePolicySnapshot {
  const [policy, setPolicy] = useState<EffectivePolicySnapshot>(SAFE_DEFAULT_POLICY);
  const [lastEpoch, setLastEpoch] = useState<string>('');

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      const p = await fetchPolicy(workspaceId);
      if (cancelled || !p) return;
      setPolicy(p);
      // Mirror into the process-wide singleton so non-React adapters
      // (Centrifugo reconnect scheduler, typing emit guard) can read
      // the latest policy without a hook.
      setEffectivePolicySnapshot(p);
      if (p.failover_epoch !== lastEpoch) {
        // Transport-affecting change — drop cached provider so the next
        // subscribe re-negotiates and binds to the new vendor.
        invalidateClientRealtimeCache(workspaceId);
        setLastEpoch(p.failover_epoch);
      }
    };

    void tick();
    timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [workspaceId, lastEpoch]);

  return policy;
}