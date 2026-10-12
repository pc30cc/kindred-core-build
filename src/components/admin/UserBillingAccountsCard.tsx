/**
 * Super Admin → Users → detail → Finance: the simple billing accounts of the
 * workspaces this user owns (phase 6, decision D22; docs/billing/SIMPLE_BILLING.md).
 * It replaces the v2 finance card while the old billing is off: one row per
 * owned workspace (with or without an account yet) with its balance in its
 * own currency and its plan, each linking to the account in Finance.
 *
 * Read only: GET /api/admin/simple-billing/accounts?filter=owner:<id>.
 */
import { Link } from 'react-router-dom';
import { ChevronRight, Loader2, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdminAccounts, type AdminAccountRow } from '@/lib/adminSimpleBillingApi';
import { useEdition } from '@/hooks/useEdition';
import { useTranslation, type TranslationKey } from '@/i18n';

/** Owned workspaces shown at once; a user with more sees a count of the rest. */
const PAGE_SIZE = 20;

function planName(row: AdminAccountRow, locale: string): string {
  const own = row.plan_localized?.[locale];
  const translated = own && typeof own === 'object' ? (own as { name?: unknown }).name : null;
  return (typeof translated === 'string' && translated.trim()) || row.plan_name || '—';
}

export default function UserBillingAccountsCard({ userId }: { userId: string }) {
  const { t, locale, dir } = useTranslation();
  const edition = useEdition();
  const { data, isLoading, isError } = useAdminAccounts(
    { filter: `owner:${userId}`, sort: 'name_asc', pageSize: PAGE_SIZE },
    { enabled: Boolean(userId) },
  );

  const statusLabel = (status: string | null) => {
    if (!status) return t('admin.plans.statuses.none');
    const key = `admin.plans.statuses.${status}` as TranslationKey;
    const label = t(key);
    return label && label !== key ? label : status;
  };

  return (
    <Card data-testid="user-billing-accounts" dir={dir}>
      <CardContent className="p-4 space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t('admin.simpleBilling.userCard.title')}
          {data && data.total > 0 && <Badge variant="secondary" className="text-[10px]">{data.total.toLocaleString(locale)}</Badge>}
        </h3>

        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="loading" />
        ) : isError || !data ? (
          <p className="text-sm text-destructive">{t('admin.users.finLoadFailed')}</p>
        ) : data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('admin.simpleBilling.userCard.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.simpleBilling.accounts.col.workspace')}</TableHead>
                  <TableHead>{t('admin.simpleBilling.accounts.col.plan')}</TableHead>
                  <TableHead className="text-end">{t('admin.simpleBilling.accounts.col.balance')}</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row) => (
                  <TableRow key={row.workspace_id}>
                    <TableCell>
                      <Link
                        to={`/admin/finance/accounts/${encodeURIComponent(row.workspace_id)}`}
                        className="font-medium hover:underline"
                      >
                        {row.name}
                      </Link>
                      <div>
                        <code className="text-[10px] text-muted-foreground bg-muted px-1 py-0.5 rounded">{row.slug}</code>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {planName(row, locale)}
                      <span className="text-muted-foreground"> · {statusLabel(row.status)}</span>
                    </TableCell>
                    <TableCell className="text-end text-xs">
                      {row.has_account && row.currency ? (
                        <span dir="ltr" className="font-medium">{edition.formatAmount(row.balance_minor, row.currency)}</span>
                      ) : (
                        <span className="text-muted-foreground">{t('admin.simpleBilling.accounts.noAccount')}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        to={`/admin/finance/accounts/${encodeURIComponent(row.workspace_id)}`}
                        aria-label={t('admin.simpleBilling.userCard.open')}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {data.total > data.items.length && (
              <p className="pt-2 text-[11px] text-muted-foreground">
                {data.items.length.toLocaleString(locale)} / {data.total.toLocaleString(locale)}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
