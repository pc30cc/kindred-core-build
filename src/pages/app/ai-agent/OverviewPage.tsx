import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useActiveWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useUpdateAiAgentSettings } from '@/hooks/useAiAgent';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/use-toast';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard, AlertTriangle, CheckCircle2, AlertCircle, Loader2,
  RefreshCw, Plus, Globe, Beaker, GraduationCap, Tags, Workflow,
  Sparkles, Database, MessageSquare, BookOpen, Wrench, ArrowUpRight,
  Activity as ActivityIcon, Bot, Zap, Languages, UserCog, ListChecks,
} from 'lucide-react';
import TestAiPanel from './TestAiPanel';

const SEVERITY_STYLES: Record<string, string> = {
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
};

const ENABLE_ERROR_MESSAGES: Record<string, string> = {
  ai_provider_not_configured: 'یک سرویس‌دهنده هوش مصنوعی برای این ورک‌اسپیس تنظیم نشده است.',
  no_published_knowledge: 'برای پاسخ‌دهی فقط از پایگاه دانش، باید حداقل یک مقاله منتشر شده داشته باشید.',
  module_ai_assistant_not_enabled: 'ماژول دستیار هوشمند در پلن فعلی این ورک‌اسپیس فعال نیست.',
  owner_or_admin_required: 'فقط مالک یا ادمین ورک‌اسپیس می‌تواند این تنظیم را تغییر دهد.',
};

export default function OverviewPage() {
  const { workspace } = useActiveWorkspace();
  const wsId = workspace?.id;
  const wsPath = useWorkspacePath();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, dir } = useTranslation();
  const tr = (k: string, fb: string) => {
    const v = t(`aiAgent.overview.${k}` as any);
    return !v || v === `aiAgent.overview.${k}` ? fb : v;
  };
  const isRtl = dir === 'rtl';
  const trWarning = (w: { code: string; message: string }): string => {
    const key = `aiAgent.overview.warning.${w.code}`;
    const count = (w.message.match(/\d+/) || [])[0] || '';
    const name = (w.message.match(/"([^"]+)"/) || [])[1] || '';
    const v = t(key as any, { count, name });
    return !v || v === key ? w.message : v;
  };
  const trEnum = (group: string, value?: string | null): string => {
    if (!value) return '—';
    const key = `aiAgent.overview.${group}.${value}`;
    const v = t(key as any);
    return !v || v === key ? value : v;
  };
  /** Sync-log status badge: prefer syncStatus, fall back to runStatus, then raw. */
  const trSyncStatus = (value?: string | null): string => {
    if (!value) return '—';
    const s = trEnum('syncStatus', value);
    if (s !== value) return s;
    return trEnum('runStatus', value);
  };
  /** Translate a raw error/status code emitted by the sync worker. */
  const trCode = (code: string): string => {
    const clean = code.trim();
    const key = `aiAgent.overview.syncCode.${clean}`;
    const v = t(key as any);
    if (v && v !== key) return v;
    const s = trEnum('syncStatus', clean);
    return s !== clean ? s : clean;
  };
  /** Translate free-form sync log messages produced by the server/worker. */
  const trSyncMessage = (raw?: string | null): string => {
    const msg = (raw || '').trim();
    if (!msg) return '';
    const m = (k: string, vars?: Record<string, string>) => {
      const key = `aiAgent.overview.syncMessage.${k}`;
      const v = t(key as any, vars as any);
      return !v || v === key ? msg : v;
    };
    const exact: Record<string, string> = {
      'Worker started': 'worker_started',
      'Sync completed': 'sync_completed',
      'Sync job queued': 'sync_queued',
      'Sync job queued (admin bypass)': 'sync_queued_admin',
      'Retry sync job queued': 'retry_queued',
      'Retry sync job queued (admin bypass)': 'retry_queued_admin',
      'Original stored': 'original_stored',
      'Ingestion job queued': 'ingestion_queued',
    };
    if (exact[msg]) return m(exact[msg]);
    const prefixed: Array<[RegExp, string, 'name' | 'value']> = [
      [/^Upload accepted:\s*(.+)$/i, 'upload_accepted', 'name'],
      [/^Crawl failed:\s*(.+)$/i, 'crawl_failed', 'value'],
      [/^job_status=(.+)$/i, 'job_status', 'value'],
      [/^source_status=(.+)$/i, 'source_status', 'value'],
      [/^complete_lost_race:(.+)$/i, 'complete_lost_race', 'value'],
      [/^fail_lost_race:(.+)$/i, 'fail_lost_race', 'value'],
    ];
    for (const [re, key, varName] of prefixed) {
      const hit = msg.match(re);
      if (hit) {
        const val = hit[1].trim();
        return m(key, { [varName]: varName === 'value' ? trCode(val) : val });
      }
    }
    // Bare error/status codes (snake_case) coming from the worker.
    if (/^[a-z0-9_]+$/.test(msg)) return trCode(msg);
    return msg;
  };

  const overview = useQuery({
    queryKey: ['ai-overview', wsId],
    queryFn: () => aiAgentApi.getOverview(wsId!),
    enabled: !!wsId,
    staleTime: 15_000,
  });

  const updateSettings = useUpdateAiAgentSettings(wsId);
  const [enabling, setEnabling] = useState(false);
  const toggleEnabled = async (v: boolean) => {
    setEnabling(true);
    try {
      await updateSettings.mutateAsync({ enabled: v });
      toast({ title: v ? 'دستیار هوشمند فعال شد' : 'دستیار هوشمند غیرفعال شد' });
      overview.refetch();
    } catch (e: any) {
      toast({
        title: ENABLE_ERROR_MESSAGES[e?.code] || e?.message || 'ذخیره‌سازی ناموفق بود',
        variant: 'destructive',
      });
    } finally {
      setEnabling(false);
    }
  };

  const rebuild = useMutation({
    mutationFn: () => aiAgentApi.rebuildKnowledgeIndex(wsId!),
    onSuccess: () => { toast({ title: tr('toast.rebuilt', 'Knowledge index rebuilt') }); qc.invalidateQueries({ queryKey: ['ai-overview', wsId] }); },
    onError: (e: any) => toast({ title: tr('toast.failed', 'Rebuild failed'), description: e?.message, variant: 'destructive' }),
  });

  if (overview.isLoading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  const data = overview.data;
  if (!data) return <p className="text-sm text-muted-foreground">{tr('noData', 'No data available yet.')}</p>;
  const c = data.counts;
  const ready = data.settings.enabled && c.activeChunks > 0;

  return (
    <div className="space-y-8" dir={dir}>
      {/* Hero header */}
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 sm:p-8">
        <div className="pointer-events-none absolute -top-16 -end-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-20 -start-10 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-primary to-primary/60 shadow-lg shadow-primary/30 flex items-center justify-center shrink-0">
              <Bot className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                {tr('title', 'Overview')}
              </h1>
              <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">
                {tr('subtitle', 'Status, knowledge readiness, recent activity, and notices for your AI Agent.')}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border',
                  ready
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300',
                )}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', ready ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500')} />
                  {ready ? tr('statusReady', 'Ready') : tr('statusNotReady', 'Not ready')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {ready ? tr('statusReadyHint', 'Your AI Agent is live and answering.') : tr('statusNotReadyHint', 'Add knowledge or enable the agent to go live.')}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 self-start sm:self-auto">
            <div className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-background/60 px-4 py-2.5">
              <span className={cn('h-2 w-2 rounded-full', data.settings.enabled ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/40')} />
              <span className="text-sm font-medium">{data.settings.enabled ? 'دستیار هوشمند فعال است' : 'دستیار هوشمند غیرفعال است'}</span>
              <Switch checked={!!data.settings.enabled} onCheckedChange={toggleEnabled} disabled={enabling} />
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate(wsPath('/ai-agent/activation'))}>
              <ListChecks className="h-3.5 w-3.5 me-1.5" />
              {tr('setupAction', 'Setup & readiness')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => overview.refetch()} disabled={overview.isFetching}>
              <RefreshCw className={cn('h-3.5 w-3.5 me-1.5', overview.isFetching && 'animate-spin')} />
              {tr('refresh', 'Refresh')}
            </Button>
          </div>
        </div>
      </div>

      {/* Status & configuration */}
      <Section title={tr('sectionStatus', 'Status & configuration')}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard tone="emerald" icon={ready ? CheckCircle2 : AlertCircle} label={tr('stat.status', 'Status')} value={ready ? tr('statusReady', 'Ready') : tr('statusNotReady', 'Not ready')} />
          <StatCard tone="violet" icon={Sparkles} label={tr('stat.mode', 'Mode')} value={trEnum('mode', data.settings.mode)} />
          <StatCard tone="sky" icon={Database} label={tr('stat.chunks', 'Knowledge chunks')} value={`${c.embeddedChunks}/${c.activeChunks}`} hint={tr('embedded', 'embedded / active')} />
          <StatCard tone="amber" icon={MessageSquare} label={tr('stat.qna', 'Q&A pairs')} value={String(c.qna)} />
        </div>
      </Section>

      {/* Knowledge & automations */}
      <Section title={tr('sectionKnowledge', 'Knowledge & automations')}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard tone="rose" icon={Tags} label={tr('stat.topics', 'Topics')} value={String(c.topics)} />
          <StatCard tone="indigo" icon={Workflow} label={tr('stat.workflows', 'Workflows')} value={String(c.workflows)} />
          <StatCard tone="teal" icon={Zap} label={tr('stat.triggers', 'Triggers')} value={String(c.messageTriggers)} />
          <StatCard tone="slate" icon={Wrench} label={tr('stat.tools', 'Tools')} value={String(c.tools)} />
        </div>
      </Section>

      {/* Last 24h */}
      <Section title={tr('sectionActivity', 'Last 24 hours')} icon={ActivityIcon}>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatCard tone="primary" icon={Sparkles} label={tr('stat.runs24h', 'AI runs')} value={String(c.aiRuns24h)} />
          <StatCard tone="emerald" icon={MessageSquare} label={tr('stat.replies24h', 'Replies')} value={String(c.replies24h)} />
          <StatCard tone="amber" icon={UserCog} label={tr('stat.handoffs24h', 'Handoffs')} value={String(c.handoffs24h)} />
          <StatCard tone="rose" icon={AlertCircle} label={tr('stat.noAnswer24h', 'No answer')} value={String(c.noAnswer24h)} />
          <StatCard tone="sky" icon={Languages} label={tr('stat.langRepairs24h', 'Language repairs')} value={String(c.outputLanguageRepairs24h)} />
        </div>
      </Section>

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> {tr('sectionWarnings', 'Warnings & notices')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.warnings.map((w) => (
              <div key={w.code} className={cn('rounded-lg border px-3 py-2 text-sm', SEVERITY_STYLES[w.severity] || '')}>
                {trWarning(w as any)}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Quick actions */}
      <Card className="overflow-hidden border-border/60">
        <CardHeader className="bg-gradient-to-r from-primary/5 to-transparent">
          <CardTitle className="text-base flex items-center gap-2"><Zap className="h-4 w-4 text-primary" /> {tr('sectionQuick', 'Quick actions')}</CardTitle>
          <CardDescription>{tr('sectionQuickDesc', 'Most common next steps for your AI Agent.')}</CardDescription>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-5">
          <QuickAction tone="primary" icon={RefreshCw} label={tr('action.rebuild', 'Rebuild knowledge index')} onClick={() => rebuild.mutate()} loading={rebuild.isPending} isRtl={isRtl} />
          <QuickAction tone="emerald" icon={Plus} label={tr('action.addQna', 'Add Q&A')} onClick={() => navigate(wsPath('/ai-agent/qna'))} isRtl={isRtl} />
          <QuickAction tone="sky" icon={Globe} label={tr('action.addWeb', 'Add web page source')} onClick={() => navigate(wsPath('/ai-agent/web-pages'))} isRtl={isRtl} />
          <QuickAction tone="violet" icon={Beaker} label={tr('action.test', 'Test AI Agent')} onClick={() => navigate(wsPath('/ai-agent/playground'))} isRtl={isRtl} />
          <QuickAction tone="amber" icon={GraduationCap} label={tr('action.review', 'Review learning candidates')} onClick={() => navigate(wsPath('/ai-agent/learning-candidates'))} isRtl={isRtl} />
          <QuickAction tone="rose" icon={Tags} label={tr('action.topics', 'Add default topics')} onClick={() => navigate(wsPath('/ai-agent/topics'))} isRtl={isRtl} />
          <QuickAction tone="indigo" icon={Workflow} label={tr('action.workflow', 'Create workflow')} onClick={() => navigate(wsPath('/ai-agent/workflow'))} isRtl={isRtl} />
        </CardContent>
      </Card>

      {/* Recent activity */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><ActivityIcon className="h-4 w-4 text-primary" /> {tr('sectionRecentRuns', 'Recent AI runs')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.recentRuns.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">{tr('noRecentRuns', 'No recent activity yet.')}</p>
            ) : data.recentRuns.slice(0, 10).map((r) => (
              <div key={r.id} className="flex items-start gap-2 text-xs py-2 border-b border-border/40 last:border-b-0 hover:bg-accent/30 -mx-2 px-2 rounded-md transition-colors">
                <Badge variant="outline" className="text-[10px] shrink-0">{trEnum('runStatus', r.status)}</Badge>
                <span className="text-muted-foreground shrink-0">{r.run_type ? trEnum('runType', r.run_type) : ''}</span>
                <span className="flex-1 truncate">{r.input_text || ''}</span>
                <span className="tabular-nums text-muted-foreground shrink-0">{new Date(r.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-border/60">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2"><BookOpen className="h-4 w-4 text-primary" /> {tr('sectionRecentSync', 'Recent sync logs')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.recentSyncLogs.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">{tr('noRecentSync', 'No sync logs yet.')}</p>
            ) : data.recentSyncLogs.map((l) => (
              <div key={l.id} className="flex items-start gap-2 text-xs py-2 border-b border-border/40 last:border-b-0 hover:bg-accent/30 -mx-2 px-2 rounded-md transition-colors">
                <Badge variant="outline" className="text-[10px] shrink-0">{trSyncStatus(l.status)}</Badge>
                <span className="flex-1 truncate">
                  {trSyncMessage(l.message) || t('aiAgent.overview.syncSummary' as any, { pages: String(l.pages_found ?? 0), chunks: String(l.chunks_created ?? 0) })}
                </span>
                <span className="tabular-nums text-muted-foreground shrink-0">{new Date(l.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <TestAiPanel />
    </div>
  );
}

const TONE_STYLES: Record<string, { bg: string; ring: string; icon: string }> = {
  primary:  { bg: 'bg-primary/10',                ring: 'ring-primary/20',     icon: 'text-primary' },
  emerald:  { bg: 'bg-emerald-500/10',            ring: 'ring-emerald-500/20', icon: 'text-emerald-500' },
  amber:    { bg: 'bg-amber-500/10',              ring: 'ring-amber-500/20',   icon: 'text-amber-500' },
  rose:     { bg: 'bg-rose-500/10',               ring: 'ring-rose-500/20',    icon: 'text-rose-500' },
  sky:      { bg: 'bg-sky-500/10',                ring: 'ring-sky-500/20',     icon: 'text-sky-500' },
  violet:   { bg: 'bg-violet-500/10',             ring: 'ring-violet-500/20',  icon: 'text-violet-500' },
  indigo:   { bg: 'bg-indigo-500/10',             ring: 'ring-indigo-500/20',  icon: 'text-indigo-500' },
  teal:     { bg: 'bg-teal-500/10',               ring: 'ring-teal-500/20',    icon: 'text-teal-500' },
  slate:    { bg: 'bg-slate-500/10',              ring: 'ring-slate-500/20',   icon: 'text-slate-500' },
};

function Section({ title, icon: Icon, children }: { title: string; icon?: any; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        {Icon && <Icon className="h-3.5 w-3.5" />} {title}
      </h2>
      {children}
    </div>
  );
}

function StatCard({ label, value, icon: Icon, hint, tone = 'primary' }: { label: string; value: string; icon: any; hint?: string; tone?: keyof typeof TONE_STYLES }) {
  const t = TONE_STYLES[tone] || TONE_STYLES.primary;
  return (
    <Card className="group relative overflow-hidden border-border/60 hover:shadow-md transition-all hover:-translate-y-0.5">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <div className={cn('h-7 w-7 rounded-lg flex items-center justify-center ring-1', t.bg, t.ring)}>
            <Icon className={cn('h-3.5 w-3.5', t.icon)} />
          </div>
        </div>
        <p className="text-2xl font-bold mt-2 tabular-nums">{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function QuickAction({ icon: Icon, label, onClick, loading, tone = 'primary', isRtl }: { icon: any; label: string; onClick: () => void; loading?: boolean; tone?: keyof typeof TONE_STYLES; isRtl?: boolean }) {
  const t = TONE_STYLES[tone] || TONE_STYLES.primary;
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="group relative flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3.5 text-start hover:border-primary/40 hover:shadow-md transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <div className={cn('h-9 w-9 rounded-lg flex items-center justify-center ring-1 shrink-0', t.bg, t.ring)}>
        {loading ? <Loader2 className={cn('h-4 w-4 animate-spin', t.icon)} /> : <Icon className={cn('h-4 w-4', t.icon)} />}
      </div>
      <span className="flex-1 text-sm font-medium">{label}</span>
      <ArrowUpRight className={cn(
        'h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0',
        isRtl && 'rotate-[270deg]',
      )} />
    </button>
  );
}