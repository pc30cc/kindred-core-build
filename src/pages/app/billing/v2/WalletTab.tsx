/**
 * Wallet — balance, auto-pay, deposit, and a human-readable ledger.
 *
 * Deposit is the one place a customer moves money without an invoice, so the
 * presets, min and max all come from server policy rather than constants here.
 * Auto-pay copy is explicit that issuing an invoice does not debit the wallet
 * on the spot: the charge happens at the due date.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SkeletonStats } from '@/components/common/Skeletons';
import { Loader2, Plus, Wallet as WalletIcon } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import {
  billingV2Wallet,
  billingV2SetAutoPay,
  billingV2DepositPreview,
  billingV2DepositCheckout,
  type WalletView,
} from '@/lib/billingV2Api';

type DepositDraft = { id: string; documentNumber: string; amountIrr: number };
import { billingDate, money, Ltr, ErrorState, EmptyState, Pager, errorMessage } from './shared';

const RIAL_PER_TOMAN = 10;

export default function WalletTab({
  workspaceId,
  canManage,
  reloadKey,
  onChanged,
}: {
  workspaceId: string;
  canManage: boolean;
  reloadKey: number;
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const [data, setData] = useState<WalletView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [savingAutoPay, setSavingAutoPay] = useState(false);

  const [depositOpen, setDepositOpen] = useState(false);
  const [amountToman, setAmountToman] = useState('');
  const [preview, setPreview] = useState<DepositDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    billingV2Wallet(workspaceId, { page, pageSize: 10 })
      .then(setData)
      .catch((e) => setError(errorMessage(e, t)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, page, reloadKey]);

  async function toggleAutoPay(enabled: boolean) {
    setSavingAutoPay(true);
    try {
      await billingV2SetAutoPay(workspaceId, enabled);
      setData((prev) => (prev ? { ...prev, autoPayEnabled: enabled } : prev));
      onChanged();
      toast.success(t('billingV2.wallet.saved'));
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setSavingAutoPay(false);
    }
  }

  function openDeposit(presetIrr?: number) {
    setPreview(null);
    setAmountToman(presetIrr ? String(Math.round(presetIrr / RIAL_PER_TOMAN)) : '');
    setDepositOpen(true);
  }

  async function runPreview() {
    const toman = Number(amountToman);
    if (!Number.isFinite(toman) || toman <= 0) {
      toast.error(t('billingV2.wallet.invalidAmount'));
      return;
    }
    setBusy(true);
    try {
      const res = await billingV2DepositPreview(workspaceId, toman * RIAL_PER_TOMAN);
      setPreview(res.deposit);
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function goToGateway() {
    if (!preview) return;
    setBusy(true);
    try {
      const callbackUrl = `${window.location.origin}${window.location.pathname}`;
      const res = await billingV2DepositCheckout(workspaceId, preview.id, callbackUrl);
      const url = res.paymentUrl || res.checkoutUrl || res.url;
      if (!url) throw new Error('NO_PROVIDER_CONFIGURED');
      window.location.href = url;
    } catch (e) {
      toast.error(errorMessage(e, t));
      setBusy(false);
    }
  }

  if (loading) return <SkeletonStats count={2} />;
  if (error) return <ErrorState message={error} onRetry={load} retryLabel={t('billingV2.common.retry')} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <WalletIcon className="h-4 w-4 text-primary" />
              {t('billingV2.wallet.balance')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-3xl font-bold">{money(data.balanceIrr, locale)}</p>
            {data.frozen && <Badge variant="destructive">{t('billingV2.wallet.frozen')}</Badge>}
            {canManage && !data.frozen && (
              <div className="flex flex-wrap gap-2">
                {data.deposit.presetsIrr.map((p) => (
                  <Button key={p} size="sm" variant="outline" onClick={() => openDeposit(p)}>
                    {money(p, locale)}
                  </Button>
                ))}
                {data.deposit.allowCustom && (
                  <Button size="sm" onClick={() => openDeposit()}>
                    <Plus className="me-1.5 h-4 w-4" />
                    {t('billingV2.wallet.deposit')}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('billingV2.wallet.autoPay')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{t('billingV2.overview.autoPayOn')}</p>
              <Switch
                checked={data.autoPayEnabled}
                disabled={!canManage || savingAutoPay}
                onCheckedChange={toggleAutoPay}
              />
            </div>
            <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
              {t('billingV2.wallet.autoPayDesc')}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('billingV2.wallet.ledger')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.ledger.entries.length === 0 ? (
            <EmptyState message={t('billingV2.wallet.empty')} />
          ) : (
            <>
              <div className="space-y-2">
                {data.ledger.entries.map((entry) => (
                  <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {t(`billingV2.wallet.entryTypes.${entry.entryType}` as any)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {billingDate(entry.createdAt, locale)}
                        {entry.reference ? <> · <Ltr>{entry.reference}</Ltr></> : null}
                      </p>
                    </div>
                    <span
                      className={`text-sm font-semibold ${entry.amountIrr >= 0 ? 'text-emerald-600' : 'text-destructive'}`}
                    >
                      {entry.amountIrr >= 0 ? '+' : '−'} {money(Math.abs(entry.amountIrr), locale)}
                    </span>
                  </div>
                ))}
              </div>
              <Pager
                page={page}
                pageSize={data.ledger.pageSize}
                total={data.ledger.total}
                onPage={setPage}
                labels={{
                  page: t('billingV2.common.page', {
                    page,
                    pages: Math.max(1, Math.ceil(data.ledger.total / data.ledger.pageSize)),
                  }),
                  prev: t('billingV2.common.prev'),
                  next: t('billingV2.common.next'),
                }}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={depositOpen} onOpenChange={(open) => !open && setDepositOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('billingV2.wallet.depositTitle')}</DialogTitle>
          </DialogHeader>

          {!preview ? (
            <div className="space-y-3">
              <Input
                inputMode="numeric"
                dir="ltr"
                value={amountToman}
                onChange={(e) => setAmountToman(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={t('billingV2.wallet.custom')}
              />
              <p className="text-xs text-muted-foreground">
                {t('billingV2.wallet.range', {
                  min: money(data.deposit.minIrr, locale),
                  max: money(data.deposit.maxIrr, locale),
                })}
              </p>
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('billingV2.common.amount')}</span>
                <span className="font-semibold">{money(preview.amountIrr, locale)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('billingV2.wallet.receipt')}</span>
                <Ltr>{preview.documentNumber}</Ltr>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('billingV2.wallet.receiptNumber')}</span>
                <Ltr>{preview.documentNumber}</Ltr>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDepositOpen(false)} disabled={busy}>
              {t('billingV2.common.cancel')}
            </Button>
            {!preview ? (
              <Button onClick={runPreview} disabled={busy}>
                {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('billingV2.common.continue')}
              </Button>
            ) : (
              <Button onClick={goToGateway} disabled={busy}>
                {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t('billingV2.wallet.continueToBank')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
