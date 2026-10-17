/**
 * Super Admin → Finance → Card to card (Iranian edition, migration 274).
 *
 * The bank account shown to workspaces that top up by card to card (with a
 * live preview of the card they see), and the review queue of their
 * receipts: open the receipt, approve — the wallet is credited through the
 * same booking as a gateway payment, with a numbered receipt and its mail —
 * or reject with a reason the workspace sees.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useEdition } from '@/hooks/useEdition';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { adminSimpleBillingApi, type AdminCardTransfer } from '@/lib/adminSimpleBillingApi';
import { Ltr, billingDate, money } from '@/pages/app/billing/shared';
import BankCard from '@/pages/app/billing/account/BankCard';
import {
  EMPTY_CARD_TRANSFER,
  latinDigits,
  normalizeCardNumber,
  normalizeIban,
  type CardTransferSettings,
  type CardTransferStatus,
} from '../../../../shared/cardTransfer';
import { TOPUP_LIMITS } from '../../../../shared/simpleBilling';

type Filter = CardTransferStatus | 'all';
const FILTERS: Filter[] = ['pending', 'approved', 'rejected', 'canceled', 'all'];
const K = 'admin.simpleBilling.cardTransfer';

const STATUS_STYLE: Record<CardTransferStatus, string> = {
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  approved: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  rejected: 'border-destructive/40 bg-destructive/10 text-destructive',
  canceled: 'border-border bg-muted text-muted-foreground',
};

function useErrorText() {
  const { t } = useTranslation();
  return (e: unknown) => {
    const code = (e as { code?: string } | null)?.code ?? '';
    const key = `${K}.e_${code}`;
    const text = t(key as never);
    return text !== key ? text : t(`${K}.e_generic` as never);
  };
}

function SettingsCard() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [form, setForm] = useState<CardTransferSettings>(EMPTY_CARD_TRANSFER);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminSimpleBillingApi.getCardTransferSettings()
      .then((r) => setForm(r.settings))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  const card = normalizeCardNumber(form.card_number);
  const iban = normalizeIban(form.iban);
  const previewable = Boolean(card && iban && form.holder_name.trim().length >= 2);

  const save = async () => {
    setSaving(true);
    try {
      const r = await adminSimpleBillingApi.putCardTransferSettings({
        ...form,
        card_number: latinDigits(form.card_number),
        iban: form.iban.trim(),
      });
      setForm(r.settings);
      toast.success(t(`${K}.saved` as never));
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t(`${K}.settingsTitle` as never)}</CardTitle>
        <CardDescription>{t(`${K}.settingsHint` as never)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,360px)]">
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <Label htmlFor="ct-enabled" className="font-medium">{t(`${K}.enabled` as never)}</Label>
              <Switch
                id="ct-enabled"
                checked={form.enabled}
                disabled={!loaded || saving}
                onCheckedChange={(enabled) => setForm((f) => ({ ...f, enabled }))}
                data-testid="ct-admin-enabled"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ct-holder">{t(`${K}.holder` as never)}</Label>
                <Input id="ct-holder" value={form.holder_name} maxLength={80} disabled={!loaded}
                  onChange={(e) => setForm((f) => ({ ...f, holder_name: e.target.value }))} data-testid="ct-admin-holder" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ct-bank">{t(`${K}.bank` as never)}</Label>
                <Input id="ct-bank" value={form.bank} maxLength={40} disabled={!loaded}
                  onChange={(e) => setForm((f) => ({ ...f, bank: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ct-card">{t(`${K}.cardNumber` as never)}</Label>
                <Input id="ct-card" dir="ltr" inputMode="numeric" value={form.card_number} disabled={!loaded}
                  aria-invalid={Boolean(form.card_number) && !card}
                  onChange={(e) => setForm((f) => ({ ...f, card_number: e.target.value }))} data-testid="ct-admin-card" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ct-iban">{t(`${K}.iban` as never)}</Label>
                <Input id="ct-iban" dir="ltr" value={form.iban} placeholder="IR…" disabled={!loaded}
                  aria-invalid={Boolean(form.iban) && !iban}
                  onChange={(e) => setForm((f) => ({ ...f, iban: e.target.value }))} data-testid="ct-admin-iban" />
              </div>
            </div>
            <Button onClick={save} disabled={!loaded || saving} data-testid="ct-admin-save">
              {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
              {t(`${K}.save` as never)}
            </Button>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t(`${K}.preview` as never)}</p>
            {previewable ? (
              <BankCard account={{ holder_name: form.holder_name.trim(), card_number: card!, iban: iban!, bank: form.bank }} />
            ) : (
              <div className="flex aspect-[1.586] items-center justify-center rounded-2xl border-2 border-dashed text-xs text-muted-foreground">
                —
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ReceiptDialog({ item, onClose }: { item: AdminCardTransfer | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!item) return;
    let objectUrl: string | null = null;
    adminSimpleBillingApi.cardTransferReceipt(item.id)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(null));
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [item]);
  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t(`${K}.receiptTitle` as never)}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-[320px] items-center justify-center overflow-hidden rounded-lg bg-muted">
          {!url ? (
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
          ) : item?.receipt_mime === 'application/pdf' ? (
            <iframe title="receipt" src={url} className="h-[70vh] w-full" />
          ) : (
            <img src={url} alt="" className="max-h-[70vh] w-auto object-contain" />
          )}
        </div>
        {url && (
          <DialogFooter>
            <Button variant="outline" onClick={() => window.open(url, '_blank', 'noopener')}>
              <ExternalLink className="me-2 h-4 w-4" aria-hidden />
              {t(`${K}.openNew` as never)}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApproveDialog({ item, onClose, onDone }: { item: AdminCardTransfer | null; onClose: () => void; onDone: () => void }) {
  const { t, locale, dir } = useTranslation();
  const errorText = useErrorText();
  const [toman, setToman] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (item) setToman(String(Math.round(item.net_minor / 10)));
  }, [item]);
  const netMinor = Number(latinDigits(toman)) * 10;
  const limits = TOPUP_LIMITS.IRR;
  const valid = Number.isSafeInteger(netMinor) && netMinor >= limits.min && netMinor <= limits.max;

  const approve = async () => {
    if (!item || !valid) return;
    setBusy(true);
    try {
      const r = await adminSimpleBillingApi.approveCardTransfer(item.id, netMinor !== item.net_minor ? netMinor : undefined);
      toast.success(t(`${K}.approved` as never, { receipt: r.receipt_number ?? '—' }));
      onDone();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent dir={dir} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(`${K}.approveTitle` as never)}</DialogTitle>
          <DialogDescription>{t(`${K}.approveBody` as never)}</DialogDescription>
        </DialogHeader>
        {item && (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-3 text-sm">
              <dt className="text-muted-foreground">{t(`${K}.workspace` as never)}</dt>
              <dd className="font-medium">{item.workspace_name ?? item.workspace_id.slice(0, 8)}</dd>
              <dt className="text-muted-foreground">{t(`${K}.amount` as never)}</dt>
              <dd className="font-medium tabular-nums">{money(item.amount_minor, locale, item.currency)}</dd>
              {item.reference && (
                <>
                  <dt className="text-muted-foreground">{t(`${K}.reference` as never)}</dt>
                  <dd><Ltr>{item.reference}</Ltr></dd>
                </>
              )}
            </dl>
            <div className="space-y-1.5">
              <Label htmlFor="ct-approve-credit">{t(`${K}.approveCredit` as never)}</Label>
              <Input id="ct-approve-credit" dir="ltr" inputMode="numeric" value={toman} aria-invalid={!valid}
                onChange={(e) => setToman(e.target.value)} data-testid="ct-approve-credit" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={approve} disabled={!valid || busy} data-testid="ct-approve-confirm">
            {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
            {t(`${K}.approveConfirm` as never)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ item, onClose, onDone }: { item: AdminCardTransfer | null; onClose: () => void; onDone: () => void }) {
  const { t, dir } = useTranslation();
  const errorText = useErrorText();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (item) setReason('');
  }, [item]);
  const valid = reason.trim().length >= 3 && reason.trim().length <= 500;
  const reject = async () => {
    if (!item || !valid) return;
    setBusy(true);
    try {
      await adminSimpleBillingApi.rejectCardTransfer(item.id, reason.trim());
      toast.success(t(`${K}.rejected` as never));
      onDone();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent dir={dir} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(`${K}.rejectTitle` as never)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="ct-reject-reason">{t(`${K}.rejectReason` as never)}</Label>
          <Textarea id="ct-reject-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)}
            data-testid="ct-reject-reason" />
        </div>
        <DialogFooter>
          <Button variant="destructive" onClick={reject} disabled={!valid || busy} data-testid="ct-reject-confirm">
            {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
            {t(`${K}.rejectConfirm` as never)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Queue() {
  const { t, locale } = useTranslation();
  const [filter, setFilter] = useState<Filter>('pending');
  const [items, setItems] = useState<AdminCardTransfer[] | null>(null);
  const [pending, setPending] = useState(0);
  const [receipt, setReceipt] = useState<AdminCardTransfer | null>(null);
  const [approving, setApproving] = useState<AdminCardTransfer | null>(null);
  const [rejecting, setRejecting] = useState<AdminCardTransfer | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await adminSimpleBillingApi.listCardTransfers(filter);
      setItems(r.items);
      setPending(r.pending);
    } catch {
      setItems([]);
    }
  }, [filter]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const done = () => {
    setApproving(null);
    setRejecting(null);
    void load();
  };

  const rows = useMemo(() => items ?? [], [items]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t(`${K}.queueTitle` as never)}</CardTitle>
          {pending > 0 && (
            <CardDescription data-testid="ct-pending-count">{t(`${K}.pendingCount` as never, { count: String(pending) })}</CardDescription>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)}>
              {t(`${K}.f_${f}` as never)}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {items === null ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden /></div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t(`${K}.empty` as never)}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((item) => (
              <li key={item.id} className="grid gap-3 py-4 lg:grid-cols-[1fr_auto]" data-testid={`ct-row-${item.id}`}>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{item.workspace_name ?? item.workspace_id.slice(0, 8)}</span>
                    {item.workspace_slug && <span className="text-xs text-muted-foreground"><Ltr>/{item.workspace_slug}</Ltr></span>}
                    <Badge variant="outline" className={cn('font-medium', STATUS_STYLE[item.status])}>
                      {t(`${K}.f_${item.status}` as never)}
                    </Badge>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                    <div><dt className="text-xs text-muted-foreground">{t(`${K}.amount` as never)}</dt>
                      <dd className="font-semibold tabular-nums">{money(item.amount_minor, locale, item.currency)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t(`${K}.credit` as never)}</dt>
                      <dd className="tabular-nums">{money(item.net_minor, locale, item.currency)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t(`${K}.reference` as never)}</dt>
                      <dd>{item.reference ? <Ltr>{item.reference}</Ltr> : '—'}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t(`${K}.paidAt` as never)}</dt>
                      <dd>{item.paid_at ? billingDate(item.paid_at, locale) : '—'}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t(`${K}.last4` as never)}</dt>
                      <dd>{item.payer_card_last4 ? <Ltr>•••• {item.payer_card_last4}</Ltr> : '—'}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t(`${K}.requester` as never)}</dt>
                      <dd className="truncate">{item.requester_email ? <Ltr>{item.requester_email}</Ltr> : '—'}</dd></div>
                  </dl>
                  {item.note && <p className="text-sm text-muted-foreground">{t(`${K}.note` as never)}: {item.note}</p>}
                  {item.review_note && (
                    <p className="text-sm text-destructive">{t(`${K}.reason` as never)}: {item.review_note}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t(`${K}.submitted` as never)}: {billingDate(item.created_at, locale)}
                    {item.reviewed_at && ` · ${t(`${K}.reviewed` as never)}: ${billingDate(item.reviewed_at, locale)}`}
                  </p>
                </div>
                <div className="flex flex-wrap items-start gap-2 lg:flex-col lg:items-stretch">
                  <Button size="sm" variant="outline" onClick={() => setReceipt(item)} data-testid="ct-view-receipt">
                    <ExternalLink className="me-1.5 h-4 w-4" aria-hidden />
                    {t(`${K}.viewReceipt` as never)}
                  </Button>
                  {item.status === 'pending' && (
                    <>
                      <Button size="sm" onClick={() => setApproving(item)} data-testid="ct-approve">
                        <Check className="me-1.5 h-4 w-4" aria-hidden />
                        {t(`${K}.approve` as never)}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRejecting(item)} data-testid="ct-reject">
                        <X className="me-1.5 h-4 w-4" aria-hidden />
                        {t(`${K}.reject` as never)}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ReceiptDialog item={receipt} onClose={() => setReceipt(null)} />
      <ApproveDialog item={approving} onClose={() => setApproving(null)} onDone={done} />
      <RejectDialog item={rejecting} onClose={() => setRejecting(null)} onDone={done} />
    </Card>
  );
}

export default function CardTransfersTab() {
  const { t } = useTranslation();
  const { isIran } = useEdition();
  if (!isIran) {
    return <p className="text-sm text-muted-foreground">{t(`${K}.notIran` as never)}</p>;
  }
  return (
    <div className="space-y-6">
      <SettingsCard />
      <Queue />
    </div>
  );
}
