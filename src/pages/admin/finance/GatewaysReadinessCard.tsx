/**
 * Finance → Gateways: the read-only "Billing gateways" card (phase 6, D21).
 *
 * For each gateway of this edition and each account currency it says whether
 * customers are offered the gateway and, when not, why — with a link to where
 * that is changed. The rule itself lives on the server (gatewayListing in
 * server/services/billing/account/gateways.ts); this card only shows it.
 */
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ExternalLink, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTranslation } from '@/i18n';
import { useGatewayReadiness, type GatewayListingReason, type GatewayReadiness } from '@/lib/adminSimpleBillingApi';
import { gatewayLabel } from '@/pages/app/billing/account/accountUi';
import { ErrorState } from '@/pages/app/billing/shared';
import { sbLabel } from './financeUi';

/** Where each reason is fixed: the gateways table below, or the provider's settings. */
function fixHref(reason: GatewayListingReason | 'card_auto_renew', provider: string): string | null {
  if (reason === 'cannot_confirm' || reason === 'test' || reason === 'card_auto_renew') {
    return `/admin/providers?type=billing&provider=${encodeURIComponent(provider)}`;
  }
  return null;
}

function ListingCell({ gateway, currency }: { gateway: GatewayReadiness; currency: string }) {
  const { t } = useTranslation();
  const listing = gateway.listing[currency];
  if (!listing) return <span className="text-muted-foreground">—</span>;
  if (listing.listed) {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" aria-hidden />
        {sbLabel(t, 'gateways.listed')}
      </Badge>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant="outline" className="gap-1 border-border text-muted-foreground">
        <XCircle className="h-3 w-3" aria-hidden />
        {sbLabel(t, 'gateways.notListed')}
      </Badge>
      <div className="flex flex-wrap gap-1">
        {listing.reasons.map((reason) => {
          const label = sbLabel(t, `gateways.reason.${reason}`, reason);
          const href = fixHref(reason, gateway.provider_name);
          return href ? (
            <Link
              key={reason}
              to={href}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 hover:underline dark:text-amber-400"
              title={sbLabel(t, 'gateways.fix')}
            >
              {label}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          ) : (
            <span
              key={reason}
              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400"
              title={sbLabel(t, 'gateways.fixBelow')}
            >
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function GatewaysReadinessCard({ refreshKey }: { refreshKey?: string }) {
  const { t, locale } = useTranslation();
  const { data, isLoading, isError, refetch } = useGatewayReadiness();

  // The table below changed a gateway: read the rule's answer again.
  const seen = useRef(refreshKey);
  useEffect(() => {
    if (seen.current === refreshKey) return;
    seen.current = refreshKey;
    void refetch();
  }, [refreshKey, refetch]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{sbLabel(t, 'gateways.readinessTitle')}</CardTitle>
        <CardDescription>{sbLabel(t, 'gateways.readinessHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : isError || !data ? (
          <ErrorState message={sbLabel(t, 'common.loadFailed')} onRetry={() => void refetch()} retryLabel={sbLabel(t, 'common.retry')} />
        ) : data.gateways.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{sbLabel(t, 'gateways.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{sbLabel(t, 'gateways.gateway')}</TableHead>
                  {data.currencies.map((c) => <TableHead key={c}>{c}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.gateways.map((g) => (
                  <TableRow key={g.provider_name}>
                    <TableCell className="align-top">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{gatewayLabel(g.display_name, g.provider_name, locale)}</span>
                        {g.is_test && <Badge variant="secondary">{sbLabel(t, 'common.test')}</Badge>}
                      </div>
                      <span className="font-mono text-xs text-muted-foreground" dir="ltr">{g.provider_name}</span>
                      {g.card_auto_renew !== undefined && (
                        <div className="mt-1 text-xs">
                          <Link
                            to={fixHref('card_auto_renew', g.provider_name) ?? '#'}
                            className="inline-flex items-center gap-1 text-muted-foreground hover:underline"
                          >
                            {sbLabel(t, 'gateways.cardAutoRenew')}:{' '}
                            <span className={g.card_auto_renew ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                              {sbLabel(t, g.card_auto_renew ? 'gateways.cardAutoRenewOn' : 'gateways.cardAutoRenewOff')}
                            </span>
                          </Link>
                        </div>
                      )}
                    </TableCell>
                    {data.currencies.map((c) => (
                      <TableCell key={c} className="align-top">
                        <ListingCell gateway={g} currency={c} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
