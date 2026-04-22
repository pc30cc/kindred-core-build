/**
 * Phase 8D — OperatorCallDock with availability toggle.
 *
 * - Shows call permissions (audio/video) the operator HAS.
 * - Shows live waiting count.
 * - Dropdown lets the operator declare their own readiness state.
 * - busy/in_call from the server overrides the manual selection in display.
 *
 * Reuses APIs only — no backend change:
 *   • callQueueApi.list             → live queue count (5s poll)
 *   • callQueueApi.myPermissions    → per-channel availability
 *   • callAvailabilityApi.*         → operator's own readiness
 */
import { useEffect, useState } from 'react';
import { Phone, Video, Bell, MicOff, Loader2, ChevronDown, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { callQueueApi, type CallQueueEntry } from '@/lib/call-queue-api';
import {
  callAvailabilityApi,
  type AvailabilityRow,
  type AvailabilityStatus,
} from '@/lib/call-availability-api';
import { toast } from '@/hooks/use-toast';

interface DockState {
  perms: {
    can_receive_audio_call: boolean;
    can_receive_video_call: boolean;
    can_join_queue_calls: boolean;
  } | null;
  waiting: number;
  availability: AvailabilityRow | null;
  saving: boolean;
}

const STATUS_LABELS: Record<AvailabilityStatus, string> = {
  available_both: 'Available (Audio + Video)',
  available_audio: 'Available (Audio only)',
  available_video: 'Available (Video only)',
  unavailable: 'Unavailable',
  busy: 'Busy',
};

function effectiveStatus(row: AvailabilityRow | null): AvailabilityStatus {
  if (!row) return 'unavailable';
  if (row.in_call) return 'busy';
  return row.status;
}

export function OperatorCallDock({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<DockState>({
    perms: null,
    waiting: 0,
    availability: null,
    saving: false,
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [p, av] = await Promise.all([
          callQueueApi.myPermissions(workspaceId),
          callAvailabilityApi.getMyAvailability(workspaceId).catch(() => null),
        ]);
        if (!cancelled) setState((s) => ({ ...s, perms: p, availability: av }));
      } catch {
        if (!cancelled) setState((s) => ({
          ...s,
          perms: { can_receive_audio_call: false, can_receive_video_call: false, can_join_queue_calls: false },
        }));
      }
    })();

    const refresh = async () => {
      try {
        const [r, av] = await Promise.all([
          callQueueApi.list(workspaceId),
          callAvailabilityApi.getMyAvailability(workspaceId).catch(() => null),
        ]);
        if (cancelled) return;
        const waiting = (r.entries as CallQueueEntry[]).filter(
          (e) => e.state === 'queued' || e.state === 'offered',
        ).length;
        setState((s) => ({ ...s, waiting, availability: av ?? s.availability }));
      } catch {
        /* network blips ok */
      }
    };
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [workspaceId]);

  const setAvailability = async (status: AvailabilityStatus) => {
    setState((s) => ({ ...s, saving: true }));
    try {
      const row = await callAvailabilityApi.setMyAvailability(workspaceId, status);
      setState((s) => ({ ...s, availability: row, saving: false }));
    } catch (e: any) {
      setState((s) => ({ ...s, saving: false }));
      toast({ title: 'Could not update availability', description: e?.message, variant: 'destructive' });
    }
  };

  const perms = state.perms;
  const anyCallPriv = !!perms && (perms.can_receive_audio_call || perms.can_receive_video_call || perms.can_join_queue_calls);
  if (!perms || !anyCallPriv) return null;

  const status = effectiveStatus(state.availability);
  const isBusy = status === 'busy';
  const isAvail = status === 'available_audio' || status === 'available_video' || status === 'available_both';
  const audioReady = perms.can_receive_audio_call && (status === 'available_audio' || status === 'available_both');
  const videoReady = perms.can_receive_video_call && (status === 'available_video' || status === 'available_both');

  // Disable options the operator doesn't actually have permission for.
  const items: { value: AvailabilityStatus; disabled: boolean }[] = [
    { value: 'available_both',  disabled: !(perms.can_receive_audio_call && perms.can_receive_video_call) },
    { value: 'available_audio', disabled: !perms.can_receive_audio_call },
    { value: 'available_video', disabled: !perms.can_receive_video_call },
    { value: 'unavailable',     disabled: false },
  ];

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 py-1.5 text-[11px] flex-wrap',
        'shadow-sm',
      )}
      role="status"
      aria-label="Operator call availability"
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium uppercase tracking-wide',
            isBusy ? 'bg-destructive/10 text-destructive'
              : isAvail ? 'bg-success/10 text-success'
              : 'bg-muted text-muted-foreground',
            'hover:opacity-80 transition-opacity',
          )}
          disabled={state.saving}
        >
          {state.saving ? <Loader2 className="h-3 w-3 animate-spin" /> : (
            <span className={cn('h-1.5 w-1.5 rounded-full',
              isBusy ? 'bg-destructive' : isAvail ? 'bg-success' : 'bg-muted-foreground')} />
          )}
          {STATUS_LABELS[status]}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="text-xs">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Call readiness
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {items.map((it) => (
            <DropdownMenuItem
              key={it.value}
              disabled={it.disabled || state.saving || isBusy}
              onClick={() => void setAvailability(it.value)}
              className="text-xs"
            >
              {state.availability?.status === it.value && !isBusy ? (
                <Check className="h-3 w-3 mr-2 text-success" />
              ) : <span className="w-3 mr-2" />}
              {STATUS_LABELS[it.value]}
            </DropdownMenuItem>
          ))}
          {isBusy && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1 text-[10px] text-muted-foreground">
                Locked while you are in a call.
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

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
