/**
 * Above the composer of a CLOSED conversation.
 *
 * A closed conversation is finished for the visitor: their next message starts
 * a new conversation (resolved ones reopen when the visitor writes, closed
 * ones do not). An operator could still type a follow-up question into it
 * without a word of warning, and the visitor's answer then arrived as a fresh
 * conversation with no context, possibly to someone else. So the composer
 * says so, offers "Reopen", and sending from here reopens it first (the
 * Inbox's "Reopen and send").
 */
import { Archive, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ClosedConversationNotice({ onReopen, pending, t, dir }: {
  onReopen: () => void;
  pending: boolean;
  t: (key: string) => string;
  dir: 'ltr' | 'rtl';
}) {
  return (
    <div
      data-inbox="closed-notice"
      role="note"
      className="mb-2 flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2"
      dir={dir}
    >
      <Archive className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold text-foreground">{t('inbox.closedComposerTitle')}</p>
        <p className="text-[11.5px] leading-snug text-muted-foreground">{t('inbox.closedComposerHint')}</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-inbox="closed-reopen"
        className="h-8 shrink-0 gap-1 px-2.5 text-[11.5px] font-semibold"
        disabled={pending}
        onClick={onReopen}
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
        {t('inbox.reopen')}
      </Button>
    </div>
  );
}
