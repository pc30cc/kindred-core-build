/**
 * One receipt, printable: the seller and the buyer as they were when the
 * money came in, what was paid for, the amount, the VAT (only when there was
 * VAT) and the total. Everything comes from the ledger row the server froze.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SkeletonCard } from '@/components/common/Skeletons';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { accountBillingApi, type LedgerEntry } from '@/lib/accountBillingApi';
import { ErrorState } from '../shared';
import { accountErrorText } from './accountUi';
import ReceiptDocument from './ReceiptDocument';

export default function ReceiptPage() {
  const { ledgerId, slug } = useParams<{ ledgerId: string; slug: string }>();
  const { workspace } = useActiveWorkspace();
  const { t, locale, dir } = useTranslation();
  const [receipt, setReceipt] = useState<LedgerEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace?.id || !ledgerId) return;
    accountBillingApi
      .receipt(workspace.id, ledgerId)
      .then((r) => setReceipt(r.receipt))
      .catch((e: { status?: number }) =>
        setError(e?.status === 404 ? t('billing.account.receipt.notFound') : accountErrorText(e, t)));
  }, [workspace?.id, ledgerId, t]);

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const back = (
    <Button asChild variant="ghost" size="sm" className="print:hidden">
      <Link to={`/${slug}/billing`}>
        <Back className="me-2 h-4 w-4" aria-hidden />
        {t('billing.account.receipt.back')}
      </Link>
    </Button>
  );

  if (error) {
    return (
      <div className="space-y-4 p-4 md:p-6 lg:p-8" dir={dir}>
        {back}
        <ErrorState message={error} retryLabel={t('billing.common.retry')} />
      </div>
    );
  }
  if (!receipt) {
    return (
      <div className="p-4 md:p-6 lg:p-8">
        <SkeletonCard lines={8} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6 lg:p-8 print:p-0" dir={dir}>
      <div className="flex items-center justify-between gap-2 print:hidden">
        {back}
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="me-2 h-4 w-4" aria-hidden />
          {t('billing.account.receipt.print')}
        </Button>
      </div>

      <ReceiptDocument receipt={receipt} locale={locale} dir={dir} />
    </div>
  );
}
