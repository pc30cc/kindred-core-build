import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Mic, MicOff, Minimize2, PhoneOff, Video, VideoOff, X } from 'lucide-react'
import { Room, RoomEvent, Track, type RemoteTrack, type LocalTrack } from 'livekit-client'
import { api } from '@/api/client'
import type { CallChannel, CallToken } from '@/api/types'
import { useApp, type ActiveCall } from '@/store/app'
import { useT } from '@/hooks/useT'
import { duration } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { cx } from '@/lib/cx'

type Phase =
  | { kind: 'waiting' }
  | { kind: 'connecting' }
  | { kind: 'connected'; since: number }
  | { kind: 'ended'; outcome: 'hungUp' | 'visitorLeft' | 'declined' | 'expired' | 'failed'; detail?: string }

/**
 * An operator never dials a visitor directly: the invitation is the offer, the
 * widget accepts it, and only then does a room exist. So this waits on the
 * invitation, then joins the room with the token the console would get.
 */
function useCallSession(call: ActiveCall | null) {
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting' })
  const [muted, setMuted] = useState(false)
  const [cameraOn, setCameraOn] = useState(false)
  const [relayWarning, setRelayWarning] = useState(false)
  const [degraded, setDegraded] = useState<'noMicrophone' | 'noCamera' | null>(null)
  const [remoteVideo, setRemoteVideo] = useState<RemoteTrack | null>(null)
  const [localVideo, setLocalVideo] = useState<LocalTrack | null>(null)
  const room = useRef<Room | null>(null)
  const sessionId = useRef<string | null>(null)
  const audioEls = useRef<HTMLMediaElement[]>([])
  const live = useRef(true)

  const channel: CallChannel = call?.invitation.channel === 'video' ? 'video' : 'audio'

  useEffect(() => {
    if (!call) return
    live.current = true
    setPhase({ kind: 'waiting' })
    setMuted(false)
    setCameraOn(channel === 'video')
    setDegraded(null)
    setRemoteVideo(null)
    setLocalVideo(null)
    sessionId.current = null

    let cancelled = false
    const poll = async () => {
      // Two seconds for as long as the invitation lives — cheaper than a realtime channel for one wait.
      while (!cancelled) {
        try {
          const inv = await api.invitation(call.invitation.id)
          if (inv.call_session_id && inv.status === 'joined') {
            sessionId.current = inv.call_session_id
            await join(inv.call_session_id)
            return
          }
          if (inv.status === 'expired' || inv.status === 'cancelled' || inv.status === 'declined') {
            setPhase({ kind: 'ended', outcome: inv.status === 'declined' ? 'declined' : 'expired' })
            return
          }
        } catch {
          // A single failed poll is a blip, not an answer.
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    void poll()
    return () => {
      cancelled = true
      live.current = false
      void teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.invitation.id])

  function iceServers(token: CallToken): RTCIceServer[] {
    const urls = token.turn?.urls
    if (!urls?.length) return []
    return [{ urls, username: token.turn?.username ?? '', credential: token.turn?.credential ?? '' }]
  }

  async function join(callSessionId: string) {
    setPhase({ kind: 'connecting' })
    try {
      const token = await api.callToken(callSessionId, null)
      setRelayWarning(token.warnings?.includes('turn_missing') === true)
      const url = token.ws_url || token.rtc_url
      if (!url) {
        setPhase({ kind: 'ended', outcome: 'failed', detail: 'no_server_url' })
        return
      }
      const r = new Room({ adaptiveStream: true, dynacast: true, videoCaptureDefaults: { resolution: { width: 1280, height: 720 } } })
      room.current = r

      const sync = () => {
        const remote = [...r.remoteParticipants.values()].flatMap((p) => [...p.videoTrackPublications.values()])
        setRemoteVideo((remote.find((p) => p.isSubscribed && !p.isMuted)?.track as RemoteTrack | undefined) ?? null)
        const local = [...r.localParticipant.videoTrackPublications.values()]
        setLocalVideo((local.find((p) => !p.isMuted)?.track as LocalTrack | undefined) ?? null)
      }
      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach()
          el.style.display = 'none'
          document.body.appendChild(el)
          audioEls.current.push(el)
        }
        sync()
      })
      r.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((el) => el.remove())
        sync()
      })
      r.on(RoomEvent.LocalTrackPublished, sync)
      r.on(RoomEvent.LocalTrackUnpublished, sync)
      r.on(RoomEvent.TrackMuted, sync)
      r.on(RoomEvent.TrackUnmuted, sync)
      r.on(RoomEvent.ParticipantDisconnected, () => {
        if (r.remoteParticipants.size === 0) void finish('visitorLeft')
      })
      r.on(RoomEvent.Disconnected, () => void finish('visitorLeft'))

      await r.connect(url, token.token, {
        rtcConfig: { iceServers: iceServers(token), iceTransportPolicy: token.ice_policy === 'relay' ? 'relay' : 'all' },
      })
      if (!live.current) return
      try {
        await r.localParticipant.setMicrophoneEnabled(true)
      } catch {
        setMuted(true)
        setDegraded('noMicrophone')
      }
      if (channel === 'video') {
        try {
          await r.localParticipant.setCameraEnabled(true)
        } catch {
          setCameraOn(false)
          setDegraded((d) => d ?? 'noCamera')
        }
      }
      setPhase({ kind: 'connected', since: Date.now() })
      sync()
    } catch (e) {
      await finish('failed', e instanceof Error ? e.message : String(e))
    }
  }

  async function teardown() {
    const r = room.current
    room.current = null
    audioEls.current.forEach((el) => el.remove())
    audioEls.current = []
    if (r) {
      r.removeAllListeners()
      await r.disconnect().catch(() => undefined)
    }
  }

  async function finish(outcome: Extract<Phase, { kind: 'ended' }>['outcome'], detail?: string) {
    setPhase((p) => (p.kind === 'ended' ? p : { kind: 'ended', outcome, detail }))
    // Ending is idempotent server-side, so a race with the visitor's own hang-up is harmless.
    if (sessionId.current) await api.hangUp(sessionId.current).catch(() => undefined)
    else if (call) await api.cancelInvitation(call.invitation.id).catch(() => undefined)
    await teardown()
  }

  return {
    channel,
    phase,
    muted,
    cameraOn,
    relayWarning,
    degraded,
    remoteVideo,
    localVideo,
    hangUp: () => finish('hungUp'),
    toggleMute() {
      const next = !muted
      setMuted(next)
      void room.current?.localParticipant.setMicrophoneEnabled(!next)
    },
    toggleCamera() {
      if (channel !== 'video') return
      const next = !cameraOn
      setCameraOn(next)
      void room.current?.localParticipant.setCameraEnabled(next)
    },
  }
}

function VideoTile({ track, mirror, className }: { track: RemoteTrack | LocalTrack | null; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !track) return
    track.attach(el)
    return () => {
      track.detach(el)
    }
  }, [track])
  if (!track) return null
  return <video ref={ref} autoPlay playsInline muted={mirror} className={cx('bg-black object-cover', mirror && '-scale-x-100', className)} />
}

export function CallOverlay() {
  const call = useApp((s) => s.call)
  const startCall = useApp((s) => s.startCall)
  const t = useT()
  const language = useApp((s) => s.language)
  const session = useCallSession(call)
  const [now, setNow] = useState(Date.now())
  const [compact, setCompact] = useState(false)

  useEffect(() => {
    if (session.phase.kind !== 'connected') return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [session.phase.kind])

  // An ended call says why for a moment, then gets out of the way.
  useEffect(() => {
    if (session.phase.kind !== 'ended') return
    const id = setTimeout(() => startCall(null), session.phase.outcome === 'failed' ? 6000 : 2500)
    return () => clearTimeout(id)
  }, [session.phase, startCall])

  if (!call) return null
  const p = session.phase
  const status =
    p.kind === 'waiting' ? t('callWaiting')
    : p.kind === 'connecting' ? t('connectingCall')
    : p.kind === 'connected' ? duration((now - p.since) / 1000, language)
    : p.outcome === 'declined' ? t('callDeclined')
    : p.outcome === 'expired' ? t('callNoAnswer')
    : p.outcome === 'failed' ? t('callFailed')
    : t('callEnded')
  const video = session.channel === 'video'
  const live = p.kind !== 'ended'

  if (compact) {
    return (
      <div className="pop-in no-drag fixed bottom-5 end-5 z-50 flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 shadow-pop">
        <Avatar name={call.contactName} imageURL={call.contactAvatarURL} size={40} />
        <div className="min-w-[120px]">
          <div className="text-[13.5px] font-semibold">{call.contactName}</div>
          <div className={cx('text-[12px] tabular-nums', p.kind === 'connected' ? 'text-success' : 'text-fg-2')}>{status}</div>
        </div>
        <button onClick={() => setCompact(false)} className="rounded-lg px-2 py-1 text-[12px] text-brand hover:bg-brand-soft">
          {t('details')}
        </button>
        {live && (
          <button onClick={() => void session.hangUp()} className="flex size-9 items-center justify-center rounded-full bg-danger text-white" title={t('hangUpCall')}>
            <PhoneOff className="size-4" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="fade-in no-drag fixed inset-0 z-50 flex flex-col bg-[#0b1220] text-white">
      <div className="flex h-11 items-center gap-2 px-4 pr-[160px]" dir="ltr">
        <span className="text-[12.5px] text-white/60">{video ? t('videoCall') : t('voiceCall')}</span>
        <span className="flex-1" />
        <button onClick={() => setCompact(true)} className="flex size-8 items-center justify-center rounded-lg text-white/70 hover:bg-white/10" title={t('close')}>
          <Minimize2 className="size-4" />
        </button>
        {!live && (
          <button onClick={() => startCall(null)} className="flex size-8 items-center justify-center rounded-lg text-white/70 hover:bg-white/10" title={t('closeCall')}>
            <X className="size-4" />
          </button>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {video && session.remoteVideo ? (
          <VideoTile track={session.remoteVideo} className="absolute inset-0 size-full" />
        ) : (
          <div className="flex flex-col items-center gap-5">
            <div className={cx('rounded-full', p.kind === 'waiting' && 'ring')}>
              <Avatar name={call.contactName} imageURL={call.contactAvatarURL} size={128} />
            </div>
            <div className="text-center">
              <div className="text-[24px] font-semibold">{call.contactName}</div>
              <div className={cx('mt-1 text-[15px] tabular-nums', p.kind === 'connected' ? 'text-emerald-300' : 'text-white/70')}>{status}</div>
              {p.kind === 'waiting' && <div className="mt-3 max-w-[340px] text-[12.5px] text-white/50">{t('inviteExpires')}</div>}
            </div>
          </div>
        )}
        {video && session.remoteVideo && (
          <div className="absolute top-4 start-4 rounded-xl bg-black/40 px-3 py-2 backdrop-blur">
            <div className="text-[14px] font-semibold">{call.contactName}</div>
            <div className="text-[12px] tabular-nums text-emerald-300">{status}</div>
          </div>
        )}
        {video && session.localVideo && (
          <VideoTile track={session.localVideo} mirror className="absolute end-5 bottom-5 h-[150px] w-[220px] rounded-xl shadow-2xl ring-1 ring-white/20" />
        )}
      </div>

      {(session.relayWarning || session.degraded) && live && (
        <div className="mx-auto mb-3 flex items-center gap-2 rounded-xl bg-amber-500/15 px-3 py-2 text-[12.5px] text-amber-200">
          <AlertTriangle className="size-4" />
          {session.degraded === 'noMicrophone' ? t('callNoMicrophone') : session.degraded === 'noCamera' ? t('callNoCamera') : t('callRelayWarning')}
        </div>
      )}
      {p.kind === 'ended' && p.outcome === 'failed' && p.detail && <div className="mb-3 text-center text-[12px] text-white/40" dir="ltr">{p.detail}</div>}

      <div className="flex items-center justify-center gap-5 pb-10">
        {live && (
          <>
            <CallButton icon={session.muted ? MicOff : Mic} label={session.muted ? t('unmute') : t('mute')} active={session.muted} onClick={session.toggleMute} disabled={p.kind !== 'connected'} />
            {video && <CallButton icon={session.cameraOn ? Video : VideoOff} label={session.cameraOn ? t('camera') : t('cameraOff')} active={!session.cameraOn} onClick={session.toggleCamera} disabled={p.kind !== 'connected'} />}
            <button onClick={() => void session.hangUp()} className="flex flex-col items-center gap-2">
              <span className="flex size-16 items-center justify-center rounded-full bg-[#e5484d] shadow-lg transition-transform hover:scale-105">
                <PhoneOff className="size-7" />
              </span>
              <span className="text-[12px] text-white/70">{t('hangUpCall')}</span>
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function CallButton({ icon: Icon, label, active, onClick, disabled }: { icon: typeof Mic; label: string; active: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex flex-col items-center gap-2 disabled:opacity-40">
      <span className={cx('flex size-14 items-center justify-center rounded-full transition-colors', active ? 'bg-white text-[#0b1220]' : 'bg-white/12 hover:bg-white/20')}>
        <Icon className="size-6" />
      </span>
      <span className="text-[12px] text-white/70">{label}</span>
    </button>
  )
}
