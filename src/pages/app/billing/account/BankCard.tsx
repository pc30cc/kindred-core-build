/**
 * The platform's bank account for a card-to-card top-up, drawn as the bank
 * card itself (a blue bank card): bank name, chip, the card number
 * and the IBAN (شبا) on the card, the holder's name, and a copy button for
 * each number below it. The numbers are always left to right.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { toast } from '@/lib/toast';
import type { CardTransferAccount } from '@/lib/accountBillingApi';
import { formatCardNumber, formatIban } from '../../../../../shared/cardTransfer';

function CopyButton({ value, label, testId }: { value: string; label: string; testId: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      toast.success(t('billing.account.cardTransfer.copied'));
      window.setTimeout(() => setDone(false), 1800);
    } catch {
      toast.error(t('billing.account.cardTransfer.copyFailed'));
    }
  };
  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} className="flex-1 gap-1.5" data-testid={testId}>
      {done ? <Check className="h-4 w-4 text-emerald-600" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      {label}
    </Button>
  );
}

function Chip() {
  return (
    <svg viewBox="0 0 46 34" className="h-8 w-11" aria-hidden>
      <defs>
        <linearGradient id="bank-card-chip" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f6e7a8" />
          <stop offset="0.5" stopColor="#d6b15a" />
          <stop offset="1" stopColor="#f3dc8f" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="45" height="33" rx="6" fill="url(#bank-card-chip)" stroke="#b8923f" strokeOpacity="0.6" />
      <path d="M0 12h14M0 22h14M32 12h14M32 22h14M14 0v34M32 0v34M14 17h18" stroke="#9c7a2e" strokeOpacity="0.55" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

export default function BankCard({ account }: { account: CardTransferAccount }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid="bank-card">
      <div
        className="relative aspect-[1.586] w-full overflow-hidden rounded-2xl p-5 text-white shadow-xl shadow-blue-900/25 ring-1 ring-white/10"
        style={{ background: 'linear-gradient(135deg, #2f6bff 0%, #1d4ed8 45%, #172fa8 100%)' }}
      >
        {/* Soft light shapes, as on the real card */}
        <div aria-hidden className="pointer-events-none absolute -end-16 -top-20 h-56 w-56 rounded-full bg-white/10 blur-sm" />
        <div aria-hidden className="pointer-events-none absolute -bottom-24 -start-10 h-56 w-56 rounded-full bg-sky-300/20" />
        <div aria-hidden className="pointer-events-none absolute bottom-6 end-[-30%] h-24 w-[90%] rotate-[-12deg] rounded-full bg-white/5" />

        <div className="relative flex h-full flex-col justify-between">
          <div className="flex items-start justify-between gap-3">
            <span className="text-lg font-extrabold tracking-tight drop-shadow-sm" data-testid="bank-card-bank">{account.bank}</span>
            <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur-sm">
              {t('billing.account.cardTransfer.cardBadge')}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <Chip />
            <svg viewBox="0 0 24 24" className="h-6 w-6 text-white/80" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M8.5 7.5a6.5 6.5 0 0 1 0 9M12 5a10 10 0 0 1 0 14M15.5 2.5a13.5 13.5 0 0 1 0 19" strokeLinecap="round" />
            </svg>
          </div>

          <div dir="ltr" className="text-center font-mono text-[1.35rem] font-semibold tracking-[0.12em] tabular-nums drop-shadow sm:text-2xl" data-testid="bank-card-number">
            {formatCardNumber(account.card_number)}
          </div>

          <div className="space-y-1">
            <div dir="ltr" className="font-mono text-[0.72rem] tracking-wider text-white/85 tabular-nums" data-testid="bank-card-iban">
              {formatIban(account.iban)}
            </div>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-white/70">{t('billing.account.cardTransfer.holder')}</span>
              <span className="font-semibold" data-testid="bank-card-holder">{account.holder_name}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <CopyButton value={account.card_number} label={t('billing.account.cardTransfer.copyCard')} testId="copy-card-number" />
        <CopyButton value={account.iban} label={t('billing.account.cardTransfer.copyIban')} testId="copy-iban" />
      </div>
    </div>
  );
}
