import { useEffect, useState, useCallback } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import { aiKbApi, type AiKbSourceResponse } from '@/lib/ai-kb-api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Globe, Sparkles, AlertCircle, CheckCircle2, RefreshCcw, FileText } from 'lucide-react';

export default function AiKbBuilderTab() {
  const workspace = useCurrentWorkspace();
  const [src, setSrc] = useState<AiKbSourceResponse | null>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [activeJob, setActiveJob] = useState<any | null>(null);
  const [generated, setGenerated] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

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
      await aiKbApi.createJob(workspace.id);
      toast.success('Scan queued. Worker will pick it up shortly.');
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to start scan');
    } finally { setBusy(false); }
  };

  const onAction = async (id: string, action: 'accept' | 'reject' | 'publish') => {
    try {
      await (action === 'accept' ? aiKbApi.accept(id) : action === 'reject' ? aiKbApi.reject(id) : aiKbApi.publish(id));
      toast.success(action === 'publish' ? 'Published' : action === 'accept' ? 'Saved as KB draft' : 'Rejected');
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || 'Action failed');
    }
  };

  if (!src) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const blocked = !src.modules.knowledge_base || !src.modules.ai_kb_builder;

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

      <div className="flex justify-end">
        <Button
          onClick={startScan}
          disabled={busy || blocked || !src.source.can_scan || !src.plan.can_start_job}
          className="gap-2"
        >
          <Sparkles className="w-4 h-4" />
          {busy ? 'Starting…' : 'Start AI scan of my website'}
        </Button>
      </div>

      {/* Active job */}
      {activeJob && (
        <div className="card-elevated p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-foreground">Latest job</div>
            <Badge variant="outline" className="capitalize">{activeJob.status}</Badge>
          </div>
          <div className="h-2 rounded bg-secondary overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${activeJob.progress || 0}%` }} />
          </div>
          <div className="text-xs text-muted-foreground">
            Pages crawled: {activeJob.pages_crawled} · Drafts generated: {activeJob.articles_generated} · Credits used: {activeJob.credits_used}
          </div>
          {activeJob.error_message && (
            <div className="text-xs text-destructive">{activeJob.error_message}</div>
          )}
        </div>
      )}

      {/* Generated drafts */}
      {generated.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Generated drafts</h3>
          <div className="space-y-2">
            {generated.map((g) => (
              <div key={g.id} className="card-elevated p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-primary shrink-0" />
                      <div className="text-sm font-semibold text-foreground truncate">{g.title}</div>
                      <Badge variant="outline" className="capitalize text-[10px]">{g.status}</Badge>
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
                          <CheckCircle2 className="w-3.5 h-3.5" /> Publish
                        </Button>
                      </>
                    )}
                    {g.status === 'accepted' && (
                      <Button size="sm" onClick={() => onAction(g.id, 'publish')}>Publish</Button>
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
