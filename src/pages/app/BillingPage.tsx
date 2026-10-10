/**
 * Canonical workspace billing entry.
 * This is the only customer-facing billing experience.
 *
 * Billing v2 is hidden while the simple billing replaces it
 * (shared/billingMode.ts, docs/billing/SIMPLE_BILLING.md): the page says so
 * instead of offering invoices and checkouts that are being retired.
 */
import { Clock } from 'lucide-react';
import { SkeletonCard, SkeletonStats } from '@/components/common/Skeletons';
import { Card, CardContent } from '@/components/ui/card';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { LEGACY_BILLING_ENABLED } from '../../../shared/billingMode';
import WorkspaceBillingPage from './billing/WorkspaceBillingPage';

export default function BillingPage() {
  const { workspace, isLoading } = useActiveWorkspace();
  const { t, dir } = useTranslation();

  if (!LEGACY_BILLING_ENABLED) {
    return (
      <div className="p-4 md:p-6 lg:p-8" dir={dir}>
        <Card className="mx-auto max-w-xl">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Clock className="h-10 w-10 text-muted-foreground" aria-hidden />
            <h1 className="text-lg font-semibold text-foreground">{t('billing.paused.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('billing.paused.body')}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !workspace) {
    return (
      <div className="space-y-5 p-4 md:p-6 lg:p-8">
        <SkeletonStats count={3} />
        <SkeletonCard lines={5} />
      </div>
    );
  }

  return <WorkspaceBillingPage workspaceId={workspace.id} />;
}
