/**
 * Phase — Inbox Call Hardening · Pass 1 + 2 + 3 + 4
 *
 * Bounded module mounted inside the inbox header. Lifecycle is owned by
 * the shared CallSessionEngine via useCallSession(). This component is
 * a presentation orchestrator:
 *   - reads engine state (phase / errors / busy)
 *   - renders idle launchers + ringing-out surface
 *   - delegates the connected surface to AudioCallSurface or
 *     VideoCallSurface depending on engine.callType (Pass 4)
 *   - drives outgoing ringback via the central ringtone controller
 *     (Pass 3) — tied to engine.phase, stops on ANY non-ringing transition
 *
 * Hard guarantees inherited from the engine:
 *   - Busy lock is released on EVERY terminal path (token failure, invite
 *     failure, connect failure, media-permission denial, no-answer
 *     timeout, remote hangup, local hangup, ending timeout, unmount).
 *   - Token + RTC URLs always come from callsApi.token() (resolver-backed).
 *   - All errors surface inline via toast — never crash the inbox.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Phone, PhoneOff, Video, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { callsApi, type CallType } from '@/lib/calls-api';
import { useCallSession } from '@/hooks/useCallSession';
import { describePhase, isTerminalPhase } from '@/lib/calls/CallSessionEngine';
import { ringtone } from '@/lib/calls/ringtone';
import { AudioCallSurface } from './calls/AudioCallSurface';
import { VideoCallSurface } from './calls/VideoCallSurface';

interface OperatorCallPanelProps {
  workspaceId: string;
  conversationId: string;
  /** Optional visitor display name for token. */
  contactName?: string | null;
}

export function OperatorCallPanel({ workspaceId, conversationId, contactName }: OperatorCallPanelProps) {
  const session = useCallSession();
  const { state: engineState, media: lk } = session;
  const phase = engineState.phase;
  const callType = engineState.callType;
  const callId = engineState.callId;
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const lastErrorRef = useRef<string | null>(null);

  // First remote participant — the visitor side. Surfaces just consume tracks.
  const first = lk.remote[0];
  const remoteAudio = first?.audio ?? null;
  const remoteVideo = first?.video ?? null;

  // ── Pass 3 — Outgoing ringback ──────────────────────────────────────
  // Ringback plays only while the engine is actively ringing the visitor.
  // The controller is idempotent so duplicate effect runs are safe.
  useEffect(() => {
    if (phase === 'outgoing_ringing') {
      ringtone.start('ringback');
    } else {
      // Only stop ringback — don't touch the global incoming ringtone
      // (that one belongs to the IncomingCallSurface).
      if (ringtone.currentKind() === 'ringback') ringtone.stop();
    }
  }, [phase]);

  // Final safety net — if this surface unmounts mid-ring, cut the sound.
  useEffect(() => {
    return () => {
      if (ringtone.currentKind() === 'ringback') ringtone.stop();
    };
  }, []);

  const startCall = useCallback((type: CallType) => {
    if (phase !== 'idle') return;
    void session.startOutgoing({
      workspaceId,
      conversationId,
      callType: type,
      displayName: 'Operator',
    });
  }, [phase, session, workspaceId, conversationId]);

  const hangup = useCallback(() => {
    void session.hangup();
  }, [session]);

  const toggleRecording = useCallback(async () => {
    if (!callId) return;
    try {
      if (!recording) {
        const r = await callsApi.startRecording(callId);
        setRecordingId(r.recording_id);
        setRecording(true);
      } else if (recordingId) {
        await callsApi.stopRecording(callId, recordingId);
        setRecording(false);
      }
    } catch (e: any) {
      toast({
        title: recording ? 'Stop recording failed' : 'Start recording failed',
        description: e?.message || String(e),
        variant: 'destructive',
      });
    }
  }, [callId, recording, recordingId]);

  // Surface engine failures via toast — exactly once per failure.
  useEffect(() => {
    if (phase !== 'failed' && phase !== 'missed') return;
    const key = phase + ':' + (engineState.errorCode ?? '') + ':' + (engineState.errorMessage ?? '');
    if (lastErrorRef.current === key) return;
    lastErrorRef.current = key;
    toast({
      title: phase === 'missed' ? 'No answer' : 'Could not start call',
      description: engineState.errorMessage || 'The visitor did not answer.',
      variant: 'destructive',
    });
  }, [phase, engineState.errorCode, engineState.errorMessage]);

  // When a terminal phase settles, reset local recording bookkeeping
  // AND make sure ringback is silenced (belt & suspenders alongside the
  // phase-driven effect above — guards against a rapid terminal race).
  useEffect(() => {
    if (isTerminalPhase(phase)) {
      setRecordingId(null);
      setRecording(false);
      if (ringtone.currentKind() === 'ringback') ringtone.stop();
    }
  }, [phase]);

  // Treat terminal phases (after a brief moment) as idle for the launcher.
  const showLauncher = phase === 'idle' || isTerminalPhase(phase);

  // Idle launchers
  if (showLauncher) {
    return (
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-[10px] font-semibold"
          onClick={() => startCall('audio')}
          aria-label="Start audio call"
        >
          <Phone className="w-3 h-3" />
          <span className="hidden sm:inline">Call</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-[10px] font-semibold"
          onClick={() => startCall('video')}
          aria-label="Start video call"
        >
          <Video className="w-3 h-3" />
          <span className="hidden sm:inline">Video</span>
        </Button>
      </div>
    );
  }

  const isConnecting = phase === 'preparing' || phase === 'connecting';
  const isRinging = phase === 'outgoing_ringing';
  const isLive = phase === 'connected' || phase === 'reconnecting';
  const liveSurfacePhase = phase === 'reconnecting' ? 'reconnecting' : 'connected';

  // ── Connected: delegate to audio-first or video-first surface ───────
  if (isLive) {
    if (callType === 'video') {
      return (
        <VideoCallSurface
          contactName={contactName ?? null}
          phase={liveSurfacePhase}
          startedAt={engineState.startedAt}
          remoteAudio={remoteAudio}
          remoteVideo={remoteVideo}
          localVideo={lk.localVideo}
          micEnabled={lk.micEnabled}
          cameraEnabled={lk.cameraEnabled}
          onToggleMic={() => void lk.toggleMic()}
          onToggleCamera={() => void lk.toggleCamera()}
          onHangup={hangup}
          recording={recording}
          onToggleRecording={() => void toggleRecording()}
          error={lk.error}
        />
      );
    }
    return (
      <AudioCallSurface
        contactName={contactName ?? null}
        phase={liveSurfacePhase}
        startedAt={engineState.startedAt}
        remoteAudio={remoteAudio}
        micEnabled={lk.micEnabled}
        onToggleMic={() => void lk.toggleMic()}
        onHangup={hangup}
        recording={recording}
        onToggleRecording={() => void toggleRecording()}
        error={lk.error}
      />
    );
  }

  // ── Pre-connected: compact ringing/connecting bar with End button ───
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card/60 p-2 min-w-[240px]">
      <div className="flex items-center gap-2 min-w-0">
        {isConnecting && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
        {isRinging && <Loader2 className="w-3.5 h-3.5 animate-spin text-warning" />}
        <span className={cn(
          'text-[11px] font-semibold truncate',
          isRinging ? 'text-warning' : 'text-foreground',
        )}>
          {isRinging
            ? 'Ringing ' + (contactName || 'visitor') + '…'
            : describePhase(engineState)}
        </span>
      </div>
      <Button
        size="sm"
        variant="destructive"
        className="h-7 px-2.5 text-[10px] font-semibold"
        onClick={hangup}
        aria-label="Cancel call"
      >
        <PhoneOff className="w-3 h-3 mr-1" />
        Cancel
      </Button>
    </div>
  );
}