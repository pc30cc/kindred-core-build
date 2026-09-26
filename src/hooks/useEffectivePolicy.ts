/**
 * Phase 6C — Operator-side hook that polls the operator handshake to
 * surface the latest effective realtime policy snapshot. On
 * `failover_epoch` change it invalidates the per-workspace client
 * realtime cache so the next subscribe re-negotiates with the new
 * vendor / token. Never throws.
 */
import { useEffect, useRef, useState } from 'react';
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
      // intent:'policy_poll' — this hook only reads effective_policy on a
      // 30s heartbeat; it is not a realtime connection lifecycle event and
      // must never be counted as a reconnect_attempt server-side.
      body: JSON.stringify({ workspace_id: workspaceId, intent: 'policy_poll' }),
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
  // A ref, not state: the epoch only steers the cache invalidation below and
  // is never rendered. As a dependency of the effect, the first answer's
  // epoch change restarted the effect, which polled again at once — two
  // operator-connect requests on every mount instead of one.
  const lastEpochRef = useRef<string>('');

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
      if (p.failover_epoch !== lastEpochRef.current) {
        // Transport-affecting change — drop cached provider so the next
        // subscribe re-negotiates and binds to the new vendor.
        invalidateClientRealtimeCache(workspaceId);
        lastEpochRef.current = p.failover_epoch;
      }
    };

    void tick();
    timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [workspaceId]);

  return policy;
}