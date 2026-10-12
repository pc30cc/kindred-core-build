/**
 * Super Admin → Workspaces → detail: the workspace's simple billing account
 * at a glance (phase 6, decision D25; docs/billing/SIMPLE_BILLING.md) —
 * currency, balance, plan and period end, auto-renew and the saved card —
 * with a link to its full account in Finance → Accounts.
 *
 * Read only: it uses the account detail endpoint, which never processes a
 * due period, creates an account or syncs a card (D4). A workspace without
 * an account yet still links there, where it can be credited.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ExternalLink, Loader2, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAdminAccount } from '@/lib/adminSimpleBillingApi';
import { useEdition } from '@/hooks/useEdition';
import { useTranslation, type TranslationKey } from '@/i18n';

/** A date in the admin's language (Jalali in Persian). */
function adminBillingDate(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const tag = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
  return new Intl.DateTimeFormat(tag, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** A plan's name in the admin's language (its own translations), else its base name. */
function adminPlanName(
  name: string | null | undefined,
  localized: Record<string, unknown> | null | undefined,
  locale: string,
): string {
  const own = localized?.[locale];
  const translated = own && typeof own === 'object' ? (own as { name?: unknown }).name : null;
  return (typeof translated === 'string' && translated.trim()) || name || '—';
}

/** The account detail route in Finance (part of the Super Admin billing screens). */
const accountDetailPath = (workspaceId: string) => `/admin/finance/accounts/${encodeURIComponent(workspaceId)}`;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded bg-muted/40 px-2.5 py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-end">{children}</span>
    </div>
  );
}

export default function WorkspaceBillingSummary({ workspaceId }: { workspaceId: string }) {
  const { t, locale } = useTranslation();
  const edition = useEdition();
  const { data: account, isLoading, isError } = useAdminAccount(workspaceId);

  const statusLabel = (status: string | null | undefined) => {
    if (!status) return t('admin.plans.statuses.none');
    const key = `admin.plans.statuses.${status}` as TranslationKey;
    const label = t(key);
    return label && label !== key ? label : status;
  };
  const intervalLabel = (interval: string | null | undefined) =>
    interval === 'monthly' ? t('admin.plans.monthly') : interval === 'yearly' ? t('admin.plans.yearly') : null;

  return (
    <Card data-testid="workspace-billing-summary">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t('admin.simpleBilling.workspaceCard.title')}
          </h3>
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link to={accountDetailPath(workspaceId)}>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t('admin.simpleBilling.workspaceCard.open')}
            </Link>
          </Button>
        </div>

        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="loading" />
        ) : isError || !account ? (
          <p className="text-xs text-destructive">{t('admin.simpleBilling.detail.notFound')}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {!account.has_account && (
              <p className="sm:col-span-2 text-xs text-muted-foreground">{t('admin.simpleBilling.workspaceCard.noAccount')}</p>
            )}
            <Row label={t('admin.simpleBilling.accounts.col.balance')}>
              <span dir="ltr" data-testid="workspace-billing-balance">
                {edition.formatAmount(account.balance_minor, account.currency)}
              </span>{' '}
              <Badge variant="outline" className="ms-1 text-[10px] font-mono">{account.currency}</Badge>
            </Row>
            <Row label={t('admin.simpleBilling.accounts.col.plan')}>
              {adminPlanName(account.plan.name, account.plan.localized, locale)}
              {intervalLabel(account.plan.billing_interval) && (
                <span className="text-muted-foreground"> · {intervalLabel(account.plan.billing_interval)}</span>
              )}
            </Row>
            <Row label={t('admin.simpleBilling.accounts.col.status')}>
              <span className="inline-flex items-center gap-1.5">
                {statusLabel(account.plan.status)}
                {account.due_unprocessed && (
                  <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600">
                    <AlertTriangle className="h-3 w-3 me-1" aria-hidden />
                    {t('admin.simpleBilling.detail.dueUnprocessed')}
                  </Badge>
                )}
              </span>
            </Row>
            <Row label={t('admin.simpleBilling.accounts.col.periodEnd')}>
              {account.plan.is_free ? '—' : adminBillingDate(account.plan.current_period_end, locale)}
            </Row>
            <Row label={t('admin.simpleBilling.accounts.col.autoRenew')}>
              {account.auto_renew ? t('admin.common.yes') : t('admin.common.no')}
            </Row>
            <Row label={t('admin.simpleBilling.accounts.col.card')}>
              {account.card ? (
                <span className="inline-flex items-center gap-1.5">
                  <span dir="ltr">
                    {account.card.brand || account.card.provider}
                    {account.card.last4 ? ` ••••${account.card.last4}` : ''}
                  </span>
                  <Badge variant={account.card.status === 'active' ? 'secondary' : 'destructive'} className="text-[10px]">
                    {statusLabel(account.card.status)}
                  </Badge>
                </span>
              ) : (
                '—'
              )}
            </Row>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
