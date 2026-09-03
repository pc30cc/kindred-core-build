/**
 * Workspace plugin marketplace.
 *
 * Availability is decided by the server (platform state + plan entitlement);
 * this page only reflects it. Cards stay visible when locked so operators can
 * see what an upgrade unlocks, but the actions are disabled.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useActiveWorkspace } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { pluginsApi, type PluginCatalogItem } from '@/lib/plugins-api';
import { PluginLogo } from '@/components/plugins/PluginLogo';
import { Link, useParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  CheckCircle2, Clock, Lock, Puzzle, Search, Settings2, Trash2, Wrench,
} from 'lucide-react';

export default function PluginsPage() {
  const { t, dir } = useTranslation();
  const { workspace } = useActiveWorkspace();
  const workspaceId = workspace?.id ?? '';
  const qc = useQueryClient();
  const { slug = '' } = useParams();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['plugins', 'catalog', workspaceId],
    queryFn: () => pluginsApi.catalog(workspaceId),
    enabled: !!workspaceId,
  });

  const uninstall = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.uninstall(workspaceId, pluginId),
    onSuccess: () => {
      toast({ title: t('plugins.telegram.disconnected') });
      qc.invalidateQueries({ queryKey: ['plugins'] });
    },
    onError: (err: any) =>
      toast({ variant: 'destructive', title: t('plugins.error.generic'), description: err?.message }),
  });

  // Only shipped plugins have localized copy; everything else falls back to
  // its registry id so a newly added "coming soon" entry never renders a raw
  // translation key.
  function localizedName(item: PluginCatalogItem) {
    const key = `plugins.${item.id}.name`;
    const label = t(key as never);
    return label === key ? item.id : label;
  }

  function localizedDescription(item: PluginCatalogItem) {
    const key = `plugins.${item.id}.description`;
    const label = t(key as never);
    return label === key ? '' : label;
  }

  // Curated display order — flagship channels first.
  const DISPLAY_ORDER = ['telegram', 'bale', 'whatsapp', 'instagram'];
  const items = useMemo(() => {
    const rank = (id: string) => {
      const i = DISPLAY_ORDER.indexOf(id);
      return i === -1 ? DISPLAY_ORDER.length : i;
    };
    return [...(data?.items ?? [])].sort((a, b) => rank(a.id) - rank(b.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);


  const stats = useMemo(() => {
    const comingSoon = items.filter(
      (i) => i.status === 'coming_soon' || i.rolloutStatus === 'coming_soon',
    ).length;
    return {
      total: items.length,
      installed: items.filter((i) => i.installed).length,
      available: items.length - comingSoon,
      comingSoon,
    };
  }, [items]);

  const categories = useMemo(
    () => [...new Set(items.map((i) => i.category))],
    [items],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (category !== 'all' && item.category !== category) return false;
      if (!q) return true;
      return (
        item.id.toLowerCase().includes(q) ||
        localizedName(item).toLowerCase().includes(q) ||
        localizedDescription(item).toLowerCase().includes(q)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, search, category]);

  const grouped = useMemo(() => {
    const map = new Map<string, PluginCatalogItem[]>();
    for (const item of filtered) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div className="space-y-6 animate-fade-in" dir={dir}>
      {/* Hero header — same language as Knowledge Base */}
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 sm:p-8">
        <div className="pointer-events-none absolute -top-16 -end-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -start-10 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/60 shadow-lg shadow-primary/30">
              <Puzzle className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('plugins.title')}</h1>
              <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">{t('plugins.subtitle')}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-card/70 px-3 py-1.5 text-xs text-foreground backdrop-blur">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            {stats.installed} / {stats.total}
          </div>
        </div>
      </div>



      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav className="flex flex-wrap items-center gap-1 border-b border-border/60 pb-px">
          {[{ key: 'all', label: t('plugins.filterAll') },
            ...categories.map((c) => ({ key: c, label: t(`plugins.category.${c}` as never) }))].map((tab) => {
            const active = category === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setCategory(tab.key)}
                className={cn(
                  'relative px-3.5 py-2.5 text-sm font-medium transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
                {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
              </button>
            );
          })}
        </nav>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('plugins.search')}
            className="ps-9"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <Card className="p-12 text-center text-sm text-muted-foreground">{t('plugins.catalogEmpty')}</Card>
      ) : grouped.length === 0 ? (
        <Card className="p-12 text-center text-sm text-muted-foreground">{t('plugins.noResults')}</Card>
      ) : (
        grouped.map(([cat, list]) => (
          <section key={cat} className="space-y-3">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-foreground">
                {t(`plugins.category.${cat}` as never)}
              </h2>
              <span className="text-xs text-muted-foreground">{list.length}</span>
              <span className="h-px flex-1 bg-border/60" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((item) => {
                const comingSoon = item.status === 'coming_soon' || item.rolloutStatus === 'coming_soon';
                const locked = !item.planAllowed;
                const blocked = comingSoon || locked || item.maintenanceMode || !item.installable;
                return (
                  <Card
                    key={item.id}
                    className={cn(
                      'group relative flex flex-col gap-4 overflow-hidden rounded-2xl border-border/60 p-5 shadow-sm transition-all',
                      blocked ? 'opacity-75' : 'hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md',
                    )}
                  >
                    <span className="pointer-events-none absolute inset-x-0 -top-16 h-24 bg-gradient-to-b from-primary/5 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                    <div className="flex items-start gap-3">
                      <PluginLogo id={item.id} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-foreground">{localizedName(item)}</span>
                          {item.installed && !blocked && (
                            <Badge variant="secondary" className="gap-1">
                              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                              {t('plugins.badge.installed')}
                            </Badge>
                          )}
                          {comingSoon && (
                            <Badge variant="outline" className="gap-1">
                              <Clock className="h-3 w-3" />{t('plugins.badge.comingSoon')}
                            </Badge>
                          )}
                          {item.rolloutStatus === 'beta' && <Badge variant="outline">{t('plugins.badge.beta')}</Badge>}
                          {item.maintenanceMode && (
                            <Badge variant="outline" className="gap-1">
                              <Wrench className="h-3 w-3" />{t('plugins.badge.maintenance')}
                            </Badge>
                          )}
                          {locked && !comingSoon && (
                            <Badge variant="outline" className="gap-1">
                              <Lock className="h-3 w-3" />{t('plugins.badge.planLocked')}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {localizedDescription(item)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/50 pt-3">
                      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        v{item.version}
                      </span>
                      <div className="flex items-center gap-2">
                        {item.installed && !comingSoon && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={uninstall.isPending}
                            onClick={() => uninstall.mutate(item.id)}
                          >
                            <Trash2 className="me-1.5 h-4 w-4" />
                            {t('plugins.action.uninstall')}
                          </Button>
                        )}
                        <Button asChild size="sm" disabled={comingSoon}>
                          <Link to={`/${slug}/plugins/${item.id}`}>
                            <Settings2 className="me-1.5 h-4 w-4" />
                            {item.installed ? t('plugins.action.configure') : t('plugins.action.details')}
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
