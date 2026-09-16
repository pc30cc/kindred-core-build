/**
 * Call Center — operator wrap-up notes.
 *
 * Replaces the disabled "coming soon" textarea that used to sit in the Live
 * Desk context column. Notes are persisted on the call
 * (`metadata.operator_notes[]`) and each one adds an `operator_note_added`
 * marker to the call timeline.
 *
 * Ctrl/Cmd+Enter submits — an operator wrapping up a call should not have to
 * reach for the mouse.
 */
import { useState } from 'react';
import { Loader2, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { useTranslation } from '@/i18n';
import { useAddCallNote, useCallCenterCallNotes } from '@/hooks/useCallCenter';
import { formatDateTime } from '@/lib/date';

const NOTE_MAX = 2000;

export function CallNotesPanel({
  workspaceId,
  callId,
  /** Compact variant for the wrap-up card; the context tab uses the full one. */
  compact = false,
}: {
  workspaceId: string | undefined;
  callId: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const { data, isLoading } = useCallCenterCallNotes(workspaceId, callId);
  const add = useAddCallNote(workspaceId, callId);
  const notes = data?.notes || [];

  async function submit() {
    const value = draft.trim();
    if (!value || add.isPending) return;
    try {
      await add.mutateAsync(value);
      setDraft('');
      toast({ title: t('callCenter.notes.saved') });
    } catch (e: unknown) {
      toast({
        title: t('callCenter.notes.failed'),
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, NOTE_MAX))}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          rows={compact ? 3 : 5}
          placeholder={t('callCenter.notes.placeholder')}
          className="text-sm resize-none"
        />
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {draft.length}/{NOTE_MAX}
          </span>
          <Button
            size="sm"
            className="ms-auto h-7 text-xs"
            onClick={submit}
            disabled={!draft.trim() || add.isPending}
          >
            {add.isPending
              ? <Loader2 className="h-3 w-3 animate-spin me-1.5" />
              : <StickyNote className="h-3 w-3 me-1.5" />}
            {add.isPending ? t('callCenter.notes.saving') : t('callCenter.notes.add')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="h-12 rounded-md bg-muted/40 animate-pulse" />
      ) : notes.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('callCenter.notes.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {[...notes].reverse().map((n) => (
            <li key={n.id} className="rounded-md border bg-muted/20 p-2.5">
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="font-medium text-foreground/80">
                  {n.author_name || t('callCenter.notes.you')}
                </span>
                <span className="ms-auto tabular-nums">{formatDateTime(n.created_at)}</span>
              </div>
              <p className="text-xs mt-1 whitespace-pre-wrap break-words">{n.note}</p>
            </li>
          ))}
        </ul>
      )}

      {!compact && (
        <p className="text-[11px] text-muted-foreground">{t('callCenter.notes.footer')}</p>
      )}
    </div>
  );
}

export default CallNotesPanel;
