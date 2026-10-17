/**
 * Card to card, step two of the top-up dialog (Iranian edition): the bank
 * card to transfer to, then the transfer's details and the bank receipt.
 * The server recomputes the amount, checks the file and the tracking number,
 * and the wallet is credited only once a Super Admin approves the receipt.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, Loader2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import { accountBillingApi, type CardTransferAccount } from '@/lib/accountBillingApi';
import {
  CARD_TRANSFER_RECEIPT_MAX_BYTES,
  CARD_TRANSFER_RECEIPT_TYPES,
  latinDigits,
} from '../../../../../shared/cardTransfer';
import { money } from '../shared';
import BankCard from './BankCard';
import { accountErrorText } from './accountUi';

interface Props {
  workspaceId: string;
  account: CardTransferAccount;
  /** The credit asked for, and what to transfer (credit + VAT). */
  netMinor: number;
  totalMinor: number;
  currency: string;
  onBack: () => void;
  onSubmitted: () => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

/** The current local time as a datetime-local value ("2026-10-16T14:05"). */
function nowLocal(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function CardTransferStep({
  workspaceId,
  account,
  netMinor,
  totalMinor,
  currency,
  onBack,
  onSubmitted,
  busy,
  setBusy,
}: Props) {
  const { t, locale, dir } = useTranslation();
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(nowLocal);
  const [last4, setLast4] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pick = (picked: File | undefined) => {
    setError(null);
    if (!picked) return;
    if (!(CARD_TRANSFER_RECEIPT_TYPES as readonly string[]).includes(picked.type)) {
      setError(t('billing.account.cardTransfer.err_receiptType'));
      return;
    }
    if (picked.size > CARD_TRANSFER_RECEIPT_MAX_BYTES) {
      setError(t('billing.account.cardTransfer.err_receiptLarge'));
      return;
    }
    setFile(picked);
  };

  const referenceDigits = latinDigits(reference);
  const last4Digits = latinDigits(last4);
  const referenceOk = referenceDigits.length >= 4 && referenceDigits.length <= 30;
  const last4Ok = !last4.trim() || last4Digits.length === 4;
  const ready = Boolean(file) && referenceOk && last4Ok && Boolean(paidAt);

  const submit = async () => {
    if (!file || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const dataBase64 = await readAsBase64(file);
      await accountBillingApi.submitCardTransfer(workspaceId, {
        amountMinor: netMinor,
        reference: referenceDigits,
        paidAt: new Date(paidAt).toISOString(),
        payerCardLast4: last4Digits || null,
        note: note.trim() || null,
        receipt: { fileName: file.name, mimeType: file.type, dataBase64 },
      });
      toast.success(t('billing.account.cardTransfer.submitted'));
      onSubmitted();
    } catch (e) {
      setError(accountErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="card-transfer-step">
      <div className="space-y-1.5 rounded-xl border border-primary/20 bg-primary/5 p-3.5">
        <p className="text-base font-semibold" data-testid="card-transfer-total">
          {t('billing.account.cardTransfer.transferTitle', { amount: money(totalMinor, locale, currency) })}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('billing.account.cardTransfer.transferBody')}</p>
      </div>

      <BankCard account={account} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="ct-reference">{t('billing.account.cardTransfer.reference')}</Label>
          <Input
            id="ct-reference"
            dir="ltr"
            inputMode="numeric"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            disabled={busy}
            aria-invalid={Boolean(reference) && !referenceOk}
            data-testid="ct-reference"
          />
          <p className="text-xs text-muted-foreground">{t('billing.account.cardTransfer.referenceHint')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ct-paid-at">{t('billing.account.cardTransfer.paidAt')}</Label>
          <Input
            id="ct-paid-at"
            type="datetime-local"
            dir="ltr"
            value={paidAt}
            max={nowLocal()}
            onChange={(e) => setPaidAt(e.target.value)}
            disabled={busy}
            data-testid="ct-paid-at"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ct-last4">{t('billing.account.cardTransfer.last4')}</Label>
          <Input
            id="ct-last4"
            dir="ltr"
            inputMode="numeric"
            maxLength={4}
            value={last4}
            onChange={(e) => setLast4(e.target.value)}
            disabled={busy}
            aria-invalid={!last4Ok}
            placeholder="••••"
            data-testid="ct-last4"
          />
          <p className="text-xs text-muted-foreground">{t('billing.account.cardTransfer.last4Hint')}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>{t('billing.account.cardTransfer.receipt')}</Label>
        <input
          ref={inputRef}
          type="file"
          accept={CARD_TRANSFER_RECEIPT_TYPES.join(',')}
          className="hidden"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = '';
          }}
          data-testid="ct-file"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            pick(e.dataTransfer.files?.[0]);
          }}
          className="flex w-full items-center gap-3 rounded-xl border-2 border-dashed border-border bg-muted/30 p-3 text-start transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:opacity-60"
          data-testid="ct-dropzone"
        >
          {preview ? (
            <img src={preview} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover ring-1 ring-border" />
          ) : (
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border">
              {file ? <FileText className="h-6 w-6 text-primary" aria-hidden /> : <Upload className="h-6 w-6 text-muted-foreground" aria-hidden />}
            </span>
          )}
          <span className="min-w-0 space-y-0.5">
            <span className="block truncate text-sm font-medium">
              {file ? file.name : t('billing.account.cardTransfer.receiptPick')}
            </span>
            <span className="block text-xs text-muted-foreground">
              {file ? t('billing.account.cardTransfer.receiptChange') : t('billing.account.cardTransfer.receiptHint')}
            </span>
          </span>
        </button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ct-note">{t('billing.account.cardTransfer.note')}</Label>
        <Textarea
          id="ct-note"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('billing.account.cardTransfer.notePlaceholder')}
          disabled={busy}
        />
      </div>

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowRight className={dir === 'rtl' ? 'me-2 h-4 w-4' : 'me-2 h-4 w-4 rotate-180'} aria-hidden />
          {t('billing.account.cardTransfer.back')}
        </Button>
        <Button type="button" onClick={submit} disabled={!ready || busy} data-testid="ct-submit">
          {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden />}
          {busy ? t('billing.account.cardTransfer.submitting') : t('billing.account.cardTransfer.submit')}
        </Button>
      </div>
    </div>
  );
}
