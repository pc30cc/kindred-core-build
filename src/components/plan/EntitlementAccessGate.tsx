/**
 * Phase 6-S5-R1 — Canonical, NON-MOUNTING entitlement gate.
 *
 * One shared core for every plan/feature gate in the app. Children are never
 * mounted unless EVERY requirement resolves to an explicit `true`.
 *
 * States (all fail closed):
 *   loading                → skeleton, children not mounted
 *   lookup error           → retryable access-check error, children not mounted
 *   missing capability key → configuration error, children not mounted
 *   explicit false         → upgrade screen, children not mounted
 *   explicit true (all)    → children
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Sparkles, AlertTriangle, RefreshCw, ArrowLeft, SlidersHorizontal } from 'lucide-react';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export type EntitlementRequirement =
  | { type: 'module'; key: string }
  | { type: 'feature'; key: string };

export interface EntitlementAccessGateProps {
  requirements: EntitlementRequirement[];
  children: ReactNode;
  className?: string;
  /** `page` = full-page card, `inline` = compact card inside a page. */
  mode?: 'page' | 'inline';
  lockedTitle?: string;
  lockedDescription?: string;
  showBack?: boolean;
}

export function useEntitlementTr() {
  const { t } = useTranslation();
  return (key: string, fallback: string): string => {
    const v = t(key as never) as unknown as string;
    return !v || v === key ? fallback : String(v);
  };
}

function GateShell({
  mode,
  className,
  dir,
  children,
}: {
  mode: 'page' | 'inline';
  className?: string;
  dir: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(mode === 'page' ? 'flex items-start justify-center p-8' : 'w-full', className)}
      dir={dir}
    >
      <div
        className={cn(
          'w-full rounded-2xl border border-border bg-card overflow-hidden',
          mode === 'page' ? 'max-w-lg shadow-xl' : 'shadow-sm',
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function EntitlementAccessGate({
  requirements,
  children,
  className,
  mode = 'page',
  lockedTitle,
  lockedDescription,
  showBack = true,
}: EntitlementAccessGateProps) {
  const { workspace } = useActiveWorkspace();
  const { data, loading, error, reload } = useWorkspaceEffectiveEntitlements(workspace?.id || null);
  const { dir, locale } = useTranslation();
  const wsPath = useWorkspacePath();
  const tr = useEntitlementTr();

  // Loading — never mount children.
  if (loading || (!data && !error)) {
    return (
      <div className={cn(mode === 'page' ? 'p-8 space-y-4' : 'space-y-3', className)} dir={dir}>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  // Lookup error — fail closed with a retry affordance.
  if (error || !data) {
    return (
      <GateShell mode={mode} className={className} dir={dir}>
        <div className="p-8 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
            <AlertTriangle className="h-7 w-7 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold mb-2">
            {tr('plan.accessCheck.errorTitle', 'Could not verify your plan access')}
          </h2>
          <p className="text-sm text-muted-foreground mb-6">
            {tr(
              'plan.accessCheck.errorBody',
              'We could not confirm which features your plan includes. Please retry.',
            )}
          </p>
          <Button variant="outline" className="w-full" onClick={reload}>
            <RefreshCw className="h-4 w-4 me-2" />
            {tr('plan.accessCheck.retry', 'Retry access check')}
          </Button>
        </div>
      </GateShell>
    );
  }

  // Resolve every requirement. Missing key ≠ enabled.
  let missingKey: EntitlementRequirement | null = null;
  let deniedKey: EntitlementRequirement | null = null;
  for (const req of requirements) {
    const bucket = req.type === 'module' ? data.modules : data.features;
    const state = bucket?.[req.key];
    if (state == null) {
      missingKey = req;
      break;
    }
    if (state.value !== true) {
      deniedKey = deniedKey || req;
    }
  }

  if (missingKey) {
    return (
      <GateShell mode={mode} className={className} dir={dir}>
        <div className="p-8 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-4">
            <SlidersHorizontal className="h-7 w-7 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold mb-2">
            {tr('plan.accessCheck.configTitle', 'Plan configuration is incomplete')}
          </h2>
          <p className="text-sm text-muted-foreground mb-6">
            {tr(
              'plan.accessCheck.configBody',
              'This capability is not defined for your workspace plan. Please contact your administrator.',
            )}
            <span className="block mt-2 font-mono text-xs opacity-70">{missingKey.key}</span>
          </p>
          <Button variant="outline" className="w-full" onClick={reload}>
            <RefreshCw className="h-4 w-4 me-2" />
            {tr('plan.accessCheck.retry', 'Retry access check')}
          </Button>
        </div>
      </GateShell>
    );
  }

  if (!deniedKey) return <>{children}</>;

  const capKey = deniedKey.key;
  const capLabel = tr(`plan.locked.module.${capKey}`, capKey);
  const localized = (data.plan?.localized || {}) as Record<string, { name?: string }>;
  const planName =
    localized[locale]?.name?.trim() ||
    localized['en']?.name?.trim() ||
    data.plan?.name ||
    data.plan?.slug ||
    tr('plan.locked.currentPlan', '—');

  const title =
    lockedTitle || tr(`plan.upgrade.${capKey}.title`, `${capLabel} is not included in your plan`);
  const description =
    lockedDescription ||
    tr(`plan.upgrade.${capKey}.body`, 'Upgrade your plan to unlock this feature.');

  return (
    <GateShell mode={mode} className={className} dir={dir}>
      <div className="h-1.5 w-full bg-gradient-to-r from-primary via-primary/60 to-primary/20" />
      <div className={cn('text-center', mode === 'page' ? 'p-8' : 'p-6')}>
        <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Lock className="h-7 w-7 text-primary" />
        </div>
        <h2 className="text-xl font-semibold text-foreground mb-2">{title}</h2>
        <p className="text-sm text-muted-foreground mb-4">{description}</p>
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground mb-6">
          <span>{tr('plan.locked.currentPlanLabel', 'Current plan')}:</span>
          <span className="font-medium text-foreground">{String(planName)}</span>
          <span className="opacity-50">•</span>
          <span className="font-medium text-foreground">{capLabel}</span>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Button asChild className="flex-1">
            <Link to={wsPath('/billing')}>
              <Sparkles className="h-4 w-4 me-2" />
              {tr('plan.locked.action', 'Upgrade plan')}
            </Link>
          </Button>
          {mode === 'page' && showBack && (
            <Button asChild variant="outline" className="flex-1">
              <Link to={wsPath('/inbox')}>
                <ArrowLeft className="h-4 w-4 me-2 rtl:rotate-180" />
                {tr('plan.locked.back', 'Back')}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </GateShell>
  );
}

export default EntitlementAccessGate;
