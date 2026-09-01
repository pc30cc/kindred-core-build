/**
 * AiCreditPanel — workspace-facing AI credit wallet.
 *
 * Shows ONLY final customer-facing numbers (allowance, purchased credit,
 * used this cycle). Provider cost, FX and the sell multiplier are platform
 * internals and are never fetched or rendered here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Loader2, Sparkles, Wallet, TrendingUp } from 'lucide-react';
import { API_BASE } from '@/lib/apiBase';
import { useTranslation } from '@/i18n';
import { useLiveUsageRefresh } from '@/hooks/useLiveUsageRefresh';
import { formatJalaliDateTime } from '@/lib/date';

interface Summary {
  currency: string;
  cycleId: string;
  renewsAt: string;
  available: number;
  reserved: number;
  granted: number;
  usedThisCycle: number;
  planRemaining: number;
  purchasedRemaining: number;
  aiReplies: number;
  mode: 'METER_ONLY' | 'ENFORCED';
}

export function AiCreditPanel({ workspaceId }: { workspaceId: string }) {
  const { t, locale, dir } = useTranslation();
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (silent = false) => {
      if (!silent) setLoading(true);
      fetch(`${API_BASE}/api/ai-billing/workspaces/${workspaceId}/summary`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: Summary) => setData(d))
        .catch(() => { /* transient */ })
        .finally(() => setLoading(false));
    },
    [workspaceId],
  );

  useEffect(() => { load(); }, [load]);
  useLiveUsageRefresh(!!workspaceId, useCallback(() => load(true), [load]));

  const nf = (n: number) => new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : locale).format(Math.round(n || 0));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data) return null;

  const total = Math.max(data.usedThisCycle + data.available, 1);
  const pct = Math.min(100, Math.round((data.usedThisCycle / total) * 100));

  return (
    <Card dir={dir}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> {t('aiBilling.walletTitle')}
            </CardTitle>
            <CardDescription>{t('aiBilling.walletHint')}</CardDescription>
          </div>
          {data.mode === 'METER_ONLY' && <Badge variant="secondary">{t('aiBilling.meterOnlyNotice')}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>{t('aiBilling.usedThisCycle')}: <span className="font-semibold text-foreground">{nf(data.usedThisCycle)}</span></span>
            <span>{t('aiBilling.available')}: <span className="font-semibold text-foreground">{nf(data.available)}</span></span>
          </div>
          <Progress value={pct} className="h-2" />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Wallet, label: t('aiBilling.planRemaining'), value: nf(data.planRemaining) },
            { icon: Wallet, label: t('aiBilling.purchasedRemaining'), value: nf(data.purchasedRemaining) },
            { icon: TrendingUp, label: t('aiBilling.aiReplies'), value: nf(data.aiReplies) },
            { icon: Sparkles, label: t('aiBilling.reservedAmount'), value: nf(data.reserved) },
          ].map((k) => (
            <div key={k.label} className="rounded-xl border border-border/60 bg-card p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <k.icon className="h-3.5 w-3.5" /> {k.label}
              </div>
              <div className="mt-1 text-sm font-semibold">{k.value}</div>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          {t('aiBilling.renewsAt')}: {locale === 'fa' ? formatJalaliDateTime(data.renewsAt) : new Date(data.renewsAt).toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}
