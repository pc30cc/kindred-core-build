/**
 * Phase — Inbox Call Hardening · Pass 4
 *
 * Video-first connected surface.
 *
 * Layout: a 16:9 remote video stage as the primary element, with a small
 * picture-in-picture local preview pinned bottom-right and a control bar
 * underneath. Reconnecting renders an overlay over the stage rather than
 * collapsing the layout — operators can keep the call frame even while
 * the line briefly drops.
 *
 * The surface attaches MediaStreamTracks to <video> elements via
 * srcObject. We do NOT touch the engine — the parent passes hangup +
 * mic/camera intents.
 */
import { useEffect, useRef } from 'react';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Circle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { CallTimer } from './CallTimer';

export interface VideoCallSurfaceProps {
  contactName?: string | null;
  phase: 'connected' | 'reconnecting';
  startedAt: number | null;
  remoteAudio: MediaStreamTrack | null;
  remoteVideo: MediaStreamTrack | null;
  /** Local preview track (camera). Optional — null until camera publishes. */
  localVideo?: MediaStreamTrack | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onHangup: () => void;
  recording: boolean;
  onToggleRecording: () => void;
  error?: string | null;
}

export function VideoCallSurface(props: VideoCallSurfaceProps) {
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = remoteVideoRef.current;
    if (!v) return;
    if (props.remoteVideo) {
      v.srcObject = new MediaStream([props.remoteVideo]);
      v.play().catch(() => { /* autoplay */ });
    } else {
      v.srcObject = null;
    }
  }, [props.remoteVideo]);

  useEffect(() => {
    const a = remoteAudioRef.current;
    if (!a) return;
    if (props.remoteAudio) {
      a.srcObject = new MediaStream([props.remoteAudio]);
      a.play().catch(() => { /* */ });
    } else {
      a.srcObject = null;
    }
  }, [props.remoteAudio]);

  useEffect(() => {
    const v = localVideoRef.current;
    if (!v) return;
    if (props.localVideo) {
      v.srcObject = new MediaStream([props.localVideo]);
      v.play().catch(() => { /* */ });
    } else {
      v.srcObject = null;
    }
  }, [props.localVideo]);

  const isReconnecting = props.phase === 'reconnecting';

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/60 p-2 min-w-[280px]">
      {/* Remote stage ────────────────────────────────────────────────── */}
      <div className="relative w-full aspect-video rounded-md bg-black overflow-hidden">
        <video
          ref={remoteVideoRef}
          className="w-full h-full object-contain bg-black"
          autoPlay
          playsInline
          muted={false}
        />
        {!props.remoteVideo && !isReconnecting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-1 text-[10px]">
            <VideoOff className="w-5 h-5 opacity-60" />
            Waiting for remote video…
          </div>
        )}
        {isReconnecting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-warning text-[11px] gap-1">
            <Loader2 className="w-4 h-4 animate-spin" />
            Reconnecting…
          </div>
        )}

        {/* Local PIP preview */}
        {props.cameraEnabled && (
          <div className="absolute bottom-1.5 right-1.5 w-1/4 max-w-[96px] aspect-video rounded border border-border/60 overflow-hidden bg-black shadow-md">
            <video
              ref={localVideoRef}
              className="w-full h-full object-cover"
              autoPlay
              playsInline
              muted
            />
          </div>
        )}

        {/* Top label row: contact + timer + REC */}
        <div className="absolute top-1.5 left-1.5 right-1.5 flex items-center gap-1.5 text-[10px] text-white/95 drop-shadow">
          <span className="font-semibold truncate flex-1">{props.contactName || 'Visitor'}</span>
          <CallTimer startedAt={props.startedAt} className="font-mono tabular-nums bg-black/40 rounded px-1 py-0.5" />
          {props.recording && (
            <Badge variant="destructive" className="h-4 px-1 text-[9px] font-semibold gap-0.5">
              <Circle className="w-2 h-2 fill-current" /> REC
            </Badge>
          )}
        </div>
      </div>

      {/* Controls ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant={props.micEnabled ? 'outline' : 'secondary'}
          className="h-8 w-8 p-0"
          onClick={props.onToggleMic}
          aria-label={props.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
        >
          {props.micEnabled ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
        </Button>
        <Button
          size="sm"
          variant={props.cameraEnabled ? 'outline' : 'secondary'}
          className="h-8 w-8 p-0"
          onClick={props.onToggleCamera}
          aria-label={props.cameraEnabled ? 'Stop camera' : 'Start camera'}
        >
          {props.cameraEnabled ? <Video className="w-3.5 h-3.5" /> : <VideoOff className="w-3.5 h-3.5" />}
        </Button>
        <Button
          size="sm"
          variant={props.recording ? 'destructive' : 'outline'}
          className={cn('h-8 w-8 p-0', props.recording && 'animate-pulse')}
          onClick={props.onToggleRecording}
          aria-label={props.recording ? 'Stop recording' : 'Start recording'}
        >
          <Circle className={cn('w-3 h-3', props.recording && 'fill-current')} />
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="h-8 px-2.5 text-[10px] font-semibold ml-auto"
          onClick={props.onHangup}
          aria-label="Hang up"
        >
          <PhoneOff className="w-3.5 h-3.5 mr-1" />
          End
        </Button>
      </div>

      {props.error && (
        <p className="text-[10px] text-destructive">{props.error}</p>
      )}

      {/* Hidden audio sink — video element is muted-on-attach in some
          browsers; routing audio through a separate sink avoids losing
          remote voice while video is buffering. */}
      <audio ref={remoteAudioRef} autoPlay className="hidden" />
    </div>
  );
}