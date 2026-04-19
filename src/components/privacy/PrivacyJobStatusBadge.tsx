import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/i18n';
import type { PrivacyJobStatus } from '@/lib/privacy-api';
import { cn } from '@/lib/utils';

const tone: Record<PrivacyJobStatus, string> = {
  pending:   'bg-muted text-muted-foreground',
  running:   'bg-primary/15 text-primary',
  completed: 'bg-success/15 text-success',
  failed:    'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

export function PrivacyJobStatusBadge({ status }: { status: PrivacyJobStatus }) {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className={cn('border-0', tone[status])}>
      {t(`privacy.status.${status}` as any)}
    </Badge>
  );
}
