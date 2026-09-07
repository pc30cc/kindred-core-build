/**
 * Pass E8 — Operator AI Assist analytics.
 *
 * Workspace-scoped quality dashboard for AI Assist suggestions and operator
 * feedback. Read-only. Does not auto-send anything.
 */
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useCurrentWorkspace, useWorkspacePath } from '@/hooks/useWorkspace';
import { useTranslation } from '@/i18n';
import { aiAgentApi, type OperatorAssistAnalytics } from '@/lib/ai-agent-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Loader2, Sparkles } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';

import { toast } from '@/hooks/use-toast';

type Range = '7d' | '30d' | '90d';

function pct(n: number) { return `${Math.round(n * 100)}%`; }

/** Graceful fallback for a code with no translation entry (e.g. a rare
 * internal error path) — "some_code" -> "Some code" — rather than showing
 * raw snake_case or an untranslated key. */
function humanizeCode(code: string): string {
  const s = code.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function OperatorAssistAnalyticsPage() {
  const workspace = useCurrentWorkspace();
  const wsPath = useWorkspacePath();
  const { t, dir } = useTranslation();
  const [range, setRange] = useState<Range>('7d');

  const rangeLabels: Record<Range, string> = {
    '7d': t('aiAgent.assistAnalytics.range.d7'),
    '30d': t('aiAgent.assistAnalytics.range.d30'),
    '90d': t('aiAgent.assistAnalytics.range.d90'),
  };

  const feedbackReasonLabels: Record<string, string> = {
    helpful: t('aiAgent.codes.feedbackReason.helpful'),
    wrong_answer: t('aiAgent.codes.feedbackReason.wrong_answer'),
    missing_context: t('aiAgent.codes.feedbackReason.missing_context'),
    bad_tone: t('aiAgent.codes.feedbackReason.bad_tone'),
    too_long: t('aiAgent.codes.feedbackReason.too_long'),
    too_short: t('aiAgent.codes.feedbackReason.too_short'),
    unsafe: t('aiAgent.codes.feedbackReason.unsafe'),
    not_grounded: t('aiAgent.codes.feedbackReason.not_grounded'),
    other: t('aiAgent.codes.feedbackReason.other'),
  };
  const operatorActionLabels: Record<string, string> = {
    inserted: t('aiAgent.codes.operatorAction.inserted'),
    replaced: t('aiAgent.codes.operatorAction.replaced'),
    appended: t('aiAgent.codes.operatorAction.appended'),
    copied: t('aiAgent.codes.operatorAction.copied'),
    dismissed: t('aiAgent.codes.operatorAction.dismissed'),
    regenerated: t('aiAgent.codes.operatorAction.regenerated'),
    sent_after_edit: t('aiAgent.codes.operatorAction.sent_after_edit'),
    sent_as_is: t('aiAgent.codes.operatorAction.sent_as_is'),
  };
  const sourceTypeLabels: Record<string, string> = {
    answer: t('aiAgent.codes.sourceType.answer'),
    file: t('aiAgent.codes.sourceType.file'),
    kb_article: t('aiAgent.codes.sourceType.kb_article'),
    learned_qna: t('aiAgent.codes.sourceType.learned_qna'),
    operator_assist_feedback: t('aiAgent.codes.sourceType.operator_assist_feedback'),
    operator_reply: t('aiAgent.codes.sourceType.operator_reply'),
    qna: t('aiAgent.codes.sourceType.qna'),
    test_run: t('aiAgent.codes.sourceType.test_run'),
    web_page: t('aiAgent.codes.sourceType.web_page'),
    website: t('aiAgent.codes.sourceType.website'),
  };

  const suggestMut = useMutation({
    mutationFn: (feedbackId: string) => aiAgentApi.suggestTestCaseFromFeedback(feedbackId),
    onSuccess: () => toast({
      title: t('aiAgent.assistAnalytics.toast.suggestedCreatedTitle'),
      description: t('aiAgent.assistAnalytics.toast.suggestedCreatedDesc'),
    }),
    onError: (e: any) => toast({
      title: t('aiAgent.assistAnalytics.toast.suggestFailedTitle'),
      description: e?.message?.includes('duplicate')
        ? t('aiAgent.assistAnalytics.toast.suggestDuplicate')
        : (e?.message || t('aiAgent.assistAnalytics.toast.suggestFailedGeneric')),
      variant: 'destructive',
    }),
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['ai-agent', 'assist-analytics', workspace?.id, range],
    queryFn: () => aiAgentApi.getAssistAnalytics(workspace!.id, range),
    enabled: !!workspace?.id,
  });

  const a = data as OperatorAssistAnalytics | undefined;

  return (
    <div className="space-y-6" dir={dir}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            {t('aiAgent.assistAnalytics.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('aiAgent.assistAnalytics.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {(['7d', '30d', '90d'] as Range[]).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={range === r ? 'default' : 'outline'}
              onClick={() => setRange(r)}
            >
              {rangeLabels[r]}
            </Button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('aiAgent.assistAnalytics.loading')}
        </div>
      )}
      {error && (
        <div className="text-sm text-destructive">
          {t('aiAgent.assistAnalytics.loadError', {
            message: (error as any)?.message || t('aiAgent.assistAnalytics.unknownError'),
          })}
        </div>
      )}

      {a && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            <SummaryCard label={t('aiAgent.assistAnalytics.summary.totalSuggestions')} value={a.summary.total_suggestions} />
            <SummaryCard label={t('aiAgent.assistAnalytics.summary.feedbackReceived')} value={a.summary.total_feedback} />
            <SummaryCard label={t('aiAgent.assistAnalytics.summary.acceptanceRate')} value={pct(a.summary.acceptance_rate)} />
            <SummaryCard
              label={t('aiAgent.assistAnalytics.summary.negativeRate')}
              value={pct(a.summary.negative_rate)}
              tone={a.summary.negative_rate > 0.3 ? 'warn' : 'default'}
            />
            <SummaryCard label={t('aiAgent.assistAnalytics.summary.noSourceCount')} value={a.summary.no_source_count} />
            <SummaryCard label={t('aiAgent.assistAnalytics.summary.avgConfidence')} value={a.summary.avg_confidence.toFixed(2)} />
            <SummaryCard
              label={t('aiAgent.assistAnalytics.summary.aiCreditsUsed')}
              value={a.summary.total_suggestions}
            />
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            <SummaryCard label={t('aiAgent.assistAnalytics.summary.positive')} value={a.summary.positive} />
            <SummaryCard label={t('aiAgent.assistAnalytics.summary.neutral')} value={a.summary.neutral} />
            <SummaryCard label={t('aiAgent.assistAnalytics.summary.negative')} value={a.summary.negative} tone={a.summary.negative > 0 ? 'warn' : 'default'} />
          </div>

          {a.summary.usage_increment_failed_count > 0 && (
            <div className="text-xs text-warning">
              {t('aiAgent.assistAnalytics.usageIncrementFailedWarning', { count: String(a.summary.usage_increment_failed_count) })}
            </div>
          )}

          <Card>
            <CardHeader><CardTitle className="text-sm">{t('aiAgent.assistAnalytics.dailyTrend.title')}</CardTitle></CardHeader>
            <CardContent className="h-[260px]">
              {a.by_day.length === 0 ? (
                <div className="text-xs text-muted-foreground">{t('aiAgent.assistAnalytics.dailyTrend.empty')}</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={a.by_day}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="suggestions" name={t('aiAgent.assistAnalytics.dailyTrend.seriesSuggestions')} stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="positive" name={t('aiAgent.assistAnalytics.summary.positive')} stroke="hsl(var(--success, 142 71% 45%))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="negative" name={t('aiAgent.assistAnalytics.summary.negative')} stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <div className="grid md:grid-cols-3 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">{t('aiAgent.assistAnalytics.byReason.title')}</CardTitle></CardHeader>
              <CardContent>
                {a.by_reason.length === 0 ? (
                  <div className="text-xs text-muted-foreground">{t('aiAgent.assistAnalytics.byReason.empty')}</div>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {a.by_reason.sort((x, y) => y.count - x.count).map((r) => (
                      <li key={r.reason} className="flex justify-between">
                        <span>{feedbackReasonLabels[r.reason] || humanizeCode(r.reason)}</span>
                        <span className="text-muted-foreground">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">{t('aiAgent.assistAnalytics.byAction.title')}</CardTitle></CardHeader>
              <CardContent>
                {a.by_action.length === 0 ? (
                  <div className="text-xs text-muted-foreground">{t('aiAgent.assistAnalytics.byAction.empty')}</div>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {a.by_action.sort((x, y) => y.count - x.count).map((r) => (
                      <li key={r.action} className="flex justify-between">
                        <span>{operatorActionLabels[r.action] || humanizeCode(r.action)}</span>
                        <span className="text-muted-foreground">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">{t('aiAgent.assistAnalytics.bySourceType.title')}</CardTitle></CardHeader>
              <CardContent>
                {a.by_source_type.length === 0 ? (
                  <div className="text-xs text-muted-foreground">{t('aiAgent.assistAnalytics.bySourceType.empty')}</div>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {a.by_source_type.sort((x, y) => y.runs - x.runs).map((r) => (
                      <li key={r.source_type} className="flex justify-between">
                        <span>{sourceTypeLabels[r.source_type] || humanizeCode(r.source_type)}</span>
                        <span className="text-muted-foreground">{r.runs}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t('aiAgent.assistAnalytics.worstRuns.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              {a.worst_runs.length === 0 ? (
                <div className="text-xs text-muted-foreground">{t('aiAgent.assistAnalytics.worstRuns.empty')}</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('aiAgent.assistAnalytics.worstRuns.colDate')}</TableHead>
                      <TableHead>{t('aiAgent.assistAnalytics.worstRuns.colConfidence')}</TableHead>
                      <TableHead>{t('aiAgent.assistAnalytics.worstRuns.colReason')}</TableHead>
                      <TableHead>{t('aiAgent.assistAnalytics.worstRuns.colSourceTypes')}</TableHead>
                      <TableHead>{t('aiAgent.assistAnalytics.worstRuns.colSafetyNotes')}</TableHead>
                      <TableHead>{t('aiAgent.assistAnalytics.worstRuns.colSuggestion')}</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {a.worst_runs.map((r) => (
                      <TableRow key={r.run_id}>
                        <TableCell className="text-xs">{new Date(r.created_at).toLocaleString()}</TableCell>
                        <TableCell className="text-xs">{r.confidence != null ? r.confidence.toFixed(2) : '—'}</TableCell>
                        <TableCell className="text-xs">{r.reason ? (feedbackReasonLabels[r.reason] || humanizeCode(r.reason)) : '—'}</TableCell>
                        <TableCell className="text-xs">
                          <div className="flex flex-wrap gap-1">
                            {r.source_types.length === 0
                              ? <span className="text-muted-foreground">{t('aiAgent.assistAnalytics.worstRuns.sourceTypesNone')}</span>
                              : r.source_types.map((s) => (
                                <Badge key={s} variant="secondary" className="text-[10px]">{sourceTypeLabels[s] || humanizeCode(s)}</Badge>
                              ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="flex flex-wrap gap-1">
                            {r.safety_notes.slice(0, 4).map((n) => (
                              <Badge key={n} variant="outline" className="text-[10px] text-warning border-warning/40">{n}</Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs max-w-[280px] truncate" title={r.suggestion_preview || ''}>
                          {r.suggestion_preview || '—'}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Link
                              to={wsPath(`/ai-agent/runs/${r.run_id}`)}
                              className="text-xs text-primary hover:underline"
                            >
                              {t('aiAgent.assistAnalytics.worstRuns.inspect')}
                            </Link>
                            {r.feedback_id && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                disabled={suggestMut.isPending}
                                onClick={() => suggestMut.mutate(r.feedback_id!)}
                              >
                                {t('aiAgent.assistAnalytics.worstRuns.createSuggestedTest')}
                              </Button>
                            )}
                          </div>
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

function SummaryCard({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'warn' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-xl font-semibold mt-1 ${tone === 'warn' ? 'text-warning' : ''}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
