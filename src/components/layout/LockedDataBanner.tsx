/**
 * LockedDataBanner — the notice above the page while the plan's limits lock
 * part of the workspace's data (simple billing phase 4, design §9).
 *
 * It reads the effective-entitlement snapshot's `locks` (GET /effective,
 * server/services/billing/locks/state.ts lockSummary): nothing is decided
 * here. Shown to the owner and admins only, and only while the edition's
 * billing locks are on and something is locked: what is locked, when locked
 * data is deleted (once both notices went out), and links to upgrade, to the
 * full report and, for the owner, to the export of locked data.
 *
 * This is the only place a workspace learns about locks when no dialog was
 * shown: the automatic move to Free when a period ends unpaid.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronDown, ChevronUp, Loader2, Lock } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { useWorkspaceLocks, type LockSummary } from '@/hooks/useEntitlements';
import { useWorkspaceRole, isWorkspaceAdmin } from '@/hooks/useWorkspaceRole';
import { accountBillingApi, type LockReport as LockReportData } from '@/lib/accountBillingApi';
import { billingDate } from '@/pages/app/billing/shared';
import LockReport, { LockedExportButton } from '@/pages/app/billing/account/LockReport';

const KINDS = ['kb_article', 'contact', 'member', 'conversation'] as const;

/** "12 articles, 340 contacts": the kinds with anything locked, in the viewer's language. */
function lockedSummaryText(
  locks: LockSummary,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  locale: string,
): string {
  const n = new Intl.NumberFormat(locale);
  return KINDS
    .filter((kind) => (locks[kind]?.locked ?? 0) > 0)
    .map((kind) => t(`billing.locks.kinds.${kind}` as TranslationKey, { count: n.format(locks[kind]!.locked) }))
    .join(locale === 'fa' ? '، ' : ', ');
}

export function LockedDataBanner({ workspaceId }: { workspaceId: string | null | undefined }) {
  const { t, locale } = useTranslation();
  const wsPath = useWorkspacePath();
  const locks = useWorkspaceLocks(workspaceId);
  const { data: role } = useWorkspaceRole(workspaceId ?? undefined);
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<LockReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!workspaceId || !locks || !locks.enabled || !locks.any_locked || !isWorkspaceAdmin(role)) return null;
  const summary = lockedSummaryText(locks, t, locale);
  if (!summary) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || report || loading) return;
    setLoading(true);
    setFailed(false);
    accountBillingApi
      .lockReport(workspaceId)
      .then(setReport, () => setFailed(true))
      .finally(() => setLoading(false));
  };

  return (
    <div
      role="status"
      data-testid="locked-data-banner"
      className="mx-4 mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 sm:mx-6 lg:mx-8"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
        <div className="min-w-0 flex-1 text-start">
          <p className="text-sm font-semibold">{t('billing.locks.banner.title')}</p>
          <p className="text-xs text-muted-foreground">{t('billing.locks.banner.summary', { summary })}</p>
          {locks.next_deletion_at && (
            <p className="mt-0.5 text-xs font-medium text-destructive" data-testid="locked-data-deletion">
              {t('billing.locks.banner.deletion', { date: billingDate(locks.next_deletion_at, locale) })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to={wsPath('/billing')}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {t('billing.locks.banner.upgrade')}
            <ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {t('billing.locks.banner.details')}
            {open ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-2.5 space-y-2">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
          ) : report ? (
            <LockReport
              report={report}
              variant="now"
              footer={<LockedExportButton workspaceId={workspaceId} />}
            />
          ) : failed ? (
            <p className="text-xs text-destructive">{t('billing.locks.report.unavailable')}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
