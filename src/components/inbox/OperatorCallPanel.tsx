/**
 * Phase — Inbox Call Hardening · Pass 1 + 2
 *
 * Bounded module mounted inside the inbox header. Lifecycle is owned by
 * the shared CallSessionEngine via useCallSession(). This component is
 * now a thin presentation layer:
 *   - reads engine state (phase / errors / busy)
 *   - renders idle launchers, ringing, and connected controls
 *   - forwards user intent (start / hang up / toggle mic / toggle camera /
 *     start-stop recording) to the engine or to the media transport
 *
 * Hard guarantees inherited from the engine:
 *   - Busy lock is released on EVERY terminal path (token failure, invite
 *     failure, connect failure, media-permission denial, no-answer
 *     timeout, remote hangup, local hangup, ending timeout, unmount).
 *   - Token + RTC URLs always come from callsApi.token() (resolver-backed).
 *   - All errors surface inline via toast — never crash the inbox.
 *
 * Intentionally deferred to later passes (per scope decision):
 *   - Audio vs Video presentation split (Pass 4)
 *   - Real ringtone / ringback audio + incoming-call surface (Pass 3)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Phone, PhoneOff, Video, VideoOff, Mic, MicOff, Loader2, Circle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { callsApi, type CallType } from '@/lib/calls-api';
import { useCallSession } from '@/hooks/useCallSession';
import { describePhase, isTerminalPhase } from '@/lib/calls/CallSessionEngine';

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

  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // Attach remote tracks to the audio/video elements.
  useEffect(() => {
    const first = lk.remote[0];
    const audioEl = remoteAudioRef.current;
    const videoEl = remoteVideoRef.current;
    if (audioEl) {
      if (first?.audio) {
        const stream = new MediaStream([first.audio]);
        audioEl.srcObject = stream;
        audioEl.play().catch(() => { /* user gesture may be required */ });
      } else {
        audioEl.srcObject = null;
      }
    }
    if (videoEl) {
      if (first?.video) {
        const stream = new MediaStream([first.video]);
        videoEl.srcObject = stream;
        videoEl.play().catch(() => { /* ignore autoplay errors */ });
      } else {
        videoEl.srcObject = null;
      }
    }
  }, [lk.remote]);

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

  // When a terminal phase settles, also reset our local recording bookkeeping.
  useEffect(() => {
    if (isTerminalPhase(phase)) {
      setRecordingId(null);
      setRecording(false);
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

  // Active call surface (compact, fits inside header row, expands below)
  return (
    <div className="flex flex-col items-stretch gap-2 rounded-lg border border-border bg-card/60 p-2 min-w-[260px]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isConnecting && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          {isRinging && <Loader2 className="w-3.5 h-3.5 animate-spin text-warning" />}
          {isLive && (
            <span className={cn(
              'inline-flex w-2 h-2 rounded-full',
              phase === 'reconnecting' ? 'bg-warning animate-pulse' : 'bg-success animate-pulse',
            )} aria-hidden />
          )}
          <span className="text-[11px] font-semibold text-foreground truncate">
            {isRinging
              ? 'Ringing ' + (contactName || 'visitor') + '...'
              : describePhase(engineState)}
          </span>
          {recording && (
            <Badge variant="destructive" className="h-5 px-1.5 text-[9px] font-semibold gap-1">
              <Circle className="w-2 h-2 fill-current" /> REC
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          variant="destructive"
          className="h-7 px-2.5 text-[10px] font-semibold"
          onClick={hangup}
          aria-label="Hang up"
        >
          <PhoneOff className="w-3 h-3" />
          End
        </Button>
      </div>

      {isLive && (
        <>
          {callType === 'video' && (
            <video
              ref={remoteVideoRef}
              className="w-full max-h-48 rounded-md bg-black object-contain"
              autoPlay
              playsInline
            />
          )}
          <audio ref={remoteAudioRef} autoPlay />
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={lk.micEnabled ? 'outline' : 'secondary'}
              className="h-7 px-2 text-[10px]"
              onClick={() => void lk.toggleMic()}
              aria-label={lk.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
            >
              {lk.micEnabled ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3" />}
            </Button>
            <Button
              size="sm"
              variant={lk.cameraEnabled ? 'outline' : 'secondary'}
              className="h-7 px-2 text-[10px]"
              onClick={() => void lk.toggleCamera()}
              aria-label={lk.cameraEnabled ? 'Stop camera' : 'Start camera'}
            >
              {lk.cameraEnabled ? <Video className="w-3 h-3" /> : <VideoOff className="w-3 h-3" />}
            </Button>
            <Button
              size="sm"
              variant={recording ? 'destructive' : 'outline'}
              className={cn('h-7 px-2 text-[10px] ml-auto', recording && 'animate-pulse')}
              onClick={() => void toggleRecording()}
              aria-label={recording ? 'Stop recording' : 'Start recording'}
            >
              <Circle className={cn('w-3 h-3', recording && 'fill-current')} />
              {recording ? 'Stop' : 'Rec'}
            </Button>
          </div>
          {phase === 'reconnecting' && (
            <p className="text-[10px] text-warning">Reconnecting...</p>
          )}
          {lk.error && (
            <p className="text-[10px] text-destructive">{lk.error}</p>
          )}
        </>
      )}
    </div>
  );
}