/**
 * Native (iOS) live visitors screen — list-only, no desktop map/resizer chrome.
 */
import { useMemo, useState } from 'react';
import { Radar, Globe } from 'lucide-react';

import { useTranslation } from '@/i18n';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { useLiveVisitors } from '@/hooks/useVisitors';
import { useVisitorsRealtime } from '@/hooks/useVisitorsRealtime';
import type { VisitorIntelItem } from '@/lib/visitors-api';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { MobileScreen } from './MobileScreen';
import { MobileSearchField } from './MobileSearchField';
import { EmptyState } from './MobileContactsPage';

const DOT: Record<string, string> = {
  online: 'bg-emerald-500',
  idle: 'bg-amber-500',
  offline: 'bg-muted-foreground/50',
  unknown: 'bg-muted-foreground/40',
};

export default function MobileVisitorsPage() {
  const { t } = useTranslation();
  const workspace = useCurrentWorkspace();
  const [includeOffline, setIncludeOffline] = useState(false);
  const [query, setQuery] = useState('');

  const live = useLiveVisitors(workspace?.id, includeOffline);
  useVisitorsRealtime(workspace?.id);

  const visitors: VisitorIntelItem[] = live.data?.items ?? [];
  const onlineCount = visitors.filter((v) => v.status === 'online').length;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return visitors;
    return visitors.filter((v) =>
      [v.current_page, v.geo?.country, v.geo?.city, v.browser, v.contact?.name, v.contact?.email]
        .some((s) => (s || '').toString().toLowerCase().includes(q)),
    );
  }, [visitors, query]);

  return (
    <MobileScreen
      title={t('nav.visitors')}
      subtitle={`${onlineCount} ${t('visitors.online')}`}
      toolbar={
        <div className="space-y-2">
          <MobileSearchField
            value={query}
            onChange={setQuery}
            placeholder={t('visitors.searchPlaceholder')}
          />
          <button
            type="button"
            onClick={() => setIncludeOffline((v) => !v)}
            className={cn(
              'h-8 rounded-full px-3 text-[13px] font-medium transition-colors',
              includeOffline
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-card text-muted-foreground',
            )}
          >
            {t('visitors.includeOffline')}
          </button>
        </div>
      }
      bodyClassName="pb-6"
    >
      {live.isLoading ? (
        <div className="space-y-2 px-4 pt-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Radar} label={t('visitors.emptyTitle')} />
      ) : (
        <ul className="mt-3 border-y border-border bg-card divide-y divide-border">
          {rows.map((v) => (
            <li key={v.id} className="flex items-start gap-3 px-4 py-3">
              <span className="mt-1.5 flex h-2.5 w-2.5 shrink-0">
                <span className={cn('h-2.5 w-2.5 rounded-full', DOT[v.status] || DOT.unknown)} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-foreground">
                  {v.contact?.name || v.contact?.email || t('visitors.unknownVisitor')}
                </p>
                <p className="truncate text-[13px] text-muted-foreground" dir="ltr">
                  {v.current_page || '—'}
                </p>
                <p className="mt-0.5 flex items-center gap-1 truncate text-[12px] text-muted-foreground">
                  <Globe className="h-3.5 w-3.5 shrink-0" />
                  {[v.geo?.city, v.geo?.country].filter(Boolean).join(', ') ||
                    t('visitors.unknownLocation')}
                  {v.browser ? ` · ${v.browser}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </MobileScreen>
  );
}
