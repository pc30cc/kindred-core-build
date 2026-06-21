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
import { Loader2, Check, X, Infinity as InfinityIcon, AlertCircle } from 'lucide-react';
import {
  fetchWorkspaceEffective,
  fetchCapabilityCatalog,
  type WorkspaceEffectiveEntitlements,
  type CapabilityDefinition,
} from '@/lib/entitlements-api';

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

function formatLimitValue(v: number | null | undefined, unit?: string): string {
  if (v === -1) return 'Unlimited';
  if (v === null || v === undefined) return '—';
  if (unit === 'mb') return `${v} MB`;
  if (unit === 'gb') return `${v} GB`;
  return v.toLocaleString();
}

function formatUsageValue(v: number, unit?: string): string {
  if (unit === 'gb') return `${v.toFixed(2)} GB`;
  if (unit === 'mb') return `${v.toFixed(1)} MB`;
  return Math.round(v).toLocaleString();
}

const SOURCE_LABEL: Record<string, string> = {
  override: 'Custom for your workspace',
  plan: 'From your plan',
  default: 'Default',
};

interface Props {
  workspaceId: string;
}

export function PlanUsagePanel({ workspaceId }: Props) {
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
          <p>{error || 'Plan state unavailable'}</p>
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

  return (
    <div className="space-y-6" data-testid="plan-usage-panel">
      {/* Plan summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your plan</CardTitle>
          <CardDescription>
            {eff.plan?.name || 'Free'}
            {eff.subscription?.status ? ` · ${eff.subscription.status}` : ''}
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Usage-backed limits */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Limits & usage</CardTitle>
          <CardDescription>What applies to your workspace right now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {limits.map((cap) => {
            const state = eff.limits[cap.key];
            if (!state) return null;
            const limitValue = state.value as number | null;
            const isUnlimited = limitValue === -1;
            const usage = readUsage(eff.usage, cap.key);
            const pct =
              !isUnlimited && usage.available && typeof limitValue === 'number' && limitValue > 0
                ? Math.min(100, Math.round((usage.value / limitValue) * 100))
                : null;

            return (
              <div key={cap.key} className="space-y-1.5" data-testid={`limit-row-${cap.key}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{cap.label}</div>
                    {cap.description && (
                      <div className="text-xs text-muted-foreground line-clamp-2">{cap.description}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isUnlimited ? (
                      <span className="inline-flex items-center gap-1 text-sm font-semibold text-foreground">
                        <InfinityIcon className="w-4 h-4" /> Unlimited
                      </span>
                    ) : (
                      <span className="text-sm font-semibold text-foreground">
                        {usage.available ? `${formatUsageValue(usage.value, cap.unit)} / ` : ''}
                        {formatLimitValue(limitValue, cap.unit)}
                      </span>
                    )}
                    <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                      {SOURCE_LABEL[state.source] || state.source}
                    </Badge>
                  </div>
                </div>
                {!isUnlimited && pct !== null && (
                  <Progress value={pct} className="h-1.5" />
                )}
                {!isUnlimited && !usage.available && (
                  <p className="text-xs text-muted-foreground">Current usage not tracked in this view.</p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Modules */}
      {modules.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Included modules</CardTitle>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-2 gap-2">
            {modules.map((cap) => {
              const state = eff.modules[cap.key];
              const enabled = !!state?.value;
              return (
                <div
                  key={cap.key}
                  className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2"
                  data-testid={`module-row-${cap.key}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {enabled ? (
                      <Check className="w-4 h-4 text-green-500 shrink-0" />
                    ) : (
                      <X className="w-4 h-4 text-muted-foreground shrink-0" />
                    )}
                    <span className={`text-sm truncate ${enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {cap.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Channels */}
      {channels.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Channels</CardTitle>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-2 gap-2">
            {channels.map((cap) => {
              const state = eff.channels[cap.key];
              const enabled = !!state?.value;
              return (
                <div
                  key={cap.key}
                  className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2"
                >
                  {enabled ? (
                    <Check className="w-4 h-4 text-green-500 shrink-0" />
                  ) : (
                    <X className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span className={`text-sm ${enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {cap.label}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Features */}
      {features.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Features</CardTitle>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-2 gap-2">
            {features.map((cap) => {
              const state = eff.features[cap.key];
              const enabled = !!state?.value;
              return (
                <div key={cap.key} className="flex items-center gap-2 text-sm">
                  {enabled ? (
                    <Check className="w-4 h-4 text-green-500 shrink-0" />
                  ) : (
                    <X className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span className={enabled ? 'text-foreground' : 'text-muted-foreground'}>
                    {cap.label}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}