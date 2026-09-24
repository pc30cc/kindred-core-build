/**
 * Phase 4c — Single note row.
 * Adds inline edit + delete (author-only), avatar fallback, hover affordances.
 */
import { useState } from 'react';
import { Loader2, Pencil, Trash2, Check, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { OperatorAvatarFallback } from '@/components/ui/operator-avatar-fallback';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ConversationNote } from '@/hooks/useConversationNotes';
import { formatRelativeShort, formatAbsoluteTooltip } from './relativeTime';

interface Props {
  note: ConversationNote;
  canEdit: boolean;
  isDeleting: boolean;
  isUpdating: boolean;
  onUpdate: (body: string) => Promise<unknown>;
  onDelete: () => void;
  t: (key: string) => string;
}

export function NoteRow({ note, canEdit, isDeleting, isUpdating, onUpdate, onDelete, t }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);

  const save = async () => {
    const body = draft.trim();
    if (!body || body === note.body) { setEditing(false); return; }
    await onUpdate(body);
    setEditing(false);
  };

  const cancel = () => { setDraft(note.body); setEditing(false); };

  const author = note.author;
  const initial = (author?.full_name?.[0] || author?.email?.[0] || '?').toUpperCase();
  const edited = note.updated_at && note.updated_at !== note.created_at;

  return (
    <div className="rounded-lg border border-border/50 bg-secondary/30 hover:bg-secondary/40 transition-colors p-2.5 group">
      <div className="flex items-start gap-2">
        <Avatar className="h-6 w-6 shrink-0">
          {author?.avatar_url && <AvatarImage src={author.avatar_url} alt="" />}
          <OperatorAvatarFallback />
        </Avatar>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-semibold text-foreground truncate">
              {author?.full_name || author?.email || t('inbox.timeline.agent') || 'Member'}
            </span>
            <span aria-hidden>·</span>
            <span title={formatAbsoluteTooltip(note.created_at)}>
              {formatRelativeShort(note.created_at)}
            </span>
            {edited && (
              <span className="italic" title={formatAbsoluteTooltip(note.updated_at)}>
                · {t('inbox.noteEdited') || 'edited'}
              </span>
            )}
          </div>

          {editing ? (
            <div className="mt-1.5 space-y-1.5">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="min-h-[60px] text-xs resize-none"
                autoFocus
                disabled={isUpdating}
              />
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" onClick={cancel} disabled={isUpdating} className="h-6 px-2 text-[11px]">
                  <X className="w-3 h-3 me-1" />
                  {t('common.cancel') || 'Cancel'}
                </Button>
                <Button size="sm" onClick={save} disabled={isUpdating || !draft.trim()} className="h-6 px-2 text-[11px]">
                  {isUpdating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3 me-1" />}
                  {t('common.save') || 'Save'}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-foreground mt-1 whitespace-pre-wrap break-words">{note.body}</p>
          )}
        </div>

        {canEdit && !editing && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              onClick={() => setEditing(true)}
              className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50"
              title={t('inbox.editNote') || 'Edit'}
              aria-label={t('inbox.editNote') || 'Edit note'}
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={onDelete}
              disabled={isDeleting}
              className="text-muted-foreground hover:text-destructive p-1 rounded hover:bg-destructive/10 disabled:opacity-50"
              title={t('inbox.deleteNote') || 'Delete'}
              aria-label={t('inbox.deleteNote') || 'Delete note'}
            >
              {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
