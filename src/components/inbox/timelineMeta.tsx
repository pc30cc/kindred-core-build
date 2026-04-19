/**
 * Phase 4c — Timeline metadata: icon + label + tone per event_type.
 * Pure presentation; no network or state.
 */
import {
  MessageSquare, UserPlus, UserMinus, CheckCircle2, RefreshCw,
  AlertCircle, Hash, Paperclip, Bot, FileText, Star, User,
  Trash2, Flag,
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

export function actorLabel(ev: TimelineEvent, t: (k: string) => string): string {
  if (ev.actor) return ev.actor.full_name || ev.actor.email || t('inbox.timeline.agent') || 'Agent';
  if (ev.actor_type === 'visitor') return t('inbox.timeline.visitor') || 'Visitor';
  if (ev.actor_type === 'ai')      return t('inbox.timeline.ai') || 'AI';
  return t('inbox.timeline.system') || 'System';
}

function priorityLabel(p: string | undefined, t: (k: string) => string): string {
  if (!p) return '—';
  return t(`inbox.priority_${p}`) || p;
}

/** Returns { primary, secondary? } so the timeline row can render a stronger main line + a subtle aside. */
export function describeEvent(
  ev: TimelineEvent,
  t: (k: string) => string,
): { primary: string; secondary?: string } {
  const p: any = ev.payload ?? {};
  switch (ev.event_type) {
    case 'created':
      return { primary: t('inbox.timeline.created') || 'Conversation created' };
    case 'identified': {
      const method = p?.method ? `(${p.method})` : '';
      return { primary: t('inbox.timeline.identified') || 'Visitor identified', secondary: method || undefined };
    }
    case 'assigned': {
      const to = p?._refs?.to?.full_name || p?._refs?.to?.email || t('inbox.timeline.someone') || 'someone';
      return { primary: `${t('inbox.timeline.assignedTo') || 'Assigned to'} ${to}` };
    }
    case 'unassigned':
      return { primary: t('inbox.timeline.unassigned') || 'Unassigned' };
    case 'resolved':
      return { primary: t('inbox.timeline.resolved') || 'Marked as resolved' };
    case 'reopened':
      return { primary: t('inbox.timeline.reopened') || 'Reopened' };
    case 'status_changed':
      return {
        primary: t('inbox.timeline.statusChanged') || 'Status changed',
        secondary: p.from && p.to ? `${p.from} → ${p.to}` : undefined,
      };
    case 'priority_changed':
      return {
        primary: t('inbox.timeline.priorityChanged') || 'Priority changed',
        secondary: `${priorityLabel(p.from, t)} → ${priorityLabel(p.to, t)}`,
      };
    case 'tag_added':
      return { primary: t('inbox.timeline.tagAdded') || 'Tag added', secondary: p.tag };
    case 'tag_removed':
      return { primary: t('inbox.timeline.tagRemoved') || 'Tag removed', secondary: p.tag };
    case 'attachment_added':
      return {
        primary: t('inbox.timeline.attachmentAdded') || 'Attachment added',
        secondary: p.file_name || undefined,
      };
    case 'ai_reply':
      return { primary: t('inbox.timeline.aiReply') || 'AI replied' };
    case 'note_added':
      return {
        primary: t('inbox.timeline.noteAdded') || 'Note added',
        secondary: p.preview || undefined,
      };
    case 'note_deleted':
      return { primary: t('inbox.timeline.noteDeleted') || 'Note deleted' };
    default:
      return { primary: ev.event_type };
  }
}
