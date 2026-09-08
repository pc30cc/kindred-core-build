/**
 * SEO — Bot Analytics. Unlike Web Analytics, this is NOT a JS-beacon
 * pipeline: the chat widget's snippet can only see visitors whose browser
 * executes it, and essentially no search or AI/LLM crawler does (GPTBot,
 * ClaudeBot, PerplexityBot, CCBot, Googlebot's initial fetch, ... all just
 * request raw HTML). The only real source for "which bots crawled my site"
 * is the site's own web-server/CDN access log, which the workspace exports
 * and uploads here — see database/migrations/146_bot_analytics.sql's header
 * comment. Every row shown across all four leaves (Overview, Categories,
 * Crawled Pages, AI Bots) comes from a real, uploaded log line matched
 * against a maintained bot signature table
 * (server/services/botAnalytics/signatures.ts) — nothing is simulated.
 */
import { useMemo, useRef, useState } from 'react';
import {
  Bot, Sparkles, Search, Wrench, Share2, HelpCircle, UploadCloud, FileText, Trash2,
  AlertTriangle, Globe2, Layers,
} from 'lucide-react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { SkeletonStats, SkeletonTable } from '@/components/common/Skeletons';
import { PlanLockedOverlay } from '@/components/plan/PlanLockedOverlay';
import { toast } from '@/lib/toast';
import {
  useBotOverview, useBotCategories, useCrawledPages, useAiBots,
  useBotImports, useUploadBotLog, useDeleteBotImport, useBotAnalyticsLimits,
} from '@/hooks/useBotAnalytics';
import { BotAnalyticsApiError } from '@/lib/botAnalytics-api';
import { GradientStatCard } from './SeoPage';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip,
} from 'recharts';

// ─── Date range (mirrors WebAnalyticsSection.tsx) ──────────────────────

type RangePreset = '7d' | '28d' | '90d';

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

function rangeForPreset(preset: RangePreset): { startDate: string; endDate: string } {
  const end = new Date();
  const days = preset === '7d' ? 7 : preset === '28d' ? 28 : 90;
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function formatCompact(v: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

function formatDateTime(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function botAnalyticsErrorMessage(err: unknown, t: (k: any) => string): string {
  if (err instanceof BotAnalyticsApiError) {
    if (err.upgradeRequired) return t('seo.botAnalytics.errors.limit_reached' as any);
    const key = `seo.botAnalytics.errors.${err.code}`;
    const translated = t(key as any);
    if (translated !== key) return translated;
  }
  return t('seo.botAnalytics.errors.generic' as any);
}

const CATEGORY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  ai_assistant: Sparkles,
  search_engine: Search,
  seo_tool: Wrench,
  social: Share2,
  other: HelpCircle,
};

// ─── Entry point ──────────────────────────────────────────────────────

export function BotAnalyticsSection({ workspaceId, subsectionKey }: { workspaceId: string; subsectionKey: string }) {
  return (
    <PlanLockedOverlay moduleKey="bot_analytics">
      <BotAnalyticsInner workspaceId={workspaceId} subsectionKey={subsectionKey} />
    </PlanLockedOverlay>
  );
}

function BotAnalyticsInner({ workspaceId, subsectionKey }: { workspaceId: string; subsectionKey: string }) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<RangePreset>('28d');
  const range = useMemo(() => rangeForPreset(preset), [preset]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('seo.botAnalytics.dataSourceNote' as any)}</p>
        <div className="flex items-center gap-2">
          <ImportLogButton workspaceId={workspaceId} />
          <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
            <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">{t('seo.webAnalytics.range.last7' as any)}</SelectItem>
              <SelectItem value="28d">{t('seo.webAnalytics.range.last28' as any)}</SelectItem>
              <SelectItem value="90d">{t('seo.webAnalytics.range.last90' as any)}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <BotAnalyticsDataView workspaceId={workspaceId} subsectionKey={subsectionKey} range={range} />
    </div>
  );
}

function BotAnalyticsDataView({ workspaceId, subsectionKey, range }: { workspaceId: string; subsectionKey: string; range: { startDate: string; endDate: string } }) {
  switch (subsectionKey) {
    case 'overview': return <OverviewView workspaceId={workspaceId} range={range} />;
    case 'categories': return <CategoriesView workspaceId={workspaceId} range={range} />;
    case 'crawledPages': return <CrawledPagesView workspaceId={workspaceId} range={range} />;
    case 'aiBots': return <AiBotsView workspaceId={workspaceId} range={range} />;
    default: return null;
  }
}

// ─── Shared: empty state when no log has ever been uploaded ───────────

function NoImportsEmptyState({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  return (
    <Card className="overflow-hidden">
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Bot className="h-5 w-5" />
        </span>
        <h3 className="text-base font-semibold">{t('seo.botAnalytics.empty.noImportsTitle' as any)}</h3>
        <p className="max-w-md text-sm text-muted-foreground">{t('seo.botAnalytics.empty.noImportsDescription' as any)}</p>
        <ImportLogButton workspaceId={workspaceId} />
      </CardContent>
    </Card>
  );
}

function ReportCard({ title, description, truncated, children }: { title: string; description?: string; truncated?: boolean; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {truncated && <Badge variant="outline" className="mt-1 w-fit gap-1 text-[10px] text-amber-600"><AlertTriangle className="h-3 w-3" />{t('seo.webAnalytics.truncatedNotice' as any)}</Badge>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// ─── Overview ───────────────────────────────────────────────────────────

function OverviewChartTooltip({ active, payload, label }: any) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border/60 bg-popover px-3 py-2 shadow-lg">
      <p className="mb-1 text-xs font-medium text-foreground">{label}</p>
      <div className="flex items-center gap-2 text-xs">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: payload[0]?.color }} />
        <span className="text-muted-foreground">{t('seo.botAnalytics.column.visits' as any)}</span>
        <span className="ms-auto font-semibold tabular-nums text-foreground">{formatCompact(payload[0]?.value ?? 0)}</span>
      </div>
    </div>
  );
}

function OverviewView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data, isLoading } = useBotOverview(workspaceId, range);

  if (isLoading) return <SkeletonStats count={4} />;
  if (!data) return null;
  if (!data.hasImports) return <NoImportsEmptyState workspaceId={workspaceId} />;

  const aiVisits = data.topCategories.find((c) => c.key === 'ai_assistant')?.visits || 0;
  const aiShare = data.totalVisits > 0 ? Math.round((aiVisits / data.totalVisits) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <GradientStatCard icon={Bot} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={formatCompact(data.totalVisits)} label={t('seo.botAnalytics.stat.totalVisits' as any)} />
        <GradientStatCard icon={Layers} iconGradient="from-sky-500 to-cyan-500" blobColor="bg-sky-500/15" value={formatCompact(data.uniqueBots)} label={t('seo.botAnalytics.stat.uniqueBots' as any)} />
        <GradientStatCard icon={Globe2} iconGradient="from-emerald-500 to-teal-500" blobColor="bg-emerald-500/15" value={formatCompact(data.uniquePaths)} label={t('seo.botAnalytics.stat.uniquePaths' as any)} />
        <GradientStatCard icon={Sparkles} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={`${aiShare}%`} label={t('seo.botAnalytics.stat.aiShare' as any)} />
      </div>

      {data.totalVisits === 0 ? (
        <Card>
          <CardContent className="py-14 text-center text-sm text-muted-foreground">{t('seo.botAnalytics.empty.noVisitsInRange' as any)}</CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('seo.botAnalytics.overview.trendTitle' as any)}</CardTitle>
              {data.truncated && <Badge variant="outline" className="mt-1 w-fit gap-1 text-[10px] text-amber-600"><AlertTriangle className="h-3 w-3" />{t('seo.webAnalytics.truncatedNotice' as any)}</Badge>}
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="botVisitsFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.32} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/40" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} tickFormatter={(d: string) => d.slice(5)} />
                    <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={40} />
                    <ReTooltip content={<OverviewChartTooltip />} />
                    <Area type="monotone" dataKey="visits" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="url(#botVisitsFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">{t('seo.botAnalytics.overview.topBots' as any)}</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  {data.topBots.map((b) => (
                    <div key={b.key} className="flex items-center justify-between text-sm">
                      <span className="truncate text-foreground">{b.label}</span>
                      <span className="tabular-nums text-muted-foreground">{formatCompact(b.visits)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">{t('seo.nav.section.botAnalytics' as any)} — {t('seo.botAnalytics.column.category' as any)}</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  {data.topCategories.map((c) => {
                    const Icon = CATEGORY_ICON[c.key] || HelpCircle;
                    return (
                      <div key={c.key} className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2 truncate text-foreground"><Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{c.label}</span>
                        <span className="tabular-nums text-muted-foreground">{formatCompact(c.visits)}</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Categories ─────────────────────────────────────────────────────────

function CategoriesView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data: overview } = useBotOverview(workspaceId, range);
  const { data, isLoading } = useBotCategories(workspaceId, range);

  if (overview && !overview.hasImports) return <NoImportsEmptyState workspaceId={workspaceId} />;

  return (
    <ReportCard title={t('seo.nav.item.categories' as any)} description={t('seo.botAnalytics.categories.description' as any)} truncated={data?.truncated}>
      {isLoading ? (
        <SkeletonTable rows={5} columns={3} />
      ) : (data?.rows.length || 0) === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.empty.noData' as any)}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('seo.botAnalytics.column.category' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.botAnalytics.column.uniqueBots' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.botAnalytics.column.visits' as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.rows || []).map((r) => {
              const Icon = CATEGORY_ICON[r.key] || HelpCircle;
              return (
                <TableRow key={r.key}>
                  <TableCell className="font-medium"><span className="flex items-center gap-2"><Icon className="h-3.5 w-3.5 text-muted-foreground" />{r.label}</span></TableCell>
                  <TableCell className="text-end tabular-nums text-muted-foreground">{formatCompact(r.uniqueBots)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatCompact(r.visits)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </ReportCard>
  );
}

// ─── Crawled pages ────────────────────────────────────────────────────

function CrawledPagesView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data: overview } = useBotOverview(workspaceId, range);
  const { data, isLoading } = useCrawledPages(workspaceId, range);

  if (overview && !overview.hasImports) return <NoImportsEmptyState workspaceId={workspaceId} />;

  return (
    <ReportCard title={t('seo.nav.item.crawledPages' as any)} truncated={data?.truncated}>
      {isLoading ? (
        <SkeletonTable rows={8} columns={3} />
      ) : (data?.rows.length || 0) === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.webAnalytics.empty.noData' as any)}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('seo.webAnalytics.column.page' as any)}</TableHead>
              <TableHead>{t('seo.botAnalytics.column.topBot' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.botAnalytics.column.uniqueBots' as any)}</TableHead>
              <TableHead className="text-end">{t('seo.botAnalytics.column.visits' as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.rows || []).map((r) => (
              <TableRow key={r.path}>
                <TableCell className="max-w-[320px] truncate font-medium" title={r.path}>{r.path}</TableCell>
                <TableCell className="text-muted-foreground">{r.topBot}</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{formatCompact(r.uniqueBots)}</TableCell>
                <TableCell className="text-end tabular-nums">{formatCompact(r.visits)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ReportCard>
  );
}

// ─── AI bots (the headline view) ───────────────────────────────────────

function AiBotsView({ workspaceId, range }: { workspaceId: string; range: { startDate: string; endDate: string } }) {
  const { t } = useTranslation();
  const { data: overview } = useBotOverview(workspaceId, range);
  const { data, isLoading } = useAiBots(workspaceId, range);

  if (overview && !overview.hasImports) return <NoImportsEmptyState workspaceId={workspaceId} />;

  const share = data && data.totalVisits > 0 ? Math.round((data.totalAiVisits / data.totalVisits) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <GradientStatCard icon={Sparkles} iconGradient="from-fuchsia-500 to-purple-500" blobColor="bg-fuchsia-500/15" value={formatCompact(data?.totalAiVisits || 0)} label={t('seo.botAnalytics.aiBots.totalAiVisits' as any)} />
        <GradientStatCard icon={Bot} iconGradient="from-indigo-500 to-violet-500" blobColor="bg-indigo-500/15" value={data?.rows.length || 0} label={t('seo.botAnalytics.aiBots.distinctBots' as any)} />
        <GradientStatCard icon={Layers} iconGradient="from-amber-500 to-orange-500" blobColor="bg-amber-500/15" value={`${share}%`} label={t('seo.botAnalytics.stat.aiShare' as any)} />
      </div>

      <ReportCard title={t('seo.nav.item.aiBots' as any)} description={t('seo.botAnalytics.aiBots.description' as any)} truncated={data?.truncated}>
        {isLoading ? (
          <SkeletonTable rows={6} columns={4} />
        ) : (data?.rows.length || 0) === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('seo.botAnalytics.aiBots.empty' as any)}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('seo.botAnalytics.column.bot' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.botAnalytics.column.visits' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.botAnalytics.column.uniquePaths' as any)}</TableHead>
                <TableHead className="text-end">{t('seo.botAnalytics.column.lastSeen' as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.rows || []).map((r) => (
                <TableRow key={r.botName}>
                  <TableCell className="font-medium"><span className="flex items-center gap-2"><Sparkles className="h-3.5 w-3.5 text-fuchsia-500" />{r.botName}</span></TableCell>
                  <TableCell className="text-end tabular-nums">{formatCompact(r.visits)}</TableCell>
                  <TableCell className="text-end tabular-nums text-muted-foreground">{formatCompact(r.uniquePaths)}</TableCell>
                  <TableCell className="text-end text-xs text-muted-foreground">{formatDateTime(r.lastSeen)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ReportCard>
    </div>
  );
}

// ─── Import log dialog (upload + history), shared across all leaves ───

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.slice(result.indexOf(',') + 1) : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function ImportLogButton({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: limitsData } = useBotAnalyticsLimits(workspaceId);
  const { data: importsData, isLoading: importsLoading } = useBotImports(workspaceId);
  const uploadLog = useUploadBotLog(workspaceId);
  const deleteImport = useDeleteBotImport(workspaceId);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const maxLines = limitsData?.limits.bot_analytics_max_log_lines ?? 0;
  const imports = importsData?.imports || [];

  const handleUpload = async () => {
    if (!selectedFile) return;
    try {
      const base64Data = await readFileAsBase64(selectedFile);
      const result = await uploadLog.mutateAsync({ filename: selectedFile.name, base64Data });
      toast.success(t('seo.botAnalytics.import.uploaded' as any, { count: result.import.matchedBotLines } as any));
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      toast.error(botAnalyticsErrorMessage(err, t));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
          <UploadCloud className="h-3.5 w-3.5" />{t('seo.botAnalytics.import.button' as any)}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('seo.botAnalytics.import.dialogTitle' as any)}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t('seo.botAnalytics.import.dialogDescription' as any)}</p>

          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".log,.txt,.jsonl,.json,text/plain,application/json"
              onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
              className="text-xs file:me-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium"
            />
            {maxLines > 0 && (
              <p className="text-[11px] text-muted-foreground">{t('seo.botAnalytics.import.maxLinesNote' as any, { count: maxLines } as any)}</p>
            )}
          </div>

          <Button onClick={handleUpload} disabled={!selectedFile || uploadLog.isPending} className="self-start gap-1.5">
            <UploadCloud className="h-3.5 w-3.5" />
            {uploadLog.isPending ? t('seo.botAnalytics.import.uploading' as any) : t('seo.botAnalytics.import.upload' as any)}
          </Button>

          <div className="border-t border-border/60 pt-3">
            <h4 className="mb-2 text-xs font-semibold text-muted-foreground">{t('seo.botAnalytics.import.recentImports' as any)}</h4>
            {importsLoading ? (
              <SkeletonTable rows={2} columns={2} />
            ) : imports.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">{t('seo.botAnalytics.import.noImports' as any)}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {imports.map((imp) => (
                  <div key={imp.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium" title={imp.filename}>{imp.filename}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{formatCompact(imp.matchedBotLines)}</span>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('seo.botAnalytics.import.deleteConfirmTitle' as any)}</AlertDialogTitle>
                          <AlertDialogDescription>{t('seo.botAnalytics.import.deleteConfirmDescription' as any)}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('seo.gsc.disconnectConfirm.cancel' as any)}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteImport.mutate(imp.id)}>{t('seo.botAnalytics.import.delete' as any)}</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('seo.botAnalytics.import.close' as any)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
