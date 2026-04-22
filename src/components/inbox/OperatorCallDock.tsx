/**
 * OperatorCallDock — compact, persistent status strip.
 *
 * Reuses existing APIs (no backend changes):
 *   • callQueueApi.list             → live queue count (5s poll)
 *   • callQueueApi.myPermissions    → per-channel availability
 *
 * Strict UX rules:
 *   • Pure presentation — does NOT start, accept or end calls.
 *   • Read-only signals: it just tells the operator what they CAN do
 *     and how many people are waiting. Accept/decline lives in the
 *     existing CallQueuePanel and OperatorCallPanel.
 *   • Never blocks the inbox if APIs fail.
 */
import { useEffect, useState } from 'react';
import { Phone, Video, Bell, MicOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { callQueueApi, type CallQueueEntry } from '@/lib/call-queue-api';

interface DockState {
  perms: {
    can_receive_audio_call: boolean;
    can_receive_video_call: boolean;
    can_join_queue_calls: boolean;
  } | null;
  waiting: number;
}

export function OperatorCallDock({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<DockState>({ perms: null, waiting: 0 });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const p = await callQueueApi.myPermissions(workspaceId);
        if (!cancelled) setState((s) => ({ ...s, perms: p }));
      } catch {
        if (!cancelled) setState((s) => ({ ...s, perms: { can_receive_audio_call: false, can_receive_video_call: false, can_join_queue_calls: false } }));
      }
    })();

    const refresh = async () => {
      try {
        const r = await callQueueApi.list(workspaceId);
        if (cancelled) return;
        const waiting = (r.entries as CallQueueEntry[]).filter(
          (e) => e.state === 'queued' || e.state === 'offered',
        ).length;
        setState((s) => ({ ...s, waiting }));
      } catch {
        /* network blips ok */
      }
    };
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [workspaceId]);

  // Hide entirely if operator has no call privileges at all.
  const perms = state.perms;
  const anyCallPriv = !!perms && (perms.can_receive_audio_call || perms.can_receive_video_call || perms.can_join_queue_calls);
  if (!perms || !anyCallPriv) return null;

  const audioReady = perms.can_receive_audio_call;
  const videoReady = perms.can_receive_video_call;

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 py-1.5 text-[11px]',
        'shadow-sm',
      )}
      role="status"
      aria-label="Operator call availability"
    >
      <span className="font-medium text-muted-foreground uppercase tracking-wide">Calls</span>

      <span className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded',
        audioReady ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
      )}>
        {audioReady ? <Phone className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
        Audio
      </span>

      <span className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded',
        videoReady ? 'bg-info/10 text-info' : 'bg-muted text-muted-foreground',
      )}>
        <Video className="h-3 w-3" /> Video
      </span>

      <span className="ms-auto inline-flex items-center gap-1 text-muted-foreground">
        <Bell className="h-3 w-3" />
        Queue
        <Badge variant={state.waiting > 0 ? 'default' : 'secondary'} className="text-[10px] px-1.5 h-4">
          {state.waiting}
        </Badge>
      </span>
    </div>
  );
}