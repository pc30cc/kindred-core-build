/**
 * ADMIN — SUPPRESSED EMAIL ADDRESSES
 *
 * The addresses the platform no longer mails (server/services/email/
 * suppressions.ts): mail to them hard-bounced, their owner complained, or
 * an admin held them back. Every provider checks the same list before
 * sending, so this is where a Super Admin finds out why someone gets no
 * mail, and lets mail to them go out again. Search, list, remove; a removal
 * is audited, and an address that still bounces comes back on its own.
 */

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Loader2, Search, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import { useI18n } from '@/i18n';
import { formatDateTime } from '@/lib/date';
import { fetchEmailSuppressions, removeEmailSuppression, type EmailSuppression } from './emailProviderApi';

const PAGE_SIZE = 25;
const QUERY_KEY = 'admin-email-suppressions';

export function EmailSuppressionsCard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<EmailSuppression | null>(null);

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: [QUERY_KEY, search, offset],
    queryFn: () => fetchEmailSuppressions({ search, limit: PAGE_SIZE, offset }),
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: (address: string) => removeEmailSuppression(address),
    onSuccess: (result, address) => {
      setPending(null);
      toast({
        title: result.removed
          ? t('adminProviders.email.suppressions.removed', { address })
          : t('adminProviders.email.suppressions.notFound'),
      });
      void qc.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
    onError: (err) => {
      setPending(null);
      toast({
        title: t('adminProviders.email.saveFailed'),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    },
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const reasonLabel = (reason: string) => {
    const key = `adminProviders.email.suppressions.reasons.${reason}`;
    const label = t(key as never);
    return label === key ? reason : label;
  };

  return (
    <Card className="border-border/60" data-email-suppressions>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-muted text-muted-foreground shrink-0">
            <Ban className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold text-foreground">{t('adminProviders.email.suppressions.title')}</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">{t('adminProviders.email.suppressions.desc')}</p>
          </div>
        </div>

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(draft.trim());
            setOffset(0);
          }}
        >
          <div className="relative flex-1">
            <Search className="absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground start-2.5" />
            <Input
              dir="ltr"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t('adminProviders.email.suppressions.search')}
              className="h-8 text-xs ps-8"
            />
          </div>
          <Button type="submit" size="sm" variant="outline" className="h-8">
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('adminProviders.email.suppressions.searchButton')}
          </Button>
        </form>

        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : isError ? (
          <p className="py-3 text-center text-xs text-destructive">{t('adminProviders.email.suppressions.loadFailed')}</p>
        ) : rows.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">
            {search ? t('adminProviders.email.suppressions.noMatch') : t('adminProviders.email.suppressions.empty')}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((row) => (
              <li
                key={row.address}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span dir="ltr" className="text-xs font-medium text-foreground break-all">{row.address}</span>
                    <Badge variant="outline" className="h-4 px-1 text-[9px] border-border text-muted-foreground">
                      {reasonLabel(row.reason)}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t('adminProviders.email.suppressions.meta', {
                      count: row.bounce_count,
                      source: row.source,
                      last: formatDateTime(row.last_seen_at, undefined, locale),
                      until: row.expires_at
                        ? formatDateTime(row.expires_at, undefined, locale)
                        : t('adminProviders.email.suppressions.never'),
                    })}
                  </p>
                </div>
                <Button
                  size="sm" variant="ghost"
                  className="h-7 px-2 text-[11px] text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => setPending(row)}
                >
                  <Trash2 className="h-3 w-3 me-1" />
                  {t('adminProviders.email.suppressions.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{t('adminProviders.email.suppressions.range', {
              from: offset + 1,
              to: Math.min(offset + PAGE_SIZE, total),
              total,
            })}</span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                {t('adminProviders.email.suppressions.prev')}
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}>
                {t('adminProviders.email.suppressions.next')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <AlertDialog open={!!pending} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <AlertDialogContent className="admin-scope bg-card border-border text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">
              {t('adminProviders.email.suppressions.removeTitle', { address: pending?.address ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {t('adminProviders.email.suppressions.removeDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border text-foreground hover:bg-muted">
              {t('adminProviders.form.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => pending && remove.mutate(pending.address)} disabled={remove.isPending}>
              {t('adminProviders.email.suppressions.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
