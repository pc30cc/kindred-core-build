/**
 * PlanUsagePanel — customer-facing plan / usage visibility.
 *
 * Renders the canonical workspace effective-state snapshot
 *   GET /api/plans/workspace/:id/effective   (useWorkspaceEffectiveEntitlements)
 * plus current usage for every limit the server can measure
 *   GET /api/plans/workspace/:id/limit-usage (fetchLimitUsage)
 *
 * Strict rules:
 *   - No client-side entitlement re-implementation: every limit the snapshot
 *     carries is shown with its effective value (-1 = unlimited).
 *   - No fake usage math: usage comes from the same resolvers the server
 *     enforces with. The server decides which keys it can measure (it drops
 *     the rest from the response); those limits show their allowance only.
 *   - Super Admin override controls are NOT rendered here.
 *   - Names, units and groups come from src/lib/capability-i18n.ts; the
 *     registry catalog only decides visibility, grouping and order.
 */

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { AiCreditPanel } from './AiCreditPanel';
import { Badge } from '@/components/ui/badge';
import {
  Loader2, Check, X, Infinity as InfinityIcon, AlertCircle,
  MessageSquare, Users, Sparkles, HardDrive, PhoneCall, Timer, Database,
  Contact, Search, Globe, ShoppingCart, Shield, Smartphone, Inbox, Palette, LifeBuoy,
  type LucideIcon,
} from 'lucide-react';
import {
  fetchCapabilityCatalog,
  fetchLimitUsageBatched,
  type CapabilityDefinition,
  type EffectiveState,
  type LimitUsage,
} from '@/lib/entitlements-api';
import { useWorkspaceEffectiveEntitlements } from '@/hooks/useEntitlements';
import { useTranslation } from '@/i18n';
import { bt, type BillingLocale } from '@/lib/billing-i18n';
import { capabilityGroupLabel, capabilityLabel, capabilityUnitLabel } from '@/lib/capability-i18n';
import { useLiveUsageRefresh } from '@/hooks/useLiveUsageRefresh';

type UsageCounters = Record<string, unknown> | null;
type UsageByKey = LimitUsage['usage'];

/**
 * Fallback only: the monthly `workspace_usage_counters` row carried by the
 * snapshot, for the four limits it has a column for. Used while /limit-usage
 * is loading or could not be read, so those cards never regress to
 * allowance-only.
 */
const USAGE_COLUMN_BY_LIMIT: Record<string, { col: string; transform?: (n: number) => number }> = {
  max_conversations: { col: 'conversations_count' },
  max_visitors: { col: 'visitors_count' },
  ai_credits_per_month: { col: 'ai_credits_used' },
  storage_gb: { col: 'storage_bytes', transform: (b) => b / (1024 * 1024 * 1024) },
};

function readUsage(key: string, measured: UsageByKey | undefined, counters: UsageCounters): number | null {
  const m = measured?.[key];
  if (m?.supported && Number.isFinite(m.value)) return m.value;
  const map = USAGE_COLUMN_BY_LIMIT[key];
  const raw = map && counters ? counters[map.col] : undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return map.transform ? map.transform(raw) : raw;
}

interface Decor { icon: LucideIcon; tint: string; bg: string; ring: string; bar: string }

// Per-limit accent color + icon for the cards.
const LIMIT_DECOR: Record<string, Decor> = {
  max_conversations:        { icon: MessageSquare, tint: 'text-sky-500',     bg: 'bg-sky-500/10',     ring: 'ring-sky-500/20',     bar: 'bg-sky-500' },
  max_visitors:             { icon: Users,         tint: 'text-violet-500',  bg: 'bg-violet-500/10',  ring: 'ring-violet-500/20',  bar: 'bg-violet-500' },
  ai_credits_per_month:     { icon: Sparkles,      tint: 'text-fuchsia-500', bg: 'bg-fuchsia-500/10', ring: 'ring-fuchsia-500/20', bar: 'bg-fuchsia-500' },
  storage_gb:               { icon: HardDrive,     tint: 'text-emerald-500', bg: 'bg-emerald-500/10', ring: 'ring-emerald-500/20', bar: 'bg-emerald-500' },
  max_call_minutes_per_month: { icon: PhoneCall,   tint: 'text-amber-500',   bg: 'bg-amber-500/10',   ring: 'ring-amber-500/20',   bar: 'bg-amber-500' },
  data_retention_days:      { icon: Timer,         tint: 'text-rose-500',    bg: 'bg-rose-500/10',    ring: 'ring-rose-500/20',    bar: 'bg-rose-500' },
};
// Every other limit takes its group's accent.
const GROUP_DECOR: Record<string, Decor> = {
  usage:    { icon: Database,      tint: 'text-sky-500',     bg: 'bg-sky-500/10',     ring: 'ring-sky-500/20',     bar: 'bg-sky-500' },
  team:     { icon: Users,         tint: 'text-indigo-500',  bg: 'bg-indigo-500/10',  ring: 'ring-indigo-500/20',  bar: 'bg-indigo-500' },
  contacts: { icon: Contact,       tint: 'text-teal-500',    bg: 'bg-teal-500/10',    ring: 'ring-teal-500/20',    bar: 'bg-teal-500' },
  calls:    { icon: PhoneCall,     tint: 'text-amber-500',   bg: 'bg-amber-500/10',   ring: 'ring-amber-500/20',   bar: 'bg-amber-500' },
  ai:       { icon: Sparkles,      tint: 'text-fuchsia-500', bg: 'bg-fuchsia-500/10', ring: 'ring-fuchsia-500/20', bar: 'bg-fuchsia-500' },
  seo:      { icon: Search,        tint: 'text-lime-600',    bg: 'bg-lime-500/10',    ring: 'ring-lime-500/20',    bar: 'bg-lime-500' },
  widget:   { icon: Globe,         tint: 'text-cyan-500',    bg: 'bg-cyan-500/10',    ring: 'ring-cyan-500/20',    bar: 'bg-cyan-500' },
  commerce: { icon: ShoppingCart,  tint: 'text-orange-500',  bg: 'bg-orange-500/10',  ring: 'ring-orange-500/20',  bar: 'bg-orange-500' },
  security: { icon: Shield,        tint: 'text-rose-500',    bg: 'bg-rose-500/10',    ring: 'ring-rose-500/20',    bar: 'bg-rose-500' },
  mobile:   { icon: Smartphone,    tint: 'text-slate-500',   bg: 'bg-slate-500/10',   ring: 'ring-slate-500/20',   bar: 'bg-slate-500' },
  inbox:    { icon: Inbox,         tint: 'text-blue-500',    bg: 'bg-blue-500/10',    ring: 'ring-blue-500/20',    bar: 'bg-blue-500' },
  branding: { icon: Palette,       tint: 'text-pink-500',    bg: 'bg-pink-500/10',    ring: 'ring-pink-500/20',    bar: 'bg-pink-500' },
  support:  { icon: LifeBuoy,      tint: 'text-emerald-500', bg: 'bg-emerald-500/10', ring: 'ring-emerald-500/20', bar: 'bg-emerald-500' },
};
const DEFAULT_DECOR: Decor = { icon: Database, tint: 'text-primary', bg: 'bg-primary/10', ring: 'ring-primary/20', bar: 'bg-primary' };

/** Groups in the order a customer reads them; anything else follows alphabetically. */
const GROUP_ORDER = ['usage', 'team', 'contacts', 'calls', 'ai', 'widget', 'inbox', 'commerce', 'seo'];
const OTHER_GROUP = '__other';

function numberLocale(locale: BillingLocale): string {
  return locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
}

function formatNumber(value: number, locale: BillingLocale): string {
  return new Intl.NumberFormat(numberLocale(locale), { maximumFractionDigits: 2 }).format(value);
}

/** "1,000 per month", "5 GB", "30 days" — the unit word comes from capability-i18n. */
function withUnit(formatted: string, unit: string | undefined, locale: BillingLocale): string {
  if (!unit || unit === 'count') return formatted;
  const label = capabilityUnitLabel(unit, locale);
  return label === '%' ? `${formatted}%` : `${formatted} ${label}`;
}

interface LimitRow {
  key: string;
  label: string;
  group: string;
  unit?: string;
  value: number;
  sortOrder: number;
  decor: Decor;
}

interface Props {
  workspaceId: string;
  /** The AI credit card; off where the page already has its own AI credit tab. */
  showAiCredit?: boolean;
}

export function PlanUsagePanel({ workspaceId, showAiCredit = true }: Props) {
  const { t, locale, dir } = useTranslation();
  const L = locale as BillingLocale;
  const { data: eff, loading: effLoading, error: effError, reload } = useWorkspaceEffectiveEntitlements(workspaceId);

  const catalogQuery = useQuery({
    queryKey: ['capability-catalog'],
    queryFn: () => fetchCapabilityCatalog(),
    staleTime: 5 * 60_000,
  });
  const catalog = catalogQuery.data?.capabilities ?? null;

  // Every limit the snapshot carries, minus what the registry keeps from customers.
  const rows = useMemo<LimitRow[]>(() => {
    if (!eff) return [];
    const byKey = new Map((catalog ?? []).map((c) => [c.key, c] as const));
    const out: LimitRow[] = [];
    for (const [key, state] of Object.entries(eff.limits) as Array<[string, EffectiveState<number | null> | undefined]>) {
      const value = state?.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const cap = byKey.get(key);
      if (cap && (!cap.userVisible || cap.internalOnly || cap.type !== 'limit')) continue;
      const group = cap?.group || OTHER_GROUP;
      out.push({
        key,
        label: capabilityLabel(key, L, cap?.label),
        group,
        unit: state?.unit ?? cap?.unit,
        value,
        sortOrder: cap?.sortOrder ?? Number.MAX_SAFE_INTEGER,
        decor: LIMIT_DECOR[key] || GROUP_DECOR[group] || DEFAULT_DECOR,
      });
    }
    return out;
  }, [eff, catalog, L]);

  // Ask the server for every finite limit; it answers only the keys it can measure.
  const usageKeys = useMemo(
    () => rows.filter((r) => r.value !== -1).map((r) => r.key).sort(),
    [rows],
  );
  const usageQuery = useQuery({
    queryKey: ['limit-usage', workspaceId, 'plan-panel', usageKeys.join(',')],
    enabled: !!workspaceId && usageKeys.length > 0,
    staleTime: 15_000,
    queryFn: () => fetchLimitUsageBatched(workspaceId, usageKeys),
  });
  const { refetch: refetchUsage } = usageQuery;

  // Live usage: silently re-pull the snapshot and the measured usage so
  // counters move without a page refresh (no spinner, no layout flash).
  const refreshLive = useCallback(() => {
    reload();
    if (usageKeys.length > 0) void refetchUsage();
  }, [reload, refetchUsage, usageKeys.length]);
  useLiveUsageRefresh(!!workspaceId, refreshLive);

  if (effLoading || catalogQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (effError || !eff || !eff.plan) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <AlertCircle className="w-6 h-6 mx-auto mb-2" />
          <p>{effError || bt(L, 'planUnavailable')}</p>
        </CardContent>
      </Card>
    );
  }

  const bySort = (a: CapabilityDefinition, b: CapabilityDefinition) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  const visible = (catalog ?? []).filter((c) => c.userVisible && !c.internalOnly);
  const modules = visible.filter((c) => c.type === 'module').sort(bySort);
  const channels = visible.filter((c) => c.type === 'channel').sort(bySort);
  const features = visible.filter((c) => c.type === 'feature').sort(bySort);

  const groups = groupRows(rows);
  const measured = usageQuery.data;

  return (
    <div className="space-y-6" data-testid="plan-usage-panel" dir={dir}>
      {showAiCredit && <AiCreditPanel workspaceId={workspaceId} />}
      {rows.length > 0 && (
        <section data-testid="plan-limits">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">{bt(L, 'usageOverview')}</h2>
              <p className="text-xs text-muted-foreground">{t('billing.planLimits.description')}</p>
            </div>
            {usageQuery.isError ? (
              <Badge variant="secondary" className="shrink-0" data-testid="limit-usage-error">
                {t('billing.planLimits.usageUnavailable')}
              </Badge>
            ) : null}
          </div>
          <div className="space-y-5">
            {groups.map(([group, groupRowsList]) => (
              <div key={group} data-testid={`limit-group-${group}`}>
                {groups.length > 1 && (
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    {group === OTHER_GROUP ? t('billing.planLimits.otherGroup') : capabilityGroupLabel(group, L)}
                  </h3>
                )}
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {groupRowsList.map((row) => (
                    <LimitCard
                      key={row.key}
                      row={row}
                      used={row.value === -1 ? null : readUsage(row.key, measured, eff.usage)}
                      locale={L}
                      allowanceLabel={t('billing.planLimits.allowance')}
                      reachedLabel={t('billing.planLimits.limitReached')}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Data & storage usage — raw workspace counters (always visible) */}
      <DataStorageSection usage={eff.usage} locale={L} />

      {/* Modules + Channels + Features — compact grouped panel */}
      {modules.length + channels.length + features.length > 0 && (
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
      )}
    </div>
  );
}

function groupRows(rows: LimitRow[]): Array<[string, LimitRow[]]> {
  const map = new Map<string, LimitRow[]>();
  for (const r of rows) {
    const list = map.get(r.group);
    if (list) list.push(r);
    else map.set(r.group, [r]);
  }
  const rank = (g: string) => {
    if (g === OTHER_GROUP) return GROUP_ORDER.length + 1;
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...map.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([g, list]) => [g, list.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))]);
}

function LimitCard({
  row, used, locale, allowanceLabel, reachedLabel,
}: {
  row: LimitRow;
  used: number | null;
  locale: BillingLocale;
  allowanceLabel: string;
  reachedLabel: string;
}) {
  const L = locale;
  const { decor } = row;
  const Icon = decor.icon;
  const isUnlimited = row.value === -1;
  const usedValue = isUnlimited ? null : used;
  const hasUsage = usedValue !== null;
  // A zero allowance has no meaningful ratio (and is not "reached" by using nothing).
  const pct = usedValue !== null && row.value > 0 ? Math.min(100, Math.round((usedValue / row.value) * 100)) : null;
  const reached = usedValue !== null && row.value > 0 && usedValue >= row.value;
  const limitText = withUnit(formatNumber(row.value, L), row.unit, L);

  return (
    <div
      data-testid={`limit-row-${row.key}`}
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
        ) : reached ? (
          <Badge variant="destructive" className="text-[10px] px-1.5 py-0">{reachedLabel}</Badge>
        ) : (
          <span className="text-xs font-medium text-muted-foreground">
            {pct !== null ? `${formatNumber(pct, L)}%` : ''}
          </span>
        )}
      </div>
      <div className="mt-3 text-sm font-medium text-foreground line-clamp-1" title={row.label}>{row.label}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {isUnlimited ? (
          <span>&nbsp;</span>
        ) : hasUsage ? (
          <>
            <span className="font-semibold text-foreground">{formatNumber(usedValue ?? 0, L)}</span>
            <span className="mx-1">{bt(L, 'ofLabel')}</span>
            <span>{limitText}</span>
          </>
        ) : (
          <span className="font-semibold text-foreground">{limitText}</span>
        )}
      </div>
      {pct !== null ? (
        <div
          className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-label={row.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className={`h-full ${reached ? 'bg-destructive' : decor.bar} transition-all`} style={{ width: `${pct}%` }} />
        </div>
      ) : !isUnlimited && !hasUsage ? (
        <p className="mt-3 text-[11px] text-muted-foreground/80">{allowanceLabel}</p>
      ) : null}
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
  usage: UsageCounters;
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
              <span className="truncate">{capabilityLabel(cap.key, locale, cap.label)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
