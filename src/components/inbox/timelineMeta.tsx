/**
 * Phase 4c — Timeline metadata: icon + label + tone per event_type.
 * Pure presentation; no network or state.
 */
import {
  MessageSquare, UserPlus, UserMinus, CheckCircle2, RefreshCw,
  AlertCircle, Hash, Paperclip, Bot, FileText, Star, User,
  Trash2, Flag, Phone, PhoneIncoming, PhoneMissed, PhoneOff, PhoneCall, Voicemail,
  Timer, AlertTriangle, Send, Video, Ban, Mail,
} from 'lucide-react';
import type { TimelineEvent } from '@/hooks/useConversationTimeline';

export type Tone = 'neutral' | 'success' | 'warning' | 'info' | 'ai' | 'danger';

export interface TimelineMeta {
  Icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
}

export function getTimelineMeta(type: string): TimelineMeta {
  switch (type) {
    case 'created':          return { Icon: MessageSquare, tone: 'info' };
    case 'identified':       return { Icon: User,          tone: 'info' };
    case 'assigned':         return { Icon: UserPlus,      tone: 'success' };
    case 'unassigned':       return { Icon: UserMinus,     tone: 'neutral' };
    case 'resolved':         return { Icon: CheckCircle2,  tone: 'success' };
    case 'reopened':         return { Icon: RefreshCw,     tone: 'warning' };
    case 'status_changed':   return { Icon: RefreshCw,     tone: 'neutral' };
    case 'priority_changed': return { Icon: Flag,          tone: 'warning' };
    case 'tag_added':        return { Icon: Hash,          tone: 'info' };
    case 'tag_removed':      return { Icon: Hash,          tone: 'neutral' };
    case 'attachment_added': return { Icon: Paperclip,     tone: 'info' };
    case 'ai_reply':         return { Icon: Bot,           tone: 'ai' };
    case 'note_added':       return { Icon: FileText,      tone: 'info' };
    case 'note_deleted':     return { Icon: Trash2,        tone: 'danger' };
    case 'call_queued':         return { Icon: Phone,          tone: 'info' };
    case 'call_offered':        return { Icon: PhoneIncoming,  tone: 'warning' };
    case 'call_accepted':       return { Icon: PhoneCall,      tone: 'success' };
    case 'call_missed':         return { Icon: PhoneMissed,    tone: 'danger' };
    case 'call_expired':        return { Icon: PhoneOff,       tone: 'neutral' };
    case 'call_cancelled':      return { Icon: PhoneOff,       tone: 'neutral' };
    case 'callback_requested':  return { Icon: Voicemail,      tone: 'info' };
    case 'callback_completed':  return { Icon: CheckCircle2,   tone: 'success' };
    case 'callback_offered':    return { Icon: Voicemail,      tone: 'warning' };
    case 'call_invited':              return { Icon: Send,         tone: 'info' };
    case 'call_invitation_joined':    return { Icon: PhoneCall,    tone: 'success' };
    case 'call_invitation_expired':   return { Icon: Timer,        tone: 'neutral' };
    case 'call_invitation_cancelled': return { Icon: Ban,          tone: 'neutral' };
    case 'call_invitation_declined':  return { Icon: PhoneOff,     tone: 'danger' };
    case 'call_ended':          return { Icon: PhoneOff,       tone: 'neutral' };
    case 'conversation_started': return { Icon: Send,          tone: 'info' };
    case 'captured_offline':    return { Icon: Timer,          tone: 'warning' };
    case 'escalation_requested': return { Icon: AlertTriangle, tone: 'warning' };
    case 'department_assigned': return { Icon: UserPlus,       tone: 'info' };
    case 'rated':               return { Icon: Star,           tone: 'success' };
    case 'transcript_emailed':  return { Icon: Mail,           tone: 'info' };
    case 'sla_breached':        return { Icon: AlertTriangle,  tone: 'danger' };
    case 'queue_long_wait':     return { Icon: Timer,          tone: 'warning' };
    default:                 return { Icon: AlertCircle,   tone: 'neutral' };
  }
}

const TONE_CLASSES: Record<Tone, { dot: string; ring: string; text: string }> = {
  neutral: { dot: 'bg-muted',                 ring: 'ring-border',           text: 'text-muted-foreground' },
  success: { dot: 'bg-emerald-500/15',        ring: 'ring-emerald-500/30',   text: 'text-emerald-600 dark:text-emerald-400' },
  warning: { dot: 'bg-amber-500/15',          ring: 'ring-amber-500/30',     text: 'text-amber-600 dark:text-amber-400' },
  info:    { dot: 'bg-primary/10',            ring: 'ring-primary/30',       text: 'text-primary' },
  ai:      { dot: 'bg-violet-500/15',         ring: 'ring-violet-500/30',    text: 'text-violet-600 dark:text-violet-400' },
  danger:  { dot: 'bg-destructive/10',        ring: 'ring-destructive/30',   text: 'text-destructive' },
};

export function toneClasses(tone: Tone) {
  return TONE_CLASSES[tone];
}

type Translate = (k: string) => string;

/**
 * The translation, or `fallback` when the key is missing: the translator
 * returns the key itself for a missing entry, so a plain `t(k) || fallback`
 * would print the key (e.g. "inbox.timeline.callQueued").
 */
function tx(t: Translate, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

/** "operator_cancelled" → "Operator cancelled": last resort for a value no translation names. */
function humanize(code: string): string {
  const text = String(code).replace(/[_-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/** A coded payload value (reason, channel, method, source…) in the interface language. */
function codeLabel(t: Translate, group: string, code: unknown): string | undefined {
  if (code === null || code === undefined || code === '') return undefined;
  const value = String(code);
  return tx(t, `inbox.timeline.${group}.${value}`, humanize(value));
}

function statusLabel(t: Translate, status: unknown): string {
  const value = String(status ?? '');
  return tx(t, `inbox.${value}`, humanize(value));
}

function secondsLabel(t: Translate, key: string, fallback: string, seconds: number): string {
  return tx(t, key, fallback).replace('{{seconds}}', String(Math.round(seconds)));
}

/** 125 → "2:05". */
function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function joinParts(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p));
  return kept.length ? kept.join(' · ') : undefined;
}

export function actorLabel(ev: TimelineEvent, t: (k: string) => string): string {
  if (ev.actor) return ev.actor.full_name || ev.actor.email || t('inbox.timeline.agent') || 'Agent';
  if (ev.actor_type === 'visitor') return t('inbox.timeline.visitor') || 'Visitor';
  if (ev.actor_type === 'ai')      return t('inbox.timeline.ai') || 'AI';
  return t('inbox.timeline.system') || 'System';
}

function priorityLabel(p: string | undefined, t: (k: string) => string): string {
  if (!p) return '—';
  return tx(t, `inbox.priority_${p}`, humanize(p));
}

/** The payload fields the timeline reads; everything else is ignored. */
interface TimelinePayload {
  source?: string;
  method?: string;
  reason?: string;
  channel?: string;
  call_type?: string;
  end_reason?: string;
  duration_seconds?: number;
  wait_seconds?: number;
  availability_reason?: string;
  department_name?: string;
  score?: number | string;
  comment?: string | null;
  status?: string;
  from?: string;
  to?: string;
  tag?: string;
  file_name?: string;
  preview?: string;
  _refs?: { to?: { full_name?: string | null; email?: string | null } | null } | null;
}

/** Returns { primary, secondary? } so the timeline row can render a stronger main line + a subtle aside. */
export function describeEvent(
  ev: TimelineEvent,
  t: Translate,
): { primary: string; secondary?: string } {
  const p = (ev.payload ?? {}) as TimelinePayload;
  const L = (key: string, fallback: string) => tx(t, `inbox.timeline.${key}`, fallback);
  const channel = codeLabel(t, 'channel', p?.channel);
  const reason = codeLabel(t, 'reason', p?.reason);
  switch (ev.event_type) {
    case 'created':
      return { primary: L('created', 'Conversation created'), secondary: codeLabel(t, 'source', p?.source) };
    case 'conversation_started':
      return { primary: L('conversationStarted', 'Operator started the conversation') };
    case 'identified':
      return { primary: L('identified', 'Visitor identified'), secondary: codeLabel(t, 'method', p?.method) };
    // How it was given or taken away (chat routing's methods: auto, round
    // robin, last agent, timeout, take over, a member leaving…), and for a
    // hand-made one where it came from (a transfer, an operator's outreach).
    case 'assigned': {
      const to = p?._refs?.to?.full_name || p?._refs?.to?.email || L('someone', 'someone');
      return {
        primary: `${L('assignedTo', 'Assigned to')} ${to}`,
        secondary: joinParts(codeLabel(t, 'method', p?.method), codeLabel(t, 'source', p?.source)),
      };
    }
    case 'unassigned':
      return { primary: L('unassigned', 'Unassigned'), secondary: codeLabel(t, 'method', p?.method) };
    // The PATCH files a move to `closed` as a `resolved` event too; its
    // payload says which (finding I-01: it used to read "Marked as resolved").
    case 'resolved':
      return p?.to === 'closed'
        ? { primary: L('closed', 'Closed'), secondary: reason }
        : { primary: L('resolved', 'Marked as resolved'), secondary: reason };
    case 'reopened':
      return { primary: L('reopened', 'Reopened'), secondary: reason };
    case 'status_changed':
      return {
        primary: L('statusChanged', 'Status changed'),
        secondary: joinParts(
          p.to ? (p.from ? `${statusLabel(t, p.from)} → ${statusLabel(t, p.to)}` : `→ ${statusLabel(t, p.to)}`) : undefined,
          reason,
        ),
      };
    case 'priority_changed':
      return {
        primary: L('priorityChanged', 'Priority changed'),
        secondary: `${priorityLabel(p.from, t)} → ${priorityLabel(p.to, t)}`,
      };
    case 'tag_added':
      return { primary: L('tagAdded', 'Tag added'), secondary: p.tag };
    case 'tag_removed':
      return { primary: L('tagRemoved', 'Tag removed'), secondary: p.tag };
    case 'attachment_added':
      return { primary: L('attachmentAdded', 'Attachment added'), secondary: p.file_name || undefined };
    case 'ai_reply':
      return { primary: L('aiReply', 'AI replied') };
    case 'note_added':
      return { primary: L('noteAdded', 'Note added'), secondary: p.preview || undefined };
    case 'note_deleted':
      return { primary: L('noteDeleted', 'Note deleted') };
    case 'department_assigned':
      return { primary: L('departmentAssigned', 'Department assigned'), secondary: p?.department_name || undefined };
    case 'escalation_requested':
      return { primary: L('escalationRequested', 'Visitor asked for a human operator') };
    case 'captured_offline':
      return {
        primary: L('capturedOffline', 'Message received while offline'),
        secondary: codeLabel(t, 'availability', p?.availability_reason),
      };
    case 'rated': {
      const score = Number(p?.score);
      const comment = typeof p?.comment === 'string' ? p.comment.trim() : '';
      return {
        primary: L('rated', 'Visitor rated the conversation'),
        secondary: joinParts(
          Number.isFinite(score) && score > 0 ? `${'★'.repeat(Math.min(5, Math.round(score)))} ${score}/5` : undefined,
          // The visitor's own words, quoted in the interface's style; one
          // pass, so text they typed is never read as a placeholder.
          comment ? L('quoted', '“{{text}}”').replace('{{text}}', () => comment) : undefined,
        ),
      };
    }
    // The visitor had the conversation mailed to the address on their
    // contact (shown masked, as the server recorded it).
    case 'transcript_emailed':
      return {
        primary: p?.status === 'failed'
          ? L('transcriptEmailFailed', 'Emailing the transcript to the visitor failed')
          : L('transcriptEmailed', 'Transcript emailed to the visitor'),
        secondary: typeof p?.to === 'string' && p.to ? p.to : undefined,
      };
    case 'call_queued':
      return { primary: L('callQueued', 'Call queued'), secondary: channel };
    case 'call_offered':
      return { primary: L('callOffered', 'Call offered to operator'), secondary: channel };
    case 'call_accepted':
      return { primary: L('callAccepted', 'Call accepted'), secondary: channel };
    case 'call_missed':
      return { primary: L('callMissed', 'Call missed'), secondary: joinParts(channel, reason) };
    case 'call_expired':
      return { primary: L('callExpired', 'Call request expired'), secondary: channel };
    case 'call_cancelled':
      return { primary: L('callCancelled', 'Call cancelled'), secondary: joinParts(channel, reason) };
    case 'call_ended': {
      const duration = typeof p?.duration_seconds === 'number' && p.duration_seconds > 0 ? clock(p.duration_seconds) : undefined;
      return {
        primary: L('callEnded', 'Call ended'),
        secondary: joinParts(codeLabel(t, 'channel', p?.call_type), codeLabel(t, 'reason', p?.end_reason), duration),
      };
    }
    case 'callback_requested':
      return { primary: L('callbackRequested', 'Callback requested'), secondary: channel };
    case 'callback_completed':
      return { primary: L('callbackCompleted', 'Callback completed') };
    case 'callback_offered':
      return { primary: L('callbackOffered', 'No operator available — callback offered'), secondary: channel };
    case 'sla_breached':
      return {
        primary: L('slaBreached', 'SLA exceeded'),
        secondary: typeof p?.wait_seconds === 'number'
          ? secondsLabel(t, 'inbox.timeline.waited', 'Waited {{seconds}}s', p.wait_seconds)
          : undefined,
      };
    case 'queue_long_wait':
      return {
        primary: L('queueLongWait', 'Visitor waiting longer than usual'),
        secondary: typeof p?.wait_seconds === 'number'
          ? secondsLabel(t, 'inbox.timeline.waitingSoFar', '{{seconds}}s so far', p.wait_seconds)
          : undefined,
      };
    case 'call_invited':
      return {
        primary: L('callInvited', 'Operator invited visitor to a call'),
        secondary: codeLabel(t, 'channel', p?.channel === 'video' ? 'video' : 'audio'),
      };
    case 'call_invitation_joined':
      return { primary: L('callInvitationJoined', 'Visitor joined the call') };
    case 'call_invitation_expired':
      return { primary: L('callInvitationExpired', 'Call invitation expired') };
    case 'call_invitation_cancelled':
      return { primary: L('callInvitationCancelled', 'Call invitation cancelled'), secondary: reason };
    case 'call_invitation_declined':
      return { primary: L('callInvitationDeclined', 'Visitor declined the call invitation') };
    default:
      return { primary: tx(t, `inbox.timeline.event.${ev.event_type}`, humanize(ev.event_type)) };
  }
}
