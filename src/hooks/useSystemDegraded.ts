/**
 * Phase 5C.1 — Reads `system_degraded` from the active auto-actions.
 * Pure UI hint: never blocks any feature, never affects realtime/widget.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchActiveAutoActions } from '@/lib/admin-auto-actions-api';

export function useSystemDegraded() {
  const q = useQuery({
    queryKey: ['admin-auto-action-active'],
    queryFn: fetchActiveAutoActions,
    refetchInterval: 30_000,
  });
  const active = q.data?.active || [];
  const degradedAction = active.find((a) => a.action_type === 'mark_system_degraded');
  return {
    isDegraded: Boolean(degradedAction),
    triggerRule: degradedAction?.trigger_rule_slug ?? null,
    expiresAt: degradedAction?.expires_at ?? null,
    isLoading: q.isLoading,
  };
}