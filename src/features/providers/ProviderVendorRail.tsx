/**
 * PROVIDER VENDOR RAIL
 *
 * The vertical tab list every provider panel selects a vendor from: one row
 * per vendor, each carrying its own state, so an operator sees at a glance
 * which vendors hold credentials — not just the one that happens to be live.
 *
 * Shared by the generic provider workspace (one vendor is the default) and
 * the storage panel (several vendors run at once, one of them primary).
 */

import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import type { ProviderVendor } from './schemas';

/**
 * - `primary` : serves traffic now (the global default, or the storage primary)
 * - `active`  : enabled alongside the primary — a mirrored storage replica
 * - `saved`   : credentials stored but switched off
 * - `soon`    : catalogued, no runtime yet
 * - `idle`    : nothing stored
 */
export type VendorState = 'primary' | 'active' | 'saved' | 'soon' | 'idle';

const DOT: Record<VendorState, string> = {
  primary: 'bg-emerald-400',
  active: 'bg-sky-400',
  saved: 'bg-amber-400',
  soon: 'bg-muted-foreground/40',
  idle: 'bg-border',
};

const BADGE: Record<VendorState, string> = {
  primary: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  active: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  saved: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  soon: 'bg-muted text-muted-foreground border-border',
  idle: '',
};

const LOCALE_GROUPS: { key: 'en' | 'fa' | 'tr'; flag: string }[] = [
  { key: 'en', flag: '🌍' },
  { key: 'fa', flag: '🇮🇷' },
  { key: 'tr', flag: '🇹🇷' },
];

interface Props {
  vendors: ProviderVendor[];
  selected: string;
  onSelect: (name: string) => void;
  /** State of one vendor — drives its dot and badge. */
  stateOf: (vendor: ProviderVendor) => VendorState;
  /** Badge caption per state; return null to show no badge. */
  badgeLabel: (state: VendorState) => string | null;
  /** Second line under the vendor name; defaults to its deployment kind. */
  subtitleOf?: (vendor: ProviderVendor) => string | null;
}

export function ProviderVendorRail({
  vendors, selected, onSelect, stateOf, badgeLabel, subtitleOf,
}: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? vendors.filter((v) =>
          v.name.toLowerCase().includes(q) ||
          v.label.toLowerCase().includes(q) ||
          v.description.toLowerCase().includes(q))
      : vendors;

    if (!vendors.some((v) => v.locales?.length)) {
      return [{ key: 'all', label: '', vendors: filtered }];
    }

    const localised: { key: string; label: string; vendors: ProviderVendor[] }[] =
      LOCALE_GROUPS.map((g) => ({
        key: g.key,
        label: `${g.flag} ${t(`adminProviders.panel.regions.${g.key}` as never)}`,
        vendors: filtered.filter((v) => v.locales?.includes(g.key)),
      }));

    const rest = filtered.filter((v) => !v.locales?.length);
    if (rest.length) {
      localised.push({ key: 'other', label: `🌐 ${t('adminProviders.panel.regions.other')}`, vendors: rest });
    }
    return localised.filter((g) => g.vendors.length > 0);
  }, [vendors, query, t]);

  const visible = groups.reduce((n, g) => n + g.vendors.length, 0);

  const defaultSubtitle = (vendor: ProviderVendor) =>
    vendor.deployment
      ? t(`adminProviders.panel.deployment.${vendor.deployment}` as never)
      : `${vendor.fields.length} ${t('adminProviders.panel.fields')}`;

  return (
    <div className="space-y-2.5">
      {vendors.length > 6 && (
        <div className="relative">
          <Search className="absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground start-2.5" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('adminProviders.panel.searchVendors')}
            className="h-8 text-xs ps-8"
          />
        </div>
      )}

      <ScrollArea className="max-h-[32rem] lg:max-h-[calc(100vh-22rem)] pe-1">
        <div className="space-y-3" role="tablist" aria-orientation="vertical">
          {groups.map((group) => (
            <div key={group.key} className="space-y-1">
              {group.label && (
                <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {group.label}
                </p>
              )}
              {group.vendors.map((vendor) => {
                const isSelected = vendor.name === selected;
                const state = stateOf(vendor);
                const badge = badgeLabel(state);
                const subtitle = subtitleOf?.(vendor) ?? defaultSubtitle(vendor);
                return (
                  <button
                    key={vendor.name}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => onSelect(vendor.name)}
                    className={cn(
                      'w-full text-start rounded-lg px-2.5 py-2 transition-colors',
                      isSelected ? 'bg-primary/10 ring-1 ring-primary/25' : 'hover:bg-muted',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', DOT[state])} />
                      <span
                        className={cn(
                          'flex-1 truncate text-xs',
                          isSelected ? 'font-medium text-primary' : 'text-foreground',
                        )}
                      >
                        {vendor.label}
                      </span>
                      {badge && (
                        <Badge variant="outline" className={cn('h-4 px-1 text-[9px] shrink-0', BADGE[state])}>
                          {badge}
                        </Badge>
                      )}
                    </div>
                    {subtitle && (
                      <p className="mt-0.5 ps-3.5 text-[10px] text-muted-foreground truncate">{subtitle}</p>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {visible === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t('adminProviders.panel.noVendorMatch')}
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
