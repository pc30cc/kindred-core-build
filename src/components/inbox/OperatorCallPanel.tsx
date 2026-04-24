/**
 * Phase 8B - Operator Call Panel.
 *
 * Bounded module mounted inside the inbox header. Owns one call session
 * lifecycle at a time. Token + URLs always come from the backend.
 *
 * Strict rules:
 *  - No page reload, no inbox refactor.
 *  - All RTC URLs/TURN come from callsApi.token() (resolver-backed).
 *  - All errors surface inline via toast - never crash the inbox.
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
import { useLiveKitCall } from '@/hooks/useLiveKitCall';

interface OperatorCallPanelProps {
  workspaceId: string;
  conversationId: string;
  /** Optional visitor display name for token. */
  contactName?: string | null;
}

type Phase = 'idle' | 'creating' | 'ringing' | 'in_call' | 'ending';

export function OperatorCallPanel({ workspaceId, conversationId, contactName }: OperatorCallPanelProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [callType, setCallType] = useState<CallType>('audio');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const lk = useLiveKitCall({ publishMic: true, publishCamera: false });

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

  const cleanup = useCallback(async () => {
    await lk.disconnect();
    setCallId(null);
    setRecordingId(null);
    setRecording(false);
    setPhase('idle');
  }, [lk]);

  const startCall = useCallback(async (type: CallType) => {
    if (phase !== 'idle') return;
    setCallType(type);
    setPhase('creating');
    let createdId: string | null = null;
    try {
      const created = await callsApi.create({
        workspace_id: workspaceId,
        call_type: type,
        context_type: 'conversation',
        context_id: conversationId,
      });
      createdId = created.id;
      setCallId(created.id);
      // Invite the visitor (server marks state=ringing + emits call_event).
      await callsApi.invite(created.id, { participant_type: 'visitor' });
      setPhase('ringing');
      // Mint participant token + TURN bundle.
      const tok = await callsApi.token(created.id, {
        display_name: 'Operator',
        ttl_seconds: 600,
      });
      if (!tok.ws_url) throw new Error('Backend did not return ws_url. Configure LiveKit RTC URL in admin.');
      const iceServers: RTCIceServer[] = [];
      if (tok.turn?.urls?.length) {
        iceServers.push({
          urls: tok.turn.urls,
          username: tok.turn.username || undefined,
          credential: tok.turn.credential || undefined,
        });
      }
      await lk.connect({
        wsUrl: tok.ws_url,
        token: tok.token,
        iceServers: iceServers.length ? iceServers : undefined,
        iceTransportPolicy: tok.ice_policy,
      });
      // Mark as accepted on our side (server transitions to in_progress).
      try { await callsApi.accept(created.id); } catch { /* non-fatal */ }
      setPhase('in_call');
    } catch (e: any) {
      toast({
        title: 'Could not start call',
        description: e?.message || String(e),
        variant: 'destructive',
      });
      if (createdId) {
        try { await callsApi.hangup(createdId); } catch { /* ignore */ }
      }
      await cleanup();
    }
  }, [phase, workspaceId, conversationId, lk, cleanup]);

  const hangup = useCallback(async () => {
    if (!callId) { await cleanup(); return; }
    setPhase('ending');
    try { await callsApi.hangup(callId); } catch { /* ignore */ }
    await cleanup();
  }, [callId, cleanup]);

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

  // Reflect remote disconnect into our local phase.
  useEffect(() => {
    if (phase === 'in_call' && (lk.state === 'disconnected' || lk.state === 'failed')) {
      void cleanup();
    }
  }, [lk.state, phase, cleanup]);

  // Idle launchers
  if (phase === 'idle') {
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

  // Active call surface (compact, fits inside header row, expands below)
  return (
    <div className="flex flex-col items-stretch gap-2 rounded-lg border border-border bg-card/60 p-2 min-w-[260px]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {phase === 'creating' && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          {phase === 'ringing' && <Loader2 className="w-3.5 h-3.5 animate-spin text-warning" />}
          {phase === 'in_call' && (
            <span className="inline-flex w-2 h-2 rounded-full bg-success animate-pulse" aria-hidden />
          )}
          <span className="text-[11px] font-semibold text-foreground truncate">
            {phase === 'creating' && 'Starting call...'}
            {phase === 'ringing' && 'Ringing ' + (contactName || 'visitor') + '...'}
            {phase === 'in_call' && 'In call' + (callType === 'video' ? ' (video)' : '')}
            {phase === 'ending' && 'Ending...'}
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

      {phase === 'in_call' && (
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
          {lk.state === 'reconnecting' && (
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