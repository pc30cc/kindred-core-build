import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Sparkles } from 'lucide-react';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Phase 6-S5-R4 — `knowledge_base` is deliberately ABSENT: the Knowledge Base
 * is a core product and is never locked or blurred by a plan.
 */
type ModuleKey =
  | 'ai_assistant'
  | 'call_center'
  | 'visitor_tracking'
  | 'contacts';

interface Props {
  /** Locks on a plan module (Sidebar-level product areas). */
  moduleKey?: ModuleKey;
  /**
   * Locks on a plan *feature* capability key (e.g. `widget_smart_engagement`).
   * Used for tab-level surfaces inside an otherwise available module.
   */
  featureKey?: string;
  /** Human label shown in the upgrade message when using `featureKey`. */
  featureLabel?: string;
  children: ReactNode;
  /** Render mode: 'block' for full-page wrap, 'inline' for inline section */
  className?: string;
}

/**
 * Wrap a page or section. When the workspace's plan does not enable the
 * given module, the content is rendered behind a blurred / disabled
 * layer and an upgrade card overlay is shown on top.
 */
export function PlanLockedOverlay({ moduleKey, featureKey, featureLabel, children, className }: Props) {
  const { workspace } = useActiveWorkspace();
  const { data, loading } = useWorkspaceEffectiveEntitlements(workspace?.id || null);
  const { t, dir, locale } = useTranslation();
  const wsPath = useWorkspacePath();

  const state = featureKey
    ? data?.features?.[featureKey]
    : moduleKey
      ? data?.modules?.[moduleKey]
      : undefined;
  const enabled = !data || loading ? true : state?.value !== false;

  if (enabled) return <>{children}</>;

  const moduleLabel = featureKey
    ? (featureLabel || t(`plan.locked.feature.${featureKey}` as any) || featureKey)
    : t(`plan.locked.module.${moduleKey}` as any) || moduleKey;
  const localized = (data?.plan?.localized || {}) as Record<string, { name?: string; description?: string }>;
  const planName =
    localized[locale]?.name?.trim() ||
    localized['en']?.name?.trim() ||
    data?.plan?.name ||
    data?.plan?.slug ||
    t('plan.locked.currentPlan' as any);

  return (
    <div className={cn('relative h-full w-full', className)} dir={dir}>
      <div aria-hidden className="pointer-events-none select-none opacity-30 blur-[2px] h-full w-full overflow-hidden">
        {children}
      </div>
      <div className="absolute inset-0 flex items-start justify-center overflow-y-auto p-6 pt-20 bg-background/40 backdrop-blur-[1px]">
        <div className="max-w-md w-full rounded-2xl border border-border bg-card shadow-xl p-8 text-center pointer-events-auto">
          <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Lock className="h-7 w-7 text-primary" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">
            {t('plan.locked.title' as any)}
          </h2>
          <p className="text-sm text-muted-foreground mb-1">
            {t('plan.locked.message' as any).toString().replace('{module}', moduleLabel)}
          </p>
          <p className="text-xs text-muted-foreground/80 mb-6">
            {t('plan.locked.currentPlanLabel' as any)}: <span className="font-medium text-foreground">{String(planName)}</span>
          </p>
          <Button asChild className="w-full">
            <Link to={wsPath('/billing')}>
              <Sparkles className="h-4 w-4 me-2" />
              {t('plan.locked.action' as any)}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
