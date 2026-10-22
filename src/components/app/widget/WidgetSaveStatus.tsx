/**
 * The widget page's save status, announced politely to screen readers
 * (WCAG 4.1.3): "Saving…" while a change waits or travels, "All changes
 * saved" once the server has them, "Not saved" (with the reason as its
 * title) when one was refused. Nothing before the first change.
 */
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { WidgetSaveStatus as Status } from '@/hooks/useWidgetSettingsDraft';

export function WidgetSaveStatus({ status, errorMessage, className }: { status: Status; errorMessage?: string | null; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      aria-live="polite"
      data-save-status={status}
      title={status === 'error' && errorMessage ? errorMessage : undefined}
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        status === 'error' ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
    >
      {status === 'saving' && (<><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t('widgetPage.save.saving')}</>)}
      {status === 'saved' && (<><Check className="h-3.5 w-3.5" aria-hidden="true" />{t('widgetPage.save.saved')}</>)}
      {status === 'error' && (<><AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />{t('widgetPage.save.failed')}</>)}
    </span>
  );
}
