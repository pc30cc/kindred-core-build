/**
 * A Widget tab the plan does not include, shown read-only (W-04): an upgrade
 * notice naming the capability and the plan, then the tab's own settings
 * with every control disabled (a disabled fieldset), so the owner can see
 * what is stored instead of the tab vanishing after a downgrade. While the
 * plan allows it, the children render as they are.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Sparkles } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { Button } from '@/components/ui/button';
import { capabilityLabel } from '@/lib/capability-i18n';

export function PlanReadOnlySection({
  featureKey,
  allowed,
  children,
}: {
  featureKey: string;
  allowed: boolean;
  children: ReactNode;
}) {
  const { t, locale } = useTranslation();
  const wsPath = useWorkspacePath();
  if (allowed) return <>{children}</>;
  const feature = capabilityLabel(featureKey, locale);
  return (
    <div className="space-y-4" data-plan-read-only={featureKey}>
      <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{t('widgetPage.locked.title', { feature })}</p>
            <p className="text-xs text-muted-foreground">{t('widgetPage.locked.body')}</p>
          </div>
        </div>
        <Button asChild size="sm" className="shrink-0">
          <Link to={wsPath('/billing')}>
            <Sparkles className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('plan.locked.action')}
          </Link>
        </Button>
      </div>
      <fieldset disabled aria-disabled="true" className="m-0 min-w-0 border-0 p-0 opacity-75">
        {children}
      </fieldset>
    </div>
  );
}
