/**
 * SEO — Site Explorer. Unlike every other SEO tool, this one is NOT scoped
 * to a site the workspace registered: it's a domain search box (like
 * Ahrefs' real Site Explorer) — type any domain, including a competitor's,
 * and get its backlink profile and organic-keywords report.
 *
 * Two independent async lookups per domain (backlinks, organic keywords —
 * see server/services/seo/siteExplorerService.ts), each with its own
 * queued/running/completed lifecycle, sharing one workspace-wide
 * concurrency budget and a per-domain re-lookup cooldown.
 */
import { useMemo, useState } from 'react';
import {
  Search, Globe2, Link2, TrendingUp, ArrowUpRight, RefreshCw, ExternalLink, Sparkles, Unlink,
} from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as ReTooltip } from 'recharts';
import { useTranslation } from '@/i18n';
import { useWorkspacePath } from '@/hooks/useWorkspace';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SkeletonStats, SkeletonTable } from '@/components/common/Skeletons';
import { PlanLockedOverlay } from '@/components/plan/PlanLockedOverlay';
import { SeoRoadmapPlaceholder } from './SeoRoadmapPlaceholder';
import { toast } from '@/lib/toast';
import {
  useSeoSites,
  
  useLatestExplorerBacklinkScan, useStartExplorerBacklinkScan, useExplorerBacklinks,
  useExplorerReferringDomains, useExplorerTopPages,
  useLatestExplorerKeywordScan, useStartExplorerKeywordScan, useExplorerKeywords,
  useLatestExplorerCompetitorScan, useStartExplorerCompetitorScan, useExplorerCompetitors,
} from '@/hooks/useSeo';
import { SeoApiError, type SeoExplorerBacklinkScan } from '@/lib/seo-api';
import { GradientStatCard } from './SeoPage';
import { findSection, findLeaf } from './seoNavTree';
import { prettyUrl } from '@/lib/prettyUrl';

function explorerErrorMessage(err: unknown, t: (k: any) => string): string {
  if (err instanceof SeoApiError) {
    if (err.upgradeRequired) return t('seo.explorer.errors.module_not_available' as any);
    const key = `seo.explorer.errors.${err.code}`;
    const translated = t(key as any);
    if (translated !== key) return translated;
  }
  return t('seo.explorer.errors.generic' as any);
}

function formatCompact(v: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

// ─── Entry point ──────────────────────────────────────────────────────────

export function SiteExplorerSection({ workspaceId, subsectionKey }: { workspaceId: string; subsectionKey: string }) {
  return (
    <PlanLockedOverlay moduleKey="seo_site_explorer">
      <SiteExplorerInner workspaceId={workspaceId} subsectionKey={subsectionKey} />
    </PlanLockedOverlay>
  );
}

function SiteExplorerInner({ workspaceId, subsectionKey }: { workspaceId: string; subsectionKey: string }) {
  const { t } = useTranslation();
  const [activeDomain, setActiveDomain] = useState<string | undefined>(undefined);
  const { data: sitesData, isLoading: sitesLoading } = useSeoSites(workspaceId);
  const ownDomain = (sitesData?.sites || []).find((s) => s.is_primary)?.domain || sitesData?.sites?.[0]?.domain;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); if (ownDomain) setActiveDomain(ownDomain); }}
          >
            <div className="relative flex-1">
              <Globe2 className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={ownDomain || ''}
                readOnly
                dir="ltr"
                placeholder={t('seo.explorer.search.placeholder' as any)}
                className="ps-9 text-start"
              />
            </div>
            <Button type="submit" className="gap-2" disabled={!ownDomain || sitesLoading}>
              <Search className="h-4 w-4" />{t('seo.explorer.search.cta' as any)}
            </Button>
          </form>
        </CardContent>
      </Card>


      {!activeDomain ? (
        <Card className="overflow-hidden">
          <CardContent className="relative flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-primary/5 to-transparent" />
            <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg">
              <Globe2 className="h-6 w-6" />
            </span>
            <h3 className="relative text-lg font-semibold">{t('seo.explorer.empty.title' as any)}</h3>
            <p className="relative max-w-md text-sm text-muted-foreground">{t('seo.explorer.empty.description' as any)}</p>
          </CardContent>
        </Card>
      ) : (
        <SiteExplorerDataView workspaceId={workspaceId} domain={activeDomain} subsectionKey={subsectionKey} />
      )}
    </div>
  );
}

// ─── Data views ────────────────────────────────────────────────────────────

function SiteExplorerDataView({ workspaceId, domain, subsectionKey }: { workspaceId: string; domain: string; subsectionKey: string }) {
  const { t } = useTranslation();
  switch (subsectionKey) {
    case 'overview':
      return <ExplorerOverview workspaceId={workspaceId} domain={domain} />;
    case 'backlinks':
      return <ExplorerBacklinksView workspaceId={workspaceId} domain={domain} />;
    case 'referringDomains':
      return <ExplorerReferringDomainsView workspaceId={workspaceId} domain={domain} />;
    case 'topPages':
      return <ExplorerTopPagesView workspaceId={workspaceId} domain={domain} />;
    case 'organicKeywords':
      return <ExplorerKeywordsView workspaceId={workspaceId} domain={domain} />;
    case 'competingDomains':
      return <ExplorerCompetingDomainsView workspaceId={workspaceId} domain={domain} />;
    default: {
      const leaf = findLeaf(findSection('site-explorer'), subsectionKey);
      return <SeoRoadmapPlaceholder label={t((leaf?.labelKey || 'seo.nav.section.siteExplorer') as any)} />;
    }
  }
}

function DomainHeading({ domain }: { domain: string }) {
  return (
    <div className="flex items-center gap-2">
      <Globe2 className="h-4 w-4 text-muted-foreground" />
      <h2 className="truncate text-base font-semibold">{domain}</h2>
      <a
        href={`https://${domain}`}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

/** Shared "not analyzed yet / run it" card used by both scan kinds when there's no scan for this domain yet. */
function ExplorerScanCta({
  titleKey, descriptionKey, ctaKey, onStart, pending,
}: { titleKey: string; descriptionKey: string; ctaKey: string; onStart: () => void; pending: boolean }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        <h4 className="text-sm font-semibold">{t(titleKey as any)}</h4>
        <p className="max-w-sm text-xs text-muted-foreground">{t(descriptionKey as any)}</p>
        <Button size="sm" onClick={onStart} disabled={pending} className="gap-1.5">
          <RefreshCw className={pending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {t(ctaKey as any)}
        </Button>
      </CardContent>
    </Card>
  );
}

function ExplorerScanProgress({ progressStage }: { progressStage: string | null }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-6">
        <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">
          {progressStage === 'fetching' ? t('seo.explorer.progress.fetching' as any) : t('seo.explorer.progress.working' as any)}
        </p>
      </CardContent>
    </Card>
  );
}

function ExplorerOverview({ workspaceId, domain }: { workspaceId: string; domain: string }) {
  const { t } = useTranslation();
  const wsPath = useWorkspacePath();

  const backlinkScanQuery = useLatestExplorerBacklinkScan(workspaceId, domain);
  const keywordScanQuery = useLatestExplorerKeywordScan(workspaceId, domain);
  const startBacklinkScan = useStartExplorerBacklinkScan(workspaceId);
  const startKeywordScan = useStartExplorerKeywordScan(workspaceId);

  const handleStartBacklinks = async () => {
    try { await startBacklinkScan.mutateAsync(domain); } catch (err) { toast.error(explorerErrorMessage(err, t)); }
  };
  const handleStartKeywords = async () => {
    try { await startKeywordScan.mutateAsync(domain); } catch (err) { toast.error(explorerErrorMessage(err, t)); }
  };

  if (backlinkScanQuery.isLoading || keywordScanQuery.isLoading) return <SkeletonStats count={4} />;

  const backlinkScan = backlinkScanQuery.data?.scan ?? null;
  const keywordScan = keywordScanQuery.data?.scan ?? null;

  return (
    <div className="flex flex-col gap-4">
      <DomainHeading domain={domain} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <GradientStatCard icon={Link2} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={backlinkScan?.status === 'completed' ? formatCompact(backlinkScan.total_backlinks ?? 0) : '—'} label={t('seo.explorer.stat.backlinks' as any)} />
        <GradientStatCard icon={Globe2} iconGradient="from-sky-500 to-cyan-500" blobColor="bg-sky-500/15" value={backlinkScan?.status === 'completed' ? formatCompact(backlinkScan.referring_domains ?? 0) : '—'} label={t('seo.explorer.stat.referringDomains' as any)} />
        <GradientStatCard icon={Search} iconGradient="from-emerald-500 to-teal-500" blobColor="bg-emerald-500/15" value={keywordScan?.status === 'completed' ? formatCompact(keywordScan.total_keywords ?? 0) : '—'} label={t('seo.explorer.stat.organicKeywords' as any)} />
        <GradientStatCard icon={TrendingUp} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={keywordScan?.status === 'completed' ? formatCompact(keywordScan.total_traffic_estimate ?? 0) : '—'} label={t('seo.explorer.stat.trafficEstimate' as any)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-base">{t('seo.nav.item.backlinks' as any)}</CardTitle>
            {backlinkScan?.status === 'completed' && (
              <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground">
                <a href={wsPath('/seo/site-explorer/backlinks')}>{t('seo.gsc.overview.viewAll' as any)}<ArrowUpRight className="h-3 w-3" /></a>
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {!backlinkScan ? (
              <ExplorerScanCta
                titleKey="seo.explorer.cta.backlinksTitle"
                descriptionKey="seo.explorer.cta.backlinksDescription"
                ctaKey="seo.explorer.cta.analyze"
                onStart={handleStartBacklinks}
                pending={startBacklinkScan.isPending}
              />
            ) : backlinkScan.status !== 'completed' && backlinkScan.status !== 'failed' && backlinkScan.status !== 'cancelled' ? (
              <ExplorerScanProgress progressStage={backlinkScan.progress_stage} />
            ) : backlinkScan.status === 'completed' ? (
              <div className="space-y-1.5 text-sm">
                <Row label={t('seo.explorer.stat.dofollow' as any)} value={formatCompact(backlinkScan.dofollow_count ?? 0)} />
                <Row label={t('seo.explorer.stat.new' as any)} value={formatCompact(backlinkScan.new_backlinks ?? 0)} />
                <Row label={t('seo.explorer.stat.lost' as any)} value={formatCompact(backlinkScan.lost_backlinks ?? 0)} />
              </div>
            ) : (
              <p className="text-sm text-destructive">{backlinkScan.error_message || t('seo.explorer.errors.generic' as any)}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-base">{t('seo.nav.item.organicKeywords' as any)}</CardTitle>
            {keywordScan?.status === 'completed' && (
              <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs text-muted-foreground">
                <a href={wsPath('/seo/site-explorer/organicKeywords')}>{t('seo.gsc.overview.viewAll' as any)}<ArrowUpRight className="h-3 w-3" /></a>
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {!keywordScan ? (
              <ExplorerScanCta
                titleKey="seo.explorer.cta.keywordsTitle"
                descriptionKey="seo.explorer.cta.keywordsDescription"
                ctaKey="seo.explorer.cta.analyze"
                onStart={handleStartKeywords}
                pending={startKeywordScan.isPending}
              />
            ) : keywordScan.status !== 'completed' && keywordScan.status !== 'failed' && keywordScan.status !== 'cancelled' ? (
              <ExplorerScanProgress progressStage={keywordScan.progress_stage} />
            ) : keywordScan.status === 'completed' ? (
              <div className="space-y-1.5 text-sm">
                <Row label={t('seo.explorer.stat.organicKeywords' as any)} value={formatCompact(keywordScan.total_keywords ?? 0)} />
                <Row label={t('seo.explorer.stat.trafficEstimate' as any)} value={formatCompact(keywordScan.total_traffic_estimate ?? 0)} />
              </div>
            ) : (
              <p className="text-sm text-destructive">{keywordScan.error_message || t('seo.explorer.errors.generic' as any)}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

const LINK_TYPE_COLORS = { dofollow: 'hsl(var(--primary))', nofollow: '#94a3b8' };

function LinkTypeDonut({ dofollow, nofollow }: { dofollow: number; nofollow: number }) {
  const { t } = useTranslation();
  const total = dofollow + nofollow;
  const data = useMemo(
    () => [
      { key: 'dofollow', value: dofollow, label: 'dofollow' },
      { key: 'nofollow', value: nofollow, label: 'nofollow' },
    ].filter((d) => d.value > 0),
    [dofollow, nofollow],
  );
  const dofollowPct = total > 0 ? Math.round((dofollow / total) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('seo.explorer.linkTypes' as any)}</CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{t('seo.gsc.empty.noData' as any)}</p>
        ) : (
          <div className="relative">
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data} dataKey="value" nameKey="label" innerRadius={44} outerRadius={64} paddingAngle={2} stroke="none">
                    {data.map((d) => <Cell key={d.key} fill={LINK_TYPE_COLORS[d.key as keyof typeof LINK_TYPE_COLORS]} />)}
                  </Pie>
                  <ReTooltip
                    formatter={(value: number, _name, entry) => [formatCompact(value), (entry?.payload as any)?.label]}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xl font-bold tabular-nums">{dofollowPct}%</span>
              <span className="text-[10px] text-muted-foreground">dofollow</span>
            </div>
          </div>
        )}
        <div className="mt-2 flex items-center justify-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" />{t('seo.explorer.stat.dofollow' as any)}</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-400" />nofollow</span>
        </div>
      </CardContent>
    </Card>
  );
}

function ExplorerBacklinksView({ workspaceId, domain }: { workspaceId: string; domain: string }) {
  const { t } = useTranslation();
  const scanQuery = useLatestExplorerBacklinkScan(workspaceId, domain);
  const startScan = useStartExplorerBacklinkScan(workspaceId);
  const scan = scanQuery.data?.scan ?? null;
  const resultsQuery = useExplorerBacklinks(workspaceId, scan?.status === 'completed' ? scan.id : undefined, { limit: 100 });

  const handleStart = async () => {
    try { await startScan.mutateAsync(domain); } catch (err) { toast.error(explorerErrorMessage(err, t)); }
  };

  if (scanQuery.isLoading) return <SkeletonTable rows={8} columns={5} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <DomainHeading domain={domain} />
        <Button size="sm" variant="outline" className="gap-1.5" onClick={handleStart} disabled={startScan.isPending}>
          <RefreshCw className={startScan.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {scan ? t('seo.explorer.cta.refresh' as any) : t('seo.explorer.cta.analyze' as any)}
        </Button>
      </div>

      {!scan ? (
        <ExplorerScanCta
          titleKey="seo.explorer.cta.backlinksTitle"
          descriptionKey="seo.explorer.cta.backlinksDescription"
          ctaKey="seo.explorer.cta.analyze"
          onStart={handleStart}
          pending={startScan.isPending}
        />
      ) : scan.status !== 'completed' && scan.status !== 'failed' && scan.status !== 'cancelled' ? (
        <ExplorerScanProgress progressStage={scan.progress_stage} />
      ) : scan.status !== 'completed' ? (
        <p className="text-sm text-destructive">{scan.error_message || t('seo.explorer.errors.generic' as any)}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <GradientStatCard icon={Link2} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={formatCompact(scan.total_backlinks ?? 0)} label={t('seo.explorer.stat.backlinks' as any)} />
            <GradientStatCard icon={Globe2} iconGradient="from-sky-500 to-cyan-500" blobColor="bg-sky-500/15" value={formatCompact(scan.referring_domains ?? 0)} label={t('seo.explorer.stat.referringDomains' as any)} />
            <GradientStatCard icon={TrendingUp} iconGradient="from-emerald-500 to-teal-500" blobColor="bg-emerald-500/15" value={formatCompact(scan.dofollow_count ?? 0)} label={t('seo.explorer.stat.dofollow' as any)} />
            <GradientStatCard icon={Sparkles} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={formatCompact(scan.new_backlinks ?? 0)} label={t('seo.explorer.stat.new' as any)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
            <LinkTypeDonut dofollow={scan.dofollow_count ?? 0} nofollow={scan.nofollow_count ?? 0} />
            <Card className="lg:col-span-1">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t('seo.explorer.linkChanges' as any)}</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500">
                    <Sparkles className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-lg font-bold tabular-nums leading-tight">{formatCompact(scan.new_backlinks ?? 0)}</p>
                    <p className="text-xs text-muted-foreground">{t('seo.explorer.stat.new' as any)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                    <Unlink className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-lg font-bold tabular-nums leading-tight">{formatCompact(scan.lost_backlinks ?? 0)}</p>
                    <p className="text-xs text-muted-foreground">{t('seo.explorer.stat.lost' as any)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="pt-6">
              {resultsQuery.isLoading ? (
                <SkeletonTable rows={8} columns={4} />
              ) : (resultsQuery.data?.backlinks.length || 0) === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.gsc.empty.noData' as any)}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('seo.explorer.column.sourceDomain' as any)}</TableHead>
                      <TableHead>{t('seo.explorer.column.anchorText' as any)}</TableHead>
                      <TableHead className="text-end">{t('seo.explorer.column.domainRank' as any)}</TableHead>
                      <TableHead className="text-end">{t('seo.explorer.column.type' as any)}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(resultsQuery.data?.backlinks || []).map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="max-w-[280px] truncate font-medium" title={prettyUrl(b.source_url)}>
                          <a href={b.source_url} target="_blank" rel="noreferrer" className="hover:underline">{b.source_domain}</a>
                        </TableCell>
                        <TableCell className="max-w-[240px] truncate text-muted-foreground">{b.anchor_text || '—'}</TableCell>
                        <TableCell className="text-end tabular-nums">{b.domain_rank ?? '—'}</TableCell>
                        <TableCell className="text-end">
                          <Badge variant={b.is_dofollow ? 'default' : 'outline'} className="text-[10px]">
                            {b.is_dofollow ? 'dofollow' : 'nofollow'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** Shared shell for Referring Domains / Top Pages — both are rollups of the SAME backlink scan (no separate scan type), so they reuse its lifecycle. */
function ExplorerBacklinkRollupShell({
  workspaceId, domain, children,
}: { workspaceId: string; domain: string; children: (scan: SeoExplorerBacklinkScan) => React.ReactNode }) {
  const { t } = useTranslation();
  const scanQuery = useLatestExplorerBacklinkScan(workspaceId, domain);
  const startScan = useStartExplorerBacklinkScan(workspaceId);
  const scan = scanQuery.data?.scan ?? null;

  const handleStart = async () => {
    try { await startScan.mutateAsync(domain); } catch (err) { toast.error(explorerErrorMessage(err, t)); }
  };

  if (scanQuery.isLoading) return <SkeletonTable rows={8} columns={4} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <DomainHeading domain={domain} />
        <Button size="sm" variant="outline" className="gap-1.5" onClick={handleStart} disabled={startScan.isPending}>
          <RefreshCw className={startScan.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {scan ? t('seo.explorer.cta.refresh' as any) : t('seo.explorer.cta.analyze' as any)}
        </Button>
      </div>

      {!scan ? (
        <ExplorerScanCta
          titleKey="seo.explorer.cta.backlinksTitle"
          descriptionKey="seo.explorer.cta.backlinksDescription"
          ctaKey="seo.explorer.cta.analyze"
          onStart={handleStart}
          pending={startScan.isPending}
        />
      ) : scan.status !== 'completed' && scan.status !== 'failed' && scan.status !== 'cancelled' ? (
        <ExplorerScanProgress progressStage={scan.progress_stage} />
      ) : scan.status !== 'completed' ? (
        <p className="text-sm text-destructive">{scan.error_message || t('seo.explorer.errors.generic' as any)}</p>
      ) : children(scan)}
    </div>
  );
}

function ExplorerReferringDomainsView({ workspaceId, domain }: { workspaceId: string; domain: string }) {
  return (
    <ExplorerBacklinkRollupShell workspaceId={workspaceId} domain={domain}>
      {(scan) => <ExplorerReferringDomainsTable workspaceId={workspaceId} scanId={scan.id} />}
    </ExplorerBacklinkRollupShell>
  );
}

function ExplorerReferringDomainsTable({ workspaceId, scanId }: { workspaceId: string; scanId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useExplorerReferringDomains(workspaceId, scanId, { limit: 100 });
  return (
    <Card>
      <CardContent className="pt-6">
        {isLoading ? (
          <SkeletonTable rows={8} columns={3} />
        ) : (data?.rows.length || 0) === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.gsc.empty.noData' as any)}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('seo.explorer.column.sourceDomain' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.explorer.column.backlinks' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.explorer.column.dofollow' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.explorer.column.domainRank' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.rows || []).map((r) => (
                <TableRow key={r.domain}>
                  <TableCell className="max-w-[280px] truncate font-medium">
                    <a href={`https://${r.domain}`} target="_blank" rel="noreferrer" className="hover:underline">{r.domain}</a>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{formatCompact(r.backlinkCount)}</TableCell>
                  <TableCell className="text-end tabular-nums text-muted-foreground">{formatCompact(r.dofollowCount)}</TableCell>
                  <TableCell className="text-end tabular-nums">{r.topDomainRank ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ExplorerTopPagesView({ workspaceId, domain }: { workspaceId: string; domain: string }) {
  return (
    <ExplorerBacklinkRollupShell workspaceId={workspaceId} domain={domain}>
      {(scan) => <ExplorerTopPagesTable workspaceId={workspaceId} scanId={scan.id} />}
    </ExplorerBacklinkRollupShell>
  );
}

function ExplorerTopPagesTable({ workspaceId, scanId }: { workspaceId: string; scanId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useExplorerTopPages(workspaceId, scanId, { limit: 100 });
  return (
    <Card>
      <CardContent className="pt-6">
        {isLoading ? (
          <SkeletonTable rows={8} columns={3} />
        ) : (data?.rows.length || 0) === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.gsc.empty.noData' as any)}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('seo.explorer.column.page' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.explorer.column.backlinks' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.explorer.stat.referringDomains' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.explorer.column.pageRank' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.rows || []).map((r) => (
                <TableRow key={r.url}>
                  <TableCell className="max-w-[320px] truncate font-medium" title={r.url}>
                    <a href={r.url} target="_blank" rel="noreferrer" className="hover:underline">{r.url}</a>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{formatCompact(r.backlinkCount)}</TableCell>
                  <TableCell className="text-end tabular-nums text-muted-foreground">{formatCompact(r.referringDomainCount)}</TableCell>
                  <TableCell className="text-end tabular-nums">{r.topPageRank ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ExplorerKeywordsView({ workspaceId, domain }: { workspaceId: string; domain: string }) {
  const { t } = useTranslation();
  const scanQuery = useLatestExplorerKeywordScan(workspaceId, domain);
  const startScan = useStartExplorerKeywordScan(workspaceId);
  const scan = scanQuery.data?.scan ?? null;
  const resultsQuery = useExplorerKeywords(workspaceId, scan?.status === 'completed' ? scan.id : undefined, { limit: 100 });

  const handleStart = async () => {
    try { await startScan.mutateAsync(domain); } catch (err) { toast.error(explorerErrorMessage(err, t)); }
  };

  if (scanQuery.isLoading) return <SkeletonTable rows={8} columns={5} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <DomainHeading domain={domain} />
        <Button size="sm" variant="outline" className="gap-1.5" onClick={handleStart} disabled={startScan.isPending}>
          <RefreshCw className={startScan.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {scan ? t('seo.explorer.cta.refresh' as any) : t('seo.explorer.cta.analyze' as any)}
        </Button>
      </div>

      {!scan ? (
        <ExplorerScanCta
          titleKey="seo.explorer.cta.keywordsTitle"
          descriptionKey="seo.explorer.cta.keywordsDescription"
          ctaKey="seo.explorer.cta.analyze"
          onStart={handleStart}
          pending={startScan.isPending}
        />
      ) : scan.status !== 'completed' && scan.status !== 'failed' && scan.status !== 'cancelled' ? (
        <ExplorerScanProgress progressStage={scan.progress_stage} />
      ) : scan.status !== 'completed' ? (
        <p className="text-sm text-destructive">{scan.error_message || t('seo.explorer.errors.generic' as any)}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <GradientStatCard icon={Search} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={formatCompact(scan.total_keywords ?? 0)} label={t('seo.explorer.stat.organicKeywords' as any)} />
            <GradientStatCard icon={TrendingUp} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={formatCompact(scan.total_traffic_estimate ?? 0)} label={t('seo.explorer.stat.trafficEstimate' as any)} />
          </div>
          <Card>
            <CardContent className="pt-6">
              {resultsQuery.isLoading ? (
                <SkeletonTable rows={8} columns={5} />
              ) : (resultsQuery.data?.results.length || 0) === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.gsc.empty.noData' as any)}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('seo.gsc.column.query' as any)}</TableHead>
                      <TableHead className="text-end">{t('seo.explorer.column.volume' as any)}</TableHead>
                      <TableHead className="text-end">{t('seo.explorer.column.position' as any)}</TableHead>
                      <TableHead className="text-end">{t('seo.explorer.column.traffic' as any)}</TableHead>
                      <TableHead>{t('seo.gsc.column.page' as any)}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(resultsQuery.data?.results || []).map((k) => (
                      <TableRow key={k.id}>
                        <TableCell className="max-w-[260px] truncate font-medium" title={k.keyword}>{k.keyword}</TableCell>
                        <TableCell className="text-end tabular-nums">{k.search_volume ?? '—'}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          <Badge variant="outline" className="tabular-nums">{k.position ?? '—'}</Badge>
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{k.traffic_estimate ?? '—'}</TableCell>
                        <TableCell className="max-w-[220px] truncate text-muted-foreground" title={k.ranking_url || undefined}>
                          {k.ranking_url ? <a href={k.ranking_url} target="_blank" rel="noreferrer" dir="ltr" className="hover:underline">{prettyUrl(k.ranking_url)}</a> : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ExplorerCompetingDomainsView({ workspaceId, domain }: { workspaceId: string; domain: string }) {
  const { t } = useTranslation();
  const scanQuery = useLatestExplorerCompetitorScan(workspaceId, domain);
  const startScan = useStartExplorerCompetitorScan(workspaceId);
  const scan = scanQuery.data?.scan ?? null;
  const resultsQuery = useExplorerCompetitors(workspaceId, scan?.status === 'completed' ? scan.id : undefined, { limit: 100 });

  const handleStart = async () => {
    try { await startScan.mutateAsync(domain); } catch (err) { toast.error(explorerErrorMessage(err, t)); }
  };

  if (scanQuery.isLoading) return <SkeletonTable rows={8} columns={4} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <DomainHeading domain={domain} />
        <Button size="sm" variant="outline" className="gap-1.5" onClick={handleStart} disabled={startScan.isPending}>
          <RefreshCw className={startScan.isPending ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {scan ? t('seo.explorer.cta.refresh' as any) : t('seo.explorer.cta.analyze' as any)}
        </Button>
      </div>

      {!scan ? (
        <ExplorerScanCta
          titleKey="seo.explorer.cta.competitorsTitle"
          descriptionKey="seo.explorer.cta.competitorsDescription"
          ctaKey="seo.explorer.cta.analyze"
          onStart={handleStart}
          pending={startScan.isPending}
        />
      ) : scan.status !== 'completed' && scan.status !== 'failed' && scan.status !== 'cancelled' ? (
        <ExplorerScanProgress progressStage={scan.progress_stage} />
      ) : scan.status !== 'completed' ? (
        <p className="text-sm text-destructive">{scan.error_message || t('seo.explorer.errors.generic' as any)}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <GradientStatCard icon={Globe2} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={formatCompact(scan.total_domains ?? 0)} label={t('seo.explorer.stat.competingDomains' as any)} />
          </div>
          <Card>
            <CardContent className="pt-6">
              {resultsQuery.isLoading ? (
                <SkeletonTable rows={8} columns={3} />
              ) : (resultsQuery.data?.results.length || 0) === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.gsc.empty.noData' as any)}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('seo.explorer.column.sourceDomain' as any)}</TableHead>
                      <TableHead className="text-end">{t('seo.explorer.column.intersections' as any)}</TableHead>
                      <TableHead className="text-end">{t('seo.explorer.column.avgPosition' as any)}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(resultsQuery.data?.results || []).map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="max-w-[280px] truncate font-medium">
                          <a href={`https://${c.domain}`} target="_blank" rel="noreferrer" className="hover:underline">{c.domain}</a>
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{c.intersections ?? '—'}</TableCell>
                        <TableCell className="text-end tabular-nums">{c.avg_position ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
