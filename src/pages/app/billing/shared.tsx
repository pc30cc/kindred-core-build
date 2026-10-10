/**
 * Shared presentation helpers for the workspace billing screens.
 *
 * Nothing here computes money. These helpers only turn server-decided values
 * into labels, badges and page furniture — and they map every backend enum to
 * a translated label so a raw DB status can never leak into the UI.
 */
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle, RefreshCw, Inbox } from 'lucide-react';
import { formatDate } from '@/lib/date';
import { defaultCurrencyFor, formatAmountForEdition, formatToman } from '@/lib/money';
import { formatPlanPrice } from '@/lib/planPrice';
import { currentEdition } from '@/lib/edition';
import type { TranslationKey } from '@/i18n';

/** Jalali in fa in the Iranian edition, Gregorian elsewhere (src/lib/date.ts) — display only, never storage. */
export function billingDate(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  return formatDate(value, { year: 'numeric', month: 'long', day: 'numeric' }, locale);
}

/**
 * A server amount as people read it. IRR (whole Rial) reads as Toman; every
 * other currency is in minor units and reads as e.g. "$29.00". With no
 * currency the edition's applies: IRR in the Iranian edition (AI credit and
 * the wallet are Rial there, so their callers leave it out), USD in the
 * International one — which never shows Toman.
 */
export function money(amount: number | null | undefined, locale: string, currency?: string | null): string {
  const edition = currentEdition();
  if (edition !== 'iran') return formatAmountForEdition(amount ?? 0, currency, locale, edition);
  const code = (currency || defaultCurrencyFor(edition)).toUpperCase();
  if (code === 'IRR') return formatToman(amount ?? 0, locale);
  return formatPlanPrice(amount ?? 0, code, locale);
}

/**
 * Document numbers, tracking codes and other identifiers stay LTR even inside
 * an RTL page, otherwise digits and separators reorder and the code becomes
 * unreadable (and untypeable into a bank's lookup form).
 */
export function Ltr({ children }: { children: ReactNode }) {
  return (
    <span dir="ltr" className="inline-block font-mono text-xs">
      {children}
    </span>
  );
}

const INVOICE_VARIANTS: Record<string, string> = {
  paid: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  open: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  partially_paid: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  past_due: 'bg-destructive/10 text-destructive border-destructive/20',
  void: 'bg-muted text-muted-foreground border-border',
  expired: 'bg-muted text-muted-foreground border-border',
  refunded: 'bg-sky-500/10 text-sky-600 border-sky-500/20',
  draft: 'bg-muted text-muted-foreground border-border',
};

export function InvoiceStatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <Badge variant="outline" className={INVOICE_VARIANTS[status] ?? INVOICE_VARIANTS.draft}>
      {label}
    </Badge>
  );
}

const TX_VARIANTS: Record<string, string> = {
  succeeded: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  pending: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  processing: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  review: 'bg-sky-500/10 text-sky-600 border-sky-500/20',
  refunded: 'bg-sky-500/10 text-sky-600 border-sky-500/20',
  failed: 'bg-destructive/10 text-destructive border-destructive/20',
  canceled: 'bg-muted text-muted-foreground border-border',
  expired: 'bg-muted text-muted-foreground border-border',
};

export function TxStatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <Badge variant="outline" className={TX_VARIANTS[status] ?? TX_VARIANTS.canceled}>
      {label}
    </Badge>
  );
}

export function ErrorState({ message, onRetry, retryLabel }: { message: string; onRetry?: () => void; retryLabel: string }) {
  return (
    <Card className="border-destructive/30">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <AlertTriangle className="h-6 w-6 text-destructive" />
        <p className="text-sm text-muted-foreground">{message}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="me-2 h-4 w-4" />
            {retryLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
      <Inbox className="h-6 w-6" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
  labels,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  labels: { page: string; prev: string; next: string };
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between pt-4">
      <span className="text-xs text-muted-foreground">{labels.page}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {labels.prev}
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          {labels.next}
        </Button>
      </div>
    </div>
  );
}

/** Server error code → translated message, with a safe generic fallback. */
export function errorMessage(e: unknown, t: (k: TranslationKey) => string): string {
  const err = e as { code?: unknown; message?: unknown; details?: unknown } | null | undefined;
  const code = err?.code || err?.message;
  // A gateway that refused the checkout: say so, with the gateway's own reason.
  if (code === 'CHECKOUT_PROVIDER_ERROR') {
    const details = (err?.details ?? null) as { providerMessage?: unknown } | null;
    const reason = typeof details?.providerMessage === 'string' ? details.providerMessage.trim() : '';
    const label = t('billing.errors.CHECKOUT_PROVIDER_ERROR' as TranslationKey);
    return reason ? `${label} ${reason}` : label;
  }
  if (typeof code === 'string' && /^[A-Za-z_]+$/.test(code)) {
    const translated = t(`billing.errors.${code}` as TranslationKey);
    if (!translated.includes('billing.errors.')) return translated;
  }
  return t('billing.errors.generic');
}
