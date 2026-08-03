import { useEffect, useState, useCallback } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiKbApi, type AiKbSourceResponse } from '@/lib/ai-kb-api';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Globe, Sparkles, AlertCircle, CheckCircle2, RefreshCcw, FileText, Clock, Eye, Info, Rocket } from 'lucide-react';

const ERROR_MESSAGES: Record<string, string> = {
  no_scannable_domain: 'No verified workspace domain. Add and verify a domain first.',
  monthly_job_limit_reached: 'You have reached this month\u2019s scan limit for your plan.',
  module_disabled: 'AI Knowledge Builder is not enabled on your plan.',
  unauthorized: 'You are not authorized to start a scan.',
  job_create_failed: 'Could not create the job. Please try again.',
  invalid_params: 'Invalid request. Please refresh and retry.',
};

function friendlyError(raw: string | undefined): string {
  if (!raw) return 'Failed to start scan';
  if (ERROR_MESSAGES[raw]) return ERROR_MESSAGES[raw];
  if (raw.includes('Module ')) return raw;
  return raw;
}

export default function AiKbBuilderTab() {
  const workspace = useCurrentWorkspace();
  const { locale } = useTranslation();
  const [src, setSrc] = useState<AiKbSourceResponse | null>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [activeJob, setActiveJob] = useState<any | null>(null);
  const [generated, setGenerated] = useState<any[]>([]);
  const [jobEvents, setJobEvents] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [stuckQueued, setStuckQueued] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspace?.id) return;
    try {
      const [s, j] = await Promise.all([
        aiKbApi.getSource(workspace.id),
        aiKbApi.listJobs(workspace.id),
      ]);
      setSrc(s);
      setJobs(j.jobs || []);
      const latest = (j.jobs || [])[0];
      if (latest) {
        const detail = await aiKbApi.getJob(latest.id);
        setActiveJob(detail.job);
        setGenerated(detail.generated || []);
        setJobEvents((detail as any).events || []);
      }
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load AI Builder state');
    }
  }, [workspace?.id]);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll while a job is running.
  useEffect(() => {
    if (!activeJob || ['completed','partial','failed','canceled'].includes(activeJob.status)) return;
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [activeJob, refresh]);

  const startScan = async () => {
    if (!workspace?.id) return;
    setBusy(true);
    try {
      const uiLocale = (['en', 'fa', 'tr'].includes(locale as string) ? locale : 'en') as 'en' | 'fa' | 'tr';
      const r = await aiKbApi.createJob(workspace.id, { locale: uiLocale });
      const id = r?.job?.id;
      toast.success(id ? `Scan queued (job ${id.slice(0, 8)}). Waiting for worker…` : 'Scan queued.');
      setStuckQueued(false);
      await refresh();
    } catch (e: any) {
      toast.error(friendlyError(e?.message));
    } finally { setBusy(false); }
  };

  // Detect "queued > 60s without worker pickup" so we can surface a clear hint.
  useEffect(() => {
    if (!activeJob || activeJob.status !== 'queued') { setStuckQueued(false); return; }
    const created = new Date(activeJob.created_at).getTime();
    const check = () => {
      setStuckQueued(Date.now() - created > 60_000 && activeJob.status === 'queued');
    };
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, [activeJob]);

  const onAction = async (id: string, action: 'accept' | 'reject' | 'publish') => {
    try {
      await (action === 'accept' ? aiKbApi.accept(id) : action === 'reject' ? aiKbApi.reject(id) : aiKbApi.publish(id));
      toast.success(action === 'publish' ? 'Published' : action === 'accept' ? 'Saved as KB draft' : 'Rejected');
      await refresh();
    } catch (e: any) {
      // A refused transition means someone else already moved this draft —
      // re-sync so the operator sees the real state instead of a stale row.
      if (e?.code === 'invalid_state') {
        toast.error(
          e.currentStatus
            ? `This draft is already "${e.currentStatus}" and can no longer be ${action}ed.`
            : 'This draft was already reviewed by someone else.',
        );
        await refresh();
        return;
      }
      if (e?.retryable) {
        toast.error('The knowledge base is temporarily unavailable. Please try again.');
        return;
      }
      toast.error(e?.message || 'Action failed');
    }
  };

  const publishAll = async () => {
    if (!activeJob?.id) return;
    const eligible = generated.filter((g) => g.status === 'pending' || g.status === 'accepted').length;
    if (!eligible) { toast.info('No drafts to publish'); return; }
    if (!window.confirm(`Publish ${eligible} draft(s) to the widget Help Center?`)) return;
    try {
      const r = await aiKbApi.publishAll(activeJob.id);
      toast.success(`Published ${r.published_count} draft(s)${r.failed_count ? ` · ${r.failed_count} failed` : ''}`);
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || 'Publish all failed');
    }
  };

  const statusBadge = (status: string) => {
    if (status === 'pending') return <Badge variant="outline" className="text-[10px]">Generated only · not in widget</Badge>;
    if (status === 'accepted') return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-[10px]">Saved as KB draft · not in widget</Badge>;
    if (status === 'published') return <Badge className="bg-success/10 text-success border-success/20 text-[10px]">Published in Help Center</Badge>;
    if (status === 'rejected') return <Badge variant="outline" className="text-[10px]">Rejected</Badge>;
    return <Badge variant="outline" className="text-[10px] capitalize">{status}</Badge>;
  };

  const publicHelpUrl = (g: any) => {
    const slug = g.slug || g.kb_article_slug;
    if (!slug) return null;
    const loc = g.locale || 'en';
    return `${window.location.origin}/help/${loc}/a/${slug}`;
  };

  if (!src) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const isAdmin = !!src.is_global_admin;
  // Phase 6-S5-R4 — only the AI KB Builder feature gates this surface.
  // `knowledge_base` is a core product and is never an access requirement.
  const moduleBlocked = !src.modules.ai_kb_builder;
  const blocked = moduleBlocked && !isAdmin;

  const noDomain = !src.source.can_scan || !src.source.domain;
  const limitReached = !src.plan.can_start_job && !isAdmin;
  const disabledReason = blocked
    ? 'AI Knowledge Builder module is disabled on your plan.'
    : noDomain
      ? 'No workspace domain available. Add a domain in workspace settings first.'
      : limitReached
        ? `Monthly scan limit reached (${src.plan.jobs_used_this_month}/${src.plan.limits.jobsPerMonth}).`
        : '';

  return (
    <div className="space-y-5">
      {/* Source + plan */}
      <div className="card-elevated p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-primary/10"><Globe className="w-4 h-4 text-primary" /></div>
            <div>
              <div className="text-xs text-muted-foreground">Scan source (workspace domain only)</div>
              <div className="text-sm font-semibold text-foreground">{src.source.domain || '— No domain available —'}</div>
              <div className="mt-1 flex items-center gap-2">
                {src.source.verified
                  ? <Badge className="bg-success/10 text-success border-success/20">Verified</Badge>
                  : src.source.kind === 'profile_domain'
                    ? <Badge variant="outline">Pending verification</Badge>
                    : <Badge variant="outline">Unverified</Badge>}
                {src.source.is_primary && <Badge variant="secondary">Primary</Badge>}
              </div>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh}><RefreshCcw className="w-4 h-4" /></Button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div><div className="text-muted-foreground">Plan</div><div className="font-semibold capitalize">{src.plan.slug || '—'}</div></div>
          <div><div className="text-muted-foreground">Pages / scan</div><div className="font-semibold">{src.plan.limits.maxPages}</div></div>
          <div><div className="text-muted-foreground">Drafts / scan</div><div className="font-semibold">{src.plan.limits.maxArticles}</div></div>
          <div><div className="text-muted-foreground">Jobs this month</div><div className="font-semibold">{src.plan.jobs_used_this_month} / {src.plan.limits.jobsPerMonth}</div></div>
        </div>
        <div className="text-xs text-muted-foreground">
          AI credits remaining: <span className="font-semibold text-foreground">{src.credits.limit === -1 ? 'unlimited' : src.credits.remaining}</span> · 1 credit per generated draft
        </div>
      </div>

      {blocked && (
        <div className="card-elevated p-4 flex items-start gap-3 border border-warning/30 bg-warning/5">
          <AlertCircle className="w-4 h-4 text-warning mt-0.5" />
          <div className="text-xs text-foreground">
            AI Knowledge Builder is not enabled on your plan. Upgrade or ask an admin to enable the
            <code className="mx-1">ai_kb_builder</code> module.
          </div>
        </div>
      )}

      {isAdmin && moduleBlocked && (
        <div className="card-elevated p-4 flex items-start gap-3 border border-primary/30 bg-primary/5">
          <AlertCircle className="w-4 h-4 text-primary mt-0.5" />
          <div className="text-xs text-foreground">
            Global Admin override active — module gating is bypassed for diagnostic use. Bypasses are written to the audit log.
          </div>
        </div>
      )}

      <div className="flex flex-col items-end gap-2">
        {disabledReason && (
          <div className="flex items-center gap-2 text-xs text-warning">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>{disabledReason}</span>
          </div>
        )}
        <Button
          onClick={startScan}
          disabled={busy || blocked || noDomain || limitReached}
          className="gap-2"
          title={disabledReason || undefined}
        >
          <Sparkles className="w-4 h-4" />
          {busy ? 'Starting…' : 'Start AI scan of my website'}
        </Button>
      </div>

      {/* Active job */}
      {activeJob && (
        <div className="card-elevated p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-foreground">
              Latest job <span className="text-xs font-mono text-muted-foreground ml-1">{activeJob.id?.slice(0, 8)}</span>
            </div>
            <Badge variant="outline" className="capitalize">{activeJob.status}</Badge>
          </div>
          <div className="h-2 rounded bg-secondary overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${activeJob.progress || 0}%` }} />
          </div>
          <div className="text-xs text-muted-foreground">
            Pages crawled: {activeJob.pages_crawled} · Drafts generated: {activeJob.articles_generated} · Credits used: {activeJob.credits_used}
          </div>
          {activeJob.error_message && (
            <div className="text-xs text-destructive">
              {activeJob.error_message}
              {/AI provider is not configured/i.test(activeJob.error_message) && (
                <a href="/admin/providers" className="ml-2 underline font-semibold">
                  Configure AI provider
                </a>
              )}
            </div>
          )}
          {activeJob.status === 'failed' && !activeJob.error_message && (
            <div className="text-xs text-destructive">Job failed without a specific error message — check worker logs.</div>
          )}
          {activeJob.status === 'completed' && (activeJob.articles_generated || 0) === 0 && (
            <div className="text-xs text-warning">
              No articles were generated. {activeJob.plan_snapshot?.maxArticles === 0
                ? 'Test crawl completed (crawl-only test).'
                : 'See worker logs / events below for details.'}
            </div>
          )}
          {stuckQueued && (
            <div className="flex items-start gap-2 text-xs text-warning bg-warning/5 border border-warning/20 rounded p-2">
              <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Worker has not picked up this job yet. Check the <code>intelligence-worker</code> service logs.
              </span>
            </div>
          )}
          {jobEvents.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-muted-foreground cursor-pointer select-none">
                Job events ({jobEvents.length})
              </summary>
              <div className="mt-2 space-y-1 max-h-64 overflow-auto">
                {jobEvents.map((ev) => (
                  <div key={ev.id} className={
                    'text-[11px] font-mono rounded px-2 py-1 ' +
                    (ev.level === 'error'
                      ? 'bg-destructive/10 text-destructive'
                      : ev.level === 'warn'
                        ? 'bg-warning/10 text-warning'
                        : 'bg-muted text-muted-foreground')
                  }>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold uppercase">{ev.level}</span>
                      <span className="opacity-60">{new Date(ev.created_at).toLocaleTimeString()}</span>
                    </div>
                    <div>{ev.message}</div>
                    {ev.metadata && Object.keys(ev.metadata).length > 0 && (
                      <pre className="mt-1 whitespace-pre-wrap opacity-80">{JSON.stringify(ev.metadata, null, 0)}</pre>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Generated drafts */}
      {generated.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Generated drafts</h3>
            {generated.some((g) => g.status === 'pending' || g.status === 'accepted') && (
              <Button size="sm" onClick={publishAll} className="gap-1">
                <Rocket className="w-3.5 h-3.5" /> Publish all to widget
              </Button>
            )}
          </div>
          <div className="card-elevated p-3 flex items-start gap-2 border border-primary/20 bg-primary/5">
            <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <div className="text-xs text-foreground space-y-1">
              <div>Generated drafts are <strong>not</strong> visible in the widget yet.</div>
              <div>“Save as draft” creates a KB draft only — invisible to visitors.</div>
              <div>“Publish to widget” makes the article visible in the widget Help Center.</div>
            </div>
          </div>
          <div className="space-y-2">
            {generated.map((g) => (
              <div key={g.id} className="card-elevated p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-primary shrink-0" />
                      <div className="text-sm font-semibold text-foreground truncate">{g.title}</div>
                      {statusBadge(g.status)}
                    </div>
                    {g.excerpt && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{g.excerpt}</div>}
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {Array.isArray(g.source_urls) && g.source_urls[0] ? `Source: ${g.source_urls[0]}` : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {g.status === 'pending' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => onAction(g.id, 'reject')}>Reject</Button>
                        <Button size="sm" variant="outline" onClick={() => onAction(g.id, 'accept')}>Save as draft</Button>
                        <Button size="sm" onClick={() => onAction(g.id, 'publish')} className="gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Publish to widget
                        </Button>
                      </>
                    )}
                    {g.status === 'accepted' && (
                      <Button size="sm" onClick={() => onAction(g.id, 'publish')} className="gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Publish to widget
                      </Button>
                    )}
                    {g.status === 'published' && publicHelpUrl(g) && (
                      <a
                        href={publicHelpUrl(g)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Eye className="w-3.5 h-3.5" /> Open in Help Center
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
