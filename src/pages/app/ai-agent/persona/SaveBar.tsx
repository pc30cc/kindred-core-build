import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { AlertCircle, CheckCircle2, CircleDot, Loader2 } from 'lucide-react';

/**
 * The page's one Save: says whether there is anything unsaved, saves or
 * discards it, and keeps a failed save's reason in view (the edits stay).
 * Disabled while there is nothing to save.
 */
export function SaveBar({
  dirty, saving, busy = false, blocked, error, onSave, onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  /** Another write of these settings is on its way (Remove of the custom instruction). */
  busy?: boolean;
  /** A field the owner edited stops the save (its own message says why). */
  blocked: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const status = error
    ? { icon: AlertCircle, text: error, tone: 'text-destructive' }
    : blocked
      ? { icon: AlertCircle, text: t('aiAgent.persona.save.blocked'), tone: 'text-destructive' }
      : dirty
        ? { icon: CircleDot, text: t('aiAgent.persona.save.unsaved'), tone: 'text-amber-700 dark:text-amber-300' }
        : { icon: CheckCircle2, text: t('aiAgent.persona.save.clean'), tone: 'text-muted-foreground' };
  const Icon = status.icon;

  return (
    <div
      data-persona-savebar
      data-dirty={dirty}
      className="sticky bottom-3 z-20 rounded-xl border border-border/70 bg-background/95 px-4 py-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p
          role={error || blocked ? 'alert' : 'status'}
          className={cn('flex min-w-0 flex-1 basis-56 items-start gap-2 text-sm', status.tone)}
        >
          <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{status.text}</span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" onClick={onDiscard} disabled={!dirty || saving || busy}>
            {t('aiAgent.persona.save.discard')}
          </Button>
          <Button type="button" onClick={onSave} disabled={!dirty || saving || busy || blocked} className="shadow-md shadow-primary/20">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('aiAgent.persona.save.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
