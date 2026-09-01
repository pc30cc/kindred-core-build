/**
 * PlanUsagePanel — customer-facing plan / usage visibility.
 *
 * Renders the canonical workspace effective-state payload from
 *   GET /api/plans/workspace/:id/effective
 *
 * Strict rules:
 *   - No client-side entitlement re-implementation.
 *   - No fake usage math: if a usage value is not present in the
 *     canonical counters payload, we render "usage unavailable" rather
 *     than guessing.
 *   - Super Admin override controls are NOT rendered here. Source
 *     badges (`override` / `plan` / `default`) are read-only context.
 *   - Registry catalog drives labels; only `userVisible` capabilities
 *     are shown.
 */

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Loader2, Check, X, Infinity as InfinityIcon, AlertCircle,
  MessageSquare, Users, Sparkles, HardDrive, PhoneCall, Timer, Database,
} from 'lucide-react';
import {
  fetchWorkspaceEffective,
  fetchCapabilityCatalog,
  type WorkspaceEffectiveEntitlements,
  type CapabilityDefinition,
} from '@/lib/entitlements-api';
import { useTranslation } from '@/i18n';
import { bt, capLabel, formatLimitValue, formatUsageValue, type BillingLocale } from '@/lib/billing-i18n';

/**
 * Map registry limit keys → column on `workspace_usage_counters` returned
 * inside `effective.usage`. Keys not in this map have no canonical
 * counter on the customer payload and are rendered as "usage unavailable".
 * Mirrors `server/services/billing/usageResolvers.ts` reads.
 */
const USAGE_COLUMN_BY_LIMIT: Record<string, { col: string; transform?: (n: number) => number }> = {
  max_conversations: { col: 'conversations_count' },
  max_visitors: { col: 'visitors_count' },
  ai_credits_per_month: { col: 'ai_credits_used' },
  storage_gb: { col: 'storage_bytes', transform: (b) => b / (1024 * 1024 * 1024) },
};

function readUsage(usage: Record<string, any> | null, limitKey: string): { value: number; available: true } | { available: false } {
  const map = USAGE_COLUMN_BY_LIMIT[limitKey];
  if (!map || !usage) return { available: false };
  const raw = usage[map.col];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { available: false };
  return { value: map.transform ? map.transform(raw) : raw, available: true };
}

// Per-limit accent color + icon for the cards.
const LIMIT_DECOR: Record<string, { icon: any; tint: string; bg: string; ring: string; bar: string }> = {
  max_conversations:        { icon: MessageSquare, tint: 'text-sky-500',     bg: 'bg-sky-500/10',     ring: 'ring-sky-500/20',     bar: 'bg-sky-500' },
  max_visitors:             { icon: Users,         tint: 'text-violet-500',  bg: 'bg-violet-500/10',  ring: 'ring-violet-500/20',  bar: 'bg-violet-500' },
  ai_credits_per_month:     { icon: Sparkles,      tint: 'text-fuchsia-500', bg: 'bg-fuchsia-500/10', ring: 'ring-fuchsia-500/20', bar: 'bg-fuchsia-500' },
  storage_gb:               { icon: HardDrive,     tint: 'text-emerald-500', bg: 'bg-emerald-500/10', ring: 'ring-emerald-500/20', bar: 'bg-emerald-500' },
  max_call_minutes_per_month: { icon: PhoneCall,   tint: 'text-amber-500',   bg: 'bg-amber-500/10',   ring: 'ring-amber-500/20',   bar: 'bg-amber-500' },
  data_retention_days:      { icon: Timer,         tint: 'text-rose-500',    bg: 'bg-rose-500/10',    ring: 'ring-rose-500/20',    bar: 'bg-rose-500' },
};
const DEFAULT_DECOR = { icon: Database, tint: 'text-primary', bg: 'bg-primary/10', ring: 'ring-primary/20', bar: 'bg-primary' };

interface Props {
  workspaceId: string;
}

export function PlanUsagePanel({ workspaceId }: Props) {
  const { locale, dir } = useTranslation();
  const L = locale as BillingLocale;
  const [eff, setEff] = useState<WorkspaceEffectiveEntitlements | null>(null);
  const [catalog, setCatalog] = useState<CapabilityDefinition[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchWorkspaceEffective(workspaceId), fetchCapabilityCatalog()])
      .then(([effRes, catRes]) => {
        if (cancelled) return;
        setEff(effRes);
        setCatalog(catRes.capabilities);
        setError(null);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e.message || 'Failed to load plan state');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error || !eff || !catalog) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <AlertCircle className="w-6 h-6 mx-auto mb-2" />
          <p>{error || bt(L, 'planUnavailable')}</p>
        </CardContent>
      </Card>
    );
  }

  // Curate from registry (userVisible only), preserve declared sortOrder.
  const visible = catalog.filter((c) => c.userVisible && !c.internalOnly);
  const limits = visible
    .filter((c) => c.type === 'limit')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const modules = visible
    .filter((c) => c.type === 'module')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const channels = visible
    .filter((c) => c.type === 'channel')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const features = visible
    .filter((c) => c.type === 'feature')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const localizedPlanName = ((eff.plan as any)?.localized?.[L]?.name as string | undefined)?.trim()
    || eff.plan?.name
    || bt(L, 'free');

  // Render only limits the plan actually exposes (i.e. has an effective state).
  const visibleLimits = limits.filter((c) => !!eff.limits[c.key]);

  return (
    <div className="space-y-6" data-testid="plan-usage-panel" dir={dir}>
      {/* Usage overview — clean colorful cards */}
      {visibleLimits.length > 0 && (
        <section>
          <div className="mb-3">
            <h2 className="text-base font-semibold text-foreground">{bt(L, 'usageOverview')}</h2>
            <p className="text-xs text-muted-foreground">{bt(L, 'usageOverviewDesc')}</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {visibleLimits.map((cap) => {
              const state = eff.limits[cap.key]!;
              const limitValue = state.value as number | null;
              const isUnlimited = limitValue === -1;
              const usage = readUsage(eff.usage, cap.key);
              const decor = LIMIT_DECOR[cap.key] || DEFAULT_DECOR;
              const Icon = decor.icon;
              const pct =
                !isUnlimited && usage.available && typeof limitValue === 'number' && limitValue > 0
                  ? Math.min(100, Math.round((usage.value / limitValue) * 100))
                  : null;
              const label = capLabel(cap, L);
              return (
                <div
                  key={cap.key}
                  data-testid={`limit-row-${cap.key}`}
                  className={`relative rounded-xl border border-border/60 bg-card p-4 ring-1 ${decor.ring} transition hover:shadow-md`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className={`w-9 h-9 rounded-lg ${decor.bg} ${decor.tint} flex items-center justify-center`}>
                      <Icon className="w-4.5 h-4.5" />
                    </div>
                    {isUnlimited ? (
                      <span className={`inline-flex items-center gap-1 text-xs font-semibold ${decor.tint}`}>
                        <InfinityIcon className="w-3.5 h-3.5" /> {bt(L, 'unlimited')}
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground">
                        {pct !== null ? `${pct}%` : ''}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 text-sm font-medium text-foreground line-clamp-1">{label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {isUnlimited ? (
                      <span>&nbsp;</span>
                    ) : usage.available ? (
                      <>
                        <span className="font-semibold text-foreground">{formatUsageValue(usage.value, cap.unit, L)}</span>
                        <span className="mx-1">{bt(L, 'ofLabel')}</span>
                        <span>{formatLimitValue(limitValue ?? 0, cap, L)}</span>
                      </>
                    ) : (
                      <span>{formatLimitValue(limitValue ?? 0, cap, L)}</span>
                    )}
                  </div>
                  {!isUnlimited && pct !== null ? (
                    <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div className={`h-full ${decor.bar} transition-all`} style={{ width: `${pct}%` }} />
                    </div>
                  ) : !isUnlimited ? (
                    <p className="mt-3 text-[11px] text-muted-foreground/80">{bt(L, 'notTracked')}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Data & storage usage — raw workspace counters (always visible) */}
      <DataStorageSection usage={eff.usage} locale={L} />



      {/* Modules + Channels + Features — compact grouped panel */}
      <Card className="border-border/60">
        <CardContent className="p-5 space-y-5">
          {modules.length > 0 && (
            <CapabilityGroup title={bt(L, 'modules')} caps={modules} stateMap={eff.modules} locale={L} />
          )}
          {channels.length > 0 && (
            <CapabilityGroup title={bt(L, 'channels')} caps={channels} stateMap={eff.channels} locale={L} />
          )}
          {features.length > 0 && (
            <CapabilityGroup title={bt(L, 'features')} caps={features} stateMap={eff.features} locale={L} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatBytes(bytes: number, locale: BillingLocale): string {
  const nf = (n: number, d = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(n);
  if (!Number.isFinite(bytes) || bytes <= 0) return `${nf(0)} MB`;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${nf(gb, 2)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${nf(mb, 1)} MB`;
  return `${nf(bytes / 1024, 1)} KB`;
}

function DataStorageSection({
  usage, locale,
}: {
  usage: Record<string, any> | null;
  locale: BillingLocale;
}) {
  const L = locale;
  const nf = (n: number) => new Intl.NumberFormat(L, { maximumFractionDigits: 0 }).format(n);
  const num = (k: string) => {
    const v = usage?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  const items = [
    { key: 'storage', label: bt(L, 'storageUsed'), value: formatBytes(num('storage_bytes'), L), decor: LIMIT_DECOR.storage_gb },
    { key: 'conversations', label: bt(L, 'usageConversations'), value: nf(num('conversations_count')), decor: LIMIT_DECOR.max_conversations },
    { key: 'messages', label: bt(L, 'usageMessages'), value: nf(num('messages_count')), decor: DEFAULT_DECOR },
    { key: 'visitors', label: bt(L, 'usageVisitors'), value: nf(num('visitors_count')), decor: LIMIT_DECOR.max_visitors },
    { key: 'ai_credits', label: bt(L, 'usageAiCredits'), value: nf(num('ai_credits_used')), decor: LIMIT_DECOR.ai_credits_per_month },
    { key: 'ai_requests', label: bt(L, 'usageAiRequests'), value: nf(num('ai_requests_count')), decor: LIMIT_DECOR.ai_credits_per_month },
    { key: 'emails', label: bt(L, 'usageEmails'), value: nf(num('email_sent_count')), decor: DEFAULT_DECOR },
    { key: 'call_minutes', label: bt(L, 'usageCallMinutes'), value: nf(num('call_minutes_used')), decor: LIMIT_DECOR.max_call_minutes_per_month },
  ];

  return (
    <section data-testid="data-storage-usage">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">{bt(L, 'dataUsage')}</h2>
          <p className="text-xs text-muted-foreground">{bt(L, 'dataUsageDesc')}</p>
        </div>
        {usage?.period ? (
          <Badge variant="secondary" className="shrink-0">
            {bt(L, 'usagePeriod')}: {String(usage.period)}
          </Badge>
        ) : null}
      </div>

      {!usage ? (
        <Card className="border-border/60">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            {bt(L, 'usageUnavailable')}
          </CardContent>
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {items.map((it) => {
            const Icon = it.decor.icon;
            return (
              <div
                key={it.key}
                data-testid={`data-usage-${it.key}`}
                className={`rounded-xl border border-border/60 bg-card p-4 ring-1 ${it.decor.ring} transition hover:shadow-md`}
              >
                <div className={`w-9 h-9 rounded-lg ${it.decor.bg} ${it.decor.tint} flex items-center justify-center`}>
                  <Icon className="w-4.5 h-4.5" />
                </div>
                <div className="mt-3 text-lg font-semibold text-foreground">{it.value}</div>
                <div className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{it.label}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CapabilityGroup({

  title, caps, stateMap, locale,
}: {
  title: string;
  caps: CapabilityDefinition[];
  stateMap: Record<string, { value: unknown } | undefined>;
  locale: BillingLocale;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{title}</h3>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {caps.map((cap) => {
          const enabled = !!stateMap[cap.key]?.value;
          return (
            <div
              key={cap.key}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                enabled
                  ? 'border-emerald-500/20 bg-emerald-500/5 text-foreground'
                  : 'border-border/50 bg-muted/30 text-muted-foreground'
              }`}
            >
              <span className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${
                enabled ? 'bg-emerald-500/15 text-emerald-500' : 'bg-muted text-muted-foreground'
              }`}>
                {enabled ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
              </span>
              <span className="truncate">{capLabel(cap, locale)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}