/**
 * Phase 4b — Operator-only Activity panel.
 *
 * Renders two sections inside the Inbox sidebar's "Activity" tab:
 *   1. Notes — internal, never visible to the visitor (own table).
 *   2. Timeline — normalized events from conversation_events.
 *
 * Both queries are workspace-membership gated server-side. The widget
 * has no API surface that returns either dataset.
 */

import { useState } from 'react';
import { Loader2, MessageSquare, Trash2, UserPlus, UserMinus,
  CheckCircle2, RefreshCw, AlertCircle, Hash, Paperclip,
  Bot, FileText, Star, User, Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  useConversationNotes, useCreateNote, useDeleteNote,
  type ConversationNote,
} from '@/hooks/useConversationNotes';
import {
  useConversationTimeline, type TimelineEvent,
} from '@/hooks/useConversationTimeline';

interface Props {
  conversationId: string;
  workspaceId: string;
  currentUserId: string | null;
  t: (key: string) => string;
  dir: 'ltr' | 'rtl';
}

function actorLabel(ev: TimelineEvent, t: (k: string) => string): string {
  if (ev.actor) return ev.actor.full_name || ev.actor.email || t('inbox.timeline.agent') || 'Agent';
  if (ev.actor_type === 'visitor') return t('inbox.timeline.visitor') || 'Visitor';
  if (ev.actor_type === 'ai') return t('inbox.timeline.ai') || 'AI';
  return t('inbox.timeline.system') || 'System';
}

function eventIcon(type: string) {
  switch (type) {
    case 'created':         return MessageSquare;
    case 'identified':      return User;
    case 'assigned':        return UserPlus;
    case 'unassigned':      return UserMinus;
    case 'resolved':        return CheckCircle2;
    case 'reopened':        return RefreshCw;
    case 'status_changed':  return RefreshCw;
    case 'priority_changed':return Star;
    case 'tag_added':
    case 'tag_removed':     return Hash;
    case 'attachment_added':return Paperclip;
    case 'ai_reply':        return Bot;
    case 'note_added':
    case 'note_deleted':    return FileText;
    default:                return AlertCircle;
  }
}

function describeEvent(ev: TimelineEvent, t: (k: string) => string): string {
  const p: any = ev.payload ?? {};
  switch (ev.event_type) {
    case 'created':          return t('inbox.timeline.created') || 'Conversation created';
    case 'identified':       return t('inbox.timeline.identified') || 'Visitor identified';
    case 'assigned': {
      const to = p?._refs?.to?.full_name || p?._refs?.to?.email || t('inbox.timeline.someone') || 'someone';
      return `${t('inbox.timeline.assignedTo') || 'Assigned to'} ${to}`;
    }
    case 'unassigned':       return t('inbox.timeline.unassigned') || 'Unassigned';
    case 'resolved':         return t('inbox.timeline.resolved') || 'Marked as resolved';
    case 'reopened':         return t('inbox.timeline.reopened') || 'Reopened';
    case 'status_changed':   return `${t('inbox.timeline.statusChanged') || 'Status'}: ${p.from} → ${p.to}`;
    case 'priority_changed': return `${t('inbox.timeline.priorityChanged') || 'Priority'}: ${p.from} → ${p.to}`;
    case 'tag_added':        return `${t('inbox.timeline.tagAdded') || 'Tag added'}: ${p.tag}`;
    case 'tag_removed':      return `${t('inbox.timeline.tagRemoved') || 'Tag removed'}: ${p.tag}`;
    case 'attachment_added': return t('inbox.timeline.attachmentAdded') || 'Attachment added';
    case 'ai_reply':         return t('inbox.timeline.aiReply') || 'AI replied';
    case 'note_added':       return p.preview ? `${t('inbox.timeline.noteAdded') || 'Note added'}: ${p.preview}` : (t('inbox.timeline.noteAdded') || 'Note added');
    case 'note_deleted':     return t('inbox.timeline.noteDeleted') || 'Note deleted';
    default:                 return ev.event_type;
  }
}

function timeShort(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString();
}

export function ConversationActivityPanel({
  conversationId, workspaceId, currentUserId, t, dir,
}: Props) {
  const [draft, setDraft] = useState('');
  const notesQ = useConversationNotes(conversationId, workspaceId);
  const timelineQ = useConversationTimeline(conversationId, workspaceId);
  const createNote = useCreateNote(conversationId, workspaceId);
  const deleteNote = useDeleteNote(conversationId, workspaceId);

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    await createNote.mutateAsync(body);
    setDraft('');
  };

  return (
    <div className="p-3 space-y-4" dir={dir}>
      {/* ─── NOTES ─── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('inbox.notes') || 'Internal notes'}
          </h4>
          <span className="text-[10px] text-muted-foreground">
            {t('inbox.notesPrivate') || 'Visible only to your team'}
          </span>
        </div>
        <div className="rounded-lg border border-border/50 bg-card/60 p-2 space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('inbox.notePlaceholder') || 'Add a note for your team…'}
            className="min-h-[60px] text-xs resize-none"
            disabled={createNote.isPending}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={submit}
              disabled={!draft.trim() || createNote.isPending}
              className="h-7 text-xs"
            >
              {createNote.isPending
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Plus className="w-3 h-3 me-1" />}
              {t('inbox.addNote') || 'Add note'}
            </Button>
          </div>
        </div>

        <div className="mt-2 space-y-2">
          {notesQ.isLoading && (
            <div className="text-[11px] text-muted-foreground py-3 text-center">
              <Loader2 className="w-3 h-3 animate-spin inline" />
            </div>
          )}
          {!notesQ.isLoading && (notesQ.data ?? []).length === 0 && (
            <div className="text-[11px] text-muted-foreground py-3 text-center">
              {t('inbox.noNotes') || 'No notes yet.'}
            </div>
          )}
          {(notesQ.data ?? []).map((n: ConversationNote) => {
            const canDelete = currentUserId && n.author_id === currentUserId;
            return (
              <div key={n.id} className="rounded-lg border border-border/50 bg-secondary/30 p-2.5 group">
                <div className="flex items-start gap-2">
                  <div className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-[10px] font-bold shrink-0 overflow-hidden">
                    {n.author?.avatar_url
                      ? <img src={n.author.avatar_url} alt="" className="w-full h-full object-cover" />
                      : (n.author?.full_name?.[0] || n.author?.email?.[0] || '?').toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="font-semibold text-foreground truncate">
                        {n.author?.full_name || n.author?.email || 'Member'}
                      </span>
                      <span>·</span>
                      <span>{timeShort(n.created_at)}</span>
                    </div>
                    <p className="text-xs text-foreground mt-1 whitespace-pre-wrap break-words">{n.body}</p>
                  </div>
                  {canDelete && (
                    <button
                      onClick={() => deleteNote.mutate(n.id)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive p-1"
                      title={t('inbox.deleteNote') || 'Delete'}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ─── TIMELINE ─── */}
      <section>
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {t('inbox.timeline') || 'Timeline'}
        </h4>
        {timelineQ.isLoading && (
          <div className="text-[11px] text-muted-foreground py-3 text-center">
            <Loader2 className="w-3 h-3 animate-spin inline" />
          </div>
        )}
        {!timelineQ.isLoading && (timelineQ.data ?? []).length === 0 && (
          <div className="text-[11px] text-muted-foreground py-3 text-center">
            {t('inbox.noActivity') || 'No activity recorded yet'}
          </div>
        )}
        <ol className="space-y-2 relative ms-2 ps-3 border-s border-border/40">
          {(timelineQ.data ?? []).map((ev) => {
            const Icon = eventIcon(ev.event_type);
            return (
              <li key={ev.id} className="relative">
                <div className={cn(
                  'absolute -start-[19px] top-1 w-3 h-3 rounded-full bg-card border border-border flex items-center justify-center'
                )}>
                  <Icon className="w-2 h-2 text-muted-foreground" />
                </div>
                <div className="text-[11px] text-foreground leading-tight">
                  <span className="font-medium">{actorLabel(ev, t)}</span>{' '}
                  <span className="text-muted-foreground">{describeEvent(ev, t)}</span>
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{timeShort(ev.created_at)}</div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
