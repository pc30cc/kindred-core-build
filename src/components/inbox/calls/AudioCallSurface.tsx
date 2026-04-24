/**
 * Phase — Inbox Call Hardening · Pass 4
 *
 * Audio-first connected surface.
 *
 * Hard rules:
 *  - No <video> element. Not even hidden. Not even "camera off".
 *    A user on an audio call must NEVER see a black rectangle implying
 *    that camera is a possibility.
 *  - Renders the remote audio MediaStreamTrack via a single hidden
 *    <audio autoPlay> element so sound flows through the system speaker.
 *  - Visuals are: avatar/initial, contact label, status text + timer,
 *    waveform indicator, mic toggle, recording, end call.
 *
 * Drives ZERO lifecycle. Receives intent callbacks from the parent so
 * busy/cleanup remain owned by CallSessionEngine.
 */
import { useEffect, useRef } from 'react';
import { Mic, MicOff, PhoneOff, Circle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { CallTimer } from './CallTimer';
import { AudioWaveform } from './AudioWaveform';

function initialOf(name?: string | null): string {
  if (!name) return '?';
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : '?';
}

export interface AudioCallSurfaceProps {
  contactName?: string | null;
  /** Phase from the engine — used to pick label + freeze waveform on reconnect. */
  phase: 'connected' | 'reconnecting';
  startedAt: number | null;
  /** Remote audio track, attached to a hidden <audio> for playback. */
  remoteAudio: MediaStreamTrack | null;
  micEnabled: boolean;
  onToggleMic: () => void;
  onHangup: () => void;
  recording: boolean;
  onToggleRecording: () => void;
  /** Optional inline error (engine media error). */
  error?: string | null;
}

export function AudioCallSurface(props: AudioCallSurfaceProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (props.remoteAudio) {
      const stream = new MediaStream([props.remoteAudio]);
      el.srcObject = stream;
      el.play().catch(() => { /* autoplay may need a gesture */ });
    } else {
      el.srcObject = null;
    }
  }, [props.remoteAudio]);

  const isReconnecting = props.phase === 'reconnecting';

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card/60 p-2.5 min-w-[280px]">
      {/* Avatar / identity ─────────────────────────────────────────────── */}
      <div
        className={cn(
          'relative flex items-center justify-center w-10 h-10 rounded-full bg-success/10 text-success font-semibold text-sm shrink-0',
          !isReconnecting && 'animate-call-ring-pulse',
        )}
        aria-hidden
      >
        {initialOf(props.contactName)}
      </div>

      {/* Status + timer + waveform ─────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground truncate">
          <span className="truncate">{props.contactName || 'Visitor'}</span>
          {props.recording && (
            <Badge variant="destructive" className="h-4 px-1 text-[9px] font-semibold gap-0.5">
              <Circle className="w-2 h-2 fill-current" /> REC
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
          {isReconnecting ? (
            <span className="inline-flex items-center gap-1 text-warning">
              <Loader2 className="w-2.5 h-2.5 animate-spin" /> Reconnecting…
            </span>
          ) : (
            <>
              <AudioWaveform active className="text-success" />
              <CallTimer startedAt={props.startedAt} className="font-mono tabular-nums" />
              <span>· Audio call</span>
            </>
          )}
        </div>
        {props.error && (
          <div className="text-[10px] text-destructive mt-0.5 truncate">{props.error}</div>
        )}
      </div>

      {/* Controls ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 shrink-0">
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
          className="h-8 px-2.5 text-[10px] font-semibold"
          onClick={props.onHangup}
          aria-label="Hang up"
        >
          <PhoneOff className="w-3.5 h-3.5 mr-1" />
          End
        </Button>
      </div>

      {/* Hidden audio sink — never visible, never a video element. */}
      <audio ref={audioRef} autoPlay className="hidden" />
    </div>
  );
}