/**
 * Call Center — operator recording controls.
 *
 * Two pieces that share ONE polled status read:
 *   • `useOperatorRecording()` — the status + start/stop actions.
 *   • `<RecordingToolbarButton>` — the single record/stop button that lives
 *     inside the media console's control bar, next to mute and hang-up,
 *     the way a real agent desktop puts it.
 *   • `<RecordingStatusStrip>` — the thin status line under the toolbar
 *     (state, consent, recording id, and a link to playback once saved).
 *
 * STRICT: never renders a storage path or signed URL. Playback is reached
 * through the existing Recordings surfaces, which mint their own tokens.
 */
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Disc, Loader2, RefreshCw, Square, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { callCenterApi, type CallCenterRecordingStatus } from '@/lib/call-center-api';
import { useTranslation } from '@/i18n';
import { recordingErrorMessage, recordingReasonLabel, recordingStateLabel } from '@/features/calls/callLabels';

export interface OperatorRecording {
  status: CallCenterRecordingStatus | undefined;
  isFetching: boolean;
  refetch: () => void;
  /** Capability + consent are satisfied and the provider can record. */
  effective: boolean;
  consentRequired: boolean;
  consentOk: boolean;
  state: string;
  isRecording: boolean;
  /** True while the provider is starting or finalizing — no action allowed. */
  isBusyState: boolean;
  /** A finished artifact exists for this call. */
  hasArtifact: boolean;
  canStart: boolean;
  canStop: boolean;
  busy: 'start' | 'stop' | null;
  start: () => void;
  stop: () => void;
  label: string;
  reason: string | null;
}

/**
 * Poll the call's recording status and expose start/stop.
 *
 * Polls only while the call can still change recording state — a finished
 * (`available`) or permanently unavailable recording stops the timer, so an
 * open wrap-up panel does not keep hitting the API forever.
 */
export function useOperatorRecording(
  workspaceId: string | undefined,
  callId: string | null,
  callConnected: boolean,
): OperatorRecording {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);

  const { data: status, refetch, isFetching } = useQuery<CallCenterRecordingStatus>({
    queryKey: ['call-center', 'recording-status', workspaceId, callId],
    queryFn: () => callCenterApi.getRecordingStatus(workspaceId!, callId!),
    enabled: !!workspaceId && !!callId,
    refetchInterval: (query) => {
      const s = query.state.data?.recording_state;
      // Terminal for this call — nothing left to poll for.
      if (s === 'available' || s === 'disabled') return false;
      return 4000;
    },
  });

  const cap = status?.capability;
  const state = status?.recording_state || 'disabled';
  const effective = !!cap?.effective_enabled;
  const consentRequired = !!cap?.consent_required;
  const consentOk = !consentRequired || !!status?.consent_given;
  const isRecording = state === 'recording';
  const isBusyState = state === 'pending' || state === 'finalizing';
  const hasArtifact = state === 'available';

  const canStart =
    effective && consentOk && callConnected && busy === null
    && (state === 'disabled' || state === 'failed');
  const canStop = (isRecording || state === 'pending') && busy === null;

  const startMutation = useMutation({
    mutationFn: () => callCenterApi.startRecording(workspaceId!, callId!, 'composite'),
    onSuccess: () => {
      void refetch();
      qc.invalidateQueries({ queryKey: ['call-center'] });
    },
    onError: (e: unknown) => {
      toast({
        title: t('callCenter.rec.startFailed'),
        description: recordingErrorMessage(t, e),
        variant: 'destructive',
      });
    },
    onSettled: () => setBusy(null),
  });

  const stopMutation = useMutation({
    mutationFn: () => callCenterApi.stopRecording(workspaceId!, callId!),
    onSuccess: () => {
      void refetch();
      qc.invalidateQueries({ queryKey: ['call-center'] });
    },
    onError: (e: unknown) => {
      toast({
        title: t('callCenter.rec.stopFailed'),
        description: recordingErrorMessage(t, e),
        variant: 'destructive',
      });
    },
    onSettled: () => setBusy(null),
  });

  const start = useCallback(() => {
    if (!workspaceId || !callId) return;
    setBusy('start');
    startMutation.mutate();
  }, [workspaceId, callId, startMutation]);

  const stop = useCallback(() => {
    if (!workspaceId || !callId) return;
    setBusy('stop');
    stopMutation.mutate();
  }, [workspaceId, callId, stopMutation]);

  // Label priority: an unmet prerequisite always wins over the raw state, so
  // the operator reads WHY they cannot record rather than just "off".
  let label: string;
  let reason: string | null = null;
  if (!effective) {
    label = recordingStateLabel(t, 'disabled');
    reason = recordingReasonLabel(t, cap?.reason || status?.reason);
  } else if (!consentOk) {
    label = recordingStateLabel(t, 'consent_pending');
    reason = recordingReasonLabel(t, 'consent_missing');
  } else if (state === 'disabled' || state === 'failed') {
    label = recordingStateLabel(t, state === 'failed' ? 'failed' : 'ready');
    if (state === 'failed' && status?.last_error) reason = status.last_error;
  } else {
    label = recordingStateLabel(t, state);
  }

  return {
    status, isFetching, refetch: () => void refetch(),
    effective, consentRequired, consentOk, state,
    isRecording, isBusyState, hasArtifact,
    canStart, canStop, busy,
    start, stop, label, reason,
  };
}

/** The record / stop button that sits in the media console's control bar. */
export function RecordingToolbarButton({ rec }: { rec: OperatorRecording }) {
  const { t } = useTranslation();
  if (!rec.effective) return null;

  if (rec.canStop || rec.isRecording) {
    return (
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="bg-rose-600 text-white hover:bg-rose-500"
        onClick={rec.stop}
        disabled={!rec.canStop}
        title={t('callCenter.rec.stop')}
      >
        {rec.busy === 'stop'
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <Square className="h-4 w-4 fill-current" />}
        <span className="ms-1.5">{t('callCenter.rec.stop')}</span>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={rec.start}
      disabled={!rec.canStart}
      title={rec.reason || t('callCenter.rec.start')}
    >
      {rec.busy === 'start'
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : <Disc className={cn('h-4 w-4', rec.isBusyState && 'animate-pulse')} />}
      <span className="ms-1.5">{t('callCenter.rec.start')}</span>
    </Button>
  );
}

/** Thin status strip rendered under the console toolbar. */
export function RecordingStatusStrip({
  rec,
  recordingsHref,
}: {
  rec: OperatorRecording;
  recordingsHref?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 font-medium',
          rec.isRecording ? 'text-rose-400'
            : rec.hasArtifact ? 'text-emerald-400'
            : rec.state === 'failed' ? 'text-destructive'
            : rec.effective && rec.consentOk ? 'text-zinc-300'
            : 'text-zinc-500',
        )}
      >
        <Disc className={cn('h-3.5 w-3.5', rec.isRecording && 'animate-pulse')} />
        {rec.label}
      </span>

      {rec.consentRequired && (
        <span
          className={cn(
            'inline-flex items-center gap-1',
            rec.consentOk ? 'text-emerald-400' : 'text-amber-400',
          )}
        >
          {rec.consentOk ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
          {rec.consentOk ? t('callCenter.rec.consentGiven') : t('callCenter.rec.consentRequired')}
        </span>
      )}

      {rec.reason && <span className="text-zinc-500">{rec.reason}</span>}

      {rec.status?.recording_id_masked && (
        <span className="font-mono text-zinc-600">
          {t('callCenter.rec.idLabel')}: {rec.status.recording_id_masked}
        </span>
      )}

      <span className="ms-auto flex items-center gap-2">
        {rec.hasArtifact && recordingsHref && (
          <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-emerald-400 hover:text-emerald-300">
            <Link to={recordingsHref}>{t('callCenter.rec.openRecordings')}</Link>
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-zinc-400"
          onClick={rec.refetch}
          disabled={rec.isFetching}
          title={t('callCenter.rec.refresh')}
          aria-label={t('callCenter.rec.refresh')}
        >
          <RefreshCw className={cn('h-3 w-3', rec.isFetching && 'animate-spin')} />
        </Button>
      </span>
    </div>
  );
}
