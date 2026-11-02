/**
 * The screens of a colleague call in the web panel (TEAM_CALLS.md, "Web
 * panel"), drawn above everything by TeamCallProvider from its session and
 * downloaded the first time a call rings or is placed:
 *
 *  - the ringing card (an incoming call): the colleague's photo or the
 *    person silhouette, never a letter; their name; voice or video; Answer
 *    (a video call also without the camera) and Decline;
 *  - the call window (placing, ringing the colleague, joining, on, ended):
 *    LiveKit through the panel's call stack (useLiveKitCall, CallStage),
 *    with mute, camera (video calls), the speaker where the browser can
 *    choose one, and hang up. It stays above the panel as the member moves
 *    around in it; closing the tab ends the call.
 *
 * Identity in the room is the server's (`internal:<opaque ref>` and the
 * profile name, POST /api/team-calls/:id/token): nothing here names a user.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import { Avatar, AvatarImage } from '@/components/ui/avatar';
import { OperatorAvatarFallback } from '@/components/ui/operator-avatar-fallback';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { useLiveKitCall } from '@/hooks/useLiveKitCall';
import { AudioCallStage, LocalVideoPiP, VideoCallStage } from '@/features/calls/CallStage';
import { teamCallsApi } from '@/lib/team-calls-api';
import { peerDisplayName, useTeamCall, type TeamCallContextValue, type TeamCallSession } from './teamCallState';

function PeerAvatar({ session, className, iconClassName }: { session: TeamCallSession; className?: string; iconClassName?: string }) {
  return (
    <Avatar className={className} data-team-call-avatar>
      {session.peer.avatar_url ? <AvatarImage src={session.peer.avatar_url} alt="" /> : null}
      <OperatorAvatarFallback iconClassName={iconClassName} />
    </Avatar>
  );
}

// ─── The ringing card ───────────────────────────────────────────────────

function IncomingCard({ session, ctx }: { session: TeamCallSession; ctx: TeamCallContextValue }) {
  const { t, dir } = useTranslation();
  const name = peerDisplayName(session.peer, t('teamCall.colleague'));
  const video = session.channel === 'video';
  const title = t(video ? 'teamCall.incomingVideo' : 'teamCall.incomingVoice');
  return (
    <div
      dir={dir}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="team-call-ring-name"
      aria-describedby="team-call-ring-kind"
      data-team-call="ringing"
      className="fixed inset-x-0 top-4 z-[200] mx-auto w-[min(92vw,380px)] rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-elevated ring-1 ring-foreground/10 animate-in fade-in slide-in-from-top-2"
    >
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <span className="absolute inset-0 rounded-full bg-emerald-500/30 animate-ping" aria-hidden="true" />
          <PeerAvatar session={session} className="relative h-14 w-14" />
        </div>
        <div className="min-w-0 flex-1">
          <p id="team-call-ring-name" className="truncate text-[15px] font-semibold">{name}</p>
          <p id="team-call-ring-kind" className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            {video ? <Video className="h-3.5 w-3.5" aria-hidden="true" /> : <Phone className="h-3.5 w-3.5" aria-hidden="true" />}
            {title}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => { void ctx.decline(); }}
          className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-destructive px-4 text-sm font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90"
        >
          <PhoneOff className="h-4 w-4" aria-hidden="true" />
          {t('teamCall.decline')}
        </button>
        {video && (
          <button
            type="button"
            onClick={() => { void ctx.answer(false); }}
            className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-full border border-border bg-secondary px-4 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/80"
          >
            <Phone className="h-4 w-4" aria-hidden="true" />
            {t('teamCall.answerWithoutVideo')}
          </button>
        )}
        {/* Never focused on its own: the ring arrives while the member may be
            typing, and an Enter or a space meant for the composer must not
            answer (a video call with the camera on). */}
        <button
          type="button"
          onClick={() => { void ctx.answer(true); }}
          className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-emerald-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-emerald-600/90"
        >
          {video ? <Video className="h-4 w-4" aria-hidden="true" /> : <Phone className="h-4 w-4" aria-hidden="true" />}
          {video ? t('teamCall.answerVideo') : t('teamCall.answer')}
        </button>
      </div>
    </div>
  );
}

// ─── The call window ────────────────────────────────────────────────────

function useElapsed(running: boolean): number {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setStartedAt((at) => at ?? Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

function clock(seconds: number, locale: string): string {
  const nf = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US', { minimumIntegerDigits: 2, useGrouping: false });
  return `${nf.format(Math.floor(seconds / 60))}:${nf.format(seconds % 60)}`;
}

/** The audio outputs the browser lets a page choose, or none. */
function useAudioOutputs(enabled: boolean): MediaDeviceInfo[] {
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!enabled) return;
    if (typeof HTMLMediaElement === 'undefined' || !('setSinkId' in HTMLMediaElement.prototype)) return;
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return;
    let alive = true;
    const read = () => {
      md.enumerateDevices()
        .then((all) => { if (alive) setOutputs(all.filter((d) => d.kind === 'audiooutput' && d.deviceId)); })
        .catch(() => { /* none to offer */ });
    };
    read();
    md.addEventListener?.('devicechange', read);
    return () => {
      alive = false;
      md.removeEventListener?.('devicechange', read);
    };
  }, [enabled]);
  return outputs;
}

function ControlButton({
  label,
  onClick,
  active = true,
  danger = false,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors disabled:opacity-50',
        danger
          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
          : active
            ? 'bg-secondary text-foreground hover:bg-secondary/80'
            : 'bg-foreground text-background hover:bg-foreground/90',
      )}
    >
      {children}
    </button>
  );
}

/** Leaves the room when there is one (a join that is still on its way checks the phase itself). */
function leaveRoom(live: ReturnType<typeof useLiveKitCall>, reason: 'server_call_ended' | 'explicit_hangup') {
  if (live.state === 'connecting' || live.state === 'connected' || live.state === 'reconnecting') {
    void live.disconnect(reason);
  }
}

function CallWindow({ session, ctx }: { session: TeamCallSession; ctx: TeamCallContextValue }) {
  const { t, dir, locale } = useTranslation();
  const video = session.channel === 'video';
  // A video call whose camera cannot open (none here, in use, refused) goes
  // on as a voice call: a connect that failed would leave the room and so
  // end the call for both.
  const live = useLiveKitCall({ publishMic: true, publishCamera: session.withCamera, cameraOptional: true });
  const [expanded, setExpanded] = useState(video);
  const [outputId, setOutputId] = useState('');
  const phaseRef = useRef(session.phase);
  phaseRef.current = session.phase;
  const joinStartedRef = useRef(false);
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => { unmountedRef.current = true; };
  }, []);
  const liveRef = useRef(live);
  liveRef.current = live;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const callId = session.call?.id ?? null;
  const joined = live.state === 'connected' || live.state === 'reconnecting';
  const elapsed = useElapsed(session.phase === 'active' && joined);
  const outputs = useAudioOutputs(joined);

  // Answered: the token, then the room. Only this call's own token.
  useEffect(() => {
    if (!callId || session.phase !== 'connecting' || joinStartedRef.current) return;
    joinStartedRef.current = true;
    // Read afresh after every wait: the call may end while the join is on its way.
    const phaseNow = (): TeamCallSession['phase'] => phaseRef.current;
    void (async () => {
      try {
        const tok = await teamCallsApi.token(callId);
        // Over while the token was on its way: never join.
        if (phaseNow() !== 'connecting' || unmountedRef.current) return;
        if (!tok.ws_url) throw new Error('missing_ws_url');
        await liveRef.current.connect({
          wsUrl: tok.ws_url,
          token: tok.token,
          iceServers: tok.turn?.urls?.length
            ? [{ urls: tok.turn.urls, username: tok.turn.username || undefined, credential: tok.turn.credential || undefined }]
            : undefined,
          iceTransportPolicy: tok.ice_policy,
        });
        if (phaseNow() === 'ended' || unmountedRef.current) {
          void liveRef.current.disconnect('server_call_ended');
          return;
        }
        ctxRef.current.markJoined();
      } catch (err) {
        if (phaseNow() === 'ended' || unmountedRef.current) return;
        void ctxRef.current.failJoin(err);
      }
    })();
  }, [callId, session.phase]);

  // Over: leave the room at once. The window closes (the session is gone):
  // never leave a room behind.
  useEffect(() => {
    if (session.phase === 'ended') leaveRoom(liveRef.current, 'server_call_ended');
  }, [session.phase]);
  useEffect(() => () => { leaveRoom(liveRef.current, 'explicit_hangup'); }, []);

  const name = peerDisplayName(session.peer, t('teamCall.colleague'));
  const status = (() => {
    switch (session.phase) {
      case 'placing': return t('teamCall.calling');
      case 'outgoing': return t('teamCall.ringing');
      case 'answering':
      case 'connecting': return t('teamCall.connecting');
      case 'active': return live.state === 'reconnecting' ? t('teamCall.reconnecting') : clock(elapsed, locale);
      case 'ended': return session.notice ? t(session.notice.key, session.notice.params) : t('teamCall.ended');
      default: return '';
    }
  })();
  const over = session.phase === 'ended';
  const remoteVideo = live.remote.some((r) => !!r.videoTrack);
  const showVideoStage = video && expanded && !over;

  return (
    <div
      dir={dir}
      role="dialog"
      aria-modal="false"
      aria-label={t(video ? 'teamCall.callVideoWith' : 'teamCall.callVoiceWith', { name })}
      data-team-call="window"
      data-team-call-phase={session.phase}
      className={cn(
        'fixed bottom-4 end-4 z-[190] flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-elevated ring-1 ring-foreground/10',
        showVideoStage ? 'w-[min(92vw,520px)]' : 'w-[min(92vw,340px)]',
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <PeerAvatar session={session} className="h-10 w-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold">{name}</p>
          <p className="flex items-center gap-1.5 truncate text-[12px] text-muted-foreground" aria-live="polite">
            {(session.phase === 'answering' || session.phase === 'connecting' || session.phase === 'placing') && (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            )}
            <span dir={session.phase === 'active' && live.state !== 'reconnecting' ? 'ltr' : undefined}>{status}</span>
          </p>
        </div>
        {video && !over && (
          <button
            type="button"
            aria-label={expanded ? t('teamCall.minimize') : t('teamCall.expand')}
            title={expanded ? t('teamCall.minimize') : t('teamCall.expand')}
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* The media: video stage for a video call (opened), else the audio
          stage, which also plays the colleague's voice. */}
      {!over && (showVideoStage ? (
        <div className="relative aspect-video w-full bg-call-stage">
          {remoteVideo ? (
            <VideoCallStage remote={live.remote} size="large" />
          ) : (
            <div className="absolute inset-0">
              <AudioCallStage remote={live.remote} face={<PeerAvatar session={session} className="relative h-20 w-20" />} />
            </div>
          )}
          {session.withCamera || live.cameraEnabled ? (
            <LocalVideoPiP
              track={live.localVideoTrack}
              cameraEnabled={live.cameraEnabled}
              offLabel={t('teamCall.cameraIsOff')}
              className="absolute bottom-2 end-2 h-24 w-32 overflow-hidden rounded-lg ring-1 ring-white/20"
            />
          ) : null}
        </div>
      ) : (
        <div className={cn('relative w-full', joined ? 'h-48' : 'h-0 overflow-hidden')}>
          <AudioCallStage remote={live.remote} face={<PeerAvatar session={session} className="relative h-20 w-20" />} />
        </div>
      ))}

      {!over && (
        <div className="flex items-center justify-center gap-2.5 border-t border-border px-3 py-2.5">
          {joined && (
            <ControlButton
              label={live.micEnabled ? t('teamCall.mute') : t('teamCall.unmute')}
              active={live.micEnabled}
              onClick={() => { void live.toggleMic().catch(() => { /* the state stays as it was */ }); }}
            >
              {live.micEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
            </ControlButton>
          )}
          {joined && video && (
            <ControlButton
              label={live.cameraEnabled ? t('teamCall.cameraOff') : t('teamCall.cameraOn')}
              active={live.cameraEnabled}
              onClick={() => { void live.toggleCamera().catch(() => { /* no camera to open: it stays off */ }); }}
            >
              {live.cameraEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
            </ControlButton>
          )}
          {joined && outputs.length > 1 && (
            <label className="relative inline-flex h-10 items-center gap-1.5 rounded-full bg-secondary px-3 text-foreground" title={t('teamCall.speaker')}>
              <Volume2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="sr-only">{t('teamCall.speaker')}</span>
              <select
                value={outputId}
                onChange={(e) => {
                  const id = e.target.value;
                  setOutputId(id);
                  void live.setAudioOutput(id || 'default');
                }}
                className="max-w-[9rem] truncate bg-transparent text-[12px] outline-none"
              >
                <option value="">{t('teamCall.speakerDefault')}</option>
                {outputs.filter((d) => d.deviceId !== 'default').map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `${t('teamCall.speaker')} ${i + 1}`}</option>
                ))}
              </select>
            </label>
          )}
          <ControlButton label={t('teamCall.hangUp')} danger onClick={() => { void ctx.hangUp(); }}>
            <PhoneOff className="h-4 w-4" />
          </ControlButton>
        </div>
      )}
      {over && (
        <button
          type="button"
          onClick={() => ctx.dismiss()}
          className="sr-only focus:not-sr-only focus:m-2 focus:rounded-md focus:px-2 focus:py-1 focus:text-[12px]"
        >
          {t('common.close')}
        </button>
      )}
    </div>
  );
}

export default function TeamCallOverlay() {
  const ctx = useTeamCall();
  const session = ctx?.session;
  if (!ctx || !session) return null;
  if (session.phase === 'incoming') return <IncomingCard session={session} ctx={ctx} />;
  return <CallWindow session={session} ctx={ctx} />;
}
