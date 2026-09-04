/**
 * AI Proactive Assistant (AI Proactive Nudge) — extends the Smart
 * Engagement tab with an AI-generated launcher_nudge surface. Additive to
 * the existing static rules above; does not replace or fork them.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Sparkles, Wand2 } from 'lucide-react';
import {
  useAiNudgeSettings, useSaveAiNudgeSettings, useAiNudgeStats, useAiNudgePreview,
  type AiProactiveMode,
} from '@/hooks/useAiNudgeSettings';

export interface AiProactiveNudgeCardProps {
  workspaceId: string | undefined;
  smartEngagementEnabled: boolean;
}

const MODES: AiProactiveMode[] = ['conservative', 'balanced', 'active'];

export function AiProactiveNudgeCard({ workspaceId, smartEngagementEnabled }: AiProactiveNudgeCardProps) {
  const { t, dir } = useTranslation();
  const { data, isLoading } = useAiNudgeSettings(workspaceId);
  const save = useSaveAiNudgeSettings(workspaceId);
  const { data: stats } = useAiNudgeStats(workspaceId);
  const preview = useAiNudgePreview(workspaceId);

  const [guidanceDraft, setGuidanceDraft] = useState('');
  const [includeDraft, setIncludeDraft] = useState('');
  const [excludeDraft, setExcludeDraft] = useState('');
  const [previewPath, setPreviewPath] = useState('/pricing');

  useEffect(() => {
    if (data?.settings) {
      setGuidanceDraft(data.settings.guidance || '');
      setIncludeDraft((data.settings.include_paths || []).join('\n'));
      setExcludeDraft((data.settings.exclude_paths || []).join('\n'));
    }
  }, [data?.settings]);

  if (!smartEngagementEnabled) return null;

  const settings = data?.settings;
  const effective = data?.effective;
  const enabled = settings?.enabled === true;

  const patch = (p: Partial<NonNullable<typeof settings>>) => save.mutate(p as any);

  return (
    <Card className="card-elevated overflow-hidden">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Sparkles className="h-4.5 w-4.5" />
          </div>
          <div>
            <CardTitle className="text-sm font-semibold">{t('widgetPage.smart.ai.title')}</CardTitle>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">{t('widgetPage.smart.ai.description')}</p>
          </div>
        </div>
        <Switch checked={enabled} disabled={isLoading || save.isPending} onCheckedChange={(v) => patch({ enabled: v })} />
      </CardHeader>

      {enabled && settings && (
        <CardContent className="space-y-4 pt-0" dir={dir}>
          {effective && !effective.available && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {t('widgetPage.smart.ai.unavailableHint')} ({effective.unavailableReason})
            </div>
          )}

          <Separator />

          {/* Behavior */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">{t('widgetPage.smart.ai.section.behavior')}</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => patch({ mode: m })}
                  className={`rounded-xl border p-3 text-start transition-colors ${
                    settings.mode === m ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">{t(`widgetPage.smart.ai.mode.${m}.label` as any)}</span>
                    {settings.mode === m && <Badge className="h-4 px-1.5 text-[9px]">{t('widgetPage.smart.ai.selected')}</Badge>}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{t(`widgetPage.smart.ai.mode.${m}.hint` as any)}</p>
                </button>
              ))}
            </div>
          </div>

          <Accordion type="multiple" className="w-full">
            {/* AI context */}
            <AccordionItem value="context">
              <AccordionTrigger className="text-xs font-semibold">{t('widgetPage.smart.ai.section.context')}</AccordionTrigger>
              <AccordionContent className="space-y-3 pt-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs">{t('widgetPage.smart.ai.useJourney')}</span>
                  <Switch checked={settings.use_journey} onCheckedChange={(v) => patch({ use_journey: v })} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs">{t('widgetPage.smart.ai.useKb')}</span>
                  <Switch checked={settings.use_kb} onCheckedChange={(v) => patch({ use_kb: v })} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs">{t('widgetPage.smart.ai.useReturningVisitor')}</span>
                  <Switch checked={settings.use_returning_visitor} onCheckedChange={(v) => patch({ use_returning_visitor: v })} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('widgetPage.smart.ai.guidanceLabel')}</label>
                  <Textarea
                    value={guidanceDraft}
                    onChange={(e) => setGuidanceDraft(e.target.value.slice(0, 500))}
                    onBlur={() => patch({ guidance: guidanceDraft || null })}
                    placeholder={t('widgetPage.smart.ai.guidancePlaceholder')}
                    maxLength={500}
                    rows={3}
                    className="text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">{t('widgetPage.smart.ai.guidanceHint')} ({guidanceDraft.length}/500)</p>
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Targeting */}
            <AccordionItem value="targeting">
              <AccordionTrigger className="text-xs font-semibold">{t('widgetPage.smart.ai.section.targeting')}</AccordionTrigger>
              <AccordionContent className="space-y-3 pt-1">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('widgetPage.smart.ai.includePaths')}</label>
                  <Textarea
                    value={includeDraft}
                    onChange={(e) => setIncludeDraft(e.target.value)}
                    onBlur={() => patch({ include_paths: includeDraft.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50) })}
                    placeholder={'/pricing\n/features/*'}
                    rows={2}
                    className="font-mono text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground">{t('widgetPage.smart.ai.includePathsHint')}</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">{t('widgetPage.smart.ai.excludePaths')}</label>
                  <Textarea
                    value={excludeDraft}
                    onChange={(e) => setExcludeDraft(e.target.value)}
                    onBlur={() => patch({ exclude_paths: excludeDraft.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50) })}
                    placeholder={'/checkout\n/account/*'}
                    rows={2}
                    className="font-mono text-xs"
                  />
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Frequency */}
            <AccordionItem value="frequency">
              <AccordionTrigger className="text-xs font-semibold">{t('widgetPage.smart.ai.section.frequency')}</AccordionTrigger>
              <AccordionContent className="space-y-3 pt-1">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">{t('widgetPage.smart.ai.maxPerSession')}</label>
                    <Input
                      type="number" min={0} max={effective?.maxEvaluationsPerSession ?? 10}
                      value={settings.max_per_session}
                      onChange={(e) => patch({ max_per_session: Math.max(0, Number(e.target.value) || 0) })}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">{t('widgetPage.smart.ai.cooldownSeconds')}</label>
                    <Input
                      type="number" min={0}
                      value={settings.cooldown_seconds}
                      onChange={(e) => patch({ cooldown_seconds: Math.max(0, Number(e.target.value) || 0) })}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                {effective && (
                  <p className="text-[10px] text-muted-foreground">
                    {t('widgetPage.smart.ai.effectiveHint')}: {t(`widgetPage.smart.ai.mode.${effective.mode}.label` as any)}
                    {' · '}{t('widgetPage.smart.ai.maxPerSession')} = {effective.maxPerSession}
                    {' · '}{t('widgetPage.smart.ai.cooldownSeconds')} = {effective.cooldownSeconds}s
                  </p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs">{t('widgetPage.smart.ai.stopAfterDismiss')}</span>
                  <Switch checked={settings.stop_after_dismiss} onCheckedChange={(v) => patch({ stop_after_dismiss: v })} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs">{t('widgetPage.smart.ai.stopAfterWidgetOpen')}</span>
                  <Switch checked={settings.stop_after_widget_open} onCheckedChange={(v) => patch({ stop_after_widget_open: v })} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs">{t('widgetPage.smart.ai.stopAfterConversation')}</span>
                  <Switch checked={settings.stop_after_conversation} onCheckedChange={(v) => patch({ stop_after_conversation: v })} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs">{t('widgetPage.smart.ai.mobileEnabled')}</span>
                  <Switch checked={settings.mobile_enabled} onCheckedChange={(v) => patch({ mobile_enabled: v })} />
                </div>
              </AccordionContent>
            </AccordionItem>

            {/* Preview / simulator */}
            <AccordionItem value="preview">
              <AccordionTrigger className="text-xs font-semibold">{t('widgetPage.smart.ai.section.preview')}</AccordionTrigger>
              <AccordionContent className="space-y-3 pt-1">
                <p className="text-[11px] text-muted-foreground">{t('widgetPage.smart.ai.previewHint')}</p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <label className="text-xs font-medium">{t('widgetPage.smart.ai.previewPath')}</label>
                    <Input value={previewPath} onChange={(e) => setPreviewPath(e.target.value)} className="h-8 text-xs" />
                  </div>
                  <Button
                    size="sm" variant="secondary" className="h-8 gap-1.5"
                    disabled={preview.isPending}
                    onClick={() => preview.mutate({ path: previewPath, sessionPageCount: 3, elapsedMs: 50000, scrollPercent: 80, returning: true })}
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    {t('widgetPage.smart.ai.runPreview')}
                  </Button>
                </div>
                {preview.data && (
                  <div className={`rounded-lg border p-3 text-xs ${preview.data.eligible ? 'border-success/30 bg-success/5' : 'border-border bg-muted/30'}`}>
                    <p className="font-semibold">
                      {preview.data.eligible ? t('widgetPage.smart.ai.previewEligible') : t('widgetPage.smart.ai.previewSuppressed')}
                    </p>
                    {typeof preview.data.score === 'number' && (
                      <p className="mt-1 text-muted-foreground">{t('widgetPage.smart.ai.previewScore')}: {preview.data.score} / {preview.data.threshold}</p>
                    )}
                    <p className="mt-1 text-muted-foreground">{t('widgetPage.smart.ai.previewReason')}: {preview.data.reasons.join(', ')}</p>
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>

            {/* Analytics */}
            {stats && (
              <AccordionItem value="analytics">
                <AccordionTrigger className="text-xs font-semibold">{t('widgetPage.smart.ai.section.analytics')}</AccordionTrigger>
                <AccordionContent className="pt-1">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <StatTile label={t('widgetPage.smart.stats.shown')} value={stats.counters.shown} />
                    <StatTile label={t('widgetPage.smart.ai.stats.ctaClicked')} value={stats.counters.cta_clicked} />
                    <StatTile label={t('widgetPage.smart.stats.dismissed' as any)} value={stats.counters.dismissed} />
                    <StatTile label={t('widgetPage.smart.stats.conversations')} value={stats.counters.conversation_started} />
                    <StatTile label={t('widgetPage.smart.ai.stats.cost')} value={`$${stats.aiUsage.costUsd.toFixed(3)}`} />
                  </div>
                  {stats.topTopics.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {stats.topTopics.slice(0, 6).map((t2) => (
                        <Badge key={t2.topic} variant="outline" className="text-[10px]">{t2.topic} · {t2.count}</Badge>
                      ))}
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            )}
          </Accordion>
        </CardContent>
      )}
    </Card>
  );
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-center">
      <p className="text-sm font-semibold">{value}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
