/**
 * Shared presentation helpers for the Billing V2 workspace screens.
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
import { formatToman } from '@/lib/money';

/** Jalali in fa, Gregorian elsewhere — a display concern only, never storage. */
export function billingDate(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  return formatDate(value, { year: 'numeric', month: 'long', day: 'numeric' }, locale);
}

export function money(irr: number | null | undefined, locale: string): string {
  return formatToman(irr ?? 0, locale);
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
export function errorMessage(e: unknown, t: (k: any) => string): string {
  const code = (e as any)?.code || (e as any)?.message;
  if (typeof code === 'string' && /^[A-Z_]+$/.test(code)) {
    const translated = t(`billingV2.errors.${code}`);
    if (!translated.includes('billingV2.errors.')) return translated;
  }
  return t('billingV2.errors.generic');
}
