/**
 * Phase 4c — Notes section: composer + list.
 * Pure presentation; mutations come from the parent.
 */
import { useState } from 'react';
import { Loader2, Plus, FileText, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useConversationNotes, useCreateNote, useDeleteNote, useUpdateNote,
} from '@/hooks/useConversationNotes';
import { NoteRow } from './NoteRow';

interface Props {
  conversationId: string;
  workspaceId: string;
  currentUserId: string | null;
  t: (key: string) => string;
}

export function NotesSection({ conversationId, workspaceId, currentUserId, t }: Props) {
  const [draft, setDraft] = useState('');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const notesQ     = useConversationNotes(conversationId, workspaceId);
  const createNote = useCreateNote(conversationId, workspaceId);
  const updateNote = useUpdateNote(conversationId, workspaceId);
  const deleteNote = useDeleteNote(conversationId, workspaceId);

  const submit = async () => {
    const body = draft.trim();
    if (!body) return;
    await createNote.mutateAsync(body);
    setDraft('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  };

  const notes = notesQ.data ?? [];

  return (
    <section aria-labelledby="notes-heading">
      <div className="flex items-center justify-between mb-2">
        <h4 id="notes-heading" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <FileText className="w-3 h-3" />
          {t('inbox.notes') || 'Internal notes'}
          {notes.length > 0 && (
            <span className="ms-1 text-[10px] font-normal text-muted-foreground/70">({notes.length})</span>
          )}
        </h4>
        <span className="text-[10px] text-muted-foreground">
          {t('inbox.notesPrivate') || 'Visible only to your team'}
        </span>
      </div>

      <div className="rounded-lg border border-border/50 bg-card/60 p-2 space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('inbox.notePlaceholder') || 'Add a note for your team…'}
          className="min-h-[60px] text-xs resize-none"
          disabled={createNote.isPending}
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/80">
            {t('inbox.noteHint') || '⌘/Ctrl + Enter to post'}
          </span>
          <Button
            size="sm"
            onClick={submit}
            disabled={!draft.trim() || createNote.isPending}
            className="h-7 text-xs"
          >
            {createNote.isPending
              ? <Loader2 className="w-3 h-3 animate-spin me-1" />
              : <Plus className="w-3 h-3 me-1" />}
            {t('inbox.addNote') || 'Add note'}
          </Button>
        </div>
        {createNote.isError && (
          <div className="flex items-center gap-1.5 text-[11px] text-destructive">
            <AlertCircle className="w-3 h-3" />
            {(createNote.error as Error)?.message || t('inbox.noteCreateFailed') || 'Failed to add note'}
          </div>
        )}
      </div>

      <div className="mt-2 space-y-2">
        {notesQ.isLoading && (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </>
        )}

        {notesQ.isError && !notesQ.isLoading && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[11px] text-destructive flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-medium">{t('inbox.notesLoadFailed') || 'Could not load notes'}</div>
              <button onClick={() => notesQ.refetch()} className="underline mt-1 hover:no-underline">
                {t('common.retry') || 'Retry'}
              </button>
            </div>
          </div>
        )}

        {!notesQ.isLoading && !notesQ.isError && notes.length === 0 && (
          <div className="rounded-lg border border-dashed border-border/60 py-4 text-center">
            <FileText className="w-4 h-4 text-muted-foreground/60 mx-auto mb-1" />
            <div className="text-[11px] text-muted-foreground">
              {t('inbox.noNotes') || 'No notes yet.'}
            </div>
          </div>
        )}

        {notes.map((n) => (
          <NoteRow
            key={n.id}
            note={n}
            canEdit={!!currentUserId && n.author_id === currentUserId}
            isDeleting={deleteNote.isPending && deleteNote.variables === n.id}
            isUpdating={updateNote.isPending && updatingId === n.id}
            onUpdate={async (body) => {
              setUpdatingId(n.id);
              try { await updateNote.mutateAsync({ noteId: n.id, body }); }
              finally { setUpdatingId(null); }
            }}
            onDelete={() => deleteNote.mutate(n.id)}
            t={t}
          />
        ))}
      </div>
    </section>
  );
}
