import { useEffect, useState, useCallback } from 'react';
import { useCurrentWorkspace } from '@/hooks/useWorkspace';
import {
  aiKbApi,
  AiKbApiError,
  AI_KB_PLATFORM_DENIAL_CODES,
  type AiKbSourceResponse,
  type AiKbJobDto,
  type AiKbGeneratedDto,
  type AiKbJobEventDto,
} from '@/lib/ai-kb-api';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/lib/toast';
import { formatTime } from '@/lib/date';
import { Globe, Sparkles, AlertCircle, CheckCircle2, RefreshCcw, FileText, Clock, Eye, Info, Rocket } from 'lucide-react';



/**
 * Phase 6-S5-R7.4 §1 — the surface has ONE authoritative access state,
 * resolved from `/source` BEFORE any private job data is requested. Using
 * `src === null` for "loading", "blocked" and "outage" alike is what made the
 * upgrade and platform states render as an endless "Loading…".
 */
export type AiKbSurfaceState =
  | { kind: 'loading' }
  | { kind: 'ready'; source: AiKbSourceResponse }
  | { kind: 'upgrade_required'; source: AiKbSourceResponse }
  | { kind: 'platform_disabled'; code: string }
  | { kind: 'customer_visibility_disabled'; code: string }
  | { kind: 'temporarily_unavailable'; code: string }
  | { kind: 'forbidden'; code: string };

export default function AiKbBuilderTab() {
  const workspace = useCurrentWorkspace();
  const { t, locale, dir } = useTranslation();
  /** Every user-visible string in this surface resolves through i18n. */
  const tr = (k: string, fb: string, vars?: Record<string, string>) => {
    const key = `aiAgent.kbBuilder.${k}`;
    const v = t(key as never, vars) as unknown as string;
    return !v || String(v).includes(key) ? fb : String(v);
  };
  /** Stable API error codes -> localized copy (never raw provider text). */
  const errorText = (code: string | undefined, fb: string) =>
    code ? tr(`error.${code}`, fb) : fb;
  const jobErrorText = (code: string | undefined) =>
    code ? tr(`jobError.${code}`, tr('jobError.job_failed', 'The scan failed. Please try again.'))
         : tr('jobError.job_failed', 'The scan failed. Please try again.');
  const [state, setState] = useState<AiKbSurfaceState>({ kind: 'loading' });
  const [activeJob, setActiveJob] = useState<AiKbJobDto | null>(null);
  const [generated, setGenerated] = useState<AiKbGeneratedDto[]>([]);
  const [jobEvents, setJobEvents] = useState<AiKbJobEventDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [stuckQueued, setStuckQueued] = useState(false);

  /**
   * Resolves the access state from `/source`, and only loads private job data
   * once the workspace is genuinely entitled AND the platform allows it.
   */
  const refresh = useCallback(async () => {
    if (!workspace?.id) return;

    let source: AiKbSourceResponse;
    try {
      source = await aiKbApi.getSource(workspace.id);
    } catch (e) {
      if (e instanceof AiKbApiError) {
        if (e.retryable) { setState({ kind: 'temporarily_unavailable', code: e.code }); return; }
        if (e.code === 'ai_customer_visibility_disabled') {
          setState({ kind: 'customer_visibility_disabled', code: e.code });
          return;
        }
        if (AI_KB_PLATFORM_DENIAL_CODES.has(e.code)) {
          setState({ kind: 'platform_disabled', code: e.code });
          return;
        }
        setState({ kind: 'forbidden', code: e.code });
        return;
      }
      setState({ kind: 'temporarily_unavailable', code: 'ai_kb_status_unavailable' });
      return;
    }

    const isAdmin = !!source.is_global_admin;

    // Unreadable platform / entitlement state is an outage, never a denial.
    if (source.modules.platform_status_unavailable) {
      setState({ kind: 'temporarily_unavailable', code: 'ai_platform_status_unavailable' });
      return;
    }
    if (source.modules.entitlement_status_unavailable) {
      setState({ kind: 'temporarily_unavailable', code: 'entitlement_status_unavailable' });
      return;
    }

    const platformDenialCode = source.modules.platform_denial_code || null;
    if (platformDenialCode && AI_KB_PLATFORM_DENIAL_CODES.has(platformDenialCode)) {
      setState(
        platformDenialCode === 'ai_customer_visibility_disabled'
          ? { kind: 'customer_visibility_disabled', code: platformDenialCode }
          : { kind: 'platform_disabled', code: platformDenialCode },
      );
      return;
    }

    // R7.4 §4 — AI KB Builder availability is `ai_assistant && ai_kb_builder`.
    // `ai_assistant` is a MODULE; `ai_kb_builder` is a FEATURE of it.
    const assistantBlocked = !source.modules.ai_assistant;
    const builderFeatureBlocked = !source.modules.ai_kb_builder;
    const planBlocked = assistantBlocked || builderFeatureBlocked;

    if ((planBlocked || source.upgrade_required === true) && !isAdmin) {
      setState({ kind: 'upgrade_required', source });
      setActiveJob(null); setGenerated([]); setJobEvents([]);
      return;
    }

    setState({ kind: 'ready', source });

    try {
      const j = await aiKbApi.listJobs(workspace.id);
      const latest = (j.jobs || [])[0];
      if (latest) {
        const detail = await aiKbApi.getJob(latest.id);
        setActiveJob(detail.job);
        setGenerated(detail.generated || []);
        setJobEvents(detail.events || []);
      } else {
        setActiveJob(null); setGenerated([]); setJobEvents([]);
      }
    } catch (e) {
      if (e instanceof AiKbApiError && e.retryable) {
        setState({ kind: 'temporarily_unavailable', code: e.code });
        return;
      }
      toast.error(tr('job.loadFailed', 'Failed to load AI Builder jobs'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  useEffect(() => { refresh(); }, [refresh]);

  const src = state.kind === 'ready' || state.kind === 'upgrade_required' ? state.source : null;

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
      toast.success(
        id
          ? tr('scan.queuedWithId', `Scan queued (job ${id.slice(0, 8)}).`, { id: id.slice(0, 8) })
          : tr('scan.queued', 'Scan queued.'),
      );
      setStuckQueued(false);
      await refresh();
    } catch (e) {
      const code = e instanceof Error ? e.message : undefined;
      toast.error(errorText(code, tr('scan.failedStart', 'Failed to start scan')));
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
      toast.success(
        action === 'publish'
          ? tr('drafts.published', 'Published')
          : action === 'accept'
            ? tr('drafts.accepted', 'Saved as KB draft')
            : tr('drafts.rejected', 'Rejected'),
      );
      await refresh();
    } catch (e) {
      const err = e instanceof AiKbApiError ? e : null;
      // A refused transition means someone else already moved this draft —
      // re-sync so the operator sees the real state instead of a stale row.
      if (err?.code === 'invalid_state') {
        toast.error(
          err.currentStatus
            ? tr('drafts.invalidState', 'This draft can no longer be changed.', {
                status: tr(`drafts.status.${err.currentStatus}`, err.currentStatus),
              })
            : tr('drafts.invalidStateGeneric', 'This draft was already reviewed by someone else.'),
        );
        await refresh();
        return;
      }
      if (err?.retryable) {
        toast.error(tr('drafts.unavailable', 'The knowledge base is temporarily unavailable. Please try again.'));
        return;
      }
      toast.error(errorText(e instanceof Error ? e.message : undefined, tr('drafts.actionFailed', 'Action failed')));
    }
  };

  const publishAll = async () => {
    if (!activeJob?.id) return;
    const eligible = generated.filter((g) => g.status === 'pending' || g.status === 'accepted').length;
    if (!eligible) { toast.info(tr('drafts.none', 'No drafts to publish')); return; }
    if (!window.confirm(tr('drafts.confirmPublishAll', `Publish ${eligible} draft(s)?`, { count: String(eligible) }))) return;
    try {
      const r = await aiKbApi.publishAll(activeJob.id);
      toast.success(
        tr('drafts.publishedCount', `Published ${r.published_count} draft(s)`, { count: String(r.published_count) })
        + (r.failed_count ? ` · ${tr('drafts.publishedFailed', `${r.failed_count} failed`, { count: String(r.failed_count) })}` : ''),
      );
      await refresh();
    } catch (e) {
      toast.error(errorText(e instanceof Error ? e.message : undefined, tr('drafts.publishAllFailed', 'Publish all failed')));
    }
  };

  const statusBadge = (status: string) => {
    if (status === 'pending') return <Badge variant="outline" className="text-[10px]">{tr('drafts.status.pending', 'Generated only · not in widget')}</Badge>;
    if (status === 'accepted') return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-[10px]">{tr('drafts.status.accepted', 'Saved as KB draft · not in widget')}</Badge>;
    if (status === 'published') return <Badge className="bg-success/10 text-success border-success/20 text-[10px]">{tr('drafts.status.published', 'Published in Help Center')}</Badge>;
    if (status === 'rejected') return <Badge variant="outline" className="text-[10px]">{tr('drafts.status.rejected', 'Rejected')}</Badge>;
    return <Badge variant="outline" className="text-[10px]">{tr(`drafts.status.${status}`, status)}</Badge>;
  };

  /**
   * The link is built ONLY from the server-resolved `public_path`, which comes
   * from the real `knowledge_base_articles` row. The draft's own `slug` is a
   * suggestion the database may have de-duplicated at publish time.
   */
  const publicHelpUrl = (g: AiKbGeneratedDto) =>
    g.public_path ? `${window.location.origin}${g.public_path}` : null;

  if (state.kind === 'loading') {
    return <div className="p-6 text-sm text-muted-foreground" dir={dir} data-testid="aikb-loading">{tr('loading', 'Loading…')}</div>;
  }

  if (state.kind === 'temporarily_unavailable') {
    return (
      <div className="card-elevated p-6 flex flex-col items-center gap-3 text-center" dir={dir} data-testid="aikb-temporarily-unavailable">
        <AlertCircle className="w-5 h-5 text-warning" />
        <div className="text-sm font-semibold text-foreground">{tr('temp.title', 'Status temporarily unavailable')}</div>
        <p className="text-xs text-muted-foreground max-w-sm">{tr('temp.desc', 'We could not confirm your plan, domain or credit status right now. Please retry in a moment.')}</p>
        <Button size="sm" variant="outline" onClick={refresh} className="gap-2" data-testid="aikb-retry">
          <RefreshCcw className="w-3.5 h-3.5" /> {tr('retry', 'Retry')}
        </Button>
      </div>
    );
  }

  if (state.kind === 'platform_disabled' || state.kind === 'customer_visibility_disabled') {
    return (
      <div
        className="card-elevated p-6 flex flex-col items-center gap-3 text-center border border-warning/30 bg-warning/5"
        dir={dir}
        data-testid={state.kind === 'platform_disabled' ? 'aikb-platform-disabled' : 'aikb-customer-hidden'}
      >
        <AlertCircle className="w-5 h-5 text-warning" />
        <div className="text-sm font-semibold text-foreground">{tr('off.title', 'AI features are switched off')}</div>
        <p className="text-xs text-muted-foreground max-w-sm">
          {errorText(state.code, tr('error.ai_platform_kill_switch', 'AI features are switched off by the platform operator.'))}
          {' '}{tr('off.contact', 'Upgrading your plan will not change this — please contact the platform operator.')}
        </p>
      </div>
    );
  }

  if (state.kind === 'forbidden') {
    return (
      <div className="card-elevated p-6 text-center space-y-2" dir={dir} data-testid="aikb-forbidden">
        <AlertCircle className="w-5 h-5 text-warning mx-auto" />
        <div className="text-sm font-semibold text-foreground">{tr('forbidden.title', 'You do not have access to this surface')}</div>
        <p className="text-xs text-muted-foreground">{errorText(state.code, state.code)}</p>
      </div>
    );
  }

  // ─── ready / upgrade_required ───
  const source = state.source;
  const isAdmin = !!source.is_global_admin;
  const assistantBlocked = !source.modules.ai_assistant;
  const builderFeatureBlocked = !source.modules.ai_kb_builder;
  const planBlocked = state.kind === 'upgrade_required';

  const noDomain = !source.source.can_scan || !source.source.domain;
  const limitReached = !source.plan.can_start_job && !isAdmin;
  const blocked = planBlocked;
  const disabledReason = planBlocked
    ? assistantBlocked
      ? tr('reason.assistant', 'AI Assistant is not included in this plan.')
      : tr('reason.builder', 'AI Knowledge Builder is not included in this plan.')
    : noDomain
      ? tr('reason.noDomain', 'No workspace domain available. Add a domain in workspace settings first.')
      : limitReached
        ? tr('reason.limitReached', 'Monthly scan limit reached.', {
            used: String(source.plan.jobs_used_this_month),
            limit: String(source.plan.limits.jobsPerMonth),
          })
        : '';

  return (
    <div className="space-y-5" dir={dir}>
      {/* Source + plan */}
      <div className="card-elevated p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-primary/10"><Globe className="w-4 h-4 text-primary" /></div>
            <div>
              <div className="text-xs text-muted-foreground">{tr('source.label', 'Scan source (workspace domain only)')}</div>
              <div className="text-sm font-semibold text-foreground">{source.source.domain || tr('source.none', '— No domain available —')}</div>
              <div className="mt-1 flex items-center gap-2">
                {source.source.verified
                  ? <Badge className="bg-success/10 text-success border-success/20">{tr('source.verified', 'Verified')}</Badge>
                  : source.source.kind === 'profile_domain'
                    ? <Badge variant="outline">{tr('source.pendingVerification', 'Pending verification')}</Badge>
                    : <Badge variant="outline">{tr('source.unverified', 'Unverified')}</Badge>}
                {source.source.is_primary && <Badge variant="secondary">{tr('source.primary', 'Primary')}</Badge>}
              </div>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} title={tr('refresh', 'Refresh')} aria-label={tr('refresh', 'Refresh')}><RefreshCcw className="w-4 h-4" /></Button>
        </div>
        {!planBlocked && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div><div className="text-muted-foreground">{tr('plan.plan', 'Plan')}</div><div className="font-semibold capitalize">{source.plan.slug || '—'}</div></div>
              <div><div className="text-muted-foreground">{tr('plan.pagesPerScan', 'Pages / scan')}</div><div className="font-semibold">{source.plan.limits.maxPages}</div></div>
              <div><div className="text-muted-foreground">{tr('plan.draftsPerScan', 'Drafts / scan')}</div><div className="font-semibold">{source.plan.limits.maxArticles}</div></div>
              <div><div className="text-muted-foreground">{tr('plan.jobsThisMonth', 'Jobs this month')}</div><div className="font-semibold">{source.plan.jobs_used_this_month} / {source.plan.limits.jobsPerMonth}</div></div>
            </div>
            <div className="text-xs text-muted-foreground">
              {tr('plan.creditsLabel', 'AI credits remaining')}: <span className="font-semibold text-foreground">{source.credits.limit === -1 ? tr('plan.unlimited', 'Unlimited') : source.credits.remaining}</span> · {tr('plan.creditsHint', '1 credit per generated draft')}
            </div>
          </>
        )}
      </div>

      {planBlocked && (
        <div
          className="card-elevated p-4 flex items-start gap-3 border border-warning/30 bg-warning/5"
          data-testid="aikb-upgrade-required"
        >
          <AlertCircle className="w-4 h-4 text-warning mt-0.5" />
          <div className="text-xs text-foreground">
            {assistantBlocked
              ? tr('upgrade.assistant', 'AI Assistant is not included in this plan.')
              : tr('upgrade.builder', 'AI Knowledge Builder is not included in this plan.')}
          </div>
        </div>
      )}

      {isAdmin && builderFeatureBlocked && (
        <div className="card-elevated p-4 flex items-start gap-3 border border-primary/30 bg-primary/5">
          <AlertCircle className="w-4 h-4 text-primary mt-0.5" />
          <div className="text-xs text-foreground">
            {tr('adminOverride', 'Global Admin override active — plan gating is bypassed for diagnostic use.')}
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
          {busy ? tr('scan.starting', 'Starting…') : tr('scan.start', 'Start AI scan of my website')}
        </Button>
      </div>

      {/* Active job */}
      {activeJob && (
        <div className="card-elevated p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-foreground">
              {tr('job.latest', 'Latest job')} <span className="text-xs font-mono text-muted-foreground mx-1">{activeJob.id?.slice(0, 8)}</span>
            </div>
            <Badge variant="outline">{tr(`job.status.${activeJob.status}`, activeJob.status)}</Badge>
          </div>
          <div className="h-2 rounded bg-secondary overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${activeJob.progress || 0}%` }} />
          </div>
          <div className="text-xs text-muted-foreground">
            {tr('job.pagesCrawled', 'Pages crawled')}: {activeJob.processed_pages ?? 0}
            {typeof activeJob.total_pages === 'number' ? ` / ${activeJob.total_pages}` : ''}
            {' · '}{tr('job.draftsGenerated', 'Drafts generated')}: {activeJob.generated_articles ?? 0}
            {(activeJob.failed_pages ?? 0) > 0 ? ` · ${tr('job.pagesFailed', 'Pages failed')}: ${activeJob.failed_pages}` : ''}
          </div>
          {activeJob.error_code && (
            <div className="text-xs text-destructive">
              {jobErrorText(activeJob.error_code)}
              {activeJob.error_code === 'provider_unavailable' && (
                <a href="/admin/providers" className="mx-2 underline font-semibold">
                  {tr('job.checkProvider', 'Check AI provider')}
                </a>
              )}
            </div>
          )}
          {activeJob.status === 'failed' && !activeJob.error_code && (
            <div className="text-xs text-destructive">{tr('job.failedNoCode', 'The scan failed. Ask an administrator to check the worker logs.')}</div>
          )}
          {activeJob.status === 'completed' && (activeJob.generated_articles || 0) === 0 && (
            <div className="text-xs text-warning">
              {tr('job.noArticles', 'No articles were generated.')} {src?.plan.limits.maxArticles === 0
                ? tr('job.noArticlesPlan', 'Your plan does not include AI-generated drafts.')
                : tr('job.noArticlesSeeEvents', 'See the job events below for details.')}
            </div>
          )}
          {stuckQueued && (
            <div className="flex items-start gap-2 text-xs text-warning bg-warning/5 border border-warning/20 rounded p-2">
              <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{tr('job.stuckQueued', 'The worker has not picked up this job yet.')}</span>
            </div>
          )}
          {jobEvents.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-muted-foreground cursor-pointer select-none">
                {tr('job.events', `Job events (${jobEvents.length})`, { count: String(jobEvents.length) })}
              </summary>
              <div className="mt-2 space-y-1 max-h-64 overflow-auto">
                {jobEvents.map((ev) => (
                  <div key={ev.id} className={
                    'text-[11px] font-mono rounded px-2 py-1 ' +
                    (ev.event_type === 'error'
                      ? 'bg-destructive/10 text-destructive'
                      : ev.event_type === 'warn'
                        ? 'bg-warning/10 text-warning'
                        : 'bg-muted text-muted-foreground')
                  }>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{tr(`job.event.${ev.event_type}`, ev.event_type.toUpperCase())}</span>
                      <span className="opacity-60">{formatTime(ev.created_at)}</span>
                    </div>
                    {ev.error_code && (
                      <div>{tr(`jobError.${ev.error_code}`, tr('job.stepFailed', 'Step failed.'))}</div>
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
            <h3 className="text-sm font-semibold text-foreground">{tr('drafts.title', 'Generated drafts')}</h3>
            {generated.some((g) => g.status === 'pending' || g.status === 'accepted') && (
              <Button size="sm" onClick={publishAll} className="gap-1">
                <Rocket className="w-3.5 h-3.5" /> {tr('drafts.publishAll', 'Publish all to widget')}
              </Button>
            )}
          </div>
          <div className="card-elevated p-3 flex items-start gap-2 border border-primary/20 bg-primary/5">
            <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <div className="text-xs text-foreground space-y-1">
              <div>{tr('drafts.note1', 'Generated drafts are not visible in the widget yet.')}</div>
              <div>{tr('drafts.note2', '“Save as draft” creates a KB draft only — invisible to visitors.')}</div>
              <div>{tr('drafts.note3', '“Publish to widget” makes the article visible in the widget Help Center.')}</div>
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
                    {g.public_path && (
                      <div className="text-[10px] text-muted-foreground mt-1 truncate">
                        {tr('drafts.path', 'Help Center path')}: <code>{g.public_path}</code>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {g.status === 'pending' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => onAction(g.id, 'reject')}>{tr('drafts.reject', 'Reject')}</Button>
                        <Button size="sm" variant="outline" onClick={() => onAction(g.id, 'accept')}>{tr('drafts.saveDraft', 'Save as draft')}</Button>
                        <Button size="sm" onClick={() => onAction(g.id, 'publish')} className="gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> {tr('drafts.publish', 'Publish to widget')}
                        </Button>
                      </>
                    )}
                    {g.status === 'accepted' && (
                      <Button size="sm" onClick={() => onAction(g.id, 'publish')} className="gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> {tr('drafts.publish', 'Publish to widget')}
                      </Button>
                    )}
                    {g.status === 'published' && publicHelpUrl(g) && (
                      <a
                        href={publicHelpUrl(g)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Eye className="w-3.5 h-3.5" /> {tr('drafts.openHelp', 'Open in Help Center')}
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
