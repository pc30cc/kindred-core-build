/**
 * Phase 6C / 7.6 — Lightweight, non-blocking banner shown to operators
 * when the platform is in degraded / force-polling mode OR when an
 * enforcement action is currently active. Pure presentation — never
 * blocks any feature, never opens a modal.
 */
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useEffectivePolicy } from '@/hooks/useEffectivePolicy';
import { Activity } from 'lucide-react';

export default function DegradedModeBanner() {
  const { workspace } = useActiveWorkspace();
  const policy = useEffectivePolicy(workspace?.id);

  // Highest-priority message wins so we never show two banners at once.
  // Order matches enforcement priority (force_polling > degraded > load
  // shedding > priority-only > intake throttle).
  let label: string | null = null;
  if (policy.force_polling) {
    label = 'Realtime is temporarily limited — using polling. Messaging still works.';
  } else if (policy.degraded_mode) {
    label = 'System is running in degraded mode. Messaging still works.';
  } else if (policy.operator_load_shedding) {
    label = 'High load — non-critical updates are paused to keep replies fast.';
  } else if (policy.priority_only_mode) {
    label = 'Priority-only mode — high-priority conversations are routed first.';
  } else if (policy.throttle_new_conversations) {
    label = 'New conversation intake is throttled — open conversations are unaffected.';
  } else if (policy.slow_mode_messages) {
    label = 'Slow-mode active — outbound messages have a small delay.';
  }

  if (!label) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-warning/10 border-b border-warning/30 px-4 py-2 flex items-center justify-center gap-2 text-xs text-warning-foreground"
    >
      <Activity className="h-3.5 w-3.5 text-warning shrink-0" aria-hidden="true" />
      <span className="font-medium text-foreground/80">{label}</span>
    </div>
  );
}