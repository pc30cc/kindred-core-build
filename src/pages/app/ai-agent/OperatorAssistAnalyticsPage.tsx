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

export default function OperatorAssistAnalyticsPage() {
  const workspace = useCurrentWorkspace();
  const wsPath = useWorkspacePath();
  const [range, setRange] = useState<Range>('7d');

  const suggestMut = useMutation({
    mutationFn: (feedbackId: string) => aiAgentApi.suggestTestCaseFromFeedback(feedbackId),
    onSuccess: () => toast({ title: 'Suggested test created', description: 'Open the Suggested Tests page to review.' }),
    onError: (e: any) => toast({
      title: 'Could not create suggestion',
      description: e?.message?.includes('duplicate') ? 'A suggestion for this run already exists.' : (e?.message || 'Failed'),
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
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            Assist Analytics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Quality of AI Operator Assist suggestions and operator feedback.
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
              {r}
            </Button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading analytics…
        </div>
      )}
      {error && (
        <div className="text-sm text-destructive">
          Could not load analytics: {(error as any)?.message || 'unknown error'}
        </div>
      )}

      {a && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            <SummaryCard label="Total suggestions" value={a.summary.total_suggestions} />
            <SummaryCard label="Feedback received" value={a.summary.total_feedback} />
            <SummaryCard label="Acceptance rate" value={pct(a.summary.acceptance_rate)} />
            <SummaryCard
              label="Negative rate"
              value={pct(a.summary.negative_rate)}
              tone={a.summary.negative_rate > 0.3 ? 'warn' : 'default'}
            />
            <SummaryCard label="No-source count" value={a.summary.no_source_count} />
            <SummaryCard label="Avg confidence" value={a.summary.avg_confidence.toFixed(2)} />
            <SummaryCard
              label="AI credits used"
              value={a.summary.total_suggestions}
            />
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            <SummaryCard label="Positive" value={a.summary.positive} />
            <SummaryCard label="Neutral" value={a.summary.neutral} />
            <SummaryCard label="Negative" value={a.summary.negative} tone={a.summary.negative > 0 ? 'warn' : 'default'} />
          </div>

          {a.summary.usage_increment_failed_count > 0 && (
            <div className="text-xs text-warning">
              {a.summary.usage_increment_failed_count} suggestion(s) could not be recorded in the usage counter.
            </div>
          )}

          <Card>
            <CardHeader><CardTitle className="text-sm">Daily trend</CardTitle></CardHeader>
            <CardContent className="h-[260px]">
              {a.by_day.length === 0 ? (
                <div className="text-xs text-muted-foreground">No activity in this range.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={a.by_day}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="suggestions" name="Suggestions" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="positive" name="Positive" stroke="hsl(var(--success, 142 71% 45%))" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="negative" name="Negative" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>



          <div className="grid md:grid-cols-3 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">Feedback by reason</CardTitle></CardHeader>
              <CardContent>
                {a.by_reason.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No reasons recorded.</div>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {a.by_reason.sort((x, y) => y.count - x.count).map((r) => (
                      <li key={r.reason} className="flex justify-between">
                        <span>{r.reason}</span>
                        <span className="text-muted-foreground">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Operator actions</CardTitle></CardHeader>
              <CardContent>
                {a.by_action.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No actions recorded.</div>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {a.by_action.sort((x, y) => y.count - x.count).map((r) => (
                      <li key={r.action} className="flex justify-between">
                        <span>{r.action}</span>
                        <span className="text-muted-foreground">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Source type quality</CardTitle></CardHeader>
              <CardContent>
                {a.by_source_type.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No sources recorded.</div>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {a.by_source_type.sort((x, y) => y.runs - x.runs).map((r) => (
                      <li key={r.source_type} className="flex justify-between">
                        <span>{r.source_type}</span>
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
              <CardTitle className="text-sm">Worst runs (negative-rated)</CardTitle>
            </CardHeader>
            <CardContent>
              {a.worst_runs.length === 0 ? (
                <div className="text-xs text-muted-foreground">No negative-rated runs in this range.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Confidence</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Source types</TableHead>
                      <TableHead>Safety notes</TableHead>
                      <TableHead>Suggestion</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {a.worst_runs.map((r) => (
                      <TableRow key={r.run_id}>
                        <TableCell className="text-xs">{new Date(r.created_at).toLocaleString()}</TableCell>
                        <TableCell className="text-xs">{r.confidence != null ? r.confidence.toFixed(2) : '—'}</TableCell>
                        <TableCell className="text-xs">{r.reason || '—'}</TableCell>
                        <TableCell className="text-xs">
                          <div className="flex flex-wrap gap-1">
                            {r.source_types.length === 0
                              ? <span className="text-muted-foreground">none</span>
                              : r.source_types.map((s) => (
                                <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
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
                              inspect
                            </Link>
                            {r.feedback_id && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                disabled={suggestMut.isPending}
                                onClick={() => suggestMut.mutate(r.feedback_id!)}
                              >
                                Create suggested test
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