/**
 * Phase 6C — Lightweight, non-blocking banner shown to operators when
 * the platform is in degraded / force-polling mode. Pure presentation —
 * never blocks any feature, never opens a modal.
 */
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useEffectivePolicy } from '@/hooks/useEffectivePolicy';
import { Activity } from 'lucide-react';

export default function DegradedModeBanner() {
  const { workspace } = useActiveWorkspace();
  const policy = useEffectivePolicy(workspace?.id);

  const show = policy.degraded_mode || policy.force_polling;
  if (!show) return null;

  const label = policy.force_polling
    ? 'Realtime is temporarily limited — using polling. Messaging still works.'
    : 'System is running in degraded mode. Messaging still works.';

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