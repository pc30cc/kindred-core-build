import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, ExternalLink, FileText, Image as ImageIcon, Loader2, Pause, Play, Video, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { MessageAttachment } from '@/api/types'
import { attachmentBlob } from '@/lib/attachments'
import { attachmentKind, attachmentName, fileSize, voiceTime } from '@/lib/format'
import { useApp } from '@/store/app'
import { useT } from '@/hooks/useT'
import { IconButton } from '@/components/ui'
import { cx } from '@/lib/cx'

type Media = { kind: 'loading' } | { kind: 'ready'; url: string; data: Uint8Array } | { kind: 'failed' }

function useMedia(a: MessageAttachment, enabled = true): Media {
  const [media, setMedia] = useState<Media>({ kind: 'loading' })
  useEffect(() => {
    if (!enabled || a.id.startsWith('local-')) return
    let alive = true
    attachmentBlob(a.id, a.mime_type ?? '')
      .then((r) => alive && setMedia({ kind: 'ready', url: r.url, data: r.data }))
      .catch(() => alive && setMedia({ kind: 'failed' }))
    return () => {
      alive = false
    }
  }, [a.id, a.mime_type, enabled])
  return media
}

export function AttachmentView({ attachment, outgoing }: { attachment: MessageAttachment; outgoing: boolean }) {
  switch (attachmentKind(attachment)) {
    case 'image':
      return <ImageAttachment attachment={attachment} outgoing={outgoing} />
    case 'audio':
      return <VoiceNote attachment={attachment} outgoing={outgoing} />
    case 'video':
      return <VideoAttachment attachment={attachment} outgoing={outgoing} />
    default:
      return <FileAttachment attachment={attachment} outgoing={outgoing} />
  }
}

function ImageAttachment({ attachment, outgoing }: { attachment: MessageAttachment; outgoing: boolean }) {
  const t = useT()
  const media = useMedia(attachment)
  const [open, setOpen] = useState(false)
  if (media.kind === 'failed') return <FileCard icon={ImageIcon} title={attachmentName(attachment) ?? t('photo')} subtitle={t('attachmentFailed')} outgoing={outgoing} />
  if (media.kind === 'loading')
    return (
      <div className="flex h-[150px] w-[220px] items-center justify-center rounded-2xl bg-elevated text-[12px] text-fg-3">
        <Loader2 className="me-2 size-4 animate-spin" />
        {attachment.id.startsWith('local-') ? t('sendingFile') : t('receivingFile')}
      </div>
    )
  return (
    <>
      <button onClick={() => setOpen(true)} className="block overflow-hidden rounded-2xl ring-1 ring-line transition-opacity hover:opacity-95">
        <img src={media.url} alt={attachment.file_name ?? ''} className="block max-h-[280px] max-w-[300px] object-contain" draggable={false} />
      </button>
      {open && <Lightbox url={media.url} name={attachmentName(attachment) ?? 'image'} data={media.data} onClose={() => setOpen(false)} />}
    </>
  )
}

function Lightbox({ url, name, data, onClose }: { url: string; name: string; data: Uint8Array; onClose: () => void }) {
  const t = useT()
  const [zoom, setZoom] = useState(1)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fade-in no-drag fixed inset-0 z-[70] flex flex-col bg-black/90" onClick={onClose}>
      <div className="flex items-center justify-end gap-1 p-3 pr-[160px]" dir="ltr" onClick={(e) => e.stopPropagation()}>
        <IconButton icon={ZoomOut} label="-" className="text-white hover:bg-white/10 hover:text-white" onClick={() => setZoom((z) => Math.max(1, z - 0.5))} />
        <IconButton icon={ZoomIn} label="+" className="text-white hover:bg-white/10 hover:text-white" onClick={() => setZoom((z) => Math.min(4, z + 0.5))} />
        <IconButton icon={Download} label={t('download')} className="text-white hover:bg-white/10 hover:text-white" onClick={() => void window.webyar.app.saveFile({ fileName: name, data })} />
        <IconButton icon={X} label={t('close')} className="text-white hover:bg-white/10 hover:text-white" onClick={onClose} />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        <img
          src={url}
          alt=""
          onClick={(e) => {
            e.stopPropagation()
            setZoom((z) => (z > 1 ? 1 : 2))
          }}
          style={{ transform: `scale(${zoom})`, transition: 'transform .18s ease-out' }}
          className="max-h-full max-w-full cursor-zoom-in object-contain"
          draggable={false}
        />
      </div>
    </div>,
    document.body,
  )
}

function VoiceNote({ attachment, outgoing }: { attachment: MessageAttachment; outgoing: boolean }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const media = useMedia(attachment)
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(0)
  const [unsupported, setUnsupported] = useState(false)

  useEffect(() => {
    if (media.kind !== 'ready') return
    const el = new Audio(media.url)
    audio.current = el
    el.onloadedmetadata = () => setLength(Number.isFinite(el.duration) ? el.duration : 0)
    el.ontimeupdate = () => {
      setTime(el.currentTime)
      setProgress(el.duration ? el.currentTime / el.duration : 0)
    }
    el.onended = () => {
      setPlaying(false)
      setProgress(0)
      setTime(0)
    }
    el.onerror = () => setUnsupported(true)
    return () => {
      el.pause()
      audio.current = null
    }
  }, [media])

  const toggle = () => {
    const el = audio.current
    if (!el) return
    if (el.paused) void el.play().then(() => setPlaying(true)).catch(() => setUnsupported(true))
    else {
      el.pause()
      setPlaying(false)
    }
  }

  const tint = outgoing ? 'text-on-brand' : 'text-fg'
  const caption =
    unsupported ? t('playbackUnsupported') : media.kind === 'failed' ? t('attachmentFailed') : media.kind === 'loading' ? t('receivingFile') : voiceTime(playing || time > 0 ? time : length, language)

  return (
    <div className={cx('flex w-[250px] items-center gap-3 rounded-2xl px-3 py-2.5', outgoing ? 'bg-brand' : 'bg-bubble-in ring-1 ring-line')} dir="ltr">
      <button
        onClick={toggle}
        disabled={media.kind !== 'ready' || unsupported}
        className={cx('flex size-9 shrink-0 items-center justify-center rounded-full disabled:opacity-50', outgoing ? 'bg-white/20 text-white' : 'bg-brand-soft text-brand')}
      >
        {media.kind === 'loading' ? <Loader2 className="size-4 animate-spin" /> : playing ? <Pause className="size-4" fill="currentColor" /> : <Play className="size-4 translate-x-px" fill="currentColor" />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          className={cx('relative h-1.5 cursor-pointer rounded-full', outgoing ? 'bg-white/30' : 'bg-elevated')}
          onClick={(e) => {
            const el = audio.current
            if (!el || !el.duration) return
            const r = e.currentTarget.getBoundingClientRect()
            el.currentTime = ((e.clientX - r.left) / r.width) * el.duration
          }}
        >
          <div className={cx('absolute inset-y-0 left-0 rounded-full', outgoing ? 'bg-white' : 'bg-brand')} style={{ width: `${progress * 100}%` }} />
        </div>
        <div className={cx('mt-1.5 text-[11px] tabular-nums opacity-75', tint)} dir={language === 'fa' ? 'rtl' : 'ltr'}>
          {caption}
        </div>
      </div>
    </div>
  )
}

function VideoAttachment({ attachment, outgoing }: { attachment: MessageAttachment; outgoing: boolean }) {
  const t = useT()
  const media = useMedia(attachment)
  if (media.kind === 'ready') {
    return <video src={media.url} controls className="max-h-[280px] max-w-[320px] rounded-2xl bg-black ring-1 ring-line" />
  }
  return <FileCard icon={Video} title={attachmentName(attachment) ?? t('videoFile')} subtitle={media.kind === 'failed' ? t('attachmentFailed') : t('receivingFile')} outgoing={outgoing} loading={media.kind === 'loading'} />
}

function FileAttachment({ attachment, outgoing }: { attachment: MessageAttachment; outgoing: boolean }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const [busy, setBusy] = useState(false)
  const name = attachmentName(attachment) ?? t('file')
  const pending = attachment.id.startsWith('local-')

  async function withData(action: (data: Uint8Array) => Promise<unknown>) {
    setBusy(true)
    try {
      const { data } = await attachmentBlob(attachment.id, attachment.mime_type ?? '')
      await action(data)
    } catch {
      // The card says what went wrong on its own the next time it is drawn.
    } finally {
      setBusy(false)
    }
  }

  return (
    <FileCard
      icon={FileText}
      title={name}
      subtitle={pending ? t('sendingFile') : attachment.size_bytes ? fileSize(attachment.size_bytes, language) : (attachment.mime_type ?? '')}
      outgoing={outgoing}
      loading={busy || pending}
      actions={
        pending ? null : (
          <>
            <IconButton size="sm" icon={ExternalLink} label={t('openFile')} className={outgoing ? 'text-white hover:bg-white/15 hover:text-white' : ''} onClick={() => withData((data) => window.webyar.app.openFileWith({ fileName: name, data }))} />
            <IconButton size="sm" icon={Download} label={t('download')} className={outgoing ? 'text-white hover:bg-white/15 hover:text-white' : ''} onClick={() => withData((data) => window.webyar.app.saveFile({ fileName: name, data }))} />
          </>
        )
      }
    />
  )
}

function FileCard({
  icon: Icon,
  title,
  subtitle,
  outgoing,
  loading,
  actions,
}: {
  icon: typeof FileText
  title: string
  subtitle: string
  outgoing: boolean
  loading?: boolean
  actions?: React.ReactNode
}) {
  return (
    <div className={cx('flex w-[270px] items-center gap-3 rounded-2xl px-3 py-2.5', outgoing ? 'bg-brand text-on-brand' : 'bg-bubble-in text-fg ring-1 ring-line')}>
      <div className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', outgoing ? 'bg-white/20' : 'bg-brand-soft text-brand')}>
        {loading ? <Loader2 className="size-5 animate-spin" /> : <Icon className="size-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold" dir="auto">{title}</div>
        <div className="truncate text-[11.5px] opacity-70">{subtitle}</div>
      </div>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </div>
  )
}
