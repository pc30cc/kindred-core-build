import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { ArrowUp, FileText, Image as ImageIcon, Loader2, Mic, Paperclip, Smile, Sparkles, Trash2, UserRound, X, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/api/client'
import type { CannedResponse } from '@/api/types'
import { useApp } from '@/store/app'
import { useT } from '@/hooks/useT'
import { interpolate, type CannedContext } from '@/lib/canned'
import { fileSize, voiceTime } from '@/lib/format'
import { Dialog, IconButton, Menu, Popover, Spinner, TextField } from '@/components/ui'
import { cx } from '@/lib/cx'

export interface PendingFile {
  id: string
  name: string
  mime: string
  data: Uint8Array
  previewUrl?: string
}

export const ALLOWED_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain',
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav',
])
export const MAX_BYTES = 25 * 1024 * 1024

export interface ComposerCapabilities {
  canAttach: boolean
  canRecordVoice: boolean
  canUseEmoji: boolean
  /** The AI owns the thread: the composer sends through it instead ("say now"). */
  aiManaged: boolean
}

const EMOJI = ['👍', '🙏', '😊', '🎉', '✅', '❤️', '😅', '🔥', '👌', '🙌', '😔', '⏳', '👋', '🤝', '📦', '💳', '📞', '⭐']

export function Composer({
  capabilities,
  sending,
  onSend,
  onSayNow,
  canned,
  placeholder,
  draftKey,
  onFilesRef,
}: {
  capabilities: ComposerCapabilities
  sending: boolean
  onSend: (text: string, files: PendingFile[]) => Promise<boolean>
  onSayNow?: (text: string, voice: 'specialist' | 'assistant') => Promise<boolean>
  /** Saved replies: available when this is a visitor conversation the operator is answering. */
  canned?: { workspaceId: string; context: CannedContext } | null
  placeholder?: string
  /** Where an unsent draft is kept, so switching threads never loses what was typed. */
  draftKey: string
  /** Lets the pane hand dropped files in. */
  onFilesRef?: (add: (files: File[]) => void) => void
}) {
  const t = useT()
  const language = useApp((s) => s.language)
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '')
  const [files, setFiles] = useState<PendingFile[]>([])
  const [voice, setVoice] = useState<'specialist' | 'assistant'>('specialist')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [sayNowBusy, setSayNowBusy] = useState(false)
  const used = useRef<{ id: string; snippet: string }[]>([])
  const area = useRef<HTMLTextAreaElement>(null)
  const recorder = useRecorder()

  useEffect(() => {
    drafts.set(draftKey, text)
  }, [draftKey, text])

  // Grow with the text, up to about eight lines.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [text])

  useEffect(() => {
    area.current?.focus()
  }, [draftKey])

  const addFiles = useMemo(
    () => async (list: File[]) => {
      if (!capabilities.canAttach) return
      for (const file of list) {
        const mime = file.type === 'audio/x-m4a' ? 'audio/mp4' : file.type
        if (!ALLOWED_MIMES.has(mime)) {
          toast.error(t('fileTypeNotAllowed'), { description: file.name })
          continue
        }
        if (file.size > MAX_BYTES) {
          toast.error(t('fileTooLarge'), { description: file.name })
          continue
        }
        const data = new Uint8Array(await file.arrayBuffer())
        setFiles((f) => [...f, { id: crypto.randomUUID(), name: file.name || 'file', mime, data, previewUrl: mime.startsWith('image/') ? URL.createObjectURL(file) : undefined }])
      }
    },
    [capabilities.canAttach, t],
  )

  useEffect(() => {
    onFilesRef?.((list) => void addFiles(list))
  }, [onFilesRef, addFiles])

  async function pickFiles() {
    const picked = await window.webyar.app.pickFiles()
    for (const p of picked) {
      if (!ALLOWED_MIMES.has(p.mimeType)) {
        toast.error(t('fileTypeNotAllowed'), { description: p.name })
        continue
      }
      if (p.data.byteLength > MAX_BYTES) {
        toast.error(t('fileTooLarge'), { description: p.name })
        continue
      }
      const previewUrl = p.mimeType.startsWith('image/') ? URL.createObjectURL(new Blob([p.data as BlobPart], { type: p.mimeType })) : undefined
      setFiles((f) => [...f, { id: crypto.randomUUID(), name: p.name, mime: p.mimeType, data: p.data, previewUrl }])
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = [...e.clipboardData.files]
    if (pasted.length && capabilities.canAttach) {
      e.preventDefault()
      void addFiles(pasted.map((f) => (f.name ? f : new File([f], `pasted.${f.type.split('/')[1] ?? 'png'}`, { type: f.type }))))
    }
  }

  // Saved replies inline: a message that starts with "/" searches them.
  const slash = !capabilities.aiManaged && canned && /^\/[^\s]*$/.test(text) ? text.slice(1) : null
  const [suggestions, setSuggestions] = useState<CannedResponse[]>([])
  const [highlight, setHighlight] = useState(0)
  useEffect(() => {
    if (slash === null || !canned) {
      setSuggestions([])
      return
    }
    const id = setTimeout(() => {
      api
        .cannedResponses(canned.workspaceId, language, slash)
        .then((items) => {
          setSuggestions(items.slice(0, 8))
          setHighlight(0)
        })
        .catch(() => setSuggestions([]))
    }, 150)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slash, canned?.workspaceId, language])

  function insertCanned(item: CannedResponse, replace: boolean) {
    const expanded = interpolate(item.body, canned?.context ?? {})
    setText((current) => {
      if (replace || !current) return expanded
      return /\s$/.test(current) ? current + expanded : current + '\n' + expanded
    })
    used.current.push({ id: item.id, snippet: expanded })
    setSuggestions([])
    area.current?.focus()
  }

  async function submit() {
    if (recorder.state === 'recording') return
    const body = text.trim()
    if (capabilities.aiManaged) {
      if (!body || !onSayNow || sayNowBusy) return
      setSayNowBusy(true)
      const ok = await onSayNow(body, voice)
      setSayNowBusy(false)
      if (ok) setText('')
      return
    }
    if ((!body && files.length === 0) || sending) return
    const toSend = files
    setText('')
    setFiles([])
    const ok = await onSend(body, toSend)
    if (!ok) {
      // Hand everything back so nothing the operator typed is lost.
      setText(body)
      setFiles(toSend)
      return
    }
    if (canned) {
      const recorded = new Set<string>()
      for (const u of used.current) {
        if (body.includes(u.snippet) && !recorded.has(u.id)) {
          recorded.add(u.id)
          void api.trackCannedUse(u.id, canned.workspaceId).catch(() => undefined)
        }
      }
    }
    used.current = []
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => (h + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertCanned(suggestions[highlight], true)
        return
      }
      if (e.key === 'Escape') {
        setSuggestions([])
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  async function finishRecording() {
    const clip = await recorder.stop()
    if (!clip) return
    await onSend('', [{ id: crypto.randomUUID(), name: `voice-${Date.now()}.webm`, mime: 'audio/webm', data: clip }])
  }

  const busy = sending || sayNowBusy
  const canSubmit = capabilities.aiManaged ? !!text.trim() && !sayNowBusy : (!!text.trim() || files.length > 0) && !sending

  return (
    <div className="relative px-4 pt-2 pb-3">
      {suggestions.length > 0 && (
        <div className="pop-in absolute inset-x-4 bottom-full mb-1 overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          <div className="border-b border-line px-3 py-1.5 text-[11px] font-semibold tracking-wide text-fg-3 uppercase">{t('shortcuts')}</div>
          {suggestions.map((s, i) => (
            <button
              key={s.id}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => insertCanned(s, true)}
              className={cx('flex w-full items-start gap-2.5 px-3 py-2 text-start', i === highlight ? 'bg-hover' : '')}
            >
              <span className="mt-px shrink-0 rounded-md bg-brand-soft px-1.5 py-px font-mono text-[11.5px] text-brand" dir="ltr">
                /{s.shortcut}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{s.title}</span>
                <span className="block truncate text-[12px] text-fg-2">{s.body}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {capabilities.aiManaged && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-brand-soft px-3 py-2 text-[12.5px] text-brand">
          <Sparkles className="size-4 shrink-0" />
          <span className="flex-1">{t('sayNowHint')}</span>
        </div>
      )}

      <div className={cx('rounded-2xl border bg-surface shadow-card transition-colors', 'border-line focus-within:border-brand/60 focus-within:ring-3 focus-within:ring-brand-soft')}>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-line p-2.5">
            {files.map((f) => (
              <div key={f.id} className="group relative flex items-center gap-2 rounded-xl border border-line bg-surface-2 p-1.5 pe-3">
                {f.previewUrl ? (
                  <img src={f.previewUrl} alt="" className="size-10 rounded-lg object-cover" />
                ) : (
                  <span className="flex size-10 items-center justify-center rounded-lg bg-brand-soft text-brand">
                    {f.mime.startsWith('audio/') ? <Mic className="size-4" /> : <FileText className="size-4" />}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block max-w-[160px] truncate text-[12.5px] font-medium" dir="auto">{f.name}</span>
                  <span className="block text-[11px] text-fg-3">{fileSize(f.data.byteLength, language)}</span>
                </span>
                <button
                  onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}
                  className="absolute -top-1.5 -end-1.5 hidden size-5 items-center justify-center rounded-full bg-fg text-bg group-hover:flex"
                  title={t('discard')}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {recorder.state !== 'idle' ? (
          <div className="flex items-center gap-2 px-2 py-2">
            <IconButton icon={Trash2} label={t('discard')} tone="danger" onClick={recorder.cancel} />
            <span className="pulse-dot size-2.5 rounded-full bg-danger" />
            <span className="text-[14px] font-semibold tabular-nums">{voiceTime(recorder.seconds, language)}</span>
            <span className="text-[12.5px] text-fg-2">{t('recording')}</span>
            <span className="flex-1" />
            <SendButton enabled={recorder.state === 'recording'} busy={sending} onClick={finishRecording} label={t('send')} />
          </div>
        ) : (
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            dir="auto"
            placeholder={capabilities.aiManaged ? t('sayNowPlaceholder') : (placeholder ?? t('messagePlaceholder'))}
            className="block max-h-[180px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-relaxed text-fg outline-none placeholder:text-fg-3"
          />
        )}

        {recorder.state === 'idle' && (
          <div className="flex items-center gap-0.5 px-2 pb-2">
            {capabilities.aiManaged ? (
              <Menu
                side="top"
                items={(['specialist', 'assistant'] as const).map((v) => ({
                  label: v === 'specialist' ? t('sayNowVoiceSpecialist') : t('sayNowVoiceAssistant'),
                  icon: v === 'specialist' ? UserRound : Sparkles,
                  checked: voice === v,
                  onSelect: () => setVoice(v),
                }))}
                trigger={({ ref, onClick }) => (
                  <button ref={ref} onClick={onClick} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-brand hover:bg-brand-soft">
                    {voice === 'specialist' ? <UserRound className="size-4" /> : <Sparkles className="size-4" />}
                    {t('sayNowVoice')}: {voice === 'specialist' ? t('sayNowVoiceSpecialist') : t('sayNowVoiceAssistant')}
                  </button>
                )}
              />
            ) : (
              <>
                {capabilities.canAttach && (
                  <Menu
                    side="top"
                    items={[
                      { label: t('sendPhoto'), icon: ImageIcon, onSelect: pickFiles },
                      { label: t('sendDocument'), icon: FileText, onSelect: pickFiles },
                    ]}
                    trigger={({ ref, onClick }) => <IconButton ref={ref} icon={Paperclip} label={t('attachFile')} onClick={onClick} disabled={busy} />}
                  />
                )}
                {canned && <IconButton icon={Zap} label={`${t('shortcuts')} (/)`} onClick={() => setPickerOpen(true)} />}
                {capabilities.canUseEmoji && (
                  <>
                    <IconButton ref={setEmojiAnchor} icon={Smile} label={t('emoji')} active={emojiOpen} onClick={() => setEmojiOpen((o) => !o)} />
                    <Popover anchor={emojiAnchor} open={emojiOpen} onClose={() => setEmojiOpen(false)} side="top">
                      <div className="grid grid-cols-6 gap-0.5 p-1" dir="ltr">
                        {EMOJI.map((e) => (
                          <button
                            key={e}
                            className="flex size-9 items-center justify-center rounded-lg text-[22px] hover:bg-hover"
                            onClick={() => {
                              setText((x) => x + e)
                              area.current?.focus()
                            }}
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                    </Popover>
                  </>
                )}
                {capabilities.canRecordVoice && <IconButton icon={Mic} label={t('voiceNote')} onClick={() => void recorder.start()} disabled={busy} />}
              </>
            )}
            <span className="flex-1 truncate px-2 text-[11px] text-fg-3">{canned && !capabilities.aiManaged && !text ? t('typeSlashHint') : ''}</span>
            <SendButton enabled={canSubmit} busy={busy} onClick={submit} label={capabilities.aiManaged ? t('sayNowAction') : t('send')} />
          </div>
        )}
      </div>

      {canned && (
        <CannedPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          workspaceId={canned.workspaceId}
          onPick={(item) => {
            insertCanned(item, false)
            setPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}

const drafts = new Map<string, string>()

function SendButton({ enabled, busy, onClick, label }: { enabled: boolean; busy: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={!enabled || busy}
      title={label}
      className={cx(
        'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold transition-colors',
        enabled && !busy ? 'bg-brand text-on-brand hover:bg-brand-hover' : 'bg-elevated text-fg-3',
      )}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" strokeWidth={2.4} />}
      {label}
    </button>
  )
}

function CannedPicker({ open, onClose, workspaceId, onPick }: { open: boolean; onClose: () => void; workspaceId: string; onPick: (c: CannedResponse) => void }) {
  const t = useT()
  const language = useApp((s) => s.language)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'loaded'; items: CannedResponse[] } | { kind: 'failed'; missing: boolean }>({ kind: 'loading' })

  useEffect(() => {
    if (!open) return
    const id = setTimeout(() => {
      api
        .cannedResponses(workspaceId, language, query)
        .then((items) => setState({ kind: 'loaded', items }))
        .catch((e) => setState({ kind: 'failed', missing: !!(e as { isFeatureMissing?: boolean }).isFeatureMissing }))
    }, 200)
    return () => clearTimeout(id)
  }, [open, query, workspaceId, language])

  return (
    <Dialog open={open} onClose={onClose} title={t('shortcuts')} width={560}>
      <div className="border-b border-line p-3">
        <TextField autoFocus icon={Zap} placeholder={t('searchShortcuts')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="max-h-[420px] min-h-[200px] overflow-y-auto p-1.5">
        {state.kind === 'loading' && (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        )}
        {state.kind === 'failed' && (
          <div className="p-6 text-center text-[13px] text-fg-2">
            <div className="font-semibold text-fg">{state.missing ? t('shortcutsUnavailableTitle') : t('offlineTitle')}</div>
            <div className="mt-1">{state.missing ? t('shortcutsUnavailableBody') : t('offlineBody')}</div>
          </div>
        )}
        {state.kind === 'loaded' && state.items.length === 0 && (
          <div className="p-6 text-center text-[13px] text-fg-2">
            <div className="font-semibold text-fg">{query ? t('noResults') : t('shortcutsEmptyTitle')}</div>
            {!query && <div className="mt-1">{t('shortcutsEmptyBody')}</div>}
          </div>
        )}
        {state.kind === 'loaded' &&
          state.items.map((item) => (
            <button key={item.id} onClick={() => onPick(item)} className="flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-start hover:bg-hover">
              <span className="flex items-center gap-2">
                <span className="rounded-md bg-brand-soft px-1.5 py-px font-mono text-[11.5px] text-brand" dir="ltr">
                  /{item.shortcut}
                </span>
                <span className="truncate text-[13.5px] font-semibold">{item.title}</span>
              </span>
              <span className="line-clamp-2 text-[12.5px] text-fg-2" dir="auto">{item.body}</span>
            </button>
          ))}
      </div>
    </Dialog>
  )
}

/** A voice note, recorded as Opus in WebM — one of the formats the attachment route accepts. */
function useRecorder() {
  const t = useT()
  const [state, setState] = useState<'idle' | 'starting' | 'recording'>('idle')
  const [seconds, setSeconds] = useState(0)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const resolveStop = useRef<((data: Uint8Array | null) => void) | null>(null)

  const cleanup = () => {
    if (timer.current) clearInterval(timer.current)
    stream.current?.getTracks().forEach((tr) => tr.stop())
    stream.current = null
    rec.current = null
    setState('idle')
    setSeconds(0)
  }

  useEffect(() => () => cleanup(), [])

  return {
    state,
    seconds,
    async start() {
      if (state !== 'idle') return
      setState('starting')
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {
        setState('idle')
        toast.error(t('microphoneDenied'), { description: t('mediaPermission') })
        return
      }
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const r = new MediaRecorder(stream.current, { mimeType: mime })
      chunks.current = []
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      r.onstop = async () => {
        const blob = new Blob(chunks.current, { type: 'audio/webm' })
        const data = blob.size ? new Uint8Array(await blob.arrayBuffer()) : null
        resolveStop.current?.(data)
        resolveStop.current = null
        cleanup()
      }
      r.start(250)
      rec.current = r
      const started = Date.now()
      timer.current = setInterval(() => setSeconds((Date.now() - started) / 1000), 200)
      setState('recording')
    },
    stop(): Promise<Uint8Array | null> {
      return new Promise((resolve) => {
        if (!rec.current) return resolve(null)
        resolveStop.current = resolve
        rec.current.stop()
      })
    },
    cancel() {
      resolveStop.current = null
      if (rec.current) {
        rec.current.onstop = () => cleanup()
        rec.current.stop()
      } else cleanup()
    },
  }
}
