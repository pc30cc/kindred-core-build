/**
 * PlanStatusBanner — the small red notice pinned above the workspace header
 * in the sidebar.
 *
 * Two states, both decided from the backend's effective-entitlement snapshot
 * (never from client guesswork about what a plan should be):
 *
 *  - trialing  → "your plan is a trial, N days left, then it becomes Free".
 *                N counts down every calendar day and never goes below 1
 *                while the trial is still running.
 *  - free      → "you are on the free plan, upgrade to unlock everything".
 *
 * A paying workspace sees nothing.
 */
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';

const DAY_MS = 86_400_000;

export function PlanStatusBanner({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();
  const { data } = useWorkspaceEffectiveEntitlements(workspaceId || null);

  // No banner without a snapshot, or where no billing exists (self-host unlimited).
  if (!data || data.billing === 'unlimited') return null;

  const sub = (data.subscription || null) as
    | { status?: string | null; trial_end?: string | null; free_fallback_at?: string | null; plan_id?: string | null }
    | null;
  const plan = (data.plan || null) as { is_free?: boolean | null; slug?: string | null; name?: string | null } | null;

  const trialEndMs = sub?.trial_end ? new Date(sub.trial_end).getTime() : NaN;
  const isTrial =
    sub?.status === 'trialing' && Number.isFinite(trialEndMs) && trialEndMs > Date.now();

  if (isTrial) {
    const daysLeft = Math.max(1, Math.ceil((trialEndMs - Date.now()) / DAY_MS));
    return (
      <div className="mx-3 mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 text-start">
            <p className="text-[12px] font-semibold text-destructive">{t('planBanner.trialTitle')}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {t('planBanner.trialDesc', { days: daysLeft })}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const isFree = Boolean(plan?.is_free) || plan?.slug === 'free' || !sub?.plan_id || !!sub?.free_fallback_at;
  if (!isFree) return null;

  return (
    <div className="mx-3 mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        <div className="min-w-0 text-start">
          <p className="text-[12px] font-semibold text-destructive">{t('planBanner.freeTitle')}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{t('planBanner.freeDesc')}</p>
          <Link
            to={wsPath('/billing')}
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-destructive hover:underline"
          >
            {t('planBanner.upgradeCta')}
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}
