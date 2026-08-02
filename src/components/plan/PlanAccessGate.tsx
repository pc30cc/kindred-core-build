/**
 * Phase 6-S5 — Canonical, NON-MOUNTING plan gate.
 *
 * Unlike PlanLockedOverlay (which renders children behind a blur and
 * therefore still runs their hooks/queries), PlanAccessGate never mounts
 * its children unless the module is enabled for the workspace plan.
 *
 * States:
 *   loading            → skeleton only
 *   entitlement error  → retryable access-check error (fail closed)
 *   module disabled    → upgrade screen only
 *   module enabled     → children
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Sparkles, AlertTriangle, RefreshCw, ArrowLeft } from 'lucide-react';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export type PlanModuleKey =
  | 'ai_assistant'
  | 'call_center'
  | 'knowledge_base'
  | 'visitor_tracking'
  | 'contacts';

interface PlanAccessGateProps {
  moduleKey: PlanModuleKey;
  children: ReactNode;
  className?: string;
  /** Optional explicit copy overrides (fall back to i18n). */
  lockedTitle?: string;
  lockedDescription?: string;
  /** Show a "back" link to the workspace inbox. */
  showBack?: boolean;
}

export function PlanAccessGate({
  moduleKey,
  children,
  className,
  lockedTitle,
  lockedDescription,
  showBack = true,
}: PlanAccessGateProps) {
  const { workspace } = useActiveWorkspace();
  const { data, loading, error, reload } = useWorkspaceEffectiveEntitlements(workspace?.id || null);
  const { t, dir, locale } = useTranslation();
  const wsPath = useWorkspacePath();

  const tr = (key: string, fallback: string): string => {
    const v = t(key as never) as unknown as string;
    return !v || v === key ? fallback : String(v);
  };

  // Loading — do NOT mount children.
  if (loading || (!data && !error)) {
    return (
      <div className={cn('p-8 space-y-4', className)} dir={dir}>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  // Entitlement lookup error — fail closed with a retryable message.
  if (error || !data) {
    return (
      <div className={cn('flex items-start justify-center p-8', className)} dir={dir}>
        <div className="max-w-md w-full rounded-2xl border border-border bg-card shadow-sm p-8 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
            <AlertTriangle className="h-7 w-7 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold mb-2">
            {tr('plan.accessCheck.errorTitle', 'Could not verify your plan access')}
          </h2>
          <p className="text-sm text-muted-foreground mb-6">
            {tr('plan.accessCheck.errorBody', 'We could not confirm which features your plan includes. Please retry.')}
          </p>
          <Button variant="outline" className="w-full" onClick={reload}>
            <RefreshCw className="h-4 w-4 me-2" />
            {tr('plan.accessCheck.retry', 'Retry access check')}
          </Button>
        </div>
      </div>
    );
  }

  const enabled = data.modules?.[moduleKey]?.value !== false;
  if (enabled) return <>{children}</>;

  const moduleLabel = tr(`plan.locked.module.${moduleKey}`, moduleKey);
  const localized = (data.plan?.localized || {}) as Record<string, { name?: string }>;
  const planName =
    localized[locale]?.name?.trim() ||
    localized['en']?.name?.trim() ||
    data.plan?.name ||
    data.plan?.slug ||
    tr('plan.locked.currentPlan', '—');

  const title = lockedTitle || tr(`plan.upgrade.${moduleKey}.title`, `${moduleLabel} is not included in your plan`);
  const description =
    lockedDescription || tr(`plan.upgrade.${moduleKey}.body`, 'Upgrade your plan to unlock this feature.');

  return (
    <div className={cn('flex items-start justify-center p-8', className)} dir={dir}>
      <div className="max-w-lg w-full rounded-2xl border border-border bg-card shadow-xl overflow-hidden">
        <div className="h-1.5 w-full bg-gradient-to-r from-primary via-primary/60 to-primary/20" />
        <div className="p-8 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Lock className="h-7 w-7 text-primary" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">{title}</h2>
          <p className="text-sm text-muted-foreground mb-4">{description}</p>
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground mb-6">
            <span>{tr('plan.locked.currentPlanLabel', 'Current plan')}:</span>
            <span className="font-medium text-foreground">{String(planName)}</span>
            <span className="opacity-50">•</span>
            <span className="font-medium text-foreground">{moduleLabel}</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button asChild className="flex-1">
              <Link to={wsPath('/billing')}>
                <Sparkles className="h-4 w-4 me-2" />
                {tr('plan.locked.action', 'Upgrade plan')}
              </Link>
            </Button>
            {showBack && (
              <Button asChild variant="outline" className="flex-1">
                <Link to={wsPath('/inbox')}>
                  <ArrowLeft className="h-4 w-4 me-2 rtl:rotate-180" />
                  {tr('plan.locked.back', 'Back')}
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default PlanAccessGate;
