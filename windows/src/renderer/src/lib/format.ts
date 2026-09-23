import { formatNumber, localeOf, translate, type Language } from '@/i18n'
import type { JSONObject, MessageAttachment } from '@/api/types'
import { ApiError } from '@/api/client'

/**
 * Timestamps arrive from Postgres in more than one shape — with and without
 * fractional seconds, with a space instead of `T`, with `+00` for the offset.
 * One odd row must not blank a whole list, so each is normalised first.
 */
export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null
  let s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ', 'T')
  s = s.replace(/([+-]\d{2})$/, '$1:00')
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

const dtfCache = new Map<string, Intl.DateTimeFormat>()
function dtf(language: Language, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = language + JSON.stringify(options)
  let f = dtfCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(localeOf(language), options)
    dtfCache.set(key, f)
  }
  return f
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function dayDiff(d: Date, now = new Date()): number {
  return Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
}

function relativeDay(language: Language, days: 0 | -1, style: 'short' | 'long' = 'long'): string {
  return new Intl.RelativeTimeFormat(localeOf(language), { numeric: 'auto', style }).format(days, 'day')
}

/** Today → time, yesterday → "Yesterday", this week → weekday, this year → day and month, else a date. */
export function listTimestamp(raw: string | null | undefined, language: Language): string {
  const d = parseDate(raw)
  if (!d) return ''
  const diff = dayDiff(d)
  if (diff <= 0) return dtf(language, { hour: 'numeric', minute: '2-digit' }).format(d)
  if (diff === 1) return capitalize(relativeDay(language, -1, 'short'))
  if (diff < 7) return dtf(language, { weekday: 'short' }).format(d)
  if (d.getFullYear() === new Date().getFullYear()) return dtf(language, { day: 'numeric', month: 'short' }).format(d)
  return dtf(language, { day: 'numeric', month: 'short', year: '2-digit' }).format(d)
}

export function dayHeader(d: Date, language: Language): string {
  const diff = dayDiff(d)
  if (diff === 0 || diff === 1) return capitalize(relativeDay(language, diff === 0 ? 0 : -1))
  if (d.getFullYear() === new Date().getFullYear()) {
    return dtf(language, { weekday: 'long', day: 'numeric', month: 'long' }).format(d)
  }
  return dtf(language, { day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

export function timeOfDay(raw: string | null | undefined, language: Language): string {
  const d = parseDate(raw)
  return d ? dtf(language, { hour: 'numeric', minute: '2-digit' }).format(d) : ''
}

export function fullDateTime(raw: string | null | undefined, language: Language): string {
  const d = parseDate(raw)
  return d ? dtf(language, { dateStyle: 'medium', timeStyle: 'short' }).format(d) : ''
}

function capitalize(s: string): string {
  return s.charAt(0).toLocaleUpperCase() + s.slice(1)
}

/** A visitor with no name is shown by the part of the email before the @, then by their code. */
export function contactName(
  c: { name?: string | null; email?: string | null; visitor_code?: string | null } | null | undefined,
  language: Language,
): string {
  const name = c?.name?.trim()
  if (name) return name
  const email = c?.email
  if (email) {
    const at = email.indexOf('@')
    return at > 0 ? email.slice(0, at) : email
  }
  if (c?.visitor_code) return `${translate(language, 'unknownVisitor')} ${c.visitor_code}`
  return translate(language, 'unknownVisitor')
}

export function preview(body: string | null | undefined): string {
  return (body ?? '').replace(/[\r\n]+/g, ' ').trim()
}

function clock(fields: number[], language: Language, padFirst = false): string {
  return fields
    .map((v, i) => {
      const text = formatNumber(v, language)
      if ((i > 0 || padFirst) && v < 10) return formatNumber(0, language) + text
      return text
    })
    .join(':')
}

export function duration(seconds: number, language: Language): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? clock([h, m, sec], language, true) : clock([m, sec], language, true)
}

export function voiceTime(seconds: number, language: Language): string {
  const total = Math.max(0, Math.floor(seconds))
  return clock([Math.floor(total / 60), total % 60], language)
}

export function fileSize(bytes: number, language: Language): string {
  if (bytes < 1024) return `${formatNumber(bytes, language)} ${translate(language, 'unitBytes')}`
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024), language)} ${translate(language, 'unitKilobytes')}`
  const mb = bytes / (1024 * 1024)
  const text = mb < 10
    ? new Intl.NumberFormat(localeOf(language), { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(mb)
    : formatNumber(Math.round(mb), language)
  return `${text} ${translate(language, 'unitMegabytes')}`
}

export type AttachmentKind = 'image' | 'audio' | 'video' | 'file'

export function attachmentKind(a: MessageAttachment): AttachmentKind {
  if (a.kind === 'image' || a.kind === 'audio' || a.kind === 'video' || a.kind === 'file') return a.kind
  const mime = a.mime_type ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

/** Some channels send a bare extension as the name — a voice note called `m4a` tells nobody anything. */
export function attachmentName(a: MessageAttachment): string | null {
  const t = (a.file_name ?? '').trim()
  return t && t.includes('.') && t.length > 4 ? t : null
}

function metaString(meta: JSONObject | null | undefined, key: string): string {
  const v = meta?.[key]
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * A system notice rebuilt in the operator's language from its metadata, because the
 * stored body is an English sentence frozen when it was written.
 */
export function systemText(meta: JSONObject | null | undefined, language: Language): string | null {
  const kind = metaString(meta, 'kind')
  if (!kind) return null
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string>) => translate(language, key, params)
  switch (kind) {
    case 'conversation_transferred':
      return t('sysTransferred', { actor: metaString(meta, 'actor_name'), to: metaString(meta, 'to_name') })
    case 'conversation_unassigned':
      return t('sysUnassigned', { actor: metaString(meta, 'actor_name') })
    case 'routing_agent_joined': {
      const name = metaString(meta, 'agent_name')
      return name ? t('sysAgentJoined', { name }) : t('sysAgentJoinedGeneric')
    }
    case 'routing_no_agent_available':
      return t('sysNoAgentAvailable')
    case 'routing_in_queue':
      return t('sysInQueue')
    case 'call_invitation': {
      const video = metaString(meta, 'channel') === 'video'
      const op = metaString(meta, 'operator_name')
      const text = op
        ? t(video ? 'sysCallInviteVideoFrom' : 'sysCallInviteAudioFrom', { op })
        : t(video ? 'sysCallInviteVideo' : 'sysCallInviteAudio')
      return `${text} · ${invitationStatus(metaString(meta, 'status') || 'pending', language)}`
    }
    case 'call_ended': {
      const raw = meta?.duration_seconds
      const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) || 0 : 0
      if (metaString(meta, 'end_reason') === 'failed' || seconds <= 0) return t('callEndedNotConnected')
      const d = duration(seconds, language)
      const by = metaString(meta, 'ended_by')
      return t(by === 'operator' ? 'callEndedByOperator' : by === 'visitor' ? 'callEndedByVisitor' : 'callEndedBySystem', { duration: d })
    }
    default:
      return null
  }
}

export function invitationStatus(status: string, language: Language): string {
  const key = { joined: 'inviteStatusJoined', expired: 'inviteStatusExpired', cancelled: 'inviteStatusCancelled', declined: 'inviteStatusDeclined' }[status]
  return translate(language, (key ?? 'inviteStatusPending') as Parameters<typeof translate>[1])
}

export function attachmentPreview(kind: string, isMe: boolean, name: string | null | undefined, language: Language): string {
  const k = kind === 'image' ? 'Image' : kind === 'audio' ? 'Audio' : kind === 'video' ? 'Video' : 'File'
  if (isMe) return translate(language, `previewYouSent${k}` as Parameters<typeof translate>[1])
  const sender = name?.trim() || translate(language, 'previewSomeone')
  return translate(language, `previewSentBy${k}` as Parameters<typeof translate>[1], { name: sender })
}

/** The words an error shows, the same mapping the iOS app uses. */
export function errorText(error: unknown, language: Language, unauthorized?: string): string {
  if (!(error instanceof ApiError)) return translate(language, 'offlineBody')
  switch (error.kind) {
    case 'transport':
      return translate(language, 'offlineBody')
    case 'unauthorized':
      return unauthorized ?? translate(language, 'sessionExpired')
    case 'decoding':
      return translate(language, 'errorUnreadableAnswer')
    case 'server': {
      if (language === 'en' && error.serverMessage) return error.serverMessage
      const s = error.status ?? 500
      if (s === 400 || s === 422) return translate(language, 'errorInvalidInput')
      if (s === 404) return translate(language, 'errorNotFound')
      if (s === 409) return translate(language, 'errorConflict')
      if (s === 429) return translate(language, 'errorTooManyRequests')
      if (s >= 400 && s < 500) return translate(language, 'errorNotAllowed')
      return translate(language, 'errorServerProblem')
    }
  }
}

/** A channel name is written the way the channel writes itself — except Bale and SMS, which have Persian names. */
export function channelTitle(key: string, language: Language): string {
  switch (key) {
    case 'telegram': return 'Telegram'
    case 'bale': return language === 'fa' ? 'بله' : 'Bale'
    case 'whatsapp': return 'WhatsApp'
    case 'instagram': return 'Instagram'
    case 'x':
    case 'twitter': return 'X'
    case 'messenger':
    case 'facebook': return 'Messenger'
    case 'sms': return language === 'fa' ? 'پیامک' : 'SMS'
    case 'widget': return language === 'fa' ? 'ویجت سایت' : language === 'tr' ? 'Site widget’ı' : 'Website widget'
    default: return key.charAt(0).toUpperCase() + key.slice(1)
  }
}

export function channelKeyOf(meta: JSONObject | null | undefined): string {
  return metaString(meta, 'channel') || metaString(meta, 'source') || 'widget'
}

export function deviceKind(raw: string | null | undefined, language: Language): string | null {
  switch (raw?.trim().toLowerCase()) {
    case 'desktop': return translate(language, 'deviceDesktop')
    case 'mobile': return translate(language, 'deviceMobile')
    case 'tablet': return translate(language, 'deviceTablet')
    default: return raw?.trim() || null
  }
}

/** "Desktop · Windows · Chrome", de-duplicated, without the parts the server could not identify. */
export function deviceLabel(p: { device?: string | null; os?: string | null; browser?: string | null }, language: Language): string {
  const parts = [deviceKind(p.device, language), p.os, p.browser]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.toLowerCase() !== 'unknown')
  const seen = new Set<string>()
  const unique = parts.filter((s) => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
  return unique.length ? unique.join(' · ') : '—'
}
